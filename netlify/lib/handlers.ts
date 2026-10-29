/**
 * Logica degli endpoint pubblici, separata dai file in netlify/functions
 * per poterla testare con dipendenze simulate.
 */
import {
  ApiError,
  assertAllowedOrigin,
  assertHuman,
  enforceRateLimit,
  json,
  mapDbError,
  readJson,
  requireAdmin,
  type Deps,
} from './http';
import {
  availabilityQuery,
  bookingBody,
  dispatchBody,
  isValidCalendarDate,
  manageAvailabilityBody,
  manageBody,
  manageRequestBody,
  manageRescheduleBody,
  parse,
  requestBody,
} from './validation';
import { emailOutcome, hashToken, processNotifications } from './notify';
import { emailConfigProblem } from './env';
import { DbError } from './db';
import { whatsappCloudStatus } from './whatsapp/cloud-api';
import { aiServerStatus, readAiEnv } from './ai/config';

export interface SettingsRow {
  business_name: string;
  logo_url: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  privacy_url: string | null;
  public_notice: string | null;
  booking_horizon_days: number;
  min_notice_minutes: number;
  online_booking_enabled: boolean;
  booking_buffer_minutes: number;
  whatsapp_number: string | null;
}

export interface ServiceRow {
  id: string;
  category: 'hair' | 'consultation';
  public_group: string;
  name: string;
  description: string | null;
  price_cents: number | null;
  price_from: boolean;
  duration_minutes: number | null;
  buffer_after_minutes: number;
  booking_mode: 'automatic' | 'manual';
  sort_order: number;
}

interface StaffRow {
  id: string;
  display_name: string;
  bio: string | null;
  staff_services: { service_id: string }[];
}

export interface SlotRow {
  staff_id: string;
  staff_name: string;
  starts_at: string;
  ends_at: string;
  fit_rank?: number;
}

export interface BundleRow {
  valid: boolean;
  error: string | null;
  duration_minutes: number;
  buffer_minutes: number;
  block_minutes: number;
  price_cents: number | null;
  price_is_estimate: boolean;
  all_automatic: boolean;
  is_consultation: boolean;
  label: string | null;
  eligible_staff: string[];
}

const SETTINGS_FIELDS =
  'business_name,logo_url,contact_phone,contact_email,address,privacy_url,public_notice,booking_horizon_days,min_notice_minutes,online_booking_enabled,booking_buffer_minutes,whatsapp_number';

// ---------------------------------------------------------------------
// GET /api/catalog — impostazioni pubbliche, servizi e operatori attivi
// ---------------------------------------------------------------------
export type CatalogData = {
  settings: SettingsRow;
  services: ServiceRow[];
  staff: { id: string; display_name: string; bio: string | null; service_ids: string[] }[];
};

/** Catalogo pubblico (stesse regole per la pagina /prenota e per Maylana AI). */
export async function loadCatalog(deps: Deps): Promise<CatalogData> {
  const [settingsRows, services, staff] = await Promise.all([
    deps.db.select<SettingsRow[]>(`business_settings?id=eq.1&select=${SETTINGS_FIELDS}`),
    deps.db.select<ServiceRow[]>(
      'services?active=eq.true&select=id,category,public_group,name,description,price_cents,price_from,duration_minutes,buffer_after_minutes,booking_mode,sort_order&order=sort_order.asc,name.asc',
    ),
    deps.db.select<StaffRow[]>('staff?active=eq.true&select=id,display_name,bio,staff_services(service_id)&order=sort_order.asc,display_name.asc'),
  ]).catch((err) => {
    throw mapDbError(err);
  });

  const settings = settingsRows[0];
  if (!settings) throw new ApiError(503, 'NOT_CONFIGURED', 'Sistema di prenotazione non ancora configurato.');

  const activeIds = new Set(services.map((s) => s.id));
  const staffOut = staff.map((s) => ({
    id: s.id,
    display_name: s.display_name,
    bio: s.bio,
    service_ids: s.staff_services.map((x) => x.service_id).filter((id) => activeIds.has(id)),
  }));
  const bookableByStaff = new Set(staffOut.flatMap((s) => s.service_ids));

  // I servizi automatici senza operatori abilitati non sono prenotabili: non li mostriamo.
  const servicesOut = services.filter((s) => s.booking_mode === 'manual' || bookableByStaff.has(s.id));
  return { settings, services: servicesOut, staff: staffOut };
}

export async function catalogHandler(_req: Request, deps: Deps): Promise<Response> {
  await enforceRateLimit(deps, 'catalog', deps.ip, 120, 60);
  const c = await loadCatalog(deps);
  return json(200, c, { 'Cache-Control': 'public, max-age=60' });
}

export async function bundle(deps: Deps, ids: string[]): Promise<BundleRow> {
  const rows = await deps.db.rpc<BundleRow[]>('bundle_info', { p_service_ids: ids }).catch((err) => {
    throw mapDbError(err);
  });
  const b = Array.isArray(rows) ? rows[0] : (rows as unknown as BundleRow);
  if (!b) throw new ApiError(500, 'SERVER_ERROR', 'Servizi non verificabili.');
  if (!b.valid) throw mapDbError(new DbError(b.error ?? 'SERVICE_NOT_BOOKABLE', 'P0001', 400));
  return b;
}

export function bundleSummary(b: BundleRow) {
  return {
    label: b.label,
    duration_minutes: b.duration_minutes,
    buffer_minutes: b.buffer_minutes,
    total_minutes: b.block_minutes,
    price_cents: b.price_cents,
    price_is_estimate: b.price_is_estimate,
    requires_approval: !b.all_automatic,
    staff_count: b.eligible_staff.length,
  };
}

// ---------------------------------------------------------------------
// GET /api/availability?serviceIds=a,b&date=YYYY-MM-DD[&staffId=]
// Orari calcolati dal database per l'INTERA combinazione, con consigliati.
// ---------------------------------------------------------------------
export async function availabilityHandler(req: Request, deps: Deps): Promise<Response> {
  await enforceRateLimit(deps, 'availability', deps.ip, 90, 60);

  const url = new URL(req.url);
  const q = parse(availabilityQuery, {
    serviceIds: (url.searchParams.get('serviceIds') ?? url.searchParams.get('serviceId') ?? '').split(',').filter(Boolean),
    date: url.searchParams.get('date') ?? '',
    staffId: url.searchParams.get('staffId') || null,
  });
  if (!isValidCalendarDate(q.date)) throw new ApiError(400, 'VALIDATION_ERROR', 'Data non valida.');

  return json(200, await computeAvailability(deps, q.serviceIds, q.date, q.staffId ?? null));
}

/**
 * Orari disponibili per una combinazione di servizi in una data, dal motore del database.
 * Usata da GET /api/availability e dagli strumenti di Maylana AI (stessi controlli).
 */
export async function computeAvailability(deps: Deps, serviceIds: string[], date: string, staffId: string | null) {
  const b = await bundle(deps, serviceIds);
  if (!b.all_automatic || b.is_consultation) {
    throw new ApiError(400, 'REQUIRES_APPROVAL', 'Questa combinazione richiede la conferma del salone: invia una richiesta.');
  }

  const [slots, settingsRows] = await Promise.all([
    deps.db.rpc<SlotRow[]>('get_bundle_slots', {
      p_service_ids: serviceIds,
      p_date: date,
      p_staff_id: staffId,
      p_apply_booking_window: true,
      p_ignore_appointment_id: null,
    }),
    deps.db.select<{ max_recommended_slots: number; smart_slots_enabled: boolean }[]>('business_settings?id=eq.1&select=max_recommended_slots,smart_slots_enabled'),
  ]).catch((err) => {
    throw mapDbError(err);
  });

  const cfg = settingsRows[0] ?? { max_recommended_slots: 3, smart_slots_enabled: true };
  return {
    date,
    bundle: bundleSummary(b),
    times: groupSlots(slots, cfg.smart_slots_enabled ? cfg.max_recommended_slots : 0),
  };
}

/**
 * Raggruppa per orario e marca come "consigliati" i primi N orari che riempiono
 * meglio l'agenda (fit_rank 0 = riempie esattamente uno spazio, 1 = attaccato a
 * un appuntamento/inizio/fine turno). Tutti gli orari validi restano selezionabili.
 */
export function groupSlots(slots: SlotRow[], maxRecommended = 0) {
  const byTime = new Map<string, { starts_at: string; ends_at: string; rank: number; recommended: boolean; staff: { id: string; name: string }[] }>();
  for (const s of slots) {
    const key = new Date(s.starts_at).toISOString();
    const entry = byTime.get(key) ?? { starts_at: key, ends_at: new Date(s.ends_at).toISOString(), rank: 9, recommended: false, staff: [] };
    entry.staff.push({ id: s.staff_id, name: s.staff_name });
    entry.rank = Math.min(entry.rank, s.fit_rank ?? 2);
    byTime.set(key, entry);
  }
  const list = [...byTime.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  list
    .filter((t) => t.rank <= 1)
    .sort((a, b) => a.rank - b.rank || a.starts_at.localeCompare(b.starts_at))
    .slice(0, maxRecommended)
    .forEach((t) => (t.recommended = true));
  return list.map(({ rank: _r, ...t }) => (void _r, t));
}

/** Invio immediato (best effort) delle email appena accodate. Gli errori restano in coda per il retry. */
async function dispatchNow(deps: Deps, ids: (string | null | undefined)[]) {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return [];
  try {
    return await processNotifications(deps, { ids: list, timeBudgetMs: 6000 });
  } catch (err) {
    console.error('[dispatchNow]', err);
    return [];
  }
}

/** Esito email per una richiesta ripetuta: si legge lo stato registrato, non si reinvia. */
async function storedEmailOutcome(deps: Deps, id: string | null): Promise<'sent' | 'not_sent' | 'pending'> {
  if (!id) return 'not_sent';
  const rows = await deps.db.select<{ status: string }[]>(`notifications?id=eq.${id}&select=status`).catch(() => []);
  const st = rows[0]?.status;
  return st === 'sent' ? 'sent' : st === 'pending' || st === 'sending' ? 'pending' : 'not_sent';
}

// ---------------------------------------------------------------------
// POST /api/book — prenotazione automatica multi-servizio (atomica, idempotente)
// ---------------------------------------------------------------------
export async function bookHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'book-ip', deps.ip, 8, 600);

  const raw = await readJson(req);
  const body = parse(bookingBody, raw);
  assertHuman(body);
  await enforceRateLimit(deps, 'book-phone', body.phone.replace(/\D/g, ''), 6, 86400);

  let rows: {
    appointment_id: string;
    code: string;
    starts_at: string;
    ends_at: string;
    staff_name: string;
    services_label: string;
    duration_minutes: number;
    total_price_cents: number | null;
    price_is_estimate: boolean;
    notification_id: string | null;
    replayed: boolean;
  }[];
  try {
    rows = await deps.db.rpc('book_appointment', {
      p_service_ids: body.serviceIds,
      p_staff_id: body.staffId ?? null,
      p_starts_at: body.startsAt,
      p_first_name: body.firstName,
      p_last_name: body.lastName,
      p_phone: body.phone,
      p_email: body.email,
      p_notes: body.notes ?? null,
      p_privacy_accepted: body.privacyAccepted,
      p_marketing_consent: body.marketingConsent,
      p_idempotency_key: body.idempotencyKey,
    });
  } catch (err) {
    throw mapDbError(err);
  }

  const appt = rows?.[0];
  // Nessuna conferma senza un record realmente salvato con codice.
  if (!appt?.code || !appt.appointment_id) {
    throw new ApiError(500, 'SERVER_ERROR', 'La prenotazione non è stata registrata. Riprova.');
  }

  // La prenotazione è già salvata: l'esito dell'email non la annulla, ma va riferito con onestà.
  const email = appt.replayed
    ? await storedEmailOutcome(deps, appt.notification_id)
    : emailOutcome(await dispatchNow(deps, [appt.notification_id]), appt.notification_id);

  return json(appt.replayed ? 200 : 201, {
    appointment: {
      code: appt.code,
      status: 'confirmed',
      starts_at: appt.starts_at,
      ends_at: appt.ends_at,
      staff_name: appt.staff_name,
      service_name: appt.services_label,
      duration_minutes: appt.duration_minutes,
      total_price_cents: appt.total_price_cents,
      price_is_estimate: appt.price_is_estimate,
    },
    replayed: appt.replayed,
    email,
  });
}

// ---------------------------------------------------------------------
// POST /api/request — richiesta da approvare (consulenze / combinazioni manuali)
// ---------------------------------------------------------------------
export async function requestHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'request-ip', deps.ip, 6, 600);

  const raw = await readJson(req);
  const body = parse(requestBody, raw);
  assertHuman(body);
  if (body.preferredDate && !isValidCalendarDate(body.preferredDate)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Data non valida.');
  }
  await enforceRateLimit(deps, 'request-phone', body.phone.replace(/\D/g, ''), 4, 86400);

  let rows: { request_id: string; code: string; status: string; notification_id: string | null; services_label: string; replayed: boolean }[];
  try {
    rows = await deps.db.rpc('create_booking_request', {
      p_service_ids: body.serviceIds,
      p_first_name: body.firstName,
      p_last_name: body.lastName,
      p_phone: body.phone,
      p_email: body.email,
      p_preferred_date: body.preferredDate ?? null,
      p_preferred_time_window: body.preferredTimeWindow,
      p_preferred_staff_id: body.preferredStaffId ?? null,
      p_notes: body.notes ?? null,
      p_privacy_accepted: body.privacyAccepted,
      p_marketing_consent: body.marketingConsent,
      p_idempotency_key: body.idempotencyKey,
    });
  } catch (err) {
    throw mapDbError(err);
  }

  const r = rows?.[0];
  if (!r?.code || !r.request_id) {
    throw new ApiError(500, 'SERVER_ERROR', 'La richiesta non è stata registrata. Riprova.');
  }
  const email = r.replayed
    ? await storedEmailOutcome(deps, r.notification_id)
    : emailOutcome(await dispatchNow(deps, [r.notification_id]), r.notification_id);
  return json(r.replayed ? 200 : 201, { request: { code: r.code, status: r.status, service_name: r.services_label }, replayed: r.replayed, email });
}

// ---------------------------------------------------------------------
// LINK CLIENTE — il token arriva nel corpo POST (mai nell'URL del server)
// e viene confrontato solo come hash SHA-256.
// ---------------------------------------------------------------------
interface ManagedAppointment {
  code: string;
  service_ids: string[];
  items: { name: string; duration_minutes: number; price_cents: number | null; price_from: boolean }[];
  duration_minutes: number;
  total_price_cents: number | null;
  price_is_estimate: boolean;
  status: string;
  service_name: string;
  category: 'hair' | 'consultation';
  self_reschedule: boolean;
  starts_at: string;
  ends_at: string;
  staff_name: string;
  first_name: string;
  can_change: boolean;
  change_deadline: string;
  pending_reschedule_request: boolean;
}

async function loadManaged(deps: Deps, token: string): Promise<ManagedAppointment> {
  try {
    return await deps.db.rpc<ManagedAppointment>('customer_get_appointment', { p_token_hash: hashToken(token) });
  } catch (err) {
    throw mapDbError(err);
  }
}

function publicManaged(a: ManagedAppointment) {
  const { service_ids: _omit, ...rest } = a;
  void _omit;
  return rest;
}

export async function manageViewHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'manage-view', deps.ip, 30, 600);
  const body = parse(manageBody, await readJson(req));
  const a = await loadManaged(deps, body.token);
  return json(200, { appointment: publicManaged(a) });
}

export async function manageAvailabilityHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'manage-avail', deps.ip, 60, 600);
  const body = parse(manageAvailabilityBody, await readJson(req));
  if (!isValidCalendarDate(body.date)) throw new ApiError(400, 'VALIDATION_ERROR', 'Data non valida.');
  const a = await loadManaged(deps, body.token);
  if (!a.self_reschedule) throw new ApiError(400, 'SELF_RESCHEDULE_NOT_ALLOWED', 'Per questo servizio puoi solo richiedere lo spostamento al salone.');
  const [slots, cfgRows] = await Promise.all([
    deps.db.rpc<SlotRow[]>('customer_reschedule_slots', { p_token_hash: hashToken(body.token), p_date: body.date }),
    deps.db.select<{ max_recommended_slots: number; smart_slots_enabled: boolean }[]>('business_settings?id=eq.1&select=max_recommended_slots,smart_slots_enabled'),
  ]).catch((err) => {
    throw mapDbError(err);
  });
  const cfg = cfgRows[0] ?? { max_recommended_slots: 3, smart_slots_enabled: true };
  return json(200, { date: body.date, times: groupSlots(slots, cfg.smart_slots_enabled ? cfg.max_recommended_slots : 0) });
}

export async function manageCancelHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'manage-action', deps.ip, 10, 600);
  const body = parse(manageBody, await readJson(req));
  let res: { notification_ids: string[] };
  try {
    res = await deps.db.rpc('customer_cancel_appointment', { p_token_hash: hashToken(body.token) });
  } catch (err) {
    throw mapDbError(err);
  }
  const results = await dispatchNow(deps, res.notification_ids);
  return json(200, { cancelled: true, email: emailOutcome(results, res.notification_ids[0]) });
}

export async function manageRescheduleHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'manage-action', deps.ip, 10, 600);
  const body = parse(manageRescheduleBody, await readJson(req));
  let res: { starts_at: string; notification_ids: string[] };
  try {
    res = await deps.db.rpc('customer_reschedule_appointment', {
      p_token_hash: hashToken(body.token),
      p_new_starts_at: body.startsAt,
      p_staff_id: body.staffId ?? null,
    });
  } catch (err) {
    throw mapDbError(err);
  }
  const results = await dispatchNow(deps, res.notification_ids);
  return json(200, { starts_at: res.starts_at, email: emailOutcome(results, res.notification_ids[0]) });
}

export async function manageRequestHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'manage-action', deps.ip, 10, 600);
  const body = parse(manageRequestBody, await readJson(req));
  if (body.preferredDate && !isValidCalendarDate(body.preferredDate)) throw new ApiError(400, 'VALIDATION_ERROR', 'Data non valida.');
  let res: { request_code: string; notification_ids: string[] };
  try {
    res = await deps.db.rpc('customer_request_reschedule', {
      p_token_hash: hashToken(body.token),
      p_preferred_date: body.preferredDate ?? null,
      p_preferred_time_window: body.preferredTimeWindow,
      p_notes: body.notes ?? null,
    });
  } catch (err) {
    throw mapDbError(err);
  }
  const results = await dispatchNow(deps, res.notification_ids);
  return json(201, { request_code: res.request_code, email: emailOutcome(results, res.notification_ids[0]) });
}

// ---------------------------------------------------------------------
// ADMIN (JWT Supabase verificato lato server)
// ---------------------------------------------------------------------
export async function adminDispatchHandler(req: Request, deps: Deps): Promise<Response> {
  await requireAdmin(req, deps);
  await enforceRateLimit(deps, 'admin-dispatch', deps.ip, 60, 60);
  const body = parse(dispatchBody, await readJson(req));
  const results = await processNotifications(deps, { ids: body.ids, limit: 20, timeBudgetMs: 8000 });
  return json(200, { results, email_configured: emailConfigProblem(deps.env.email) === null });
}

export async function adminStatusHandler(req: Request, deps: Deps): Promise<Response> {
  await requireAdmin(req, deps);
  const problem = emailConfigProblem(deps.env.email);
  return json(200, {
    email: { configured: problem === null, problem, provider: deps.env.email.provider, from: problem ? null : deps.env.email.from },
    site_url: deps.env.siteUrl || null,
    whatsapp_cloud: whatsappCloudStatus(),
    ai: aiServerStatus(deps.ai?.env ?? readAiEnv(deps.env.rateLimitSalt)),
  });
}

// ---------------------------------------------------------------------
// PROCESSO SCHEDULATO: promemoria + retry
// ---------------------------------------------------------------------
export async function scheduledRun(deps: Deps): Promise<{ enqueued: number; results: Awaited<ReturnType<typeof processNotifications>> }> {
  const enqueued = await deps.db.rpc<number>('enqueue_due_reminders', {});
  const results = await processNotifications(deps, { limit: 50, timeBudgetMs: 20000 });
  // Maylana AI: eliminazione delle sessioni scadute (nessun contenuto, solo contatori)
  await deps.db.rpc<number>('ai_purge', {}).catch(() => console.error('[scheduled] pulizia sessioni AI non riuscita'));
  return { enqueued, results };
}
