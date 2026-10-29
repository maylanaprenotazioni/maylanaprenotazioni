// Scenari obbligatori (Prompt 5, FASE 9) — handler Netlify reali contro Postgres reale (DB di test dedicato).
// Simulati: provider email (Resend finto), Supabase Auth, modello OpenAI. Nessun servizio esterno reale.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { DbError } from '../../netlify/lib/db';
import { errorResponse, type Deps } from '../../netlify/lib/http';
import * as H from '../../netlify/lib/handlers';
import { aiChatHandler, aiStatusHandler } from '../../netlify/lib/ai/chat';
import type { ModelClient, ModelResponse } from '../../netlify/lib/ai/model';

const pexec = promisify(execFile);
const DB = process.env.TESTDB || 'maylana_test';
const PSQL = ['-d', DB, '-qtA', '-v', 'ON_ERROR_STOP=1'];
async function sql(q: string, claims = '{"role":"service_role"}', role = 'service_role'): Promise<any> {
  try {
    const { stdout } = await pexec('psql', [...PSQL, '-c', `set role ${role}`, '-c', `select set_config('request.jwt.claims','${claims}',false)`, '-c', q]);
    return JSON.parse(stdout.trim().split('\n').slice(1).join('\n') || 'null');
  } catch (e: any) {
    if (e instanceof SyntaxError) throw e;
    const m = /ERROR:\s+(.+)/.exec(String(e.stderr));
    throw new DbError(m ? m[1].trim() : 'unknown', 'P0001', 400);
  }
}
const su = async (q: string) => (await pexec('psql', [...PSQL, '-c', q])).stdout.trim();
const OWNER = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const STAFFU = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const asOwner = (q: string) => sql(q, `{"role":"authenticated","sub":"${OWNER}"}`, 'authenticated');
const asStaff = (q: string) => sql(q, `{"role":"authenticated","sub":"${STAFFU}"}`, 'authenticated');
const lit = (v: unknown): string => v === null || v === undefined ? 'null' : Array.isArray(v) ? `array[${v.map(lit).join(',')}]::uuid[]` : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const SETOF = new Set(['book_appointment', 'create_booking_request', 'get_bundle_slots', 'bundle_info', 'ai_begin_turn', 'claim_notifications', 'customer_reschedule_slots']);
const db = {
  async rpc(fn: string, args: Record<string, unknown>) {
    const a = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
    if (SETOF.has(fn)) return sql(`select coalesce(json_agg(r), '[]'::json) from public.${fn}(${a}) r`);
    if (fn === 'ai_record_usage') { await sql(`select json_build_object('x', (select 1 from (select public.${fn}(${a})) z))`); return null; }
    return sql(`select to_json(public.${fn}(${a}))`);
  },
  async select(p: string) {
    const t = p.split('?')[0];
    if (t === 'business_settings') return sql(`select json_agg(b) from business_settings b`);
    if (t === 'notifications') { const id = /id=eq\.([0-9a-f-]+)/.exec(p)![1]; return sql(`select coalesce(json_agg(json_build_object('status',status)),'[]') from notifications where id='${id}'`); }
    if (t === 'admin_users') { const id = /user_id=eq\.([0-9a-f-]+)/.exec(p)![1]; return sql(`select coalesce(json_agg(json_build_object('role',role)),'[]') from admin_users where user_id='${id}'`); }
    if (t === 'services') return sql(`select coalesce(json_agg(s order by sort_order),'[]') from services s where active`);
    if (t === 'staff') return sql(`select coalesce(json_agg(json_build_object('id',s.id,'display_name',s.display_name,'bio',s.bio,'staff_services',(select coalesce(json_agg(json_build_object('service_id',service_id)),'[]') from staff_services where staff_id=s.id))),'[]') from staff s where active`);
    throw new Error('select non gestita ' + p);
  },
};

// Resend simulato: 'ok' | 'down'
let mailMode: 'ok' | 'down' = 'ok';
const sent: { to: string; subject: string; html: string; idem: string }[] = [];
const fakeFetch = (async (url: string, init: any) => {
  if (url === 'https://api.resend.com/emails') {
    if (mailMode === 'down') return new Response(JSON.stringify({ message: 'service unavailable' }), { status: 503 });
    const b = JSON.parse(init.body);
    sent.push({ to: b.to[0], subject: b.subject, html: b.html, idem: init.headers['Idempotency-Key'] });
    return new Response(JSON.stringify({ id: 'm' + sent.length }), { status: 200 });
  }
  if (url.endsWith('/auth/v1/user')) return new Response('{}', { status: 401 });
  throw new Error('fetch inatteso ' + url);
}) as unknown as typeof fetch;

let modelCalls = 0;
const model: ModelClient = {
  async create(req) {
    modelCalls++;
    const done = (req.input as any[]).filter((i) => i.type === 'function_call_output').length;
    if (done === 0) return { output: [{ type: 'function_call', call_id: 'c1', name: 'prepare_booking', arguments: JSON.stringify({ service_ids: [ids.uomo], starts_at: aiSlot, staff_id: null }) }], usage: { input_tokens: 500, output_tokens: 20 } } as ModelResponse;
    return { output: [], output_text: 'Perfetto, ho prenotato per te: il tuo appuntamento è confermato!', usage: { input_tokens: 600, output_tokens: 20 } } as ModelResponse;
  },
};
const env = { supabaseUrl: 'https://x.supabase.co', serviceKey: 'sk', rateLimitSalt: 'test-salt-1234567890', allowedOrigins: ['https://prenota.example.it'], siteUrl: 'https://prenota.example.it', email: { provider: 'resend', apiKey: 're_test', from: 'Maylana Coiffeur <prenotazioni@example.invalid>', replyTo: '' } } as any;
const aiEnv = { enabled: true, apiKey: 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWX', model: 'test', timeoutMs: 4000, deadlineMs: 8000, reasoningEffort: null, includeReasoning: true, sessionSecret: 'segreto-scenari-123456' } as const;
let ipN = 0;
const deps = (ai: any = aiEnv): Deps => ({ env, db: db as any, ip: `10.5.${Math.floor(++ipN / 250)}.${ipN % 250}`, fetch: fakeFetch, ai: { env: ai, model } });
async function call(h: any, req: Request, d = deps()) {
  let r: Response;
  try { r = await h(req, d); } catch (e) { r = errorResponse(e); }
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
const post = (path: string, body: any, headers: Record<string, string> = {}) => new Request('https://prenota.example.it' + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://prenota.example.it', ...headers }, body: JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}) => new Request('https://prenota.example.it' + path, { headers });
let phoneN = 100;
const person = (o: any = {}) => ({ firstName: 'Cliente', lastName: 'Prova', phone: `+39 340 0000${++phoneN}`, email: `cliente${phoneN}@example.invalid`, notes: null, privacyAccepted: true, marketingConsent: false, website: '', formStartedAt: Date.now() - 20000, idempotencyKey: crypto.randomUUID(), ...o });
const linkToken = (html: string) => /\/gestisci#t=([A-Za-z0-9_-]+)/.exec(html)?.[1] ?? null;

// ---- report ----
type Res = { id: number; name: string; status: 'PASS' | 'FAIL'; details: string[] };
const report: Res[] = [];
async function scenario(id: number, name: string, fn: (ok: (c: boolean, msg: string) => void) => Promise<void>) {
  const details: string[] = [];
  let failed = false;
  const ok = (c: boolean, msg: string) => { details.push(`${c ? '✓' : '✗'} ${msg}`); if (!c) failed = true; };
  try { await fn(ok); } catch (e) { failed = true; details.push(`✗ eccezione: ${(e as Error).message}`); }
  report.push({ id, name, status: failed ? 'FAIL' : 'PASS', details });
  console.log(`TEST ${id} — ${name}: ${failed ? 'FAIL' : 'PASS'}`);
  for (const d of details) console.log('    ' + d);
}

// ---- dati del salone di test ----
await su(`update business_settings set min_notice_minutes=0, booking_horizon_days=60, address='Via di Prova 1, Palagiano', contact_phone='000 0000000', notification_email='salone@example.invalid'`);
await su(`insert into auth.users(id,email) values ('${OWNER}','o@x.invalid'),('${STAFFU}','s@x.invalid') on conflict do nothing; insert into admin_users(user_id,role) values ('${OWNER}','owner'),('${STAFFU}','staff') on conflict do nothing`);
await su(`insert into staff(id,display_name) values ('dddddddd-0000-4000-8000-000000000001','Operatore Uno') on conflict do nothing`);
await su(`update services set duration_minutes=30, price_cents=1500, active=true where name='Taglio uomo';
  update services set duration_minutes=45, price_cents=2500, active=true where name='Taglio donna';
  update services set duration_minutes=30, price_cents=1500, active=true where name='Shampoo e piega';
  update services set duration_minutes=60, active=true where name in ('Consulenza protesi capillari donna','Balayage');
  insert into staff_services select 'dddddddd-0000-4000-8000-000000000001', id from services where active on conflict do nothing;
  insert into working_hours(staff_id,weekday,start_time,end_time) select 'dddddddd-0000-4000-8000-000000000001', d, '09:00','18:00' from generate_series(1,7) d on conflict do nothing`);
const ids = {
  uomo: await su(`select id from services where name='Taglio uomo'`),
  donna: await su(`select id from services where name='Taglio donna'`),
  piega: await su(`select id from services where name='Shampoo e piega'`),
  cons: await su(`select id from services where name='Consulenza protesi capillari donna'`),
};
const STAFF = 'dddddddd-0000-4000-8000-000000000001';
const day = (n: number) => su(`select ((now() at time zone 'Europe/Rome')::date + ${n})::text`);
const at = async (n: number, hhmm: string) => new Date(await su(`select to_char(((((now() at time zone 'Europe/Rome')::date + ${n}) + time '${hhmm}') at time zone 'Europe/Rome') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`)).toISOString();
const times = async (serviceIds: string[], d: string) => {
  const r = await call(H.availabilityHandler, get(`/api/availability?serviceIds=${serviceIds.join(',')}&date=${d}`));
  return (r.body?.times ?? []).map((t: any) => new Date(t.starts_at).toISOString()) as string[];
};
let aiSlot = '';

// ===================================================================
await scenario(1, 'Cliente prenota taglio uomo', async (ok) => {
  const s = await at(3, '09:00');
  sent.length = 0;
  const r = await call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.uomo], staffId: null, startsAt: s }));
  ok(r.status === 201 && r.body.appointment.status === 'confirmed', `201 confermato, codice ${r.body?.appointment?.code}`);
  ok((await su(`select count(*) from appointments where code='${r.body.appointment.code}' and status='confirmed'`)) === '1', 'appuntamento presente nel database');
  ok(r.body.email === 'sent' && sent.some((m) => m.to.startsWith('cliente') && /conferm/i.test(m.subject)), `email di conferma al cliente (${sent.length} email)`);
});

await scenario(2, 'Cliente prenota taglio donna + piega', async (ok) => {
  const s = await at(3, '11:00');
  const r = await call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.donna, ids.piega], staffId: null, startsAt: s }));
  ok(r.status === 201, '201 confermato');
  ok(r.body.appointment.duration_minutes === 75 && r.body.appointment.total_price_cents === 4000, `durata ${r.body.appointment.duration_minutes}' prezzo ${r.body.appointment.total_price_cents}`);
  const items = await su(`select count(*)||'/'||(extract(epoch from (ends_at-starts_at))/60)::int from appointments a join appointment_items i on i.appointment_id=a.id where a.code='${r.body.appointment.code}' group by a.id`);
  ok(items === '2/75', `2 servizi in un unico blocco da 75' (${items})`);
});

await scenario(3, 'Due clienti scelgono contemporaneamente lo stesso orario', async (ok) => {
  const s = await at(4, '10:00');
  const [a, b] = await Promise.all([
    call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.uomo], staffId: STAFF, startsAt: s })),
    call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.uomo], staffId: STAFF, startsAt: s })),
  ]);
  const st = [a.status, b.status].sort();
  ok(st[0] === 201 && st[1] === 409, `esiti: ${a.status} e ${b.status} (atteso 201 + 409)`);
  ok([a, b].some((x) => x.body?.error?.code === 'SLOT_UNAVAILABLE'), 'il secondo riceve SLOT_UNAVAILABLE');
  ok((await su(`select count(*) from appointments where starts_at='${s}' and status<>'cancelled'`)) === '1', 'una sola prenotazione confermata nel database');
  ok((await su(`select count(*) from pg_constraint where conname='appointments_no_overlap'`)) === '1', 'vincolo di esclusione presente');
});

let reqA = '', reqB = '';
await scenario(4, 'Cliente richiede consulenza Capelli For You', async (ok) => {
  sent.length = 0;
  const r = await call(H.requestHandler, post('/api/request', { ...person(), serviceIds: [ids.cons], preferredDate: await day(5), preferredTimeWindow: 'mattina', preferredStaffId: null }));
  ok(r.status === 201 && r.body.request.status === 'pending', `richiesta ${r.body?.request?.code} in attesa`);
  reqA = await su(`select id from booking_requests where code='${r.body.request.code}'`);
  ok((await su(`select count(*) from appointments a where a.booking_request_id='${reqA}'`)) === '0', 'nessun appuntamento creato');
  ok(sent.some((m) => m.to.startsWith('cliente') && !/protesi/i.test(m.subject + m.html)), 'email "richiesta ricevuta" discreta (senza dettagli del servizio)');
  const r2 = await call(H.requestHandler, post('/api/request', { ...person(), serviceIds: [ids.cons], preferredDate: null, preferredTimeWindow: 'indifferente', preferredStaffId: null }));
  reqB = await su(`select id from booking_requests where code='${r2.body.request.code}'`);
  // tentativo di prenotarla come appuntamento automatico
  const b = await call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.cons], staffId: null, startsAt: await at(5, '09:00') }));
  ok(b.status === 400 && b.body.error.code === 'REQUIRES_APPROVAL', 'la consulenza non si può prenotare in automatico');
});

await scenario(5, 'Admin approva consulenza', async (ok) => {
  sent.length = 0;
  const s = await at(5, '15:00');
  const res = await asOwner(`select to_json(admin_confirm_request('${reqA}', '${STAFF}', '${s}'))`);
  ok(!!res?.appointment_id, 'approvazione registrata dal titolare');
  ok((await su(`select status from booking_requests where id='${reqA}'`)) === 'confirmed', 'richiesta → confermata');
  ok((await su(`select count(*) from appointments where id='${res.appointment_id}' and status='confirmed' and starts_at='${s}'`)) === '1', 'appuntamento in agenda all\'orario scelto');
  await H.scheduledRun(deps());
  ok(sent.some((m) => /conferm/i.test(m.subject) && m.to.startsWith('cliente')), 'email di approvazione al cliente');
  let err = '';
  try { await asOwner(`select to_json(admin_confirm_request('${reqA}', '${STAFF}', '${await at(5, '16:00')}'))`); } catch (e) { err = (e as Error).message; }
  ok(err === 'REQUEST_NOT_CONFIRMABLE', 'seconda approvazione rifiutata');
  let e2 = '';
  try { await sql(`select to_json(admin_confirm_request(gen_random_uuid(), '${STAFF}', now()))`, '{"role":"anon"}', 'anon'); } catch (e) { e2 = (e as Error).message; }
  ok(/permission denied|FORBIDDEN/.test(e2), 'un visitatore non autenticato non può approvare');
});

await scenario(6, 'Admin rifiuta consulenza', async (ok) => {
  sent.length = 0;
  await asOwner(`select to_json(admin_set_request_status('${reqB}', 'rejected', 'Nessuna disponibilità'))`);
  ok((await su(`select status from booking_requests where id='${reqB}'`)) === 'rejected', 'richiesta → rifiutata');
  await H.scheduledRun(deps());
  ok(sent.some((m) => m.to.startsWith('cliente')), 'email di rifiuto al cliente');
  ok((await su(`select count(*) from appointments a where a.booking_request_id='${reqB}'`)) === '0', 'nessun appuntamento creato');
});

await scenario(7, 'Cliente annulla appuntamento con token valido', async (ok) => {
  sent.length = 0;
  const s = await at(6, '10:00');
  const r = await call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.uomo], staffId: STAFF, startsAt: s }));
  const tok = linkToken(sent.find((m) => m.to.startsWith('cliente'))!.html)!;
  ok(!!tok, 'link personale ricevuto via email');
  ok((await su(`select count(*) from appointment_tokens where token_hash = '${tok}'`)) === '0', 'nel database solo l\'hash del token');
  const v = await call(H.manageViewHandler, post('/api/manage/view', { token: tok }));
  ok(v.status === 200 && v.body.appointment.code === r.body.appointment.code, 'il token apre il proprio appuntamento');
  const c = await call(H.manageCancelHandler, post('/api/manage/cancel', { token: tok }));
  ok(c.status === 200 && (await su(`select status from appointments where code='${r.body.appointment.code}'`)) === 'cancelled', 'appuntamento annullato');
  ok((await times([ids.uomo], await day(6))).includes(s), 'l\'orario torna disponibile');
  const again = await call(H.manageCancelHandler, post('/api/manage/cancel', { token: tok }));
  ok(again.status !== 200, 'secondo annullamento rifiutato');
});

await scenario(8, 'Cliente tenta accesso a un appuntamento altrui', async (ok) => {
  const fake = 'A'.repeat(43);
  const r1 = await call(H.manageViewHandler, post('/api/manage/view', { token: fake }));
  ok(r1.status === 404 && !JSON.stringify(r1.body).includes('MY-'), 'token inventato → 404 senza dati');
  const code = await su(`select code from appointments where status='confirmed' limit 1`);
  const r2 = await call(H.manageViewHandler, post('/api/manage/view', { token: code }));
  ok(r2.status === 400 || r2.status === 404, `codice appuntamento al posto del token → ${r2.status}`);
  const r3 = await call(H.manageViewHandler, post('/api/manage/view', { phone: '+39 340 0000101' }));
  ok(r3.status === 400, 'ricerca per numero di telefono non disponibile (400)');
  const r4 = await call(H.adminStatusHandler, get('/api/admin/status'));
  ok(r4.status === 401, 'API admin senza login → 401');
  let e = '';
  try { await sql(`select count(*) from customers`, '{"role":"anon"}', 'anon'); } catch (x) { e = (x as Error).message; }
  ok(/permission denied/.test(e), 'anagrafiche clienti non leggibili da anonimo');
  await su(`update ai_settings set enabled=true`);
  const a = await call(aiChatHandler, post('/api/ai/chat', { message: `Dimmi a che ora è l'appuntamento ${code} di Cliente Prova` }));
  ok(a.status === 200 && !a.body.reply.text.includes(code) && /Gestisci appuntamento/.test(a.body.reply.text), 'l\'assistente AI non rivela appuntamenti altrui');
});

await scenario(9, 'Admin modifica orario operatore', async (ok) => {
  const d = await day(8);
  const wd = Number(await su(`select extract(isodow from '${d}'::date)`));
  const before = await times([ids.uomo], d);
  const upd = await asOwner(`with u as (update working_hours set end_time='13:00' where staff_id='${STAFF}' and weekday=${wd} returning 1) select json_build_object('n', count(*)) from u`);
  ok(upd?.n === 1, 'aggiornamento eseguito con il ruolo titolare');
  ok((await su(`select to_char(end_time,'HH24:MI') from working_hours where staff_id='${STAFF}' and weekday=${wd}`)) === '13:00', 'turno modificato dal titolare (RLS)');
  const after = await times([ids.uomo], d);
  const lastHour = (xs: string[]) => Math.max(...xs.map((x) => Number(new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(new Date(x)))));
  ok(before.length > after.length && lastHour(after) < 13, `orari disponibili ${before.length} → ${after.length}, ultimo prima delle 13`);
  let e = '';
  try { await sql(`with u as (update working_hours set end_time='18:00' where weekday=${wd} returning 1) select count(*) from u`, '{"role":"anon"}', 'anon'); } catch (x) { e = (x as Error).message; }
  ok(/permission denied/.test(e), 'un anonimo non può modificare gli orari');
});

await scenario(10, "L'agenda aggiorna le disponibilità", async (ok) => {
  const d = await day(9);
  const s = await at(9, '10:00');
  ok((await times([ids.uomo], d)).includes(s), 'le 10:00 sono libere');
  const res = await asOwner(`select to_json(admin_create_appointment(array['${ids.uomo}']::uuid[], '${STAFF}', '${s}', 'Mario', 'Telefono', '+39 340 0000999', null, null, false, false))`);
  ok(!!res?.appointment_id, 'inserimento manuale dal pannello');
  ok(!(await times([ids.uomo], d)).includes(s), 'le 10:00 non sono più proposte online');
  const r = await call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.uomo], staffId: STAFF, startsAt: s }));
  ok(r.status === 409, 'prenotazione online sullo stesso orario rifiutata');
  await asOwner(`select to_json(admin_cancel_appointment('${res.appointment_id}', 'test', false))`);
  ok((await times([ids.uomo], d)).includes(s), 'dopo l\'annullamento dal pannello le 10:00 tornano libere');
});

await scenario(11, "L'assistente AI non conferma prenotazioni senza consenso", async (ok) => {
  await su(`update ai_settings set enabled=true, session_message_limit=50`);
  aiSlot = await at(10, '11:00');
  const before = await su(`select count(*) from appointments`);
  modelCalls = 0;
  const r = await call(aiChatHandler, post('/api/ai/chat', { message: 'Prenotami un taglio uomo il giorno indicato alle 11, va bene tutto' }));
  ok(r.status === 200 && modelCalls === 2, 'il modello (simulato) ha usato prepare_booking');
  ok((await su(`select count(*) from appointments`)) === before, 'nessun appuntamento salvato dalla chat');
  ok(!/è confermato|ho prenotato/i.test(r.body.reply.text), 'la falsa conferma del modello non arriva al cliente');
  ok(r.body.cards.some((c: any) => c.type === 'booking'), 'mostrato solo il riepilogo da confermare con il modulo');
});

await scenario(12, 'Il sistema continua a funzionare con AI disattivata', async (ok) => {
  await su(`update ai_settings set enabled=false`);
  const g = await call(aiStatusHandler, get('/api/ai/chat'));
  ok(g.body.available === false, 'assistente non disponibile');
  const p = await call(aiChatHandler, post('/api/ai/chat', { message: 'ciao' }));
  ok(p.status === 503, 'chat → 503');
  const r = await call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.uomo], staffId: null, startsAt: await at(10, '15:00') }));
  ok(r.status === 201, 'prenotazione tradizionale confermata');
  const noKey = await call(aiStatusHandler, get('/api/ai/chat'), deps({ ...aiEnv, apiKey: '' }));
  ok(noKey.body.available === false, 'senza chiave OpenAI l\'assistente resta nascosto');
});

await scenario(13, 'Il servizio email è temporaneamente indisponibile', async (ok) => {
  sent.length = 0;
  mailMode = 'down';
  const r = await call(H.bookHandler, post('/api/book', { ...person(), serviceIds: [ids.uomo], staffId: null, startsAt: await at(11, '09:30') }));
  ok(r.status === 201 && r.body.email !== 'sent', `prenotazione salvata, email dichiarata "${r.body.email}" (non inviata)`);
  const n = await su(`select n.status||'|'||n.attempts from notifications n join appointments a on a.id=n.appointment_id where a.code='${r.body.appointment.code}' and n.audience='customer'`);
  ok(n === 'pending|1', `email in coda per un nuovo tentativo (${n})`);
  mailMode = 'ok';
  await su(`update notifications set next_attempt_at = now() where status='pending'`);
  await H.scheduledRun(deps());
  const mine = sent.filter((m) => m.html.includes(r.body.appointment.code));
  ok(mine.length === 1, `ritentativo riuscito: inviata ${mine.length} volta`);
  await su(`update notifications set next_attempt_at = now() where status='pending'`);
  await H.scheduledRun(deps());
  ok(sent.filter((m) => m.html.includes(r.body.appointment.code)).length === 1, 'nessun invio duplicato al processo successivo');
  ok(mine[0]?.idem?.length > 0, 'chiave di idempotenza inviata al provider');
});

fs.writeFileSync('test-results/report_scenari.json', JSON.stringify(report, null, 2));
const f = report.filter((r) => r.status === 'FAIL').length;
console.log(f ? `\n❌ ${f} scenari FAIL` : `\n✅ Scenari 1-13: tutti PASS`);
process.exit(f ? 1 : 0);
