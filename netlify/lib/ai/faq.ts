/**
 * FAQ approvate dal salone: risposta locale (senza chiamare OpenAI) per le
 * domande semplici e selezione delle poche FAQ pertinenti da passare al
 * modello come contesto (riduce i token trasmessi).
 */
export interface Faq {
  id: string;
  topic: string;
  language: 'it' | 'en';
  question: string;
  answer: string;
  keywords: string[];
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(
  'il lo la i gli le un uno una di a da in con su per tra fra e o ma che chi cosa come quale quali quanto quanta quanti quante dove quando del dello della dei degli delle al allo alla ai agli alle dal dalla nel nella sul sulla mi ti ci vi si se non piu anche avete fate fai potete posso vorrei sono siete e the a an of to is are do you your what how much'.split(
    ' ',
  ),
);

/** Termini che indicano una richiesta operativa: servono strumenti, non una FAQ. */
const NEEDS_TOOLS =
  /\b(prenot|appuntament|disponib|liber|orari?o?|oggi|domani|dopodomani|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|settimana|mattin|pomerigg|sera|alle|book|available|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday)\w*/;

function keywordHits(text: string, f: Faq): number {
  const t = ` ${text} `;
  let hits = 0;
  for (const k of f.keywords) {
    const kk = normalize(k);
    if (kk && t.includes(` ${kk} `)) hits += kk.includes(' ') ? 2 : 1;
    else if (kk.length >= 5 && t.includes(` ${kk}`)) hits += 1; // radice: "protes" → "protesi"
  }
  return hits;
}

function overlap(text: string, f: Faq): number {
  const words = new Set(text.split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
  const q = normalize(f.question).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
  if (!q.length) return 0;
  const common = q.filter((w) => words.has(w)).length;
  return common / q.length;
}

export interface FaqMatch {
  faq: Faq;
  score: number;
}

export function rankFaq(message: string, faqs: Faq[], lang: 'it' | 'en'): FaqMatch[] {
  const text = normalize(message);
  return faqs
    .filter((f) => f.language === lang || faqs.every((x) => x.language !== lang))
    .map((faq) => ({ faq, score: keywordHits(text, faq) + overlap(text, faq) * 2 }))
    .filter((m) => m.score >= 1)
    .sort((a, b) => b.score - a.score);
}

/**
 * Risposta locale solo se la domanda è breve, non operativa e la FAQ è
 * chiaramente la più pertinente.
 */
export function localFaqAnswer(message: string, faqs: Faq[], lang: 'it' | 'en'): Faq | null {
  const text = normalize(message);
  if (!text || NEEDS_TOOLS.test(text)) return null;
  const words = text.split(' ').length;
  if (words > 14) return null;
  const ranked = rankFaq(message, faqs, lang);
  const best = ranked[0];
  if (!best) return null;
  const second = ranked[1]?.score ?? 0;
  const clear = best.score >= 2.5 || (best.score >= 1.5 && words <= 6);
  return clear && best.score - second >= 1 ? best.faq : null;
}

/** Al massimo N FAQ pertinenti da dare al modello (più quelle Capelli For You se se ne parla). */
export function faqContext(message: string, faqs: Faq[], lang: 'it' | 'en', n = 3): Faq[] {
  const picked = rankFaq(message, faqs, lang).slice(0, n).map((m) => m.faq);
  const text = normalize(message);
  if (/\b(protes|consulenz|capelli for you|parrucc|toupet|diradament|calvizie|hair system)/.test(text)) {
    for (const f of faqs) {
      if (picked.length >= n + 3) break;
      if (f.topic === 'capelli_for_you' && !picked.includes(f)) picked.push(f);
    }
  }
  return picked;
}
