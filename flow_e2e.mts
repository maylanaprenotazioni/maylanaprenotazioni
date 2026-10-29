// TEST 14 (connessione persa durante la prenotazione), prenotazione completa SENZA chat,
// ripresa del modulo, TEST 15 (navigazione delle route con le regole di netlify.toml) — browser reale,
// handler reali, DB di test. Il bundle è la build di produzione esbuild (NON "npm run build"/Vite).
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DbError } from '../../netlify/lib/db';
import { errorResponse, type Deps } from '../../netlify/lib/http';
import * as H from '../../netlify/lib/handlers';
import { aiChatHandler, aiStatusHandler } from '../../netlify/lib/ai/chat';
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


su(`update business_settings set min_notice_minutes=0, booking_horizon_days=60, address='Via di Prova 1, Palagiano', contact_phone='000 0000000'`);
su(`update ai_settings set enabled=false`);
su(`insert into staff(id,display_name) values ('dddddddd-0000-4000-8000-000000000001','Operatore Uno') on conflict do nothing`);
su(`update services set duration_minutes=30, price_cents=1500, active=true where name='Taglio uomo';
    insert into staff_services select 'dddddddd-0000-4000-8000-000000000001', id from services where active on conflict do nothing;
    insert into working_hours(staff_id,weekday,start_time,end_time) select 'dddddddd-0000-4000-8000-000000000001', d, '09:00','18:00' from generate_series(1,7) d on conflict do nothing`);
const env = { supabaseUrl: 'https://x', serviceKey: 'sk', rateLimitSalt: 'test-salt-1234567890', allowedOrigins: ['http://maylana.test'], siteUrl: 'http://maylana.test', email: { provider: null, apiKey: '', from: '', replyTo: '' } } as any;
let ipN = 0;
const deps = (): Deps => ({ env, db: db as any, ip: `10.8.0.${++ipN}`, fetch: (async () => { throw new Error('no'); }) as any, ai: { env: { enabled: false, apiKey: '', model: '', timeoutMs: 1, deadlineMs: 1, reasoningEffort: null, includeReasoning: true, sessionSecret: 'x'.repeat(20) } } });
async function handle(h: any, req: Request) { try { return await h(req, deps()); } catch (e) { return errorResponse(e); } }

type Res = { id: number; name: string; status: 'PASS' | 'FAIL'; details: string[] };
const report: Res[] = [];
let cur: Res;
const begin = (id: number, name: string) => { cur = { id, name, status: 'PASS', details: [] }; report.push(cur); };
const check = (n: string, c: boolean, x = '') => { cur.details.push(`${c ? '✓' : '✗'} ${n} ${x}`); if (!c) cur.status = 'FAIL'; };

const browser = await chromium.launch();
// Emulazione delle regole di netlify.toml: funzioni con path → redirect "/" → 404 JSON per /api/* → fallback SPA
async function newPage(dev: any) {
  const ctx = await browser.newContext({ ...dev, locale: 'it-IT' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.route('**/*', async (route: any) => {
    const r = route.request();
    const url = new URL(r.url());
    const fns: Record<string, any> = { '/api/catalog': H.catalogHandler, '/api/availability': H.availabilityHandler, '/api/book': H.bookHandler, '/api/request': H.requestHandler, '/api/ai/chat': r.method() === 'GET' ? aiStatusHandler : aiChatHandler, '/api/admin/status': H.adminStatusHandler, '/api/manage/view': H.manageViewHandler };
    if (fns[url.pathname]) {
      const req = new Request(url.toString(), { method: r.method(), headers: r.headers(), body: r.method() === 'POST' ? r.postData() : undefined });
      const res: Response = await handle(fns[url.pathname], req);
      return route.fulfill({ status: res.status, headers: { 'content-type': 'application/json' }, body: await res.text() });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, path: path.join(dir, 'api-404.json'), contentType: 'application/json' });
    const f = path.join(dir, url.pathname);
    if (url.pathname !== '/' && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ path: f, contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : 'text/html' });
    return route.fulfill({ path: path.join(dir, 'index.html'), contentType: 'text/html' });
  });
  return { page, ctx, errors };
}

async function toSummary(page: any) {
  await page.goto('http://maylana.test/prenota');
  await page.waitForSelector('text=Cosa desideri prenotare?');
  await page.click('button:has-text("Uomo")');
  await page.click('button[aria-pressed]:has-text("Taglio uomo")');
  await page.click('button:has-text("Continua")');
  await page.waitForSelector('text=Giorno e orario');
  let tbtn = page.locator('button.tabular-nums').filter({ hasText: /^\d{2}:\d{2}$/ });
  await page.waitForTimeout(800);
  if (!(await tbtn.count())) await page.click('button:has-text("Cerca il primo giorno libero")');
  await tbtn.first().waitFor({ timeout: 8000 });
  const chosen = (await tbtn.last().textContent()).trim();
  await tbtn.last().click();
  await page.waitForSelector('text=I tuoi dati');
  await page.getByLabel('Nome', { exact: true }).fill('Luca');
  await page.getByLabel('Cognome').fill('Prova');
  await page.getByLabel('Telefono').fill('+39 340 7770001');
  await page.getByLabel('Email').fill('luca@example.invalid');
  await page.locator('input[type=checkbox]').first().check();
  await page.click('button:has-text("Vai al riepilogo")');
  await page.waitForSelector('button:has-text("Conferma prenotazione")');
  return chosen;
}
const count = () => Number(su('select count(*) from appointments'));

// ===================================================================
begin(14, 'La Web App perde connessione durante una prenotazione');
{
  const { page, ctx, errors } = await newPage(devices['iPhone 13']);
  const chosen = await toSummary(page);
  const before = count();
  await ctx.setOffline(true);
  await page.waitForTimeout(500);
  let body = await page.textContent('body');
  check('offline: avviso chiaro e pulsante di conferma disattivato', /Sei offline/.test(body!) && (await page.locator('button:has-text("Conferma prenotazione")').isDisabled()));
  await page.screenshot({ path: 'test-results/t14-offline.png' });
  await ctx.setOffline(false);
  await page.waitForTimeout(400);
  // la rete cade proprio durante l'invio (il browser crede di essere online)
  let drop = true;
  await page.route('**/api/book', (route: any) => (drop ? route.abort('internetdisconnected') : route.fallback()));
  await page.click('button:has-text("Conferma prenotazione")');
  await page.waitForTimeout(800);
  body = await page.textContent('body');
  check('rete caduta durante l\'invio: messaggio di connessione, nessuna falsa conferma', /connessione/i.test(body!) && !/Ti aspettiamo|Prenotazione confermata/.test(body!));
  check('nessun appuntamento salvato', count() === before);
  check('riepilogo e dati conservati per riprovare', (await page.locator('button:has-text("Conferma prenotazione")').count()) === 1 && body!.includes('Luca'));
  await page.screenshot({ path: 'test-results/t14-rete-caduta.png' });
  drop = false;
  await page.click('button:has-text("Conferma prenotazione")');
  await page.waitForSelector('text=Ti aspettiamo', { timeout: 8000 });
  check('tornata la rete, la conferma va a buon fine (una sola volta)', count() === before + 1, `ore ${chosen}`);
  const stored = JSON.stringify(await page.evaluate(() => ({ ...sessionStorage, ...localStorage })));
  check('nessun dato personale salvato nel browser', !/Luca|7770001|luca@/.test(stored));
  check('nessun errore JavaScript', errors.length === 0, errors.join('|'));
  await ctx.close();
}
begin(140, 'Ripresa del modulo dopo ricarica (solo dati non sensibili)');
{
  const { page, ctx } = await newPage(devices['Pixel 7']);
  await page.goto('http://maylana.test/prenota');
  await page.click('button:has-text("Uomo")');
  await page.click('button[aria-pressed]:has-text("Taglio uomo")');
  await page.click('button:has-text("Continua")');
  await page.waitForSelector('text=Giorno e orario');
  const draft = await page.evaluate(() => sessionStorage.getItem('maylana:bozza'));
  check('bozza salvata senza dati personali', !!draft && !/Luca|@|340/.test(draft!), draft ?? '');
  await page.reload();
  await page.waitForSelector('text=Abbiamo ripreso le scelte', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(300);
  const bodyR = (await page.textContent('body'))!;
  check('dopo la ricarica si riparte dalla scelta dell\'orario con il servizio già selezionato', bodyR.includes('Abbiamo ripreso') && bodyR.includes('Taglio uomo') && bodyR.includes('Giorno e orario'), `${bodyR.includes('Abbiamo ripreso')}/${bodyR.includes('Taglio uomo')}/${bodyR.includes('Giorno e orario')}`);
  await ctx.close();
}

// ===================================================================
begin(15, 'Build di produzione e navigazione delle route');
{
  const idx = path.join(dir, 'index.html');
  const html = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8') : '';
  check('build di produzione presente (npm run build → dist con index.html, asset e sw.js)', dir === 'dist' && /assets\//.test(html) && fs.existsSync(path.join(dir, 'sw.js')) && fs.existsSync(path.join(dir, 'manifest.webmanifest')), dir === 'dist' ? '' : `(cartella ${dir}: non prodotta da npm run build)`);
}
{
  const { page, ctx, errors } = await newPage(devices['Desktop Chrome']);
  const toml = fs.readFileSync('netlify.toml', 'utf8');
  const order = ['from = "/"', 'from = "/api/*"', 'from = "/*"'].map((k) => toml.indexOf(k));
  check('netlify.toml: build "npm run build", publish "dist", redirect "/"→/prenota, /api/* 404 PRIMA del fallback SPA', /command = "npm run build"/.test(toml) && /publish = "dist"/.test(toml) && order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2]);
  const r1 = await page.goto('http://maylana.test/');
  check('"/" → /prenota (anche lato app)', await page.waitForSelector('text=Cosa desideri prenotare?').then(() => page.url().endsWith('/prenota')));
  await page.goto('http://maylana.test/prenota?sezione=capelli-for-you');
  check('/prenota?sezione=capelli-for-you senza consulenze attive → messaggio chiaro, non pagina vuota', await page.waitForSelector('text=Le consulenze non sono ancora prenotabili online').then(() => true).catch(() => false));
  su(`update services set duration_minutes=60, active=true where category='consultation'`);
  await page.goto('http://maylana.test/prenota?sezione=capelli-for-you');
  check('/prenota?sezione=capelli-for-you apre le consulenze attive', await page.waitForSelector('button[aria-pressed]:has-text("Consulenza")').then(() => true).catch(() => false));
  await page.goto('http://maylana.test/gestisci');
  check('/gestisci senza token → messaggio, nessun dato', await page.waitForSelector('text=/link non valido|link/i', { timeout: 5000 }).then(() => true).catch(() => false));
  await page.goto('http://maylana.test/admin');
  await page.waitForTimeout(800);
  check('/admin carica l\'area riservata (login o configurazione)', /Area riservata|Accedi|configur/i.test((await page.textContent('body'))!));
  await page.goto('http://maylana.test/pagina-inesistente');
  check('route sconosciuta → app di prenotazione (fallback SPA)', await page.waitForSelector('text=Cosa desideri prenotare?').then(() => true).catch(() => false));
  const api404 = await page.evaluate(async () => { const r = await fetch('/api/inesistente'); return { s: r.status, ct: r.headers.get('content-type'), b: await r.text() }; });
  check('/api/inesistente → 404 JSON, non la pagina HTML', api404.s === 404 && /json/.test(api404.ct ?? '') && api404.b.includes('NOT_FOUND'));
  const cat = await page.evaluate(async () => (await fetch('/api/catalog')).status);
  check('le API reali non sono intercettate dal fallback', cat === 200);
  check('nessun errore JavaScript sulle route', errors.length === 0, errors.join('|'));
  void r1;
  await ctx.close();
}
await browser.close();
fs.writeFileSync('test-results/report_flow.json', JSON.stringify(report, null, 2));
for (const r of report) { console.log(`TEST ${r.id} — ${r.name}: ${r.status}`); r.details.forEach((d) => console.log('    ' + d)); }
process.exit(report.some((r) => r.status === 'FAIL') ? 1 : 0);
