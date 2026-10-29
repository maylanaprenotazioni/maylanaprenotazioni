/**
 * Variabili d'ambiente lato server (Netlify). Non hanno prefisso VITE_
 * e quindi non finiscono mai nel bundle del browser.
 */
export type EmailProvider = 'resend' | 'brevo';

export interface EmailEnv {
  provider: EmailProvider | null;
  apiKey: string;
  from: string; // "Maylana Coiffeur <prenotazioni@dominio.it>"
  replyTo: string;
}

export interface ServerEnv {
  supabaseUrl: string;
  serviceKey: string;
  rateLimitSalt: string;
  allowedOrigins: string[];
  /** URL pubblico della web app, usato nei link delle email */
  siteUrl: string;
  email: EmailEnv;
}

export class ConfigError extends Error {}

export function emailConfigProblem(e: EmailEnv): string | null {
  if (!e.provider) return 'EMAIL_PROVIDER non impostato (resend oppure brevo)';
  if (!e.apiKey) return 'EMAIL_API_KEY mancante';
  if (!/<[^@\s>]+@[^@\s>]+>$|^[^@\s<]+@[^@\s>]+$/.test(e.from)) return 'EMAIL_FROM mancante o non valido';
  return null;
}

export function getServerEnv(): ServerEnv {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const rateLimitSalt = process.env.RATE_LIMIT_SALT || '';

  if (!supabaseUrl || !serviceKey) {
    throw new ConfigError('SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurate');
  }
  if (rateLimitSalt.length < 16) {
    throw new ConfigError('RATE_LIMIT_SALT mancante o troppo corto (min 16 caratteri)');
  }

  const clean = (o: string | undefined) => (o || '').trim().replace(/\/+$/, '');
  const allowedOrigins = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.PUBLIC_SITE_URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')]
    .map(clean)
    .filter(Boolean);

  const p = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  const provider: EmailProvider | null = p === 'resend' || p === 'brevo' ? p : null;

  return {
    supabaseUrl,
    serviceKey,
    rateLimitSalt,
    allowedOrigins,
    siteUrl: clean(process.env.PUBLIC_SITE_URL) || clean(process.env.URL),
    email: {
      provider,
      apiKey: (process.env.EMAIL_API_KEY || '').trim(),
      from: (process.env.EMAIL_FROM || '').trim(),
      replyTo: (process.env.EMAIL_REPLY_TO || '').trim(),
    },
  };
}
