#!/usr/bin/env bash
# =====================================================================
# Test di integrazione ed end-to-end di Maylana Coiffeur Booking.
#
# Girano su un PostgreSQL LOCALE e usa-e-getta (mai su Supabase cloud né
# sul database di produzione): per ogni suite crea un database nuovo,
# applica uno stub minimo di Supabase (ruoli anon/authenticated/service_role,
# auth.uid()), tutte le migrazioni e il seed, poi lo elimina.
#
# Requisiti:  psql + PostgreSQL 15/16 locale con utente amministratore
#             (Mac: brew install postgresql@16 && brew services start postgresql@16)
#             npm install (installa anche playwright e tsx)
#             npx playwright install chromium
#             npm run build   (gli E2E usano la cartella dist)
# Connessione: variabili standard PGHOST, PGPORT, PGUSER, PGPASSWORD.
#
# Uso:        npm run test:integration        (API + scenari + email)
#             npm run test:e2e                (browser: chat AI, offline, route)
# Simulati:   provider email, Supabase Auth e modello OpenAI (nessun servizio esterno).
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
MODE="${1:-integration}"

case "${PGHOST:-localhost}" in
  *supabase.co*|*supabase.com*|*pooler*) echo "RIFIUTATO: questi test creano ed eliminano database. Usa un PostgreSQL locale, non Supabase."; exit 2 ;;
esac
[ -n "${DATABASE_URL:-}" ] && case "$DATABASE_URL" in *supabase.co*|*supabase.com*|*pooler*) echo "RIFIUTATO: DATABASE_URL punta a Supabase. Questi test usano solo un PostgreSQL locale."; exit 2 ;; esac

mkdir -p test-results/email
TSX="npx --no-install tsx"
export PGOPTIONS="${PGOPTIONS:-} --client-min-messages=warning"
P="psql -X -q -v ON_ERROR_STOP=1"

fresh() { # crea un database di test nuovo con stub, migrazioni e seed
  local db="$1"
  $P -d postgres -c "drop database if exists $db" -c "create database $db" >/dev/null
  $P -d "$db" -f tests/integration/supabase_stub.sql >/dev/null
  for f in supabase/migrations/*.sql; do $P -d "$db" -f "$f" >/dev/null; done
  $P -d "$db" -f supabase/seed.sql >/dev/null
}
drop() { $P -d postgres -c "drop database if exists $1" >/dev/null; }

run() { # suite, file
  local db="maylana_it_$1"
  fresh "$db"
  echo "── $2"
  if TESTDB="$db" $TSX "tests/integration/$2"; then drop "$db"; else drop "$db"; return 1; fi
}

fail=0
if [ "$MODE" = "integration" ]; then
  run scen scenarios.test.mts || fail=1
  run ai api_ai.test.mts || fail=1
  echo "── email_render.test.mts"; $TSX tests/integration/email_render.test.mts || fail=1
else
  [ -d "${DIST_DIR:-dist}" ] || { echo "Manca la cartella ${DIST_DIR:-dist}: esegui prima npm run build"; exit 2; }
  run e2e chat_e2e.mts || fail=1
  run flow flow_e2e.mts || fail=1
fi
echo
[ $fail = 0 ] && echo "✅ Suite $MODE superata (report in test-results/)" || echo "❌ Suite $MODE con errori (vedi sopra e test-results/)"
exit $fail
