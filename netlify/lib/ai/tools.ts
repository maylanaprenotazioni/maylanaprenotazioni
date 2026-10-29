/**
 * Strumenti server-side di Maylana AI, con contratto tipizzato.
 *
 * - Lo schema JSON (strict) è quello inviato a OpenAI; gli argomenti ricevuti
 *   sono comunque RIVALIDATI con zod: il modello non è una fonte affidabile.
 * - Gli strumenti sono SOLO in lettura e usano le stesse funzioni del backend
 *   delle prenotazioni tradizionali (catalogo, bundle_info, get_bundle_slots).
 * - Nessuno strumento scrive nel database, legge clienti o appuntamenti.
 *   prepare_booking / prepare_consultation_request preparano soltanto un
 *   riepilogo: la scrittura avviene con /api/book o /api/request dopo che il
 *   cliente ha inserito i dati in un modulo e ha confermato esplicitamente.
 */
import { z } from 'zod';
import { ApiError, mapDbError, type Deps } from '../http';
import { isValidCalendarDate } from '../validation';
import { bundle, computeAvailability, type CatalogData, type ServiceRow } from '../handlers';
import { addDays, formatDuration, formatPrice, isoToRome, isoWeekday } from '../../../src/lib/time';
import type { AiCard, AiServiceCard, AiTime } from '../../../src/lib/ai-types';

export const GROUP_VALUES = ['uomo', 'donna', 'trattamenti', 'acconciature', 'consulenze'] as const;

export interface ToolContext {
  deps: Deps;
  catalog: CatalogData;
  today: string; // YYYY-MM-DD (Europe/Rome)
  workingWeekdays: number[];
  openingWeekdays: number[];
  cards: AiCard[];
}

// ---------------------------------------------------------------------
// Schemi per il modello (Responses API, function tools, strict)
// ---------------------------------------------------------------------
const serviceIdsSchema = {
  type: 'array',
  description: 'ID dei servizi restituiti da get_services (1-5).',
  items: { type: 'string' },
};

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'get_services',
    description: 'Elenco dei servizi attivi del salone con durata, prezzo e modalità di prenotazione (online oppure su richiesta). Usalo prima di parlare di servizi o prezzi.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        group: { type: ['string', 'null'], enum: [...GROUP_VALUES, null], description: 'Categoria, oppure null per tutte.' },
      },
      required: ['group'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_service_details',
    description: 'Dettagli approvati di un singolo servizio (descrizione, durata, prezzo, operatori abilitati).',
    strict: true,
    parameters: {
      type: 'object',
      properties: { service_id: { type: 'string', description: 'ID del servizio da get_services.' } },
      required: ['service_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_availability',
    description: 'Orari realmente disponibili per una combinazione di servizi PRENOTABILI ONLINE in una data. Mostra al cliente solo questi orari.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        service_ids: serviceIdsSchema,
        date: { type: 'string', description: 'Data nel formato YYYY-MM-DD.' },
        staff_id: { type: ['string', 'null'], description: 'Operatore preferito, oppure null.' },
        part_of_day: { type: 'string', enum: ['mattina', 'pomeriggio', 'qualsiasi'] },
      },
      required: ['service_ids', 'date', 'staff_id', 'part_of_day'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'prepare_booking',
    description: 'Prepara il riepilogo di una prenotazione dopo che il cliente ha scelto un orario restituito da get_availability. NON salva nulla: il cliente dovrà inserire i dati e confermare nel modulo.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        service_ids: serviceIdsSchema,
        starts_at: { type: 'string', description: 'Valore starts_at esattamente come restituito da get_availability.' },
        staff_id: { type: ['string', 'null'], description: 'Operatore scelto, oppure null.' },
      },
      required: ['service_ids', 'starts_at', 'staff_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'prepare_consultation_request',
    description: 'Prepara una RICHIESTA da far approvare al salone (consulenze Capelli For You e servizi su richiesta). NON salva nulla: il cliente dovrà inserire i recapiti e confermare.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        service_ids: serviceIdsSchema,
        preferred_date: { type: ['string', 'null'], description: 'Data preferita YYYY-MM-DD, oppure null.' },
        time_window: { type: 'string', enum: ['mattina', 'pomeriggio', 'indifferente'] },
      },
      required: ['service_ids', 'preferred_date', 'time_window'],
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];
export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name) as readonly string[];

// ---------------------------------------------------------------------
// Validazione degli argomenti (zod)
// ---------------------------------------------------------------------
const ref = z.string().trim().min(1).max(120);
const refs = z.array(ref).min(1).max(5);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ARGS = {
  get_services: z.object({ group: z.enum(GROUP_VALUES).nullable() }).strict(),
  get_service_details: z.object({ service_id: ref }).strict(),
  get_availability: z
    .object({ service_ids: refs, date: isoDate, staff_id: ref.nullable(), part_of_day: z.enum(['mattina', 'pomeriggio', 'qualsiasi']) })
    .strict(),
  prepare_booking: z.object({ service_ids: refs, starts_at: z.string().datetime({ offset: true }), staff_id: ref.nullable() }).strict(),
  prepare_consultation_request: z
    .object({ service_ids: refs, preferred_date: isoDate.nullable(), time_window: z.enum(['mattina', 'pomeriggio', 'indifferente']) })
    .strict(),
} as const;

type ToolResult = Record<string, unknown>;

const fail = (error: string, message: string): ToolResult => ({ ok: false, error, message });

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Accetta ID o nomi esatti dei servizi del catalogo; altrimenti errore. */
export function resolveServices(ctx: ToolContext, list: string[]): ServiceRow[] | ToolResult {
  const out: ServiceRow[] = [];
  for (const r of list) {
    const byId = ctx.catalog.services.find((s) => s.id === r);
    const byName = byId ? null : ctx.catalog.services.filter((s) => norm(s.name) === norm(r));
    const s = byId ?? (byName && byName.length === 1 ? byName[0] : null);
    if (!s) return fail('UNKNOWN_SERVICE', `Servizio "${r.slice(0, 60)}" non trovato. Usa gli ID restituiti da get_services.`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function resolveStaff(ctx: ToolContext, ref: string | null): { id: string; name: string } | null | ToolResult {
  if (!ref) return null;
  const st = ctx.catalog.staff.find((s) => s.id === ref) ?? ctx.catalog.staff.find((s) => norm(s.display_name) === norm(ref));
  return st ? { id: st.id, name: st.display_name } : fail('UNKNOWN_STAFF', 'Operatore non trovato.');
}

const isFail = (x: unknown): x is ToolResult => !!x && typeof x === 'object' && (x as ToolResult).ok === false;

function serviceCard(_ctx: ToolContext, s: ServiceRow): AiServiceCard {
  return {
    id: s.id,
    name: s.name,
    group: s.public_group,
    description: s.description,
    durationMinutes: s.duration_minutes === null ? null : s.duration_minutes + (s.buffer_after_minutes ?? 0),
    priceCents: s.price_cents,
    priceFrom: s.price_from,
    bookable: s.booking_mode === 'automatic' && s.category === 'hair' ? 'online' : 'request',
  };
}

function priceText(cents: number | null, from: boolean): string {
  return cents === null ? 'prezzo da chiedere in salone' : formatPrice(cents, from);
}

/** Date proponibili per una richiesta: giorni lavorativi entro l'orizzonte di prenotazione. */
export function requestDates(ctx: ToolContext, max = 14): string[] {
  const horizon = ctx.catalog.settings.booking_horizon_days;
  const days = ctx.openingWeekdays.length ? ctx.workingWeekdays.filter((d) => ctx.openingWeekdays.includes(d)) : ctx.workingWeekdays;
  const out: string[] = [];
  for (let i = 1; i <= horizon && out.length < max; i++) {
    const d = addDays(ctx.today, i);
    if (!days.length || days.includes(isoWeekday(d))) out.push(d);
  }
  return out;
}

const hhmm = (iso: string) => isoToRome(iso).time;

// ---------------------------------------------------------------------
// Esecuzione
// ---------------------------------------------------------------------
async function getServices(ctx: ToolContext, a: z.infer<typeof ARGS.get_services>): Promise<ToolResult> {
  const list = ctx.catalog.services.filter((s) => !a.group || s.public_group === a.group);
  const cards = list.map((s) => serviceCard(ctx, s));
  if (cards.length) ctx.cards.push({ type: 'services', services: cards.slice(0, 12) });
  return {
    ok: true,
    services: cards.map((c) => ({
      id: c.id,
      name: c.name,
      group: c.group,
      duration: c.durationMinutes === null ? 'da definire' : formatDuration(c.durationMinutes),
      price: priceText(c.priceCents, c.priceFrom),
      booking: c.bookable === 'online' ? 'prenotabile online' : 'su richiesta da approvare',
    })),
    note: cards.length ? 'Le card con i servizi sono già mostrate al cliente.' : 'Nessun servizio attivo in questa categoria.',
  };
}

async function getServiceDetails(ctx: ToolContext, a: z.infer<typeof ARGS.get_service_details>): Promise<ToolResult> {
  const r = resolveServices(ctx, [a.service_id]);
  if (isFail(r)) return r;
  const s = (r as ServiceRow[])[0];
  const staff = ctx.catalog.staff.filter((x) => x.service_ids.includes(s.id)).map((x) => x.display_name);
  ctx.cards.push({ type: 'services', services: [serviceCard(ctx, s)] });
  return {
    ok: true,
    id: s.id,
    name: s.name,
    group: s.public_group,
    description: s.description ?? 'Nessuna descrizione approvata disponibile: suggerisci di contattare il salone per dettagli.',
    duration: s.duration_minutes === null ? 'da definire' : formatDuration(s.duration_minutes + (s.buffer_after_minutes ?? 0)),
    price: priceText(s.price_cents, s.price_from),
    booking: s.booking_mode === 'automatic' && s.category === 'hair' ? 'prenotabile online' : 'su richiesta da approvare',
    staff,
  };
}

async function getAvailability(ctx: ToolContext, a: z.infer<typeof ARGS.get_availability>): Promise<ToolResult> {
  if (!isValidCalendarDate(a.date)) return fail('INVALID_DATE', 'Data non valida.');
  if (a.date < ctx.today) return fail('PAST_DATE', 'La data è nel passato.');
  const r = resolveServices(ctx, a.service_ids);
  if (isFail(r)) return r;
  const services = r as ServiceRow[];
  const staff = resolveStaff(ctx, a.staff_id);
  if (isFail(staff)) return staff;
  if (services.some((s) => s.booking_mode !== 'automatic' || s.category !== 'hair')) {
    return fail('REQUIRES_APPROVAL', 'Questa combinazione non si prenota online: va inviata una richiesta con prepare_consultation_request.');
  }
  let av;
  try {
    av = await computeAvailability(ctx.deps, services.map((s) => s.id), a.date, (staff as { id: string } | null)?.id ?? null);
  } catch (err) {
    const e = err instanceof ApiError ? err : mapDbError(err);
    return fail(e.code, e.message);
  }
  const inPart = (t: { starts_at: string }) => {
    const h = Number(hhmm(t.starts_at).slice(0, 2));
    return a.part_of_day === 'qualsiasi' || (a.part_of_day === 'mattina' ? h < 13 : h >= 13);
  };
  const filtered = av.times.filter(inPart);
  const ordered = [...filtered.filter((t) => t.recommended), ...filtered.filter((t) => !t.recommended)];
  const times: AiTime[] = filtered.slice(0, 16).map((t) => ({ startsAt: t.starts_at, endsAt: t.ends_at, recommended: t.recommended, staff: t.staff }));
  if (times.length) {
    ctx.cards.push({
      type: 'slots',
      serviceIds: services.map((s) => s.id),
      label: av.bundle.label ?? services.map((s) => s.name).join(' + '),
      date: a.date,
      durationMinutes: av.bundle.total_minutes,
      priceCents: av.bundle.price_cents,
      priceIsEstimate: av.bundle.price_is_estimate,
      staffId: (staff as { id: string } | null)?.id ?? null,
      times,
      partOfDay: a.part_of_day,
    });
  }
  return {
    ok: true,
    date: a.date,
    services: av.bundle.label,
    total_duration: formatDuration(av.bundle.total_minutes),
    price: priceText(av.bundle.price_cents, av.bundle.price_is_estimate),
    available_count: filtered.length,
    times: ordered.slice(0, 8).map((t) => ({
      time: hhmm(t.starts_at),
      starts_at: t.starts_at,
      recommended: t.recommended,
      staff: t.staff.map((s) => s.name),
    })),
    note: filtered.length
      ? 'Gli orari sono già mostrati al cliente come pulsanti. Non inventare altri orari.'
      : 'Nessun orario libero in questa fascia: proponi un altro giorno o l\'altra fascia.',
  };
}

async function prepareBooking(ctx: ToolContext, a: z.infer<typeof ARGS.prepare_booking>): Promise<ToolResult> {
  const r = resolveServices(ctx, a.service_ids);
  if (isFail(r)) return r;
  const services = r as ServiceRow[];
  const staff = resolveStaff(ctx, a.staff_id);
  if (isFail(staff)) return staff;
  return prepareBookingFor(ctx, services.map((s) => s.id), a.starts_at, (staff as { id: string } | null)?.id ?? null);
}

/** Usata anche dall'azione "select_slot" del pulsante orario (senza modello). */
export async function prepareBookingFor(ctx: ToolContext, serviceIds: string[], startsAt: string, staffId: string | null): Promise<ToolResult> {
  const { date } = isoToRome(startsAt);
  let av;
  try {
    av = await computeAvailability(ctx.deps, serviceIds, date, staffId);
  } catch (err) {
    const e = err instanceof ApiError ? err : mapDbError(err);
    return fail(e.code, e.message);
  }
  const wanted = new Date(startsAt).getTime();
  const t = av.times.find((x) => new Date(x.starts_at).getTime() === wanted);
  if (!t) {
    return fail('SLOT_UNAVAILABLE', "Questo orario non è disponibile. Proponi gli altri orari restituiti da get_availability.");
  }
  const staffName = staffId ? (t.staff.find((s) => s.id === staffId)?.name ?? null) : t.staff.length === 1 ? t.staff[0].name : null;
  ctx.cards.push({
    type: 'booking',
    serviceIds,
    label: av.bundle.label ?? '',
    staffId,
    staffName,
    startsAt: t.starts_at,
    endsAt: t.ends_at,
    durationMinutes: av.bundle.total_minutes,
    priceCents: av.bundle.price_cents,
    priceIsEstimate: av.bundle.price_is_estimate,
  });
  return {
    ok: true,
    saved: false,
    summary: {
      services: av.bundle.label,
      date: date,
      time: hhmm(t.starts_at),
      duration: formatDuration(av.bundle.total_minutes),
      price: priceText(av.bundle.price_cents, av.bundle.price_is_estimate),
      staff: staffName ?? 'assegnato in base alla disponibilità',
    },
    next_step: 'Il riepilogo con il modulo dati è mostrato al cliente. NON è ancora prenotato: il cliente deve inserire i dati e premere "Conferma prenotazione".',
  };
}

async function prepareConsultation(ctx: ToolContext, a: z.infer<typeof ARGS.prepare_consultation_request>): Promise<ToolResult> {
  const r = resolveServices(ctx, a.service_ids);
  if (isFail(r)) return r;
  const services = r as ServiceRow[];
  return prepareRequestFor(ctx, services.map((s) => s.id), a.preferred_date, a.time_window);
}

export async function prepareRequestFor(
  ctx: ToolContext,
  serviceIds: string[],
  preferredDate: string | null,
  timeWindow: 'mattina' | 'pomeriggio' | 'indifferente',
): Promise<ToolResult> {
  let b;
  try {
    b = await bundle(ctx.deps, serviceIds);
  } catch (err) {
    const e = err instanceof ApiError ? err : mapDbError(err);
    return fail(e.code, e.message);
  }
  if (b.all_automatic && !b.is_consultation) {
    return fail('USE_AUTOMATIC_BOOKING', 'Questi servizi si prenotano online: usa get_availability e prepare_booking.');
  }
  const dates = requestDates(ctx);
  let pref = preferredDate;
  if (pref && (!isValidCalendarDate(pref) || pref <= ctx.today || pref > addDays(ctx.today, ctx.catalog.settings.booking_horizon_days))) pref = null;
  ctx.cards.push({
    type: 'request',
    serviceIds,
    label: b.label ?? '',
    isConsultation: b.is_consultation,
    preferredDate: pref,
    timeWindow,
    dates,
  });
  return {
    ok: true,
    saved: false,
    summary: { services: b.label, preferred_date: pref, time_window: timeWindow, status_after_sending: 'in attesa di approvazione del salone' },
    next_step: 'Il modulo per i recapiti è mostrato al cliente. Dopo l\'invio la richiesta resta IN ATTESA: Maylana deve approvarla. Non chiedere dati sanitari o foto.',
  };
}

/** Esegue uno strumento con argomenti non fidati. Errori sempre restituiti come dati, mai lanciati. */
export async function runTool(ctx: ToolContext, name: string, rawArgs: string): Promise<ToolResult> {
  if (!TOOL_NAMES.includes(name)) return fail('UNKNOWN_TOOL', 'Strumento non disponibile.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs || '{}');
  } catch {
    return fail('INVALID_ARGUMENTS', 'Argomenti non validi.');
  }
  const schema = ARGS[name as ToolName];
  const res = schema.safeParse(parsed);
  if (!res.success) return fail('INVALID_ARGUMENTS', 'Argomenti non validi per ' + name + '.');
  switch (name as ToolName) {
    case 'get_services':
      return getServices(ctx, res.data as z.infer<typeof ARGS.get_services>);
    case 'get_service_details':
      return getServiceDetails(ctx, res.data as z.infer<typeof ARGS.get_service_details>);
    case 'get_availability':
      return getAvailability(ctx, res.data as z.infer<typeof ARGS.get_availability>);
    case 'prepare_booking':
      return prepareBooking(ctx, res.data as z.infer<typeof ARGS.prepare_booking>);
    case 'prepare_consultation_request':
      return prepareConsultation(ctx, res.data as z.infer<typeof ARGS.prepare_consultation_request>);
  }
}

export { serviceCard, getAvailability as runAvailability, ARGS as TOOL_ARGS };
