import { z } from 'zod';
import { ApiError } from './http';

// Rimuove caratteri di controllo e spazi superflui
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanMultiline = (s: string) => s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();

const uuid = z.string().uuid();
const firstName = z.string().transform(clean).pipe(z.string().min(1, 'Inserisci il nome.').max(60, 'Nome troppo lungo.'));
const lastName = z.string().transform(clean).pipe(z.string().min(1, 'Inserisci il cognome.').max(60, 'Cognome troppo lungo.'));
const phone = z
  .string()
  .transform(clean)
  .pipe(z.string().max(40))
  .refine((v) => /^\+?[0-9 ().\-/]{6,40}$/.test(v) && v.replace(/\D/g, '').length >= 6 && v.replace(/\D/g, '').length <= 20, 'Numero di telefono non valido.');
const email = z.string().transform(clean).pipe(z.string().email('Indirizzo email non valido.').max(200));
const notes = z
  .string()
  .transform(cleanMultiline)
  .pipe(z.string().max(500, 'Le note possono contenere al massimo 500 caratteri.'))
  .optional()
  .nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida.');

const antiSpam = {
  website: z.string().max(200).optional(), // honeypot: deve restare vuoto
  formStartedAt: z.number().int().positive(),
};

const serviceIds = z
  .array(uuid)
  .min(1, 'Scegli almeno un servizio.')
  .max(5, 'Puoi scegliere al massimo 5 servizi.')
  .refine((a) => new Set(a).size === a.length, 'Servizio ripetuto.');

export const availabilityQuery = z.object({
  serviceIds,
  date: isoDate,
  staffId: uuid.optional().nullable(),
});

export const bookingBody = z.object({
  serviceIds,
  idempotencyKey: uuid,
  marketingConsent: z.boolean().default(false),
  staffId: uuid.nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  firstName,
  lastName,
  phone,
  email,
  notes,
  privacyAccepted: z.literal(true, { errorMap: () => ({ message: "È necessario accettare l'informativa privacy." }) }),
  ...antiSpam,
});

export const requestBody = z.object({
  serviceIds,
  idempotencyKey: uuid,
  marketingConsent: z.boolean().default(false),
  preferredStaffId: uuid.nullable().optional(),
  preferredDate: isoDate.nullable().optional(),
  preferredTimeWindow: z.enum(['mattina', 'pomeriggio', 'indifferente']).default('indifferente'),
  firstName,
  lastName,
  phone,
  email,
  notes,
  privacyAccepted: z.literal(true, { errorMap: () => ({ message: "È necessario accettare l'informativa privacy." }) }),
  ...antiSpam,
});

const token = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'Link non valido.');

export const manageBody = z.object({ token });

export const manageAvailabilityBody = z.object({ token, date: isoDate });

export const manageRescheduleBody = z.object({
  token,
  startsAt: z.string().datetime({ offset: true }),
  staffId: uuid.nullable().optional(),
});

export const manageRequestBody = z.object({
  token,
  preferredDate: isoDate.nullable().optional(),
  preferredTimeWindow: z.enum(['mattina', 'pomeriggio', 'indifferente']).default('indifferente'),
  notes,
});

export const dispatchBody = z.object({
  ids: z.array(uuid).max(20).optional(),
});

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path?.join('.') || 'input';
    const msg = first?.message && !/^(Required|Invalid|Expected)/.test(first.message) ? first.message : `Campo non valido: ${field}`;
    throw new ApiError(400, 'VALIDATION_ERROR', msg);
  }
  return result.data;
}

export function isValidCalendarDate(d: string): boolean {
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}
