-- =====================================================================
-- ROLLBACK della migrazione 20261030000010_ai_assistant.sql (Maylana AI)
-- Rimuove SOLO tabelle e funzioni dell'assistente. Nessun effetto su
-- appuntamenti, richieste, clienti, servizi o impostazioni del salone.
-- Si perdono: impostazioni AI, FAQ approvate, consumi aggregati, sessioni.
-- Prima: spegni l'assistente (dashboard o AI_ENABLED=false) e fai un backup.
-- =====================================================================
begin;
drop function if exists public.ai_purge();
drop function if exists public.ai_record_usage(uuid, int, int, int, boolean);
drop function if exists public.ai_begin_turn(text, text, boolean);
drop function if exists public.ai_public_context();
drop table if exists public.ai_sessions;
drop table if exists public.ai_usage_daily;
drop table if exists public.ai_faq;
drop table if exists public.ai_settings;
commit;
-- Nota: il processo schedulato chiama ai_purge(); dopo il rollback registra
-- un avviso nei log ("pulizia sessioni AI non riuscita") senza altri effetti.
