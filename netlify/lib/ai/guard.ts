/**
 * Protezioni sul testo in ingresso e in uscita di Maylana AI.
 *
 * Ingresso: pulizia, limite di lunghezza, minimizzazione dei dati (telefoni,
 * email e codici prenotazione non vengono inoltrati al fornitore AI).
 * Uscita: nessuna conferma di prenotazione nel testo del modello (le conferme
 * arrivano solo dal backend), solo testo semplice, lunghezza massima.
 */

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

export function cleanUserText(s: string, maxChars: number): string {
  return s.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Sequenze di 7+ cifre con separatori comuni: numeri di telefono e simili
const PHONE_RE = /(?:\+|00)?\d[\d\s().\/-]{5,}\d/g;
// Date (14/11/2026, 2026-11-14, 14.11.26): non sono numeri di telefono
const DATE_LIKE = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})$/;
const CODE_RE = /\b(?:MY|RQ)-[A-Z0-9]{6}\b/gi;
const TOKEN_RE = /[A-Za-z0-9_-]{32,}/g;

/**
 * Dati che non servono al modello e non devono uscire verso il fornitore AI.
 * Le date (es. 12/11) e gli orari restano invariati: hanno meno di 7 cifre.
 */
export function redactForModel(s: string): { text: string; redacted: boolean } {
  let redacted = false;
  const mark = (label: string) => () => {
    redacted = true;
    return label;
  };
  const text = s
    .replace(EMAIL_RE, mark('[email omessa]'))
    .replace(TOKEN_RE, mark('[codice omesso]'))
    .replace(CODE_RE, mark('[codice prenotazione omesso]'))
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 7 && !DATE_LIKE.test(m.trim()) ? mark('[numero omesso]')() : m));
  return { text, redacted };
}

/** Mascheramento per i log tecnici. */
export function maskForLog(s: string): string {
  return redactForModel(String(s)).text.slice(0, 200);
}

/**
 * Tentativi tipici di manipolazione: usati solo per statistiche e per la
 * risposta locale; la vera protezione è architetturale (il modello non ha
 * strumenti di scrittura né accesso a dati di altri clienti).
 */
const INJECTION_PATTERNS = [
  /ignora (tutte )?le (tue )?(istruzioni|regole)/i,
  /ignore (all |your |previous |the )*(instructions|rules)/i,
  /system prompt|prompt di sistema|developer message/i,
  /(mostra|rivela|dimmi|stampa).{0,30}(istruzioni|prompt|chiave|api key|password)/i,
  /(reveal|print|show).{0,30}(instructions|prompt|api key|password)/i,
  /sei (ora|adesso) (un|una|in modalit)/i,
  /you are now|act as|jailbreak|DAN mode/i,
];

export function looksLikeInjection(s: string): boolean {
  return INJECTION_PATTERNS.some((r) => r.test(s));
}

/** Richieste di vedere/modificare appuntamenti esistenti: si risponde senza modello. */
export function asksAboutExistingBooking(s: string): boolean {
  const t = s.toLowerCase();
  return (
    /(mi[ao]|il|l'|un|del|nostro|suo|di) ?(appuntament|prenotazion)/.test(t) &&
    /(annull|cancell|spost|modific|cambi|vedere|controll|verific|quando (ho|è)|che ora|a che ora|disdir)/.test(t)
  ) || /(appuntament|prenotazion).{0,40}(di|del|della) (mia |mio )?(moglie|marito|amic|madre|padre|sorell|fratell|cliente|signor)/.test(t);
}

/** Frasi con cui il modello potrebbe dichiarare un'azione che non ha compiuto. */
const FALSE_ACTION_PATTERNS = [
  /[^.!?\n]*\b(il tuo|l'|il) ?appuntamento (è|e') (stato )?(confermato|prenotato|registrato|fissato|salvato)[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\b(ho|abbiamo) (già )?(prenotato|confermato|registrato|fissato|salvato|inviato)[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\bprenotazione (è )?(stata )?(confermata|effettuata|completata|registrata)[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\brichiesta (è )?(stata )?(inviata|registrata|approvata|confermata)[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\b(your )?(appointment|booking) (is|has been) (confirmed|booked|scheduled)[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\bI (have )?(booked|confirmed|scheduled)[^.!?\n]*[.!?]?/gi,
];

export function guardModelOutput(text: string, maxChars = 1200): { text: string; removedClaims: number } {
  let removedClaims = 0;
  let out = text.replace(CONTROL, '');
  for (const re of FALSE_ACTION_PATTERNS) {
    out = out.replace(re, () => {
      removedClaims++;
      return '';
    });
  }
  // Solo testo semplice: niente HTML, niente link markdown verso siti esterni.
  out = out
    .replace(/<[^>]{1,200}>/g, '')
    .replace(/\[([^\]]{1,80})\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (removedClaims > 0) {
    out = `${out}${out ? '\n\n' : ''}Nota: dalla chat non viene registrato nulla finché non confermi il riepilogo e il sistema non mostra l'esito.`.trim();
  }
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  return { text: out, removedClaims };
}
