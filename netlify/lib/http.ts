import { createHash } from 'node:crypto';
import { ConfigError, getServerEnv, type ServerEnv } from './env';
import { createDb, DbError, type Db } from './db';
import type { AiEnv } from './ai/config';
import type { ModelClient } from './ai/model';

export interface Deps {
  env: ServerEnv;
  db: Db;
  ip: string;
  fetch: typeof fetch;
  /** Solo Maylana AI: configurazione e client del modello (sostituibili nei test). */
  ai?: { env?: AiEnv; model?: ModelClient };
}

/** Errore applicativo con messaggio sicuro da mostrare all'utente. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/** Messaggi in italiano per i codici sollevati dalle funzioni SQL. */
const DB_MESSAGES: Record<string, [number, string]> = {
  SLOT_UNAVAILABLE: [409, "L'orario selezionato non è più disponibile. Scegli un altro orario."],
  SERVICE_NOT_BOOKABLE: [400, 'Il servizio selezionato non è prenotabile online.'],
  BOOKING_DISABLED: [503, 'Le prenotazioni online sono momentaneamente sospese.'],
  PRIVACY_REQUIRED: [400, "È necessario accettare l'informativa privacy."],
  INVALID_NAME: [400, 'Inserisci nome e cognome.'],
  INVALID_PHONE: [400, 'Numero di telefono non valido.'],
  INVALID_EMAIL: [400, 'Indirizzo email non valido.'],
  INVALID_NOTES: [400, 'Le note sono troppo lunghe.'],
  INVALID_DATE: [400, 'Data non valida o fuori dal periodo prenotabile.'],
  INVALID_TIME_WINDOW: [400, 'Fascia oraria non valida.'],
  INVALID_STAFF: [400, 'Operatore non valido.'],
  TOO_MANY_PENDING: [429, 'Hai già delle richieste in attesa: ti ricontatteremo al più presto.'],
  INVALID_TOKEN: [404, 'Link non valido o scaduto. Usa il link più recente ricevuto via email oppure contatta il salone.'],
  CHANGE_DEADLINE_PASSED: [409, 'Non è più possibile modificare online questo appuntamento: contatta il salone.'],
  SELF_RESCHEDULE_NOT_ALLOWED: [400, 'Per questo servizio puoi solo richiedere lo spostamento al salone.'],
  RESCHEDULE_ALREADY_REQUESTED: [409, 'Hai già una richiesta di spostamento in attesa.'],
  SAME_TIME: [400, "Hai scelto lo stesso orario dell'appuntamento attuale."],
  APPOINTMENT_NOT_ACTIVE: [409, "L'appuntamento non è più attivo."],
  REQUIRES_APPROVAL: [400, 'Questa combinazione richiede la conferma del salone: invia una richiesta.'],
  USE_AUTOMATIC_BOOKING: [400, 'Questi servizi si prenotano direttamente scegliendo un orario.'],
  NO_STAFF_FOR_COMBINATION: [409, 'Nessun operatore esegue tutti questi servizi nello stesso appuntamento: riduci la selezione o contatta il salone.'],
  CONSULTATION_SINGLE: [400, 'Le consulenze si prenotano singolarmente.'],
  INVALID_SERVICES: [400, 'Selezione dei servizi non valida.'],
  IDEMPOTENCY_CONFLICT: [409, 'Richiesta duplicata non valida: ricarica la pagina e riprova.'],
};

export function mapDbError(err: unknown): ApiError {
  if (err instanceof DbError) {
    const mapped = DB_MESSAGES[err.message];
    if (mapped) return new ApiError(mapped[0], err.message, mapped[1]);
  }
  return new ApiError(500, 'SERVER_ERROR', 'Si è verificato un errore. Riprova tra qualche minuto.');
}

export function hashKey(salt: string, value: string): string {
  return createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 40);
}

/**
 * Rate limiting persistente su Postgres (tabella api_rate_limits).
 * In caso di errore del database la richiesta viene rifiutata (fail-closed).
 */
export async function enforceRateLimit(
  deps: Deps,
  scope: string,
  identifier: string,
  max: number,
  windowSeconds: number,
): Promise<void> {
  const bucket = `${scope}:${hashKey(deps.env.rateLimitSalt, identifier)}:${windowSeconds}`;
  let allowed: boolean;
  try {
    allowed = await deps.db.rpc<boolean>('check_rate_limit', {
      p_bucket: bucket,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
  } catch {
    throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Servizio momentaneamente non disponibile. Riprova.');
  }
  if (allowed !== true) {
    throw new ApiError(429, 'RATE_LIMITED', 'Troppe richieste. Attendi qualche minuto e riprova.');
  }
}

/** Blocca POST provenienti da origini diverse dal sito di prenotazione. */
export function assertAllowedOrigin(req: Request, env: ServerEnv): void {
  const origin = req.headers.get('origin');
  if (!origin) return; // richieste server-to-server o browser che non inviano Origin
  const clean = origin.replace(/\/+$/, '');
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean) && process.env.CONTEXT === 'dev';
  if (env.allowedOrigins.includes(clean) || isLocal) return;
  throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origine della richiesta non consentita.');
}

/** Controlli anti-spam: honeypot e tempo minimo di compilazione. */
export function assertHuman(body: { website?: unknown; formStartedAt?: unknown }): void {
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    throw new ApiError(400, 'SPAM_DETECTED', 'Richiesta non valida.');
  }
  const started = Number(body.formStartedAt);
  const elapsed = Date.now() - started;
  if (!Number.isFinite(started) || elapsed < 3000 || elapsed > 6 * 60 * 60 * 1000) {
    throw new ApiError(400, 'FORM_EXPIRED', 'Il modulo è scaduto o è stato inviato troppo velocemente. Ricarica la pagina e riprova.');
  }
}

export function clientIp(req: Request, contextIp?: string): string {
  return (
    contextIp ||
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 10_000) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Richiesta troppo grande.');
  const text = await req.text();
  if (text.length > 10_000) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Richiesta troppo grande.');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* gestito sotto */
  }
  throw new ApiError(400, 'INVALID_JSON', 'Richiesta non valida.');
}

type Handler = (req: Request, deps: Deps) => Promise<Response>;

/** Wrapper comune: configurazione, metodo, errori. */
export function endpoint(methods: string[], handler: Handler) {
  return async (req: Request, context?: { ip?: string }): Promise<Response> => {
    if (!methods.includes(req.method)) {
      return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Metodo non consentito.' } }, { Allow: methods.join(', ') });
    }
    try {
      const env = getServerEnv();
      const deps: Deps = { env, db: createDb(env), ip: clientIp(req, context?.ip), fetch };
      return await handler(req, deps);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/**
 * Verifica server-side dell'amministratore: JWT di Supabase Auth valido
 * e presenza in admin_users. Ritorna id e ruolo.
 */
export async function requireAdmin(req: Request, deps: Deps): Promise<{ userId: string; role: 'owner' | 'staff' }> {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(auth)) throw new ApiError(401, 'UNAUTHORIZED', 'Accesso richiesto.');
  let res: Response;
  try {
    res = await deps.fetch(`${deps.env.supabaseUrl}/auth/v1/user`, { headers: { apikey: deps.env.serviceKey, Authorization: auth } });
  } catch {
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Verifica accesso non disponibile. Riprova.');
  }
  if (!res.ok) throw new ApiError(401, 'UNAUTHORIZED', 'Sessione scaduta: accedi di nuovo.');
  const user = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!user?.id || !/^[0-9a-f-]{36}$/.test(user.id)) throw new ApiError(401, 'UNAUTHORIZED', 'Sessione non valida.');
  const rows = await deps.db.select<{ role: 'owner' | 'staff' }[]>(`admin_users?user_id=eq.${user.id}&select=role`);
  if (!rows.length) throw new ApiError(403, 'FORBIDDEN', 'Account non abilitato.');
  return { userId: user.id, role: rows[0].role };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json(err.status, { error: { code: err.code, message: err.message } });
  }
  if (err instanceof ConfigError) {
    console.error('[config]', err.message);
    return json(503, { error: { code: 'NOT_CONFIGURED', message: 'Sistema di prenotazione non ancora configurato.' } });
  }
  const mapped = mapDbError(err);
  if (mapped.status >= 500) console.error('[api]', err);
  return json(mapped.status, { error: { code: mapped.code, message: mapped.message } });
}
