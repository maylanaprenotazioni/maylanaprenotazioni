/**
 * WhatsApp Business Platform (Cloud API) — MODULO PREDISPOSTO, NON ATTIVO.
 *
 * Oggi la web app usa solo link wa.me: si apre WhatsApp con un messaggio
 * precompilato e l'invio lo fa una persona. Nessuna notifica automatica.
 *
 * Questo modulo serve per una futura integrazione UFFICIALE. Si attiva solo se:
 *  1. WHATSAPP_CLOUD_ENABLED=true
 *  2. credenziali del numero aziendale (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN)
 *  3. firma dei webhook (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN)
 *  4. template APPROVATI da Meta, mappati in WHATSAPP_TEMPLATES (JSON)
 *  5. consenso del cliente a ricevere messaggi WhatsApp (da raccogliere e registrare:
 *     NON è ancora presente nella web app) — sendTemplate lo richiede esplicitamente
 *  6. gestione degli stati di consegna tramite webhook (vedi whatsapp-webhook.ts)
 * Non usare mai automazioni non ufficiali o sessioni WhatsApp Web.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WhatsAppTemplateRef {
  name: string;
  language: string; // es. "it"
}

export interface WhatsAppCloudConfig {
  enabled: boolean;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
  templates: Record<string, WhatsAppTemplateRef>;
}

export function readWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppCloudConfig {
  let templates: Record<string, WhatsAppTemplateRef> = {};
  try {
    templates = env.WHATSAPP_TEMPLATES ? JSON.parse(env.WHATSAPP_TEMPLATES) : {};
  } catch {
    templates = {};
  }
  return {
    enabled: (env.WHATSAPP_CLOUD_ENABLED || '').toLowerCase() === 'true',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    templates,
  };
}

export function whatsappCloudProblems(cfg: WhatsAppCloudConfig): string[] {
  const p: string[] = [];
  if (!cfg.enabled) p.push('WHATSAPP_CLOUD_ENABLED non è "true"');
  if (!cfg.phoneNumberId) p.push('WHATSAPP_PHONE_NUMBER_ID mancante');
  if (!cfg.accessToken) p.push('WHATSAPP_ACCESS_TOKEN mancante');
  if (!cfg.appSecret) p.push('WHATSAPP_APP_SECRET mancante (firma webhook)');
  if (!cfg.verifyToken) p.push('WHATSAPP_VERIFY_TOKEN mancante (verifica webhook)');
  if (!Object.keys(cfg.templates).length) p.push('Nessun template approvato configurato (WHATSAPP_TEMPLATES)');
  return p;
}

/** Stato per la dashboard: mai "attivo" se manca anche un solo requisito. */
export function whatsappCloudStatus(cfg = readWhatsAppConfig()) {
  const problems = whatsappCloudProblems(cfg);
  return { active: problems.length === 0, problems };
}

export class WhatsAppNotEnabledError extends Error {}

/**
 * Invio di un template approvato. Rifiuta l'invio se il modulo non è
 * completamente configurato o se il consenso del destinatario non è attestato.
 * NON è chiamato da nessuna parte della web app attuale.
 */
export async function sendTemplate(
  cfg: WhatsAppCloudConfig,
  args: { to: string; kind: string; params: string[]; consentAt: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageId: string }> {
  const problems = whatsappCloudProblems(cfg);
  if (problems.length) throw new WhatsAppNotEnabledError(`WhatsApp Business non attivo: ${problems.join('; ')}`);
  if (!args.consentAt) throw new WhatsAppNotEnabledError('Consenso WhatsApp del cliente non registrato');
  const tpl = cfg.templates[args.kind];
  if (!tpl) throw new WhatsAppNotEnabledError(`Nessun template approvato per "${args.kind}"`);
  const to = args.to.replace(/[^\d]/g, '');
  const res = await fetchImpl(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: tpl.name,
        language: { code: tpl.language },
        components: [{ type: 'body', parameters: args.params.map((text) => ({ type: 'text', text })) }],
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!res.ok || !body.messages?.[0]?.id) throw new Error(`WhatsApp HTTP ${res.status}: ${body.error?.message ?? 'errore'}`);
  return { messageId: body.messages[0].id };
}

/** Verifica della firma X-Hub-Signature-256 dei webhook Meta. */
export function verifyWebhookSignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

/** Estrae gli stati di consegna (sent/delivered/read/failed) dal payload del webhook. */
export function parseStatuses(payload: unknown): { messageId: string; status: string; timestamp: string; error?: string }[] {
  const out: { messageId: string; status: string; timestamp: string; error?: string }[] = [];
  const entries = (payload as { entry?: { changes?: { value?: { statuses?: unknown[] } }[] }[] })?.entry ?? [];
  for (const e of entries)
    for (const c of e.changes ?? [])
      for (const st of (c.value?.statuses ?? []) as { id: string; status: string; timestamp: string; errors?: { title?: string }[] }[])
        out.push({ messageId: st.id, status: st.status, timestamp: st.timestamp, error: st.errors?.[0]?.title });
  return out;
}
