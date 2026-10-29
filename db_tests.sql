-- =====================================================================
-- Test database Maylana Booking (v2): funzionali, idempotenza, sicurezza
--
-- Tutto in UNA transazione chiusa con ROLLBACK: non lascia dati.
-- Usare comunque un progetto di TEST.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/db_tests.sql
--
-- Ogni controllo fallito interrompe lo script con "TEST FALLITO: ...".
-- Nota: dentro una transazione now() è costante: i test ne tengono conto.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
begin;

-- ---------- dati di test ----------
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'zz-owner@example.invalid'),
  ('aaaaaaaa-0000-4000-8000-0000000000a2', 'zz-staff@example.invalid'),
  ('aaaaaaaa-0000-4000-8000-0000000000a3', 'zz-intruso@example.invalid');
insert into public.admin_users (user_id, role) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'owner'),
  ('aaaaaaaa-0000-4000-8000-0000000000a2', 'staff');

insert into public.staff (id, display_name, sort_order) values
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'ZZ Test A', 1),
  ('bbbbbbbb-0000-4000-8000-0000000000b2', 'ZZ Test B', 2);
insert into public.services (id, category, name, duration_minutes, booking_mode, active) values
  ('cccccccc-0000-4000-8000-0000000000c1', 'hair', 'ZZ Test taglio', 30, 'automatic', true),
  ('cccccccc-0000-4000-8000-0000000000c2', 'consultation', 'ZZ Test consulenza', 60, 'manual', true);
insert into public.staff_services
  select s, v from unnest(array['bbbbbbbb-0000-4000-8000-0000000000b1','bbbbbbbb-0000-4000-8000-0000000000b2']::uuid[]) s,
                   unnest(array['cccccccc-0000-4000-8000-0000000000c1','cccccccc-0000-4000-8000-0000000000c2']::uuid[]) v;
insert into public.working_hours (staff_id, weekday, start_time, end_time)
  select s, d, t.a, t.b
  from unnest(array['bbbbbbbb-0000-4000-8000-0000000000b1','bbbbbbbb-0000-4000-8000-0000000000b2']::uuid[]) s,
       generate_series(1, 7) d,
       (values ('09:00'::time, '13:00'::time), ('15:00', '19:00')) t(a, b);
update public.business_settings
   set min_notice_minutes = 0, booking_horizon_days = 365, online_booking_enabled = true,
       customer_change_min_hours = 24, reminder_1_hours = 24, reminder_2_hours = null;

create temp table t_ctx as
select ((now() at time zone 'Europe/Rome')::date + 7) as d7,
       ((now() at time zone 'Europe/Rome')::date + 9) as d9,
       (((now() at time zone 'Europe/Rome')::date + 7) + time '10:00') at time zone 'Europe/Rome' as slot10,
       (((now() at time zone 'Europe/Rome')::date + 7) + time '10:15') at time zone 'Europe/Rome' as slot1015,
       (((now() at time zone 'Europe/Rome')::date + 7) + time '13:00') at time zone 'Europe/Rome' as slot13,
       (((now() at time zone 'Europe/Rome')::date + 7) + time '20:00') at time zone 'Europe/Rome' as slot20,
       (((now() at time zone 'Europe/Rome')::date + 8) + time '11:00') at time zone 'Europe/Rome' as d8_11,
       (((now() at time zone 'Europe/Rome')::date + 8) + time '15:00') at time zone 'Europe/Rome' as d8_15,
       (((now() at time zone 'Europe/Rome')::date + 10) + time '09:00') at time zone 'Europe/Rome' as d10_09,
       (((now() at time zone 'Europe/Rome')::date + 10) + time '16:00') at time zone 'Europe/Rome' as d10_16;
grant select on t_ctx to anon, authenticated, service_role;

create or replace function pg_temp.expect_error(p_sql text, p_expected text)
returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'TEST FALLITO: atteso errore % per: %', p_expected, p_sql;
exception
  when others then
    if sqlerrm like 'TEST FALLITO%' then raise; end if;
    if p_expected is not null and sqlerrm <> p_expected and sqlstate <> p_expected then
      raise exception 'TEST FALLITO: atteso %, ottenuto % (%) per: %', p_expected, sqlerrm, sqlstate, p_sql;
    end if;
end $$;
grant execute on function pg_temp.expect_error(text, text) to anon, authenticated, service_role;

create or replace function pg_temp.check(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'TEST FALLITO: %', p_msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to anon, authenticated, service_role;

-- =====================================================================
-- BACKEND (service_role): disponibilità, prenotazione, deduplica
-- =====================================================================
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null

do $$
declare r record; n int; c1 uuid; c2 uuid;
begin
  select count(*) into n from get_available_slots('cccccccc-0000-4000-8000-0000000000c1', (select d7 from t_ctx));
  perform pg_temp.check(n = 60, 'slot attesi 60, trovati ' || n);

  if (now() at time zone 'Europe/Rome')::date + 365 >= date '2027-03-28' then
    perform pg_temp.check((select min(starts_at) from get_available_slots('cccccccc-0000-4000-8000-0000000000c1', date '2027-03-28'))
      = timestamptz '2027-03-28 07:00:00+00', 'ora legale: 09:00 Roma = 07:00 UTC');
  end if;

  select * into r from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select slot10 from t_ctx),
    'ZZ Mario', 'Rossi', '+39 333 0000001', 'zz1@example.invalid', null, true);
  perform pg_temp.check(r.code ~ '^MY-[A-Z0-9]{6}$', 'formato codice');
  perform pg_temp.check(r.notification_id is not null, 'notifica di conferma accodata');
  perform pg_temp.check((select kind from notifications where id = r.notification_id) = 'booking_confirmed', 'tipo notifica');

  select * into r from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select slot10 from t_ctx),
    'ZZ Luca', 'Bianchi', '3330000002', 'zz2@example.invalid', null, true);
  perform pg_temp.check(r.staff_name = 'ZZ Test B', 'secondo cliente sul secondo operatore');

  -- Deduplica: stesso telefono+email → stessa scheda; nome non sovrascritto
  select * into r from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select d8_11 from t_ctx),
    'Altro', 'Nome', '+39 333 000 0001', 'ZZ1@example.invalid', null, true);
  select count(*) into n from customers where phone_normalized = '+393330000001';
  perform pg_temp.check(n = 1, 'deduplica telefono+email (' || n || ' schede)');
  perform pg_temp.check((select first_name || ' ' || last_name from customers where phone_normalized = '+393330000001') = 'ZZ Mario Rossi',
    'dati anagrafici non sovrascritti da input pubblico');

  -- Scheda creata senza email (es. dal salone), poi prenotazione online con email → stessa scheda
  c1 := upsert_customer('ZZ Anna', 'Neri', '347 555 1234', null);
  c2 := upsert_customer('ZZ Anna', 'Neri', '+347 555 1234', 'anna.neri@example.invalid');
  perform pg_temp.check(c1 = c2 or (select count(*) from customers where phone_normalized like '%3475551234') = 2,
    'deduplica: telefono con/senza prefisso + gestito come numero diverso');
  c2 := upsert_customer('ZZ Anna', 'Neri', '347-555-1234', 'anna.neri@example.invalid');
  perform pg_temp.check(c1 = c2, 'deduplica: scheda senza email completata');
  perform pg_temp.check((select email_normalized from customers where id = c1) = 'anna.neri@example.invalid', 'email aggiunta alla scheda');
  perform pg_temp.check((select full_name from customers where id = c1) = 'ZZ Anna Neri', 'full_name mantenuto dal trigger');
end $$;

select pg_temp.expect_error($q$select * from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select slot10 from t_ctx), 'ZZ', 'Terzo', '3330000003', 'zz3@example.invalid', null, true)$q$, 'SLOT_UNAVAILABLE') \g /dev/null
select pg_temp.expect_error($q$select * from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select slot1015 from t_ctx), 'ZZ', 'Quarto', '3330000004', 'zz4@example.invalid', null, true)$q$, 'SLOT_UNAVAILABLE') \g /dev/null
select pg_temp.expect_error($q$select * from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select slot13 from t_ctx), 'ZZ', 'Quinto', '3330000005', 'zz5@example.invalid', null, true)$q$, 'SLOT_UNAVAILABLE') \g /dev/null
select pg_temp.expect_error($q$select * from book_appointment(array['cccccccc-0000-4000-8000-0000000000c2']::uuid[], null, (select slot10 from t_ctx), 'ZZ', 'Sesto', '3330000006', 'zz6@example.invalid', null, true)$q$, 'REQUIRES_APPROVAL') \g /dev/null
select pg_temp.expect_error($q$select * from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select d10_09 from t_ctx), 'ZZ', 'Settimo', '3330000007', 'zz7@example.invalid', null, false)$q$, 'PRIVACY_REQUIRED') \g /dev/null
select pg_temp.expect_error($q$select * from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select d10_09 from t_ctx), 'ZZ', '', '3330000008', 'zz8@example.invalid', null, true)$q$, 'INVALID_NAME') \g /dev/null
select pg_temp.expect_error($q$select * from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], null, (select d10_09 from t_ctx), 'ZZ', 'Nono', 'abc', 'zz9@example.invalid', null, true)$q$, 'INVALID_PHONE') \g /dev/null
select pg_temp.expect_error($q$insert into appointments (service_id, staff_id, customer_id, starts_at, ends_at, source)
  select service_id, staff_id, customer_id, starts_at + interval '5 min', ends_at + interval '5 min', 'admin' from appointments where source = 'online' limit 1$q$, '23P01') \g /dev/null

-- =====================================================================
-- Notifiche: idempotenza, claim, retry
-- =====================================================================
do $$
declare a uuid; id1 uuid; id2 uuid; n int; st text; rec record;
begin
  select id into a from appointments order by created_at limit 1;
  id1 := enqueue_notification('appointment_cancelled', 'customer', a, null, 'zz-dedupe-test');
  id2 := enqueue_notification('appointment_cancelled', 'customer', a, null, 'zz-dedupe-test');
  perform pg_temp.check(id1 = id2 and (select count(*) from notifications where dedupe_key = 'zz-dedupe-test') = 1, 'dedupe_key idempotente');

  select count(*) into n from claim_notifications(100, array[id1]);
  perform pg_temp.check(n = 1, 'claim prende la notifica');
  select count(*) into n from claim_notifications(100, array[id1]);
  perform pg_temp.check(n = 0, 'notifica in invio non reclamabile due volte');

  st := complete_notification(id1, 'failed', 'HTTP 503', true);
  perform pg_temp.check(st = 'pending', 'errore temporaneo → nuovo tentativo programmato');
  select * into rec from notifications where id = id1;
  perform pg_temp.check(rec.next_attempt_at > now() and rec.attempts = 1 and rec.last_error = 'HTTP 503', 'backoff e log errore');
  select count(*) into n from claim_notifications(100, array[id1]);
  perform pg_temp.check(n = 0, 'prima del backoff non si ritenta');

  update notifications set next_attempt_at = now(), attempts = 5 where id = id1;
  perform claim_notifications(100, array[id1]);
  st := complete_notification(id1, 'failed', 'HTTP 503', true);
  perform pg_temp.check(st = 'failed', 'superati i tentativi massimi → fallita definitivamente');

  st := complete_notification(id1, 'sent', null, false);
  perform pg_temp.check(st = 'failed', 'completamento ignorato se non in invio (niente falsi "inviata")');
end $$;

-- =====================================================================
-- Promemoria
-- =====================================================================
reset role;
-- appuntamenti di prova a +23h e +25h, creati 2 giorni fa; uno a +23h creato ora
insert into public.appointments (service_id, staff_id, customer_id, starts_at, ends_at, source, created_at)
select 'cccccccc-0000-4000-8000-0000000000c1', 'bbbbbbbb-0000-4000-8000-0000000000b1', c.id,
       now() + v.h, now() + v.h + interval '30 min', 'admin', now() - v.created
  from (select id from customers where email_normalized = 'zz1@example.invalid') c,
       (values (interval '23 hours', interval '2 days'), (interval '25 hours', interval '2 days'),
               (interval '22 hours', interval '0 minutes')) v(h, created);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
do $$
declare n int; n2 int; ctx jsonb; nid uuid;
begin
  n := enqueue_due_reminders();
  perform pg_temp.check(n = 1, 'un solo promemoria dovuto (trovati ' || n || ')');
  n2 := enqueue_due_reminders();
  perform pg_temp.check(n2 = 0, 'promemoria non duplicato alla seconda esecuzione');

  select id into nid from notifications where kind = 'reminder' limit 1;
  ctx := notification_context(nid);
  perform pg_temp.check((ctx ->> 'valid')::boolean and (ctx ->> 'needs_link')::boolean, 'contesto promemoria valido con link');
  perform pg_temp.check(ctx ->> 'recipient' = 'zz1@example.invalid', 'destinatario promemoria');

  -- se l'appuntamento viene annullato, il promemoria non va inviato
  update appointments set status = 'cancelled' where id = (select appointment_id from notifications where id = nid);
  ctx := notification_context(nid);
  perform pg_temp.check(not (ctx ->> 'valid')::boolean, 'promemoria di appuntamento annullato non valido');
end $$;

-- =====================================================================
-- Link cliente (token)
-- =====================================================================
do $$
declare
  a uuid; ctx jsonb; res jsonb; tok_id uuid;
  h1 text := encode(sha256('zz-token-1'::bytea), 'hex');
  h2 text := encode(sha256('zz-token-2'::bytea), 'hex');
  h3 text := encode(sha256('zz-token-3'::bytea), 'hex');
  h4 text := encode(sha256('zz-token-4'::bytea), 'hex');
begin
  select appointment_id into a from book_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b1',
    (select d10_09 from t_ctx), 'ZZ Giulia', 'Verdi', '3401112223', 'giulia@example.invalid', null, true);
  perform issue_manage_token(a, h1);
  perform pg_temp.check(not exists (select 1 from appointment_tokens where token_hash = 'zz-token-1'), 'token in chiaro mai salvato');

  ctx := customer_get_appointment(h1);
  perform pg_temp.check(ctx ->> 'service_name' = 'ZZ Test taglio' and (ctx ->> 'can_change')::boolean, 'lettura appuntamento con token');
  perform pg_temp.check(not (ctx ? 'phone') and not (ctx ? 'email'), 'nessun recapito esposto nella pagina cliente');

  -- spostamento self-service su slot libero
  res := customer_reschedule_appointment(h1, (select d10_16 from t_ctx), null);
  perform pg_temp.check((select starts_at from appointments where id = a) = (select d10_16 from t_ctx), 'spostamento eseguito');
  perform pg_temp.check((select used_at is not null from appointment_tokens where token_hash = h1), 'token usato marcato');
  perform pg_temp.check(jsonb_array_length(res -> 'notification_ids') = 2, 'notifica cliente + salone');
  perform pg_temp.check(exists (select 1 from audit_log where table_name = 'appointments' and row_id = a and actor_kind = 'customer'),
    'storico modifiche con autore cliente');
end $$;

select pg_temp.expect_error($q$select customer_get_appointment(encode(sha256('zz-token-1'::bytea), 'hex'))$q$, 'INVALID_TOKEN') \g /dev/null
select pg_temp.expect_error($q$select customer_get_appointment(encode(sha256('inesistente'::bytea), 'hex'))$q$, 'INVALID_TOKEN') \g /dev/null
select pg_temp.expect_error($q$select customer_get_appointment('non-esadecimale')$q$, 'INVALID_TOKEN') \g /dev/null

do $$
declare a uuid; res jsonb;
  h2 text := encode(sha256('zz-token-2'::bytea), 'hex');
  h3 text := encode(sha256('zz-token-3'::bytea), 'hex');
begin
  select id into a from appointments where customer_id = (select id from customers where email_normalized = 'giulia@example.invalid');
  -- spostamento verso slot occupato
  perform issue_manage_token(a, h2);
  perform pg_temp.expect_error(format($q$select customer_reschedule_appointment(%L, (select slot10 from t_ctx), 'bbbbbbbb-0000-4000-8000-0000000000b1')$q$, h2), 'SLOT_UNAVAILABLE');
  -- limite temporale
  update business_settings set customer_change_min_hours = 336;
  perform pg_temp.expect_error(format($q$select customer_cancel_appointment(%L)$q$, h2), 'CHANGE_DEADLINE_PASSED');
  update business_settings set customer_change_min_hours = 24;
  -- annullamento: token revocato dopo l'uso, notifiche cliente + salone
  perform issue_manage_token(a, h3);
  res := customer_cancel_appointment(h2);
  perform pg_temp.check((select status from appointments where id = a) = 'cancelled', 'annullamento cliente');
  perform pg_temp.check((select revoked_at is not null from appointment_tokens where token_hash = h3), 'altri token revocati');
  perform pg_temp.check((select count(*) from notifications where dedupe_key in ('appointment_cancelled:' || a, 'salon_cancel:' || a)) = 2,
    'notifiche annullamento');
  perform pg_temp.expect_error(format($q$select customer_cancel_appointment(%L)$q$, h2), 'INVALID_TOKEN');
  perform pg_temp.expect_error(format($q$select issue_manage_token(%L, %L)$q$, a, encode(sha256('x'::bytea), 'hex')), 'APPOINTMENT_NOT_ACTIVE');
end $$;

-- =====================================================================
-- Richieste: consulenza, approvazione unica, proposta, spostamento richiesto
-- =====================================================================
do $$
declare r record; n int;
begin
  select * into r from create_booking_request(array['cccccccc-0000-4000-8000-0000000000c2']::uuid[], 'ZZ Paola', 'Ferri', '3470000001',
    'zz-paola@example.invalid', (select d7 from t_ctx) + 6, 'mattina', null, null, true);
  perform pg_temp.check(r.status = 'pending' and r.notification_id is not null, 'richiesta + notifica ricevuta');
  select count(*) into n from get_available_slots('cccccccc-0000-4000-8000-0000000000c2', (select d7 from t_ctx) + 6);
  perform pg_temp.check(n = 52, 'richiesta in attesa non blocca slot');
  insert into time_off (staff_id, starts_at, ends_at, kind)
  values (null, ((select d9 from t_ctx)::timestamp) at time zone 'Europe/Rome', (((select d9 from t_ctx) + 1)::timestamp) at time zone 'Europe/Rome', 'chiusura');
  select count(*) into n from get_available_slots('cccccccc-0000-4000-8000-0000000000c1', (select d9 from t_ctx));
  perform pg_temp.check(n = 0, 'giorno di chiusura senza slot');
end $$;

-- =====================================================================
-- ANON: nessun accesso
-- =====================================================================
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true) \g /dev/null
select pg_temp.expect_error('select 1 from public.customers limit 1', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.appointments limit 1', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.booking_requests limit 1', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.notifications limit 1', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.appointment_tokens limit 1', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.audit_log limit 1', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.admin_users limit 1', '42501') \g /dev/null
select pg_temp.expect_error($q$select * from public.book_appointment(null::uuid[], null, now(), 'x', 'y', '1', 'x', null, true)$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select public.customer_get_appointment('x')$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select public.customer_cancel_appointment('x')$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select * from public.claim_notifications(10, null)$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select public.enqueue_due_reminders()$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select public.check_rate_limit('x', 1, 60)$q$, '42501') \g /dev/null

-- =====================================================================
-- AUTENTICATO NON ADMIN
-- =====================================================================
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a3"}', true) \g /dev/null
select pg_temp.check((select count(*) from customers) + (select count(*) from appointments) + (select count(*) from notifications)
  + (select count(*) from audit_log) = 0, 'utente non admin non vede dati') \g /dev/null
select pg_temp.expect_error($q$select public.customer_get_appointment(encode(sha256('x'::bytea), 'hex'))$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select * from public.claim_notifications(10, null)$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select public.issue_manage_token(gen_random_uuid(), encode(sha256('x'::bytea), 'hex'))$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select public.admin_overview(current_date)$q$, 'FORBIDDEN') \g /dev/null
select pg_temp.expect_error($q$select * from public.admin_customers(null, 10)$q$, 'FORBIDDEN') \g /dev/null
select pg_temp.expect_error($q$select public.admin_cancel_appointment(gen_random_uuid())$q$, 'FORBIDDEN') \g /dev/null
select pg_temp.expect_error($q$select public.admin_create_appointment(null::uuid[], null, now(), 'x', 'y', '1')$q$, 'FORBIDDEN') \g /dev/null
select pg_temp.expect_error($q$insert into admin_users (user_id, role) values ('aaaaaaaa-0000-4000-8000-0000000000a3', 'owner')$q$, '42501') \g /dev/null

-- =====================================================================
-- ADMIN ruolo staff
-- =====================================================================
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a2"}', true) \g /dev/null
do $$
declare v_req uuid; res jsonb; a uuid; n int;
begin
  update services set price_cents = 1 where id = 'cccccccc-0000-4000-8000-0000000000c1';
  perform pg_temp.check((select price_cents from services where id = 'cccccccc-0000-4000-8000-0000000000c1') is null, 'lo staff non modifica i prezzi');
  perform pg_temp.expect_error('select 1 from appointment_tokens', '42501');
  perform pg_temp.expect_error($q$update notifications set status = 'sent'$q$, '42501');
  perform pg_temp.expect_error($q$delete from audit_log$q$, '42501');
  perform pg_temp.check((select count(*) from notifications) > 0, 'lo staff vede lo stato delle email');

  v_req := (select id from booking_requests where customer_id = (select id from customers where email_normalized = 'zz-paola@example.invalid'));
  -- orario occupato → rifiutata, la richiesta resta in attesa
  perform pg_temp.expect_error(format($q$select admin_confirm_request(%L, 'bbbbbbbb-0000-4000-8000-0000000000b1', (select slot10 from t_ctx))$q$, v_req), 'SLOT_UNAVAILABLE');
  perform pg_temp.check((select status from booking_requests where id = v_req) = 'pending', 'richiesta ancora in attesa dopo conflitto');

  -- proposta nuova data
  res := admin_propose_request_time(v_req, 'bbbbbbbb-0000-4000-8000-0000000000b2', (select d8_15 from t_ctx), 'Proposta pomeriggio');
  perform pg_temp.check((select status from booking_requests where id = v_req) = 'reschedule', 'proposta → da riprogrammare');
  perform pg_temp.check((select count(*) from notifications where booking_request_id = v_req and kind = 'request_proposal') = 1, 'email proposta accodata');

  -- approvazione
  res := admin_confirm_request(v_req, 'bbbbbbbb-0000-4000-8000-0000000000b2', (select d8_15 from t_ctx));
  a := (res ->> 'appointment_id')::uuid;
  perform pg_temp.check((select status from booking_requests where id = v_req) = 'confirmed', 'richiesta confermata');
  perform pg_temp.check((select kind from notifications where id = (res -> 'notification_ids' ->> 0)::uuid) = 'request_approved', 'email approvazione accodata');
  -- seconda approvazione → rifiutata (nessun duplicato)
  perform pg_temp.expect_error(format($q$select admin_confirm_request(%L, 'bbbbbbbb-0000-4000-8000-0000000000b1', (select d8_11 from t_ctx))$q$, v_req), 'REQUEST_NOT_CONFIRMABLE');
  select count(*) into n from appointments where booking_request_id = v_req;
  perform pg_temp.check(n = 1, 'un solo appuntamento per richiesta');

  -- spostamento admin: conflitto e successo
  perform pg_temp.expect_error(format($q$select admin_move_appointment(%L, 'bbbbbbbb-0000-4000-8000-0000000000b1', (select slot10 from t_ctx))$q$, a), 'SLOT_UNAVAILABLE');
  res := admin_move_appointment(a, 'bbbbbbbb-0000-4000-8000-0000000000b1', (select d8_11 from t_ctx) + interval '1 hour');
  perform pg_temp.check((select starts_at from appointments where id = a) = (select d8_11 from t_ctx) + interval '1 hour', 'spostamento admin');
  perform pg_temp.check(jsonb_array_length(res -> 'notification_ids') = 1, 'email spostamento accodata');

  -- annullamento admin idempotente
  res := admin_cancel_appointment(a, 'Test');
  perform pg_temp.check((select status from appointments where id = a) = 'cancelled', 'annullamento admin');
  res := admin_cancel_appointment(a, 'Test');
  perform pg_temp.check(jsonb_array_length(res -> 'notification_ids') = 0, 'secondo annullamento senza nuove email');
  perform pg_temp.check((select status from booking_requests where id = v_req) = 'cancelled', 'richiesta collegata annullata');

  -- inserimento manuale fuori orario
  perform pg_temp.expect_error($q$select admin_create_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b1', (select slot20 from t_ctx), 'ZZ', 'Telefono', '3339990000')$q$, 'OUTSIDE_WORKING_HOURS');
  res := admin_create_appointment(array['cccccccc-0000-4000-8000-0000000000c1']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b1',
    (select slot20 from t_ctx), 'ZZ', 'Telefono', '3339990000', null, null, true, true);
  perform pg_temp.check(res ->> 'appointment_id' is not null, 'inserimento forzato');
  perform pg_temp.check((select count(*) from admin_search_appointments('ZZ Mario')) >= 1, 'ricerca appuntamenti');
  perform pg_temp.check((select count(*) from admin_customers('Rossi', 10)) = 1, 'ricerca clienti per cognome');
  perform pg_temp.check((admin_overview((select d7 from t_ctx)) ->> 'today_count')::int = 3, 'panoramica: appuntamenti del giorno');
  perform pg_temp.check(exists (select 1 from audit_log where table_name = 'appointments' and actor_kind = 'admin'
                                  and actor_user = 'aaaaaaaa-0000-4000-8000-0000000000a2'), 'audit con utente admin');
end $$;

-- spostamento richiesto dal cliente per un servizio su approvazione
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
do $$
declare r record; a uuid; res jsonb;
  h4 text := encode(sha256('zz-token-4'::bytea), 'hex');
  h5 text := encode(sha256('zz-token-5'::bytea), 'hex');
begin
  select * into r from create_booking_request(array['cccccccc-0000-4000-8000-0000000000c2']::uuid[], 'ZZ Elena', 'Riva', '3470000002',
    'zz-elena@example.invalid', null, 'indifferente', null, null, true);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a1"}', true);
  -- (owner tramite service role non è admin: usa direttamente l'insert simulando un appuntamento confermato)
  insert into appointments (service_id, staff_id, customer_id, booking_request_id, starts_at, ends_at, source)
  select 'cccccccc-0000-4000-8000-0000000000c2', 'bbbbbbbb-0000-4000-8000-0000000000b1', customer_id, id,
         (select d10_09 from t_ctx) + interval '1 hour', (select d10_09 from t_ctx) + interval '2 hours', 'request'
    from booking_requests where id = r.request_id
  returning id into a;
  update booking_requests set status = 'confirmed' where id = r.request_id;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  perform issue_manage_token(a, h4);
  perform pg_temp.check(not (customer_get_appointment(h4) ->> 'self_reschedule')::boolean, 'consulenza: niente spostamento self-service');
  perform pg_temp.expect_error(format($q$select customer_reschedule_appointment(%L, (select d10_16 from t_ctx))$q$, h4), 'SELF_RESCHEDULE_NOT_ALLOWED');
  res := customer_request_reschedule(h4, (select d7 from t_ctx) + 5, 'pomeriggio', null);
  perform pg_temp.check((select status from appointments where id = a) = 'confirmed', 'appuntamento resta valido durante la richiesta');
  perform issue_manage_token(a, h5);
  perform pg_temp.expect_error(format($q$select customer_request_reschedule(%L, null, 'indifferente', null)$q$, h5), 'RESCHEDULE_ALREADY_REQUESTED');
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a1"}', true) \g /dev/null
do $$
declare v_req uuid; a uuid; res jsonb;
begin
  select id, reschedule_of_appointment_id into v_req, a from booking_requests where reschedule_of_appointment_id is not null;
  res := admin_confirm_request(v_req, 'bbbbbbbb-0000-4000-8000-0000000000b2', (select d10_16 from t_ctx));
  perform pg_temp.check((res ->> 'appointment_id')::uuid = a, 'conferma spostamento: stesso appuntamento');
  perform pg_temp.check((select starts_at from appointments where id = a) = (select d10_16 from t_ctx), 'appuntamento originale spostato');
  perform pg_temp.check((select count(*) from appointments where customer_id = (select id from customers where email_normalized = 'zz-elena@example.invalid') and status = 'confirmed') = 1,
    'nessun appuntamento duplicato');
  update services set price_cents = 2500 where id = 'cccccccc-0000-4000-8000-0000000000c1';
  perform pg_temp.check((select price_cents from services where id = 'cccccccc-0000-4000-8000-0000000000c1') = 2500, 'owner modifica i prezzi');
  perform pg_temp.check(exists (select 1 from audit_log where table_name = 'services' and changes ? 'price_cents'), 'audit cambio prezzo');
end $$;


-- =====================================================================
-- v3: SERVIZI MULTIPLI, MOTORE ORARI, IDEMPOTENZA, MODIFICHE COMBINATE
-- =====================================================================
reset role;
insert into public.services (id, category, name, duration_minutes, buffer_after_minutes, booking_mode, active, price_cents, price_from) values
  ('cccccccc-0000-4000-8000-0000000000d1', 'hair', 'ZZ3 Taglio donna', 45, 0, 'automatic', true, 3000, false),
  ('cccccccc-0000-4000-8000-0000000000d2', 'hair', 'ZZ3 Piega', 30, 0, 'automatic', true, 2000, false),
  ('cccccccc-0000-4000-8000-0000000000d3', 'hair', 'ZZ3 Colore', 60, 15, 'manual', true, 4500, true),
  ('cccccccc-0000-4000-8000-0000000000d4', 'hair', 'ZZ3 Taglio uomo', 30, 0, 'automatic', true, null, false);
insert into public.staff (id, display_name, sort_order) values ('bbbbbbbb-0000-4000-8000-0000000000b3', 'ZZ3 Op C', 3);
-- C fa tutto; A fa solo taglio donna e taglio uomo
insert into public.staff_services values
  ('bbbbbbbb-0000-4000-8000-0000000000b3', 'cccccccc-0000-4000-8000-0000000000d1'),
  ('bbbbbbbb-0000-4000-8000-0000000000b3', 'cccccccc-0000-4000-8000-0000000000d2'),
  ('bbbbbbbb-0000-4000-8000-0000000000b3', 'cccccccc-0000-4000-8000-0000000000d3'),
  ('bbbbbbbb-0000-4000-8000-0000000000b3', 'cccccccc-0000-4000-8000-0000000000d4'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'cccccccc-0000-4000-8000-0000000000d1'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'cccccccc-0000-4000-8000-0000000000d4');
insert into public.working_hours (staff_id, weekday, start_time, end_time)
  select 'bbbbbbbb-0000-4000-8000-0000000000b3', d, '09:00', '12:00' from generate_series(1, 7) d;
create temp table t3 as
select ((now() at time zone 'Europe/Rome')::date + 20) as d20,
       ((now() at time zone 'Europe/Rome')::date + 21) as d21,
       ((now() at time zone 'Europe/Rome')::date + 22) as d22,
       array['cccccccc-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000d2']::uuid[] as tp,
       array['cccccccc-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000d3']::uuid[] as tc;
grant select on t3 to anon, authenticated, service_role;
create or replace function pg_temp.at(d date, t text) returns timestamptz language sql immutable as $$ select (d + t::time) at time zone 'Europe/Rome' $$;
grant execute on function pg_temp.at(date, text) to authenticated, service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
do $$
declare b record; n int; r record; k uuid := gen_random_uuid(); a1 uuid; a2 uuid; s1 timestamptz;
begin
  -- 1. Durata e prezzo totali
  select * into b from bundle_info((select tp from t3));
  perform pg_temp.check(b.valid and b.duration_minutes = 75 and b.block_minutes = 75, 'durata totale 45+30=75');
  perform pg_temp.check(b.price_cents = 5000 and not b.price_is_estimate, 'prezzo totale 30+20=50 €');
  perform pg_temp.check(b.eligible_staff = array['bbbbbbbb-0000-4000-8000-0000000000b3']::uuid[], 'un solo operatore abilitato a tutti i servizi');
  perform pg_temp.check(b.label = 'ZZ3 Taglio donna + ZZ3 Piega', 'etichetta nell''ordine scelto');
  select * into b from bundle_info((select tc from t3));
  perform pg_temp.check(b.valid and not b.all_automatic and b.block_minutes = 120 and b.price_is_estimate, 'colore: manuale, +15'' preparazione, prezzo "da"');
  select * into b from bundle_info(array['cccccccc-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000d4']::uuid[]);
  perform pg_temp.check(b.price_cents is null and b.price_is_estimate, 'prezzo non pubblicato → totale "in salone"');
  perform pg_temp.check(not (select valid from bundle_info(array['cccccccc-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000d1']::uuid[])), 'servizi duplicati rifiutati');
  perform pg_temp.check((select error from bundle_info(array['cccccccc-0000-4000-8000-0000000000c2', 'cccccccc-0000-4000-8000-0000000000d1']::uuid[])) = 'CONSULTATION_SINGLE', 'consulenza non combinabile');

  -- 2. Solo slot con 75 minuti consecutivi nel turno 9-12 dell'operatore C
  select count(*) into n from get_bundle_slots((select tp from t3), (select d20 from t3));
  perform pg_temp.check(n = 8, 'slot 75'' nel turno 9-12 ogni 15'' = 8 (trovati ' || n || ')');
  perform pg_temp.check((select max(ends_at) from get_bundle_slots((select tp from t3), (select d20 from t3))) = pg_temp.at((select d20 from t3), '12:00'),
    'ultimo slot termina esattamente a fine turno');
  perform pg_temp.check(not exists (select 1 from get_bundle_slots((select tp from t3), (select d20 from t3)) where staff_id <> 'bbbbbbbb-0000-4000-8000-0000000000b3'),
    'nessuno slot su operatori non abilitati a tutti i servizi');

  -- tempi aggiuntivi: preparazione del servizio + tempo globale
  update business_settings set booking_buffer_minutes = 15;
  select count(*) into n from get_bundle_slots((select tp from t3), (select d20 from t3));
  perform pg_temp.check(n = 7, 'con 15'' aggiuntivi il blocco è 90'' → 7 slot (trovati ' || n || ')');
  update business_settings set booking_buffer_minutes = 0;

  -- orari di apertura del salone: 9:30-11:30 → slot 9:30..10:15
  insert into opening_hours (weekday, start_time, end_time) select d, '09:30', '11:30' from generate_series(1, 7) d;
  select count(*), min(starts_at) into n, s1 from get_bundle_slots((select tp from t3), (select d20 from t3));
  perform pg_temp.check(n = 4 and s1 = pg_temp.at((select d20 from t3), '09:30'), 'slot limitati all''apertura del salone (trovati ' || n || ')');
  delete from opening_hours;

  -- 3. Prenotazione multi-servizio + idempotenza
  select * into r from book_appointment((select tp from t3), null, pg_temp.at((select d20 from t3), '09:00'),
    'ZZ Viola', 'Multi', '3401000001', 'viola@example.invalid', null, true, true, k);
  a1 := r.appointment_id;
  perform pg_temp.check(r.duration_minutes = 75 and r.total_price_cents = 5000 and r.ends_at = pg_temp.at((select d20 from t3), '10:15'), 'prenotazione: durata, prezzo, fine');
  perform pg_temp.check((select count(*) from appointment_items where appointment_id = a1) = 2, 'due servizi registrati in appointment_items');
  perform pg_temp.check((select marketing_consent from customers where email_normalized = 'viola@example.invalid'), 'consenso marketing registrato solo se dato');
  select * into r from book_appointment((select tp from t3), null, pg_temp.at((select d20 from t3), '09:00'),
    'ZZ Viola', 'Multi', '3401000001', 'viola@example.invalid', null, true, true, k);
  perform pg_temp.check(r.replayed and r.appointment_id = a1, 'stessa richiesta ripetuta → stessa prenotazione');
  perform pg_temp.check((select count(*) from appointments where customer_id = (select id from customers where email_normalized = 'viola@example.invalid')) = 1, 'nessun duplicato');
  perform pg_temp.expect_error(format($q$select * from book_appointment((select tp from t3), null, pg_temp.at((select d20 from t3), '10:30'), 'X', 'Y', '3409999999', 'x@example.invalid', null, true, false, %L)$q$, k), 'IDEMPOTENCY_CONFLICT');

  -- 4. Slot che diventa occupato durante la procedura
  perform pg_temp.check(exists (select 1 from get_bundle_slots((select tp from t3), (select d20 from t3)) where starts_at = pg_temp.at((select d20 from t3), '10:15')),
    'cliente 2 vede le 10:15 libere');
  perform * from book_appointment(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b3', pg_temp.at((select d20 from t3), '10:30'),
    'ZZ Primo', 'Arrivato', '3401000002', 'primo@example.invalid', null, true);
  perform pg_temp.expect_error($q$select * from book_appointment((select tp from t3), null, pg_temp.at((select d20 from t3), '10:15'), 'ZZ', 'Secondo', '3401000003', 'secondo@example.invalid', null, true)$q$, 'SLOT_UNAVAILABLE');
  perform pg_temp.check(not exists (select 1 from get_bundle_slots((select tp from t3), (select d20 from t3)) where starts_at = pg_temp.at((select d20 from t3), '10:15')),
    'lo slot non viene più proposto');

  -- 5. Orari consigliati: spazio libero 10:15-10:30 troppo corto; 11:00-12:00 dopo il taglio uomo (10:30-11:00)
  perform pg_temp.check((select fit_rank from get_bundle_slots(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], (select d20 from t3), 'bbbbbbbb-0000-4000-8000-0000000000b3')
                          where starts_at = pg_temp.at((select d20 from t3), '11:00')) = 1, 'slot attaccato a un appuntamento: consigliato');
  -- creare il buco esatto di 30' tra 10:15 e 10:45 non è possibile (10:30 occupato): verifico un riempimento esatto
  perform * from book_appointment(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b3', pg_temp.at((select d20 from t3), '11:30'),
    'ZZ Terzo', 'Cliente', '3401000004', 'terzo@example.invalid', null, true);
  perform pg_temp.check((select fit_rank from get_bundle_slots(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], (select d20 from t3), 'bbbbbbbb-0000-4000-8000-0000000000b3')
                          where starts_at = pg_temp.at((select d20 from t3), '11:00')) = 0, 'servizio da 30'' nel buco da 30'': riempimento esatto (rank 0)');

  -- 6. Combinazione con servizio su richiesta → richiesta, non blocca l'agenda
  perform pg_temp.expect_error($q$select * from book_appointment((select tc from t3), null, pg_temp.at((select d21 from t3), '09:00'), 'ZZ', 'Colore', '3401000005', 'c@example.invalid', null, true)$q$, 'REQUIRES_APPROVAL');
  select * into r from create_booking_request((select tc from t3), 'ZZ Rosa', 'Colore', '3401000005', 'rosa@example.invalid',
    (select d21 from t3), 'mattina', null, null, true, false, k);
  perform pg_temp.check(r.status = 'pending' and r.services_label = 'ZZ3 Taglio donna + ZZ3 Colore', 'richiesta multi-servizio');
  perform pg_temp.check((select count(*) from booking_request_items where booking_request_id = r.request_id) = 2, 'servizi della richiesta salvati');
  perform pg_temp.check((select request_id from create_booking_request((select tc from t3), 'ZZ Rosa', 'Colore', '3401000005', 'rosa@example.invalid',
    (select d21 from t3), 'mattina', null, null, true, false, k)) = r.request_id, 'richiesta ripetuta: nessun duplicato');
  perform pg_temp.expect_error($q$select * from create_booking_request((select tp from t3), 'ZZ', 'Auto', '3401000006', 'a@example.invalid', null, 'mattina', null, null, true)$q$, 'USE_AUTOMATIC_BOOKING');
  select count(*) into n from get_bundle_slots((select tp from t3), (select d21 from t3));
  perform pg_temp.check(n = 8, 'la richiesta in attesa non blocca slot');

  -- 7. Ora legale → solare (31/10/2027): 09:00 Roma = 08:00 UTC, stesso numero di slot
  perform pg_temp.check((select min(starts_at) from get_bundle_slots((select tp from t3), date '2027-10-31', null, false)) = timestamptz '2027-10-31 08:00:00+00'
                        and (select count(*) from get_bundle_slots((select tp from t3), date '2027-10-31', null, false)) = 8, 'cambio ora solare');
  perform pg_temp.check((select min(starts_at) from get_bundle_slots((select tp from t3), date '2027-03-28', null, false)) = timestamptz '2027-03-28 07:00:00+00', 'cambio ora legale');

  -- 8. Spostamento cliente che si sovrappone a sé stesso (di 15')
  perform issue_manage_token(a1, encode(sha256('zz3-tok'::bytea), 'hex'));
  perform pg_temp.check((customer_get_appointment(encode(sha256('zz3-tok'::bytea), 'hex')) ->> 'duration_minutes')::int = 75, 'pagina cliente: durata totale');
end $$;

-- spostamento cliente di 15' sovrapposto a sé stesso: ammesso? (9:00-10:15 → 9:15-10:30 collide con 10:30? no: fine 10:30 = inizio taglio uomo)
do $$
begin
  perform customer_reschedule_appointment(encode(sha256('zz3-tok'::bytea), 'hex'), pg_temp.at((select d20 from t3), '09:15'));
  perform pg_temp.check((select starts_at from appointments where idempotency_key is not null and customer_id = (select id from customers where email_normalized = 'viola@example.invalid'))
                        = pg_temp.at((select d20 from t3), '09:15'), 'spostamento cliente sovrapposto al proprio orario consentito');
end $$;

-- ---------- ADMIN staff: modifica combinati, assegnazione, suggerimenti ----------
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a2"}', true) \g /dev/null
do $$
declare a uuid; res jsonb; sug jsonb; n int;
begin
  res := admin_create_appointment(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b1',
    pg_temp.at((select d22 from t3), '09:00'), 'ZZ Ugo', 'Admin', '3401000007', null, null, false, false);
  a := (res ->> 'appointment_id')::uuid;
  -- aggiunge la piega: A non è abilitato → errore; con C sì
  perform pg_temp.expect_error(format($q$select admin_update_appointment(%L, (select tp from t3), 'bbbbbbbb-0000-4000-8000-0000000000b1', pg_temp.at((select d22 from t3), '09:00'))$q$, a), 'STAFF_NOT_ENABLED');
  res := admin_update_appointment(a, (select tp from t3), 'bbbbbbbb-0000-4000-8000-0000000000b3', pg_temp.at((select d22 from t3), '09:00'));
  perform pg_temp.check((select ends_at from appointments where id = a) = pg_temp.at((select d22 from t3), '10:15') and (select count(*) from appointment_items where appointment_id = a) = 2,
    'modifica servizi: durata e servizi aggiornati');
  -- un secondo appuntamento di C alle 10:30; allungare il primo fino a sovrapporsi deve fallire
  perform admin_create_appointment(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b3',
    pg_temp.at((select d22 from t3), '10:30'), 'ZZ Ivo', 'Admin', '3401000008', null, null, false, false);
  perform pg_temp.expect_error(format($q$select admin_update_appointment(%L, (select tp from t3), 'bbbbbbbb-0000-4000-8000-0000000000b3', pg_temp.at((select d22 from t3), '09:30'))$q$, a), 'SLOT_UNAVAILABLE');
  perform pg_temp.expect_error(format($q$select admin_move_appointment(%L, 'bbbbbbbb-0000-4000-8000-0000000000b1', pg_temp.at((select d22 from t3), '11:00'))$q$, a), 'STAFF_NOT_ENABLED');
  -- idempotenza inserimento manuale
  res := admin_create_appointment(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b1',
    pg_temp.at((select d22 from t3), '11:00'), 'ZZ Ada', 'Doppio', '3401000009', null, null, false, false, 'aaaaaaaa-1111-4111-8111-111111111111');
  perform pg_temp.check((admin_create_appointment(array['cccccccc-0000-4000-8000-0000000000d4']::uuid[], 'bbbbbbbb-0000-4000-8000-0000000000b1',
    pg_temp.at((select d22 from t3), '11:00'), 'ZZ Ada', 'Doppio', '3401000009', null, null, false, false, 'aaaaaaaa-1111-4111-8111-111111111111') ->> 'replayed')::boolean,
    'doppio clic su inserimento manuale: nessun duplicato');
  -- suggerimenti: C libero 10:15-10:30 (15') e 11:00-12:00 (60'); le richieste compatibili compaiono
  sug := admin_gap_suggestions((select d22 from t3));
  select count(*) into n from jsonb_array_elements(sug) g where g ->> 'staff_id' = 'bbbbbbbb-0000-4000-8000-0000000000b3' and (g ->> 'minutes')::int = 60;
  perform pg_temp.check(n = 1, 'spazio libero da 60'' individuato');
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(sug) g, jsonb_array_elements(g -> 'services') x
                                 where (g ->> 'minutes')::int = 60 and x ->> 'name' in ('ZZ3 Taglio uomo', 'ZZ3 Taglio donna', 'ZZ3 Piega')), 'servizi suggeriti per lo spazio');
  perform pg_temp.expect_error($q$insert into opening_hours (weekday, start_time, end_time) values (1, '09:00', '18:00')$q$, '42501');
end $$;

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true) \g /dev/null
select pg_temp.expect_error($q$select * from public.bundle_info(array[gen_random_uuid()])$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select * from public.get_bundle_slots(array[gen_random_uuid()], current_date)$q$, '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.appointment_items limit 1', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.opening_hours limit 1', '42501') \g /dev/null
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a3"}', true) \g /dev/null
select pg_temp.expect_error($q$select public.admin_update_appointment(gen_random_uuid(), array[gen_random_uuid()], gen_random_uuid(), now())$q$, 'FORBIDDEN') \g /dev/null
select pg_temp.expect_error($q$select public.admin_gap_suggestions(current_date)$q$, 'FORBIDDEN') \g /dev/null
select pg_temp.expect_error($q$select * from public.get_bundle_slots(array[gen_random_uuid()], current_date)$q$, 'FORBIDDEN') \g /dev/null
select pg_temp.check((select count(*) from appointment_items) = 0, 'non admin non vede i servizi degli appuntamenti') \g /dev/null

-- =====================================================================
-- Maylana AI (v0.4): limiti atomici, sessioni, consumi, permessi
-- =====================================================================
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
do $$
declare r record; v_sid uuid; v_cnt int;
begin
  update ai_settings set enabled = false;
  select * into r from ai_begin_turn(null, repeat('1', 64), true);
  perform pg_temp.check(not r.ok and r.reason = 'DISABLED', 'AI disattivata: turno rifiutato');
  update ai_settings set enabled = true, session_message_limit = 2, daily_request_limit = 1000,
         input_price_per_mtok_usd = 1, output_price_per_mtok_usd = 2;
  select * into r from ai_begin_turn(null, repeat('1', 64), true);
  perform pg_temp.check(r.ok and r.session_created, 'nuova sessione creata');
  v_sid := r.session_id;
  select * into r from ai_begin_turn(repeat('1', 64), repeat('2', 64), false);
  perform pg_temp.check(r.ok and not r.session_created and r.session_id = v_sid, 'sessione riutilizzata con lo stesso token');
  select * into r from ai_begin_turn(repeat('1', 64), repeat('3', 64), false);
  perform pg_temp.check(not r.ok and r.reason = 'SESSION_LIMIT', 'limite messaggi per sessione');
  perform pg_temp.expect_error($q$select * from ai_begin_turn(null, 'non-esadecimale', true)$q$, 'INVALID_SESSION');
  perform ai_record_usage(v_sid, 1000000, 500000, 2, false);
  perform pg_temp.check((select est_cost_usd from ai_usage_daily where day = (now() at time zone 'Europe/Rome')::date) >= 2.0, 'costo stimato calcolato dai prezzi');
  update ai_settings set daily_cost_limit_usd = 1, session_message_limit = 50;
  select * into r from ai_begin_turn(null, repeat('4', 64), true);
  perform pg_temp.check(not r.ok and r.reason = 'DAILY_LIMIT', 'limite di costo giornaliero');
  select * into r from ai_begin_turn(repeat('4', 64), repeat('5', 64), false);
  perform pg_temp.check(r.ok, 'risposte locali consentite anche oltre il limite di costo');
  update ai_sessions set expires_at = now() - interval '2 days';
  v_cnt := ai_purge();
  perform pg_temp.check(v_cnt >= 2 and not exists (select 1 from ai_sessions), 'sessioni scadute eliminate');
  perform pg_temp.check(not exists (select 1 from information_schema.columns where table_name in ('ai_sessions', 'ai_usage_daily')
                          and column_name ~ '(text|message|content|prompt|phone|email|ip)'), 'nessuna colonna per testi o dati personali');
end $$;

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true) \g /dev/null
select pg_temp.expect_error('select 1 from public.ai_settings', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.ai_faq', '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.ai_sessions', '42501') \g /dev/null
select pg_temp.expect_error('select public.ai_public_context()', '42501') \g /dev/null
select pg_temp.expect_error($q$select * from public.ai_begin_turn(null, repeat('9', 64), true)$q$, '42501') \g /dev/null
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a3"}', true) \g /dev/null
select pg_temp.check((select count(*) from ai_settings) = 0 and (select count(*) from ai_usage_daily) = 0, 'non admin non vede impostazioni e consumi AI') \g /dev/null
select pg_temp.expect_error('select 1 from public.ai_sessions', '42501') \g /dev/null
select pg_temp.expect_error($q$select * from public.ai_begin_turn(null, repeat('9', 64), true)$q$, '42501') \g /dev/null
select pg_temp.expect_error($q$select public.ai_record_usage(null, 1, 1, 1, false)$q$, '42501') \g /dev/null
-- staff: legge, non modifica
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a2"}', true) \g /dev/null
select pg_temp.check((select count(*) from ai_settings) = 1, 'staff legge le impostazioni AI') \g /dev/null
update ai_settings set enabled = false;
select pg_temp.check((select enabled from ai_settings) = true, 'staff non può modificare le impostazioni AI') \g /dev/null
select pg_temp.expect_error($q$insert into ai_faq (question, answer) values ('Domanda?', 'Risposta')$q$, '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.ai_sessions', '42501') \g /dev/null
-- titolare: modifica impostazioni e FAQ, mai le sessioni né i consumi
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-0000000000a1"}', true) \g /dev/null
update ai_settings set welcome_message = 'Benvenuta! Sono Maylana AI, assistente virtuale.';
select pg_temp.check((select welcome_message from ai_settings) like 'Benvenuta! Sono%', 'titolare modifica il messaggio iniziale') \g /dev/null
insert into ai_faq (topic, question, answer, keywords) values ('generale', 'Domanda di prova?', 'Risposta di prova', array['prova']);
select pg_temp.check((select count(*) from ai_faq) = 1, 'titolare inserisce una FAQ') \g /dev/null
select pg_temp.expect_error($q$update ai_usage_daily set est_cost_usd = 0$q$, '42501') \g /dev/null
select pg_temp.expect_error('select 1 from public.ai_sessions', '42501') \g /dev/null
select pg_temp.expect_error($q$update ai_settings set welcome_message = 'x'$q$, '23514') \g /dev/null
reset role;

\echo '✅ TUTTI I TEST DATABASE SUPERATI (rollback: nessun dato salvato)'
rollback;
