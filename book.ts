import type { Config, Context } from '@netlify/functions';
import { endpoint } from '../lib/http';
import { bookHandler } from '../lib/handlers';

const run = endpoint(['POST'], bookHandler);

export default (req: Request, context: Context) => run(req, { ip: context.ip });

export const config: Config = {
  path: '/api/book',
};
