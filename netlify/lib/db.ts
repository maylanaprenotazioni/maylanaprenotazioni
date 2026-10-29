/**
 * Client minimale per PostgREST di Supabase, usato SOLO lato server con la
 * service role key (o secret key). Nessuna dipendenza esterna.
 */
import type { ServerEnv } from './env';

export class DbError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly status: number,
  ) {
    super(message);
  }
}

export type FetchLike = typeof fetch;

function headers(env: ServerEnv): Record<string, string> {
  const h: Record<string, string> = {
    apikey: env.serviceKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  // Chiavi legacy (JWT "eyJ…") vanno anche in Authorization.
  // Le nuove secret key "sb_secret_…" vanno solo in apikey.
  if (env.serviceKey.startsWith('eyJ')) h.Authorization = `Bearer ${env.serviceKey}`;
  return h;
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { message?: string; code?: string };
    throw new DbError(b.message || `Errore database (${res.status})`, b.code, res.status);
  }
  return body as T;
}

export function createDb(env: ServerEnv, fetchImpl: FetchLike = fetch) {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const res = await fetchImpl(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: headers(env),
        body: JSON.stringify(args),
      });
      return handle<T>(res);
    },
    async select<T>(pathAndQuery: string): Promise<T> {
      const res = await fetchImpl(`${env.supabaseUrl}/rest/v1/${pathAndQuery}`, {
        method: 'GET',
        headers: headers(env),
      });
      return handle<T>(res);
    },
  };
}

export type Db = ReturnType<typeof createDb>;
