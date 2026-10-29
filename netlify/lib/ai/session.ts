/**
 * Sessioni di chat senza salvataggio dei testi.
 *
 * - Il browser riceve un token casuale; nel database c'è solo il suo hash SHA-256.
 * - La breve cronologia necessaria al contesto resta nel browser (in memoria) e
 *   viene rimandata dal client: ogni messaggio è firmato dal server con HMAC
 *   legato alla sessione, così il client non può inserire finti messaggi
 *   dell'assistente né riusare messaggi di un'altra sessione.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type Role = 'user' | 'assistant';

export function signMessage(secret: string, sessionId: string, role: Role, text: string): string {
  return createHmac('sha256', secret).update(`${sessionId}\u0000${role}\u0000${text}`).digest('base64url').slice(0, 32);
}

export function verifyMessage(secret: string, sessionId: string, role: Role, text: string, sig: string | undefined): boolean {
  if (!sig || sig.length !== 32) return false;
  const expected = Buffer.from(signMessage(secret, sessionId, role, text));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
