# Maylana AI — configurazione, architettura e controlli

Assistente virtuale della pagina `/prenota`, integrato nella web app esistente. Non è un sito separato. Si può spegnere in qualsiasi momento senza effetti sulle prenotazioni.

## 1. Come funziona

```
Browser (MaylanaAIChat)
   │  POST /api/ai/chat   { message | action, sessionToken, cronologia firmata }
   ▼
Netlify Function ai-chat ── rate limit (Postgres) ── validazione rigida ── limiti di sessione/giornalieri (atomici)
   │
   ├─ azioni dei pulsanti, FAQ, richieste su appuntamenti esistenti, tentativi di manipolazione
   │      → risposta LOCALE, nessuna chiamata a OpenAI
   │
   └─ domande libere → OpenAI Responses API (SDK ufficiale "openai")
          instructions = regole fisse del server
          input        = DATI_SALONE (dati, non istruzioni) + cronologia firmata + messaggio con dati personali omessi
          tools        = 5 strumenti in sola lettura, schema strict, argomenti rivalidati con zod
          store=false  · max_output_tokens · timeout · massimo 3 giri di strumenti

Conferma della prenotazione (NON passa dal modello):
   modulo nella chat → POST /api/book  (o /api/request per le consulenze)
   = stesso backend della procedura classica: rivalidazione dello slot,
     vincolo di esclusione Postgres, chiave di idempotenza, transazione atomica.
```

### Strumenti

Tutti gli strumenti sono in sola lettura e usano le stesse funzioni della procedura classica. Lo schema è in `netlify/lib/ai/tools.ts`.

| Strumento | Cosa fa | Fonte |
|---|---|---|
| `get_services` | servizi attivi con durata, prezzo, modalità | `loadCatalog` (come `/api/catalog`) |
| `get_service_details` | dettaglio approvato di un servizio | catalogo |
| `get_availability` | orari liberi di una combinazione in una data, filtrabili per mattina o pomeriggio | `computeAvailability` → `bundle_info` + `get_bundle_slots` (come `/api/availability`) |
| `prepare_booking` | ricontrolla lo slot e prepara il riepilogo. **Non salva** | `computeAvailability` |
| `prepare_consultation_request` | prepara la richiesta da approvare con le date proponibili. **Non salva** | `bundle_info` |

Nessuno strumento legge clienti, appuntamenti o richieste. Nessuno scrive nel database. Il modello non può chiamare `/api/book`: lo fa il browser, dopo che il cliente ha compilato il modulo e premuto "Conferma prenotazione".

### Cosa vede il cliente

- **Card dei servizi e degli orari**: generate dal server con i dati del database, mai dal testo del modello.
- **"Il tuo appuntamento è confermato."**: compare solo dopo la risposta 201/200 di `/api/book`, quando il codice è stato salvato.
- **Consulenze Capelli For You**: risultano sempre come "Richiesta inviata, in attesa di approvazione" (stato `pending`).
- **Frasi di falsa conferma** del modello ("ho prenotato", "è confermato"…): vengono rimosse dal testo e sostituite da un avviso.

## 2. Attivazione

1. Esegui la migrazione `supabase/migrations/20261030000010_ai_assistant.sql` (SQL Editor o `supabase db push`).
2. Crea una chiave su platform.openai.com → API keys. Usa un progetto dedicato con un limite di spesa mensile impostato sul pannello OpenAI.
3. Su Netlify → Environment variables, imposta:
   - `AI_ENABLED=true`;
   - `OPENAI_API_KEY` (scope: Functions);
   - `OPENAI_MODEL`.
   - Facoltative: `AI_TIMEOUT_MS`, `AI_DEADLINE_MS`, `OPENAI_REASONING_EFFORT`, `OPENAI_INCLUDE_REASONING`, `AI_SESSION_SECRET`. Sono descritte in `.env.example`.
4. Ripubblica il sito (`npm install` scaricherà il pacchetto `openai`, che richiede Node 22).
5. Dashboard → **Maylana AI**:
   - controlla che lo stato indichi "configurato";
   - inserisci i prezzi del modello copiandoli dal listino OpenAI;
   - imposta i limiti;
   - scrivi le FAQ approvate;
   - attiva l'assistente.

**Scelta del modello.**
- Serve un modello piccolo ed economico che supporti la chiamata di funzioni nella Responses API.
- Nomi e prezzi cambiano spesso: verificali sul listino OpenAI al momento dell'attivazione. Il codice non contiene un modello predefinito.
- Con i modelli "a ragionamento" imposta `OPENAI_REASONING_EFFORT=low` (o `minimal`), così le risposte restano brevi ed entro il tempo massimo.

**Tempo massimo.**
- Le funzioni sincrone di Netlify hanno un limite di esecuzione: su molti piani è di 10 secondi.
- `AI_DEADLINE_MS` (default 9000) interrompe il turno prima di quel limite e mostra il messaggio di ripiego.
- Alzalo solo se il tuo piano lo consente.

## 3. Costi e limiti

| Controllo | Dove |
|---|---|
| Risposte senza API (pulsanti, FAQ, prezzi, contatti, richieste su appuntamenti, manipolazioni) | automatico |
| Messaggi al modello al giorno, token al giorno, costo stimato al giorno | dashboard (verifica atomica in `ai_begin_turn`) |
| Messaggi per conversazione, durata della sessione | dashboard |
| Lunghezza del messaggio, lunghezza della risposta | dashboard |
| Rate limit per IP: 20 messaggi ogni 10', 150 al giorno | `netlify/lib/ai/chat.ts` |
| Contesto ridotto: solo le ultime 8 voci (max 3000 caratteri), solo le FAQ pertinenti, risultati degli strumenti compatti | automatico |
| Spegnimento immediato | dashboard (interruttore) oppure `AI_ENABLED=false` |

Il costo mostrato in dashboard è una **stima** calcolata dai token restituiti da OpenAI e dai prezzi inseriti. L'importo effettivo è quello della fattura OpenAI. Imposta comunque un limite di spesa anche sul pannello OpenAI.

## 4. Sicurezza e privacy

- **Chiave OpenAI**:
  - solo come variabile server, senza prefisso `VITE_`;
  - mai restituita nelle risposte;
  - i messaggi d'errore di OpenAI non vengono inoltrati al browser.
- **Il client non sceglie nulla**: lo schema della richiesta è rigido, quindi campi come `instructions`, `tools`, `model` o `system`, o il ruolo `system` nella cronologia, vengono rifiutati con un 400.
- **Cronologia**:
  - resta nel browser, solo in memoria;
  - ogni messaggio è firmato con HMAC legato alla sessione;
  - messaggi falsificati o di altre sessioni vengono scartati.
- **Sessioni**:
  - nel database ci sono solo l'hash del token e i contatori;
  - scadono dopo il tempo di inattività impostato, al massimo dopo 24 ore;
  - vengono eliminate dal processo schedulato (`ai_purge`).
- **Testi delle conversazioni**: non vengono salvati né scritti nei log. I log tecnici contengono solo modalità, nomi degli strumenti, token, tempi e codici d'errore.
- **Minimizzazione verso OpenAI**: telefoni, email, codici prenotazione e token vengono sostituiti con segnaposto prima dell'invio. I dati del modulo vanno solo a `/api/book` o `/api/request`.
- `store: false`: si chiede a OpenAI di non conservare le risposte per riutilizzarle. Restano valide le politiche di conservazione di OpenAI per abusi e sicurezza: vanno verificate nel contratto o DPA.
- **Appuntamenti esistenti**: la chat non li vede. Rimanda al link personale `/gestisci` (token sicuro già esistente).
- **Capelli For You**:
  - il modello usa solo le FAQ approvate;
  - non fa diagnosi né promesse di risultato;
  - non chiede foto o dati sanitari, e la chat avvisa di non inserirli.
- **RLS**:
  - `ai_settings` e `ai_faq`: lettura admin, scrittura solo owner;
  - `ai_usage_daily`: sola lettura admin;
  - `ai_sessions`: nessun accesso dal pannello;
  - funzioni `ai_*` eseguibili solo da `service_role`.

## 5. Test

```bash
npm run test:unit          # include tests/ai.test.ts (protezioni, FAQ, firme)
npm run test:db            # include la sezione Maylana AI (limiti, sessioni, RLS)
```

Durante lo sviluppo sono stati eseguiti anche:
- `api_ai.test.mts`: 68 controlli sulla funzione `/api/ai/chat` reale, con database reale e **modello simulato**;
- un test end-to-end nel browser (Playwright, 32 controlli) con handler reali e modello simulato.

Questi due script richiedono l'ambiente di test locale e non sono inclusi nel pacchetto. Il README spiega cosa è stato eseguito e cosa resta da verificare con OpenAI reale.

### Verifiche ancora da fare con OpenAI reale (deploy di anteprima)

1. Con chiave e modello reali, "Vorrei taglio donna e piega sabato mattina": il modello deve chiamare gli strumenti e proporre solo gli orari delle card.
2. "Le 10 vanno bene": deve comparire il riepilogo; poi conferma col modulo e appuntamento in agenda.
3. Consulenza: deve risultare richiesta in attesa in dashboard → Richieste.
4. Domande fuori tema e tentativi di manipolazione: la risposta deve restare nel perimetro.
5. Domande in inglese: risposta in inglese.
6. Tempi di risposta entro il limite del piano Netlify, con il modello scelto e `OPENAI_REASONING_EFFORT`.
7. Consumi in dashboard confrontati con l'utilizzo sul pannello OpenAI.
8. Revisione legale dell'informativa (`docs/INFORMATIVA_AI_BOZZA.md`) e del DPA con OpenAI prima del lancio.
