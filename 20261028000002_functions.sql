-- =====================================================================
-- Maylana Coiffeur Booking — Funzioni: ruoli, disponibilità, prenotazione
-- atomica, richieste, operazioni amministrative, rate limit.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Ruoli amministrativi
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid() and role = 'owner');
$$;

-- Chiamata dal backend (service role) oppure da un admin autenticato.
create or replace function public.assert_backend_or_admin()
returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or public.is_admin() then
    return;
  end if;
  raise exception using message = 'FORBIDDEN', errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------
-- Verifica di uno slot per un operatore.
-- Ritorna NULL se libero, altrimenti il motivo.
-- ---------------------------------------------------------------------

create or replace function public.slot_problem(
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_check_working_hours boolean default true,
  p_ignore_appointment_id uuid default null
)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_local_start timestamp := p_starts_at at time zone public.app_tz();
  v_local_end   timestamp := p_ends_at   at time zone public.app_tz();
begin
  if p_ends_at <= p_starts_at then
    return 'INVALID_RANGE';
  end if;

  if not exists (select 1 from public.staff where id = p_staff_id and active) then
    return 'STAFF_INACTIVE';
  end if;

  if p_check_working_hours and not exists (
    select 1
    from public.working_hours w
    where w.staff_id = p_staff_id
      and w.weekday = extract(isodow from v_local_start)::int
      and v_local_start >= v_local_start::date + w.start_time
      and v_local_end   <= v_local_start::date + w.end_time
  ) then
    return 'OUTSIDE_WORKING_HOURS';
  end if;

  if exists (
    select 1
    from public.time_off t
    where (t.staff_id is null or t.staff_id = p_staff_id)
      and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    return 'TIME_OFF';
  end if;

  if exists (
    select 1
    from public.appointments a
    where a.staff_id = p_staff_id
      and a.status <> 'cancelled'
      and (p_ignore_appointment_id is null or a.id <> p_ignore_appointment_id)
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    return 'SLOT_UNAVAILABLE';
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Slot disponibili per servizio e giorno (data locale Europe/Rome).
-- Generati dagli orari reali di ciascun operatore abilitato al servizio.
-- Le richieste in attesa NON vengono considerate (non bloccano slot).
-- p_apply_booking_window: applica preavviso minimo e orizzonte (pubblico).
-- ---------------------------------------------------------------------

create or replace function public.get_available_slots(
  p_service_id uuid,
  p_date date,
  p_staff_id uuid default null,
  p_apply_booking_window boolean default true
)
returns table (staff_id uuid, staff_name text, starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_duration int;
  v_cfg public.business_settings%rowtype;
  v_today date := (now() at time zone public.app_tz())::date;
begin
  perform public.assert_backend_or_admin();

  select duration_minutes into v_duration
  from public.services
  where id = p_service_id and active;

  if v_duration is null then
    return;
  end if;

  select * into v_cfg from public.business_settings where id = 1;

  if p_apply_booking_window and (p_date < v_today or p_date > v_today + v_cfg.booking_horizon_days) then
    return;
  end if;

  return query
  with eligible as (
    select s.id, s.display_name, s.sort_order
    from public.staff s
    join public.staff_services ss on ss.staff_id = s.id and ss.service_id = p_service_id
    where s.active
      and (p_staff_id is null or s.id = p_staff_id)
  ),
  shifts as (
    select e.id as sid, e.display_name, e.sort_order,
           (p_date + w.start_time) at time zone public.app_tz() as shift_start,
           (p_date + w.end_time)   at time zone public.app_tz() as shift_end
    from eligible e
    join public.working_hours w
      on w.staff_id = e.id and w.weekday = extract(isodow from p_date)::int
  ),
  candidates as (
    select sh.sid, sh.display_name, sh.sort_order,
           gs as c_start,
           gs + make_interval(mins => v_duration) as c_end
    from shifts sh
    cross join lateral generate_series(
      sh.shift_start,
      sh.shift_end - make_interval(mins => v_duration),
      make_interval(mins => v_cfg.slot_interval_minutes)
    ) as gs
  )
  select c.sid, c.display_name, c.c_start, c.c_end
  from candidates c
  where (not p_apply_booking_window
         or c.c_start >= now() + make_interval(mins => v_cfg.min_notice_minutes))
    and not exists (
      select 1 from public.time_off t
      where (t.staff_id is null or t.staff_id = c.sid)
        and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(c.c_start, c.c_end, '[)')
    )
    and not exists (
      select 1 from public.appointments a
      where a.staff_id = c.sid
        and a.status <> 'cancelled'
        and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(c.c_start, c.c_end, '[)')
    )
  order by c.c_start, c.sort_order, c.display_name;
end;
$$;

-- ---------------------------------------------------------------------
-- Cliente: trova o crea (chiave = telefono normalizzato + email)
-- ---------------------------------------------------------------------

create or replace function public.upsert_customer(p_full_name text, p_phone text, p_email text)
returns uuid
language plpgsql
volatile
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_phone_raw text := btrim(coalesce(p_phone, ''));
  v_phone text := regexp_replace(v_phone_raw, '[^0-9+]', '', 'g');
  v_email_raw text := btrim(coalesce(p_email, ''));
  v_email text := lower(v_email_raw);
begin
  perform public.assert_backend_or_admin();

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception using message = 'INVALID_NAME', errcode = 'P0001';
  end if;
  if v_phone !~ '^\+?[0-9]{6,20}$' then
    raise exception using message = 'INVALID_PHONE', errcode = 'P0001';
  end if;
  if v_email <> '' and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 200) then
    raise exception using message = 'INVALID_EMAIL', errcode = 'P0001';
  end if;

  insert into public.customers (full_name, phone, phone_normalized, email, email_normalized)
  values (v_name, v_phone_raw, v_phone, nullif(v_email_raw, ''), v_email)
  on conflict (phone_normalized, email_normalized)
    do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- PRENOTAZIONE AUTOMATICA ATOMICA (chiamata dal backend Netlify)
-- Controllo disponibilità + inserimento nella stessa transazione.
-- Il vincolo di esclusione impedisce sovrapposizioni anche in caso di
-- richieste simultanee: la seconda transazione fallisce e, se l'operatore
-- era "indifferente", si prova il successivo libero.
-- ---------------------------------------------------------------------

create or replace function public.book_appointment(
  p_service_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_full_name text,
  p_phone text,
  p_email text,
  p_notes text,
  p_privacy_accepted boolean
)
returns table (
  appointment_id uuid,
  code text,
  starts_at timestamptz,
  ends_at timestamptz,
  staff_name text,
  service_name text
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
begin
  perform public.assert_backend_or_admin();

  if not coalesce(p_privacy_accepted, false) then
    raise exception using message = 'PRIVACY_REQUIRED', errcode = 'P0001';
  end if;

  if not (select online_booking_enabled from public.business_settings where id = 1) then
    raise exception using message = 'BOOKING_DISABLED', errcode = 'P0001';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id
    and active
    and category = 'hair'
    and booking_mode = 'automatic';

  if not found then
    raise exception using message = 'SERVICE_NOT_BOOKABLE', errcode = 'P0001';
  end if;

  if p_notes is not null and length(p_notes) > 500 then
    raise exception using message = 'INVALID_NOTES', errcode = 'P0001';
  end if;

  if btrim(coalesce(p_email, '')) = '' then
    raise exception using message = 'INVALID_EMAIL', errcode = 'P0001';
  end if;

  v_customer := public.upsert_customer(p_full_name, p_phone, p_email);

  for v_candidate in
    select s.staff_id, s.staff_name, s.starts_at, s.ends_at
    from public.get_available_slots(p_service_id, v_local_date, p_staff_id, true) s
    where s.starts_at = p_starts_at
  loop
    begin
      insert into public.appointments (
        service_id, staff_id, customer_id, starts_at, ends_at,
        status, source, customer_notes, privacy_accepted_at
      )
      values (
        p_service_id, v_candidate.staff_id, v_customer, v_candidate.starts_at, v_candidate.ends_at,
        'confirmed', 'online', nullif(btrim(coalesce(p_notes, '')), ''), now()
      )
      returning * into v_appt;

      return query
        select v_appt.id, v_appt.code, v_appt.starts_at, v_appt.ends_at,
               v_candidate.staff_name, v_service.name;
      return;
    exception
      when exclusion_violation then
        -- Slot occupato da una transazione concorrente: prova il prossimo operatore.
        null;
    end;
  end loop;

  raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------
-- RICHIESTA CON APPROVAZIONE MANUALE (consulenze / servizi manuali)
-- Non crea appuntamenti e non blocca slot.
-- ---------------------------------------------------------------------

create or replace function public.create_booking_request(
  p_service_id uuid,
  p_full_name text,
  p_phone text,
  p_email text,
  p_preferred_date date,
  p_preferred_time_window text,
  p_preferred_staff_id uuid,
  p_notes text,
  p_privacy_accepted boolean
)
returns table (request_id uuid, code text, status text)
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
begin
  perform public.assert_backend_or_admin();

  if not coalesce(p_privacy_accepted, false) then
    raise exception using message = 'PRIVACY_REQUIRED', errcode = 'P0001';
  end if;

  select * into v_cfg from public.business_settings where id = 1;
  if not v_cfg.online_booking_enabled then
    raise exception using message = 'BOOKING_DISABLED', errcode = 'P0001';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and active and booking_mode = 'manual';

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

  v_customer := public.upsert_customer(p_full_name, p_phone, p_email);

  -- Anti-abuso: massimo 3 richieste in attesa per lo stesso cliente.
  if (select count(*) from public.booking_requests r
      where r.customer_id = v_customer and r.status = 'pending') >= 3 then
    raise exception using message = 'TOO_MANY_PENDING', errcode = 'P0001';
  end if;

  insert into public.booking_requests (
    service_id, customer_id, preferred_staff_id, preferred_date,
    preferred_time_window, customer_notes, privacy_accepted_at
  )
  values (
    p_service_id, v_customer, p_preferred_staff_id, p_preferred_date,
    coalesce(p_preferred_time_window, 'indifferente'),
    nullif(btrim(coalesce(p_notes, '')), ''), now()
  )
  returning * into v_req;

  return query select v_req.id, v_req.code, v_req.status;
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: conferma richiesta solo se l'orario è ancora disponibile
-- ---------------------------------------------------------------------

create or replace function public.admin_confirm_request(
  p_request_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_internal_notes text default null,
  p_allow_outside_hours boolean default false
)
returns uuid
language plpgsql
volatile
set search_path = public
as $$
declare
  v_req public.booking_requests%rowtype;
  v_duration int;
  v_ends timestamptz;
  v_problem text;
  v_appt_id uuid;
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

  select duration_minutes into v_duration from public.services where id = v_req.service_id;
  if v_duration is null then
    raise exception using message = 'SERVICE_DURATION_MISSING', errcode = 'P0001';
  end if;

  v_ends := p_starts_at + make_interval(mins => v_duration);

  v_problem := public.slot_problem(p_staff_id, p_starts_at, v_ends, not coalesce(p_allow_outside_hours, false));
  if v_problem is not null then
    raise exception using message = v_problem, errcode = 'P0001';
  end if;

  -- Un eventuale appuntamento precedente (es. riprogrammazione) viene liberato.
  update public.appointments
     set status = 'cancelled', cancelled_at = now(), booking_request_id = null
   where booking_request_id = v_req.id and status <> 'cancelled';
  update public.appointments set booking_request_id = null where booking_request_id = v_req.id;

  begin
    insert into public.appointments (
      service_id, staff_id, customer_id, booking_request_id, starts_at, ends_at,
      status, source, customer_notes, internal_notes, privacy_accepted_at, created_by
    )
    values (
      v_req.service_id, p_staff_id, v_req.customer_id, v_req.id, p_starts_at, v_ends,
      'confirmed', 'request', v_req.customer_notes, nullif(btrim(coalesce(p_internal_notes, '')), ''),
      v_req.privacy_accepted_at, auth.uid()
    )
    returning id into v_appt_id;
  exception
    when exclusion_violation then
      raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
  end;

  update public.booking_requests
     set status = 'confirmed', handled_by = auth.uid(), handled_at = now()
   where id = v_req.id;

  return v_appt_id;
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: cambio stato richiesta (rifiutata / da riprogrammare / annullata)
-- Se esisteva un appuntamento collegato, viene annullato e lo slot liberato.
-- ---------------------------------------------------------------------

create or replace function public.admin_set_request_status(
  p_request_id uuid,
  p_status text,
  p_admin_notes text default null
)
returns void
language plpgsql
volatile
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;

  if p_status not in ('pending', 'rejected', 'reschedule', 'cancelled') then
    raise exception using message = 'INVALID_STATUS', errcode = 'P0001';
  end if;

  update public.booking_requests
     set status = p_status,
         admin_notes = coalesce(nullif(btrim(coalesce(p_admin_notes, '')), ''), admin_notes),
         handled_by = auth.uid(),
         handled_at = now()
   where id = p_request_id;

  if not found then
    raise exception using message = 'REQUEST_NOT_FOUND', errcode = 'P0001';
  end if;

  update public.appointments
     set status = 'cancelled', cancelled_at = now()
   where booking_request_id = p_request_id and status = 'confirmed';
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: inserimento manuale appuntamento
-- ---------------------------------------------------------------------

create or replace function public.admin_create_appointment(
  p_service_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_full_name text,
  p_phone text,
  p_email text default null,
  p_internal_notes text default null,
  p_allow_outside_hours boolean default false
)
returns uuid
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

  v_customer := public.upsert_customer(p_full_name, p_phone, p_email);

  begin
    insert into public.appointments (
      service_id, staff_id, customer_id, starts_at, ends_at, status, source, internal_notes, created_by
    )
    values (
      p_service_id, p_staff_id, v_customer, p_starts_at, v_ends, 'confirmed', 'admin',
      nullif(btrim(coalesce(p_internal_notes, '')), ''), auth.uid()
    )
    returning id into v_id;
  exception
    when exclusion_violation then
      raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
  end;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: ricerca appuntamenti (nome, telefono, email, codice)
-- ---------------------------------------------------------------------

create or replace function public.admin_search_appointments(p_query text)
returns table (
  id uuid, code text, starts_at timestamptz, ends_at timestamptz, status text, source text,
  service_name text, staff_name text, customer_name text, customer_phone text, customer_email text
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
  if length(v_q) < 2 then
    return;
  end if;

  return query
  select a.id, a.code, a.starts_at, a.ends_at, a.status, a.source,
         s.name, st.display_name, c.full_name, c.phone, c.email
  from public.appointments a
  join public.services s on s.id = a.service_id
  join public.staff st on st.id = a.staff_id
  join public.customers c on c.id = a.customer_id
  where a.code ilike '%' || v_q || '%'
     or c.full_name ilike '%' || v_q || '%'
     or c.email_normalized ilike '%' || lower(v_q) || '%'
     or (length(v_digits) >= 4 and c.phone_normalized like '%' || v_digits || '%')
  order by a.starts_at desc
  limit 100;
end;
$$;

-- ---------------------------------------------------------------------
-- Rate limit persistente (solo backend)
-- ---------------------------------------------------------------------

create or replace function public.check_rate_limit(p_bucket text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into public.api_rate_limits (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set hits = public.api_rate_limits.hits + 1
  returning hits into v_hits;

  if random() < 0.02 then
    delete from public.api_rate_limits where window_start < now() - interval '2 days';
  end if;

  return v_hits <= p_max;
end;
$$;
