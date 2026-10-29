-- =====================================================================
-- Maylana Booking v3 — Funzioni
--   bundle_info            validazione e totali di una combinazione di servizi
--   day_shifts             turni operatori ∩ orari di apertura del salone
--   get_bundle_slots       motore di disponibilità + punteggio "orari consigliati"
--   book_appointment       prenotazione atomica multi-servizio, idempotente
--   create_booking_request richiesta multi-servizio, idempotente
--   admin_*                inserimento/modifica combinati, assegnazione operatore,
--                          approvazione, suggerimenti per riempire gli spazi
--   customer_*             gestione dal link personale con servizi multipli
-- =====================================================================

drop function if exists public.book_appointment(uuid, uuid, timestamptz, text, text, text, text, text, boolean);
drop function if exists public.create_booking_request(uuid, text, text, text, text, date, text, uuid, text, boolean);
drop function if exists public.admin_create_appointment(uuid, uuid, timestamptz, text, text, text, text, text, boolean, boolean);
drop function if exists public.get_available_slots(uuid, date, uuid, boolean);

-- ---------------------------------------------------------------------
-- Combinazione di servizi: validazione e totali (calcolati SEMPRE dal DB)
-- ---------------------------------------------------------------------
create or replace function public.bundle_info(p_service_ids uuid[])
returns table (
  valid boolean, error text, n int, service_ids uuid[],
  duration_minutes int, buffer_minutes int, block_minutes int,
  price_cents int, price_is_estimate boolean,
  all_automatic boolean, is_consultation boolean, label text, eligible_staff uuid[]
)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_n int := coalesce(array_length(p_service_ids, 1), 0);
  v_cfg public.business_settings%rowtype;
  r record;
  v_staff uuid[];
begin
  perform public.assert_backend_or_admin();
  if v_n < 1 or v_n > 5 or (select count(distinct x) from unnest(p_service_ids) x) <> v_n then
    return query select false, 'INVALID_SERVICES'::text, v_n, p_service_ids, 0, 0, 0, null::int, true, false, false, null::text, '{}'::uuid[];
    return;
  end if;
  select * into v_cfg from public.business_settings where id = 1;

  select count(*)::int as found,
         count(*) filter (where s.duration_minutes is null)::int as no_duration,
         coalesce(sum(s.duration_minutes), 0)::int as dur,
         coalesce(sum(s.buffer_after_minutes), 0)::int as buf,
         case when bool_or(s.price_cents is null) then null else sum(s.price_cents)::int end as price,
         coalesce(bool_or(s.price_from) or bool_or(s.price_cents is null), true) as est,
         coalesce(bool_and(s.booking_mode = 'automatic'), false) as auto,
         coalesce(bool_or(s.category = 'consultation'), false) as cons,
         string_agg(s.name, ' + ' order by u.ord) as lbl
    into r
    from unnest(p_service_ids) with ordinality u(id, ord)
    join public.services s on s.id = u.id and s.active;

  if r.found <> v_n or r.no_duration > 0 then
    return query select false, 'SERVICE_NOT_BOOKABLE'::text, v_n, p_service_ids, 0, 0, 0, null::int, true, false, false, null::text, '{}'::uuid[];
    return;
  end if;
  if r.cons and v_n > 1 then
    return query select false, 'CONSULTATION_SINGLE'::text, v_n, p_service_ids, 0, 0, 0, null::int, true, false, true, null::text, '{}'::uuid[];
    return;
  end if;

  -- Una combinazione usa UN solo operatore abilitato a tutti i servizi.
  select coalesce(array_agg(st.id order by st.sort_order, st.display_name), '{}') into v_staff
    from public.staff st
   where st.active
     and (select count(distinct ss.service_id) from public.staff_services ss
           where ss.staff_id = st.id and ss.service_id = any (p_service_ids)) = v_n;

  return query select true, null::text, v_n, p_service_ids, r.dur, r.buf + v_cfg.booking_buffer_minutes,
                      r.dur + r.buf + v_cfg.booking_buffer_minutes, r.price, r.est, r.auto, r.cons, r.lbl, v_staff;
end;
$$;

-- ---------------------------------------------------------------------
-- Turni effettivi del giorno: turno operatore ∩ orario di apertura salone
-- ---------------------------------------------------------------------
create or replace function public.day_shifts(p_date date)
returns table (staff_id uuid, shift_start timestamptz, shift_end timestamptz)
language sql
stable
set search_path = public
as $$
  with w as (
    select w.staff_id, w.start_time, w.end_time
      from public.working_hours w
     where w.weekday = extract(isodow from p_date)::int
  ),
  has_open as (select exists (select 1 from public.opening_hours) as v),
  o as (
    select start_time, end_time from public.opening_hours where weekday = extract(isodow from p_date)::int
  )
  select w.staff_id,
         (p_date + w.start_time) at time zone public.app_tz(),
         (p_date + w.end_time) at time zone public.app_tz()
    from w, has_open
   where not has_open.v
  union all
  select w.staff_id,
         (p_date + greatest(w.start_time, o.start_time)) at time zone public.app_tz(),
         (p_date + least(w.end_time, o.end_time)) at time zone public.app_tz()
    from w
    join o on greatest(w.start_time, o.start_time) < least(w.end_time, o.end_time)
    cross join has_open
   where has_open.v;
$$;

-- ---------------------------------------------------------------------
-- MOTORE DI DISPONIBILITÀ
-- Restituisce solo slot in cui l'INTERA combinazione (servizi + tempi di
-- preparazione + tempo aggiuntivo) entra senza interruzioni nel turno
-- effettivo di un operatore abilitato a tutti i servizi, senza ferie,
-- pause, chiusure o appuntamenti confermati. Le richieste in attesa non
-- bloccano. fit_rank (orari consigliati, logica prevedibile):
--   0 = riempie esattamente uno spazio libero (nessun buco prima/dopo)
--   1 = attaccato a un appuntamento o all'inizio/fine turno, senza lasciare buchi inutilizzabili
--   2 = neutro
--   3 = lascia un buco più corto di min_useful_gap_minutes
-- ---------------------------------------------------------------------
create or replace function public.get_bundle_slots(
  p_service_ids uuid[],
  p_date date,
  p_staff_id uuid default null,
  p_apply_booking_window boolean default true,
  p_ignore_appointment_id uuid default null
)
returns table (
  staff_id uuid, staff_name text, starts_at timestamptz, ends_at timestamptz,
  gap_before_minutes int, gap_after_minutes int, fit_rank int
)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  b record;
  v_cfg public.business_settings%rowtype;
  v_today date := (now() at time zone public.app_tz())::date;
  v_from timestamptz := (p_date::timestamp) at time zone public.app_tz();
  v_to timestamptz := ((p_date + 1)::timestamp) at time zone public.app_tz();
begin
  perform public.assert_backend_or_admin();
  select * into b from public.bundle_info(p_service_ids);
  if not b.valid then
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
     where s.active and s.id = any (b.eligible_staff)
       and (p_staff_id is null or s.id = p_staff_id)
  ),
  shifts as (
    select e.id as sid, e.display_name, e.sort_order, d.shift_start, d.shift_end
      from eligible e
      join public.day_shifts(p_date) d on d.staff_id = e.id
  ),
  busy as (
    select a.staff_id as sid, a.starts_at as bs, a.ends_at as be
      from public.appointments a
     where a.status <> 'cancelled'
       and a.starts_at < v_to and a.ends_at > v_from
       and a.staff_id in (select id from eligible)
       and (p_ignore_appointment_id is null or a.id <> p_ignore_appointment_id)
    union all
    select e.id, t.starts_at, t.ends_at
      from public.time_off t
      join eligible e on (t.staff_id is null or t.staff_id = e.id)
     where t.starts_at < v_to and t.ends_at > v_from
  ),
  candidates as (
    select sh.sid, sh.display_name, sh.sort_order, sh.shift_start, sh.shift_end,
           gs as c_start, gs + make_interval(mins => b.block_minutes) as c_end
      from shifts sh
      cross join lateral generate_series(
        sh.shift_start,
        sh.shift_end - make_interval(mins => b.block_minutes),
        make_interval(mins => v_cfg.slot_interval_minutes)
      ) gs
  ),
  free as (
    select c.*
      from candidates c
     where (not p_apply_booking_window or c.c_start >= now() + make_interval(mins => v_cfg.min_notice_minutes))
       and not exists (
         select 1 from busy x
          where x.sid = c.sid and tstzrange(x.bs, x.be, '[)') && tstzrange(c.c_start, c.c_end, '[)'))
  ),
  gaps as (
    select f.*,
      (extract(epoch from f.c_start - greatest(f.shift_start,
         coalesce((select max(x.be) from busy x where x.sid = f.sid and x.be <= f.c_start), f.shift_start))) / 60)::int as gb,
      (extract(epoch from least(f.shift_end,
         coalesce((select min(x.bs) from busy x where x.sid = f.sid and x.bs >= f.c_end), f.shift_end)) - f.c_end) / 60)::int as ga
      from free f
  )
  select g.sid, g.display_name, g.c_start, g.c_end, g.gb, g.ga,
         case
           when not v_cfg.smart_slots_enabled then 2
           when g.gb = 0 and g.ga = 0 then 0
           when (g.gb > 0 and g.gb < v_cfg.min_useful_gap_minutes) or (g.ga > 0 and g.ga < v_cfg.min_useful_gap_minutes) then 3
           when g.gb = 0 or g.ga = 0 then 1
           else 2
         end
    from gaps g
   order by g.c_start, g.sort_order, g.display_name;
end;
$$;

-- Compatibilità v0.1/v0.2: singolo servizio
create or replace function public.get_available_slots(
  p_service_id uuid,
  p_date date,
  p_staff_id uuid default null,
  p_apply_booking_window boolean default true
)
returns table (staff_id uuid, staff_name text, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = public
as $$
  select s.staff_id, s.staff_name, s.starts_at, s.ends_at
    from public.get_bundle_slots(array[p_service_id], p_date, p_staff_id, p_apply_booking_window) s;
$$;

-- ---------------------------------------------------------------------
-- Verifica slot per l'admin (ora anche con orari di apertura del salone)
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
  v_date date := (p_starts_at at time zone public.app_tz())::date;
begin
  if p_ends_at <= p_starts_at then
    return 'INVALID_RANGE';
  end if;
  if not exists (select 1 from public.staff where id = p_staff_id and active) then
    return 'STAFF_INACTIVE';
  end if;
  if p_check_working_hours and not exists (
    select 1 from public.day_shifts(v_date) d
     where d.staff_id = p_staff_id and p_starts_at >= d.shift_start and p_ends_at <= d.shift_end
  ) then
    return 'OUTSIDE_WORKING_HOURS';
  end if;
  if exists (
    select 1 from public.time_off t
     where (t.staff_id is null or t.staff_id = p_staff_id)
       and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    return 'TIME_OFF';
  end if;
  if exists (
    select 1 from public.appointments a
     where a.staff_id = p_staff_id and a.status <> 'cancelled'
       and (p_ignore_appointment_id is null or a.id <> p_ignore_appointment_id)
       and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    return 'SLOT_UNAVAILABLE';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Scrive gli elementi (snapshot) e i totali di un appuntamento
-- ---------------------------------------------------------------------
create or replace function public.write_appointment_items(p_appointment_id uuid, p_service_ids uuid[])
returns void
language plpgsql
volatile
set search_path = public
as $$
declare b record;
begin
  select * into b from public.bundle_info(p_service_ids);
  if not b.valid then
    raise exception using message = coalesce(b.error, 'SERVICE_NOT_BOOKABLE'), errcode = 'P0001';
  end if;
  delete from public.appointment_items where appointment_id = p_appointment_id;
  insert into public.appointment_items (appointment_id, service_id, position, name, duration_minutes, buffer_minutes, price_cents, price_from)
  select p_appointment_id, s.id, u.ord, s.name, s.duration_minutes, s.buffer_after_minutes, s.price_cents, s.price_from
    from unnest(p_service_ids) with ordinality u(id, ord)
    join public.services s on s.id = u.id;
  update public.appointments
     set service_id = p_service_ids[1], total_price_cents = b.price_cents, price_is_estimate = b.price_is_estimate
   where id = p_appointment_id;
end;
$$;

create or replace function public.staff_can_do_all(p_staff_id uuid, p_service_ids uuid[])
returns boolean
language sql
stable
set search_path = public
as $$
  select (select count(distinct ss.service_id) from public.staff_services ss
           where ss.staff_id = p_staff_id and ss.service_id = any (p_service_ids))
         = coalesce(array_length(p_service_ids, 1), 0);
$$;

create or replace function public.appointment_service_ids(p_appointment_id uuid)
returns uuid[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(service_id order by position), '{}') from public.appointment_items where appointment_id = p_appointment_id;
$$;

create or replace function public.record_marketing_consent(p_customer_id uuid, p_source text)
returns void
language sql
volatile
set search_path = public
as $$
  update public.customers
     set marketing_consent = true, marketing_consent_at = now(), marketing_consent_source = p_source
   where id = p_customer_id and not marketing_consent;
$$;

-- ---------------------------------------------------------------------
-- PRENOTAZIONE AUTOMATICA (multi-servizio, atomica, idempotente)
-- ---------------------------------------------------------------------
create or replace function public.book_appointment(
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_notes text,
  p_privacy_accepted boolean,
  p_marketing_consent boolean default false,
  p_idempotency_key uuid default null
)
returns table (
  appointment_id uuid, code text, starts_at timestamptz, ends_at timestamptz, staff_name text,
  services_label text, duration_minutes int, total_price_cents int, price_is_estimate boolean,
  notification_id uuid, replayed boolean
)
language plpgsql
volatile
set search_path = public
as $$
#variable_conflict use_column
declare
  b record;
  v_local_date date := (p_starts_at at time zone public.app_tz())::date;
  v_customer uuid;
  v_candidate record;
  v_appt public.appointments%rowtype;
  v_notif uuid;
  v_phone text := regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9+]', '', 'g');
begin
  perform public.assert_backend_or_admin();
  perform set_config('app.actor', 'customer', true);

  -- Stessa richiesta ripetuta (doppio clic, rete instabile): stessa risposta, nessun duplicato.
  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('book:' || p_idempotency_key::text, 0));
    select a.* into v_appt from public.appointments a where a.idempotency_key = p_idempotency_key;
    if found then
      -- stessa chiave ma contenuto diverso: non è una ripetizione, è un conflitto
      if (select phone_normalized from public.customers where id = v_appt.customer_id) <> v_phone
         or public.appointment_service_ids(v_appt.id) <> p_service_ids
         or v_appt.starts_at <> p_starts_at then
        raise exception using message = 'IDEMPOTENCY_CONFLICT', errcode = 'P0001';
      end if;
      return query
        select v_appt.id, v_appt.code, v_appt.starts_at, v_appt.ends_at,
               (select display_name from public.staff where id = v_appt.staff_id),
               (select string_agg(i.name, ' + ' order by i.position) from public.appointment_items i where i.appointment_id = v_appt.id),
               (select sum(i.duration_minutes)::int from public.appointment_items i where i.appointment_id = v_appt.id),
               v_appt.total_price_cents, v_appt.price_is_estimate,
               (select n.id from public.notifications n where n.dedupe_key = 'booking_confirmed:' || v_appt.id), true;
      return;
    end if;
  end if;

  if not coalesce(p_privacy_accepted, false) then
    raise exception using message = 'PRIVACY_REQUIRED', errcode = 'P0001';
  end if;
  if not (select online_booking_enabled from public.business_settings where id = 1) then
    raise exception using message = 'BOOKING_DISABLED', errcode = 'P0001';
  end if;

  select * into b from public.bundle_info(p_service_ids);
  if not b.valid then
    raise exception using message = b.error, errcode = 'P0001';
  end if;
  if not b.all_automatic or b.is_consultation then
    raise exception using message = 'REQUIRES_APPROVAL', errcode = 'P0001';
  end if;
  if coalesce(array_length(b.eligible_staff, 1), 0) = 0 then
    raise exception using message = 'NO_STAFF_FOR_COMBINATION', errcode = 'P0001';
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

  -- Verifica finale lato server, nella stessa transazione dell'inserimento.
  -- Con "nessuna preferenza" si prova prima l'operatore che lascia meno buchi.
  for v_candidate in
    select s.staff_id, s.staff_name, s.starts_at, s.ends_at
      from public.get_bundle_slots(p_service_ids, v_local_date, p_staff_id, true) s
     where s.starts_at = p_starts_at
     order by s.fit_rank, s.staff_name
  loop
    begin
      insert into public.appointments (
        service_id, staff_id, customer_id, starts_at, ends_at, status, source,
        customer_notes, privacy_accepted_at, idempotency_key
      )
      values (
        p_service_ids[1], v_candidate.staff_id, v_customer, v_candidate.starts_at, v_candidate.ends_at,
        'confirmed', 'online', nullif(btrim(coalesce(p_notes, '')), ''), now(), p_idempotency_key
      )
      returning * into v_appt;

      perform public.write_appointment_items(v_appt.id, p_service_ids);
      if coalesce(p_marketing_consent, false) then
        perform public.record_marketing_consent(v_customer, 'prenotazione online');
      end if;
      v_notif := public.enqueue_notification('booking_confirmed', 'customer', v_appt.id, null,
        'booking_confirmed:' || v_appt.id, jsonb_build_object('starts_at', v_appt.starts_at));

      return query select v_appt.id, v_appt.code, v_appt.starts_at, v_appt.ends_at, v_candidate.staff_name,
                          b.label, b.duration_minutes, b.price_cents, b.price_is_estimate, v_notif, false;
      return;
    exception
      when exclusion_violation then null; -- occupato in concorrenza: prossimo operatore
    end;
  end loop;

  raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------
-- RICHIESTA CON APPROVAZIONE (multi-servizio, idempotente)
-- Basta un servizio "su richiesta" perché tutta la combinazione lo sia.
-- ---------------------------------------------------------------------
create or replace function public.create_booking_request(
  p_service_ids uuid[],
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_preferred_date date,
  p_preferred_time_window text,
  p_preferred_staff_id uuid,
  p_notes text,
  p_privacy_accepted boolean,
  p_marketing_consent boolean default false,
  p_idempotency_key uuid default null
)
returns table (request_id uuid, code text, status text, notification_id uuid, services_label text, replayed boolean)
language plpgsql
volatile
set search_path = public
as $$
#variable_conflict use_column
declare
  b record;
  v_customer uuid;
  v_cfg public.business_settings%rowtype;
  v_today date := (now() at time zone public.app_tz())::date;
  v_req public.booking_requests%rowtype;
  v_notif uuid;
begin
  perform public.assert_backend_or_admin();
  perform set_config('app.actor', 'customer', true);

  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('request:' || p_idempotency_key::text, 0));
    select r.* into v_req from public.booking_requests r where r.idempotency_key = p_idempotency_key;
    if found then
      if public.request_service_ids(v_req.id) <> p_service_ids
         or (select phone_normalized from public.customers where id = v_req.customer_id)
            <> regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9+]', '', 'g') then
        raise exception using message = 'IDEMPOTENCY_CONFLICT', errcode = 'P0001';
      end if;
      return query select v_req.id, v_req.code, v_req.status,
        (select n.id from public.notifications n where n.dedupe_key = 'request_received:' || v_req.id),
        (select string_agg(s.name, ' + ' order by i.position) from public.booking_request_items i
           join public.services s on s.id = i.service_id where i.booking_request_id = v_req.id),
        true;
      return;
    end if;
  end if;

  if not coalesce(p_privacy_accepted, false) then
    raise exception using message = 'PRIVACY_REQUIRED', errcode = 'P0001';
  end if;
  select * into v_cfg from public.business_settings where id = 1;
  if not v_cfg.online_booking_enabled then
    raise exception using message = 'BOOKING_DISABLED', errcode = 'P0001';
  end if;
  select * into b from public.bundle_info(p_service_ids);
  if not b.valid then
    raise exception using message = b.error, errcode = 'P0001';
  end if;
  if b.all_automatic then
    raise exception using message = 'USE_AUTOMATIC_BOOKING', errcode = 'P0001';
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
    service_id, customer_id, preferred_staff_id, preferred_date, preferred_time_window, customer_notes,
    privacy_accepted_at, idempotency_key
  )
  values (
    p_service_ids[1], v_customer, p_preferred_staff_id, p_preferred_date, coalesce(p_preferred_time_window, 'indifferente'),
    nullif(btrim(coalesce(p_notes, '')), ''), now(), p_idempotency_key
  )
  returning * into v_req;

  insert into public.booking_request_items (booking_request_id, service_id, position)
  select v_req.id, u.id, u.ord from unnest(p_service_ids) with ordinality u(id, ord);

  if coalesce(p_marketing_consent, false) then
    perform public.record_marketing_consent(v_customer, 'richiesta online');
  end if;
  v_notif := public.enqueue_notification('request_received', 'customer', null, v_req.id, 'request_received:' || v_req.id);

  return query select v_req.id, v_req.code, v_req.status, v_notif, b.label, false;
end;
$$;

create or replace function public.request_service_ids(p_request_id uuid)
returns uuid[]
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select array_agg(service_id order by position) from public.booking_request_items where booking_request_id = p_request_id),
    (select array[service_id] from public.booking_requests where id = p_request_id));
$$;

-- ---------------------------------------------------------------------
-- ADMIN: approva richiesta (durata = intera combinazione)
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
  v_ids uuid[];
  b record;
  v_ends timestamptz;
  v_problem text;
  v_appt_id uuid;
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

  if v_req.reschedule_of_appointment_id is not null then
    select * into v_orig from public.appointments where id = v_req.reschedule_of_appointment_id for update;
    if not found or v_orig.status <> 'confirmed' then
      raise exception using message = 'APPOINTMENT_NOT_ACTIVE', errcode = 'P0001';
    end if;
    v_ids := public.appointment_service_ids(v_orig.id);
    if not public.staff_can_do_all(p_staff_id, v_ids) then
      raise exception using message = 'STAFF_NOT_ENABLED', errcode = 'P0001';
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
    v_ids := public.request_service_ids(v_req.id);
    select * into b from public.bundle_info(v_ids);
    if not b.valid then
      raise exception using message = case when b.error = 'SERVICE_NOT_BOOKABLE' then 'SERVICE_DURATION_MISSING' else b.error end, errcode = 'P0001';
    end if;
    if not public.staff_can_do_all(p_staff_id, v_ids) then
      raise exception using message = 'STAFF_NOT_ENABLED', errcode = 'P0001';
    end if;
    v_ends := p_starts_at + make_interval(mins => b.block_minutes);
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
        v_ids[1], p_staff_id, v_req.customer_id, v_req.id, p_starts_at, v_ends, 'confirmed', 'request',
        v_req.customer_notes, nullif(btrim(coalesce(p_internal_notes, '')), ''), v_req.privacy_accepted_at, auth.uid()
      )
      returning id into v_appt_id;
    exception when exclusion_violation then
      raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
    end;
    perform public.write_appointment_items(v_appt_id, v_ids);
    v_notif := public.enqueue_notification('request_approved', 'customer', v_appt_id, v_req.id,
      'request_approved:' || v_req.id || ':' || v_appt_id, jsonb_build_object('starts_at', p_starts_at));
  end if;

  update public.booking_requests
     set status = 'confirmed', handled_by = auth.uid(), handled_at = now(), proposed_starts_at = null, proposed_staff_id = null
   where id = v_req.id;

  return jsonb_build_object('appointment_id', v_appt_id, 'notification_ids', jsonb_build_array(v_notif));
end;
$$;

-- Proposta di nuova data: verifica con la durata dell'intera combinazione
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
  v_ids uuid[];
  v_minutes int;
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
  if v_req.reschedule_of_appointment_id is not null then
    v_ids := public.appointment_service_ids(v_req.reschedule_of_appointment_id);
    select (extract(epoch from (ends_at - starts_at)) / 60)::int into v_minutes from public.appointments where id = v_req.reschedule_of_appointment_id;
  else
    v_ids := public.request_service_ids(v_req.id);
    select block_minutes into v_minutes from public.bundle_info(v_ids) where valid;
  end if;
  if v_minutes is null then
    raise exception using message = 'SERVICE_DURATION_MISSING', errcode = 'P0001';
  end if;
  if not public.staff_can_do_all(p_staff_id, v_ids) then
    raise exception using message = 'STAFF_NOT_ENABLED', errcode = 'P0001';
  end if;
  v_problem := public.slot_problem(p_staff_id, p_starts_at, p_starts_at + make_interval(mins => v_minutes), true, v_req.reschedule_of_appointment_id);
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
-- ADMIN: inserimento manuale di appuntamenti (anche combinati)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_appointment(
  p_service_ids uuid[],
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text default null,
  p_internal_notes text default null,
  p_allow_outside_hours boolean default false,
  p_notify boolean default true,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  b record;
  v_ends timestamptz;
  v_problem text;
  v_customer uuid;
  v_id uuid;
  v_ids jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('admin-create:' || p_idempotency_key::text, 0));
    select id into v_id from public.appointments where idempotency_key = p_idempotency_key;
    if v_id is not null then
      return jsonb_build_object('appointment_id', v_id, 'notification_ids', '[]'::jsonb, 'replayed', true);
    end if;
  end if;

  select * into b from public.bundle_info(p_service_ids);
  if not b.valid then
    raise exception using message = case when b.error = 'SERVICE_NOT_BOOKABLE' then 'SERVICE_DURATION_MISSING' else b.error end, errcode = 'P0001';
  end if;
  if not public.staff_can_do_all(p_staff_id, p_service_ids) then
    raise exception using message = 'STAFF_NOT_ENABLED', errcode = 'P0001';
  end if;
  v_ends := p_starts_at + make_interval(mins => b.block_minutes);
  v_problem := public.slot_problem(p_staff_id, p_starts_at, v_ends, not coalesce(p_allow_outside_hours, false));
  if v_problem is not null then
    raise exception using message = v_problem, errcode = 'P0001';
  end if;

  v_customer := public.upsert_customer(p_first_name, p_last_name, p_phone, p_email);
  begin
    insert into public.appointments (service_id, staff_id, customer_id, starts_at, ends_at, status, source, internal_notes, created_by, idempotency_key)
    values (p_service_ids[1], p_staff_id, v_customer, p_starts_at, v_ends, 'confirmed', 'admin',
            nullif(btrim(coalesce(p_internal_notes, '')), ''), auth.uid(), p_idempotency_key)
    returning id into v_id;
  exception when exclusion_violation then
    raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
  end;
  perform public.write_appointment_items(v_id, p_service_ids);

  if p_notify then
    v_ids := jsonb_build_array(public.enqueue_notification('booking_confirmed', 'customer', v_id, null,
      'booking_confirmed:' || v_id, jsonb_build_object('starts_at', p_starts_at)));
  end if;
  return jsonb_build_object('appointment_id', v_id, 'notification_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: modifica appuntamento (servizi, operatore, orario) in un'unica
-- transazione; la disponibilità è verificata escludendo l'appuntamento stesso.
-- ---------------------------------------------------------------------
create or replace function public.admin_update_appointment(
  p_appointment_id uuid,
  p_service_ids uuid[],
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
  b record;
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
  select * into b from public.bundle_info(p_service_ids);
  if not b.valid then
    raise exception using message = case when b.error = 'SERVICE_NOT_BOOKABLE' then 'SERVICE_DURATION_MISSING' else b.error end, errcode = 'P0001';
  end if;
  if not public.staff_can_do_all(p_staff_id, p_service_ids) then
    raise exception using message = 'STAFF_NOT_ENABLED', errcode = 'P0001';
  end if;
  v_ends := p_starts_at + make_interval(mins => b.block_minutes);
  v_problem := public.slot_problem(p_staff_id, p_starts_at, v_ends, not coalesce(p_allow_outside_hours, false), v_a.id);
  if v_problem is not null then
    raise exception using message = v_problem, errcode = 'P0001';
  end if;
  begin
    update public.appointments
       set staff_id = p_staff_id, starts_at = p_starts_at, ends_at = v_ends,
           rescheduled_at = case when starts_at <> p_starts_at then now() else rescheduled_at end
     where id = v_a.id;
  exception when exclusion_violation then
    raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
  end;
  perform public.write_appointment_items(v_a.id, p_service_ids);
  if v_a.starts_at <> p_starts_at then
    perform public.revoke_appointment_tokens(v_a.id);
    if p_notify then
      v_ids := jsonb_build_array(public.enqueue_notification('appointment_rescheduled', 'customer', v_a.id, null,
        'appointment_rescheduled:' || v_a.id || ':' || extract(epoch from p_starts_at)::bigint,
        jsonb_build_object('starts_at', p_starts_at, 'previous_starts_at', v_a.starts_at)));
    end if;
  end if;
  return jsonb_build_object('appointment_id', v_a.id, 'notification_ids', v_ids);
end;
$$;

-- Spostamento semplice (compatibilità v0.2): stessi servizi, con controllo abilitazione operatore
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
  if not public.staff_can_do_all(p_staff_id, public.appointment_service_ids(v_a.id)) then
    raise exception using message = 'STAFF_NOT_ENABLED', errcode = 'P0001';
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
-- ADMIN: spazi liberi del giorno e cosa potrebbe riempirli
-- (solo suggerimenti: non sposta nulla e non modifica le preferenze dei clienti)
-- ---------------------------------------------------------------------
create or replace function public.staff_free_gaps(p_date date, p_min_minutes int default 15)
returns table (staff_id uuid, gap_start timestamptz, gap_end timestamptz, minutes int)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  sh record;
  blk record;
  v_cursor timestamptz;
  v_from timestamptz := (p_date::timestamp) at time zone public.app_tz();
  v_to timestamptz := ((p_date + 1)::timestamp) at time zone public.app_tz();
begin
  perform public.assert_backend_or_admin();
  for sh in
    select d.staff_id, d.shift_start, d.shift_end
      from public.day_shifts(p_date) d
      join public.staff s on s.id = d.staff_id and s.active
     order by d.staff_id, d.shift_start
  loop
    -- per oggi si parte da "adesso", arrotondato all'intervallo degli slot
    v_cursor := sh.shift_start;
    if now() > sh.shift_start then
      v_cursor := sh.shift_start + make_interval(mins => (ceil(extract(epoch from (now() - sh.shift_start)) / 60
                    / (select slot_interval_minutes from public.business_settings where id = 1))
                    * (select slot_interval_minutes from public.business_settings where id = 1))::int);
    end if;
    for blk in
      select bs, be from (
        select a.starts_at as bs, a.ends_at as be from public.appointments a
         where a.staff_id = sh.staff_id and a.status <> 'cancelled' and a.starts_at < v_to and a.ends_at > v_from
        union all
        select t.starts_at, t.ends_at from public.time_off t
         where (t.staff_id is null or t.staff_id = sh.staff_id) and t.starts_at < v_to and t.ends_at > v_from
      ) x
      where x.be > sh.shift_start and x.bs < sh.shift_end
      order by bs
    loop
      if blk.bs > v_cursor and extract(epoch from (least(blk.bs, sh.shift_end) - v_cursor)) / 60 >= p_min_minutes then
        return query select sh.staff_id, v_cursor, least(blk.bs, sh.shift_end), (extract(epoch from (least(blk.bs, sh.shift_end) - v_cursor)) / 60)::int;
      end if;
      v_cursor := greatest(v_cursor, blk.be);
    end loop;
    if sh.shift_end > v_cursor and extract(epoch from (sh.shift_end - v_cursor)) / 60 >= p_min_minutes then
      return query select sh.staff_id, v_cursor, sh.shift_end, (extract(epoch from (sh.shift_end - v_cursor)) / 60)::int;
    end if;
  end loop;
end;
$$;

create or replace function public.admin_gap_suggestions(p_date date)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_cfg public.business_settings%rowtype;
begin
  if not public.is_admin() then
    raise exception using message = 'FORBIDDEN', errcode = '42501';
  end if;
  select * into v_cfg from public.business_settings where id = 1;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'staff_id', g.staff_id,
      'staff_name', st.display_name,
      'gap_start', g.gap_start,
      'gap_end', g.gap_end,
      'minutes', g.minutes,
      -- servizi singoli che l'operatore può svolgere e che entrano nello spazio (prima chi lo riempie meglio)
      'services', coalesce((
        select jsonb_agg(x order by x.waste, x.name) from (
          select s.id, s.name, s.duration_minutes + s.buffer_after_minutes + v_cfg.booking_buffer_minutes as block,
                 g.minutes - (s.duration_minutes + s.buffer_after_minutes + v_cfg.booking_buffer_minutes) as waste
            from public.services s
            join public.staff_services ss on ss.service_id = s.id and ss.staff_id = g.staff_id
           where s.active and s.duration_minutes is not null and s.category = 'hair'
             and s.duration_minutes + s.buffer_after_minutes + v_cfg.booking_buffer_minutes <= g.minutes
           order by g.minutes - (s.duration_minutes + s.buffer_after_minutes + v_cfg.booking_buffer_minutes), s.name
           limit 3) x), '[]'::jsonb),
      -- richieste in attesa compatibili (giorno preferito libero o uguale)
      'requests', coalesce((
        select jsonb_agg(y) from (
          select r.id, r.code, c.full_name as customer_name, bi.label, bi.block_minutes as block
            from public.booking_requests r
            join public.customers c on c.id = r.customer_id
            cross join lateral public.bundle_info(public.request_service_ids(r.id)) bi
           where r.status in ('pending', 'reschedule') and r.reschedule_of_appointment_id is null
             and (r.preferred_date is null or r.preferred_date = p_date)
             and (r.preferred_staff_id is null or r.preferred_staff_id = g.staff_id)
             and bi.valid and bi.block_minutes <= g.minutes
             and g.staff_id = any (bi.eligible_staff)
           order by g.minutes - bi.block_minutes, r.created_at
           limit 3) y), '[]'::jsonb)
    ) order by g.gap_start, st.sort_order)
    from public.staff_free_gaps(p_date, 15) g
    join public.staff st on st.id = g.staff_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- LINK CLIENTE con servizi multipli
-- ---------------------------------------------------------------------
create or replace function public.customer_get_appointment(p_token_hash text)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_a public.appointments%rowtype;
  v_cfg public.business_settings%rowtype;
  v_deadline timestamptz;
  v_ids uuid[];
  v_cons boolean;
  v_auto boolean;
begin
  v_a := public.resolve_manage_token(p_token_hash, false);
  select * into v_cfg from public.business_settings where id = 1;
  v_ids := public.appointment_service_ids(v_a.id);
  select coalesce(bool_or(s.category = 'consultation'), false),
         coalesce(bool_and(s.booking_mode = 'automatic' and s.active), false)
    into v_cons, v_auto
    from public.services s where s.id = any (v_ids);
  v_deadline := v_a.starts_at - make_interval(hours => v_cfg.customer_change_min_hours);
  return jsonb_build_object(
    'code', v_a.code,
    'service_ids', to_jsonb(v_ids),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'duration_minutes', i.duration_minutes,
                         'price_cents', i.price_cents, 'price_from', i.price_from) order by i.position)
                         from public.appointment_items i where i.appointment_id = v_a.id), '[]'::jsonb),
    'service_name', (select string_agg(i.name, ' + ' order by i.position) from public.appointment_items i where i.appointment_id = v_a.id),
    'duration_minutes', (select sum(i.duration_minutes)::int from public.appointment_items i where i.appointment_id = v_a.id),
    'total_price_cents', v_a.total_price_cents,
    'price_is_estimate', v_a.price_is_estimate,
    'category', case when v_cons then 'consultation' else 'hair' end,
    'self_reschedule', not v_cons and v_auto and v_cfg.online_booking_enabled,
    'starts_at', v_a.starts_at,
    'ends_at', v_a.ends_at,
    'staff_name', (select display_name from public.staff where id = v_a.staff_id),
    'first_name', (select first_name from public.customers where id = v_a.customer_id),
    'status', v_a.status,
    'can_change', now() <= v_deadline,
    'change_deadline', v_deadline,
    'pending_reschedule_request', exists (
      select 1 from public.booking_requests r
       where r.reschedule_of_appointment_id = v_a.id and r.status in ('pending', 'reschedule'))
  );
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
  v_ids uuid[];
  b record;
  v_candidate record;
  v_out jsonb;
begin
  perform set_config('app.actor', 'customer', true);
  v_a := public.resolve_manage_token(p_token_hash, true);
  select * into v_cfg from public.business_settings where id = 1;
  if now() > v_a.starts_at - make_interval(hours => v_cfg.customer_change_min_hours) then
    raise exception using message = 'CHANGE_DEADLINE_PASSED', errcode = 'P0001';
  end if;
  v_ids := public.appointment_service_ids(v_a.id);
  select * into b from public.bundle_info(v_ids);
  if not (b.valid and b.all_automatic and not b.is_consultation and v_cfg.online_booking_enabled) then
    raise exception using message = 'SELF_RESCHEDULE_NOT_ALLOWED', errcode = 'P0001';
  end if;
  if p_new_starts_at = v_a.starts_at then
    raise exception using message = 'SAME_TIME', errcode = 'P0001';
  end if;

  -- Disponibilità calcolata escludendo l'appuntamento stesso (si può anche "scorrere" di poco)
  for v_candidate in
    select s.staff_id, s.starts_at, s.ends_at
      from public.get_bundle_slots(v_ids, (p_new_starts_at at time zone public.app_tz())::date, p_staff_id, true, v_a.id) s
     where s.starts_at = p_new_starts_at
     order by (s.staff_id = v_a.staff_id) desc, s.fit_rank
  loop
    begin
      update public.appointments
         set staff_id = v_candidate.staff_id, starts_at = v_candidate.starts_at, ends_at = v_candidate.ends_at,
             rescheduled_at = now()
       where id = v_a.id;
      update public.appointment_tokens set used_at = now() where token_hash = p_token_hash;
      perform public.revoke_appointment_tokens(v_a.id);
      v_out := jsonb_build_object(
        'starts_at', v_candidate.starts_at,
        'notification_ids', jsonb_build_array(
          public.enqueue_notification('appointment_rescheduled', 'customer', v_a.id, null,
            'appointment_rescheduled:' || v_a.id || ':' || extract(epoch from v_candidate.starts_at)::bigint,
            jsonb_build_object('starts_at', v_candidate.starts_at, 'previous_starts_at', v_a.starts_at, 'by', 'customer')),
          public.enqueue_notification('salon_customer_change', 'salon', v_a.id, null,
            'salon_reschedule:' || v_a.id || ':' || extract(epoch from v_candidate.starts_at)::bigint,
            jsonb_build_object('action', 'reschedule', 'previous_starts_at', v_a.starts_at, 'starts_at', v_candidate.starts_at))));
      return v_out;
    exception when exclusion_violation then
      null;
    end;
  end loop;
  raise exception using message = 'SLOT_UNAVAILABLE', errcode = 'P0001';
end;
$$;

-- Richiesta di spostamento: copia tutti i servizi dell'appuntamento combinato
create or replace function public.copy_reschedule_request_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reschedule_of_appointment_id is not null then
    insert into public.booking_request_items (booking_request_id, service_id, position)
    select new.id, i.service_id, i.position from public.appointment_items i
     where i.appointment_id = new.reschedule_of_appointment_id
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger trg_booking_requests_copy_items
  after insert on public.booking_requests
  for each row execute function public.copy_reschedule_request_items();

-- Orari per lo spostamento dal link cliente (escludono l'appuntamento stesso)
create or replace function public.customer_reschedule_slots(p_token_hash text, p_date date)
returns table (staff_id uuid, staff_name text, starts_at timestamptz, ends_at timestamptz, fit_rank int)
language plpgsql
volatile
set search_path = public
as $$
#variable_conflict use_column
declare v_a public.appointments%rowtype;
begin
  v_a := public.resolve_manage_token(p_token_hash, false);
  return query
    select s.staff_id, s.staff_name, s.starts_at, s.ends_at, s.fit_rank
      from public.get_bundle_slots(public.appointment_service_ids(v_a.id), p_date, null, true, v_a.id) s
     where s.starts_at <> v_a.starts_at;
end;
$$;

-- ---------------------------------------------------------------------
-- Contesto email: etichetta con tutti i servizi e prezzo indicativo
-- ---------------------------------------------------------------------
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
             'service_name', coalesce((select string_agg(i.name, ' + ' order by i.position) from public.appointment_items i where i.appointment_id = a.id), s.name),
             'category', case when exists (select 1 from public.appointment_items i join public.services s2 on s2.id = i.service_id
                                            where i.appointment_id = a.id and s2.category = 'consultation')
                                   or s.category = 'consultation' then 'consultation' else 'hair' end,
             'booking_mode', s.booking_mode,
             'staff_name', st.display_name,
             'total_price_cents', a.total_price_cents,
             'price_is_estimate', a.price_is_estimate),
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
             'id', r.id, 'code', r.code, 'status', r.status,
             'service_name', coalesce((select string_agg(s2.name, ' + ' order by i.position) from public.booking_request_items i
                                        join public.services s2 on s2.id = i.service_id where i.booking_request_id = r.id), s.name),
             'category', s.category,
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
    'id', v_n.id, 'kind', v_n.kind, 'audience', v_n.audience, 'channel', v_n.channel, 'data', v_n.data,
    'attempts', v_n.attempts, 'max_attempts', v_n.max_attempts,
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
      'email_instructions', v_cfg.email_instructions, 'customer_change_min_hours', v_cfg.customer_change_min_hours,
      'whatsapp_number', v_cfg.whatsapp_number)
  );
end;
$$;

-- Le email vengono prelevate solo dal canale email (WhatsApp Business non attivo)
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
     where channel = 'email'
       and ((status = 'pending' and next_attempt_at <= now())
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

-- Ricerca appuntamenti: include i nomi di tutti i servizi
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
         coalesce((select string_agg(i.name, ' + ' order by i.position) from public.appointment_items i where i.appointment_id = a.id), s.name),
         st.display_name, c.full_name, c.phone, c.email
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
-- Permessi
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.bundle_info(uuid[])',
    'public.day_shifts(date)',
    'public.get_bundle_slots(uuid[], date, uuid, boolean, uuid)',
    'public.get_available_slots(uuid, date, uuid, boolean)',
    'public.write_appointment_items(uuid, uuid[])',
    'public.staff_can_do_all(uuid, uuid[])',
    'public.appointment_service_ids(uuid)',
    'public.request_service_ids(uuid)',
    'public.record_marketing_consent(uuid, text)',
    'public.book_appointment(uuid[], uuid, timestamptz, text, text, text, text, text, boolean, boolean, uuid)',
    'public.create_booking_request(uuid[], text, text, text, text, date, text, uuid, text, boolean, boolean, uuid)',
    'public.admin_create_appointment(uuid[], uuid, timestamptz, text, text, text, text, text, boolean, boolean, uuid)',
    'public.admin_update_appointment(uuid, uuid[], uuid, timestamptz, boolean, boolean)',
    'public.staff_free_gaps(date, int)',
    'public.admin_gap_suggestions(date)',
    'public.services_default_group()',
    'public.customer_reschedule_slots(text, date)',
    'public.copy_reschedule_request_items()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function public.bundle_info(uuid[]) to authenticated, service_role;
grant execute on function public.day_shifts(date) to authenticated, service_role;
grant execute on function public.get_bundle_slots(uuid[], date, uuid, boolean, uuid) to authenticated, service_role;
grant execute on function public.get_available_slots(uuid, date, uuid, boolean) to authenticated, service_role;
grant execute on function public.write_appointment_items(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.staff_can_do_all(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.appointment_service_ids(uuid) to authenticated, service_role;
grant execute on function public.request_service_ids(uuid) to authenticated, service_role;
grant execute on function public.record_marketing_consent(uuid, text) to authenticated, service_role;
grant execute on function public.staff_free_gaps(date, int) to authenticated, service_role;
grant execute on function public.services_default_group() to authenticated, service_role;

grant execute on function public.customer_reschedule_slots(text, date) to service_role;
grant execute on function public.copy_reschedule_request_items() to authenticated, service_role;
grant execute on function public.book_appointment(uuid[], uuid, timestamptz, text, text, text, text, text, boolean, boolean, uuid) to service_role;
grant execute on function public.create_booking_request(uuid[], text, text, text, text, date, text, uuid, text, boolean, boolean, uuid) to service_role;

grant execute on function public.admin_create_appointment(uuid[], uuid, timestamptz, text, text, text, text, text, boolean, boolean, uuid) to authenticated;
grant execute on function public.admin_update_appointment(uuid, uuid[], uuid, timestamptz, boolean, boolean) to authenticated;
grant execute on function public.admin_gap_suggestions(date) to authenticated;
