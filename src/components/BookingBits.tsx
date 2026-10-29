import type { ReactNode } from 'react';
import type { EmailOutcome } from '../lib/api';
import { formatDuration, formatPrice } from '../lib/time';
import { waLink } from '../lib/whatsapp';

export function StepTitle({ n, children }: { n?: number; children: ReactNode }) {
  return (
    <h2 className="mb-4 flex items-baseline gap-3 font-display text-[26px] leading-tight">
      {n !== undefined && <span className="text-base text-champagne-deep tabular-nums">{n}.</span>}
      {children}
    </h2>
  );
}

/** Indicatore dei 5 passaggi (sequenza reale della procedura). */
export function Steps({ current, total = 5 }: { current: number; total?: number }) {
  return (
    <div className="mb-6 flex items-center gap-3" aria-label={`Passaggio ${current} di ${total}`}>
      <div className="flex flex-1 gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`h-1 flex-1 rounded-full ${i < current ? 'bg-ink' : 'bg-line'}`} />
        ))}
      </div>
      <span className="text-xs tabular-nums text-taupe">
        {current} di {total}
      </span>
    </div>
  );
}

/** Riepilogo delle scelte fatte, ciascuna modificabile. */
export function Choice({ label, value, onEdit }: { label: string; value: string; onEdit?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-3">
      <div className="min-w-0">
        <p className="text-xs text-taupe">{label}</p>
        <p className="text-[15px]">{value}</p>
      </div>
      {onEdit && (
        <button onClick={onEdit} className="shrink-0 rounded-full px-3 py-1.5 text-sm text-champagne-deep hover:bg-champagne-wash">
          Modifica
        </button>
      )}
    </div>
  );
}

export function durationText(duration: number, buffer: number): string {
  return buffer > 0 ? `${formatDuration(duration)} (+${buffer} min di preparazione)` : formatDuration(duration);
}

export function priceText(cents: number | null, estimate: boolean): string {
  return cents === null ? 'Prezzo in salone' : estimate ? `${formatPrice(cents, true)} (indicativo)` : formatPrice(cents);
}

export function EmailNote({
  email,
  sentText,
  savedText = 'la prenotazione è comunque registrata',
}: {
  email: EmailOutcome;
  sentText: string;
  savedText?: string;
}) {
  if (email === 'sent') return <p className="mx-auto mt-6 max-w-sm text-sm text-ok">{sentText}</p>;
  return (
    <p className="mx-auto mt-6 max-w-sm text-sm text-ink-soft">
      {email === 'pending'
        ? `L'email di conferma non è ancora partita: riproveremo a breve. Intanto conserva il codice: ${savedText}.`
        : `Non siamo riusciti a inviarti l'email di conferma: conserva il codice, ${savedText}.`}
    </p>
  );
}

/** Pulsante per scrivere al salone su WhatsApp (link wa.me, invio manuale). */
export function WhatsAppButton({ number, text, label = 'Scrivici su WhatsApp', className = '' }: { number: string | null; text: string; label?: string; className?: string }) {
  if (!number) return null;
  return (
    <a
      href={waLink(number, text)}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#1f7a4d]/40 bg-paper px-5 text-[15px] text-[#1f6b45] hover:bg-[#1f7a4d]/5 ${className}`}
    >
      <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="currentColor">
        <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3a.5.5 0 0 0 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.5-.3Z" />
      </svg>
      {label}
    </a>
  );
}
