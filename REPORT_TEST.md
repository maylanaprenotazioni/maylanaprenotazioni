# Report dei test — Maylana Coiffeur Booking 1.0.0-rc.1

Data di esecuzione: 28 ottobre 2026. I test sono stati eseguiti nell'ambiente di sviluppo, che **non ha accesso** a:
- registro npm (bloccato dalla policy di rete con errore 403);
- Supabase cloud;
- un provider email reale;
- OpenAI;
- Netlify;
- dispositivi fisici.

Tutte le prove sono state eseguite su un database PostgreSQL 16 **locale e usa-e-getta**: per ogni suite un database nuovo, con stub dei ruoli Supabase, le migrazioni 001–010 e il seed. Le parti simulate sono indicate in ogni riga. Nessun test ha toccato dati reali.

Legenda:
- **PASS**: eseguito, tutti i controlli superati.
- **FAIL**: eseguito, almeno un controllo non superato.
- **NON ESEGUITO**: non eseguibile in questo ambiente.

## Scenari obbligatori (FASE 9)

| # | Scenario | Esito | Come è stato verificato |
|---|---|---|---|
| 1 | Cliente prenota taglio uomo | **PASS** | `POST /api/book` reale → 201, appuntamento nel DB, email di conferma al cliente (Resend simulato) |
| 2 | Cliente prenota taglio donna + piega | **PASS** | un solo appuntamento con 2 servizi, blocco di 75', prezzo 40 € |
| 3 | Due clienti scelgono lo stesso orario | **PASS** | due richieste **parallele** su connessioni DB distinte → 201 + 409 `SLOT_UNAVAILABLE`, una sola riga nel DB, vincolo di esclusione presente. Ripetuto 3 volte, più `test-concurrency.sh` (25 richieste simultanee) 5/5 |
| 4 | Cliente richiede consulenza Capelli For You | **PASS** | richiesta `pending`, nessun appuntamento, email discreta senza dettagli; la prenotazione automatica della consulenza viene rifiutata |
| 5 | Admin approva consulenza | **PASS** | `admin_confirm_request` con ruolo titolare (RLS reale) → appuntamento in agenda, email di approvazione; seconda approvazione rifiutata; anonimo → permesso negato |
| 6 | Admin rifiuta consulenza | **PASS** | stato `rejected`, email di rifiuto, nessun appuntamento |
| 7 | Cliente annulla con token valido | **PASS** | link dall'email; nel DB solo l'hash del token; annullamento; l'orario torna libero; secondo annullamento rifiutato |
| 8 | Accesso a un appuntamento altrui | **PASS** | token inventato → 404 senza dati; codice al posto del token → 400; ricerca per telefono → 400; API admin senza login → 401; tabella clienti negata all'anonimo; l'assistente AI non rivela dati |
| 9 | Admin modifica orario operatore | **PASS** | aggiornamento dei turni con ruolo titolare → orari online da 35 a 15, nessuno dopo le 13; modifica negata all'anonimo |
| 10 | L'agenda aggiorna le disponibilità | **PASS** | inserimento manuale → orario non più proposto online e prenotazione online rifiutata (409); annullamento dal pannello → orario di nuovo libero |
| 11 | L'AI non conferma senza consenso | **PASS** | il modello **simulato** chiama `prepare_booking` e scrive "confermato": nessun appuntamento salvato, frase rimossa, mostrato solo il riepilogo da confermare |
| 12 | Sistema funzionante con AI disattivata | **PASS** | chat → 503, pulsante nascosto (anche senza chiave), prenotazione tradizionale → 201 |
| 13 | Servizio email non disponibile | **PASS** | provider simulato → 503: prenotazione salvata ed email dichiarata non inviata; poi il processo schedulato la invia **una sola volta**, con chiave di idempotenza |
| 14 | Connessione persa durante la prenotazione | **PASS** | browser reale (Chromium):<br>- offline → avviso e pulsante disattivato;<br>- rete caduta durante l'invio → messaggio, nessun salvataggio, dati conservati;<br>- al ritorno della rete una sola conferma;<br>- nessun dato personale nello storage del browser;<br>- dopo una ricarica il modulo riprende solo le scelte non sensibili |
| 15 | Build di produzione e navigazione route | **NON ESEGUITO** (build) / PASS (route) | **`npm run build` (tsc + Vite) non eseguita**: npm bloccato. Sostituto eseguito su un bundle di produzione esbuild con le regole di `netlify.toml` emulate:<br>- `/` → `/prenota`;<br>- `/prenota?sezione=capelli-for-you`;<br>- `/gestisci`, `/admin`, route sconosciuta → app;<br>- `/api/inesistente` → 404 JSON;<br>- API reali non intercettate;<br>- nessun errore JS |

## Altre suite eseguite

| Suite | Esito | Note |
|---|---|---|
| `npm run test:unit` | **PASS** 26/26 | fuso orario e ora legale, totali dei servizi, file .ics, link WhatsApp, protezioni AI, FAQ, firme |
| `supabase/tests/db_tests.sql` | **PASS** | funzionali, idempotenza, permessi di anon / non-admin / staff / titolare, sezione AI |
| `supabase/tests/security_audit.sql` (**nuovo**) | **PASS** | RLS su tutte le 21 tabelle, nessun privilegio anonimo, nessuna funzione eseguibile da anon, `search_path` fissato, policy legate al ruolo, scritture riservate al titolare. **Validato con 6 difetti introdotti apposta, tutti rilevati** |
| `scripts/test-concurrency.sh` | **PASS** 5/5 | 25 prenotazioni simultanee, approvazioni simultanee, coda email parallela, doppio invio, combinazioni miste |
| API v0.3 (regressione) | **PASS** 59/59 + 27/27 | handler reali, DB reale |
| Maylana AI `/api/ai/chat` | **PASS** 68/68 | modello **simulato** |
| Chat AI nel browser | **PASS** 32/32 | modello **simulato** |
| Template email (9 tipi) | **PASS** 36/36 | rendering locale a 360 px, ora legale e solare, discrezione consulenze. **Nessun invio reale** |
| PWA | **PASS** 12/12 | manifest, icone, service worker, cache solo statica, offline, aggiornamento (Chromium) |
| Dispositivi | **PASS** 7/7 | iPhone SE, iPhone 13, Pixel 7, iPad, Galaxy Tab S4, 1440×900, 1920×1080, con controllo automatico di scorrimento orizzontale, elementi fuori schermo, testo < 11 px e pulsanti sovrapposti. **Emulazione su Chromium**: WebKit/Safari non disponibile |
| Rollback migrazione 010 | **PASS** | tabelle AI rimosse, dati del salone intatti, audit superato, migrazione ri-applicabile |
| Aggiornamento v0.3 → v0.4 con dati | **PASS** | eseguito nel Prompt 4 |

## Difetti trovati e corretti in questa fase

| Gravità | Problema | Correzione |
|---|---|---|
| Alta | Se un modulo caricato al bisogno non arrivava (rete instabile o nuovo deploy), la pagina restava **bianca**. Un errore della chat AI avrebbe fatto sparire l'intera pagina di prenotazione | `ErrorBoundary`: messaggio con "Ricarica"; la chat in errore sparisce senza toccare il modulo |
| Media | Un percorso `/api/...` inesistente riceveva la pagina HTML con codice 200 | regola `/api/*` → 404 JSON, prima del fallback SPA |
| Media | Senza rete la dashboard mostrava l'errore tecnico inglese "Failed to fetch" | messaggio "Connessione assente: la modifica NON è stata salvata" |
| Media | Codici d'errore SQL mostrati grezzi in dashboard (es. `STAFF_NOT_ENABLED`) | 11 messaggi in italiano |
| Media | Su iPhone SE (320 px) la dashboard scorreva in orizzontale (+35 px) | intestazione e barra dell'agenda vanno a capo, menu inferiore compatto |
| Media | Su iPad e tablet Android le ultime voci del menu admin erano fuori schermo | menu su più righe |
| Media | Sezione Capelli For You **vuota** se il salone non ha attivato consulenze | messaggio con invito a contattare il salone |
| Media | Dopo una ricarica senza rete il modulo ripartiva da zero | ripresa delle sole scelte non sensibili (servizi, giorno, fascia; 2 ore, solo nella scheda) |
| Bassa | Badge numerico a 10 px | 11 px |
| Bassa | `.env.example` conteneva un dominio inventato | segnaposto `TUO-DOMINIO` |

Nella FASE 9 tutti i fallimenti iniziali degli scenari erano errori del codice di test (formati di data, nomi di colonna), non dell'applicazione. Sono stati analizzati uno per uno e documentati.

## Cosa NON è stato verificato (da fare prima della pubblicazione)

1. `npm install`, `npm run typecheck` e `npm run build`. Il controllo dei tipi eseguito qui usa dichiarazioni semplificate per React e Supabase, perché i pacchetti di tipi non erano installabili: **la build ufficiale potrebbe segnalare errori di tipo non visti qui**. Se la build fallisce su Netlify, resta online la versione precedente.
2. Supabase cloud:
   - migrazioni applicate;
   - `npm run test:db` e `npm run test:security` sul progetto di **test**;
   - login reale e RLS con JWT reali;
   - dashboard collegata a dati reali (qui solo con dati simulati per le schermate).
3. Invio email reale (Resend/Brevo, SPF/DKIM, consegna e spam) e Scheduled Function dei promemoria su Netlify.
4. OpenAI reale: qualità e lingua delle risposte, tempi, parametri del modello scelto, consumi confrontati con il pannello OpenAI.
5. Deploy Netlify, HTTPS, dominio, variabili a runtime.
6. Safari reale (iPhone, iPad, Mac): installazione PWA, VoiceOver e TalkBack, tastiere virtuali.
7. Revisione legale di informativa privacy, informativa AI e DPA con i fornitori.

## Come ripetere i test

```bash
npm install && npx playwright install chromium
npm run test:unit
npm run build
# PostgreSQL LOCALE (mai Supabase): PGHOST/PGPORT/PGUSER/PGPASSWORD
npm run test:integration      # scenari 1-13, Maylana AI, template email
npm run test:e2e              # browser: chat AI, offline (14), route e build (15)
# Progetto Supabase di TEST:
export DATABASE_URL="postgresql://…"   # progetto di test, mai produzione
npm run test:db && npm run test:security && npm run test:concurrency
```
