import { createContext, useContext } from 'react';
import type { Service, Staff } from '../../lib/types';

export type Role = 'owner' | 'staff';
export type Tab = 'panoramica' | 'agenda' | 'richieste' | 'clienti' | 'storico' | 'orari' | 'servizi' | 'operatori' | 'impostazioni' | 'ai';

export interface AdminCtx {
  role: Role;
  services: Service[];
  staff: Staff[];
  staffServices: { staff_id: string; service_id: string }[];
  reloadRefs: () => Promise<void>;
  userEmail: string;
  /** Naviga a una sezione; per l'agenda si può indicare la data (YYYY-MM-DD). */
  go: (tab: Tab, opts?: { date?: string; customerId?: string }) => void;
  agendaDate: string | null;
  focusCustomerId: string | null;
  toast: (text: string, tone?: 'ok' | 'error' | 'info') => void;
  /**
   * Invia subito le email accodate da un'operazione e mostra l'esito reale.
   * Non dichiara mai "inviata" se il server non lo conferma.
   */
  sendEmails: (ids: unknown) => Promise<void>;
  /** Nome del salone (impostazioni), usato nei messaggi WhatsApp precompilati. */
  businessName: string;
}

export const AdminContext = createContext<AdminCtx | null>(null);

export function useAdmin(): AdminCtx {
  const c = useContext(AdminContext);
  if (!c) throw new Error('AdminContext mancante');
  return c;
}

type Tone = 'ok' | 'gold' | 'danger' | 'muted' | 'neutral';

export const APPT_STATUS: Record<string, { label: string; tone: Tone }> = {
  confirmed: { label: 'Confermato', tone: 'gold' },
  completed: { label: 'Completato', tone: 'ok' },
  no_show: { label: 'Non presentato', tone: 'danger' },
  cancelled: { label: 'Annullato', tone: 'muted' },
};

/** Colori dei blocchi in agenda, per stato (testo sempre leggibile). */
export const APPT_BLOCK: Record<string, string> = {
  confirmed: 'bg-champagne-wash border-champagne-deep text-ink',
  completed: 'bg-ok/10 border-ok text-ink',
  no_show: 'bg-danger/10 border-danger text-ink',
  cancelled: 'bg-line/40 border-taupe/50 text-taupe line-through',
};

export const REQ_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'In attesa', tone: 'gold' },
  confirmed: { label: 'Confermata', tone: 'ok' },
  rejected: { label: 'Rifiutata', tone: 'danger' },
  reschedule: { label: 'Da riprogrammare', tone: 'neutral' },
  cancelled: { label: 'Annullata', tone: 'muted' },
};

export const SOURCE_LABEL: Record<string, string> = {
  online: 'Online',
  admin: 'Inserito dal salone',
  request: 'Da richiesta',
};

export const NOTIF_LABEL: Record<string, string> = {
  booking_confirmed: 'Conferma prenotazione',
  request_received: 'Richiesta ricevuta',
  request_approved: 'Richiesta approvata',
  request_rejected: 'Richiesta rifiutata',
  request_proposal: 'Proposta nuova data',
  appointment_rescheduled: 'Appuntamento spostato',
  appointment_cancelled: 'Appuntamento annullato',
  reminder: 'Promemoria',
  salon_customer_change: 'Avviso al salone',
};

export const NOTIF_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'In coda', tone: 'neutral' },
  sending: { label: 'In invio', tone: 'neutral' },
  sent: { label: 'Inviata', tone: 'ok' },
  failed: { label: 'Non inviata', tone: 'danger' },
  skipped: { label: 'Non inviata', tone: 'muted' },
};


