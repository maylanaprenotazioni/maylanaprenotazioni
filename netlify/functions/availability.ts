import type { Config, Context } from '@netlify/functions';
import { endpoint } from '../lib/http';
import { availabilityHandler } from '../lib/handlers';

const run = endpoint(['GET'], availabilityHandler);

export default (req: Request, context: Context) => run(req, { ip: context.ip });

export const config: Config = {
  path: '/api/availability',
};
