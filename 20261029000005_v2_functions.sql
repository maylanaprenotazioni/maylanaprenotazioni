-- =====================================================================
-- Maylana Booking v2 — Funzioni
-- Sostituisce le funzioni del primo rilascio che cambiano firma
-- (nome/cognome separati, notifiche) e aggiunge:
--   notifiche (coda, claim, completamento, promemoria)
--   link cliente (token), spostamenti, annullamenti, proposte
--   panoramica e clienti per la dashboard
-- =====================================================================

drop function if exists public.book_appointment(uuid, uuid, timestamptz, text, text, text, text, boolean);
drop function if exists public.create_booking_request(uuid, text, text, text, date, text, uuid, text, boolean);
drop function if exists public.admin_confirm_request(uuid, uuid, timestamptz, text, boolean);
drop function if exists public.admin_set_request_status(uuid, text, text);
drop function if exists public.admin_create_appointment(uuid, uuid, timestamptz, text, text, text, text, boolean);
drop function if exists public.upsert_customer(text, text, text);

-- ---------------------------------------------------------------------
-- Cliente: trova o crea evitando duplicati
--  1) stesso telefono + stessa email
--  2) stesso telefono, scheda esistente senza email → completa l'email
--  3) stesso telefono e nessuna email fornita → scheda più recente
--  4) altrimenti nuova scheda
-- I dati anagrafici esistenti non vengono sovrascritti da input pubblici.
-- ---------------------------------------------------------------------
create or replace function public.upsert_customer(p_first_name text, p_last_name text, p_phone text, p_email text)
returns uuid
language plpgsql
volatile
set search_path = public
as $$
declare
  v_id uuid;
  v_first text := btrim(regexp_replace(coalesce(p_first_name, ''), '\s+', ' ', 'g'));
  v_last text := btrim(regexp_replace(coalesce(p_last_name, ''), '\s+', ' ', 'g'));
  v_phone_raw text := btrim(coalesce(p_phone, ''));
  v_phone text := regexp_replace(v_phone_raw, '[^0-9+]', '', 'g');
  v_email_raw text := btrim(coalesce(p_email, ''));
  v_email text := lower(v_email_raw);
begin
  perform public.assert_backend_or_admin();

  if length(v_first) < 1 or length(v_first) > 60 or length(v_last) > 60 or length(v_first || v_last) < 2 then
    raise exception using message = 'INVALID_NAME', errcode = 'P0001';
  end if;
  if v_phone !~ '^\+?[0-9]{6,20}$' then
    raise exception using message = 'INVALID_PHONE', errcode = 'P0001';
  end if;
  if v_email <> '' and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 200) then
    raise exception using message = 'INVALID_EMAIL', errcode = 'P0001';
  end if;

  select id into v_id from public.customers where phone_normalized = v_phone and email_normalized = v_email;

  if v_id is null and v_email <> '' then
    select id into v_id from public.customers
     where phone_normalized = v_phone and email_normalized = ''
     order by created_at limit 1
     for update;
    if v_id is not null then
      update public.customers set email = v_email_raw, email_normalized = v_email where id = v_id;
    end if;
  elsif v_id is null then
    select id into v_id from public.customers
     where phone_normalized = v_phone
     order by updated_at desc limit 1;
  end if;

  if v_id is null then
    insert into public.customers (first_name, last_name, full_name, phone, phone_normalized, email, email_normalized)
    values (v_first, v_last, btrim(v_first || ' ' || v_last), v_phone_raw, v_phone, nullif(v_email_raw, ''), v_email)
    on conflict (phone_normalized, email_normalized) do update set updated_at = now()
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Notifiche: accodamento idempotente
-- ---------------------------------------------------------------------
create or replace function public.enqueue_notification(
  p_kind text,
  p_audience text,
  p_appointment_id uuid,
  p_request_id uuid,
  p_dedupe_key text,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  insert into public.notifications (kind, audience, appointment_id, booking_request_id, dedupe_key, data)
  values (p_kind, p_audience, p_appointment_id, p_request_id, p_dedupe_key, coalesce(p_data, '{}'::jsonb))
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.notifications where dedupe_key = p_dedupe_key;
  end if;
  return v_id;
end;
$$;

create or replace function public.revoke_appointment_tokens(p_appointment_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.appointment_tokens
     set revoked_at = now()
   where appointment_id = p_appointment_id and revoked_at is null and used_at is null;
$$;

-- ---------------------------------------------------------------------
-- PRENOTAZIONE AUTOMATICA ATOMICA (backend pubblico)
-- ---------------------------------------------------------------------
create or replace function public.book_appointment(
  p_service_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_notes text,
  p_privacy_accepted boolean
)
returns table (
  appointment_id uuid, code text, starts_at timestamptz, ends_at timestamptz,
  staff_name text, service_name text, notification_id uuid
)
language plpgsql
volatile
set search_path = public
as $$
#variable_conflict use_column
declare
  v_service public.services%rowtype;
  v_local_date date := (p_starts_at at time zone public.app_tz())::date;
  v_customer uuid;
  v_candidate record;
  v_appt public.appointments%rowtype;
  v_notif uuid;
begin
  perform public.assert_backend_or_admin();
  perform set_config('app.actor', 'customer', true);

  if not coalesce(p_privacy_accepted, false) then
    raise exception using message = 'PRIVACY_REQUIRED', errcode = 'P0001';
  end if;
  if not (select online_booking_enabled from public.business_settings where id = 1) then
    raise exception using message = 'BOOKING_DISABLED', errcode = 'P0001';
  end if;

  select * into v_service from public.services
   where id = p_service_id and active and category = 'hair' and booking_mode = 'automatic';
  if not found then
    raise exception using message = 'SERVICE_NOT_BOOKABLE', errcode = 'P0001';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception using message = 'INVALID_NOTES', errcode = 'P0001';
  end if;
  if btrim(coalesce(p_email, '')) = '' then
    raise exception using message = 'INVALID_EMAIL', errcode = 'P0001';
  end if;
  if btrim(coalesce(p_last_name, '')) = '' then
    raise exception using message = 'INVALID_NAME', errcode = 'P0001';
  end if;

  v_customer := public.upsert_customer(p_first_name, p_last_name, p_phone, p_email);

  for v_candidate in
    select s.staff_id, s.staff_name, s.starts_at, s.ends_at
    from public.get_available_slots(p_service_id, v_local_date, p_staff_id, true) s
    where s.starts_at = p_starts_at
  loop
    begin
      insert into public.appointments (
        service_id, staff_id, customer_id, starts_at, ends_at, status, source, customer_notes, privacy_accepted_at
      )
      values (
        p_service_id, v_candidate.staff_id, v_customer, v_candidate.starts_at, v_candidate.ends_at,
        'confirmed', 'online', nullif(btrim(coalesce(p_notes, '')), ''), now()
      )
      returning * into v_appt;

      v_notif := public.enqueue_notification('booking_confirmed', 'customer', v_appt.id, null,
        'booking_confirmed:' || v_appt.id, jsonb_build_object('starts_at', v_appt.starts_at));

      return query select v_appt.id, v_appt.code, v_appt.starts_at, v_appt.ends_at,
                          v_candidate.staff_name, v_service.name, v_notif;
      return;
    exception
      when exclusion_violation then null; -- slot preso in concorrenza: prossimo operatore
    end;
  end loop;

  raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------
-- RICHIESTA CON APPROVAZIONE (backend pubblico)
-- ---------------------------------------------------------------------
create or replace function public.create_booking_request(
  p_service_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_preferred_date date,
  p_preferred_time_window text,
  p_preferred_staff_id uuid,
  p_notes text,
  p_privacy_accepted boolean
)
returns table (request_id uuid, code text, status text, notification_id uuid)
language plpgsql
volatile
set search_path = public
as $$
#variable_conflict use_column
declare
  v_service public.services%rowtype;
  v_customer uuid;
  v_cfg public.business_settings%rowtype;
  v_today date := (now() at time zone public.app_tz())::date;
  v_req public.booking_requests%rowtype;
  v_notif uuid;
begin
  perform public.assert_backend_or_admin();
  perform set_config('app.actor', 'customer', true);

  if not coalesce(p_privacy_accepted, false) then
    raise exception using message = 'PRIVACY_REQUIRED', errcode = 'P0001';
  end if;
  select * into v_cfg from public.business_settings where id = 1;
  if not v_cfg.online_booking_enabled then
    raise exception using message = 'BOOKING_DISABLED', errcode = 'P0001';
  end if;
  select * into v_service from public.services where id = p_service_id and active and booking_mode = 'manual';
  if not found then
    raise exception using message = 'SERVICE_NOT_BOOKABLE', errcode = 'P0001';
  end if;
  if p_preferred_date is not null
     and (p_preferred_date < v_today or p_preferred_date > v_today + v_cfg.booking_horizon_days) then
    raise exception using message = 'INVALID_DATE', errcode = 'P0001';
  end if;
  if coalesce(p_preferred_time_window, 'indifferente') not in ('mattina', 'pomeriggio', 'indifferente') then
    raise exception using message = 'INVALID_TIME_WINDOW', errcode = 'P0001';
  end if;
  if p_preferred_staff_id is not null
     and not exists (select 1 from public.staff where id = p_preferred_staff_id and active) then
    raise exception using message = 'INVALID_STAFF', errcode = 'P0001';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception using message = 'INVALID_NOTES', errcode = 'P0001';
  end if;
  if btrim(coalesce(p_email, '')) = '' then
    raise exception using message = 'INVALID_EMAIL', errcode = 'P0001';
  end if;
  if btrim(coalesce(p_last_name, '')) = '' then
    raise exception using message = 'INVALID_NAME', errcode = 'P0001';
  end if;

  v_customer := public.upsert_customer(p_first_name, p_last_name, p_phone, p_email);

  if (select count(*) from public.booking_requests r where r.customer_id = v_customer and r.status = 'pending') >= 3 then
    raise exception using message = 'TOO_MANY_PENDING', errcode = 'P0001';
  end if;

  insert into public.booking_requests (
    service_id, customer_id, preferred_staff_id, preferred_date, preferred_time_window, customer_notes, privacy_accepted_at
  )
  values (
    p_service_id, v_customer, p_preferred_staff_id, p_preferred_date,
    coalesce(p_preferred_time_window, 'indifferente'), nullif(btrim(coalesce(p_notes, '')), ''), now()
  )
  returning * into v_req;

  v_notif := public.enqueue_notification('request_received', 'customer', null, v_req.id, 'request_received:' || v_req.id);

  return query select v_req.id, v_req.code, v_req.status, v_notif;
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: approva richiesta (slot verificato + registrazione atomica)
-- Se la richiesta è uno spostamento chiesto dal cliente, sposta
-- l'appuntamento originale invece di crearne uno nuovo.
-- ---------------------------------------------------------------------
create or replace function public.admin_confirm_request(
  p_request_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_internal_notes text default null,
  p_allow_outside_hours boolean default false
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_req public.booking_requests%rowtype;
  v_orig public.appointments%rowtype;
  v_duration int;
  v_ends timestamptz;
  v_problem text;
  v_appt_id uuid;
  v_notif uuid;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;

  -- Il lock impedisce approvazioni doppie concorrenti della stessa richiesta.
  select * into v_req from public.booking_requests where id = p_request_id for update;
  if not found then
    raise exception using message = 'REQUEST_NOT_FOUND', errcode = 'P0001';
  end if;
  if v_req.status not in ('pending', 'reschedule') then
    raise exception using message = 'REQUEST_NOT_CONFIRMABLE', errcode = 'P0001';
  end if;

  if v_req.reschedule_of_appointment_id is not null then
    select * into v_orig from public.appointments where id = v_req.reschedule_of_appointment_id for update;
    if not found or v_orig.status <> 'confirmed' then
      raise exception using message = 'APPOINTMENT_NOT_ACTIVE', errcode = 'P0001';
    end if;
    v_ends := p_starts_at + (v_orig.ends_at - v_orig.starts_at);
    v_problem := public.slot_problem(p_staff_id, p_starts_at, v_ends, not coalesce(p_allow_outside_hours, false), v_orig.id);
    if v_problem is not null then
      raise exception using message = v_problem, errcode = 'P0001';
    end if;
    begin
      update public.appointments
         set staff_id = p_staff_id, starts_at = p_starts_at, ends_at = v_ends, rescheduled_at = now(),
             internal_notes = coalesce(nullif(btrim(coalesce(p_internal_notes, '')), ''), internal_notes)
       where id = v_orig.id;
    exception when exclusion_violation then
      raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
    end;
    perform public.revoke_appointment_tokens(v_orig.id);
    v_appt_id := v_orig.id;
    v_notif := public.enqueue_notification('appointment_rescheduled', 'customer', v_orig.id, v_req.id,
      'appointment_rescheduled:' || v_orig.id || ':' || extract(epoch from p_starts_at)::bigint,
      jsonb_build_object('starts_at', p_starts_at, 'previous_starts_at', v_orig.starts_at));
  else
    select duration_minutes into v_duration from public.services where id = v_req.service_id;
    if v_duration is null then
      raise exception using message = 'SERVICE_DURATION_MISSING', errcode = 'P0001';
    end if;
    v_ends := p_starts_at + make_interval(mins => v_duration);
    v_problem := public.slot_problem(p_staff_id, p_starts_at, v_ends, not coalesce(p_allow_outside_hours, false));
    if v_problem is not null then
      raise exception using message = v_problem, errcode = 'P0001';
    end if;

    update public.appointments set status = 'cancelled', cancelled_at = now()
     where booking_request_id = v_req.id and status <> 'cancelled';
    update public.appointments set booking_request_id = null where booking_request_id = v_req.id;

    begin
      insert into public.appointments (
        service_id, staff_id, customer_id, booking_request_id, starts_at, ends_at, status, source,
        customer_notes, internal_notes, privacy_accepted_at, created_by
      )
      values (
        v_req.service_id, p_staff_id, v_req.customer_id, v_req.id, p_starts_at, v_ends, 'confirmed', 'request',
        v_req.customer_notes, nullif(btrim(coalesce(p_internal_notes, '')), ''), v_req.privacy_accepted_at, auth.uid()
      )
      returning id into v_appt_id;
    exception when exclusion_violation then
      raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
    end;
    v_notif := public.enqueue_notification('request_approved', 'customer', v_appt_id, v_req.id,
      'request_approved:' || v_req.id || ':' || v_appt_id, jsonb_build_object('starts_at', p_starts_at));
  end if;

  update public.booking_requests
     set status = 'confirmed', handled_by = auth.uid(), handled_at = now(),
         proposed_starts_at = null, proposed_staff_id = null
   where id = v_req.id;

  return jsonb_build_object('appointment_id', v_appt_id, 'notification_ids', jsonb_build_array(v_notif));
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: stato richiesta (rifiuta / da riprogrammare / annulla / riapri)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_request_status(
  p_request_id uuid,
  p_status text,
  p_admin_notes text default null,
  p_notify boolean default true
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_req public.booking_requests%rowtype;
  v_appt record;
  v_ids jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  if p_status not in ('pending', 'rejected', 'reschedule', 'cancelled') then
    raise exception using message = 'INVALID_STATUS', errcode = 'P0001';
  end if;

  select * into v_req from public.booking_requests where id = p_request_id for update;
  if not found then
    raise exception using message = 'REQUEST_NOT_FOUND', errcode = 'P0001';
  end if;
  if v_req.status = p_status then
    return jsonb_build_object('notification_ids', v_ids);
  end if;

  update public.booking_requests
     set status = p_status,
         admin_notes = coalesce(nullif(btrim(coalesce(p_admin_notes, '')), ''), admin_notes),
         handled_by = auth.uid(), handled_at = now()
   where id = p_request_id;

  -- Appuntamento nato da questa richiesta: liberato se non più valido
  if p_status in ('rejected', 'reschedule', 'cancelled') then
    for v_appt in
      update public.appointments set status = 'cancelled', cancelled_at = now()
       where booking_request_id = p_request_id and status = 'confirmed'
      returning id
    loop
      perform public.revoke_appointment_tokens(v_appt.id);
      if p_notify then
        v_ids := v_ids || to_jsonb(public.enqueue_notification('appointment_cancelled', 'customer', v_appt.id, p_request_id,
          'appointment_cancelled:' || v_appt.id));
      end if;
    end loop;
  end if;

  if p_status = 'rejected' and p_notify then
    v_ids := v_ids || to_jsonb(public.enqueue_notification('request_rejected', 'customer', v_req.reschedule_of_appointment_id, p_request_id,
      'request_rejected:' || p_request_id || ':' || extract(epoch from now())::bigint,
      jsonb_build_object('is_reschedule', v_req.reschedule_of_appointment_id is not null)));
  end if;

  return jsonb_build_object('notification_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: proponi nuova data per una richiesta (non blocca lo slot)
-- ---------------------------------------------------------------------
create or replace function public.admin_propose_request_time(
  p_request_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_admin_notes text default null
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_req public.booking_requests%rowtype;
  v_duration int;
  v_problem text;
  v_notif uuid;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  select * into v_req from public.booking_requests where id = p_request_id for update;
  if not found then
    raise exception using message = 'REQUEST_NOT_FOUND', errcode = 'P0001';
  end if;
  if v_req.status not in ('pending', 'reschedule') then
    raise exception using message = 'REQUEST_NOT_CONFIRMABLE', errcode = 'P0001';
  end if;
  if p_starts_at <= now() then
    raise exception using message = 'INVALID_DATE', errcode = 'P0001';
  end if;
  select duration_minutes into v_duration from public.services where id = v_req.service_id;
  if v_duration is null then
    raise exception using message = 'SERVICE_DURATION_MISSING', errcode = 'P0001';
  end if;
  v_problem := public.slot_problem(p_staff_id, p_starts_at, p_starts_at + make_interval(mins => v_duration), true,
                                   v_req.reschedule_of_appointment_id);
  if v_problem is not null then
    raise exception using message = v_problem, errcode = 'P0001';
  end if;

  update public.booking_requests
     set status = 'reschedule', proposed_starts_at = p_starts_at, proposed_staff_id = p_staff_id,
         admin_notes = coalesce(nullif(btrim(coalesce(p_admin_notes, '')), ''), admin_notes),
         handled_by = auth.uid(), handled_at = now()
   where id = p_request_id;

  v_notif := public.enqueue_notification('request_proposal', 'customer', null, p_request_id,
    'request_proposal:' || p_request_id || ':' || extract(epoch from p_starts_at)::bigint,
    jsonb_build_object('proposed_starts_at', p_starts_at));

  return jsonb_build_object('notification_ids', jsonb_build_array(v_notif));
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: inserimento manuale
-- ---------------------------------------------------------------------
create or replace function public.admin_create_appointment(
  p_service_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text default null,
  p_internal_notes text default null,
  p_allow_outside_hours boolean default false,
  p_notify boolean default true
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_duration int;
  v_ends timestamptz;
  v_problem text;
  v_customer uuid;
  v_id uuid;
  v_ids jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  select duration_minutes into v_duration from public.services where id = p_service_id;
  if v_duration is null then
    raise exception using message = 'SERVICE_DURATION_MISSING', errcode = 'P0001';
  end if;
  v_ends := p_starts_at + make_interval(mins => v_duration);
  v_problem := public.slot_problem(p_staff_id, p_starts_at, v_ends, not coalesce(p_allow_outside_hours, false));
  if v_problem is not null then
    raise exception using message = v_problem, errcode = 'P0001';
  end if;

  v_customer := public.upsert_customer(p_first_name, p_last_name, p_phone, p_email);

  begin
    insert into public.appointments (service_id, staff_id, customer_id, starts_at, ends_at, status, source, internal_notes, created_by)
    values (p_service_id, p_staff_id, v_customer, p_starts_at, v_ends, 'confirmed', 'admin',
            nullif(btrim(coalesce(p_internal_notes, '')), ''), auth.uid())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
  end;

  if p_notify then
    v_ids := jsonb_build_array(public.enqueue_notification('booking_confirmed', 'customer', v_id, null,
      'booking_confirmed:' || v_id, jsonb_build_object('starts_at', p_starts_at)));
  end if;
  return jsonb_build_object('appointment_id', v_id, 'notification_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: sposta appuntamento (atomico, stesso vincolo anti-sovrapposizione)
-- ---------------------------------------------------------------------
create or replace function public.admin_move_appointment(
  p_appointment_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_allow_outside_hours boolean default false,
  p_notify boolean default true
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_a public.appointments%rowtype;
  v_ends timestamptz;
  v_problem text;
  v_ids jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  select * into v_a from public.appointments where id = p_appointment_id for update;
  if not found or v_a.status <> 'confirmed' then
    raise exception using message = 'APPOINTMENT_NOT_ACTIVE', errcode = 'P0001';
  end if;
  if v_a.starts_at = p_starts_at and v_a.staff_id = p_staff_id then
    return jsonb_build_object('appointment_id', v_a.id, 'notification_ids', v_ids);
  end if;
  v_ends := p_starts_at + (v_a.ends_at - v_a.starts_at);
  v_problem := public.slot_problem(p_staff_id, p_starts_at, v_ends, not coalesce(p_allow_outside_hours, false), v_a.id);
  if v_problem is not null then
    raise exception using message = v_problem, errcode = 'P0001';
  end if;
  begin
    update public.appointments
       set staff_id = p_staff_id, starts_at = p_starts_at, ends_at = v_ends, rescheduled_at = now()
     where id = v_a.id;
  exception when exclusion_violation then
    raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
  end;
  perform public.revoke_appointment_tokens(v_a.id);
  if p_notify and v_a.starts_at <> p_starts_at then
    v_ids := jsonb_build_array(public.enqueue_notification('appointment_rescheduled', 'customer', v_a.id, null,
      'appointment_rescheduled:' || v_a.id || ':' || extract(epoch from p_starts_at)::bigint,
      jsonb_build_object('starts_at', p_starts_at, 'previous_starts_at', v_a.starts_at)));
  end if;
  return jsonb_build_object('appointment_id', v_a.id, 'notification_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: annulla appuntamento
-- ---------------------------------------------------------------------
create or replace function public.admin_cancel_appointment(
  p_appointment_id uuid,
  p_reason text default null,
  p_notify boolean default true
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_a public.appointments%rowtype;
  v_ids jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  select * into v_a from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception using message = 'APPOINTMENT_NOT_ACTIVE', errcode = 'P0001';
  end if;
  if v_a.status = 'cancelled' then
    return jsonb_build_object('notification_ids', v_ids);
  end if;
  update public.appointments
     set status = 'cancelled', cancelled_at = now(),
         internal_notes = case when nullif(btrim(coalesce(p_reason, '')), '') is null then internal_notes
                               else concat_ws(E'\n', internal_notes, 'Annullato: ' || btrim(p_reason)) end
   where id = v_a.id;
  perform public.revoke_appointment_tokens(v_a.id);
  update public.booking_requests set status = 'cancelled', handled_by = auth.uid(), handled_at = now()
   where id = v_a.booking_request_id and status = 'confirmed';
  if p_notify and v_a.starts_at > now() then
    v_ids := jsonb_build_array(public.enqueue_notification('appointment_cancelled', 'customer', v_a.id, null,
      'appointment_cancelled:' || v_a.id));
  end if;
  return jsonb_build_object('notification_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------------
-- LINK CLIENTE (token). Tutte le funzioni ricevono solo l'hash.
-- ---------------------------------------------------------------------
create or replace function public.issue_manage_token(p_appointment_id uuid, p_token_hash text)
returns uuid
language plpgsql
volatile
set search_path = public
as $$
declare v_id uuid; v_start timestamptz;
begin
  perform public.assert_backend_or_admin();
  select starts_at into v_start from public.appointments
   where id = p_appointment_id and status = 'confirmed' and starts_at > now();
  if v_start is null then
    raise exception using message = 'APPOINTMENT_NOT_ACTIVE', errcode = 'P0001';
  end if;
  insert into public.appointment_tokens (appointment_id, token_hash, expires_at)
  values (p_appointment_id, p_token_hash, v_start)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.revoke_token(p_token_id uuid)
returns void
language sql
volatile
set search_path = public
as $$
  update public.appointment_tokens set revoked_at = now() where id = p_token_id and revoked_at is null;
$$;

-- Risolve un token valido e blocca l'appuntamento (uso interno)
create or replace function public.resolve_manage_token(p_token_hash text, p_lock boolean default false)
returns public.appointments
language plpgsql
volatile
set search_path = public
as $$
declare v_tok public.appointment_tokens%rowtype; v_a public.appointments%rowtype;
begin
  perform public.assert_backend_or_admin();
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'INVALID_TOKEN', errcode = 'P0001';
  end if;
  select * into v_tok from public.appointment_tokens where token_hash = p_token_hash;
  if not found or v_tok.revoked_at is not null or v_tok.used_at is not null or v_tok.expires_at <= now() then
    raise exception using message = 'INVALID_TOKEN', errcode = 'P0001';
  end if;
  if p_lock then
    select * into v_a from public.appointments where id = v_tok.appointment_id for update;
  else
    select * into v_a from public.appointments where id = v_tok.appointment_id;
  end if;
  if v_a.status <> 'confirmed' then
    raise exception using message = 'INVALID_TOKEN', errcode = 'P0001';
  end if;
  return v_a;
end;
$$;

create or replace function public.customer_get_appointment(p_token_hash text)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_a public.appointments%rowtype;
  v_cfg public.business_settings%rowtype;
  v_svc public.services%rowtype;
  v_deadline timestamptz;
begin
  v_a := public.resolve_manage_token(p_token_hash, false);
  select * into v_cfg from public.business_settings where id = 1;
  select * into v_svc from public.services where id = v_a.service_id;
  v_deadline := v_a.starts_at - make_interval(hours => v_cfg.customer_change_min_hours);
  return jsonb_build_object(
    'code', v_a.code,
    'service_id', v_a.service_id,
    'service_name', v_svc.name,
    'category', v_svc.category,
    'self_reschedule', v_svc.category = 'hair' and v_svc.booking_mode = 'automatic' and v_svc.active,
    'starts_at', v_a.starts_at,
    'ends_at', v_a.ends_at,
    'staff_name', (select display_name from public.staff where id = v_a.staff_id),
    'first_name', (select first_name from public.customers where id = v_a.customer_id),
    'can_change', now() <= v_deadline,
    'change_deadline', v_deadline,
    'pending_reschedule_request', exists (
      select 1 from public.booking_requests r
       where r.reschedule_of_appointment_id = v_a.id and r.status in ('pending', 'reschedule'))
  );
end;
$$;

create or replace function public.customer_cancel_appointment(p_token_hash text)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_a public.appointments%rowtype;
  v_min int;
  v_ids jsonb;
begin
  perform set_config('app.actor', 'customer', true);
  v_a := public.resolve_manage_token(p_token_hash, true);
  select customer_change_min_hours into v_min from public.business_settings where id = 1;
  if now() > v_a.starts_at - make_interval(hours => v_min) then
    raise exception using message = 'CHANGE_DEADLINE_PASSED', errcode = 'P0001';
  end if;

  update public.appointments set status = 'cancelled', cancelled_at = now() where id = v_a.id;
  update public.appointment_tokens set used_at = now() where token_hash = p_token_hash;
  perform public.revoke_appointment_tokens(v_a.id);
  update public.booking_requests set status = 'cancelled', handled_at = now()
   where (id = v_a.booking_request_id and status = 'confirmed')
      or (reschedule_of_appointment_id = v_a.id and status in ('pending', 'reschedule'));

  v_ids := jsonb_build_array(
    public.enqueue_notification('appointment_cancelled', 'customer', v_a.id, null, 'appointment_cancelled:' || v_a.id,
      jsonb_build_object('by', 'customer')),
    public.enqueue_notification('salon_customer_change', 'salon', v_a.id, null, 'salon_cancel:' || v_a.id,
      jsonb_build_object('action', 'cancel', 'previous_starts_at', v_a.starts_at))
  );
  return jsonb_build_object('notification_ids', v_ids);
end;
$$;

create or replace function public.customer_reschedule_appointment(p_token_hash text, p_new_starts_at timestamptz, p_staff_id uuid default null)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_a public.appointments%rowtype;
  v_cfg public.business_settings%rowtype;
  v_svc public.services%rowtype;
  v_candidate record;
  v_ids jsonb;
begin
  perform set_config('app.actor', 'customer', true);
  v_a := public.resolve_manage_token(p_token_hash, true);
  select * into v_cfg from public.business_settings where id = 1;
  select * into v_svc from public.services where id = v_a.service_id;

  if now() > v_a.starts_at - make_interval(hours => v_cfg.customer_change_min_hours) then
    raise exception using message = 'CHANGE_DEADLINE_PASSED', errcode = 'P0001';
  end if;
  if not (v_svc.active and v_svc.category = 'hair' and v_svc.booking_mode = 'automatic' and v_cfg.online_booking_enabled) then
    raise exception using message = 'SELF_RESCHEDULE_NOT_ALLOWED', errcode = 'P0001';
  end if;
  if p_new_starts_at = v_a.starts_at then
    raise exception using message = 'SAME_TIME', errcode = 'P0001';
  end if;

  for v_candidate in
    select s.staff_id, s.starts_at, s.ends_at
      from public.get_available_slots(v_a.service_id, (p_new_starts_at at time zone public.app_tz())::date, p_staff_id, true) s
     where s.starts_at = p_new_starts_at
     order by (s.staff_id = v_a.staff_id) desc
  loop
    begin
      update public.appointments
         set staff_id = v_candidate.staff_id, starts_at = v_candidate.starts_at, ends_at = v_candidate.ends_at,
             rescheduled_at = now()
       where id = v_a.id;
      update public.appointment_tokens set used_at = now() where token_hash = p_token_hash;
      perform public.revoke_appointment_tokens(v_a.id);
      v_ids := jsonb_build_array(
        public.enqueue_notification('appointment_rescheduled', 'customer', v_a.id, null,
          'appointment_rescheduled:' || v_a.id || ':' || extract(epoch from v_candidate.starts_at)::bigint,
          jsonb_build_object('starts_at', v_candidate.starts_at, 'previous_starts_at', v_a.starts_at, 'by', 'customer')),
        public.enqueue_notification('salon_customer_change', 'salon', v_a.id, null,
          'salon_reschedule:' || v_a.id || ':' || extract(epoch from v_candidate.starts_at)::bigint,
          jsonb_build_object('action', 'reschedule', 'previous_starts_at', v_a.starts_at, 'starts_at', v_candidate.starts_at))
      );
      return jsonb_build_object('starts_at', v_candidate.starts_at, 'notification_ids', v_ids);
    exception when exclusion_violation then
      null;
    end;
  end loop;
  raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
end;
$$;

-- Servizi su approvazione e consulenze: il cliente chiede lo spostamento,
-- l'appuntamento resta valido finché il salone non conferma il nuovo orario.
create or replace function public.customer_request_reschedule(
  p_token_hash text,
  p_preferred_date date,
  p_preferred_time_window text,
  p_notes text
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_a public.appointments%rowtype;
  v_cfg public.business_settings%rowtype;
  v_today date := (now() at time zone public.app_tz())::date;
  v_req_id uuid;
  v_code text;
  v_ids jsonb;
begin
  perform set_config('app.actor', 'customer', true);
  v_a := public.resolve_manage_token(p_token_hash, true);
  select * into v_cfg from public.business_settings where id = 1;
  if now() > v_a.starts_at - make_interval(hours => v_cfg.customer_change_min_hours) then
    raise exception using message = 'CHANGE_DEADLINE_PASSED', errcode = 'P0001';
  end if;
  if p_preferred_date is not null and (p_preferred_date < v_today or p_preferred_date > v_today + v_cfg.booking_horizon_days) then
    raise exception using message = 'INVALID_DATE', errcode = 'P0001';
  end if;
  if coalesce(p_preferred_time_window, 'indifferente') not in ('mattina', 'pomeriggio', 'indifferente') then
    raise exception using message = 'INVALID_TIME_WINDOW', errcode = 'P0001';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception using message = 'INVALID_NOTES', errcode = 'P0001';
  end if;

  begin
    insert into public.booking_requests (
      service_id, customer_id, preferred_staff_id, preferred_date, preferred_time_window, customer_notes,
      privacy_accepted_at, reschedule_of_appointment_id
    )
    values (
      v_a.service_id, v_a.customer_id, v_a.staff_id, p_preferred_date, coalesce(p_preferred_time_window, 'indifferente'),
      nullif(btrim(coalesce(p_notes, '')), ''), coalesce(v_a.privacy_accepted_at, now()), v_a.id
    )
    returning id, code into v_req_id, v_code;
  exception when unique_violation then
    raise exception using message = 'RESCHEDULE_ALREADY_REQUESTED', errcode = 'P0001';
  end;

  update public.appointment_tokens set used_at = now() where token_hash = p_token_hash;
  perform public.revoke_appointment_tokens(v_a.id);

  v_ids := jsonb_build_array(
    public.enqueue_notification('request_received', 'customer', v_a.id, v_req_id, 'request_received:' || v_req_id,
      jsonb_build_object('is_reschedule', true)),
    public.enqueue_notification('salon_customer_change', 'salon', v_a.id, v_req_id, 'salon_reschedule_request:' || v_req_id,
      jsonb_build_object('action', 'reschedule_request', 'previous_starts_at', v_a.starts_at))
  );
  return jsonb_build_object('request_code', v_code, 'notification_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------------
-- NOTIFICHE: elaborazione (solo backend)
-- ---------------------------------------------------------------------
create or replace function public.claim_notifications(p_limit int default 20, p_ids uuid[] default null)
returns setof public.notifications
language plpgsql
volatile
set search_path = public
as $$
begin
  perform public.assert_backend_or_admin();
  return query
  with c as (
    select id from public.notifications
     where ((status = 'pending' and next_attempt_at <= now())
         or (status = 'sending' and locked_at < now() - interval '15 minutes'))
       and (p_ids is null or id = any (p_ids))
     order by next_attempt_at
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  )
  update public.notifications n
     set status = 'sending', locked_at = now(), attempts = n.attempts + 1
    from c
   where n.id = c.id
  returning n.*;
end;
$$;

create or replace function public.complete_notification(
  p_id uuid,
  p_status text,
  p_error text default null,
  p_retry boolean default false,
  p_recipient text default null,
  p_provider text default null,
  p_provider_message_id text default null
)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare v_n public.notifications%rowtype; v_final text;
begin
  perform public.assert_backend_or_admin();
  select * into v_n from public.notifications where id = p_id for update;
  if not found or v_n.status <> 'sending' then
    return coalesce(v_n.status, 'missing');
  end if;
  if p_status not in ('sent', 'failed', 'skipped') then
    raise exception using message = 'INVALID_STATUS', errcode = 'P0001';
  end if;
  v_final := p_status;
  if p_status = 'failed' and p_retry and v_n.attempts < v_n.max_attempts then
    v_final := 'pending';
  end if;
  update public.notifications
     set status = v_final,
         last_error = case when p_status = 'sent' then null else left(p_error, 500) end,
         next_attempt_at = case when v_final = 'pending'
                                then now() + make_interval(mins => 5 * (2 ^ greatest(v_n.attempts - 1, 0))::int)
                                else next_attempt_at end,
         locked_at = null,
         recipient = coalesce(p_recipient, recipient),
         provider = coalesce(p_provider, provider),
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id;
  return v_final;
end;
$$;

-- Dati per comporre l'email, letti al momento dell'invio (sempre aggiornati).
create or replace function public.notification_context(p_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_n public.notifications%rowtype;
  v_cfg public.business_settings%rowtype;
  v_a jsonb;
  v_r jsonb;
  v_valid boolean := true;
  v_reason text;
  v_appt_status text;
  v_appt_start timestamptz;
  v_customer_email text;
  v_customer_first text;
begin
  perform public.assert_backend_or_admin();
  select * into v_n from public.notifications where id = p_id;
  if not found then
    raise exception using message = 'NOT_FOUND', errcode = 'P0001';
  end if;
  select * into v_cfg from public.business_settings where id = 1;

  if v_n.appointment_id is not null then
    select jsonb_build_object(
             'id', a.id, 'code', a.code, 'status', a.status, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
             'service_name', s.name, 'category', s.category, 'booking_mode', s.booking_mode,
             'staff_name', st.display_name),
           a.status, a.starts_at, c.email, c.first_name
      into v_a, v_appt_status, v_appt_start, v_customer_email, v_customer_first
      from public.appointments a
      join public.services s on s.id = a.service_id
      join public.staff st on st.id = a.staff_id
      join public.customers c on c.id = a.customer_id
     where a.id = v_n.appointment_id;
  end if;

  if v_n.booking_request_id is not null then
    select jsonb_build_object(
             'id', r.id, 'code', r.code, 'status', r.status, 'service_name', s.name, 'category', s.category,
             'preferred_date', r.preferred_date, 'preferred_time_window', r.preferred_time_window,
             'proposed_starts_at', r.proposed_starts_at,
             'proposed_staff_name', (select display_name from public.staff where id = r.proposed_staff_id),
             'duration_minutes', s.duration_minutes),
           coalesce(v_customer_email, c.email), coalesce(v_customer_first, c.first_name)
      into v_r, v_customer_email, v_customer_first
      from public.booking_requests r
      join public.services s on s.id = r.service_id
      join public.customers c on c.id = r.customer_id
     where r.id = v_n.booking_request_id;
  end if;

  -- Una email non deve descrivere uno stato non più vero.
  if v_n.kind in ('booking_confirmed', 'request_approved', 'appointment_rescheduled', 'reminder') then
    if v_appt_status is distinct from 'confirmed' then
      v_valid := false; v_reason := 'Appuntamento non più confermato';
    elsif v_n.data ? 'starts_at' and (v_n.data ->> 'starts_at')::timestamptz <> v_appt_start then
      v_valid := false; v_reason := 'Orario cambiato dopo la creazione della notifica';
    elsif v_n.kind = 'reminder' and v_appt_start <= now() then
      v_valid := false; v_reason := 'Appuntamento già iniziato';
    end if;
  elsif v_n.kind = 'request_proposal' then
    if (v_r ->> 'status') <> 'reschedule'
       or (v_r ->> 'proposed_starts_at')::timestamptz is distinct from (v_n.data ->> 'proposed_starts_at')::timestamptz then
      v_valid := false; v_reason := 'Proposta non più attuale';
    end if;
  end if;

  return jsonb_build_object(
    'id', v_n.id, 'kind', v_n.kind, 'audience', v_n.audience, 'data', v_n.data, 'attempts', v_n.attempts,
    'max_attempts', v_n.max_attempts,
    'recipient', case when v_n.audience = 'salon' then v_cfg.notification_email else v_customer_email end,
    'customer_first_name', v_customer_first,
    'appointment', v_a,
    'request', v_r,
    'valid', v_valid,
    'invalid_reason', v_reason,
    'needs_link', v_valid and v_n.audience = 'customer'
                  and v_n.kind in ('booking_confirmed', 'request_approved', 'appointment_rescheduled', 'reminder')
                  and v_appt_status = 'confirmed' and v_appt_start > now(),
    'settings', jsonb_build_object(
      'business_name', v_cfg.business_name, 'logo_url', v_cfg.logo_url, 'address', v_cfg.address,
      'contact_phone', v_cfg.contact_phone, 'contact_email', v_cfg.contact_email,
      'email_instructions', v_cfg.email_instructions, 'customer_change_min_hours', v_cfg.customer_change_min_hours)
  );
end;
$$;

-- Promemoria: idempotente grazie a dedupe_key (appuntamento + orario + numero)
create or replace function public.enqueue_due_reminders()
returns int
language plpgsql
volatile
set search_path = public
as $$
declare
  v_cfg public.business_settings%rowtype;
  v_count int := 0;
  v_n int;
  v_hours int;
  v_rows int;
begin
  perform public.assert_backend_or_admin();
  select * into v_cfg from public.business_settings where id = 1;
  foreach v_n in array array[1, 2] loop
    v_hours := case v_n when 1 then v_cfg.reminder_1_hours else v_cfg.reminder_2_hours end;
    continue when v_hours is null;
    insert into public.notifications (kind, audience, appointment_id, dedupe_key, data)
    select 'reminder', 'customer', a.id,
           'reminder' || v_n || ':' || a.id || ':' || extract(epoch from a.starts_at)::bigint,
           jsonb_build_object('n', v_n, 'starts_at', a.starts_at, 'hours', v_hours)
      from public.appointments a
      join public.customers c on c.id = a.customer_id
     where a.status = 'confirmed'
       and c.email_normalized <> ''
       and a.starts_at > now() + interval '1 hour'
       and a.starts_at <= now() + make_interval(hours => v_hours)
       -- non inviare se l'appuntamento è stato fissato/spostato dopo il momento del promemoria
       and greatest(a.created_at, coalesce(a.rescheduled_at, a.created_at)) < a.starts_at - make_interval(hours => v_hours)
    on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  return v_count;
end;
$$;

create or replace function public.admin_retry_notification(p_id uuid)
returns void
language plpgsql
volatile
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  update public.notifications
     set status = 'pending', next_attempt_at = now(), max_attempts = attempts + 3, last_error = null
   where id = p_id and status in ('failed', 'skipped');
end;
$$;

-- ---------------------------------------------------------------------
-- DASHBOARD: panoramica
-- ---------------------------------------------------------------------
create or replace function public.admin_overview(p_date date)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_from timestamptz := (p_date::timestamp) at time zone public.app_tz();
  v_to timestamptz := ((p_date + 1)::timestamp) at time zone public.app_tz();
  v_week timestamptz := ((p_date + 8)::timestamp) at time zone public.app_tz();
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  return jsonb_build_object(
    'today_count', (select count(*) from appointments where starts_at >= v_from and starts_at < v_to and status <> 'cancelled'),
    'upcoming_count', (select count(*) from appointments where starts_at >= v_to and starts_at < v_week and status = 'confirmed'),
    'pending_requests', (select count(*) from booking_requests r join services s on s.id = r.service_id
                          where r.status in ('pending', 'reschedule') and s.category = 'hair'),
    'pending_consultations', (select count(*) from booking_requests r join services s on s.id = r.service_id
                               where r.status in ('pending', 'reschedule') and s.category = 'consultation'),
    'upcoming_consultations', (select count(*) from appointments a join services s on s.id = a.service_id
                                where a.status = 'confirmed' and s.category = 'consultation' and a.starts_at >= v_from),
    'cancelled_7d', (select count(*) from appointments where status = 'cancelled' and cancelled_at >= now() - interval '7 days'),
    'failed_notifications', (select count(*) from notifications where status = 'failed'),
    'skipped_notifications_7d', (select count(*) from notifications where status = 'skipped' and created_at >= now() - interval '7 days'),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', st.id,
        'name', st.display_name,
        'shifts', coalesce((select jsonb_agg(jsonb_build_object('start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI')) order by w.start_time)
                              from working_hours w where w.staff_id = st.id and w.weekday = extract(isodow from p_date)::int), '[]'::jsonb),
        'time_off', exists (select 1 from time_off t where (t.staff_id is null or t.staff_id = st.id)
                              and tstzrange(t.starts_at, t.ends_at) && tstzrange(v_from, v_to)),
        'appointments', (select count(*) from appointments a where a.staff_id = st.id and a.status <> 'cancelled'
                              and a.starts_at >= v_from and a.starts_at < v_to),
        'booked_minutes', (select coalesce(sum(extract(epoch from (a.ends_at - a.starts_at)) / 60), 0)::int from appointments a
                              where a.staff_id = st.id and a.status <> 'cancelled' and a.starts_at >= v_from and a.starts_at < v_to),
        'work_minutes', (select coalesce(sum(extract(epoch from (w.end_time - w.start_time)) / 60), 0)::int from working_hours w
                              where w.staff_id = st.id and w.weekday = extract(isodow from p_date)::int)
      ) order by st.sort_order, st.display_name)
      from staff st where st.active), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- DASHBOARD: clienti
-- ---------------------------------------------------------------------
create or replace function public.admin_customers(p_query text default null, p_limit int default 50)
returns table (
  id uuid, first_name text, last_name text, phone text, email text, created_at timestamptz,
  past_count bigint, upcoming_count bigint, last_visit timestamptz, next_visit timestamptz
)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_q text := btrim(coalesce(p_query, ''));
  v_digits text := regexp_replace(v_q, '[^0-9]', '', 'g');
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  return query
  select c.id, c.first_name, c.last_name, c.phone, c.email, c.created_at,
         count(a.id) filter (where a.starts_at < now() and a.status in ('completed', 'confirmed', 'no_show')),
         count(a.id) filter (where a.starts_at >= now() and a.status = 'confirmed'),
         max(a.starts_at) filter (where a.starts_at < now() and a.status <> 'cancelled'),
         min(a.starts_at) filter (where a.starts_at >= now() and a.status = 'confirmed')
    from public.customers c
    left join public.appointments a on a.customer_id = c.id
   where v_q = ''
      or c.full_name ilike '%' || v_q || '%'
      or (c.last_name || ' ' || c.first_name) ilike '%' || v_q || '%'
      or c.email_normalized like '%' || lower(v_q) || '%'
      or (length(v_digits) >= 4 and c.phone_normalized like '%' || v_digits || '%')
   group by c.id
   order by c.last_name, c.first_name
   limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

-- ---------------------------------------------------------------------
-- Permessi delle nuove funzioni (minimo privilegio)
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.upsert_customer(text, text, text, text)',
    'public.enqueue_notification(text, text, uuid, uuid, text, jsonb)',
    'public.revoke_appointment_tokens(uuid)',
    'public.book_appointment(uuid, uuid, timestamptz, text, text, text, text, text, boolean)',
    'public.create_booking_request(uuid, text, text, text, text, date, text, uuid, text, boolean)',
    'public.admin_confirm_request(uuid, uuid, timestamptz, text, boolean)',
    'public.admin_set_request_status(uuid, text, text, boolean)',
    'public.admin_propose_request_time(uuid, uuid, timestamptz, text)',
    'public.admin_create_appointment(uuid, uuid, timestamptz, text, text, text, text, text, boolean, boolean)',
    'public.admin_move_appointment(uuid, uuid, timestamptz, boolean, boolean)',
    'public.admin_cancel_appointment(uuid, text, boolean)',
    'public.issue_manage_token(uuid, text)',
    'public.revoke_token(uuid)',
    'public.resolve_manage_token(text, boolean)',
    'public.customer_get_appointment(text)',
    'public.customer_cancel_appointment(text)',
    'public.customer_reschedule_appointment(text, timestamptz, uuid)',
    'public.customer_request_reschedule(text, date, text, text)',
    'public.claim_notifications(int, uuid[])',
    'public.complete_notification(uuid, text, text, boolean, text, text, text)',
    'public.notification_context(uuid)',
    'public.enqueue_due_reminders()',
    'public.admin_retry_notification(uuid)',
    'public.admin_overview(date)',
    'public.admin_customers(text, int)',
    'public.audit_row()',
    'public.customers_sync_full_name()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- usate internamente dalle funzioni admin (invoker) e dai trigger
grant execute on function public.upsert_customer(text, text, text, text) to authenticated, service_role;
grant execute on function public.enqueue_notification(text, text, uuid, uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.revoke_appointment_tokens(uuid) to authenticated, service_role;
grant execute on function public.audit_row() to authenticated, service_role;
grant execute on function public.customers_sync_full_name() to authenticated, service_role;

-- area amministrativa (controllo is_admin() interno)
grant execute on function public.admin_confirm_request(uuid, uuid, timestamptz, text, boolean) to authenticated;
grant execute on function public.admin_set_request_status(uuid, text, text, boolean) to authenticated;
grant execute on function public.admin_propose_request_time(uuid, uuid, timestamptz, text) to authenticated;
grant execute on function public.admin_create_appointment(uuid, uuid, timestamptz, text, text, text, text, text, boolean, boolean) to authenticated;
grant execute on function public.admin_move_appointment(uuid, uuid, timestamptz, boolean, boolean) to authenticated;
grant execute on function public.admin_cancel_appointment(uuid, text, boolean) to authenticated;
grant execute on function public.admin_retry_notification(uuid) to authenticated;
grant execute on function public.admin_overview(date) to authenticated;
grant execute on function public.admin_customers(text, int) to authenticated;

-- solo backend (Netlify Functions con service role)
grant execute on function public.book_appointment(uuid, uuid, timestamptz, text, text, text, text, text, boolean) to service_role;
grant execute on function public.create_booking_request(uuid, text, text, text, text, date, text, uuid, text, boolean) to service_role;
grant execute on function public.issue_manage_token(uuid, text) to service_role;
grant execute on function public.revoke_token(uuid) to service_role;
grant execute on function public.resolve_manage_token(text, boolean) to service_role;
grant execute on function public.customer_get_appointment(text) to service_role;
grant execute on function public.customer_cancel_appointment(text) to service_role;
grant execute on function public.customer_reschedule_appointment(text, timestamptz, uuid) to service_role;
grant execute on function public.customer_request_reschedule(text, date, text, text) to service_role;
grant execute on function public.claim_notifications(int, uuid[]) to service_role;
grant execute on function public.complete_notification(uuid, text, text, boolean, text, text, text) to service_role;
grant execute on function public.notification_context(uuid) to service_role;
grant execute on function public.enqueue_due_reminders() to service_role;
