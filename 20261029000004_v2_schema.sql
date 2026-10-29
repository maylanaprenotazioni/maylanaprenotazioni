-- =====================================================================
-- Maylana Booking v2 — Migrazione incrementale: schema
--  * clienti con nome e cognome separati (full_name mantenuto da trigger)
--  * impostazioni email, promemoria, limiti modifiche cliente
--  * spostamenti appuntamenti, proposte di nuova data, richieste di spostamento
--  * token di gestione per il cliente (solo hash)
--  * coda notifiche email (outbox) con idempotenza e retry
--  * audit log delle modifiche rilevanti
-- =====================================================================

-- ---------------------------------------------------------------------
-- Impostazioni
-- ---------------------------------------------------------------------
alter table public.business_settings
  add column notification_email text check (notification_email is null or length(notification_email) <= 200),
  add column email_instructions text check (email_instructions is null or length(email_instructions) <= 1000),
  add column customer_change_min_hours int not null default 24 check (customer_change_min_hours between 0 and 336),
  add column reminder_1_hours int default 24 check (reminder_1_hours is null or reminder_1_hours between 2 and 168),
  add column reminder_2_hours int check (reminder_2_hours is null or reminder_2_hours between 2 and 168),
  add constraint reminders_order check (reminder_2_hours is null or (reminder_1_hours is not null and reminder_2_hours < reminder_1_hours));

-- ---------------------------------------------------------------------
-- Clienti: nome e cognome
-- ---------------------------------------------------------------------
alter table public.customers
  add column first_name text,
  add column last_name text not null default '';

update public.customers
   set first_name = split_part(btrim(full_name), ' ', 1),
       last_name  = btrim(substr(btrim(full_name), length(split_part(btrim(full_name), ' ', 1)) + 1));

alter table public.customers
  alter column first_name set not null,
  add constraint customers_first_name_len check (length(btrim(first_name)) between 1 and 60),
  add constraint customers_last_name_len check (length(last_name) <= 60);

create or replace function public.customers_sync_full_name()
returns trigger
language plpgsql
as $$
begin
  new.first_name := btrim(regexp_replace(new.first_name, '\s+', ' ', 'g'));
  new.last_name := btrim(regexp_replace(coalesce(new.last_name, ''), '\s+', ' ', 'g'));
  new.full_name := btrim(new.first_name || ' ' || new.last_name);
  return new;
end;
$$;

create trigger trg_customers_full_name
  before insert or update of first_name, last_name on public.customers
  for each row execute function public.customers_sync_full_name();

create index customers_phone_idx on public.customers (phone_normalized);
create index customers_last_name_idx on public.customers (lower(last_name), lower(first_name));

-- ---------------------------------------------------------------------
-- Appuntamenti e richieste
-- ---------------------------------------------------------------------
alter table public.appointments
  add column rescheduled_at timestamptz;

alter table public.booking_requests
  add column proposed_starts_at timestamptz,
  add column proposed_staff_id uuid references public.staff (id) on delete set null,
  add column reschedule_of_appointment_id uuid references public.appointments (id) on delete set null;

-- Una sola richiesta di spostamento aperta per appuntamento
create unique index booking_requests_one_open_reschedule
  on public.booking_requests (reschedule_of_appointment_id)
  where reschedule_of_appointment_id is not null and status in ('pending', 'reschedule');

-- ---------------------------------------------------------------------
-- Token di gestione per il cliente (link personale nelle email).
-- Il token in chiaro non viene MAI salvato: solo SHA-256 esadecimale.
-- ---------------------------------------------------------------------
create table public.appointment_tokens (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index appointment_tokens_appt_idx on public.appointment_tokens (appointment_id);

-- ---------------------------------------------------------------------
-- Coda notifiche (outbox). Le notifiche vengono create nella stessa
-- transazione dell'operazione che le genera; l'invio avviene dopo,
-- dalle Netlify Functions. dedupe_key impedisce duplicati.
-- ---------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'booking_confirmed', 'request_received', 'request_approved', 'request_rejected',
    'request_proposal', 'appointment_rescheduled', 'appointment_cancelled', 'reminder',
    'salon_customer_change'
  )),
  audience text not null check (audience in ('customer', 'salon')),
  appointment_id uuid references public.appointments (id) on delete cascade,
  booking_request_id uuid references public.booking_requests (id) on delete cascade,
  dedupe_key text not null unique,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  recipient text,
  provider text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notifications_target check (appointment_id is not null or booking_request_id is not null)
);
create index notifications_queue_idx on public.notifications (status, next_attempt_at);
create index notifications_appt_idx on public.notifications (appointment_id);
create index notifications_request_idx on public.notifications (booking_request_id);

create trigger trg_notifications_updated
  before update on public.notifications
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  table_name text not null,
  row_id uuid,
  action text not null,
  actor_kind text not null,
  actor_user uuid,
  changes jsonb
);
create index audit_log_row_idx on public.audit_log (table_name, row_id, at desc);
create index audit_log_at_idx on public.audit_log (at desc);

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb;
  v_actor text := nullif(current_setting('app.actor', true), '');
  v_rid text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_changes := v_new - 'created_at' - 'updated_at';
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    select jsonb_object_agg(e.key, jsonb_build_object('da', v_old -> e.key, 'a', e.value))
      into v_changes
      from jsonb_each(v_new) e
     where e.key not in ('updated_at', 'created_at')
       and (v_old -> e.key) is distinct from e.value;
    if v_changes is null then
      return new;
    end if;
  else
    v_old := to_jsonb(old);
    v_changes := v_old;
  end if;

  v_rid := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'user_id', v_old ->> 'user_id', v_new ->> 'service_id', v_old ->> 'service_id');

  insert into public.audit_log (table_name, row_id, action, actor_kind, actor_user, changes)
  values (
    tg_table_name,
    case when v_rid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_rid::uuid end,
    lower(tg_op),
    case when auth.uid() is not null then 'admin' else coalesce(v_actor, 'system') end,
    auth.uid(),
    v_changes
  );
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['business_settings', 'services', 'staff', 'staff_services', 'working_hours',
                           'time_off', 'customers', 'booking_requests', 'appointments', 'admin_users'] loop
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.audit_row()', t);
  end loop;
end $$;
