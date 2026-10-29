/**
 * WhatsApp tramite link wa.me: si apre la chat con un messaggio precompilato,
 * l'invio lo fa sempre una persona. Nessuna notifica automatica.
 * Nei messaggi non inseriamo mai il tipo di consulenza o dettagli sensibili.
 */
import { formatLongDate, formatTime } from './time';

export { waLink, waNumber } from './wa';

const when = (iso: string) => `${formatLongDate(iso)} alle ${formatTime(iso)}`;

/** Messaggi del cliente verso il salone. */
export const customerMessages = {
  general: () => 'Buongiorno Maylana, vorrei informazioni per un appuntamento.',
  aboutBooking: (code: string, startsAt: string) => `Buongiorno Maylana, scrivo per la prenotazione ${code} di ${when(startsAt)}.`,
};

export type StaffTemplate = 'conferma' | 'promemoria' | 'spostamento' | 'annullamento' | 'proposta' | 'contatto';

export const STAFF_TEMPLATES: { key: StaffTemplate; label: string }[] = [
  { key: 'conferma', label: 'Conferma' },
  { key: 'promemoria', label: 'Promemoria' },
  { key: 'spostamento', label: 'Variazione orario' },
  { key: 'annullamento', label: 'Annullamento' },
  { key: 'proposta', label: 'Proposta nuova data' },
  { key: 'contatto', label: 'Messaggio libero' },
];

/** Messaggi precompilati per il personale: nome, data, ora, riferimento. Nessun dettaglio del servizio. */
export function staffMessage(
  t: StaffTemplate,
  d: { firstName: string; startsAt?: string | null; code?: string | null; businessName: string },
): string {
  const ref = d.code ? ` (rif. ${d.code})` : '';
  const at = d.startsAt ? when(d.startsAt) : '';
  switch (t) {
    case 'conferma':
      return `Buongiorno ${d.firstName}, le confermiamo l'appuntamento da ${d.businessName} per ${at}${ref}. A presto!`;
    case 'promemoria':
      return `Buongiorno ${d.firstName}, le ricordiamo l'appuntamento da ${d.businessName} per ${at}${ref}. Per variazioni ci scriva pure qui.`;
    case 'spostamento':
      return `Buongiorno ${d.firstName}, il suo appuntamento da ${d.businessName} è stato spostato a ${at}${ref}. Ci faccia sapere se va bene.`;
    case 'annullamento':
      return `Buongiorno ${d.firstName}, il suo appuntamento da ${d.businessName}${ref} è stato annullato. Ci scriva se desidera fissarne un altro.`;
    case 'proposta':
      return `Buongiorno ${d.firstName}, per la sua richiesta${ref} possiamo proporle ${at}. Ci conferma se le va bene?`;
    default:
      return `Buongiorno ${d.firstName}, la contattiamo da ${d.businessName}${ref}.`;
  }
}
