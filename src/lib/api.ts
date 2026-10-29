import type { BookedAppointment, BundleSummary, Catalog, ManagedAppointment, TimeOption } from './types';
import type { AiAction, AiChatResponse, AiHistoryItem, AiPublicStatus } from './ai-types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Esito dell'email di conferma, riferito così come registrato dal server. */
export type EmailOutcome = 'sent' | 'not_sent' | 'pending';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError(0, 'OFFLINE', 'Sei offline: per prenotare o modificare un appuntamento serve la connessione a Internet.');
  }
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Connessione non riuscita: per effettuare o modificare prenotazioni è necessaria la connessione Internet. Controlla la rete e riprova.');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* risposta non JSON */
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? 'Servizio non raggiungibile. Riprova tra poco.');
  }
  if (body === null) throw new ApiError(res.status, 'INVALID_RESPONSE', 'Risposta non valida dal server.');
  return body as T;
}

const post = <T>(path: string, payload: unknown, headers?: Record<string, string>) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(payload), headers });

export const api = {
  catalog: () => request<Catalog>('/api/catalog'),
  availability: (serviceIds: string[], date: string, staffId: string | null) => {
    const q = new URLSearchParams({ serviceIds: serviceIds.join(','), date });
    if (staffId) q.set('staffId', staffId);
    return request<{ date: string; bundle: BundleSummary; times: TimeOption[] }>(`/api/availability?${q}`);
  },
  book: async (payload: Record<string, unknown>) => {
    const r = await post<{ appointment?: BookedAppointment; email?: EmailOutcome }>('/api/book', payload);
    // Conferma mostrata solo se il server restituisce un appuntamento salvato con codice.
    if (!r.appointment?.code) throw new ApiError(500, 'INVALID_RESPONSE', 'La prenotazione non risulta registrata. Riprova.');
    return { appointment: r.appointment, email: r.email ?? 'pending' };
  },
  request: async (payload: Record<string, unknown>) => {
    const r = await post<{ request?: { code: string; status: string; service_name: string }; email?: EmailOutcome }>('/api/request', payload);
    if (!r.request?.code) throw new ApiError(500, 'INVALID_RESPONSE', 'La richiesta non risulta registrata. Riprova.');
    return { ...r.request, email: r.email ?? 'pending' };
  },

  // Maylana AI (solo tramite backend: nessuna chiave nel browser)
  aiStatus: () => request<AiPublicStatus>('/api/ai/chat'),
  aiChat: (body: { sessionToken: string | null; message?: string; action?: AiAction; history: AiHistoryItem[]; lang?: 'it' | 'en' }) =>
    post<AiChatResponse>('/api/ai/chat', body),

  // Link personale del cliente (token solo nel corpo della richiesta)
  manageView: (token: string) => post<{ appointment: ManagedAppointment }>('/api/manage/view', { token }),
  manageAvailability: (token: string, date: string) => post<{ date: string; times: TimeOption[] }>('/api/manage/availability', { token, date }),
  manageCancel: (token: string) => post<{ cancelled: true; email: EmailOutcome }>('/api/manage/cancel', { token }),
  manageReschedule: (token: string, startsAt: string) => post<{ starts_at: string; email: EmailOutcome }>('/api/manage/reschedule', { token, startsAt }),
  manageRequest: (token: string, preferredDate: string | null, preferredTimeWindow: string, notes: string | null) =>
    post<{ request_code: string; email: EmailOutcome }>('/api/manage/request', { token, preferredDate, preferredTimeWindow, notes }),

  // Area admin: JWT Supabase verificato dal server
  adminStatus: (jwt: string) =>
    request<{
      email: { configured: boolean; problem: string | null; provider: string | null; from: string | null };
      site_url: string | null;
      whatsapp_cloud: { active: boolean; problems: string[] };
      ai: { configured: boolean; model: string | null; problems: string[] };
    }>('/api/admin/status', {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
  adminDispatch: (jwt: string, ids: string[]) =>
    post<{ results: { id: string; status: string; error?: string }[]; email_configured: boolean }>('/api/admin/dispatch', { ids }, { Authorization: `Bearer ${jwt}` }),
};
