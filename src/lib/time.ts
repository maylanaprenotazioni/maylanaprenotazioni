/**
 * Date e orari in Europe/Rome, senza dipendenze esterne.
 * Le date di calendario sono stringhe "YYYY-MM-DD"; gli istanti sono ISO UTC.
 * Le conversioni usano Intl, quindi l'ora legale è gestita correttamente.
 */
export const TZ = 'Europe/Rome';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function romeParts(instant: Date) {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(instant)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Differenza (ms) tra l'ora di Roma e UTC in un dato istante. */
function offsetMs(instant: Date): number {
  const p = romeParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Data di calendario di oggi a Roma. */
export function romeToday(now: Date = new Date()): string {
  const p = romeParts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Converte un'ora locale di Roma (data + "HH:mm") nell'istante ISO UTC. */
export function romeLocalToIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMs(new Date(guess));
  ts = guess - offsetMs(new Date(ts)); // seconda iterazione per i giorni di cambio ora
  return new Date(ts).toISOString();
}

/** Scompone un istante in data e ora di Roma. */
export function isoToRome(iso: string): { date: string; time: string } {
  const p = romeParts(new Date(iso));
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** Intervallo [inizio, fine) in UTC che copre i giorni locali richiesti. */
export function romeDaysRange(startDate: string, days = 1): { from: string; to: string } {
  return { from: romeLocalToIso(startDate, '00:00'), to: romeLocalToIso(addDays(startDate, days), '00:00') };
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 1 = lunedì … 7 = domenica */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function startOfWeek(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

/** "14:30" */
export function formatTime(iso: string): string {
  return fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** "giovedì 29 ottobre 2026" */
export function formatLongDate(iso: string): string {
  return fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** Formattazione di una data di calendario (mezzogiorno UTC: mai ambiguo). */
export function formatCalendarDate(date: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', ...opts }).format(new Date(`${date}T12:00:00Z`));
}

export function formatPrice(cents: number | null, from = false): string {
  if (cents === null || cents === undefined) return 'Prezzo in salone';
  const v = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  return from ? `da ${v}` : v;
}

export function formatDuration(min: number | null): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
