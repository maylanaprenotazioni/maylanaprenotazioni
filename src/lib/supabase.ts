import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * URL di apertura, letto PRIMA di creare il client: Supabase elabora (e ripulisce)
 * #access_token / ?code del link email in modo asincrono, quindi la pagina di
 * recupero password lavora su questa copia. Non va mai stampata nei log.
 */
export const initialAuthUrl = typeof window !== 'undefined' ? window.location.href : '';

/** Indirizzo a cui Supabase rimanda dal link "reimposta password" (deve essere tra i Redirect URL autorizzati). */
export const RESET_PASSWORD_URL = 'https://maylana.netlify.app/admin/reset-password';

/** Parametri del link di recupero (query + frammento). */
export function authUrlParams(href = initialAuthUrl): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(href);
    u.searchParams.forEach((v, k) => (out[k] = v));
    new URLSearchParams(u.hash.replace(/^#/, '')).forEach((v, k) => (out[k] = v));
  } catch {
    /* URL non valido: nessun parametro */
  }
  return out;
}

/** Client usato SOLO nell'area /admin (chiave pubblica + login; dati protetti da RLS). */
export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

const ERRORS: Record<string, string> = {
  SLOT_UNAVAILABLE: "L'orario è già occupato per questo operatore.",
  OUTSIDE_WORKING_HOURS: "L'orario è fuori dall'orario di lavoro dell'operatore.",
  TIME_OFF: "L'operatore (o il salone) risulta assente in quell'orario.",
  STAFF_INACTIVE: "L'operatore selezionato non è attivo.",
  REQUEST_NOT_CONFIRMABLE: 'Questa richiesta è già stata gestita.',
  REQUEST_NOT_FOUND: 'Richiesta non trovata.',
  SERVICE_DURATION_MISSING: 'Imposta la durata del servizio prima di confermare.',
  INVALID_PHONE: 'Numero di telefono non valido.',
  INVALID_EMAIL: 'Email non valida.',
  INVALID_NAME: 'Nome non valido.',
  FORBIDDEN: 'Non hai i permessi per questa operazione.',
  INVALID_RANGE: 'Intervallo orario non valido.',
  APPOINTMENT_NOT_ACTIVE: "L'appuntamento non è più attivo (annullato o già concluso).",
  INVALID_STAFF: 'Operatore non valido.',
  INVALID_STATUS: 'Stato non valido per questa operazione.',
  INVALID_DATE: 'Data non valida o fuori dal periodo prenotabile.',
  INVALID_SERVICES: 'Selezione dei servizi non valida.',
  NO_STAFF_FOR_COMBINATION: 'Nessun operatore esegue tutti i servizi selezionati.',
  STAFF_NOT_ENABLED: "L'operatore scelto non è abilitato a tutti i servizi selezionati.",
  SERVICE_NOT_BOOKABLE: 'Servizio non attivo o senza durata.',
  IDEMPOTENCY_CONFLICT: 'Operazione già inviata con dati diversi: ricarica la pagina e riprova.',
  CONSULTATION_SINGLE: 'Le consulenze vanno inserite da sole, senza altri servizi.',
};

/** Errori di rete (browser offline, server non raggiungibile). */
const NETWORK = /failed to fetch|networkerror|load failed|fetch failed|network request failed/i;

/** Traduce gli errori Supabase/Postgres in messaggi comprensibili. */
export function dbMessage(err: unknown): string {
  const e = err as { message?: string; code?: string } | null;
  const msg = e?.message ?? '';
  if (ERRORS[msg]) return ERRORS[msg];
  if (NETWORK.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return 'Connessione assente: la modifica NON è stata salvata. Controlla la rete e riprova.';
  }
  if (/opening_hours_no_overlap/.test(msg)) return 'La fascia di apertura si sovrappone a una esistente.';
  if (/working_hours_no_overlap/.test(msg)) return 'La fascia oraria si sovrappone a una esistente.';
  if (e?.code === '23P01') return ERRORS.SLOT_UNAVAILABLE;
  if (e?.code === '42501') return ERRORS.FORBIDDEN;
  if (e?.code === '23503') return 'Elemento collegato ad altri dati: disattivalo invece di eliminarlo.';
  if (/services_active_requires_duration/.test(msg)) return 'Per attivare un servizio indica la durata.';
  if (e?.code === '23514') return 'Valore non valido: controlla i campi e riprova.';
  return msg || 'Operazione non riuscita.';
}
