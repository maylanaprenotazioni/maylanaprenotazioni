import type { Config, Context } from '@netlify/functions';
import { endpoint } from '../lib/http';
import { adminStatusHandler } from '../lib/handlers';

const run = endpoint(['GET'], adminStatusHandler);

export default (req: Request, context: Context) => run(req, { ip: context.ip });

export const config: Config = {
  path: '/api/admin/status',
};
