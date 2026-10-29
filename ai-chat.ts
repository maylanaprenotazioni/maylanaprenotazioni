import type { Config, Context } from '@netlify/functions';
import { endpoint } from '../lib/http';
import { aiChatHandler, aiStatusHandler } from '../lib/ai/chat';

// GET: disponibilità e messaggio iniziale · POST: un turno di conversazione
const run = endpoint(['GET', 'POST'], (req, deps) => (req.method === 'GET' ? aiStatusHandler(req, deps) : aiChatHandler(req, deps)));

export default (req: Request, context: Context) => run(req, { ip: context.ip });

export const config: Config = {
  path: '/api/ai/chat',
};
