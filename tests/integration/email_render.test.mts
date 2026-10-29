// Render dei template email: tutti i tipi, ora legale/solare, larghezza 360px (Playwright).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { renderEmail, type NotificationContext } from '../../netlify/lib/email/templates';
let fails = 0;
const check = (n: string, c: boolean, x = '') => { console.log(`${c ? '✓' : '✗'} ${n} ${x}`); if (!c) fails++; };
const settings = { business_name: 'Maylana Coiffeur', logo_url: null, address: 'Via di Prova 1, Palagiano', contact_phone: '000 0000000', contact_email: 'info@example.invalid', email_instructions: 'Arriva 5 minuti prima.', customer_change_min_hours: 24 };
const appt = (starts: string, cat: 'hair' | 'consultation' = 'hair') => ({ id: 'a1', code: 'MY-TEST01', status: 'confirmed', starts_at: starts, ends_at: new Date(new Date(starts).getTime() + 75 * 60000).toISOString(), service_name: cat === 'hair' ? 'Taglio donna + Shampoo e piega' : 'Consulenza protesi capillari donna', category: cat, staff_name: 'Operatore Uno', total_price_cents: cat === 'hair' ? 4000 : null, price_is_estimate: false });
const req = (cat: 'hair' | 'consultation', proposed: string | null = null) => ({ id: 'r1', code: 'RQ-TEST01', status: 'pending', service_name: cat === 'hair' ? 'Balayage' : 'Consulenza protesi capillari donna', category: cat, preferred_date: '2027-07-12', preferred_time_window: 'mattina', proposed_starts_at: proposed, proposed_staff_name: proposed ? 'Operatore Uno' : null });
const base = { id: 'n1', audience: 'customer' as const, data: {}, recipient: 'cliente@example.invalid', customer_first_name: 'Giulia', valid: true, invalid_reason: null, needs_link: true, settings, appointment: null, request: null };
const SUMMER = '2027-07-10T08:30:00Z'; // 10:30 a Roma (CEST)
const WINTER = '2027-01-15T09:00:00Z'; // 10:00 a Roma (CET)
const cases: [string, NotificationContext, string | null][] = [
  ['conferma prenotazione (estate)', { ...base, kind: 'booking_confirmed', appointment: appt(SUMMER) } as any, '10:30'],
  ['conferma prenotazione (inverno)', { ...base, kind: 'booking_confirmed', appointment: appt(WINTER) } as any, '10:00'],
  ['richiesta consulenza ricevuta', { ...base, kind: 'request_received', request: req('consultation') } as any, null],
  ['consulenza approvata', { ...base, kind: 'request_approved', appointment: appt(SUMMER, 'consultation') } as any, '10:30'],
  ['richiesta rifiutata', { ...base, kind: 'request_rejected', request: { ...req('consultation'), status: 'rejected' } } as any, null],
  ['proposta nuova data', { ...base, kind: 'request_proposal', request: req('hair', WINTER) } as any, '10:00'],
  ['riprogrammazione', { ...base, kind: 'appointment_rescheduled', appointment: appt(WINTER) } as any, '10:00'],
  ['cancellazione', { ...base, kind: 'appointment_cancelled', needs_link: false, appointment: { ...appt(SUMMER), status: 'cancelled' } } as any, '10:30'],
  ['promemoria', { ...base, kind: 'reminder', appointment: appt(SUMMER) } as any, '10:30'],
];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 360, height: 800 } })).newPage();
for (const [name, ctx, time] of cases) {
  const m = renderEmail(ctx, { manageUrl: 'https://prenota.example.invalid/gestisci#t=TOKEN', adminUrl: null });
  const file = `test-results/email/${name.replace(/\W+/g, '-')}.html`;
  fs.writeFileSync(file, m.html);
  await page.goto('file://' + path.resolve(file));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const small = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length);
  const okTime = time === null || (m.html.includes(time) && m.text.includes(time));
  const cons = ctx.request?.category === 'consultation' || ctx.appointment?.category === 'consultation';
  const discreet = !cons || !/protesi/i.test(m.subject + m.html + m.text);
  check(`${name}: oggetto, html e testo`, !!m.subject && m.html.length > 200 && m.text.length > 50, `«${m.subject}»`);
  check(`${name}: nessuno scorrimento orizzontale a 360px, testo ≥ 12px`, over <= 0 && small === 0, `over=${over} piccoli=${small}`);
  check(`${name}: orario corretto (Europe/Rome)`, okTime, time ?? 'n/a');
  check(`${name}: consulenza senza dettagli del servizio`, discreet);
  if (name.startsWith('conferma prenotazione (estate)') || name === 'richiesta consulenza ricevuta') await page.screenshot({ path: `test-results/email/${name.replace(/\W+/g, '-')}.png`, fullPage: true });
}
await browser.close();
console.log(fails ? `\n❌ ${fails} controlli email falliti` : '\n✅ Template email verificati (rendering locale, nessun invio reale)');
process.exit(fails ? 1 : 0);
