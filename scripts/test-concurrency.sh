#!/usr/bin/env bash
# =====================================================================
# Test di concorrenza e idempotenza, ciascuna operazione da una
# connessione Postgres diversa e simultanea:
#  [1] N prenotazioni sullo stesso slot, stesso operatore → 1 sola
#  [2] N prenotazioni "nessuna preferenza" con 2 operatori → 2
#  [3] nessuna sovrapposizione nel database
#  [4] N approvazioni simultanee della stessa richiesta → 1 sola
#  [5] N processi email che prelevano la stessa coda → nessuna email presa due volte
#  [6] la stessa prenotazione inviata 10 volte insieme (doppio clic) → 1 appuntamento
#  [7] combinazioni di durata diversa che si sovrappongono in parte → mai sovrapposizioni
#
# Da eseguire su un progetto Supabase di TEST/STAGING.
# Crea dati temporanei marcati "ZZ-CONC" e li elimina alla fine.
#
#   export DATABASE_URL="postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres"
#   npm run test:concurrency        (oppure: bash scripts/test-concurrency.sh)
#
# Requisiti: psql (Mac: brew install libpq && brew link --force libpq)
# =====================================================================
set -euo pipefail
: "${DATABASE_URL:?Imposta DATABASE_URL (connessione diretta Postgres del progetto di TEST)}"
N="${PARALLEL:-25}"
PSQL=(psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1)
TAG="ZZ-CONC-$(date +%s)"
TMP="$(mktemp -d)"
SVC=""
SVC2=""
SVC3=""
ADMIN="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || cat /proc/sys/kernel/random/uuid)"

cleanup() {
  if [[ -n "$SVC" ]]; then
    "${PSQL[@]}" -c "
      create temp table zz_c as select distinct customer_id from appointments where service_id in ('$SVC', '$SVC2', '$SVC3')
        union select distinct customer_id from booking_requests where service_id in ('$SVC', '$SVC2', '$SVC3');
      delete from appointments where service_id in ('$SVC', '$SVC2', '$SVC3');
      delete from booking_requests where service_id in ('$SVC', '$SVC2', '$SVC3');
      delete from customers c where id in (select customer_id from zz_c) and email_normalized like '%@example.invalid'
         and not exists (select 1 from appointments a where a.customer_id = c.id)
         and not exists (select 1 from booking_requests r where r.customer_id = c.id);
      delete from admin_users where user_id = '$ADMIN';
      delete from auth.users where id = '$ADMIN';
      delete from staff where display_name like '$TAG%';
      delete from services where id in ('$SVC', '$SVC2', '$SVC3');" >/dev/null || echo "⚠️  Pulizia non completata: cerca record '$TAG'"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

SVC=$("${PSQL[@]}" -c "insert into services (category, name, duration_minutes, booking_mode, active)
                       values ('hair', '$TAG', 30, 'automatic', true) returning id" | head -1)
"${PSQL[@]}" -c "
  insert into staff (display_name, sort_order) values ('$TAG-A', 1), ('$TAG-B', 2);
  insert into staff_services select id, '$SVC' from staff where display_name like '$TAG%';
  insert into working_hours (staff_id, weekday, start_time, end_time)
    select s.id, d, '00:00', '23:59' from staff s, generate_series(1, 7) d where s.display_name like '$TAG%';" >/dev/null
STAFF_A=$("${PSQL[@]}" -c "select id from staff where display_name = '$TAG-A'")

slot_for() { # $1 = ora locale
  "${PSQL[@]}" -c "select (((now() at time zone 'Europe/Rome')::date
      + least(booking_horizon_days, ceil(min_notice_minutes / 1440.0)::int + 2)) + time '$1') at time zone 'Europe/Rome'
      from business_settings where id = 1"
}

storm() { # $1 = staff ('null' o uuid quotato), $2 = slot
  rm -f "$TMP"/r_*
  for i in $(seq 1 "$N"); do
    ( "${PSQL[@]}" -c "set role service_role;
        select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);
        select 'OK ' || staff_name from book_appointment(array['$SVC']::uuid[], $1, '$2', 'Test', 'Concorrenza $i',
               '+39000000$(printf %04d "$i")', 'conc$i@example.invalid', null, true);" > "$TMP/r_$i" 2>&1 || true ) &
  done
  wait
  OKS=$(grep -l '^OK ' "$TMP"/r_* | wc -l | tr -d ' ')
  BUSY=$(grep -l 'SLOT_UNAVAILABLE' "$TMP"/r_* | wc -l | tr -d ' ')
  OTHER=$(( N - OKS - BUSY ))
  DISTINCT=$(grep -h '^OK ' "$TMP"/r_* | sort -u | wc -l | tr -d ' ')
}

FAIL=0
storm "'$STAFF_A'" "$(slot_for '12:00')"
echo "[1] $N richieste stesso operatore: riuscite=$OKS, rifiutate=$BUSY, errori inattesi=$OTHER  (atteso 1/$((N-1))/0)"
[[ "$OKS" == 1 && "$OTHER" == 0 ]] || FAIL=1
[[ "$OTHER" == 0 ]] || { echo "Esempio errore:"; grep -L -E '^OK |SLOT_UNAVAILABLE' "$TMP"/r_* | head -1 | xargs cat; }

storm "null" "$(slot_for '14:00')"
echo "[2] $N richieste operatore indifferente (2 operatori): riuscite=$OKS su $DISTINCT operatori, errori inattesi=$OTHER  (atteso 2 su 2, 0)"
[[ "$OKS" == 2 && "$DISTINCT" == 2 && "$OTHER" == 0 ]] || FAIL=1

OVER=$("${PSQL[@]}" -c "select count(*) from appointments a join appointments b
   on a.staff_id = b.staff_id and a.id < b.id and a.status <> 'cancelled' and b.status <> 'cancelled'
  and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  where a.service_id = '$SVC'")
echo "[3] Sovrapposizioni nel database: $OVER (atteso 0)"
[[ "$OVER" == 0 ]] || FAIL=1

# ---------------------------------------------------------------------
# [4] approvazioni simultanee della stessa richiesta
# ---------------------------------------------------------------------
SVC2=$("${PSQL[@]}" -c "insert into services (category, name, duration_minutes, booking_mode, active)
                        values ('consultation', '$TAG-cons', 60, 'manual', true) returning id" | head -1)
"${PSQL[@]}" -c "
  insert into staff_services select id, '$SVC2' from staff where display_name like '$TAG%';
  insert into auth.users (id, email) values ('$ADMIN', 'zz-conc-admin@example.invalid');
  insert into admin_users (user_id, role) values ('$ADMIN', 'staff');" >/dev/null
REQ=$("${PSQL[@]}" -c "set role service_role; select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);
  select request_id from create_booking_request(array['$SVC2']::uuid[], 'Test', 'Approvazione', '+390000009999', 'appr@example.invalid', null, 'indifferente', null, null, true);" | tail -1)
rm -f "$TMP"/a_*
for i in $(seq 1 "$N"); do
  HOURS=(09 10 11 15)   # orari liberi: 12 e 14 sono usati dagli scenari [1] e [2]
  H=${HOURS[$(( i % 4 ))]}
  ( "${PSQL[@]}" -c "set role authenticated;
      select set_config('request.jwt.claims', '{\"role\":\"authenticated\",\"sub\":\"$ADMIN\"}', false);
      select 'OK ' || (admin_confirm_request('$REQ', '$STAFF_A', $(printf "'%s'" "$(slot_for "$H:00")"))->>'appointment_id');" > "$TMP/a_$i" 2>&1 || true ) &
done
wait
AOK=$(grep -l '^OK ' "$TMP"/a_* | wc -l | tr -d ' ')
ADUP=$(grep -l 'REQUEST_NOT_CONFIRMABLE' "$TMP"/a_* | wc -l | tr -d ' ')
ADBG=$(grep -L -E '^OK |REQUEST_NOT_CONFIRMABLE' "$TMP"/a_* | head -1)
[[ -n "$ADBG" ]] && { echo "Esempio esito inatteso [4]:"; grep -i error "$ADBG" | head -2; }
ACOUNT=$("${PSQL[@]}" -c "select count(*) from appointments where booking_request_id = '$REQ'")
echo "[4] $N approvazioni simultanee: riuscite=$AOK, rifiutate come già gestite=$ADUP, appuntamenti creati=$ACOUNT  (atteso 1/$((N-1))/1)"
[[ "$AOK" == 1 && "$ACOUNT" == 1 && "$ADUP" == $((N-1)) ]] || FAIL=1

# ---------------------------------------------------------------------
# [5] coda email: processi paralleli non prendono la stessa notifica
# ---------------------------------------------------------------------
"${PSQL[@]}" -c "
  insert into notifications (kind, audience, appointment_id, dedupe_key)
  select 'appointment_cancelled', 'customer', a.id, '$TAG-claim-' || g
    from (select id from appointments where service_id = '$SVC' limit 1) a, generate_series(1, 40) g;" >/dev/null
rm -f "$TMP"/c_*
for i in $(seq 1 10); do
  ( "${PSQL[@]}" -c "set role service_role; select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);
      select id from claim_notifications(10, (select array_agg(id) from notifications where dedupe_key like '$TAG-claim-%'));" \
      | grep -E '^[0-9a-f-]{36}$' > "$TMP/c_$i" 2>/dev/null || true ) &
done
wait
CTOT=$(cat "$TMP"/c_* | wc -l | tr -d ' ')
CUNI=$(cat "$TMP"/c_* | sort -u | wc -l | tr -d ' ')
echo "[5] 10 processi su 40 email in coda: prelevate=$CTOT, distinte=$CUNI  (atteso 40/40)"
[[ "$CTOT" == 40 && "$CUNI" == 40 ]] || FAIL=1

# ---------------------------------------------------------------------
# [6] doppio clic: stessa richiesta (stessa chiave) inviata 10 volte insieme
# ---------------------------------------------------------------------
SVC3=$("${PSQL[@]}" -c "insert into services (category, name, duration_minutes, booking_mode, active)
                        values ('hair', '$TAG-piega', 45, 'automatic', true) returning id" | head -1)
"${PSQL[@]}" -c "insert into staff_services select id, '$SVC3' from staff where display_name like '$TAG%';" >/dev/null
KEY="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || cat /proc/sys/kernel/random/uuid)"
SLOT6=$(slot_for '16:00')
rm -f "$TMP"/k_*
for i in $(seq 1 10); do
  ( "${PSQL[@]}" -c "set role service_role;
      select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);
      select 'OK ' || code from book_appointment(array['$SVC', '$SVC3']::uuid[], null, '$SLOT6', 'Test', 'Doppioclic',
             '+390000077777', 'doppio@example.invalid', null, true, false, '$KEY');" > "$TMP/k_$i" 2>&1 || true ) &
done
wait
KOK=$(grep -h '^OK ' "$TMP"/k_* | wc -l | tr -d ' ')
KCODES=$(grep -h '^OK ' "$TMP"/k_* | sort -u | wc -l | tr -d ' ')
KCOUNT=$("${PSQL[@]}" -c "select count(*) from appointments where idempotency_key = '$KEY'")
echo "[6] 10 invii identici simultanei: risposte positive=$KOK, codici distinti=$KCODES, appuntamenti creati=$KCOUNT  (atteso 10/1/1)"
[[ "$KOK" == 10 && "$KCODES" == 1 && "$KCOUNT" == 1 ]] || FAIL=1

# ---------------------------------------------------------------------
# [7] combinazioni di durata diversa (30', 45', 75') a orari sfalsati, stesso operatore
# ---------------------------------------------------------------------
rm -f "$TMP"/m_*
i=0
for t in 09:00 09:15 09:30 09:45 10:00 10:15 10:30 10:45; do
  for combo in "'$SVC'" "'$SVC3'" "'$SVC','$SVC3'"; do
    i=$((i+1))
    ( "${PSQL[@]}" -c "set role service_role;
        select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);
        select 'OK ' || code from book_appointment(array[$combo]::uuid[], '$STAFF_A', '$(slot_for "$t" | sed 's/+00$//')'::timestamptz + interval '2 days',
               'Test', 'Mix $i', '+39000088$(printf %04d "$i")', 'mix$i@example.invalid', null, true);" > "$TMP/m_$i" 2>&1 || true ) &
  done
done
wait
MOK=$(grep -l '^OK ' "$TMP"/m_* | wc -l | tr -d ' ')
MOTHER=$(grep -L -E '^OK |SLOT_UNAVAILABLE' "$TMP"/m_* | wc -l | tr -d ' ')
OVER7=$("${PSQL[@]}" -c "select count(*) from appointments a join appointments b
   on a.staff_id = b.staff_id and a.id < b.id and a.status <> 'cancelled' and b.status <> 'cancelled'
  and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  where a.staff_id = '$STAFF_A'")
echo "[7] $i prenotazioni miste simultanee: riuscite=$MOK, errori inattesi=$MOTHER, sovrapposizioni=$OVER7  (atteso ≥1, 0, 0)"
[[ "$MOK" -ge 1 && "$MOTHER" == 0 && "$OVER7" == 0 ]] || FAIL=1

if [[ "$FAIL" == 0 ]]; then echo "✅ TEST DI CONCORRENZA E IDEMPOTENZA SUPERATO"; else echo "❌ TEST DI CONCORRENZA E IDEMPOTENZA FALLITO"; exit 1; fi
