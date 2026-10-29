-- =====================================================================
-- Maylana Coiffeur Booking — Schema iniziale
-- Fuso orario di riferimento: Europe/Rome (gestione ora legale via
-- PostgreSQL: le conversioni usano "AT TIME ZONE 'Europe/Rome'").
-- Tutti gli istanti sono salvati come timestamptz (UTC).
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- Utilità
-- ---------------------------------------------------------------------

create or replace function public.app_tz()
returns text
language sql
immutable
as $$ select 'Europe/Rome'::text $$;

-- Codice appuntamento leggibile (senza caratteri ambigui: 0/O, 1/I).
create or replace function public.gen_booking_code(prefix text default 'MY')
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 simboli
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  result text := '';
begin
  for i in 0..5 loop
    result := result || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return prefix || '-' || result;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Impostazioni del salone (riga unica, tutto configurabile da admin)
-- Nessun recapito/orario/prezzo reale è precompilato.
-- ---------------------------------------------------------------------

create table public.business_settings (
  id smallint primary key default 1 check (id = 1),
  business_name text not null default 'Maylana Coiffeur',
  logo_url text,
  contact_phone text,
  contact_email text,
  address text,
  privacy_url text,
  public_notice text check (public_notice is null or length(public_notice) <= 500),
  slot_interval_minutes int not null default 15 check (slot_interval_minutes between 5 and 120),
  min_notice_minutes int not null default 120 check (min_notice_minutes between 0 and 10080),
  booking_horizon_days int not null default 60 check (booking_horizon_days between 1 and 365),
  online_booking_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.business_settings (id) values (1);

create trigger trg_business_settings_updated
  before update on public.business_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Servizi
--   category: 'hair' (parrucchiere) | 'consultation' (Capelli For You)
--   booking_mode: 'automatic' (slot confermato subito) | 'manual' (richiesta)
--   price_cents NULL = prezzo non pubblicato ("prezzo in salone")
--   duration_minutes NULL ammesso solo per servizi disattivi
-- ---------------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('hair', 'consultation')),
  name text not null check (length(btrim(name)) between 2 and 120),
  description text check (description is null or length(description) <= 1000),
  price_cents int check (price_cents is null or price_cents >= 0),
  price_from boolean not null default false,
  duration_minutes int check (duration_minutes is null or duration_minutes between 5 and 600),
  booking_mode text not null default 'automatic' check (booking_mode in ('automatic', 'manual')),
  active boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint services_active_requires_duration check (not active or duration_minutes is not null),
  constraint services_consultation_is_manual check (category <> 'consultation' or booking_mode = 'manual')
);

create trigger trg_services_updated
  before update on public.services
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Operatori
-- ---------------------------------------------------------------------

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  bio text check (bio is null or length(bio) <= 500),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_staff_updated
  before update on public.staff
  for each row execute function public.touch_updated_at();

create table public.staff_services (
  staff_id uuid not null references public.staff (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  primary key (staff_id, service_id)
);

create index staff_services_service_idx on public.staff_services (service_id);

-- ---------------------------------------------------------------------
-- Orari di lavoro per operatore (più fasce per giorno = pausa pranzo)
-- weekday ISO: 1 = lunedì … 7 = domenica. Orari in ora locale Europe/Rome.
-- ---------------------------------------------------------------------

create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  constraint working_hours_order check (end_time > start_time),
  constraint working_hours_no_overlap exclude using gist (
    staff_id with =,
    weekday with =,
    tsrange(date '2000-01-03' + start_time, date '2000-01-03' + end_time, '[)') with &&
  )
);

-- ---------------------------------------------------------------------
-- Assenze, ferie, pause, chiusure (staff_id NULL = tutto il salone)
-- ---------------------------------------------------------------------

create table public.time_off (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references public.staff (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null default 'altro' check (kind in ('ferie', 'pausa', 'chiusura', 'permesso', 'altro')),
  reason text check (reason is null or length(reason) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint time_off_order check (ends_at > starts_at)
);

create index time_off_range_idx on public.time_off using gist (tstzrange(starts_at, ends_at, '[)'));

-- ---------------------------------------------------------------------
-- Clienti (dati personali: MAI accessibili pubblicamente)
-- ---------------------------------------------------------------------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  phone text not null check (length(phone) <= 40),
  phone_normalized text not null check (phone_normalized ~ '^\+?[0-9]{6,20}$'),
  email text check (email is null or length(email) <= 200),
  email_normalized text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_identity_unique unique (phone_normalized, email_normalized)
);

create index customers_name_idx on public.customers (lower(full_name));

create trigger trg_customers_updated
  before update on public.customers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Richieste soggette ad approvazione manuale (consulenze Capelli For You
-- e servizi parrucchiere impostati in modalità "manuale").
-- Una richiesta in attesa NON blocca alcuno slot.
-- ---------------------------------------------------------------------

create table public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default public.gen_booking_code('RQ'),
  service_id uuid not null references public.services (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  preferred_staff_id uuid references public.staff (id) on delete set null,
  preferred_date date,
  preferred_time_window text not null default 'indifferente'
    check (preferred_time_window in ('mattina', 'pomeriggio', 'indifferente')),
  customer_notes text check (customer_notes is null or length(customer_notes) <= 500),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'rejected', 'reschedule', 'cancelled')),
  admin_notes text check (admin_notes is null or length(admin_notes) <= 1000),
  privacy_accepted_at timestamptz not null,
  handled_by uuid references auth.users (id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index booking_requests_status_idx on public.booking_requests (status, created_at desc);

create trigger trg_booking_requests_updated
  before update on public.booking_requests
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Appuntamenti
-- Vincolo di esclusione: nessuna sovrapposizione per lo stesso operatore
-- tra appuntamenti non annullati. È la garanzia finale anche in caso di
-- prenotazioni concorrenti.
-- ---------------------------------------------------------------------

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default public.gen_booking_code('MY'),
  service_id uuid not null references public.services (id) on delete restrict,
  staff_id uuid not null references public.staff (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  booking_request_id uuid unique references public.booking_requests (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed'
    check (status in ('confirmed', 'completed', 'no_show', 'cancelled')),
  source text not null check (source in ('online', 'admin', 'request')),
  customer_notes text check (customer_notes is null or length(customer_notes) <= 500),
  internal_notes text check (internal_notes is null or length(internal_notes) <= 1000),
  privacy_accepted_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_time_order check (ends_at > starts_at),
  constraint appointments_no_overlap exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status <> 'cancelled')
);

create index appointments_starts_idx on public.appointments (starts_at);
create index appointments_customer_idx on public.appointments (customer_id);

create trigger trg_appointments_updated
  before update on public.appointments
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Amministratori (collegati a Supabase Auth)
--   owner: gestisce anche servizi, prezzi, operatori, orari, impostazioni
--   staff: agenda, richieste, chiusure, clienti
-- ---------------------------------------------------------------------

create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'staff' check (role in ('owner', 'staff')),
  display_name text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Rate limiting persistente (finestre fisse, chiave = hash IP + endpoint)
-- ---------------------------------------------------------------------

create table public.api_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 1,
  primary key (bucket, window_start)
);
