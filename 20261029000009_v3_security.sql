-- =====================================================================
-- Maylana Booking v3 — RLS e permessi delle nuove tabelle
-- =====================================================================

alter table public.opening_hours         enable row level security;
alter table public.appointment_items     enable row level security;
alter table public.booking_request_items enable row level security;

revoke all on table public.opening_hours, public.appointment_items, public.booking_request_items from anon;

-- Orari di apertura: lettura admin, scrittura owner
create policy opening_hours_select on public.opening_hours
  for select to authenticated using (public.is_admin());
create policy opening_hours_insert on public.opening_hours
  for insert to authenticated with check (public.is_owner());
create policy opening_hours_update on public.opening_hours
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy opening_hours_delete on public.opening_hours
  for delete to authenticated using (public.is_owner());

-- Servizi dell'appuntamento: gestiti dalle funzioni (anche per conto degli admin)
create policy appointment_items_select on public.appointment_items
  for select to authenticated using (public.is_admin());
create policy appointment_items_insert on public.appointment_items
  for insert to authenticated with check (public.is_admin());
create policy appointment_items_delete on public.appointment_items
  for delete to authenticated using (public.is_admin());
revoke update on table public.appointment_items from authenticated;

-- Servizi delle richieste: lettura admin; scrittura solo dal backend
create policy booking_request_items_select on public.booking_request_items
  for select to authenticated using (public.is_admin());
revoke insert, update, delete on table public.booking_request_items from authenticated;

-- I clienti non possono essere marcati con consenso marketing dal pannello
-- senza traccia: le modifiche passano comunque dall'audit log (trigger su customers).
