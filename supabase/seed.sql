-- =====================================================================
-- Catalogo iniziale (FACOLTATIVO)
--
-- Inserisce i nomi dei servizi indicati nel brief, tutti DISATTIVI,
-- senza prezzo e senza durata: Maylana deve completarli dalla dashboard
-- (Servizi → prezzo, durata, operatori → Attiva). Nessun dato inventato.
-- Eseguire una sola volta dal SQL Editor di Supabase.
-- =====================================================================

insert into public.services (category, public_group, name, booking_mode, active, sort_order) values
  ('hair', 'uomo', 'Taglio uomo',              'automatic', false, 10),
  ('hair', 'donna', 'Taglio donna',             'automatic', false, 20),
  ('hair', 'donna', 'Shampoo e piega',          'automatic', false, 30),
  ('hair', 'donna', 'Colore',                   'manual',    false, 40),
  ('hair', 'donna', 'Meches',                   'manual',    false, 50),
  ('hair', 'donna', 'Balayage',                 'manual',    false, 60),
  ('hair', 'trattamenti', 'Trattamenti capelli',      'manual',    false, 70),
  ('hair', 'acconciature', 'Acconciature',             'manual',    false, 80),
  ('consultation', 'consulenze', 'Consulenza protesi capillari uomo',  'manual', false, 110),
  ('consultation', 'consulenze', 'Consulenza protesi capillari donna', 'manual', false, 120),
  ('consultation', 'consulenze', 'Consulenza personalizzata',          'manual', false, 130),
  ('consultation', 'consulenze', 'Manutenzione protesi capillari',     'manual', false, 140);

-- Categorie cliente (Uomo, Donna, Trattamenti, Acconciature, Consulenze) modificabili
-- dalla dashboard. Nota: colore, meches, balayage, trattamenti e acconciature sono impostati
-- in modalità "manuale" (richiesta da approvare) solo come punto di partenza
-- prudente; si può passare ad "automatica" dalla dashboard.
