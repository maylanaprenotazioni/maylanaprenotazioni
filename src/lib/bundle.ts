import type { PublicGroup, Service } from './types';

export const GROUPS: { key: PublicGroup; label: string; hint: string }[] = [
  { key: 'uomo', label: 'Uomo', hint: 'Tagli e servizi uomo' },
  { key: 'donna', label: 'Donna', hint: 'Taglio, piega, colore' },
  { key: 'trattamenti', label: 'Trattamenti', hint: 'Cura del capello' },
  { key: 'acconciature', label: 'Acconciature', hint: 'Raccolti ed eventi' },
  { key: 'consulenze', label: 'Consulenze Capelli For You', hint: 'Su appuntamento riservato' },
];

export interface BundleCalc {
  duration: number;
  buffer: number;
  total: number;
  priceCents: number | null;
  priceEstimate: boolean;
  needsApproval: boolean;
  isConsultation: boolean;
  label: string;
}

/**
 * Calcolo indicativo lato client (anteprima immediata). Il server ricalcola
 * sempre durata, prezzo e disponibilità al momento della prenotazione.
 */
export function calcBundle(selected: Service[], globalBufferMinutes: number): BundleCalc {
  const duration = selected.reduce((a, s) => a + (s.duration_minutes ?? 0), 0);
  const buffer = selected.reduce((a, s) => a + (s.buffer_after_minutes ?? 0), 0) + (selected.length ? globalBufferMinutes : 0);
  const anyUnknown = selected.some((s) => s.price_cents === null);
  return {
    duration,
    buffer,
    total: duration + buffer,
    priceCents: anyUnknown ? null : selected.reduce((a, s) => a + (s.price_cents ?? 0), 0),
    priceEstimate: anyUnknown || selected.some((s) => s.price_from),
    needsApproval: selected.some((s) => s.booking_mode === 'manual' || s.category === 'consultation'),
    isConsultation: selected.some((s) => s.category === 'consultation'),
    label: selected.map((s) => s.name).join(' + '),
  };
}

/** Nuova chiave di idempotenza (una per tentativo di conferma). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
