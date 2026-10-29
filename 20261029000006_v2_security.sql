-- =====================================================================
-- Maylana Booking v2 — RLS e permessi delle nuove tabelle
-- =====================================================================

alter table public.appointment_tokens enable row level security;
alter table public.notifications      enable row level security;
alter table public.audit_log          enable row level security;

-- Token: nessun accesso diretto se non dalla service role.
revoke all on table public.appointment_tokens from anon, authenticated;

-- Notifiche: gli admin vedono lo stato degli invii, non possono modificarle
-- direttamente (riprova tramite admin_retry_notification).
revoke all on table public.notifications from anon, authenticated;
grant select on table public.notifications to authenticated;
create policy notifications_select on public.notifications
  for select to authenticated using (public.is_admin());

-- Audit: sola lettura per gli admin, scrittura solo dal trigger.
revoke all on table public.audit_log from anon, authenticated;
grant select on table public.audit_log to authenticated;
create policy audit_select on public.audit_log
  for select to authenticated using (public.is_admin());

revoke all on all sequences in schema public from anon;
