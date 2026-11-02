import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, isoToRome, isoWeekday, romeLocalToIso, romeToday } from '../../lib/time';

/**
 * Finto client Supabase per /admin/demo: implementa solo le chiamate usate
 * dall'area riservata, su dati di esempio in memoria. Ricaricando la pagina
 * si riparte dai dati iniziali; nulla viene inviato al database reale.
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Result = { data: any; error: { message: string; code?: string } | null; count?: number | null }; // eslint-disable-line @typescript-eslint/no-explicit-any

let seq = 0;
const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `demo-${Date.now()}-${++seq}`);
const fail = (message: string, code?: string): Result => ({ data: null, error: { message, code } });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const DEMO_USER = { id: 'demo-user', email: 'demo@maylana.it' };

// ---------------------------------------------------------------- dati di esempio

function seed(): Record<string, Row[]> {
  const now = new Date().toISOString();
  const svc = (id: string, name: string, group: string, dur: number, price: number | null, mode = 'automatic', from = false, buf = 0, sort = 0): Row => ({
    id,
    category: group === 'consulenze' ? 'consultation' : 'hair',
    public_group: group,
    name,
    description: null,
    price_cents: price,
    price_from: from,
    duration_minutes: dur,
    booking_mode: mode,
    buffer_after_minutes: buf,
    active: true,
    sort_order: sort,
  });
  const services = [
    svc('s-taglio-uomo', 'Taglio uomo', 'uomo', 30, 1500, 'automatic', false, 0, 1),
    svc('s-barba', 'Barba', 'uomo', 15, 800, 'automatic', false, 0, 2),
    svc('s-taglio-donna', 'Taglio donna', 'donna', 45, 2500, 'automatic', false, 0, 3),
    svc('s-piega', 'Shampoo e piega', 'donna', 30, 1800, 'automatic', false, 0, 4),
    svc('s-colore', 'Colore', 'donna', 60, 3500, 'automatic', true, 15, 5),
    svc('s-meches', 'Meches', 'donna', 90, 5000, 'manual', true, 0, 6),
    svc('s-balayage', 'Balayage', 'donna', 120, 8000, 'manual', true, 0, 7),
    svc('s-trattamento', 'Trattamento ristrutturante', 'trattamenti', 30, 2000, 'automatic', false, 0, 8),
    svc('s-acconciatura', 'Acconciatura sposa', 'acconciature', 90, null, 'manual', false, 0, 9),
    svc('s-cons-uomo', 'Consulenza protesi capillari uomo', 'consulenze', 60, null, 'manual', false, 0, 10),
    svc('s-cons-donna', 'Consulenza protesi capillari donna', 'consulenze', 60, null, 'manual', false, 0, 11),
  ];
  const staff = [
    { id: 'st-maylana', display_name: 'Maylana', bio: 'Titolare, colore e tagli donna', active: true, sort_order: 1 },
    { id: 'st-sara', display_name: 'Sara', bio: 'Tagli uomo e pieghe', active: true, sort_order: 2 },
  ];
  const staff_services = staff.flatMap((s) => services.map((v) => ({ staff_id: s.id, service_id: v.id })));
  const working_hours: Row[] = [];
  const opening_hours: Row[] = [];
  for (let wd = 2; wd <= 6; wd++) {
    for (const [a, b] of [
      ['09:00:00', '13:00:00'],
      ['15:00:00', '19:30:00'],
    ]) {
      opening_hours.push({ id: uid(), weekday: wd, start_time: a, end_time: b });
      for (const s of staff) working_hours.push({ id: uid(), staff_id: s.id, weekday: wd, start_time: a, end_time: b });
    }
  }
  const people = [
    ['Giulia', 'Russo'],
    ['Marco', 'Lombardi'],
    ['Francesca', 'Greco'],
    ['Antonio', 'Caputo'],
    ['Elena', 'Marino'],
    ['Luca', 'De Santis'],
    ['Chiara', 'Ferri'],
    ['Paolo', 'Conte'],
  ];
  const customers = people.map(([f, l], i) => ({
    id: `c-${i}`,
    first_name: f,
    last_name: l,
    phone: `+39 333 12345${String(i).padStart(2, '0')}`,
    email: `${f.toLowerCase()}.${l.toLowerCase().replace(/\s/g, '')}@esempio.it`,
    marketing_consent: i % 3 === 0,
    marketing_consent_at: null,
    created_at: now,
  }));

  const appointments: Row[] = [];
  const today = romeToday();
  const plan: [string, string, string[]][] = [
    ['09:30', 'st-maylana', ['s-taglio-donna', 's-piega']],
    ['11:30', 'st-maylana', ['s-colore']],
    ['16:00', 'st-maylana', ['s-trattamento']],
    ['09:00', 'st-sara', ['s-taglio-uomo', 's-barba']],
    ['10:30', 'st-sara', ['s-taglio-uomo']],
    ['17:00', 'st-sara', ['s-piega']],
  ];
  let n = 0;
  for (let d = -14; d <= 10; d++) {
    const date = addDays(today, d);
    const wd = isoWeekday(date);
    if (wd < 2 || wd > 6) continue;
    plan.forEach(([time, staffId, ids], k) => {
      if ((d + k) % 4 === 3) return; // qualche spazio libero
      n++;
      const items = ids.map((sid, position) => {
        const s = services.find((x) => x.id === sid)!;
        return { service_id: sid, position, name: s.name, duration_minutes: s.duration_minutes, buffer_minutes: s.buffer_after_minutes, price_cents: s.price_cents, price_from: s.price_from };
      });
      const minutes = items.reduce((t, i) => t + i.duration_minutes + i.buffer_minutes, 0);
      const starts = romeLocalToIso(date, time);
      const past = d < 0;
      const status = past ? (n % 17 === 0 ? 'no_show' : 'completed') : n % 13 === 0 ? 'cancelled' : 'confirmed';
      appointments.push({
        id: uid(),
        code: `MY-${String(1000 + n)}`,
        starts_at: starts,
        ends_at: new Date(Date.parse(starts) + minutes * 60000).toISOString(),
        status,
        source: n % 3 === 0 ? 'admin' : 'online',
        customer_id: customers[n % customers.length].id,
        staff_id: staffId,
        service_id: ids[0],
        booking_request_id: null,
        rescheduled_at: null,
        cancelled_at: status === 'cancelled' ? now : null,
        total_price_cents: items.every((i) => i.price_cents != null) ? items.reduce((t, i) => t + (i.price_cents ?? 0), 0) : null,
        price_is_estimate: items.some((i) => i.price_from),
        customer_notes: null,
        internal_notes: null,
        created_at: now,
        appointment_items: items,
      });
    });
  }

  const req = (code: string, service: string, customer: number, date: string | null, win: string, notes: string | null): Row => ({
    id: uid(),
    code,
    status: 'pending',
    preferred_date: date,
    preferred_time_window: win,
    customer_notes: notes,
    admin_notes: null,
    created_at: now,
    service_id: service,
    customer_id: customers[customer].id,
    preferred_staff_id: null,
    proposed_starts_at: null,
    proposed_staff_id: null,
    reschedule_of_appointment_id: null,
    booking_request_items: [{ position: 0, service_id: service }],
  });
  const booking_requests = [
    req('RQ-2001', 's-balayage', 4, addDays(today, 3), 'mattina', 'Vorrei schiarire le punte.'),
    req('RQ-2002', 's-cons-donna', 6, addDays(today, 5), 'pomeriggio', null),
    req('RQ-2003', 's-acconciatura', 2, null, 'indifferente', 'Matrimonio a giugno, prova acconciatura.'),
  ];

  return {
    admin_users: [{ user_id: DEMO_USER.id, role: 'owner', display_name: 'Demo' }],
    business_settings: [
      {
        id: 1,
        business_name: 'Maylana Coiffeur',
        logo_url: null,
        contact_phone: '+39 099 000 0000',
        contact_email: 'info@esempio.it',
        address: 'Via Esempio 1, Palagiano (TA)',
        privacy_url: null,
        public_notice: null,
        slot_interval_minutes: 15,
        min_notice_minutes: 120,
        booking_horizon_days: 60,
        online_booking_enabled: true,
        notification_email: 'salone@esempio.it',
        email_instructions: null,
        customer_change_min_hours: 24,
        reminder_1_hours: 24,
        reminder_2_hours: null,
        booking_buffer_minutes: 0,
        smart_slots_enabled: true,
        min_useful_gap_minutes: 30,
        max_recommended_slots: 3,
        whatsapp_number: '+39 333 0000000',
      },
    ],
    services,
    staff,
    staff_services,
    working_hours,
    opening_hours,
    time_off: [{ id: uid(), staff_id: 'st-sara', starts_at: romeLocalToIso(addDays(today, 15), '00:00'), ends_at: romeLocalToIso(addDays(today, 18), '00:00'), kind: 'ferie', reason: 'Ferie' }],
    customers,
    appointments,
    booking_requests,
    notifications: [],
    audit_log: [],
    ai_settings: [
      {
        id: 1,
        enabled: false,
        welcome_message: 'Ciao! Sono l’assistente di Maylana: posso aiutarti a scegliere il servizio e trovare un orario.',
        daily_request_limit: 300,
        daily_token_limit: 400000,
        daily_cost_limit_usd: 2,
        session_message_limit: 20,
        session_ttl_minutes: 30,
        max_input_chars: 500,
        max_output_tokens: 400,
        input_price_per_mtok_usd: null,
        output_price_per_mtok_usd: null,
      },
    ],
    ai_faq: [
      { id: uid(), topic: 'orari', language: 'it', question: 'Quali sono gli orari?', answer: 'Da martedì a sabato, 9–13 e 15–19:30.', keywords: ['orari', 'aperti'], active: true, sort_order: 1, created_at: now },
    ],
    ai_usage_daily: [],
  };
}

const db = seed();

// ---------------------------------------------------------------- relazioni

const fullName = (c: Row) => `${c.first_name} ${c.last_name}`.trim();
const byId = (table: string, id: unknown) => db[table].find((r) => r.id === id) ?? null;

function expand(table: string, r: Row): Row {
  const out = clone(r);
  if (table === 'customers') out.full_name = fullName(r);
  if (table === 'appointments') {
    const c = byId('customers', r.customer_id);
    const s = byId('services', r.service_id);
    const st = byId('staff', r.staff_id);
    out.customers = c ? { ...clone(c), full_name: fullName(c) } : null;
    out.services = s ? { name: s.name, category: s.category, public_group: s.public_group } : null;
    out.staff = st ? { display_name: st.display_name } : null;
  }
  if (table === 'booking_requests') {
    const c = byId('customers', r.customer_id);
    const s = byId('services', r.service_id);
    out.customers = c ? { ...clone(c), full_name: fullName(c) } : null;
    out.services = s ? { name: s.name, category: s.category, duration_minutes: s.duration_minutes } : null;
    out.booking_request_items = (r.booking_request_items ?? []).map((i: Row) => {
      const x = byId('services', i.service_id);
      return { ...i, services: x ? { name: x.name, duration_minutes: x.duration_minutes } : null };
    });
    out.appointments = db.appointments
      .filter((a) => a.booking_request_id === r.id)
      .map((a) => ({ id: a.id, starts_at: a.starts_at, status: a.status, staff: { display_name: byId('staff', a.staff_id)?.display_name ?? '' } }));
  }
  return out;
}

// ---------------------------------------------------------------- query builder

type Filter = (r: Row) => boolean;

class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private head = false;
  private count = false;

  constructor(private table: string) {
    db[table] ??= [];
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.head = true;
    if (opts?.count) this.count = true;
    return this;
  }
  insert(v: Row | Row[]) {
    this.op = 'insert';
    this.payload = v;
    return this;
  }
  upsert(v: Row | Row[]) {
    return this.insert(v);
  }
  update(v: Row) {
    this.op = 'update';
    this.payload = v;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  in(c: string, v: unknown[]) {
    this.filters.push((r) => v.includes(r[c]));
    return this;
  }
  gte(c: string, v: string | number) {
    this.filters.push((r) => r[c] != null && r[c] >= v);
    return this;
  }
  gt(c: string, v: string | number) {
    this.filters.push((r) => r[c] != null && r[c] > v);
    return this;
  }
  lte(c: string, v: string | number) {
    this.filters.push((r) => r[c] != null && r[c] <= v);
    return this;
  }
  lt(c: string, v: string | number) {
    this.filters.push((r) => r[c] != null && r[c] < v);
    return this;
  }
  /** Supporta solo la forma usata dall'agenda: "col.is.null,and(col.gte.X,col.lte.Y)". */
  or(expr: string) {
    const m = /^(\w+)\.is\.null,and\(\1\.gte\.([^,]+),\1\.lte\.([^)]+)\)$/.exec(expr);
    if (m) {
      const [, c, a, b] = m;
      this.filters.push((r) => r[c] == null || (r[c] >= a && r[c] <= b));
    }
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(a: number, b: number) {
    this.rng = [a, b];
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  private matching(): Row[] {
    return db[this.table].filter((r) => this.filters.every((f) => f(r)));
  }

  private shape(rows: Row[]): Result {
    let out = rows;
    for (const { col, asc } of [...this.orders].reverse()) {
      out = [...out].sort((x, y) => (x[col] === y[col] ? 0 : x[col] == null ? 1 : y[col] == null ? -1 : (x[col] < y[col] ? -1 : 1) * (asc ? 1 : -1)));
    }
    const total = out.length;
    if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim != null) out = out.slice(0, this.lim);
    const data = out.map((r) => expand(this.table, r));
    if (this.head) return { data: null, error: null, count: total };
    if (this.mode === 'single') return data.length ? { data: data[0], error: null } : fail('Nessun risultato', 'PGRST116');
    if (this.mode === 'maybe') return { data: data[0] ?? null, error: null };
    return { data, error: null, count: this.count ? total : null };
  }

  private run(): Result {
    const t = this.table;
    if (this.op === 'select') return this.shape(this.matching());
    if (this.op === 'insert') {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((v) => ({ id: uid(), created_at: new Date().toISOString(), ...v }));
      for (const r of list) {
        const err = validate(t, r);
        if (err) return fail(err.message, err.code);
      }
      db[t].push(...list);
      return this.shape(list);
    }
    const hit = this.matching();
    if (this.op === 'update') {
      for (const r of hit) {
        const err = validate(t, { ...r, ...this.payload }, r);
        if (err) return fail(err.message, err.code);
      }
      hit.forEach((r) => Object.assign(r, this.payload));
      return this.shape(hit);
    }
    db[t] = db[t].filter((r) => !hit.includes(r));
    return this.shape(hit);
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    let res: Result;
    try {
      res = this.run();
    } catch (e) {
      res = fail((e as Error).message);
    }
    return new Promise<Result>((r) => setTimeout(() => r(res), 60)).then(ok, ko);
  }
}

/** Gli stessi vincoli principali del database reale, per una demo realistica. */
function validate(table: string, r: Row, self?: Row): { message: string; code?: string } | null {
  if (table === 'services' && r.active && !r.duration_minutes) return { message: 'services_active_requires_duration', code: '23514' };
  if (table === 'working_hours' || table === 'opening_hours') {
    if (r.end_time <= r.start_time) return { message: 'INVALID_RANGE' };
    const clash = db[table].some((x) => x !== self && x.id !== r.id && x.weekday === r.weekday && (table === 'opening_hours' || x.staff_id === r.staff_id) && x.start_time < r.end_time && r.start_time < x.end_time);
    if (clash) return { message: `${table}_no_overlap` };
  }
  return null;
}

// ---------------------------------------------------------------- logica (RPC)

function bundle(ids: string[]) {
  const list = ids.map((id) => byId('services', id)).filter(Boolean) as Row[];
  const settings = db.business_settings[0];
  const duration = list.reduce((t, s) => t + (s.duration_minutes ?? 0), 0);
  const buffer = list.reduce((t, s) => t + (s.buffer_after_minutes ?? 0), 0) + (settings.booking_buffer_minutes ?? 0);
  const eligible = db.staff.filter((st) => st.active && ids.every((id) => db.staff_services.some((x) => x.staff_id === st.id && x.service_id === id))).map((s) => s.id);
  const consult = list.some((s) => s.category === 'consultation');
  const error = list.length !== ids.length || list.some((s) => !s.duration_minutes) ? 'SERVICE_NOT_BOOKABLE' : consult && list.length > 1 ? 'CONSULTATION_SINGLE' : !eligible.length ? 'NO_STAFF_FOR_COMBINATION' : null;
  return {
    valid: !error,
    error,
    duration_minutes: duration,
    buffer_minutes: buffer,
    block_minutes: duration + buffer,
    price_cents: list.every((s) => s.price_cents != null) ? list.reduce((t, s) => t + s.price_cents, 0) : null,
    price_is_estimate: list.some((s) => s.price_from || s.price_cents == null),
    all_automatic: list.every((s) => s.booking_mode === 'automatic'),
    eligible_staff: eligible,
    items: list,
  };
}

const overlaps = (staffId: string, start: number, end: number, ignore?: string | null) =>
  db.appointments.some((a) => a.staff_id === staffId && a.status !== 'cancelled' && a.id !== ignore && Date.parse(a.starts_at) < end && start < Date.parse(a.ends_at));

function insideHours(staffId: string, startIso: string, minutes: number): boolean {
  const { date, time } = isoToRome(startIso);
  const endTime = isoToRome(new Date(Date.parse(startIso) + minutes * 60000).toISOString()).time;
  return db.working_hours.some((w) => w.staff_id === staffId && w.weekday === isoWeekday(date) && w.start_time.slice(0, 5) <= time && endTime <= w.end_time.slice(0, 5) && endTime > time);
}

function place(p: { serviceIds: string[]; staffId: string; startsAt: string; force?: boolean; ignore?: string | null }): { error?: string; items?: Row[]; ends?: string; b?: ReturnType<typeof bundle> } {
  const b = bundle(p.serviceIds);
  if (b.error && b.error !== 'NO_STAFF_FOR_COMBINATION') return { error: b.error };
  if (!b.eligible_staff.includes(p.staffId)) return { error: 'STAFF_NOT_ENABLED' };
  const start = Date.parse(p.startsAt);
  const end = start + b.block_minutes * 60000;
  if (overlaps(p.staffId, start, end, p.ignore)) return { error: 'SLOT_UNAVAILABLE' };
  if (!p.force && !insideHours(p.staffId, p.startsAt, b.block_minutes)) return { error: 'OUTSIDE_WORKING_HOURS' };
  const items = b.items.map((s, position) => ({ service_id: s.id, position, name: s.name, duration_minutes: s.duration_minutes, buffer_minutes: s.buffer_after_minutes, price_cents: s.price_cents, price_from: s.price_from }));
  return { items, ends: new Date(end).toISOString(), b };
}

let codeSeq = 5000;

function newAppointment(p: { serviceIds: string[]; staffId: string; startsAt: string; customerId: string; source: string; force?: boolean; notes?: string | null; requestId?: string | null }): Result {
  const r = place(p);
  if (r.error) return fail(r.error);
  const row = {
    id: uid(),
    code: `MY-${++codeSeq}`,
    starts_at: new Date(Date.parse(p.startsAt)).toISOString(),
    ends_at: r.ends,
    status: 'confirmed',
    source: p.source,
    customer_id: p.customerId,
    staff_id: p.staffId,
    service_id: p.serviceIds[0],
    booking_request_id: p.requestId ?? null,
    rescheduled_at: null,
    cancelled_at: null,
    total_price_cents: r.b!.price_cents,
    price_is_estimate: r.b!.price_is_estimate,
    customer_notes: null,
    internal_notes: p.notes ?? null,
    created_at: new Date().toISOString(),
    appointment_items: r.items,
  };
  db.appointments.push(row);
  return { data: { appointment_id: row.id, code: row.code, notification_ids: [] }, error: null };
}

function slots(p: Row): Row[] {
  const b = bundle(p.p_service_ids);
  if (!b.eligible_staff.includes(p.p_staff_id) || !b.block_minutes) return [];
  const step = db.business_settings[0].slot_interval_minutes || 15;
  const wd = isoWeekday(p.p_date);
  const out: Row[] = [];
  for (const w of db.working_hours.filter((x) => x.staff_id === p.p_staff_id && x.weekday === wd)) {
    const [h1, m1] = w.start_time.split(':').map(Number);
    const [h2, m2] = w.end_time.split(':').map(Number);
    for (let t = h1 * 60 + m1; t + b.block_minutes <= h2 * 60 + m2; t += step) {
      const iso = romeLocalToIso(p.p_date, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
      const s = Date.parse(iso);
      if (!overlaps(p.p_staff_id, s, s + b.block_minutes * 60000, p.p_ignore_appointment_id)) {
        const edge = t === h1 * 60 + m1 || t + b.block_minutes === h2 * 60 + m2;
        out.push({ starts_at: iso, fit_rank: edge ? 1 : 3 });
      }
    }
  }
  return out;
}

function findCustomer(p: Row): string {
  const phone = String(p.p_phone ?? '').replace(/\s/g, '');
  const hit = db.customers.find((c) => c.phone.replace(/\s/g, '') === phone);
  if (hit) return hit.id;
  const c = { id: uid(), first_name: p.p_first_name ?? '', last_name: p.p_last_name ?? '', phone: p.p_phone ?? '', email: p.p_email ?? null, marketing_consent: false, created_at: new Date().toISOString() };
  db.customers.push(c);
  return c.id;
}

function minutesBetween(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

const RPC: Record<string, (p: Row) => Result> = {
  admin_overview: (p) => {
    const day = (iso: string) => isoToRome(iso).date;
    const today = p.p_date as string;
    const active = db.appointments.filter((a) => a.status !== 'cancelled');
    const open = db.booking_requests.filter((r) => r.status === 'pending' || r.status === 'reschedule');
    const isCons = (id: string) => byId('services', id)?.category === 'consultation';
    const wd = isoWeekday(today);
    return {
      data: {
        today_count: active.filter((a) => day(a.starts_at) === today).length,
        upcoming_count: active.filter((a) => day(a.starts_at) > today && day(a.starts_at) <= addDays(today, 7)).length,
        pending_requests: open.filter((r) => !isCons(r.service_id)).length,
        pending_consultations: open.filter((r) => isCons(r.service_id)).length,
        upcoming_consultations: active.filter((a) => day(a.starts_at) >= today && isCons(a.service_id)).length,
        cancelled_7d: db.appointments.filter((a) => a.status === 'cancelled').length,
        failed_notifications: 0,
        skipped_notifications_7d: 0,
        staff: db.staff
          .filter((s) => s.active)
          .map((s) => {
            const shifts = db.working_hours.filter((w) => w.staff_id === s.id && w.weekday === wd).map((w) => ({ start: w.start_time.slice(0, 5), end: w.end_time.slice(0, 5) }));
            const mine = active.filter((a) => a.staff_id === s.id && day(a.starts_at) === today);
            return {
              id: s.id,
              name: s.display_name,
              shifts,
              time_off: false,
              appointments: mine.length,
              booked_minutes: mine.reduce((t, a) => t + minutesBetween(a.starts_at, a.ends_at), 0),
              work_minutes: shifts.reduce((t, x) => t + minutesBetween(`2000-01-01T${x.start}:00Z`, `2000-01-01T${x.end}:00Z`), 0),
            };
          }),
      },
      error: null,
    };
  },
  admin_customers: (p) => {
    const q = String(p.p_query ?? '').toLowerCase();
    const now = new Date().toISOString();
    const rows = db.customers
      .filter((c) => !q || `${c.first_name} ${c.last_name} ${c.phone} ${c.email ?? ''}`.toLowerCase().includes(q))
      .map((c) => {
        const list = db.appointments.filter((a) => a.customer_id === c.id && a.status !== 'cancelled').map((a) => a.starts_at).sort();
        const past = list.filter((x) => x < now);
        const next = list.filter((x) => x >= now);
        return { ...c, past_count: past.length, upcoming_count: next.length, last_visit: past.at(-1) ?? null, next_visit: next[0] ?? null };
      })
      .sort((a: Row, b: Row) => a.last_name.localeCompare(b.last_name));
    return { data: rows.slice(0, p.p_limit ?? 100), error: null };
  },
  admin_search_appointments: (p) => {
    const q = String(p.p_query ?? '').toLowerCase();
    const ids = db.appointments
      .filter((a) => {
        const c = byId('customers', a.customer_id);
        return `${a.code} ${c ? fullName(c) : ''} ${c?.phone ?? ''} ${c?.email ?? ''}`.toLowerCase().includes(q);
      })
      .map((a) => ({ id: a.id }));
    return { data: ids, error: null };
  },
  bundle_info: (p) => {
    const { items: _items, ...b } = bundle(p.p_service_ids ?? []); // eslint-disable-line @typescript-eslint/no-unused-vars
    return { data: [b], error: null };
  },
  get_bundle_slots: (p) => ({ data: slots(p), error: null }),
  admin_gap_suggestions: () => ({ data: [], error: null }),
  admin_retry_notification: () => ({ data: null, error: null }),
  admin_create_appointment: (p) =>
    newAppointment({ serviceIds: p.p_service_ids, staffId: p.p_staff_id, startsAt: p.p_starts_at, customerId: findCustomer(p), source: 'admin', force: p.p_allow_outside_hours, notes: p.p_internal_notes }),
  admin_update_appointment: (p) => {
    const a = byId('appointments', p.p_appointment_id);
    if (!a || a.status !== 'confirmed') return fail('APPOINTMENT_NOT_ACTIVE');
    const r = place({ serviceIds: p.p_service_ids, staffId: p.p_staff_id, startsAt: p.p_starts_at, force: p.p_allow_outside_hours, ignore: a.id });
    if (r.error) return fail(r.error);
    const moved = a.starts_at !== p.p_starts_at || a.staff_id !== p.p_staff_id;
    Object.assign(a, {
      starts_at: new Date(Date.parse(p.p_starts_at)).toISOString(),
      ends_at: r.ends,
      staff_id: p.p_staff_id,
      service_id: p.p_service_ids[0],
      appointment_items: r.items,
      total_price_cents: r.b!.price_cents,
      price_is_estimate: r.b!.price_is_estimate,
      rescheduled_at: moved ? new Date().toISOString() : a.rescheduled_at,
    });
    return { data: { notification_ids: [] }, error: null };
  },
  admin_cancel_appointment: (p) => {
    const a = byId('appointments', p.p_appointment_id);
    if (!a || a.status !== 'confirmed') return fail('APPOINTMENT_NOT_ACTIVE');
    Object.assign(a, { status: 'cancelled', cancelled_at: new Date().toISOString(), internal_notes: p.p_reason ?? a.internal_notes });
    return { data: { notification_ids: [] }, error: null };
  },
  admin_confirm_request: (p) => {
    const r = byId('booking_requests', p.p_request_id);
    if (!r) return fail('REQUEST_NOT_FOUND');
    if (r.status !== 'pending' && r.status !== 'reschedule') return fail('REQUEST_NOT_CONFIRMABLE');
    const ids = (r.booking_request_items ?? []).sort((a: Row, b: Row) => a.position - b.position).map((i: Row) => i.service_id);
    const res = newAppointment({ serviceIds: ids.length ? ids : [r.service_id], staffId: p.p_staff_id, startsAt: p.p_starts_at, customerId: r.customer_id, source: 'request', force: p.p_allow_outside_hours, notes: p.p_internal_notes, requestId: r.id });
    if (res.error) return res;
    r.status = 'confirmed';
    return res;
  },
  admin_propose_request_time: (p) => {
    const r = byId('booking_requests', p.p_request_id);
    if (!r) return fail('REQUEST_NOT_FOUND');
    Object.assign(r, { proposed_starts_at: p.p_starts_at, proposed_staff_id: p.p_staff_id, admin_notes: p.p_admin_notes ?? r.admin_notes });
    return { data: { notification_ids: [] }, error: null };
  },
  admin_set_request_status: (p) => {
    const r = byId('booking_requests', p.p_request_id);
    if (!r) return fail('REQUEST_NOT_FOUND');
    Object.assign(r, { status: p.p_status, admin_notes: p.p_admin_notes ?? r.admin_notes });
    return { data: { notification_ids: [] }, error: null };
  },
};

// ---------------------------------------------------------------- client

const session = {
  access_token: 'demo',
  refresh_token: 'demo',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: DEMO_USER.id, email: DEMO_USER.email, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
};

export function createDemoClient(): SupabaseClient {
  const client = {
    from: (table: string) => new Query(table),
    rpc: (name: string, params: Row = {}) => ({
      then(ok?: (v: Result) => unknown, ko?: (e: unknown) => unknown) {
        const fn = RPC[name];
        let res: Result;
        try {
          res = fn ? fn(params) : fail(`Funzione non disponibile nella demo: ${name}`);
        } catch (e) {
          res = fail((e as Error).message);
        }
        return new Promise<Result>((r) => setTimeout(() => r(res), 80)).then(ok, ko);
      },
    }),
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => {
        window.location.assign('/admin');
        return { error: null };
      },
    },
  };
  return client as unknown as SupabaseClient;
}
