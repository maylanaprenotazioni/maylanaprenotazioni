// Test unitari dei helper di data/ora (Europe/Rome, ora legale).
// Esecuzione: npm run test:unit   (Node >= 22.6)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  formatPrice,
  isoToRome,
  isoWeekday,
  romeDaysRange,
  romeLocalToIso,
  romeToday,
  startOfWeek,
} from '../src/lib/time.ts';

test('ora solare: 09:00 a Roma = 08:00 UTC', () => {
  assert.equal(romeLocalToIso('2027-03-27', '09:00'), '2027-03-27T08:00:00.000Z');
});

test('ora legale: 09:00 a Roma = 07:00 UTC', () => {
  assert.equal(romeLocalToIso('2027-03-28', '09:00'), '2027-03-28T07:00:00.000Z');
  assert.equal(romeLocalToIso('2026-07-15', '18:30'), '2026-07-15T16:30:00.000Z');
});

test('ritorno ora solare (25/10/2026): mezzanotte e mattina', () => {
  assert.equal(romeLocalToIso('2026-10-25', '00:00'), '2026-10-24T22:00:00.000Z');
  assert.equal(romeLocalToIso('2026-10-25', '09:00'), '2026-10-25T08:00:00.000Z');
});

test('giorno di 23 ore e di 25 ore', () => {
  const spring = romeDaysRange('2027-03-28');
  assert.equal((Date.parse(spring.to) - Date.parse(spring.from)) / 3_600_000, 23);
  const autumn = romeDaysRange('2026-10-25');
  assert.equal((Date.parse(autumn.to) - Date.parse(autumn.from)) / 3_600_000, 25);
});

test('isoToRome è inverso di romeLocalToIso', () => {
  for (const [d, t] of [['2026-10-29', '10:15'], ['2027-03-28', '15:45'], ['2026-12-31', '23:30']]) {
    assert.deepEqual(isoToRome(romeLocalToIso(d, t)), { date: d, time: t });
  }
});

test('oggi a Roma vicino alla mezzanotte UTC', () => {
  assert.equal(romeToday(new Date('2026-07-15T22:30:00Z')), '2026-07-16');
  assert.equal(romeToday(new Date('2026-12-15T22:30:00Z')), '2026-12-15');
});

test('aritmetica di calendario', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-03-01', -1), '2027-02-28');
  assert.equal(isoWeekday('2026-10-26'), 1); // lunedì
  assert.equal(isoWeekday('2026-11-01'), 7); // domenica
  assert.equal(startOfWeek('2026-11-01'), '2026-10-26');
  assert.equal(daysBetween('2026-10-28', '2026-11-04'), 7);
});

test('prezzi', () => {
  assert.equal(formatPrice(null), 'Prezzo in salone');
  assert.match(formatPrice(2500), /25\s?€/);
  assert.match(formatPrice(1850, true), /^da 18,50\s?€/);
});
