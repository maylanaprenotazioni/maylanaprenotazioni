/**
 * Webhook WhatsApp Business Platform — PREDISPOSTO, NON ATTIVO.
 * Risponde 404 finché il modulo non è completamente configurato
 * (vedi netlify/lib/whatsapp/cloud-api.ts e README §WhatsApp).
 */
import type { Config } from '@netlify/functions';
import { parseStatuses, readWhatsAppConfig, verifyWebhookSignature, whatsappCloudProblems } from '../lib/whatsapp/cloud-api';

export default async (req: Request) => {
  const cfg = readWhatsAppConfig();
  if (whatsappCloudProblems(cfg).length) return new Response('Not found', { status: 404 });

  if (req.method === 'GET') {
    // Verifica dell'endpoint richiesta da Meta in fase di configurazione
    const url = new URL(req.url);
    if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === cfg.verifyToken) {
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  if (!verifyWebhookSignature(cfg.appSecret, raw, req.headers.get('x-hub-signature-256'))) {
    return new Response('Invalid signature', { status: 401 });
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  // Da completare all'attivazione: registrare gli stati in notifications (channel = 'whatsapp').
  for (const s of parseStatuses(payload)) console.log('[whatsapp] stato', s.messageId, s.status, s.error ?? '');
  return new Response('OK', { status: 200 });
};

export const config: Config = {
  path: '/api/whatsapp/webhook',
};
