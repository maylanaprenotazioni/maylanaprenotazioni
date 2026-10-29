// Test unitari: combinazione servizi, file .ics, numeri WhatsApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcBundle } from '../src/lib/bundle.ts';
import { buildIcs } from '../src/lib/ics.ts';
import { waLink, waNumber } from '../src/lib/wa.ts';

const svc = (o: Record<string, unknown>) =>
  ({ id: 'x', category: 'hair', public_group: 'donna', name: 'S', description: null, price_cents: 1000, price_from: false, duration_minutes: 30, buffer_after_minutes: 0, booking_mode: 'automatic', sort_order: 0, ...o }) as never;

test('taglio donna 45 + piega 30 = 75 minuti, prezzo sommato', () => {
  const b = calcBundle([svc({ name: 'Taglio donna', duration_minutes: 45, price_cents: 3000 }), svc({ name: 'Piega', price_cents: 2000 })], 0);
  assert.equal(b.duration, 75);
  assert.equal(b.total, 75);
  assert.equal(b.priceCents, 5000);
  assert.equal(b.priceEstimate, false);
  assert.equal(b.needsApproval, false);
  assert.equal(b.label, 'Taglio donna + Piega');
});

test('tempi di preparazione e tempo aggiuntivo globale', () => {
  const b = calcBundle([svc({ duration_minutes: 60, buffer_after_minutes: 15 }), svc({})], 5);
  assert.equal(b.duration, 90);
  assert.equal(b.buffer, 20);
  assert.equal(b.total, 110);
});

test('un servizio su richiesta rende la combinazione da approvare', () => {
  assert.equal(calcBundle([svc({}), svc({ booking_mode: 'manual' })], 0).needsApproval, true);
});

test('prezzo non pubblicato o "da" → totale indicativo', () => {
  assert.equal(calcBundle([svc({}), svc({ price_cents: null })], 0).priceCents, null);
  assert.equal(calcBundle([svc({ price_from: true })], 0).priceEstimate, true);
});

test('.ics: date UTC, CRLF, campi escapati', () => {
  const ics = buildIcs({ uid: 'MY-ABC123', title: 'Maylana: Taglio, piega', startsAt: '2026-11-03T09:30:00Z', endsAt: '2026-11-03T10:45:00Z', location: 'Via Roma; 1' });
  assert.match(ics, /DTSTART:20261103T093000Z\r\n/);
  assert.match(ics, /DTEND:20261103T104500Z\r\n/);
  assert.match(ics, /SUMMARY:Maylana: Taglio\\, piega\r\n/);
  assert.match(ics, /LOCATION:Via Roma\; 1\r\n/);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
});

test('numeri WhatsApp in formato internazionale', () => {
  assert.equal(waNumber('340 123 4567'), '393401234567');
  assert.equal(waNumber('+39 340 1234567'), '393401234567');
  assert.equal(waNumber('0039 340 1234567'), '393401234567');
  assert.equal(waNumber('3912345678'), '393912345678');
  assert.equal(waLink('3401234567', 'Ciao, è ok?'), 'https://wa.me/393401234567?text=Ciao%2C%20%C3%A8%20ok%3F');
});
