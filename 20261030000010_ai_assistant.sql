-- =====================================================================
-- Maylana Booking v0.4 — Assistente "Maylana AI"
--
-- Migrazione incrementale: non modifica tabelle, funzioni o dati esistenti.
--
--  * ai_settings        configurazione (attivazione, messaggio iniziale, limiti, prezzi per la stima dei costi)
--  * ai_faq             risposte approvate dal salone (usate dalla chat e risposte locali senza API)
--  * ai_usage_daily     consumi AGGREGATI per giorno (nessun dato personale, nessun testo)
--  * ai_sessions        sessioni a scadenza: solo hash del token e contatori.
--                       Il testo delle conversazioni NON viene salvato nel database.
--
-- Tutte le funzioni sono eseguibili solo dal backend (service_role).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Impostazioni (riga unica)
-- ---------------------------------------------------------------------
create table public.ai_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  welcome_message text not null default 'Benvenuta da Maylana Coiffeur! Sono Maylana AI, il tuo assistente virtuale. Posso aiutarti a scoprire i nostri servizi, trovare un appuntamento o richiedere una consulenza Capelli For You. Come posso aiutarti?'
    check (length(btrim(welcome_message)) between 10 and 600),
  -- limiti di utilizzo
  daily_request_limit int not null default 300 check (daily_request_limit between 0 and 100000),
  daily_token_limit int not null default 400000 check (daily_token_limit between 0 and 100000000),
  daily_cost_limit_usd numeric(10,2) check (daily_cost_limit_usd is null or daily_cost_limit_usd >= 0),
  session_message_limit int not null default 20 check (session_message_limit between 1 and 200),
  session_ttl_minutes int not null default 60 check (session_ttl_minutes between 5 and 1440),
  max_input_chars int not null default 500 check (max_input_chars between 50 and 2000),
  max_output_tokens int not null default 500 check (max_output_tokens between 100 and 4000),
  -- prezzi del modello in USD per 1 milione di token, inseriti dal salone dal listino OpenAI
  -- (servono solo per la STIMA dei costi; se vuoti la stima non viene calcolata)
  input_price_per_mtok_usd numeric(10,4) check (input_price_per_mtok_usd is null or input_price_per_mtok_usd >= 0),
  output_price_per_mtok_usd numeric(10,4) check (output_price_per_mtok_usd is null or output_price_per_mtok_usd >= 0),
  updated_at timestamptz not null default now()
);
insert into public.ai_settings (id) values (1) on conflict do nothing;

create trigger trg_ai_settings_updated
  before update on public.ai_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- FAQ / contenuti approvati dal salone
-- ---------------------------------------------------------------------
create table public.ai_faq (
  id uuid primary key default gen_random_uuid(),
  topic text not null default 'generale'
    check (topic in ('generale', 'servizi', 'prezzi', 'prenotazioni', 'capelli_for_you', 'contatti', 'altro')),
  language text not null default 'it' check (language in ('it', 'en')),
  question text not null check (length(btrim(question)) between 3 and 300),
  answer text not null check (length(btrim(answer)) between 3 and 1500),
  -- parole chiave per la risposta locale senza API (minuscole, senza accenti)
  keywords text[] not null default '{}' check (cardinality(keywords) <= 20),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_faq_active_idx on public.ai_faq (active, topic, sort_order);

create trigger trg_ai_faq_updated
  before update on public.ai_faq
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Consumi aggregati giornalieri (fuso Europe/Rome)
-- ---------------------------------------------------------------------
create table public.ai_usage_daily (
  day date primary key,
  turns int not null default 0,            -- messaggi gestiti (qualsiasi fonte)
  model_turns int not null default 0,      -- messaggi che hanno chiamato OpenAI
  model_calls int not null default 0,      -- chiamate API totali (più di una per turno con gli strumenti)
  local_answers int not null default 0,    -- risposte da FAQ/azioni locali senza API
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  errors int not null default 0,
  blocked int not null default 0,          -- turni rifiutati per limiti
  est_cost_usd numeric(12,6) not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Sessioni a scadenza (nessun contenuto dei messaggi)
-- ---------------------------------------------------------------------
create table public.ai_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  turns int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0
);
create index ai_sessions_expires_idx on public.ai_sessions (expires_at);

-- Audit delle modifiche di configurazione (non delle sessioni/consumi)
create trigger trg_audit_ai_settings after insert or update or delete on public.ai_settings
  for each row execute function public.audit_row();
create trigger trg_audit_ai_faq after insert or update or delete on public.ai_faq
  for each row execute function public.audit_row();

-- =====================================================================
-- Funzioni (solo backend)
-- =====================================================================

-- Contesto pubblico per la chat: impostazioni AI, recapiti, orari, FAQ attive.
-- Contiene solo dati pubblici del salone.
create or replace function public.ai_public_context()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'ai', (select json_build_object(
              'enabled', a.enabled, 'welcome_message', a.welcome_message,
              'max_input_chars', a.max_input_chars, 'max_output_tokens', a.max_output_tokens,
              'session_message_limit', a.session_message_limit)
           from public.ai_settings a where a.id = 1),
    'salon', (select json_build_object(
              'business_name', b.business_name, 'address', b.address,
              'contact_phone', b.contact_phone, 'contact_email', b.contact_email,
              'whatsapp_number', b.whatsapp_number, 'privacy_url', b.privacy_url,
              'online_booking_enabled', b.online_booking_enabled,
              'booking_horizon_days', b.booking_horizon_days,
              'min_notice_minutes', b.min_notice_minutes,
              'customer_change_min_hours', b.customer_change_min_hours)
           from public.business_settings b where b.id = 1),
    'opening_hours', coalesce((select json_agg(json_build_object(
              'weekday', o.weekday, 'start', to_char(o.start_time, 'HH24:MI'), 'end', to_char(o.end_time, 'HH24:MI'))
              order by o.weekday, o.start_time)
           from public.opening_hours o), '[]'::json),
    -- giorni della settimana in cui almeno un operatore attivo lavora (per le date proponibili)
    'working_weekdays', coalesce((select json_agg(distinct w.weekday order by w.weekday)
           from public.working_hours w join public.staff s on s.id = w.staff_id and s.active), '[]'::json),
    'faq', coalesce((select json_agg(json_build_object(
              'id', f.id, 'topic', f.topic, 'language', f.language,
              'question', f.question, 'answer', f.answer, 'keywords', f.keywords)
              order by f.sort_order, f.created_at)
           from public.ai_faq f where f.active), '[]'::json)
  );
$$;

-- ---------------------------------------------------------------------
-- Inizio di un turno di chat, in modo atomico:
--  * verifica attivazione, sessione (creata se assente/scaduta), limite messaggi per sessione,
--    limiti giornalieri globali (richieste, token, costo stimato) se il turno usa il modello;
--  * incrementa i contatori.
-- Ritorna ok=false con il motivo se il turno non è consentito.
-- ---------------------------------------------------------------------
create or replace function public.ai_begin_turn(
  p_token_hash text,       -- hash del token inviato dal browser (può essere null)
  p_new_token_hash text,   -- hash di un nuovo token, usato se serve una nuova sessione
  p_uses_model boolean
)
returns table (ok boolean, reason text, session_id uuid, session_created boolean, turns_left int)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_cfg public.ai_settings;
  v_sess public.ai_sessions;
  v_day date := (now() at time zone public.app_tz())::date;
  v_use public.ai_usage_daily;
  v_created boolean := false;
begin
  if current_user <> 'service_role' and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;

  select * into v_cfg from public.ai_settings where id = 1;
  if not found or not v_cfg.enabled then
    return query select false, 'DISABLED'::text, null::uuid, false, 0;
    return;
  end if;

  insert into public.ai_usage_daily (day) values (v_day) on conflict (day) do nothing;
  select * into v_use from public.ai_usage_daily where day = v_day for update;

  if p_token_hash is not null then
    select * into v_sess from public.ai_sessions
     where token_hash = p_token_hash and expires_at > now()
     for update;
  end if;

  if v_sess.id is null then
    if p_new_token_hash is null or p_new_token_hash !~ '^[0-9a-f]{64}$' then
      raise exception using message = 'INVALID_SESSION', errcode = 'P0001';
    end if;
    insert into public.ai_sessions (token_hash, expires_at)
    values (p_new_token_hash, now() + make_interval(mins => v_cfg.session_ttl_minutes))
    returning * into v_sess;
    v_created := true;
  end if;

  if v_sess.turns >= v_cfg.session_message_limit then
    update public.ai_usage_daily set blocked = blocked + 1, updated_at = now() where day = v_day;
    return query select false, 'SESSION_LIMIT'::text, v_sess.id, v_created, 0;
    return;
  end if;

  if p_uses_model and (
       v_use.model_turns >= v_cfg.daily_request_limit
    or (v_use.input_tokens + v_use.output_tokens) >= v_cfg.daily_token_limit
    or (v_cfg.daily_cost_limit_usd is not null and v_use.est_cost_usd >= v_cfg.daily_cost_limit_usd)
  ) then
    update public.ai_usage_daily set blocked = blocked + 1, updated_at = now() where day = v_day;
    return query select false, 'DAILY_LIMIT'::text, v_sess.id, v_created, v_cfg.session_message_limit - v_sess.turns;
    return;
  end if;

  update public.ai_sessions
     set turns = turns + 1,
         last_seen_at = now(),
         -- scadenza "scorrevole", ma mai oltre 24 ore dalla creazione
         expires_at = least(created_at + interval '24 hours', now() + make_interval(mins => v_cfg.session_ttl_minutes))
   where id = v_sess.id;

  update public.ai_usage_daily
     set turns = turns + 1,
         model_turns = model_turns + case when p_uses_model then 1 else 0 end,
         local_answers = local_answers + case when p_uses_model then 0 else 1 end,
         updated_at = now()
   where day = v_day;

  return query select true, null::text, v_sess.id, v_created, v_cfg.session_message_limit - v_sess.turns - 1;
end;
$$;

-- Registra i consumi effettivi di un turno (token e chiamate) e la stima del costo.
create or replace function public.ai_record_usage(
  p_session_id uuid,
  p_input_tokens int,
  p_output_tokens int,
  p_model_calls int,
  p_error boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_cfg public.ai_settings;
  v_day date := (now() at time zone public.app_tz())::date;
  v_cost numeric := 0;
begin
  if current_user <> 'service_role' and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  select * into v_cfg from public.ai_settings where id = 1;
  if v_cfg.input_price_per_mtok_usd is not null and v_cfg.output_price_per_mtok_usd is not null then
    v_cost := (greatest(p_input_tokens, 0) * v_cfg.input_price_per_mtok_usd
             + greatest(p_output_tokens, 0) * v_cfg.output_price_per_mtok_usd) / 1000000.0;
  end if;

  insert into public.ai_usage_daily (day) values (v_day) on conflict (day) do nothing;
  update public.ai_usage_daily
     set input_tokens = input_tokens + greatest(p_input_tokens, 0),
         output_tokens = output_tokens + greatest(p_output_tokens, 0),
         model_calls = model_calls + greatest(p_model_calls, 0),
         errors = errors + case when p_error then 1 else 0 end,
         est_cost_usd = est_cost_usd + v_cost,
         updated_at = now()
   where day = v_day;

  if p_session_id is not null then
    update public.ai_sessions
       set input_tokens = input_tokens + greatest(p_input_tokens, 0),
           output_tokens = output_tokens + greatest(p_output_tokens, 0)
     where id = p_session_id;
  end if;
end;
$$;

-- Pulizia: sessioni scadute da più di un giorno; consumi aggregati oltre 13 mesi.
create or replace function public.ai_purge()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  n int;
begin
  if current_user <> 'service_role' and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  delete from public.ai_sessions where expires_at < now() - interval '1 day';
  get diagnostics n = row_count;
  delete from public.ai_usage_daily where day < (now() at time zone public.app_tz())::date - 400;
  return n;
end;
$$;

-- =====================================================================
-- Sicurezza
-- =====================================================================
alter table public.ai_settings    enable row level security;
alter table public.ai_faq         enable row level security;
alter table public.ai_usage_daily enable row level security;
alter table public.ai_sessions    enable row level security;

revoke all on table public.ai_settings, public.ai_faq, public.ai_usage_daily, public.ai_sessions from anon;
-- Le sessioni non sono mai accessibili dal pannello: solo dal backend.
revoke all on table public.ai_sessions from authenticated;
revoke insert, update, delete on table public.ai_usage_daily from authenticated;
revoke insert, delete on table public.ai_settings from authenticated;

create policy ai_settings_select on public.ai_settings
  for select to authenticated using (public.is_admin());
create policy ai_settings_update on public.ai_settings
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

create policy ai_faq_select on public.ai_faq
  for select to authenticated using (public.is_admin());
create policy ai_faq_insert on public.ai_faq
  for insert to authenticated with check (public.is_owner());
create policy ai_faq_update on public.ai_faq
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy ai_faq_delete on public.ai_faq
  for delete to authenticated using (public.is_owner());

create policy ai_usage_select on public.ai_usage_daily
  for select to authenticated using (public.is_admin());

revoke execute on function public.ai_public_context() from public, anon, authenticated;
revoke execute on function public.ai_begin_turn(text, text, boolean) from public, anon, authenticated;
revoke execute on function public.ai_record_usage(uuid, int, int, int, boolean) from public, anon, authenticated;
revoke execute on function public.ai_purge() from public, anon, authenticated;
grant execute on function public.ai_public_context() to service_role;
grant execute on function public.ai_begin_turn(text, text, boolean) to service_role;
grant execute on function public.ai_record_usage(uuid, int, int, int, boolean) to service_role;
grant execute on function public.ai_purge() to service_role;
