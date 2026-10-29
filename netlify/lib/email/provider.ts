/**
 * Invio email transazionali via API HTTP (nessuna dipendenza).
 * Provider supportati: Resend, Brevo. Chiavi solo lato server.
 */
import { emailConfigProblem, type EmailEnv } from '../env';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Chiave di idempotenza (id notifica): evita doppi invii sui retry */
  idempotencyKey: string;
}

export type SendResult =
  | { ok: true; provider: string; messageId: string | null }
  | { ok: false; provider: string | null; error: string; retry: boolean; notConfigured?: boolean };

function parseFrom(from: string): { name: string; email: string } {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() };
  return { name: '', email: from.trim() };
}

function classify(status: number): boolean {
  // true = errore temporaneo, si può ritentare
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function sendEmail(cfg: EmailEnv, msg: OutgoingEmail, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const problem = emailConfigProblem(cfg);
  if (problem) {
    return { ok: false, provider: cfg.provider, error: `EMAIL_NOT_CONFIGURED: ${problem}`, retry: false, notConfigured: true };
  }

  try {
    if (cfg.provider === 'resend') {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': msg.idempotencyKey,
        },
        body: JSON.stringify({
          from: cfg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!res.ok) return { ok: false, provider: 'resend', error: `HTTP ${res.status}: ${body.message || body.name || 'errore'}`, retry: classify(res.status) };
      return { ok: true, provider: 'resend', messageId: body.id ?? null };
    }

    // Brevo
    const from = parseFrom(cfg.from);
    const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from.email, ...(from.name ? { name: from.name } : {}) },
        to: [{ email: msg.to }],
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
        ...(cfg.replyTo ? { replyTo: { email: cfg.replyTo } } : {}),
        headers: { 'X-Mailin-custom': `notification:${msg.idempotencyKey}` },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string; code?: string };
    if (!res.ok) return { ok: false, provider: 'brevo', error: `HTTP ${res.status}: ${body.message || body.code || 'errore'}`, retry: classify(res.status) };
    return { ok: true, provider: 'brevo', messageId: body.messageId ?? null };
  } catch (err) {
    return { ok: false, provider: cfg.provider, error: `Rete: ${(err as Error).message}`, retry: true };
  }
}
