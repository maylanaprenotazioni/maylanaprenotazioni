# Consegna finale — Maylana Coiffeur Booking 1.0.0-rc.1

Web app PWA **indipendente** dal sito vetrina di Maylana Coiffeur (Palagiano, TA): prenotazioni online, consulenze Capelli For You su approvazione, dashboard, email, link WhatsApp manuali e assistente Maylana AI (facoltativo).

> **Stato: release candidate, NON ancora pubblicata.** Il codice è stato verificato in locale (vedi [REPORT_TEST.md](REPORT_TEST.md)). La build ufficiale, Supabase, email, OpenAI e Netlify reali non erano raggiungibili da questo ambiente, quindi la checklist del §15 resta interamente da spuntare da parte tua.

---

## 1. Codice aggiornato

Archivio `maylana-booking-v1.0.0-rc.1.zip`. Struttura e funzioni sono nel [README](../README.md).

## 2. File modificati in questa fase (Prompt 5)

Nessuna nuova funzione commerciale: solo correzioni, test e configurazione.

| File | Modifica |
|---|---|
| `src/components/ErrorBoundary.tsx` (nuovo) | niente più pagina bianca se un modulo non si carica; la chat in errore non blocca la prenotazione |
| `src/App.tsx` | usa l'ErrorBoundary |
| `src/pages/BookingPage.tsx` | ErrorBoundary per la chat; ripresa del modulo con sole scelte non sensibili; messaggio quando una categoria (es. consulenze) è vuota; avviso informativo (non errore) |
| `src/lib/supabase.ts` | messaggi in italiano per connessione assente e 11 codici d'errore |
| `src/pages/admin/AdminApp.tsx` | menu inferiore e intestazione adatti a 320 px; menu su più righe sui tablet; badge 11 px |
| `src/pages/admin/Agenda.tsx` | barra degli strumenti che va a capo su schermi stretti |
| `netlify.toml` | `/api/*` inesistenti → 404 JSON, prima del fallback SPA |
| `public/api-404.json` (nuovo) | risposta JSON per le API inesistenti |
| `scripts/build-sw.mjs` | esclude `api-404.json` dalla cache offline |
| `supabase/tests/security_audit.sql` (nuovo) | audit automatico di RLS, grant e policy (`npm run test:security`) |
| `supabase/rollback/20261030000010_ai_assistant.down.sql` (nuovo) | rollback della migrazione AI |
| `tests/integration/*` (nuovo) | scenari 1-13, Maylana AI, email, E2E browser (offline, route, chat), con script `run.sh` che **rifiuta** Supabase cloud |
| `package.json` | versione 1.0.0-rc.1; script `test:security`, `test:integration`, `test:e2e`; devDependencies `playwright`, `tsx` |
| `.env.example` | dominio d'esempio sostituito da segnaposto |
| `.gitignore` | `test-results/` |
| `docs/CONSEGNA.md`, `docs/REPORT_TEST.md` (nuovi), `README.md` | documentazione |

## 3. Migrazioni SQL

**Nessuna nuova migrazione in questa fase.** Le migrazioni da applicare in ordine (incrementali) sono:

| File | Contenuto |
|---|---|
| `20261028000001` → `003` | schema, funzioni, sicurezza (v0.1) |
| `20261029000004` → `006` | nomi, notifiche, token, audit (v0.2) |
| `20261029000007` → `009` | servizi multipli, orari del salone, consigliati (v0.3) |
| `20261030000010` | Maylana AI (v0.4) — rollback in `supabase/rollback/` |

## 4. Configurazione Netlify

`netlify.toml`, già nel progetto:

| Voce | Valore |
|---|---|
| Build command | `npm run build` (tsc + Vite + generazione `sw.js`) |
| Publish directory | `dist` |
| Functions | `netlify/functions` (esbuild), Node 22 |
| Redirect | `/` → `/prenota` (302); `/api/*` inesistenti → 404 JSON; `/*` → `/index.html` (fallback SPA) |
| Header | CSP, HSTS, `X-Frame-Options`, `noindex` + `no-store` per `/admin` e `/gestisci`, `sw.js` mai in cache |

**API.** Ogni API è una Netlify Function con `path` dichiarato nel codice, per esempio `config.path = '/api/book'`. Netlify esegue queste funzioni prima dei redirect, quindi il fallback SPA non le intercetta. Lo scenario 15 lo verifica con le regole emulate.

**Funzione schedulata.** `notifications-scheduled` (promemoria, nuovi tentativi email, pulizia sessioni AI) gira ogni 10 minuti, solo sul deploy di produzione.

## 5. Variabili da configurare

Su Netlify → *Site configuration → Environment variables*. Le variabili segrete vanno marcate *Secret* e con scope che includa **Functions**.

| Variabile | Obbligatoria | Dove si usa | Note |
|---|---|---|---|
| `VITE_SUPABASE_URL` | sì | browser (build) | URL del progetto Supabase |
| `VITE_SUPABASE_ANON_KEY` | sì | browser (build) | chiave **pubblica** (anon/publishable), protetta dalla RLS |
| `SUPABASE_URL` | sì | functions | stesso URL |
| `SUPABASE_SERVICE_ROLE_KEY` | sì | functions | **segreta** (service_role o `sb_secret_…`) |
| `RATE_LIMIT_SALT` | sì | functions | ≥ 16 caratteri casuali (`openssl rand -hex 32`) |
| `PUBLIC_SITE_URL` | consigliata | functions | URL pubblico della web app (link nelle email) |
| `ALLOWED_ORIGINS` | se dominio personalizzato | functions | origini aggiuntive, separate da virgola |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | per le email | functions | §8 |
| `AI_ENABLED`, `OPENAI_API_KEY`, `OPENAI_MODEL` | solo per Maylana AI | functions | §7 |
| `AI_TIMEOUT_MS`, `AI_DEADLINE_MS`, `OPENAI_REASONING_EFFORT`, `OPENAI_INCLUDE_REASONING`, `AI_SESSION_SECRET` | facoltative | functions | `.env.example` |
| `WHATSAPP_*` | no (modulo disattivato) | functions | solo per una futura attivazione ufficiale |

**Regole per le chiavi:**
- Le variabili `VITE_*` finiscono nel bundle pubblico: **mai chiavi segrete con quel prefisso**.
- Le variabili server sono lette a ogni richiesta: dopo una modifica serve un nuovo deploy (*Deploys → Trigger deploy*).

## 6. Istruzioni Supabase

1. Crea **due progetti** (regione UE): uno di **test** e uno di **produzione**.
2. Su ciascuno, *SQL Editor* → esegui le migrazioni 001…010 in ordine (oppure `supabase db push`). Facoltativo: `seed.sql` (catalogo iniziale **disattivo**, senza prezzi né durate inventati).
3. *Authentication → Providers/Settings*: **disattiva le registrazioni pubbliche**.
4. *Authentication → Users*: crea l'utente del titolare, poi nel SQL Editor:
   ```sql
   insert into public.admin_users (user_id, role, display_name) values ('UUID-UTENTE', 'owner', 'Titolare');
   -- collaboratori: role = 'staff'
   ```
5. *Authentication → URL Configuration*: Site URL = indirizzo della web app.
6. Sul progetto di **test**:
   ```bash
   export DATABASE_URL="postgresql://postgres:…@db.<ref-test>.supabase.co:5432/postgres"
   npm run test:db && npm run test:security && npm run test:concurrency
   ```
   Su **produzione** esegui solo `npm run test:security`, che è in sola lettura.
7. Attiva i backup e, se il piano lo consente, il Point-in-Time Recovery.
8. Configura dalla dashboard: operatori e turni, servizi (durate, prezzi, modalità automatica o su richiesta), orari del salone, ferie e chiusure, impostazioni (recapiti, URL dell'informativa privacy, numero WhatsApp).

**Nota sulle modalità del catalogo iniziale:**
- *taglio uomo/donna* e *shampoo e piega* sono automatici;
- *colore, meches, balayage, trattamenti, acconciature* e tutte le consulenze sono **su richiesta**.

La modalità si cambia per servizio dalla dashboard, per esempio se Maylana vuole il colore prenotabile in automatico.

## 7. Istruzioni OpenAI (facoltativo)

Dettagli in [MAYLANA_AI.md](MAYLANA_AI.md).
1. Crea un progetto dedicato su platform.openai.com.
2. Imposta un **limite di spesa mensile** e crea una chiave API.
3. Su Netlify imposta `AI_ENABLED=true`, `OPENAI_API_KEY` (Secret) e `OPENAI_MODEL`. Scegli un modello piccolo con chiamata di funzioni, verificando nome e prezzo sul listino.
4. Nuovo deploy.
5. Dashboard → Maylana AI:
   - verifica lo stato "configurato";
   - inserisci i prezzi del modello e i limiti;
   - scrivi le FAQ approvate;
   - **attiva**.
6. Esegui le verifiche reali elencate in MAYLANA_AI.md §5.

Per spegnere l'assistente: interruttore in dashboard, effetto immediato. Le prenotazioni continuano normalmente.

## 8. Istruzioni email

1. Crea un account **Resend** o **Brevo** e **verifica il dominio del mittente** (record SPF e DKIM nel DNS del dominio di Maylana: serve l'accesso a quel DNS).
2. Su Netlify imposta:
   - `EMAIL_PROVIDER` = `resend` oppure `brevo`;
   - `EMAIL_API_KEY` (Secret);
   - `EMAIL_FROM` = `Maylana Coiffeur <indirizzo@dominio-verificato>`;
   - facoltativo `EMAIL_REPLY_TO`.
3. Dashboard → Impostazioni: email del salone per gli avvisi, istruzioni, ore dei promemoria.
4. Prova reale, con un indirizzo tuo:
   - prenota;
   - invia una richiesta di consulenza, poi approvala e rifiutala;
   - sposta e annulla;
   - attendi il promemoria (la funzione schedulata gira ogni 10').
5. Per ogni email controlla destinatario, data e ora, link "Gestisci" e cartella spam.

**Senza provider configurato:**
- le prenotazioni funzionano;
- le email risultano "non inviate" con il motivo in Panoramica;
- partono nuovi tentativi automatici con backoff, senza duplicati.

**WhatsApp:** solo link `wa.me` manuali (l'invio lo fa una persona). L'integrazione ufficiale WhatsApp Business **non è attiva**.

## 9. Test eseguiti

Vedi **[REPORT_TEST.md](REPORT_TEST.md)**:
- scenari 1-14: PASS;
- scenario 15: build ufficiale NON ESEGUITA, navigazione delle route PASS;
- audit di sicurezza validato con difetti introdotti apposta;
- 7 dispositivi emulati.

## 10. Problemi ancora presenti e rischi noti

1. **Build ufficiale non verificata.** `npm install` / `npm run build` non sono stati eseguibili qui. Il controllo dei tipi usa dichiarazioni semplificate di React e Supabase, quindi la build può segnalare errori di tipo nuovi. Correggili prima del deploy: Netlify non pubblica una build fallita.
2. **Servizi esterni mai provati dal vivo**: Supabase cloud, provider email, OpenAI, Netlify (Functions, Scheduled Function, variabili).
3. **Safari/WebKit non testato** (solo Chromium con viewport e user agent emulati). Da provare su iPhone, iPad e Mac reali, inclusa l'installazione PWA.
4. **Icone e logo**: le icone dell'app sono un monogramma generato; vanno sostituite con il logo ufficiale (`public/icons/monogram.svg` + `npm run icons`, oppure i PNG).
5. **Testi legali**: informativa privacy (prenotazioni, email, link personale, AI) da far verificare. La bozza AI è in `docs/INFORMATIVA_AI_BOZZA.md`.
6. **Dati del salone**: orari, prezzi, durate, recapiti e contenuti Capelli For You **non sono inseriti**, per non inventarli; vanno compilati dalla dashboard.
7. **Rollback delle migrazioni 001–009**: non esistono script di rollback, perché trasformano dati. In caso di problemi si ripristina il backup (§14).
8. **Duplicazione minore**: il modulo dati esiste sia nella procedura classica sia nella chat. Non unificato, per non toccare componenti funzionanti.

## 11. Istruzioni di pubblicazione

1. **GitHub**: crea un repository privato e carica il progetto. `.env` e `node_modules` sono esclusi da `.gitignore`.
2. **In locale** (Mac/PC con Node 22):
   ```bash
   npm install
   npm run typecheck && npm run test:unit && npm run build
   ```
   Se `typecheck` o `build` segnalano errori, correggili prima di proseguire.
3. **Netlify** → *Add new project → Import from Git*: le impostazioni di build sono lette da `netlify.toml`.
4. Inserisci le variabili del §5. Collega prima Supabase di **test** per un **Deploy Preview** (ramo o PR).
5. Sul deploy di anteprima esegui le prove manuali (README §8) e la checklist del §15.
6. Passa le variabili al progetto Supabase di **produzione** e pubblica il ramo principale.
7. **Dominio**: *Domain management* → aggiungi un sottodominio del dominio di Maylana, per esempio `prenota.<dominio-di-maylana>` (richiede accesso al DNS). HTTPS è automatico. Poi aggiorna `PUBLIC_SITE_URL` e `ALLOWED_ORIGINS` e ripubblica.
8. Verifica la *Scheduled Function* in *Logs → Functions* (dopo 10').

## 12. Collegamento al sito Maylana

Il sito esistente **non è stato modificato** e il suo dominio non è noto. Sostituisci `INDIRIZZO-WEB-APP` con l'URL reale della web app, cioè il dominio Netlify o il sottodominio scelto.

**Pulsante "Prenota online"** (HTML da inserire dove il gestore del sito lo consente):
```html
<a href="https://INDIRIZZO-WEB-APP/prenota"
   style="display:inline-block;padding:14px 28px;border-radius:999px;background:#1D1A17;color:#F7F2E8;font:500 16px/1 system-ui,sans-serif;text-decoration:none">
  Prenota online
</a>
```

**Sezione Capelli For You** (apre direttamente le consulenze):
```html
<a href="https://INDIRIZZO-WEB-APP/prenota?sezione=capelli-for-you">Richiedi una consulenza Capelli For You</a>
```

Con un costruttore di siti (WordPress, Wix, Squarespace…) usa un elemento "Pulsante" con link esterno a questi indirizzi.

**Social e Google.** Le voci dei menu possono cambiare: verifica sull'app.
- **Facebook** (Pagina) → *Modifica pulsante d'azione* → "Prenota ora" / "Prenota con…" → "Link a un sito web": `https://INDIRIZZO-WEB-APP/prenota`.
- **Instagram** → *Modifica profilo* → *Link*: aggiungi `https://INDIRIZZO-WEB-APP/prenota`. Nei post e nelle storie usa lo sticker "Link".
- **Google (Profilo dell'attività)** → *Modifica profilo* → *Prenotazioni* / "Link per prenotare": `https://INDIRIZZO-WEB-APP/prenota`. La disponibilità dipende dalla categoria dell'attività e dalle politiche di Google.
- **QR code** in salone: genera un QR verso `https://INDIRIZZO-WEB-APP/prenota`.

## 13. Installare la PWA

| Dispositivo | Procedura |
|---|---|
| **iPhone / iPad** (Safari) | apri l'indirizzo → pulsante **Condividi** → **Aggiungi alla schermata Home** → Aggiungi. Su iOS/iPadOS 16.4+ funziona anche da Chrome/Edge tramite Condividi |
| **Android** (Chrome) | apri l'indirizzo → menu **⋮** → **Installa app** (o "Aggiungi a schermata Home") → Installa. Può comparire anche il banner automatico |
| **Tablet Android** | come Android |
| **Mac** (Safari 17+) | menu **File → Aggiungi al Dock** |
| **Mac / Windows** (Chrome o Edge) | icona **Installa** nella barra degli indirizzi, oppure menu → *Trasmetti, salva e condividi → Installa pagina come app* (Chrome) / *App → Installa questo sito come app* (Edge) |

**Due app separate:**
- l'app dei clienti si apre su `/prenota`;
- installata da `/admin`, l'app del salone si apre sull'agenda.

**Comportamento offline:**
- l'app si apre e mostra un avviso;
- **le prenotazioni non sono possibili offline**;
- nessun dato personale è conservato nella cache.

## 14. Rollback in caso di errori

| Problema | Azione | Tempo |
|---|---|---|
| Nuovo deploy difettoso | Netlify → *Deploys* → scegli l'ultimo deploy funzionante → **Publish deploy**. Il sito torna subito alla versione precedente. Poi correggi su Git (`git revert`) | 1 minuto |
| Problemi con Maylana AI | dashboard → Maylana AI → disattiva (oppure `AI_ENABLED=false` e nuovo deploy) | immediato |
| Email errate o in eccesso | rimuovi `EMAIL_PROVIDER` e ripubblica: le email restano in coda come "non inviate", nessun dato perso | 2 minuti |
| Migrazione 010 da annullare | `supabase/rollback/20261030000010_ai_assistant.down.sql` (rimuove solo le tabelle AI; testato) | minuti |
| Errore su dati o migrazioni 001–009 | Supabase → *Database → Backups*: ripristina il backup o il punto nel tempo precedente. **Prima di ogni migrazione fai un backup manuale** | dipende dal piano |
| Chiave esposta per errore | revoca subito la chiave (Supabase, OpenAI, provider email), creane una nuova, aggiorna Netlify e ripubblica | minuti |
| Prenotazioni online da sospendere | dashboard → Impostazioni → disattiva le prenotazioni online (la pagina mostra il telefono del salone) | immediato |

## 15. Checklist di verifica finale

Nessuna voce è spuntata: ognuna va verificata sull'ambiente reale. La colonna "Verifica locale" indica solo cosa è stato provato qui.

| | Voce | Verifica locale (questo ambiente) |
|---|---|---|
| [ ] | Build senza errori (`npm run build`) | **non eseguita** (npm bloccato) |
| [ ] | Supabase collegato (test e produzione) | non disponibile |
| [ ] | Migrazioni 001–010 applicate | PASS su PostgreSQL locale |
| [ ] | RLS verificata (`npm run test:security` su Supabase) | PASS su PostgreSQL locale |
| [ ] | Admin funzionante (login reale, titolare e staff) | permessi PASS in SQL; interfaccia solo con dati simulati |
| [ ] | Servizi configurati (durate, prezzi, modalità) | da fare dal salone |
| [ ] | Orari configurati (salone, turni, chiusure) | da fare dal salone |
| [ ] | Operatori configurati | da fare dal salone |
| [ ] | Prenotazione automatica verificata | PASS in locale (scenari 1-3, 10) |
| [ ] | Consulenza manuale verificata | PASS in locale (scenari 4-6) |
| [ ] | Email verificate (consegna reale di tutti i tipi) | solo rendering e coda con provider simulato |
| [ ] | AI verificata oppure disattivata | PASS con modello simulato; reale da fare |
| [ ] | PWA installabile (Android, iPhone, desktop) | PASS su Chromium; dispositivi reali da fare |
| [ ] | Test mobile completati su dispositivi reali | solo emulazione (7 dispositivi) |
| [ ] | Privacy verificata (informativa, AI, DPA) | bozze pronte, revisione legale da fare |
| [ ] | Netlify pubblicato (HTTPS, dominio, funzione schedulata attiva) | non disponibile |
| [ ] | Link dal sito vetrina, Facebook, Instagram, Google configurati | snippet pronti (§12) |

**Cosa manca per completare da qui:**
- accesso al registro npm;
- credenziali di un progetto Supabase di test;
- account del provider email con dominio verificato;
- (facoltativa) chiave OpenAI;
- account Netlify / GitHub;
- dominio e accesso al DNS di Maylana.

Con questi accessi si possono eseguire i passi dei §6–§11.
