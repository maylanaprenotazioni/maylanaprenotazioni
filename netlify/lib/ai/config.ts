/**
 * Configurazione di Maylana AI (solo server). Le variabili non hanno prefisso
 * VITE_ e quindi non finiscono mai nel bundle del browser.
 *
 *   AI_ENABLED=true          interruttore generale lato server (oltre a quello in dashboard)
 *   OPENAI_API_KEY=sk-...    chiave segreta OpenAI
 *   OPENAI_MODEL=...         modello, modificabile senza toccare il codice
 *   AI_TIMEOUT_MS=8000       timeout di ogni chiamata a OpenAI (facoltativo)
 *   AI_DEADLINE_MS=9000      tempo massimo complessivo di un turno (facoltativo):
 *                            le funzioni sincrone Netlify hanno un limite di esecuzione
 *                            (10 s su molti piani): alzalo solo se il tuo piano lo consente.
 *   OPENAI_REASONING_EFFORT  facoltativo: minimal|low|medium (solo modelli con ragionamento)
 *   OPENAI_INCLUDE_REASONING facoltativo: false per non richiedere il ragionamento cifrato
 *   AI_SESSION_SECRET        facoltativo: segreto per firmare la cronologia (default: derivato da RATE_LIMIT_SALT)
 */
import { createHash } from 'node:crypto';

export interface AiEnv {
  enabled: boolean;
  apiKey: string;
  model: string;
  timeoutMs: number;
  deadlineMs: number;
  reasoningEffort: 'minimal' | 'low' | 'medium' | null;
  includeReasoning: boolean;
  sessionSecret: string;
}

export function readAiEnv(rateLimitSalt = process.env.RATE_LIMIT_SALT || ''): AiEnv {
  const effort = (process.env.OPENAI_REASONING_EFFORT || '').trim().toLowerCase();
  const timeout = Number(process.env.AI_TIMEOUT_MS || 8000);
  const deadline = Number(process.env.AI_DEADLINE_MS || 9000);
  const secret = (process.env.AI_SESSION_SECRET || '').trim();
  return {
    enabled: (process.env.AI_ENABLED || '').trim().toLowerCase() === 'true',
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: (process.env.OPENAI_MODEL || '').trim(),
    timeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 2000), 55000) : 8000,
    deadlineMs: Number.isFinite(deadline) ? Math.min(Math.max(deadline, 3000), 58000) : 9000,
    reasoningEffort: effort === 'minimal' || effort === 'low' || effort === 'medium' ? effort : null,
    includeReasoning: (process.env.OPENAI_INCLUDE_REASONING || 'true').trim().toLowerCase() !== 'false',
    // Mai vuoto: se manca un segreto dedicato se ne deriva uno dal sale del rate limit.
    sessionSecret: secret.length >= 16 ? secret : createHash('sha256').update(`maylana-ai:${rateLimitSalt}`).digest('hex'),
  };
}

/** Problemi di configurazione, in chiaro per la dashboard (mai la chiave). */
export function aiConfigProblems(e: AiEnv): string[] {
  const p: string[] = [];
  if (!e.enabled) p.push('AI_ENABLED non è impostato a true');
  if (!e.apiKey) p.push('OPENAI_API_KEY mancante');
  else if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(e.apiKey)) p.push('OPENAI_API_KEY in formato non riconosciuto');
  if (!e.model) p.push('OPENAI_MODEL mancante');
  else if (!/^[A-Za-z0-9._:-]{2,80}$/.test(e.model)) p.push('OPENAI_MODEL non valido');
  return p;
}

export function aiServerStatus(e: AiEnv = readAiEnv()) {
  const problems = aiConfigProblems(e);
  return { configured: problems.length === 0, model: e.model || null, problems };
}
