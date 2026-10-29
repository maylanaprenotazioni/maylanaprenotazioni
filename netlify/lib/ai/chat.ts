/**
 * GET  /api/ai/chat  → disponibilità dell'assistente e messaggio iniziale
 * POST /api/ai/chat  → un turno di conversazione
 *
 * Ordine dei controlli di un turno:
 *  origine → rate limit persistente (IP) → configurazione server → validazione
 *  rigida del corpo → impostazioni dal database → scelta della risposta
 *  (azione/FAQ/locale/modello) → limiti atomici di sessione e giornalieri →
 *  esecuzione → protezione dell'output → registrazione dei consumi.
 *
 * Il testo delle conversazioni non viene salvato né scritto nei log.
 */
import { z } from 'zod';
import { ApiError, assertAllowedOrigin, enforceRateLimit, json, mapDbError, readJson, type Deps } from '../http';
import { parse } from '../validation';
import { loadCatalog, type CatalogData } from '../handlers';
import { romeToday } from '../../../src/lib/time';
import type { AiAction, AiCard, AiChatResponse, AiHistoryItem } from '../../../src/lib/ai-types';
import { aiConfigProblems, readAiEnv, type AiEnv } from './config';
import { createOpenAIClient, classifyUpstream, responseText, UpstreamError, type ModelClient, type ModelOutputItem, type ModelRequest } from './model';
import { asksAboutExistingBooking, cleanUserText, guardModelOutput, looksLikeInjection, redactForModel } from './guard';
import { faqContext, localFaqAnswer, type Faq } from './faq';
import { buildSalonContext, SYSTEM_INSTRUCTIONS, type SalonInfo } from './prompt';
import { hashSessionToken, newSessionToken, signMessage, verifyMessage } from './session';
import { prepareBookingFor, prepareRequestFor, runTool, serviceCard, GROUP_VALUES, TOOL_DEFINITIONS, type ToolContext } from './tools';

const MAX_TOOL_ROUNDS = 3;
const MAX_CALLS_PER_ROUND = 3;
const MAX_HISTORY = 8;
const MAX_HISTORY_CHARS = 3000;

interface PublicContext {
  ai: { enabled: boolean; welcome_message: string; max_input_chars: number; max_output_tokens: number; session_message_limit: number } | null;
  salon: (SalonInfo & { privacy_url: string | null; online_booking_enabled: boolean }) | null;
  opening_hours: { weekday: number; start: string; end: string }[];
  working_weekdays: number[];
  faq: Faq[];
}

const UNAVAILABLE = 'Maylana AI non è disponibile in questo momento. Puoi prenotare normalmente con il modulo della pagina oppure contattare il salone.';

async function publicContext(deps: Deps): Promise<PublicContext> {
  try {
    const raw = await deps.db.rpc<PublicContext | PublicContext[]>('ai_public_context', {});
    const ctx = Array.isArray(raw) ? raw[0] : raw;
    if (!ctx?.ai || !ctx.salon) throw new ApiError(503, 'AI_UNAVAILABLE', UNAVAILABLE);
    return ctx;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(503, 'AI_UNAVAILABLE', UNAVAILABLE);
  }
}

function aiEnvOf(deps: Deps): AiEnv {
  return deps.ai?.env ?? readAiEnv(deps.env.rateLimitSalt);
}

// ---------------------------------------------------------------------
// GET: stato pubblico
// ---------------------------------------------------------------------
export async function aiStatusHandler(_req: Request, deps: Deps): Promise<Response> {
  await enforceRateLimit(deps, 'ai-status', deps.ip, 60, 60);
  const env = aiEnvOf(deps);
  if (aiConfigProblems(env).length) return json(200, { available: false, welcome: null, maxInputChars: 0 });
  const ctx = await publicContext(deps).catch(() => null);
  const available = !!ctx?.ai?.enabled;
  return json(200, {
    available,
    welcome: available ? ctx!.ai!.welcome_message : null,
    maxInputChars: available ? ctx!.ai!.max_input_chars : 0,
  });
}

// ---------------------------------------------------------------------
// Corpo della richiesta: schema RIGIDO. Campi non previsti (es. "instructions",
// "tools", "model", "system") fanno fallire la validazione.
// ---------------------------------------------------------------------
const uuid = z.string().uuid();
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prices') }).strict(),
  z.object({ type: z.literal('contact') }).strict(),
  z.object({ type: z.literal('services'), group: z.enum(GROUP_VALUES).nullable() }).strict(),
  z.object({ type: z.literal('availability'), serviceIds: z.array(uuid).min(1).max(5), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), staffId: uuid.nullable() }).strict(),
  z.object({ type: z.literal('select_slot'), serviceIds: z.array(uuid).min(1).max(5), startsAt: z.string().datetime({ offset: true }), staffId: uuid.nullable() }).strict(),
  z.object({ type: z.literal('consultation'), serviceId: uuid.nullable() }).strict(),
]);

export const chatBody = z
  .object({
    sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().optional(),
    message: z.string().max(2000).optional(),
    action: actionSchema.optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1500), sig: z.string().max(64) }).strict())
      .max(20)
      .optional(),
    lang: z.enum(['it', 'en']).optional(),
  })
  .strict()
  .refine((b) => (b.message !== undefined) !== (b.action !== undefined), 'Invia un messaggio oppure un\'azione.');

type Outcome = { text: string; cards: AiCard[]; quickReplies: string[]; source: AiChatResponse['source'] };

// ---------------------------------------------------------------------
// Risposte locali (nessuna chiamata a OpenAI)
// ---------------------------------------------------------------------
function contactText(ctx: PublicContext): string {
  const s = ctx.salon!;
  const parts = [s.contact_phone && `telefono ${s.contact_phone}`, s.contact_email && `email ${s.contact_email}`, s.whatsapp_number && 'WhatsApp'].filter(Boolean);
  return parts.length
    ? `Puoi contattare Maylana direttamente: ${parts.join(', ')}. Trovi i pulsanti qui sotto.`
    : 'I recapiti del salone non sono ancora stati pubblicati. Puoi prenotare con il modulo della pagina.';
}

async function runAction(action: AiAction, tctx: ToolContext, ctx: PublicContext): Promise<Outcome> {
  switch (action.type) {
    case 'contact':
      return { text: contactText(ctx), cards: [{ type: 'contact' }], quickReplies: [], source: 'local' };
    case 'prices':
    case 'services': {
      const group = action.type === 'services' ? action.group : null;
      const list = tctx.catalog.services.filter((s) => !group || s.public_group === group);
      if (!list.length) return { text: 'Al momento non ci sono servizi pubblicati in questa categoria. Contatta il salone per informazioni.', cards: [{ type: 'contact' }], quickReplies: [], source: 'local' };
      const priced = list.filter((s) => s.price_cents !== null).length;
      return {
        text:
          action.type === 'prices'
            ? `Ecco i servizi con i prezzi indicati dal salone${priced < list.length ? '. Dove manca il prezzo, viene definito in salone' : ''}. Dimmi pure quale ti interessa.`
            : 'Ecco i servizi disponibili. Quale ti interessa?',
        cards: [{ type: 'services', services: list.slice(0, 20).map((s) => serviceCard(tctx, s)) }],
        quickReplies: ['Taglio e piega', 'Consulenza Capelli For You'],
        source: 'local',
      };
    }
    case 'availability': {
      const r = await runTool(tctx, 'get_availability', JSON.stringify({ service_ids: action.serviceIds, date: action.date, staff_id: action.staffId, part_of_day: 'qualsiasi' }));
      if (r.ok === false) return { text: String(r.message ?? 'Nessun orario disponibile.'), cards: [], quickReplies: [], source: 'local' };
      return {
        text: (r.available_count as number) > 0 ? 'Ecco gli orari liberi in quella giornata. Tocca quello che preferisci.' : 'In quella giornata non ci sono orari liberi per questi servizi. Prova un altro giorno.',
        cards: tctx.cards,
        quickReplies: [],
        source: 'local',
      };
    }
    case 'select_slot': {
      const r = await prepareBookingFor(tctx, action.serviceIds, action.startsAt, action.staffId);
      if (r.ok === false) return { text: String(r.message), cards: [], quickReplies: [], source: 'local' };
      return {
        text: 'Ecco il riepilogo. Per completare inserisci i tuoi dati nel modulo e premi "Conferma prenotazione": l\'appuntamento sarà registrato solo dopo la conferma.',
        cards: tctx.cards,
        quickReplies: [],
        source: 'local',
      };
    }
    case 'consultation': {
      const cons = tctx.catalog.services.filter((s) => s.category === 'consultation');
      if (!action.serviceId) {
        if (!cons.length) return { text: 'Le consulenze Capelli For You non sono ancora prenotabili online. Contatta il salone per fissarne una.', cards: [{ type: 'contact' }], quickReplies: [], source: 'local' };
        return {
          text: 'Ecco le consulenze Capelli For You. Scegli quella che ti interessa: invierai una richiesta che Maylana dovrà approvare.',
          cards: [{ type: 'services', services: cons.map((s) => serviceCard(tctx, s)) }],
          quickReplies: [],
          source: 'local',
        };
      }
      const r = await prepareRequestFor(tctx, [action.serviceId], null, 'indifferente');
      if (r.ok === false) return { text: String(r.message), cards: [], quickReplies: [], source: 'local' };
      return {
        text: 'Scegli una data preferita e inserisci i recapiti. La richiesta resterà in attesa finché Maylana non la approva.',
        cards: tctx.cards,
        quickReplies: [],
        source: 'local',
      };
    }
  }
}

function existingBookingAnswer(): Outcome {
  return {
    text: 'Per motivi di riservatezza non posso vedere né modificare gli appuntamenti dalla chat. Usa il link "Gestisci appuntamento" che hai ricevuto via email: da lì puoi vedere, spostare o annullare il tuo appuntamento. In alternativa contatta il salone.',
    cards: [{ type: 'contact' }],
    quickReplies: [],
    source: 'local',
  };
}

function injectionAnswer(): Outcome {
  return {
    text: 'Posso aiutarti solo con i servizi e le prenotazioni di Maylana Coiffeur. Vuoi vedere i servizi o cercare un appuntamento?',
    cards: [],
    quickReplies: ['Prezzi dei servizi', 'Prenota un taglio'],
    source: 'local',
  };
}

// ---------------------------------------------------------------------
// Modello
// ---------------------------------------------------------------------
async function runModel(
  model: ModelClient,
  env: AiEnv,
  ctx: PublicContext,
  tctx: ToolContext,
  history: AiHistoryItem[],
  userText: string,
  safetyId: string,
): Promise<{ text: string; inTok: number; outTok: number; calls: number; tools: string[] }> {
  const input: unknown[] = [
    { role: 'developer', content: buildSalonContext({ today: tctx.today, salon: ctx.salon!, openingHours: ctx.opening_hours, faqs: faqContext(userText, ctx.faq, 'it') }) },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: userText },
  ];
  const started = Date.now();
  let inTok = 0;
  let outTok = 0;
  let calls = 0;
  const tools: string[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const remaining = env.deadlineMs - (Date.now() - started);
    if (remaining < 1500) throw new UpstreamError('timeout', null);
    const req: ModelRequest = {
      model: env.model,
      instructions: SYSTEM_INSTRUCTIONS,
      input,
      tools: TOOL_DEFINITIONS as unknown as unknown[],
      tool_choice: round === MAX_TOOL_ROUNDS ? 'none' : 'auto',
      parallel_tool_calls: false,
      max_output_tokens: ctx.ai!.max_output_tokens,
      store: false,
      safety_identifier: safetyId,
      ...(env.includeReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
      ...(env.reasoningEffort ? { reasoning: { effort: env.reasoningEffort } } : {}),
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(env.timeoutMs, remaining));
    let res;
    try {
      calls++;
      res = await model.create(req, ac.signal);
    } catch (err) {
      throw classifyUpstream(err);
    } finally {
      clearTimeout(timer);
    }
    inTok += res.usage?.input_tokens ?? 0;
    outTok += res.usage?.output_tokens ?? 0;

    const fnCalls = (res.output ?? []).filter((o): o is ModelOutputItem & { name: string; arguments: string; call_id: string } => o.type === 'function_call');
    if (!fnCalls.length) {
      return { text: responseText(res), inTok, outTok, calls, tools };
    }
    // Si rimandano al modello i suoi output (ragionamento cifrato + chiamate), poi i risultati.
    for (const item of res.output) if (item.type === 'reasoning' || item.type === 'function_call') input.push(item);
    for (const [i, fc] of fnCalls.entries()) {
      const result =
        i < MAX_CALLS_PER_ROUND
          ? await runTool(tctx, String(fc.name), String(fc.arguments ?? ''))
          : { ok: false, error: 'TOO_MANY_CALLS', message: 'Una richiesta alla volta.' };
      tools.push(String(fc.name).slice(0, 40));
      input.push({ type: 'function_call_output', call_id: String(fc.call_id), output: JSON.stringify(result).slice(0, 6000) });
    }
  }
  return { text: '', inTok, outTok, calls, tools };
}

// ---------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------
export async function aiChatHandler(req: Request, deps: Deps): Promise<Response> {
  assertAllowedOrigin(req, deps.env);
  await enforceRateLimit(deps, 'ai-ip', deps.ip, 20, 600);
  await enforceRateLimit(deps, 'ai-ip-day', deps.ip, 150, 86400);

  const env = aiEnvOf(deps);
  if (aiConfigProblems(env).length) throw new ApiError(503, 'AI_UNAVAILABLE', UNAVAILABLE);

  const body = parse(chatBody, await readJson(req));
  const ctx = await publicContext(deps);
  if (!ctx.ai!.enabled) throw new ApiError(503, 'AI_DISABLED', UNAVAILABLE);

  // Testo del cliente: pulizia, limiti, minimizzazione dei dati verso il fornitore AI.
  let userText: string | null = null;
  let redacted = false;
  if (body.message !== undefined) {
    const cleaned = cleanUserText(body.message, ctx.ai!.max_input_chars);
    if (!cleaned) throw new ApiError(400, 'VALIDATION_ERROR', 'Scrivi un messaggio.');
    const r = redactForModel(cleaned);
    userText = r.text;
    redacted = r.redacted;
  }

  // Scelta della modalità di risposta PRIMA di consumare il budget del modello.
  type Mode = 'action' | 'existing' | 'injection' | 'faq' | 'model';
  let mode: Mode = 'model';
  let faq: Faq | null = null;
  if (body.action) mode = 'action';
  else if (asksAboutExistingBooking(userText!)) mode = 'existing';
  else if (looksLikeInjection(userText!)) mode = 'injection';
  else if ((faq = localFaqAnswer(userText!, ctx.faq, body.lang ?? 'it'))) mode = 'faq';

  // Sessione e limiti (atomici nel database)
  const givenToken = body.sessionToken ?? null;
  const freshToken = newSessionToken();
  let turn: { ok: boolean; reason: string | null; session_id: string | null; session_created: boolean; turns_left: number };
  try {
    const rows = await deps.db.rpc<(typeof turn)[]>('ai_begin_turn', {
      p_token_hash: givenToken ? hashSessionToken(givenToken) : null,
      p_new_token_hash: hashSessionToken(freshToken),
      p_uses_model: mode === 'model',
    });
    turn = Array.isArray(rows) ? rows[0] : (rows as unknown as typeof turn);
  } catch (err) {
    throw mapDbError(err);
  }
  if (!turn) throw new ApiError(503, 'AI_UNAVAILABLE', UNAVAILABLE);
  if (!turn.ok && turn.reason === 'DISABLED') throw new ApiError(503, 'AI_DISABLED', UNAVAILABLE);
  const sessionToken = turn.session_created ? freshToken : givenToken!;
  const sessionId = turn.session_id!;

  const sign = (role: 'user' | 'assistant', text: string): AiHistoryItem => ({ role, text, sig: signMessage(env.sessionSecret, sessionId, role, text) });
  const respond = (o: Outcome, status = 200) => {
    const reply = sign('assistant', o.text);
    const out: AiChatResponse = {
      sessionToken,
      user: userText !== null ? sign('user', userText) : null,
      reply,
      cards: o.cards.slice(0, 4),
      quickReplies: o.quickReplies.slice(0, 4),
      source: o.source,
      turnsLeft: Math.max(0, turn.turns_left),
    };
    return json(status, out);
  };

  if (!turn.ok) {
    const text =
      turn.reason === 'SESSION_LIMIT'
        ? 'Abbiamo raggiunto il numero massimo di messaggi per questa conversazione. Puoi continuare con il modulo di prenotazione o contattare il salone.'
        : 'In questo momento l\'assistente ha raggiunto il limite di utilizzo. Puoi prenotare normalmente con il modulo della pagina oppure contattare il salone.';
    log({ s: sessionId, mode, blocked: turn.reason });
    return respond({ text, cards: [{ type: 'contact' }], quickReplies: [], source: 'local' });
  }

  // Cronologia: solo messaggi firmati da questo server per questa sessione.
  const history: AiHistoryItem[] = [];
  if (!turn.session_created) {
    let chars = 0;
    for (const h of (body.history ?? []).slice(-MAX_HISTORY).reverse()) {
      if (!verifyMessage(env.sessionSecret, sessionId, h.role, h.text, h.sig)) continue;
      if (chars + h.text.length > MAX_HISTORY_CHARS) break;
      chars += h.text.length;
      history.unshift(h);
    }
  }

  let catalog: CatalogData;
  try {
    catalog = await loadCatalog(deps);
  } catch {
    throw new ApiError(503, 'AI_UNAVAILABLE', UNAVAILABLE);
  }
  const tctx: ToolContext = {
    deps,
    catalog,
    today: romeToday(),
    workingWeekdays: ctx.working_weekdays ?? [],
    openingWeekdays: [...new Set((ctx.opening_hours ?? []).map((h) => h.weekday))],
    cards: [],
  };

  const t0 = Date.now();
  try {
    let outcome: Outcome;
    if (mode === 'action') outcome = await runAction(body.action as AiAction, tctx, ctx);
    else if (mode === 'existing') outcome = existingBookingAnswer();
    else if (mode === 'injection') outcome = injectionAnswer();
    else if (mode === 'faq') outcome = { text: faq!.answer, cards: [], quickReplies: [], source: 'faq' };
    else {
      const model = deps.ai?.model ?? createOpenAIClient(env);
      const r = await runModel(model, env, ctx, tctx, history, userText!, sessionId.slice(0, 16));
      await recordUsage(deps, sessionId, r.inTok, r.outTok, r.calls, false);
      const g = guardModelOutput(r.text);
      const text = g.text || (tctx.cards.length ? 'Ecco cosa ho trovato.' : 'Non sono riuscita a rispondere. Puoi riformulare oppure contattare il salone.');
      log({ s: sessionId, mode, tools: r.tools, in: r.inTok, out: r.outTok, calls: r.calls, ms: Date.now() - t0, guarded: g.removedClaims, redacted });
      return respond({ text, cards: dedupeCards(tctx.cards), quickReplies: [], source: 'model' });
    }
    log({ s: sessionId, mode, ms: Date.now() - t0, redacted });
    return respond({ ...outcome, cards: dedupeCards(outcome.cards) });
  } catch (err) {
    if (err instanceof UpstreamError) {
      await recordUsage(deps, sessionId, 0, 0, 1, true);
      log({ s: sessionId, mode, upstream: err.kind, status: err.httpStatus, ms: Date.now() - t0 });
      throw new ApiError(503, 'AI_UNAVAILABLE', UNAVAILABLE);
    }
    await recordUsage(deps, sessionId, 0, 0, 0, true);
    log({ s: sessionId, mode, error: err instanceof ApiError ? err.code : 'internal', ms: Date.now() - t0 });
    if (err instanceof ApiError && err.status < 500) throw err;
    throw new ApiError(503, 'AI_UNAVAILABLE', UNAVAILABLE);
  }
}

/** Una sola card per tipo: vale l'ultima prodotta (es. orari aggiornati dopo un secondo tentativo). */
function dedupeCards(cards: AiCard[]): AiCard[] {
  const last = new Map<string, AiCard>();
  for (const c of cards) last.set(c.type, c);
  const order: AiCard['type'][] = ['services', 'slots', 'booking', 'request', 'open_form', 'contact'];
  return order.map((t) => last.get(t)).filter((c): c is AiCard => !!c);
}

async function recordUsage(deps: Deps, sessionId: string, inTok: number, outTok: number, calls: number, error: boolean) {
  try {
    await deps.db.rpc('ai_record_usage', { p_session_id: sessionId, p_input_tokens: inTok, p_output_tokens: outTok, p_model_calls: calls, p_error: error });
  } catch {
    console.error('[ai] registrazione consumi non riuscita');
  }
}

/** Log tecnico: nessun testo dei messaggi, nessun dato personale, sessione abbreviata. */
function log(o: Record<string, unknown>) {
  console.log('[ai]', JSON.stringify({ ...o, s: String(o.s ?? '').slice(0, 8) }));
}

