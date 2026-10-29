# Maylana Coiffeur Booking — 1.0.0-rc.1

> **Pubblicazione:** segui **[docs/CONSEGNA.md](docs/CONSEGNA.md)** (variabili, Supabase, email, OpenAI, Netlify, collegamento al sito, installazione PWA, rollback, checklist).
> **Esito dei test:** **[docs/REPORT_TEST.md](docs/REPORT_TEST.md)** (PASS / FAIL / NON ESEGUITO).
> Stato: release candidate verificata in locale; build ufficiale e servizi esterni reali ancora da verificare.

Web app di prenotazione **installabile (PWA)** per Maylana Coiffeur (Palagiano, TA), con le consulenze **Capelli For You**.
Non sostituisce il sito vetrina: si collega con un pulsante "Prenota online".

| Percorso | Per chi | Cosa |
|---|---|---|
| `/prenota` | clienti | servizi parrucchiere (automatici o su richiesta) e consulenze Capelli For You (sempre su approvazione) |
| `/gestisci#t=…` | clienti | link personale ricevuto via email: riepilogo, annullare, scegliere un nuovo orario o chiedere una nuova data, scaricare il file calendario (.ics), contattare il salone — senza account |
| `/admin` | salone | panoramica, agenda giorno/settimana/mese, richieste, clienti, storico, orari e chiusure, servizi e prezzi, operatori, impostazioni |

Stack: React 19 + Vite + TypeScript + Tailwind 4 · Supabase (Postgres, Auth, RLS) · Netlify Functions e Scheduled Functions · PWA (manifest + service worker senza dipendenze) · email via Resend o Brevo.

---

## 0a. Novità della v0.4 (Prompt 4): assistente "Maylana AI"

Guida completa: **[docs/MAYLANA_AI.md](docs/MAYLANA_AI.md)**. Bozza dell'informativa: **[docs/INFORMATIVA_AI_BOZZA.md](docs/INFORMATIVA_AI_BOZZA.md)**, da far verificare prima del lancio.

Tutte le funzioni dei Prompt 1–3 restano invariate. Il modello di prenotazione non cambia e l'app resta una PWA su Netlify + Supabase.

- **Chat sulla pagina `/prenota`** (componente `MaylanaAIChat`):
  - pulsante flottante discreto, visibile anche durante la scelta dei servizi e nella sezione Capelli For You (con suggerimenti dedicati);
  - si carica solo se l'assistente è attivo;
  - è accessibile da tastiera e con screen reader;
  - la procedura classica resta disponibile per chi non vuole usare l'AI.
- **Backend `POST /api/ai/chat`** (Netlify Function):
  - usa l'SDK ufficiale `openai` e la Responses API;
  - la chiave è solo sul server;
  - il modello si sceglie con `OPENAI_MODEL`.
- **Strumenti tipizzati in sola lettura**: `get_services`, `get_service_details`, `get_availability`, `prepare_booking`, `prepare_consultation_request`. Usano lo stesso codice di `/api/catalog` e `/api/availability`.
- **Nessuna prenotazione dal modello.** Dopo la scelta dell'orario compaiono il riepilogo e un modulo dati; la conferma esplicita richiama `/api/book`, il backend esistente con idempotenza e vincolo anti-sovrapposizione. "Il tuo appuntamento è confermato." compare solo dopo l'esito reale.
- **Consulenze Capelli For You**: sempre richiesta `pending` tramite `/api/request`, da approvare in dashboard.
- **Costi**:
  - pulsanti, prezzi, contatti e FAQ semplici rispondono senza chiamare OpenAI;
  - limiti giornalieri (messaggi, token, costo stimato) e per conversazione;
  - rate limit persistente;
  - contesto ridotto.
- **Privacy**:
  - nessun testo delle conversazioni salvato; sessioni a scadenza con il solo hash del token;
  - telefoni ed email omessi prima dell'invio a OpenAI;
  - log senza dati personali;
  - nessun accesso ad appuntamenti di altri (si rimanda al link sicuro `/gestisci`).
- **Dashboard → Maylana AI** (titolare): attivazione, messaggio iniziale, limiti, prezzi per la stima dei costi, FAQ approvate, consumi aggregati.
- **Migrazione incrementale `20261030000010_ai_assistant.sql`**: tabelle `ai_settings`, `ai_faq`, `ai_usage_daily`, `ai_sessions`, con RLS e funzioni accessibili solo al backend.

## 0. Novità della v0.3 (Prompt 3)

Nessuna funzione precedente è stata rimossa; architettura invariata (Supabase + Netlify Functions + React PWA).

**Più servizi in un appuntamento**
- Nuova tabella `appointment_items` (e `booking_request_items` per le richieste): ogni servizio è salvato con nome, durata, tempo di preparazione e prezzo **fotografati al momento della prenotazione**.
- Gli appuntamenti esistenti sono convertiti automaticamente (una riga per appuntamento).
- Durata totale = somma delle durate + tempi di preparazione per servizio + tempo extra globale (configurabile). Esempio: 45' + 30' = 75' consecutivi.
- Prezzo indicativo = somma dei prezzi; se un servizio ha prezzo "da" o non ha prezzo, il totale è segnato come indicativo / "Prezzo in salone".
- Un solo operatore deve essere abilitato a **tutti** i servizi scelti (niente prenotazioni multi-operatore).
- Se anche un solo servizio è "manuale", l'intera combinazione diventa una **richiesta** da approvare. Le consulenze Capelli For You si prenotano da sole.

**Motore di disponibilità** (`get_bundle_slots`, sempre ricontrollato dal server al momento del salvataggio)
- Considera orari del salone (nuova tabella `opening_hours`, opzionale: se vuota valgono solo i turni), turni operatore, ferie/pause/chiusure, appuntamenti confermati, durata reale, preavviso minimo e orizzonte massimo.
- Le richieste in attesa **non** bloccano gli slot. Il vincolo di esclusione su Postgres resta l'ultima garanzia contro le sovrapposizioni. Fuso Europe/Rome con ora legale.

**Prenotazione in 5 passaggi** (`/prenota`)
1. categoria (Uomo, Donna, Trattamenti, Acconciature, Consulenze Capelli For You);
2. uno o più servizi con prezzo e durata, totale sempre visibile;
3. operatore, giorno e orario: solo dati del server;
4. dati (nome, cognome, telefono, email), informativa privacy obbligatoria e consenso marketing **separato e facoltativo**;
5. riepilogo (servizi, data, ora, durata, prezzo, operatore, stato).
- La conferma compare solo dopo il salvataggio reale. Le consulenze mostrano "Richiesta inviata, in attesa di approvazione".
- Se l'orario viene preso da qualcun altro durante la compilazione, si torna alla scelta dell'orario senza perdere i dati.
- Doppio clic o reinvio: ogni riepilogo ha una chiave di idempotenza, quindi lo stesso invio crea **un solo** appuntamento. Se la stessa chiave arriva con dati diversi, viene rifiutata.

**Orari consigliati** (configurabili in Impostazioni)
- Mostrati per primi gli orari che non lasciano buchi, cioè attaccati a un altro appuntamento o all'inizio/fine del turno, oppure che lasciano un buco di almeno N minuti.
- Tutti gli altri orari validi restano selezionabili. Logica deterministica (`fit_rank` 0–3). Gli appuntamenti confermati non vengono mai spostati.

**WhatsApp**
- Pulsante "Scrivici su WhatsApp" (link `wa.me`, numero configurabile in Impostazioni) e pulsanti con modelli in dashboard (nome, data, ora, codice).
- **Sono link manuali:** aprono WhatsApp con il testo pronto e l'invio lo fa una persona. Nessun dettaglio del servizio né dati sanitari nei link.
- Modulo **WhatsApp Business Platform (Cloud API)** separato e **disattivato** (`netlify/lib/whatsapp/cloud-api.ts`, webhook `/api/whatsapp/webhook`): credenziali, template approvati, consenso, stati di consegna. Non è collegato ad alcun invio finché non viene configurato e attivato. Nessuna automazione non ufficiale o WhatsApp Web.

**Pagina cliente** (`/gestisci`): riepilogo multi-servizio, annullamento nei termini, nuovo orario (se consentito) o richiesta di nuova data, file .ics, contatti. Nessuna ricerca pubblica per numero di telefono: solo link con token gestito dal server.

**Dashboard**
- Servizi multipli con durata e prezzo totali, filtro per categoria in agenda e storico.
- Creazione e **modifica** di appuntamenti combinati (servizi, operatore, orario) sempre attraverso la disponibilità reale.
- Pannello "Spazi liberi da riempire" con servizi e richieste in attesa che ci starebbero: solo suggerimenti, nulla viene spostato.
- Editor orari del salone, tempi di preparazione per servizio, impostazioni orari consigliati e numero WhatsApp.

## 1. Novità della v0.2 (Prompt 2)

- **Dashboard**:
  - *Panoramica*: oggi, prossimi 7 giorni, richieste in attesa, consulenze, annullati, disponibilità degli operatori, email non inviate.
  - *Agenda*: vista giorno a colonne per operatore, settimana e mese; colori per stato; tocco su uno spazio vuoto per inserire; sposta e annulla; conferma delle richieste dall'agenda.
  - *Clienti*: scheda con appuntamenti passati e futuri e collegamento all'agenda.
  - *Storico*: filtri per periodo, operatore e stato.
  - *Orari e chiusure*.
  - Menu mobile con 4 sezioni principali più "Altro".
- **Capelli For You**: sezione dedicata nelle richieste, con approva, rifiuta, proponi nuova data, storico e contatta (telefono, WhatsApp, email).
- **Clienti con nome e cognome separati** e deduplica: stesso telefono ed email, oppure scheda senza email da completare. I dati già registrati non vengono sovrascritti da un modulo pubblico.
- **Email transazionali**:
  - Eventi: conferma, richiesta ricevuta, approvata, rifiutata, proposta di nuova data, spostamento, annullamento, promemoria, avviso al salone.
  - Template HTML con logo o nome, servizio, data e ora, indirizzo, riferimento e istruzioni.
  - Le email Capelli For You sono **discrete**: il servizio compare come "Consulenza riservata".
- **Coda email affidabile**:
  - Le notifiche nascono nella stessa transazione dell'operazione.
  - Una chiave di deduplica impedisce le email doppie.
  - Il prelievo dalla coda è atomico (`SKIP LOCKED`), con retry e backoff (5 → 10 → 20 → 40 min, massimo 5 tentativi).
  - L'idempotency key del provider coincide con l'id della notifica.
  - Ogni esito è registrato. Senza provider configurato l'invio risulta **fallito**, e la dashboard lo segnala.
- **Promemoria automatici**:
  - Una Scheduled Function gira ogni 10 minuti.
  - Il primo promemoria (default 24 h) e un eventuale secondo sono configurabili.
  - Nessun duplicato, nessun invio per appuntamenti annullati o spostati.
- **Link personale del cliente**:
  - Token casuale da 256 bit; nel database si salva **solo l'hash SHA-256**.
  - Il token scade all'inizio dell'appuntamento ed è revocato dopo l'uso.
  - Limite temporale configurabile (default 24 h prima).
  - Spostamento con verifica della disponibilità. Per consulenze e servizi su approvazione si invia una richiesta, e l'appuntamento resta valido finché il salone non conferma.
  - Storico delle modifiche; avviso al cliente e al salone.
- **Audit log** delle modifiche rilevanti (prezzi, orari, appuntamenti, richieste, clienti, permessi), con autore: salone, cliente o sistema.
- **PWA**:
  - Manifest "Maylana Coiffeur Booking" / "Maylana", icone 192/512 (anche maskable), Apple touch icon, schermate di avvio iOS, standalone.
  - Il service worker mette in cache **solo file statici**: mai le API, mai Supabase.
  - Offline compare un avviso chiaro e nessuna operazione viene simulata.
  - Aggiornamenti con il pulsante "Aggiorna".
  - Installata da `/admin`, l'app si apre sull'agenda.

## 2. Struttura

```
maylana-booking/
├── index.html                    meta PWA/iOS, manifest
├── netlify.toml                  build, redirect, CSP e header (sw.js, /gestisci, /admin)
├── .env.example
├── public/
│   ├── manifest.webmanifest      PWA clienti (start /prenota)
│   ├── manifest-admin.webmanifest PWA salone (start /admin)
│   ├── offline.html
│   ├── icons/                    monogram.svg + PNG generati (sostituibili)
│   └── splash/                   schermate di avvio iOS
├── scripts/
│   ├── sw-template.js            service worker (sorgente)
│   ├── build-sw.mjs              genera dist/sw.js dopo la build (versione + precache)
│   ├── generate-icons.mjs        rigenera icone/splash da monogram.svg (npm run icons)
│   └── test-concurrency.sh       test concorrenza e idempotenza
├── netlify/
│   ├── functions/
│   │   ├── catalog.ts · availability.ts · book.ts · request.ts        API pubbliche
│   │   ├── manage-view|availability|cancel|reschedule|request.ts      link cliente
│   │   ├── admin-dispatch.ts · admin-status.ts                        admin (JWT verificato)
│   │   ├── notifications-scheduled.ts                                 promemoria + retry (ogni 10')
│   │   ├── whatsapp-webhook.ts                                        Cloud API (404 finché non configurata)
│   │   └── ai-chat.ts                                                 /api/ai/chat (Maylana AI)
│   └── lib/                      validazione, rate limit, client PostgREST, coda email,
│       ├── email/                provider (Resend/Brevo) e template HTML
│       ├── whatsapp/cloud-api.ts modulo WhatsApp Business ufficiale, DISATTIVATO
│       └── ai/                   Maylana AI: config, model (SDK OpenAI), prompt, tools, faq, guard, session, chat
├── src/
│   ├── App.tsx                   rotte, banner offline, avviso aggiornamento
│   ├── pages/BookingPage.tsx     /prenota
│   ├── pages/ManagePage.tsx      /gestisci
│   ├── pages/admin/              Overview, Agenda, Requests, Customers, History, Hours,
│   │                             Services, StaffPage, SettingsPage, shared, context
│   ├── components/               UI, selettore date e orari (consigliati), BookingBits, Online,
│   │                             ai/MaylanaAIChat.tsx (chat)
│   └── lib/                      api, supabase, time (Europe/Rome), types, bundle (totali),
│                                 ics (calendario), wa/whatsapp (link e modelli manuali)
├── supabase/
│   ├── migrations/               001–003 (v0.1) + 004–006 (v0.2) + 007–009 (v0.3) + 010 (v0.4 AI), incrementali
│   ├── seed.sql                  catalogo iniziale disattivo, senza prezzi/durate
│   └── tests/db_tests.sql        funzionali + idempotenza + autorizzazioni (ROLLBACK)
├── tests/                      time, helpers, ai (protezioni, FAQ, firme)
└── docs/                       MAYLANA_AI.md, INFORMATIVA_AI_BOZZA.md
```

## 3b. Aggiornare un'installazione v0.3 → v0.4

1. Backup del database.
2. SQL Editor: esegui `supabase/migrations/20261030000010_ai_assistant.sql` (oppure `supabase db push`). Non modifica dati esistenti e l'assistente parte **disattivato**.
3. Netlify:
   - `NODE_VERSION` resta 22: il pacchetto `openai` 7.x richiede Node 22;
   - aggiungi `AI_ENABLED=true`, `OPENAI_API_KEY` (segreta, scope Functions) e `OPENAI_MODEL`;
   - ripubblica: la build esegue `npm install` e scarica `openai`.
4. Dashboard → Maylana AI:
   - verifica lo stato "configurato";
   - inserisci i prezzi del modello dal listino OpenAI;
   - imposta i limiti e scrivi le FAQ approvate (soprattutto per Capelli For You);
   - attiva.
5. Imposta un limite di spesa anche nel pannello OpenAI.
6. Pubblica l'informativa aggiornata (bozza in `docs/`) e collegala in Impostazioni → URL informativa privacy.

Per spegnere l'assistente: interruttore in dashboard (immediato) oppure `AI_ENABLED=false` e nuovo deploy. Le prenotazioni continuano normalmente.

## 3a. Aggiornare un'installazione v0.2 → v0.3

1. Backup del database (Supabase → Database → Backups).
2. Esegui nel **SQL Editor**, in ordine: `20261029000007_v3_schema.sql`, `20261029000008_v3_functions.sql`, `20261029000009_v3_security.sql` (oppure `supabase db push`).
   - Gli appuntamenti e le richieste esistenti ricevono automaticamente le righe servizio.
   - Ai servizi viene assegnata una categoria cliente (uomo/donna/consulenze), da correggere in dashboard → Servizi.
3. In dashboard: **Servizi** (categoria, tempo di preparazione), **Orari → Orari del salone** (facoltativo), **Impostazioni** (tempo extra, orari consigliati, numero WhatsApp).
4. Su Netlify: nessuna variabile nuova obbligatoria. Le variabili `WHATSAPP_*` servono solo se un giorno attivi la Cloud API. Poi ripubblica.

## 3. Aggiornare un'installazione v0.1

Esegui nel **SQL Editor** di Supabase, in ordine, solo le migrazioni nuove:
`20261029000004_v2_schema.sql`, `20261029000005_v2_functions.sql`, `20261029000006_v2_security.sql`
(oppure `supabase db push`). I nomi esistenti vengono separati automaticamente in nome e cognome.
Poi aggiungi su Netlify le nuove variabili (`PUBLIC_SITE_URL`, `EMAIL_*`) e ripubblica.

## 4. Nuova installazione: Supabase

1. Crea un progetto (regione EU). Consigliato un secondo progetto per i **test**.
2. SQL Editor → esegui in ordine tutte le migrazioni `001`…`010`, poi facoltativamente `seed.sql`.
3. Authentication → disattiva "Allow new users to sign up".
4. Authentication → Users → crea l'utente del titolare. Poi nel SQL Editor:
   ```sql
   insert into public.admin_users (user_id, role, display_name) values ('UUID-UTENTE', 'owner', 'Titolare');
   -- collaboratori: role = 'staff' (agenda, richieste, clienti, chiusure; niente prezzi/impostazioni)
   ```
5. Authentication → URL Configuration → Site URL = dominio pubblicato.
6. Project Settings → API: URL, chiave pubblica e chiave segreta per le variabili d'ambiente.

## 5. Email (Resend o Brevo)

1. Crea un account sul provider e **verifica il dominio** del mittente (record SPF/DKIM nel DNS).
2. Su Netlify: `EMAIL_PROVIDER=resend` (o `brevo`), `EMAIL_API_KEY`, `EMAIL_FROM`, facoltativo `EMAIL_REPLY_TO`, `PUBLIC_SITE_URL`.
3. Dashboard → Impostazioni: email del salone per gli avvisi, istruzioni, ore dei promemoria, limite modifiche cliente.
4. Panoramica e Impostazioni mostrano se il servizio è attivo. Le email non inviate compaiono con il motivo e il pulsante "Riprova".

I promemoria partono dalla Scheduled Function `notifications-scheduled` (ogni 10 minuti, solo sul deploy di produzione). In Netlify → Functions puoi vederne i log.

## 6. Avvio su Mac

```bash
cd maylana-booking
npm install
npm install -g netlify-cli
cp .env.example .env            # valori del progetto Supabase di TEST
openssl rand -hex 32            # → RATE_LIMIT_SALT
netlify dev                     # http://localhost:8888/prenota · /admin
```
Il service worker è disattivato in sviluppo (`vite dev`). Per provarlo in locale: `netlify serve` (build di produzione + functions) oppure un deploy di anteprima.

## 7. Pubblicazione su Netlify

1. Repository GitHub → Netlify "Import from Git" (build da `netlify.toml`).
2. Variabili d'ambiente: tutte quelle di `.env.example` (le chiavi segrete marcate come *secret*). Per Maylana AI: `AI_ENABLED`, `OPENAI_API_KEY`, `OPENAI_MODEL` (vedi `docs/MAYLANA_AI.md`).
3. Dominio personalizzato (consigliato, es. `prenota.<dominio>`) con HTTPS automatico. Aggiungilo a `ALLOWED_ORIGINS` e `PUBLIC_SITE_URL`.
4. Sul sito vetrina: `<a href="https://prenota.<dominio>/prenota">Prenota online</a>` e `…/prenota?sezione=capelli-for-you`.
5. Installazione: su Android menu → "Installa app"; su iPhone Safari → Condividi → "Aggiungi alla schermata Home".

Logo e icone: carica il logo dalla dashboard (Impostazioni → URL del logo). Per le icone dell'app sostituisci `public/icons/monogram.svg` ed esegui `npm run icons` (richiede `sharp`, già tra le devDependencies), oppure sostituisci direttamente i PNG.

## 8. Verifiche

```bash
npm install              # 1
npm run build            # 2  (tsc + vite build + generazione sw.js)
npm run test:unit        #    fuso orario/ora legale, totali, .ics, link WhatsApp
# Progetto Supabase di TEST (psql: brew install libpq && brew link --force libpq)
export DATABASE_URL="postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres"
npm run test:db          #    funzionali + idempotenza + autorizzazioni (rollback) — su DB di test senza dati reali
npm run test:concurrency #    prenotazioni/approvazioni simultanee, coda email parallela
npm run test:security    #    audit RLS/grant/policy (sola lettura: ok anche su produzione)
# PostgreSQL LOCALE usa-e-getta (mai Supabase): PGHOST/PGPORT/PGUSER
npm run test:integration #    scenari obbligatori 1-13, Maylana AI, template email
npm run test:e2e         #    browser (dopo npm run build): chat AI, connessione persa, route
```

Prove manuali (su deploy di anteprima con progetto di test):

| # | Verifica | Come |
|---|---|---|
| 3 | Login amministratore | /admin con titolare; un utente non presente in `admin_users` deve essere rifiutato |
| 4 | Lettura calendario | Agenda giorno/settimana/mese, filtri operatore e categoria, pannello "Spazi liberi" |
| 5 | Prenotazione singola | /prenota → 1 servizio → conferma con codice → email → appuntamento in agenda |
| 6 | Prenotazione multipla | 2–3 servizi automatici → durata e prezzo totali corretti → un solo blocco in agenda |
| 7 | Combinazione manuale | servizio automatico + servizio manuale → diventa richiesta "in attesa di approvazione" |
| 8 | Consulenza | Capelli For You → "Richiesta inviata, in attesa di approvazione"; email senza dettagli |
| 9 | Orario preso durante la compilazione | due telefoni sullo stesso orario: il secondo torna alla scelta orario con i dati conservati |
| 10 | Doppio invio | doppio tocco veloce su "Conferma" e ricarica pagina → un solo appuntamento |
| 11 | Approvazione e modifica | Richieste → Approva; dettaglio appuntamento → Modifica servizi/operatore/orario |
| 12 | Link cliente | email → Gestisci: .ics, nuovo orario, richiesta nuova data, annullamento; poi link non più valido |
| 13 | WhatsApp | pulsante pubblico e modelli admin aprono WhatsApp con testo corretto (invio manuale) |
| 14 | Promemoria | appuntamento tra 2–23 h → entro 10' email "Promemoria" (log Netlify) |
| 15 | PWA | installazione su Android e iPhone; modalità aereo → avviso offline |

### Cosa è stato eseguito per la v0.4 (risultati reali)

**OpenAI NON è stato chiamato**: in quest'ambiente non c'erano una chiave né l'accesso a npm per installare il pacchetto `openai`. Tutte le prove sull'assistente usano un **modello simulato** che restituisce risposte e chiamate di strumenti programmate. Sono verifiche della nostra integrazione, non del comportamento del modello reale.

*Eseguiti*:
- **Database**:
  - migrazione 010 su DB nuovo e su DB v0.3 con dati: dati invariati, assistente spento di default;
  - `db_tests.sql` superato (sezione AI: limiti atomici di sessione e di costo, sessioni scadute, nessuna colonna per testi; permessi di anon, non-admin, staff e owner);
  - concorrenza 5/5.
- **`/api/ai/chat` reale contro Postgres con modello simulato: 68/68 controlli.** Tra questi:
  - configurazione assente → 503 e prenotazione classica funzionante;
  - campi `instructions`/`tools`/`model`/`system` dal client rifiutati;
  - prezzi e orari = database;
  - durata 45+30 = 75';
  - falsa conferma del modello rimossa;
  - telefono ed email non inviati al modello;
  - riepilogo senza salvataggio, poi `/api/book` → appuntamento; doppio invio → 1 solo;
  - slot occupato rifiutato;
  - consulenza mai prenotabile come appuntamento e salvata `pending`;
  - prompt injection e appuntamenti di terzi gestiti senza modello;
  - strumento inesistente e argomenti extra rifiutati;
  - cronologia falsificata scartata;
  - errori 429/500/401/timeout → ripiego senza dettagli esterni; timeout effettivo ≈2 s;
  - consumi e costo stimato corretti;
  - limiti giornalieri e di sessione; sessione scaduta; rate limit 429;
  - nessun testo nel DB né nei log; chiave mai nelle risposte.
- **Mutazioni volute**:
  - protezione dell'output disattivata → test fallisce;
  - redazione disattivata → test fallisce;
  - RLS di `ai_sessions` aperta → `db_tests` fallisce.
- **E2E nel browser (Playwright) con handler reali, DB reale e modello simulato: 32/32.**
  - Accessibilità: dialog con `aria-modal`, focus nel campo, Tab trattenuto, Esc chiude e riporta il focus, `role=log` `aria-live`.
  - I 5 suggerimenti, i prezzi reali e gli orari della card uguali al motore del database.
  - Conferma senza dati rifiutata; "Il tuo appuntamento è confermato." solo dopo il salvataggio; doppio clic → 1 appuntamento.
  - Consulenza → richiesta `pending`.
  - Errore del modello → ripiego; procedura classica intatta; AI spenta → nessun pulsante.
  - Nessun riferimento OpenAI nel bundle; nessun errore in pagina, nessuno scorrimento orizzontale.
- **Regressione v0.3**: API 59/59 e 27/27; unitari 26/26 (12 nuovi, che hanno trovato e fatto correggere un difetto: le date tipo 14/11/2026 venivano omesse come numeri di telefono).
- **PWA** 12/12: `/api/ai/chat` mai in cache. Typecheck pulito.

*NON eseguiti* (da fare, vedi `docs/MAYLANA_AI.md` §5):
- chiamate reali a OpenAI: qualità delle risposte, rispetto delle istruzioni, lingua inglese, tempi con il modello scelto, compatibilità del parametro `include` / ragionamento con quel modello;
- `npm install` / `npm run build` con il pacchetto `openai` reale;
- build e deploy Netlify;
- confronto dei consumi con il pannello OpenAI;
- revisione legale dell'informativa e del DPA;
- dispositivi reali con lettori di schermo (VoiceOver/TalkBack).

### Cosa è stato eseguito durante lo sviluppo (risultati reali, v0.3)

L'ambiente di sviluppo **non aveva accesso al registry npm**, né a Supabase reale, a un provider email o a WhatsApp.

**NON eseguiti** (da fare con la tabella sopra):
- `npm install` e `npm run build` (tsc + Vite) con le dipendenze ufficiali, quindi nemmeno una build Netlify reale;
- login reale su Supabase Auth e RLS sul Supabase ospitato;
- invio reale Resend/Brevo e Scheduled Function su Netlify;
- WhatsApp: né i link `wa.me` su un telefono né la Cloud API (non configurata);
- dispositivi fisici.

**Eseguiti** su PostgreSQL 16 con simulazione dei ruoli Supabase (`anon`, `authenticated`, `service_role`, `auth.uid()`):

*Migrazioni*
- 001–009 su database nuovo: superate.
- **Aggiornamento da v0.2 con dati esistenti** (001–006 + dati, poi 007–009): superato. L'appuntamento esistente riceve la riga servizio con durata e prezzo, le richieste ricevono le loro righe, i servizi ricevono la categoria e lo slot occupato resta bloccato.

*`db_tests.sql`*: superato su database nuovo (101 controlli). Oltre ai test v0.2 copre:
- totali della combinazione (45'+30' = 75', prezzi), tempi di preparazione ed extra;
- orari del salone, slot preso a metà flusso, orari consigliati (`fit_rank`);
- combinazione manuale → richiesta, operatore non abilitato a tutti i servizi;
- ora legale (31/10/2027 e 28/03/2027);
- spostamento cliente sovrapposto a sé stesso;
- modifica admin con verifica disponibilità, idempotenza, suggerimenti spazi liberi;
- divieti per anon e non-admin.
- Con mutazioni volute (verifica operatore disattivata, tempo di preparazione ignorato) il test **fallisce**, quindi rileva davvero questi difetti.
- Nota: il file presuppone un database senza clienti di prova omonimi. Su un DB già popolato un controllo di conteggio può fallire per collisione dei dati.

*`test-concurrency.sh`*: superato in 20 esecuzioni consecutive (15 durante lo sviluppo + 5 nella verifica finale).
- [1] 25 prenotazioni sullo stesso operatore e orario → 1 riuscita.
- [2] operatore indifferente → 2 riuscite su 2 operatori.
- [3] 0 sovrapposizioni.
- [4] 25 approvazioni simultanee → 1.
- [5] coda email parallela senza doppioni.
- [6] 10 invii identici simultanei (stessa chiave) → 1 appuntamento.
- [7] combinazioni di durate diverse in parallelo → 0 sovrapposizioni.

*API (Netlify Functions eseguite davvero contro il database, con email e Auth simulati)*
- 59/59 controlli v0.3 su database nuovo, più 27/27 di regressione.
- Il test usa orari fissi: rieseguito sullo stesso DB, alcuni controlli falliscono per SLOT_UNAVAILABLE, che è il comportamento corretto.

*Unitari*: 14/14 (fuso orario, totali, file .ics, link WhatsApp).

*Interfaccia* (esbuild + Tailwind 4 con Supabase simulato, Playwright su viewport mobile):
- flusso in 5 passaggi, consulenza, pagina cliente, dashboard (agenda, spazi liberi, dettaglio multi-servizio, richieste, clienti);
- nessun errore in console, nessuno scorrimento orizzontale.

*PWA* su server locale: 12/12 controlli.
- Manifest e icone corretti, nessun errore di installabilità in Chrome.
- Il service worker controlla la pagina; in cache solo file statici, nessuna API.
- Offline compaiono l'avviso e nessuna falsa conferma, senza POST partiti; aggiornamento con "Aggiorna".

*Typecheck* `tsc` con dichiarazioni sostitutive delle librerie: nessun errore nel codice dell'app. Non sostituisce `npm run build`.

## 9. Prima di andare in produzione

Il sistema **non è da considerarsi pronto per la produzione** finché non hai:
- [ ] `npm run build` senza errori
- [ ] `npm run test:db` e `npm run test:concurrency` superati sul progetto Supabase di test
- [ ] le prove manuali 3–15 superate su un deploy di anteprima
- [ ] il dominio email verificato e un'email di prova ricevuta (anche in spam: controlla SPF/DKIM)
- [ ] registrazioni pubbliche disattivate, password robuste, MFA per gli admin
- [ ] informativa privacy aggiornata (email transazionali, link personale, conservazione dei dati e dell'audit log)
- [ ] backup del database attivi
- [ ] se usi Maylana AI: prove con OpenAI reale (docs/MAYLANA_AI.md §5), limite di spesa sul pannello OpenAI, informativa AI verificata e pubblicata

## 10. Privacy e sicurezza (sintesi)

- Il browser pubblico non accede a tabelle né funzioni: passa sempre dalle Netlify Functions (validazione zod, honeypot, tempo minimo, controllo Origin, rate limit persistente su Postgres).
- Area admin: Supabase Auth + RLS su tutte le tabelle + ruoli `owner`/`staff`. Le API admin verificano il JWT lato server.
- Nessuna chiave segreta nel frontend. Token cliente solo come hash. Pagine `/gestisci` e `/admin` con `noindex` e `no-store`.
- Moduli e note senza dati sanitari; email Capelli For You senza dettagli del servizio.
- Consenso privacy (obbligatorio, solo per gestire l'appuntamento) e consenso marketing (facoltativo, casella separata non preselezionata) salvati distintamente con data e origine. Nessun invio marketing è implementato.
- I link WhatsApp contengono solo nome, data, ora e codice: mai il servizio, quindi mai dettagli Capelli For You.
- Maylana AI:
  - chiave OpenAI solo sul server;
  - nessun testo delle conversazioni salvato;
  - dati di contatto omessi verso il fornitore AI;
  - strumenti in sola lettura;
  - scritture solo tramite i moduli e il backend esistente.

## 11. Rimandato

Attivazione reale WhatsApp Cloud API (richiede account Meta e template approvati), pagamenti Stripe, statistiche avanzate, CAPTCHA (es. Turnstile) se lo spam aumenta, accettazione online della proposta di nuova data.
