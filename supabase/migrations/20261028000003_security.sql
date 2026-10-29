-- =====================================================================
-- Maylana Coiffeur Booking — Row Level Security e permessi
--
-- Principi:
--  * Il ruolo "anon" (browser non autenticato) NON ha accesso ad alcuna
--    tabella né funzione: la pagina pubblica passa dalle Netlify Functions,
--    che usano la service role key lato server.
--  * Gli utenti autenticati accedono solo se presenti in admin_users.
--  * owner: configurazione (servizi, prezzi, operatori, orari, impostazioni)
--    staff: agenda, richieste, clienti, chiusure.
-- =====================================================================

-- RLS attiva ovunque
alter table public.business_settings enable row level security;
alter table public.services          enable row level security;
alter table public.staff             enable row level security;
alter table public.staff_services    enable row level security;
alter table public.working_hours     enable row level security;
alter table public.time_off          enable row level security;
alter table public.customers         enable row level security;
alter table public.booking_requests  enable row level security;
alter table public.appointments      enable row level security;
alter table public.admin_users       enable row level security;
alter table public.api_rate_limits   enable row level security;

-- Nessun privilegio diretto per anon (difesa in profondità oltre alla RLS)
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on table public.api_rate_limits from authenticated;
revoke all on table public.admin_users from authenticated;
grant select on table public.admin_users to authenticated;

-- ---------------------------------------------------------------------
-- Configurazione: lettura admin, scrittura owner
-- ---------------------------------------------------------------------

create policy settings_select on public.business_settings
  for select to authenticated using (public.is_admin());
create policy settings_update on public.business_settings
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

create policy services_select on public.services
  for select to authenticated using (public.is_admin());
create policy services_insert on public.services
  for insert to authenticated with check (public.is_owner());
create policy services_update on public.services
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy services_delete on public.services
  for delete to authenticated using (public.is_owner());

create policy staff_select on public.staff
  for select to authenticated using (public.is_admin());
create policy staff_insert on public.staff
  for insert to authenticated with check (public.is_owner());
create policy staff_update on public.staff
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy staff_delete on public.staff
  for delete to authenticated using (public.is_owner());

create policy staff_services_select on public.staff_services
  for select to authenticated using (public.is_admin());
create policy staff_services_insert on public.staff_services
  for insert to authenticated with check (public.is_owner());
create policy staff_services_delete on public.staff_services
  for delete to authenticated using (public.is_owner());

create policy working_hours_select on public.working_hours
  for select to authenticated using (public.is_admin());
create policy working_hours_insert on public.working_hours
  for insert to authenticated with check (public.is_owner());
create policy working_hours_update on public.working_hours
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy working_hours_delete on public.working_hours
  for delete to authenticated using (public.is_owner());

-- ---------------------------------------------------------------------
-- Operatività: tutti gli admin; cancellazioni definitive solo owner
-- ---------------------------------------------------------------------

create policy time_off_select on public.time_off
  for select to authenticated using (public.is_admin());
create policy time_off_insert on public.time_off
  for insert to authenticated with check (public.is_admin());
create policy time_off_update on public.time_off
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy time_off_delete on public.time_off
  for delete to authenticated using (public.is_admin());

create policy customers_select on public.customers
  for select to authenticated using (public.is_admin());
create policy customers_insert on public.customers
  for insert to authenticated with check (public.is_admin());
create policy customers_update on public.customers
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy customers_delete on public.customers
  for delete to authenticated using (public.is_owner());

create policy requests_select on public.booking_requests
  for select to authenticated using (public.is_admin());
create policy requests_update on public.booking_requests
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy requests_delete on public.booking_requests
  for delete to authenticated using (public.is_owner());
-- Inserimento richieste solo tramite funzione backend (service role).

create policy appointments_select on public.appointments
  for select to authenticated using (public.is_admin());
create policy appointments_insert on public.appointments
  for insert to authenticated with check (public.is_admin());
create policy appointments_update on public.appointments
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy appointments_delete on public.appointments
  for delete to authenticated using (public.is_owner());

-- admin_users: ognuno vede il proprio ruolo, l'owner vede tutti.
-- Inserimenti/modifiche solo da SQL Editor (service role).
create policy admin_users_select on public.admin_users
  for select to authenticated using (user_id = auth.uid() or public.is_owner());

-- api_rate_limits: nessuna policy → accessibile solo dalla service role.

-- ---------------------------------------------------------------------
-- Funzioni: revoca a public/anon, concessione mirata
-- ---------------------------------------------------------------------

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;

-- funzioni usate dentro policy / trigger / default
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_owner() to authenticated, service_role;
grant execute on function public.app_tz() to authenticated, service_role;
grant execute on function public.gen_booking_code(text) to authenticated, service_role;
grant execute on function public.touch_updated_at() to authenticated, service_role;
grant execute on function public.assert_backend_or_admin() to authenticated, service_role;
grant execute on function public.slot_problem(uuid, timestamptz, timestamptz, boolean, uuid) to authenticated, service_role;
grant execute on function public.upsert_customer(text, text, text) to authenticated, service_role;
grant execute on function public.get_available_slots(uuid, date, uuid, boolean) to authenticated, service_role;

-- backend pubblico (Netlify Functions con service role)
grant execute on function public.book_appointment(uuid, uuid, timestamptz, text, text, text, text, boolean) to service_role;
grant execute on function public.create_booking_request(uuid, text, text, text, date, text, uuid, text, boolean) to service_role;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

-- area amministrativa (verifica is_admin() interna)
grant execute on function public.admin_confirm_request(uuid, uuid, timestamptz, text, boolean) to authenticated;
grant execute on function public.admin_set_request_status(uuid, text, text) to authenticated;
grant execute on function public.admin_create_appointment(uuid, uuid, timestamptz, text, text, text, text, boolean) to authenticated;
grant execute on function public.admin_search_appointments(text) to authenticated;

-- Le funzioni create in futuro non devono essere eseguibili da anon per default.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
