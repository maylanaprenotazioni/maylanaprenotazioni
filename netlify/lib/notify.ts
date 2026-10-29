/**
 * Elaborazione della coda notifiche.
 *  - claim atomico (FOR UPDATE SKIP LOCKED): due processi non inviano la stessa email
 *  - contesto letto al momento dell'invio: niente email su stati non più veri
 *  - link personale: token casuale generato qui, nel DB solo l'hash
 *  - esito registrato SEMPRE: sent / failed (con retry) / skipped
 *  - mai "inviata" senza conferma del provider
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Deps } from './http';
import { sendEmail } from './email/provider';
import { renderEmail, type NotificationContext } from './email/templates';

export interface NotificationResult {
  id: string;
  status: 'sent' | 'failed' | 'skipped' | 'pending' | 'error';
  error?: string;
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

interface ClaimedRow {
  id: string;
  attempts: number;
  max_attempts: number;
}

async function complete(
  deps: Deps,
  id: string,
  status: 'sent' | 'failed' | 'skipped',
  extra: { error?: string; retry?: boolean; recipient?: string | null; provider?: string | null; messageId?: string | null } = {},
): Promise<NotificationResult['status']> {
  const final = await deps.db.rpc<string>('complete_notification', {
    p_id: id,
    p_status: status,
    p_error: extra.error ?? null,
    p_retry: extra.retry ?? false,
    p_recipient: extra.recipient ?? null,
    p_provider: extra.provider ?? null,
    p_provider_message_id: extra.messageId ?? null,
  });
  return (final as NotificationResult['status']) ?? status;
}

export async function processNotifications(
  deps: Deps,
  opts: { ids?: string[]; limit?: number; timeBudgetMs?: number } = {},
): Promise<NotificationResult[]> {
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? 8000;
  const claimed = await deps.db.rpc<ClaimedRow[]>('claim_notifications', {
    p_limit: opts.limit ?? 20,
    p_ids: opts.ids && opts.ids.length ? opts.ids : null,
  });

  const results: NotificationResult[] = [];
  for (const row of claimed) {
    if (Date.now() - started > budget) {
      // Tempo esaurito: rimetti in coda per il prossimo giro (nessun invio fatto)
      const st = await complete(deps, row.id, 'failed', { error: 'Rinviata: tempo di esecuzione esaurito', retry: true });
      results.push({ id: row.id, status: st === 'pending' ? 'pending' : 'failed' });
      continue;
    }
    results.push(await processOne(deps, row));
  }
  return results;
}

async function processOne(deps: Deps, row: ClaimedRow): Promise<NotificationResult> {
  let tokenId: string | null = null;
  try {
    if (row.attempts > row.max_attempts) {
      const st = await complete(deps, row.id, 'failed', { error: 'Numero massimo di tentativi superato' });
      return { id: row.id, status: st as NotificationResult['status'] };
    }

    const ctx = await deps.db.rpc<NotificationContext>('notification_context', { p_id: row.id });

    if (!ctx.valid) {
      await complete(deps, row.id, 'skipped', { error: ctx.invalid_reason ?? 'Non più valida' });
      return { id: row.id, status: 'skipped', error: ctx.invalid_reason ?? undefined };
    }
    if (!ctx.recipient) {
      const reason = ctx.audience === 'salon' ? 'Email del salone non configurata (Impostazioni)' : 'Cliente senza indirizzo email';
      await complete(deps, row.id, 'skipped', { error: reason });
      return { id: row.id, status: 'skipped', error: reason };
    }

    let manageUrl: string | null = null;
    if (ctx.needs_link && ctx.appointment && deps.env.siteUrl) {
      const { token, hash } = newToken();
      tokenId = await deps.db.rpc<string>('issue_manage_token', { p_appointment_id: ctx.appointment.id, p_token_hash: hash });
      manageUrl = `${deps.env.siteUrl}/gestisci#t=${token}`;
    }

    const email = renderEmail(ctx, {
      manageUrl,
      adminUrl: deps.env.siteUrl ? `${deps.env.siteUrl}/admin` : null,
    });

    const res = await sendEmail(deps.env.email, { to: ctx.recipient, ...email, idempotencyKey: row.id }, deps.fetch);

    if (res.ok) {
      await complete(deps, row.id, 'sent', { recipient: ctx.recipient, provider: res.provider, messageId: res.messageId });
      return { id: row.id, status: 'sent' };
    }

    if (tokenId) await deps.db.rpc('revoke_token', { p_token_id: tokenId }).catch(() => undefined);
    const st = await complete(deps, row.id, 'failed', { error: res.error, retry: res.retry, recipient: ctx.recipient, provider: res.provider });
    return { id: row.id, status: st === 'pending' ? 'pending' : 'failed', error: res.error };
  } catch (err) {
    if (tokenId) await deps.db.rpc('revoke_token', { p_token_id: tokenId }).catch(() => undefined);
    const message = (err as Error).message || 'Errore sconosciuto';
    console.error('[notify]', row.id, message);
    try {
      const st = await complete(deps, row.id, 'failed', { error: `Errore interno: ${message}`, retry: true });
      return { id: row.id, status: st === 'pending' ? 'pending' : 'failed', error: message };
    } catch {
      // Lo stato resta "sending": verrà ripreso dopo 15 minuti dal processo schedulato.
      return { id: row.id, status: 'error', error: message };
    }
  }
}

/** Esito sintetico per l'interfaccia (es. schermata di conferma). */
export function emailOutcome(results: NotificationResult[], id: string | null | undefined): 'sent' | 'not_sent' | 'pending' {
  const r = results.find((x) => x.id === id);
  if (!r) return 'pending';
  if (r.status === 'sent') return 'sent';
  if (r.status === 'pending') return 'pending';
  return 'not_sent';
}
