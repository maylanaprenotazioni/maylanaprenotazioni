// E2E MaylanaAIChat: browser reale (Playwright) + handler reali (catalogo, chat, book, request)
// su Postgres; solo il modello OpenAI è SIMULATO.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DbError } from '../../netlify/lib/db';
import { errorResponse, type Deps } from '../../netlify/lib/http';
import * as H from '../../netlify/lib/handlers';
import { aiChatHandler, aiStatusHandler } from '../../netlify/lib/ai/chat';
import type { ModelClient, ModelRequest, ModelResponse } from '../../netlify/lib/ai/model';

const DB = process.env.TESTDB || 'maylana_test';
const dir = process.env.DIST_DIR || 'dist';
function sql(q: string): any {
  try {
    const out = execFileSync('psql', ['-d', DB, '-qtA', '-v', 'ON_ERROR_STOP=1', '-c', 'set role service_role', '-c', `select set_config('request.jwt.claims','{"role":"service_role"}',false)`, '-c', q], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(out.trim().split('\n').slice(1).join('\n') || 'null');
  } catch (e: any) {
    if (e instanceof SyntaxError) throw e;
    const m = /ERROR:\s+(.+)/.exec(String(e.stderr));
    throw new DbError(m ? m[1].trim() : 'unknown', 'P0001', 400);
  }
}
const su = (q: string) => execFileSync('psql', ['-d', DB, '-qtA', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
const lit = (v: unknown): string => v === null || v === undefined ? 'null' : Array.isArray(v) ? `array[${v.map(lit).join(',')}]::uuid[]` : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const SETOF = new Set(['book_appointment', 'create_booking_request', 'get_bundle_slots', 'bundle_info', 'ai_begin_turn', 'claim_notifications']);
const db = {
  async rpc(fn: string, args: Record<string, unknown>) {
    const a = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
    if (SETOF.has(fn)) return sql(`select coalesce(json_agg(r), '[]'::json) from public.${fn}(${a}) r`);
    if (fn === 'ai_record_usage') { sql(`select json_build_object('x', (select 1 from (select public.${fn}(${a})) z))`); return null; }
    return sql(`select to_json(public.${fn}(${a}))`);
  },
  async select(p: string) {
    const t = p.split('?')[0];
    if (t === 'business_settings') return sql(`select json_agg(b) from business_settings b`);
    if (t === 'notifications') return [];
    if (t === 'services') return sql(`select coalesce(json_agg(s order by sort_order),'[]') from services s where active`);
    if (t === 'staff') return sql(`select coalesce(json_agg(json_build_object('id',s.id,'display_name',s.display_name,'bio',s.bio,'staff_services',(select coalesce(json_agg(json_build_object('service_id',service_id)),'[]') from staff_services where staff_id=s.id))),'[]') from staff s where active`);
    throw new Error('select ' + p);
  },
};

// ---- dati di prova ----
su(`update business_settings set min_notice_minutes=0, booking_horizon_days=60, address='Via di Prova 1, Palagiano', contact_phone='000 0000000', contact_email='info@example.invalid', whatsapp_number='+39 000 0000000'`);
su(`update ai_settings set enabled=true`);
su(`insert into staff(id,display_name) values ('dddddddd-0000-4000-8000-000000000001','Operatore Uno') on conflict do nothing`);
su(`update services set duration_minutes=45, price_cents=2500, description='Descrizione di prova approvata.', active=true where name='Taglio donna';
    update services set duration_minutes=30, price_cents=1500, active=true where name='Shampoo e piega';
    update services set duration_minutes=30, price_cents=1200, active=true where name='Taglio uomo';
    update services set duration_minutes=60, active=true where name in ('Consulenza protesi capillari donna','Consulenza protesi capillari uomo');
    insert into staff_services select 'dddddddd-0000-4000-8000-000000000001', id from services where active on conflict do nothing;
    insert into working_hours(staff_id,weekday,start_time,end_time) select 'dddddddd-0000-4000-8000-000000000001', d, '09:00','18:00' from generate_series(1,7) d on conflict do nothing`);
const taglio = su(`select id from services where name='Taglio donna'`);
const piega = su(`select id from services where name='Shampoo e piega'`);
const saturday = su(`select d::date::text from generate_series((now() at time zone 'Europe/Rome')::date + 2, (now() at time zone 'Europe/Rome')::date + 9, interval '1 day') d where extract(isodow from d)=6 limit 1`);

// ---- modello simulato ----
let modelDown = false;
const say = (text: string): ModelResponse => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], output_text: text, usage: { input_tokens: 800, output_tokens: 50 } });
const fc = (name: string, args: unknown): ModelResponse => ({ output: [{ type: 'function_call', call_id: 'c' + Math.random(), name, arguments: JSON.stringify(args) }], usage: { input_tokens: 700, output_tokens: 30 } });
const model: ModelClient = {
  async create(req: ModelRequest) {
    if (modelDown) throw Object.assign(new Error('down'), { status: 503 });
    const user = [...(req.input as any[])].reverse().find((i) => i.role === 'user')?.content ?? '';
    const done = (req.input as any[]).filter((i) => i.type === 'function_call_output').length;
    if (/sabato/i.test(user)) {
      if (done === 0) return fc('get_services', { group: 'donna' });
      if (done === 1) return fc('get_availability', { service_ids: [taglio, piega], date: saturday, staff_id: null, part_of_day: 'mattina' });
      return say('Ecco gli orari liberi di sabato mattina per taglio donna e piega. Quale preferisci?');
    }
    return say('Sono Maylana AI, un assistente virtuale. Posso aiutarti con servizi e prenotazioni.');
  },
};
const env = { supabaseUrl: 'https://x', serviceKey: 'sk', rateLimitSalt: 'test-salt-1234567890', allowedOrigins: ['http://maylana.test'], siteUrl: 'http://maylana.test', email: { provider: null, apiKey: '', from: '', replyTo: '' } } as any;
const aiEnv = { enabled: true, apiKey: ['sk', 'test', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-') /* chiave finta, composta a runtime per non attivare il secrets scanning */, model: 'test', timeoutMs: 4000, deadlineMs: 8000, reasoningEffort: null, includeReasoning: true, sessionSecret: 'segreto-e2e-1234567890' } as const;
let ipN = 0;
const deps = (): Deps => ({ env, db: db as any, ip: `10.7.0.${++ipN}`, fetch: (async () => { throw new Error('no fetch'); }) as any, ai: { env: { ...aiEnv }, model } });
async function handle(h: any, req: Request) {
  try { return await h(req, deps()); } catch (e) { return errorResponse(e); }
}

let fails = 0;
const check = (n: string, c: boolean, x = '') => { console.log(`${c ? '✓' : '✗'} ${n} ${x}`); if (!c) fails++; };

const browser = await chromium.launch();
async function newPage(ctxOpts: any = devices['iPhone 13']) {
  const ctx = await browser.newContext({ ...ctxOpts, locale: 'it-IT' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => m.type() === 'error' && !/status of 4\d\d|status of 503/.test(m.text()) && errors.push(m.text()));
  await page.route('**/*', async (route: any) => {
    const r = route.request();
    const url = new URL(r.url());
    const api: Record<string, any> = { '/api/catalog': H.catalogHandler, '/api/book': H.bookHandler, '/api/request': H.requestHandler, '/api/ai/chat': r.method() === 'GET' ? aiStatusHandler : aiChatHandler };
    if (api[url.pathname]) {
      const req = new Request(url.toString(), { method: r.method(), headers: r.headers(), body: r.method() === 'POST' ? r.postData() : undefined });
      const res: Response = await handle(api[url.pathname], req);
      return route.fulfill({ status: res.status, headers: { 'content-type': 'application/json' }, body: await res.text() });
    }
    const p = url.pathname.startsWith('/prenota') ? '/index.html' : url.pathname;
    const f = path.join(dir, p);
    if (fs.existsSync(f)) return route.fulfill({ path: f, contentType: p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' });
    return route.fulfill({ status: 404, body: '' });
  });
  return { page, errors, ctx };
}
const overflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// ===================================================================
// A) apertura, accessibilità da tastiera, suggerimenti
// ===================================================================
let { page, errors } = await newPage();
await page.goto('http://maylana.test/prenota');
await page.waitForSelector('text=Cosa desideri prenotare?');
const launcher = page.locator('button[aria-haspopup="dialog"]');
await launcher.waitFor({ timeout: 5000 });
check('pulsante flottante visibile con assistente attivo', await launcher.isVisible());
await page.screenshot({ path: 'test-results/ai0-pagina.png' });
await launcher.focus();
await page.keyboard.press('Enter');
const dlg = page.locator('[role="dialog"]');
await dlg.waitFor();
check('dialog accessibile (role, aria-modal, titolo)', (await dlg.getAttribute('aria-modal')) === 'true' && !!(await dlg.getAttribute('aria-labelledby')));
await page.waitForTimeout(100);
check('focus nel campo di testo all\'apertura', await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'));
check('messaggio iniziale approvato e dichiarazione di assistente virtuale', (await dlg.textContent())!.includes('Sono Maylana AI, il tuo assistente virtuale') && (await dlg.textContent())!.includes('Assistente virtuale, non una persona'));
check('conversazione annunciata agli screen reader (role=log, aria-live)', (await page.locator('[role="log"][aria-live="polite"]').count()) === 1);
for (const s of ['Prenota un taglio', 'Taglio e piega', 'Consulenza Capelli For You', 'Prezzi dei servizi', 'Contatta il salone']) check(`suggerimento "${s}"`, await dlg.locator(`button:has-text("${s}")`).isVisible());
for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
check('focus trattenuto nella finestra con Tab', await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')));
await page.screenshot({ path: 'test-results/ai1-apertura.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('Esc chiude e riporta il focus sul pulsante', (await dlg.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-haspopup'))) === 'dialog');

// ===================================================================
// B) prezzi reali dal database
// ===================================================================
await launcher.click();
await dlg.locator('button:has-text("Prezzi dei servizi")').click();
await dlg.locator('section[aria-label="Servizi"]').waitFor();
const txt = (await dlg.textContent())!;
check('prezzi mostrati = database (25 €, 15 €, 12 €)', /25\s?€/.test(txt) && /15\s?€/.test(txt) && /12\s?€/.test(txt));
check('consulenze senza prezzo → "Prezzo in salone"', txt.includes('Prezzo in salone'));
await page.waitForTimeout(700);
await page.screenshot({ path: 'test-results/ai2-prezzi.png' });

// ===================================================================
// C) prenotazione guidata: orari reali → riepilogo → modulo → conferma
// ===================================================================
const before = Number(su('select count(*) from appointments'));
await dlg.locator('textarea').fill('Vorrei taglio donna e piega sabato mattina');
await page.keyboard.press('Enter');
await dlg.locator('text=Maylana AI sta scrivendo').waitFor({ timeout: 3000 }).catch(() => {});
const slotsCard = dlg.locator('section').filter({ hasText: 'Taglio donna + Shampoo e piega' }).last();
await slotsCard.waitFor({ timeout: 8000 });
const shownTimes = await slotsCard.locator('button.tabular-nums').allTextContents();
const dbTimes = (sql(`select coalesce(json_agg(to_char(r.starts_at at time zone 'Europe/Rome','HH24:MI') order by r.starts_at),'[]') from get_bundle_slots(array['${taglio}','${piega}']::uuid[], '${saturday}'::date, null, true, null) r`) as string[]).filter((t) => Number(t.slice(0, 2)) < 13);
check('orari nella card = motore disponibilità del database', shownTimes.length > 0 && shownTimes.every((t) => dbTimes.includes(t.trim())), `${shownTimes.length} orari`);
await page.waitForTimeout(700);
await page.screenshot({ path: 'test-results/ai3-orari.png' });
const pick = shownTimes[shownTimes.length - 1].trim();
await slotsCard.locator(`button.tabular-nums:has-text("${pick}")`).first().click();
const booking = dlg.locator('section[aria-label="Riepilogo dell\'appuntamento"]');
await booking.waitFor({ timeout: 5000 });
check('riepilogo con servizi, durata 1 h 15 min, prezzo 40 €, stato "Da confermare"', /1 h 15 min/.test((await booking.textContent())!) && /40\s?€/.test((await booking.textContent())!) && /Da confermare/.test((await booking.textContent())!));
check('nessun appuntamento salvato prima della conferma', Number(su('select count(*) from appointments')) === before);
await booking.locator('button:has-text("Conferma prenotazione")').click();
check('conferma senza dati → errore, nessun salvataggio', /Inserisci nome e cognome/.test((await booking.textContent())!) && Number(su('select count(*) from appointments')) === before);
await booking.locator('label:has-text("Nome") + input, input[autocomplete="given-name"]').first().fill('Giulia');
await booking.locator('input[autocomplete="family-name"]').fill('Prova');
await booking.locator('input[autocomplete="tel"]').fill('+39 340 5551111');
await booking.locator('input[autocomplete="email"]').fill('giulia@example.invalid');
await booking.locator('input[type="checkbox"]').first().check();
await page.screenshot({ path: 'test-results/ai4-riepilogo.png' });
await page.waitForTimeout(3200); // tempo minimo anti-bot del modulo
await booking.locator('button:has-text("Conferma prenotazione")').dblclick();
await dlg.locator('text=Il tuo appuntamento è confermato.').waitFor({ timeout: 8000 });
const after = Number(su('select count(*) from appointments'));
check('"Il tuo appuntamento è confermato." solo dopo il salvataggio reale', after === before + 1);
check('doppio clic su Conferma → un solo appuntamento', after === before + 1);
const code = su(`select code from appointments order by created_at desc limit 1`);
check('codice mostrato = codice nel database', (await dlg.textContent())!.includes(code));
check('appuntamento con 2 servizi e orario scelto', su(`select count(*) from appointment_items i join appointments a on a.id=i.appointment_id where a.code='${code}'`) === '2' && su(`select to_char(starts_at at time zone 'Europe/Rome','HH24:MI') from appointments where code='${code}'`) === pick);
await page.waitForTimeout(700);
await page.evaluate(() => window.getSelection()?.removeAllRanges());
await page.screenshot({ path: 'test-results/ai5-confermato.png' });
check('nessuno scorrimento orizzontale', (await overflow(page)) <= 0);
check('nessun errore in pagina', errors.length === 0, errors.join(' | '));

// ===================================================================
// D) consulenza Capelli For You: richiesta in attesa
// ===================================================================
({ page, errors } = await newPage(devices['Pixel 7']));
await page.goto('http://maylana.test/prenota?sezione=capelli-for-you');
await page.locator('button[aria-haspopup="dialog"]').click();
const d2 = page.locator('[role="dialog"]');
check('nella sezione Capelli For You il primo suggerimento è la consulenza', ((await d2.locator('[aria-label="Suggerimenti"] button').first().textContent()) ?? '').startsWith('Consulenza'));
await d2.locator('button:has-text("Consulenza Capelli For You")').click();
await d2.locator('button:has-text("Invia una richiesta")').first().click();
const reqCard = d2.locator('section[aria-label^="Richiesta di consulenza"]');
await reqCard.waitFor({ timeout: 5000 });
const rb = Number(su('select count(*) from booking_requests')), ab = Number(su('select count(*) from appointments'));
await reqCard.locator('select').first().selectOption({ index: 1 });
await reqCard.locator('input[autocomplete="given-name"]').fill('Anna');
await reqCard.locator('input[autocomplete="family-name"]').fill('Prova');
await reqCard.locator('input[autocomplete="tel"]').fill('+39 340 5552222');
await reqCard.locator('input[autocomplete="email"]').fill('anna@example.invalid');
await reqCard.locator('input[type="checkbox"]').first().check();
await page.screenshot({ path: 'test-results/ai6-consulenza.png' });
await page.waitForTimeout(3200);
await reqCard.locator('button:has-text("Invia la richiesta")').click();
await d2.locator('text=Richiesta inviata, in attesa di approvazione').waitFor({ timeout: 8000 });
check('consulenza salvata come richiesta PENDING, nessun appuntamento', Number(su('select count(*) from booking_requests')) === rb + 1 && su(`select status from booking_requests order by created_at desc limit 1`) === 'pending' && Number(su('select count(*) from appointments')) === ab);
check('nessun messaggio di appuntamento confermato per la consulenza', !(await d2.textContent())!.includes('Il tuo appuntamento è confermato'));
await page.waitForTimeout(700);
await page.screenshot({ path: 'test-results/ai7-richiesta.png' });
check('nessun errore in pagina (consulenza)', errors.length === 0, errors.join(' | '));

// ===================================================================
// E) AI non disponibile: messaggio di ripiego, prenotazione classica intatta
// ===================================================================
({ page, errors } = await newPage());
modelDown = true;
await page.goto('http://maylana.test/prenota');
await page.locator('button[aria-haspopup="dialog"]').click();
const d3 = page.locator('[role="dialog"]');
await d3.locator('textarea').fill('Che servizi avete per uomo?');
await page.keyboard.press('Enter');
await d3.locator('text=non è disponibile in questo momento').waitFor({ timeout: 8000 });
check('errore OpenAI → ripiego con contatti', await d3.locator('section[aria-label^="Contatta"]').isVisible());
await page.waitForTimeout(700);
await page.screenshot({ path: 'test-results/ai8-errore.png' });
await page.keyboard.press('Escape');
await page.click('text=Donna');
check('procedura classica utilizzabile con AI guasta', await page.locator('text=Scegli uno o più servizi').isVisible());

// AI disattivata: nessun pulsante, pagina invariata
su(`update ai_settings set enabled=false`);
({ page, errors } = await newPage());
await page.goto('http://maylana.test/prenota');
await page.waitForSelector('text=Cosa desideri prenotare?');
await page.waitForTimeout(800);
check('AI disattivata → nessun pulsante chat', (await page.locator('button[aria-haspopup="dialog"]').count()) === 0);
const jsFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
check('nessuna chiave o riferimento OpenAI nel bundle del browser', jsFiles.every((f) => !/sk-[A-Za-z0-9]{10}|OPENAI_API_KEY|api\.openai\.com/.test(fs.readFileSync(path.join(dir, f), 'utf8'))));

await browser.close();
console.log(fails ? `\n❌ ${fails} controlli E2E falliti` : '\n✅ E2E chat superato (browser reale, handler reali, modello simulato)');
process.exit(fails ? 1 : 0);
