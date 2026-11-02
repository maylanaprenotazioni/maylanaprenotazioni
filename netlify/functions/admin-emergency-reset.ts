import type { Config, Context } from '@netlify/functions';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, assertAllowedOrigin, endpoint, enforceRateLimit, json, readJson, type Deps } from '../lib/http';

/**
 * Recupero password di emergenza (senza email) per l'area riservata.
 * Attivo SOLO se nelle variabili d'ambiente Netlify è impostato
 * ADMIN_RECOVERY_CODE (min 20 caratteri). Chi conosce il codice può
 * impostare una nuova password per un account presente in admin_users.
 * Dopo l'uso si consiglia di cancellare la variabile.
 */
const MIN_CODE = 20;

function recoveryCode(): string {
  return (process.env.ADMIN_RECOVERY_CODE || '').trim();
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authHeaders(deps: Deps): Record<string, string> {
  const h: Record<string, string> = { apikey: deps.env.serviceKey, 'Content-Type': 'application/json' };
  if (deps.env.serviceKey.startsWith('eyJ')) h.Authorization = `Bearer ${deps.env.serviceKey}`;
  return h;
}

async function findUserId(deps: Deps, email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    const res = await deps.fetch(`${deps.env.supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: authHeaders(deps) });
    if (!res.ok) throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Servizio di accesso non disponibile. Riprova.');
    const body = (await res.json()) as { users?: { id: string; email?: string }[] };
    const users = body.users ?? [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < 200) break;
  }
  return null;
}

async function handler(req: Request, deps: Deps): Promise<Response> {
  const code = recoveryCode();
  if (req.method === 'GET') return json(200, { enabled: code.length >= MIN_CODE });
  if (code.length < MIN_CODE) {
    throw new ApiError(404, 'NOT_ENABLED', 'Recupero di emergenza non attivo: imposta ADMIN_RECOVERY_CODE su Netlify e ripubblica il sito.');
  }
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'emergency-reset', deps.ip, 5, 3600);
  await enforceRateLimit(deps, 'emergency-reset-all', 'all', 20, 3600);

  const body = await readJson(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const given = typeof body.code === 'string' ? body.code.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new ApiError(400, 'INVALID_EMAIL', 'Indirizzo email non valido.');
  if (password.length < 10 || password.length > 72) throw new ApiError(400, 'WEAK_PASSWORD', 'La nuova password deve avere da 10 a 72 caratteri.');

  const denied = new ApiError(403, 'DENIED', 'Codice di recupero o email non corretti.');
  if (!sameSecret(given, code)) throw denied;

  const userId = await findUserId(deps, email);
  if (!userId) throw denied;
  const rows = await deps.db.select<{ role: string }[]>(`admin_users?user_id=eq.${userId}&select=role`);
  if (!rows.length) throw denied;

  const res = await deps.fetch(`${deps.env.supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: authHeaders(deps),
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => null)) as { msg?: string } | null)?.msg || '';
    if (/password/i.test(msg)) throw new ApiError(400, 'WEAK_PASSWORD', 'Password non accettata: scegline una più lunga e meno comune.');
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Impossibile aggiornare la password. Riprova.');
  }
  console.log('[emergency-reset] password aggiornata per un account admin');
  return json(200, { ok: true });
}

const run = endpoint(['GET', 'POST'], handler);

export default (req: Request, context: Context) => run(req, { ip: context.ip });

export const config: Config = {
  path: '/api/admin/emergency-reset',
};
