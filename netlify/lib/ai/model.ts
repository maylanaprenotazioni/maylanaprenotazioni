/**
 * Accesso al modello tramite l'SDK ufficiale OpenAI (pacchetto "openai") e la
 * Responses API (client.responses.create). Nessun uso di Assistants API.
 *
 * L'interfaccia ModelClient permette ai test di sostituire OpenAI con un modello
 * simulato senza toccare il resto del codice.
 */
import type { AiEnv } from './config';

/** Sottoinsieme dei parametri di responses.create usati da Maylana AI. */
export interface ModelRequest {
  model: string;
  instructions: string;
  input: unknown[];
  tools: unknown[];
  tool_choice: 'auto' | 'none';
  parallel_tool_calls: boolean;
  max_output_tokens: number;
  store: false;
  include?: string[];
  reasoning?: { effort: string };
  safety_identifier?: string;
}

export interface ModelOutputItem {
  type: string;
  [k: string]: unknown;
}

export interface ModelResponse {
  output: ModelOutputItem[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  status?: string;
  incomplete_details?: { reason?: string } | null;
}

export interface ModelClient {
  create(req: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export type UpstreamKind = 'timeout' | 'rate_limited' | 'auth' | 'bad_request' | 'unavailable';

/** Errore del fornitore AI: il messaggio originale NON viene mai inoltrato al browser. */
export class UpstreamError extends Error {
  constructor(public readonly kind: UpstreamKind, public readonly httpStatus: number | null) {
    super(`upstream:${kind}`);
  }
}

export function classifyUpstream(err: unknown): UpstreamError {
  if (err instanceof UpstreamError) return err;
  const e = err as { name?: string; status?: number; code?: string };
  if (e?.name === 'AbortError' || e?.name === 'APIConnectionTimeoutError' || /timeout/i.test(String(e?.name))) {
    return new UpstreamError('timeout', null);
  }
  const st = typeof e?.status === 'number' ? e.status : null;
  if (st === 429) return new UpstreamError('rate_limited', st);
  if (st === 401 || st === 403) return new UpstreamError('auth', st);
  if (st === 400 || st === 404 || st === 422) return new UpstreamError('bad_request', st);
  return new UpstreamError('unavailable', st);
}

/** Client reale: importa l'SDK solo quando serve (la funzione resta leggera se l'AI è spenta). */
export function createOpenAIClient(env: AiEnv): ModelClient {
  let clientPromise: Promise<{ responses: { create: (body: unknown, opts?: unknown) => Promise<unknown> } }> | null = null;
  const getClient = () => {
    clientPromise ??= import('openai').then(
      (m) =>
        new m.default({
          apiKey: env.apiKey,
          timeout: env.timeoutMs,
          maxRetries: 1,
        }) as unknown as { responses: { create: (body: unknown, opts?: unknown) => Promise<unknown> } },
    );
    return clientPromise;
  };
  return {
    async create(req, signal) {
      const client = await getClient();
      try {
        return (await client.responses.create(req, { signal, timeout: env.timeoutMs })) as ModelResponse;
      } catch (err) {
        throw classifyUpstream(err);
      }
    },
  };
}

/** Testo finale della risposta (output_text se presente, altrimenti dai messaggi). */
export function responseText(r: ModelResponse): string {
  if (typeof r.output_text === 'string' && r.output_text.trim()) return r.output_text;
  const parts: string[] = [];
  for (const item of r.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content as { type?: string; text?: string }[]) {
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}
