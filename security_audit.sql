-- =====================================================================
-- Audit automatico dei permessi (Supabase) — sola lettura del catalogo.
-- Esegui:  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/security_audit.sql
-- (npm run test:security). Si interrompe al primo problema con il dettaglio.
--
-- Verifica su TUTTE le tabelle e funzioni dello schema public:
--  1. RLS attiva su ogni tabella
--  2. il ruolo anon (browser non autenticato) non ha alcun privilegio su tabelle,
--     viste o sequenze
--  3. anon e PUBLIC non possono eseguire alcuna funzione
--  4. ogni funzione SECURITY DEFINER ha search_path fissato
--  5. tabelle riservate al backend senza accesso per gli utenti autenticati
--  6. ogni tabella accessibile agli autenticati ha policy che richiedono is_admin()/is_owner()
--     (nessuna policy "true" per tutti)
--  7. scritture su prezzi, operatori, impostazioni consentite solo al titolare
-- =====================================================================
\set ON_ERROR_STOP 1
\pset footer off

do $$
declare
  r record;
  problems text[] := '{}';
begin
  -- 1. RLS
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity loop
    problems := problems || format('RLS disattivata sulla tabella %s', r.relname);
  end loop;

  -- 2. anon: nessun privilegio su tabelle/viste/sequenze
  for r in select table_name, privilege_type from information_schema.role_table_grants
            where table_schema = 'public' and grantee in ('anon', 'PUBLIC') loop
    problems := problems || format('%s ha %s su %s', 'anon/PUBLIC', r.privilege_type, r.table_name);
  end loop;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') else false end loop
    problems := problems || format('anon può usare la sequenza %s', r.relname);
  end loop;

  -- 3. funzioni eseguibili da anon o PUBLIC
  for r in select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and (has_function_privilege('anon', p.oid, 'EXECUTE')
                   or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) loop
    problems := problems || format('funzione eseguibile da anon/PUBLIC: %s', r.fn);
  end loop;

  -- 4. SECURITY DEFINER senza search_path
  for r in select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') loop
    problems := problems || format('SECURITY DEFINER senza search_path: %s', r.fn);
  end loop;

  -- 5. tabelle solo backend
  for r in select t from unnest(array['api_rate_limits', 'ai_sessions', 'appointment_tokens']) t
            where to_regclass('public.' || t) is not null
              and has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') loop
    problems := problems || format('authenticated ha accesso alla tabella riservata al backend %s', r.t);
  end loop;

  -- 6. policy aperte a chiunque
  for r in select tablename, policyname, qual, with_check from pg_policies
            where schemaname = 'public'
              and (coalesce(qual, '') ~* '^\(?true\)?$' or coalesce(with_check, '') ~* '^\(?true\)?$'
                   or roles && array['anon', 'public']::name[]) loop
    problems := problems || format('policy troppo permissiva: %s.%s', r.tablename, r.policyname);
  end loop;
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public'
              and coalesce(qual, '') !~ '(is_admin|is_owner|auth\.uid)' and coalesce(with_check, '') !~ '(is_admin|is_owner|auth\.uid)' loop
    problems := problems || format('policy senza controllo del ruolo: %s.%s', r.tablename, r.policyname);
  end loop;

  -- 7. scritture riservate al titolare
  for r in select tablename, policyname, cmd from pg_policies
            where schemaname = 'public'
              and tablename in ('services', 'staff', 'staff_services', 'business_settings', 'ai_settings', 'ai_faq', 'opening_hours', 'admin_users')
              and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
              and coalesce(with_check, qual, '') !~ 'is_owner' loop
    problems := problems || format('scrittura non riservata al titolare: %s.%s (%s)', r.tablename, r.policyname, r.cmd);
  end loop;

  if cardinality(problems) > 0 then
    raise exception E'AUDIT SICUREZZA FALLITO (% problemi):\n - %', cardinality(problems), array_to_string(problems, E'\n - ');
  end if;
end $$;

-- Riepilogo leggibile
select c.relname as tabella,
       c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policy,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_legge,
       has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select_grant
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by 1;

\echo '✅ AUDIT SICUREZZA SUPERATO: RLS attiva ovunque, nessun accesso anonimo, funzioni e policy coerenti'
