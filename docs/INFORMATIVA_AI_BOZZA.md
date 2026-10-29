# BOZZA — Integrazione dell'informativa privacy per l'assistente "Maylana AI"

> **Da verificare con un consulente privacy/legale prima del lancio.** Il testo seguente descrive il funzionamento tecnico implementato. I dati tra parentesi quadre vanno completati dal titolare. Non sostituisce l'informativa generale del salone: è una sezione da aggiungere.

---

### Assistente virtuale "Maylana AI"

**Che cos'è.**
- Sulla pagina di prenotazione è disponibile un assistente virtuale basato su intelligenza artificiale.
- Non è una persona: risponde automaticamente alle domande su servizi, prezzi e disponibilità e aiuta a preparare una prenotazione o una richiesta di consulenza.
- L'uso è facoltativo: puoi prenotare con il modulo tradizionale senza usare l'assistente.

**Titolare del trattamento.** [Ragione sociale, indirizzo, P. IVA, contatti] ("Maylana Coiffeur").

**Quali dati trattiamo e come.**
- *Messaggi scritti nella chat.*
  - Vengono inviati, tramite i nostri server, al fornitore del servizio di intelligenza artificiale per generare la risposta.
  - Prima dell'invio, eventuali numeri di telefono, indirizzi email e codici di prenotazione presenti nel testo vengono sostituiti automaticamente con segnaposto.
  - Il salone **non conserva** il testo delle conversazioni: la cronologia resta nel tuo browser solo finché la finestra è aperta.
- *Dati tecnici.*
  - Indirizzo IP, trattato in forma anonimizzata (hash) per il limite di richieste anti-abuso, conservato [fino a 2 giorni].
  - Identificativo di sessione casuale, di cui conserviamo solo una versione cifrata (hash), con il numero di messaggi e di token utilizzati, conservato fino a [24 ore + 1 giorno].
  - Statistiche aggregate giornaliere senza dati personali, conservate [fino a 13 mesi].
- *Dati per prenotare o inviare una richiesta* (nome, cognome, telefono, email, consensi):
  - si inseriscono in un modulo dedicato e vengono inviati **direttamente al sistema di prenotazione del salone, non al fornitore di intelligenza artificiale**;
  - sono trattati come descritto nella sezione "Prenotazioni" di questa informativa.

**Dati sanitari.**
- L'assistente non è progettato per trattare dati relativi alla salute: non inserire in chat informazioni sulla salute, condizioni del cuoio capelluto, terapie o foto.
- Per le consulenze Capelli For You questi aspetti si affrontano di persona.

**Finalità e base giuridica.**
- Rispondere alle tue richieste di informazioni e aiutarti a prenotare: misure precontrattuali richieste dall'interessato (art. 6.1.b GDPR).
- Sicurezza e prevenzione degli abusi del servizio: legittimo interesse (art. 6.1.f GDPR).

**Fornitore di intelligenza artificiale (responsabile del trattamento).**
- [OpenAI — denominazione dell'entità contrattuale, es. OpenAI Ireland Ltd / OpenAI, L.L.C., da verificare nel contratto], nominato responsabile del trattamento ai sensi dell'art. 28 GDPR tramite [Data Processing Addendum del DATA].
- Le richieste sono inviate con l'opzione che chiede di non conservare le risposte per riutilizzi successivi. Il fornitore può comunque conservare i dati per un periodo limitato per finalità di sicurezza e prevenzione degli abusi, secondo [riferimento alle condizioni applicabili, es. 30 giorni].
- Secondo le condizioni business del fornitore, i dati inviati tramite API [non sono utilizzati per addestrare i modelli — verificare].

**Trasferimenti extra UE.**
- [Indicare se i dati possono essere trasferiti negli Stati Uniti e la garanzia adottata: es. EU-US Data Privacy Framework e/o Clausole Contrattuali Standard — da verificare].

**Limiti dell'assistente.**
- Le risposte sono generate automaticamente e possono contenere imprecisioni.
- Servizi, prezzi, durate e orari mostrati nelle schede provengono dal sistema del salone.
- La prenotazione è valida solo quando compare la conferma con il codice; le consulenze restano richieste fino all'approvazione del salone.
- L'assistente non prende decisioni con effetti giuridici o significativi su di te: nessun processo decisionale automatizzato ai sensi dell'art. 22 GDPR.

**I tuoi diritti.**
- Puoi esercitare i diritti previsti dagli artt. 15-22 GDPR scrivendo a [email].
- Puoi proporre reclamo al Garante per la protezione dei dati personali (www.garanteprivacy.it).

---

*Nota per il titolare (da non pubblicare):*
- verificare l'informativa e gli obblighi di trasparenza sui sistemi di IA applicabili (es. AI Act, obbligo di informare che si interagisce con un sistema di IA: già indicato nell'interfaccia);
- verificare la valutazione dei rischi e la necessità di aggiornare il registro dei trattamenti;
- collegare questa sezione all'URL dell'informativa impostato in dashboard → Impostazioni, che è già mostrato nella chat.
