-- =====================================================================
-- Maylana Booking v3 — Migrazione incrementale: schema
--  * categorie cliente dei servizi (Uomo, Donna, Trattamenti, Acconciature, Consulenze)
--  * tempi di preparazione per servizio e tempo aggiuntivo globale
--  * orari di apertura del salone (oltre ai turni degli operatori)
--  * servizi multipli: appointment_items e booking_request_items
--  * prezzo totale indicativo sull'appuntamento
--  * chiavi di idempotenza (doppio clic / richiesta ripetuta)
--  * consenso marketing separato e facoltativo
--  * impostazioni orari consigliati e WhatsApp del salone
-- Compatibile con i dati esistenti: ogni appuntamento/richiesta esistente
-- riceve un elemento con il proprio servizio.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Servizi: categoria per il cliente e tempo di preparazione
-- ---------------------------------------------------------------------
alter table public.services
  add column public_group text,
  add column buffer_after_minutes int not null default 0 check (buffer_after_minutes between 0 and 120);

update public.services set public_group = case
  when category = 'consultation' then 'consulenze'
  when name ilike '%uomo%' then 'uomo'
  when name ilike '%trattament%' then 'trattamenti'
  when name ilike '%acconciat%' then 'acconciature'
  else 'donna' end;

-- Compatibilità: inserimenti che non indicano la categoria cliente la ricevono automaticamente
create or replace function public.services_default_group()
returns trigger
language plpgsql
as $$
begin
  if new.public_group is null then
    new.public_group := case
      when new.category = 'consultation' then 'consulenze'
      when new.name ilike '%uomo%' then 'uomo'
      when new.name ilike '%trattament%' then 'trattamenti'
      when new.name ilike '%acconciat%' then 'acconciature'
      else 'donna' end;
  end if;
  return new;
end;
$$;

create trigger trg_services_default_group
  before insert or update on public.services
  for each row execute function public.services_default_group();

alter table public.services
  alter column public_group set not null,
  add constraint services_public_group_check check (public_group in ('uomo', 'donna', 'trattamenti', 'acconciature', 'consulenze')),
  add constraint services_group_matches_category check ((category = 'consultation') = (public_group = 'consulenze'));

-- ---------------------------------------------------------------------
-- Impostazioni
-- ---------------------------------------------------------------------
alter table public.business_settings
  add column booking_buffer_minutes int not null default 0 check (booking_buffer_minutes between 0 and 60),
  add column smart_slots_enabled boolean not null default true,
  add column min_useful_gap_minutes int not null default 30 check (min_useful_gap_minutes between 5 and 240),
  add column max_recommended_slots int not null default 3 check (max_recommended_slots between 0 and 12),
  add column whatsapp_number text check (whatsapp_number is null or whatsapp_number ~ '^\+?[0-9 ]{6,20}$');

-- ---------------------------------------------------------------------
-- Orari di apertura del salone (ora locale Europe/Rome).
-- Se la tabella è vuota valgono solo i turni degli operatori (come v0.2).
-- Se contiene righe, un giorno senza righe è un giorno di chiusura.
-- ---------------------------------------------------------------------
create table public.opening_hours (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  constraint opening_hours_order check (end_time > start_time),
  constraint opening_hours_no_overlap exclude using gist (
    weekday with =,
    tsrange(date '2000-01-03' + start_time, date '2000-01-03' + end_time, '[)') with &&
  )
);

-- ---------------------------------------------------------------------
-- Servizi dell'appuntamento (snapshot di nome, durata e prezzo)
-- ---------------------------------------------------------------------
create table public.appointment_items (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete restrict,
  position smallint not null check (position between 1 and 10),
  name text not null,
  duration_minutes int not null check (duration_minutes between 5 and 600),
  buffer_minutes int not null default 0 check (buffer_minutes between 0 and 120),
  price_cents int check (price_cents is null or price_cents >= 0),
  price_from boolean not null default false,
  created_at timestamptz not null default now(),
  constraint appointment_items_position_unique unique (appointment_id, position)
);
create index appointment_items_service_idx on public.appointment_items (service_id);

create table public.booking_request_items (
  id uuid primary key default gen_random_uuid(),
  booking_request_id uuid not null references public.booking_requests (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete restrict,
  position smallint not null check (position between 1 and 10),
  constraint booking_request_items_position_unique unique (booking_request_id, position)
);

alter table public.appointments
  add column total_price_cents int check (total_price_cents is null or total_price_cents >= 0),
  add column price_is_estimate boolean not null default true,
  add column idempotency_key uuid unique;

alter table public.booking_requests
  add column idempotency_key uuid unique;

-- Dati esistenti: un elemento per appuntamento/richiesta
insert into public.appointment_items (appointment_id, service_id, position, name, duration_minutes, buffer_minutes, price_cents, price_from)
select a.id, a.service_id, 1, s.name,
       greatest(5, least(600, (extract(epoch from (a.ends_at - a.starts_at)) / 60)::int)),
       0, s.price_cents, s.price_from
  from public.appointments a
  join public.services s on s.id = a.service_id;

update public.appointments a
   set total_price_cents = s.price_cents,
       price_is_estimate = s.price_from or s.price_cents is null
  from public.services s
 where s.id = a.service_id;

insert into public.booking_request_items (booking_request_id, service_id, position)
select id, service_id, 1 from public.booking_requests;

-- ---------------------------------------------------------------------
-- Consenso marketing: separato, facoltativo, mai dedotto
-- ---------------------------------------------------------------------
alter table public.customers
  add column marketing_consent boolean not null default false,
  add column marketing_consent_at timestamptz,
  add column marketing_consent_source text check (marketing_consent_source is null or length(marketing_consent_source) <= 40);

-- ---------------------------------------------------------------------
-- Notifiche: canale (oggi solo email; WhatsApp Business predisposto, non attivo)
-- ---------------------------------------------------------------------
alter table public.notifications
  add column channel text not null default 'email' check (channel in ('email', 'whatsapp'));

-- ---------------------------------------------------------------------
-- Audit delle nuove tabelle
-- ---------------------------------------------------------------------
create trigger trg_audit_opening_hours after insert or update or delete on public.opening_hours
  for each row execute function public.audit_row();
create trigger trg_audit_appointment_items after insert or update or delete on public.appointment_items
  for each row execute function public.audit_row();
