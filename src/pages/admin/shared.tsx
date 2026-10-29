import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { AppointmentRow, NotificationRow, PublicGroup, Service } from '../../lib/types';
import { formatCalendarDate, formatDuration, formatLongDate, formatPrice, formatTime, isoToRome, romeLocalToIso, romeToday } from '../../lib/time';
import { GROUPS, newIdempotencyKey } from '../../lib/bundle';
import { STAFF_TEMPLATES, staffMessage, waLink } from '../../lib/whatsapp';
import { Alert, Badge, Button, Input, Select, Spinner, Textarea, cx } from '../../components/ui';
import { APPT_STATUS, NOTIF_LABEL, NOTIF_STATUS, SOURCE_LABEL, useAdmin } from './context';

export const APPT_SELECT =
  '*, customers(id, first_name, last_name, full_name, phone, email, marketing_consent), services(name, category, public_group), staff(display_name), appointment_items(service_id, position, name, duration_minutes, buffer_minutes, price_cents, price_from)';

/** Etichetta con tutti i servizi dell'appuntamento ("Taglio + Piega"). */
export function apptLabel(a: AppointmentRow): string {
  const items = [...(a.appointment_items ?? [])].sort((x, y) => x.position - y.position);
  return items.length ? items.map((i) => i.name).join(' + ') : a.services?.name ?? '';
}

export function apptServiceIds(a: AppointmentRow): string[] {
  const items = [...(a.appointment_items ?? [])].sort((x, y) => x.position - y.position);
  return items.length ? items.map((i) => i.service_id) : [a.service_id];
}

/** Durata dei soli servizi (senza tempi di preparazione). */
export function apptServiceMinutes(a: AppointmentRow): number {
  const items = a.appointment_items ?? [];
  return items.length ? items.reduce((t, i) => t + i.duration_minutes, 0) : Math.round((Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 60000);
}

export function apptGroups(a: AppointmentRow, services: Service[]): Set<PublicGroup> {
  const ids = apptServiceIds(a);
  return new Set(services.filter((s) => ids.includes(s.id)).map((s) => s.public_group));
}

export function priceLabel(cents: number | null | undefined, estimate: boolean | undefined): string {
  return cents == null ? 'Prezzo in salone' : formatPrice(cents, !!estimate);
}

/** Compone l'istante UTC da data + ora italiane. */
export function toIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}/.test(time)) return null;
  return romeLocalToIso(date, time.slice(0, 5));
}

interface BundleInfo {
  valid: boolean;
  error: string | null;
  duration_minutes: number;
  buffer_minutes: number;
  block_minutes: number;
  price_cents: number | null;
  price_is_estimate: boolean;
  all_automatic: boolean;
  eligible_staff: string[];
}

/** Totali della combinazione calcolati dal database (fonte autorevole). */
export function useBundle(serviceIds: string[]): BundleInfo | null {
  const [b, setB] = useState<BundleInfo | null>(null);
  const key = serviceIds.join(',');
  useEffect(() => {
    if (!serviceIds.length) {
      setB(null);
      return;
    }
    let alive = true;
    supabase!.rpc('bundle_info', { p_service_ids: serviceIds }).then(({ data }) => {
      if (alive) setB(((data as BundleInfo[]) ?? [])[0] ?? null);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return b;
}

/** Selezione di uno o più servizi, raggruppati per categoria. */
export function ServicePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { services } = useAdmin();
  const usable = services.filter((s) => s.duration_minutes);
  const bundle = useBundle(value);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.length < 5 ? [...value, id] : value);
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink-soft">Servizi</p>
      <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-line bg-paper p-3">
        {GROUPS.map((g) => {
          const list = usable.filter((s) => s.public_group === g.key);
          if (!list.length) return null;
          return (
            <div key={g.key}>
              <p className="mb-1 text-xs text-taupe">{g.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {list.map((s) => {
                  const on = value.includes(s.id);
                  return (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => toggle(s.id)}
                      aria-pressed={on}
                      className={cx('min-h-9 rounded-full border px-3 text-sm', on ? 'border-ink bg-ink text-ivory' : 'border-line hover:border-ink', !s.active && 'opacity-70')}
                    >
                      {on && <span className="mr-1 tabular-nums">{value.indexOf(s.id) + 1}.</span>}
                      {s.name} <span className="opacity-70">{s.duration_minutes}'</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {value.length > 0 && bundle && (
        <p className={cx('mt-2 text-sm', bundle.valid ? 'text-ink-soft' : 'text-danger')}>
          {bundle.valid
            ? `Totale ${formatDuration(bundle.duration_minutes)}${bundle.buffer_minutes ? ` + ${bundle.buffer_minutes}' preparazione` : ''}, ${priceLabel(bundle.price_cents, bundle.price_is_estimate)}${bundle.eligible_staff.length ? '' : '. Nessun operatore abilitato a tutti questi servizi.'}`
            : bundle.error === 'CONSULTATION_SINGLE'
              ? 'Le consulenze vanno inserite da sole.'
              : 'Combinazione non valida.'}
        </p>
      )}
    </div>
  );
}

/**
 * Scelta operatore + data + orario per l'area admin, per l'intera combinazione.
 * Solo operatori abilitati a TUTTI i servizi. Slot calcolati dal database
 * (esclude l'appuntamento che si sta modificando). Consente anche un orario manuale.
 */
export function SlotChooser({
  serviceIds,
  staffId,
  onStaff,
  date,
  onDate,
  time,
  onTime,
  ignoreAppointmentId,
}: {
  serviceIds: string[];
  staffId: string;
  onStaff: (id: string) => void;
  date: string;
  onDate: (d: string) => void;
  time: string;
  onTime: (t: string) => void;
  ignoreAppointmentId?: string;
}) {
  const { staff, staffServices } = useAdmin();
  const [slots, setSlots] = useState<{ time: string; rank: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = serviceIds.join(',');

  const options = useMemo(
    () =>
      staff.filter((s) => s.active && serviceIds.length > 0 && serviceIds.every((id) => staffServices.some((x) => x.staff_id === s.id && x.service_id === id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staff, staffServices, key],
  );

  useEffect(() => {
    if (!serviceIds.length || !staffId || !date) {
      setSlots(null);
      return;
    }
    let alive = true;
    setSlots(null);
    setErr(null);
    supabase!
      .rpc('get_bundle_slots', {
        p_service_ids: serviceIds,
        p_date: date,
        p_staff_id: staffId,
        p_apply_booking_window: false,
        p_ignore_appointment_id: ignoreAppointmentId ?? null,
      })
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) setErr(dbMessage(error));
        setSlots(((data as { starts_at: string; fit_rank: number }[]) ?? []).map((x) => ({ time: isoToRome(x.starts_at).time, rank: x.fit_rank })));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, staffId, date, ignoreAppointmentId]);

  const staffValid = !staffId || options.some((o) => o.id === staffId);

  return (
    <div className="space-y-4">
      <Select label="Operatore" value={staffId} onChange={(e) => onStaff(e.target.value)}>
        <option value="">Scegli…</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.display_name}
          </option>
        ))}
      </Select>
      {serviceIds.length > 0 && options.length === 0 && <Alert>Nessun operatore attivo è abilitato a tutti i servizi scelti (vedi Servizi → operatori abilitati).</Alert>}
      {!staffValid && <Alert>L'operatore attuale non è abilitato a tutti i servizi scelti: scegline un altro.</Alert>}
      <Input label="Data" type="date" value={date} onChange={(e) => onDate(e.target.value)} />
      {staffId && staffValid && date && (
        <div>
          <p className="mb-2 text-sm font-medium text-ink-soft">
            Orari liberi <span className="font-normal text-taupe">(bordo dorato = riempie meglio l'agenda)</span>
          </p>
          {err && <Alert>{err}</Alert>}
          {!slots && !err && <Spinner small />}
          {slots && slots.length === 0 && <p className="text-sm text-taupe">Nessuno slot libero per l'intera durata. Puoi indicare un orario manuale.</p>}
          {slots && slots.length > 0 && (
            <div className="grid max-h-48 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6">
              {slots.map((t) => (
                <button
                  type="button"
                  key={t.time}
                  onClick={() => onTime(t.time)}
                  className={cx(
                    'min-h-10 rounded-lg border text-sm tabular-nums',
                    t.time === time ? 'border-ink bg-ink text-ivory' : t.rank <= 1 ? 'border-champagne-deep bg-champagne-wash' : 'border-line bg-paper hover:border-ink',
                  )}
                >
                  {t.time}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Input label="Orario" type="time" step={300} value={time} onChange={(e) => onTime(e.target.value)} hint="Selezionalo sopra o scrivilo a mano: il sistema verifica comunque la disponibilità." />
    </div>
  );
}

/** WhatsApp verso il cliente con messaggi precompilati (link wa.me: l'invio lo fai tu). */
export function WhatsAppStaff({
  phone,
  firstName,
  code,
  startsAt,
  defaultTemplate = 'contatto',
}: {
  phone: string;
  firstName: string;
  code?: string | null;
  startsAt?: string | null;
  defaultTemplate?: (typeof STAFF_TEMPLATES)[number]['key'];
}) {
  const [open, setOpen] = useState(false);
  const { businessName } = useAdmin();
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex min-h-10 items-center rounded-full border border-[#1f7a4d]/40 bg-paper px-4 text-sm text-[#1f6b45]"
      >
        WhatsApp ▾
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-64 rounded-xl border border-line bg-paper p-2 shadow-lg">
          <p className="px-2 pb-1 text-xs text-taupe">Si apre WhatsApp con il testo pronto: l'invio lo fai tu.</p>
          {STAFF_TEMPLATES.filter((t) => (t.key === 'contatto' || !!startsAt) && (t.key !== 'proposta' || defaultTemplate === 'proposta')).map((t) => (
            <a
              key={t.key}
              href={waLink(phone, staffMessage(t.key, { firstName, startsAt, code, businessName }))}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className={cx('block rounded-lg px-2 py-2 text-sm hover:bg-champagne-wash', t.key === defaultTemplate && 'font-medium')}
            >
              {t.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Contatti rapidi: telefono, WhatsApp, email. */
export function ContactLinks({
  phone,
  email,
  firstName = '',
  code,
  startsAt,
  template,
}: {
  phone: string;
  email: string | null;
  firstName?: string;
  code?: string | null;
  startsAt?: string | null;
  template?: (typeof STAFF_TEMPLATES)[number]['key'];
}) {
  const cls = 'inline-flex min-h-10 items-center rounded-full border border-line bg-paper px-4 text-sm hover:border-ink';
  return (
    <div className="flex flex-wrap gap-2">
      <a className={cls} href={`tel:${phone.replace(/\s/g, '')}`}>
        Chiama
      </a>
      <WhatsAppStaff phone={phone} firstName={firstName} code={code} startsAt={startsAt} defaultTemplate={template} />
      {email && (
        <a className={cls} href={`mailto:${email}`}>
          Email
        </a>
      )}
    </div>
  );
}

/** Stato delle email collegate a un appuntamento o una richiesta. */
export function EmailLog({ appointmentId, requestId, refreshKey = 0 }: { appointmentId?: string; requestId?: string; refreshKey?: number }) {
  const { sendEmails } = useAdmin();
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    let q = supabase!.from('notifications').select('*').order('created_at', { ascending: false }).limit(20);
    q = appointmentId ? q.eq('appointment_id', appointmentId) : q.eq('booking_request_id', requestId!);
    q.then(({ data }) => setRows((data as NotificationRow[]) ?? []));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [appointmentId, requestId, refreshKey]);

  const retry = async (id: string) => {
    setBusy(id);
    const { error } = await supabase!.rpc('admin_retry_notification', { p_id: id });
    if (!error) await sendEmails([id]);
    setBusy(null);
    load();
  };

  if (!rows) return <Spinner small />;
  if (!rows.length) return <p className="text-sm text-taupe">Nessuna email.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((n) => {
        const st = NOTIF_STATUS[n.status];
        return (
          <li key={n.id} className="rounded-xl border border-line bg-paper px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{NOTIF_LABEL[n.kind] ?? n.kind}</span>
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="ml-auto text-xs text-taupe">
                {formatCalendarDate(isoToRome(n.sent_at ?? n.created_at).date, { day: 'numeric', month: 'short' })} {formatTime(n.sent_at ?? n.created_at)}
              </span>
            </div>
            {n.last_error && <p className="mt-1 text-xs text-danger">{n.last_error}</p>}
            {(n.status === 'failed' || n.status === 'skipped') && (
              <button onClick={() => retry(n.id)} disabled={busy === n.id} className="mt-1 text-xs text-champagne-deep underline underline-offset-2">
                {busy === n.id ? 'Invio…' : 'Riprova invio'}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface AuditRow {
  id: number;
  at: string;
  action: string;
  actor_kind: string;
  changes: Record<string, { da: unknown; a: unknown }> | Record<string, unknown> | null;
}

const FIELD: Record<string, string> = { starts_at: 'Orario', staff_id: 'Operatore', status: 'Stato', internal_notes: 'Note interne' };

/** Storico delle modifiche (audit log). */
export function ChangeLog({ table, rowId }: { table: string; rowId: string }) {
  const { staff } = useAdmin();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  useEffect(() => {
    supabase!
      .from('audit_log')
      .select('id, at, action, actor_kind, changes')
      .eq('table_name', table)
      .eq('row_id', rowId)
      .order('at', { ascending: false })
      .limit(30)
      .then(({ data }) => setRows((data as AuditRow[]) ?? []));
  }, [table, rowId]);

  const fmt = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return '—';
    if (k === 'starts_at' && typeof v === 'string') return `${formatCalendarDate(isoToRome(v).date, { day: 'numeric', month: 'short' })} ${formatTime(v)}`;
    if (k === 'staff_id') return staff.find((s) => s.id === v)?.display_name ?? '—';
    if (k === 'status') return APPT_STATUS[String(v)]?.label ?? String(v);
    return String(v);
  };
  const who = (k: string) => (k === 'customer' ? 'Cliente (link)' : k === 'admin' ? 'Salone' : 'Sistema');

  if (!rows) return <Spinner small />;
  if (!rows.length) return <p className="text-sm text-taupe">Nessuna modifica registrata.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {rows.map((r) => {
        const changes = r.action === 'update' && r.changes ? Object.entries(r.changes as Record<string, { da: unknown; a: unknown }>).filter(([k]) => k in FIELD) : [];
        return (
          <li key={r.id} className="border-l-2 border-line pl-3">
            <p className="text-xs text-taupe">
              {formatCalendarDate(isoToRome(r.at).date, { day: 'numeric', month: 'short' })} {formatTime(r.at)}, {who(r.actor_kind)}
            </p>
            {r.action === 'insert' && <p>Creato</p>}
            {r.action === 'delete' && <p>Eliminato</p>}
            {changes.map(([k, v]) => (
              <p key={k}>
                {FIELD[k]}: {fmt(k, v.da)} → {fmt(k, v.a)}
              </p>
            ))}
            {r.action === 'update' && changes.length === 0 && <p className="text-taupe">Altri dati aggiornati</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** Dettaglio appuntamento con tutte le azioni, utilizzabile da smartphone. */
export function AppointmentDetail({ appt, onChanged }: { appt: AppointmentRow; onChanged: () => void }) {
  const { go, toast } = useAdmin();
  const [view, setView] = useState<'main' | 'move' | 'cancel'>('main');
  const [notes, setNotes] = useState(appt.internal_notes ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'email' | 'storico' | null>(null);
  const st = APPT_STATUS[appt.status];
  const c = appt.customers;
  const isFuture = new Date(appt.starts_at).getTime() > Date.now();

  const update = async (patch: Record<string, unknown>, key: string, msg: string) => {
    setBusy(key);
    setErr(null);
    const { error } = await supabase!.from('appointments').update(patch).eq('id', appt.id);
    setBusy(null);
    if (error) return setErr(dbMessage(error));
    toast(msg);
    onChanged();
  };

  if (view === 'move') return <MoveForm appt={appt} onBack={() => setView('main')} onDone={onChanged} />;
  if (view === 'cancel') return <CancelForm appt={appt} onBack={() => setView('main')} onDone={onChanged} />;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={st.tone}>{st.label}</Badge>
          <Badge>{SOURCE_LABEL[appt.source]}</Badge>
          {appt.services?.category === 'consultation' && <Badge tone="gold">Capelli For You</Badge>}
          <span className="text-xs text-taupe">{appt.code}</span>
        </div>
        <p className="mt-3 first-letter:uppercase">
          {formatLongDate(appt.starts_at)}, {formatTime(appt.starts_at)}–{formatTime(appt.ends_at)}
        </p>
        <p className="text-sm text-taupe">con {appt.staff?.display_name}</p>
        <ul className="mt-3 space-y-1 rounded-xl border border-line bg-paper px-4 py-3">
          {[...(appt.appointment_items ?? [])]
            .sort((a, b) => a.position - b.position)
            .map((i) => (
              <li key={i.position} className="flex items-baseline gap-3">
                <span className="font-display text-lg">{i.name}</span>
                <span className="leader" aria-hidden />
                <span className="shrink-0 text-sm tabular-nums text-ink-soft">
                  {i.duration_minutes}'{i.buffer_minutes ? ` +${i.buffer_minutes}'` : ''}, {priceLabel(i.price_cents, i.price_from)}
                </span>
              </li>
            ))}
          {!appt.appointment_items?.length && <li className="font-display text-lg">{appt.services?.name}</li>}
          <li className="flex justify-between border-t border-line pt-2 text-sm">
            <span>
              Totale {formatDuration(apptServiceMinutes(appt))}
              {Math.round((Date.parse(appt.ends_at) - Date.parse(appt.starts_at)) / 60000) > apptServiceMinutes(appt) ? ' (+ preparazione)' : ''}
            </span>
            <span className="font-medium tabular-nums">{priceLabel(appt.total_price_cents, appt.price_is_estimate)}</span>
          </li>
        </ul>
      </div>

      {appt.status === 'confirmed' && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setView('move')}>
            Modifica
          </Button>
          <Button variant="danger" onClick={() => setView('cancel')}>
            Annulla
          </Button>
        </div>
      )}

      {c && (
        <div className="space-y-3 rounded-xl border border-line bg-paper p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium">{c.full_name}</p>
              <p className="text-sm text-ink-soft">{c.phone}</p>
              {c.email && <p className="text-sm text-ink-soft">{c.email}</p>}
            </div>
            <button onClick={() => go('clienti', { customerId: c.id })} className="text-sm text-champagne-deep underline underline-offset-4">
              Scheda
            </button>
          </div>
          <ContactLinks phone={c.phone} email={c.email} firstName={c.first_name} code={appt.code} startsAt={appt.status === 'confirmed' ? appt.starts_at : null} template={appt.status === 'cancelled' ? 'annullamento' : isFuture ? 'promemoria' : 'contatto'} />
          {c.marketing_consent && <p className="text-xs text-taupe">Ha dato il consenso a ricevere comunicazioni promozionali.</p>}
          {appt.customer_notes && <p className="border-t border-line pt-3 text-sm text-ink-soft">Note cliente: {appt.customer_notes}</p>}
        </div>
      )}

      <Textarea label="Note interne" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
      <Button variant="ghost" busy={busy === 'notes'} onClick={() => update({ internal_notes: notes.trim() || null }, 'notes', 'Note salvate.')} className="w-full">
        Salva note
      </Button>

      {err && <Alert>{err}</Alert>}

      {appt.status !== 'cancelled' && !isFuture && (
        <div className="grid grid-cols-2 gap-2 border-t border-line pt-5">
          {appt.status !== 'completed' && (
            <Button variant="secondary" busy={busy === 'completed'} onClick={() => update({ status: 'completed' }, 'completed', 'Segnato come completato.')}>
              Completato
            </Button>
          )}
          {appt.status !== 'no_show' && (
            <Button variant="secondary" busy={busy === 'no_show'} onClick={() => update({ status: 'no_show' }, 'no_show', 'Segnato come non presentato.')}>
              Non presentato
            </Button>
          )}
          {appt.status !== 'confirmed' && (
            <Button variant="ghost" busy={busy === 'confirmed'} onClick={() => update({ status: 'confirmed' }, 'confirmed', 'Stato ripristinato.')}>
              Ripristina
            </Button>
          )}
        </div>
      )}

      <div className="flex gap-2 border-t border-line pt-4">
        {(['email', 'storico'] as const).map((t) => (
          <button key={t} onClick={() => setTab(tab === t ? null : t)} className={cx('rounded-full border px-4 py-1.5 text-sm', tab === t ? 'border-ink bg-ink text-ivory' : 'border-line')}>
            {t === 'email' ? 'Email inviate' : 'Storico modifiche'}
          </button>
        ))}
      </div>
      {tab === 'email' && <EmailLog appointmentId={appt.id} />}
      {tab === 'storico' && <ChangeLog table="appointments" rowId={appt.id} />}
    </div>
  );
}

/** Modifica appuntamento: servizi, operatore, data e ora in un'unica operazione verificata dal server. */
function MoveForm({ appt, onBack, onDone }: { appt: AppointmentRow; onBack: () => void; onDone: () => void }) {
  const { sendEmails, toast } = useAdmin();
  const cur = isoToRome(appt.starts_at);
  const [serviceIds, setServiceIds] = useState(apptServiceIds(appt));
  const [staffId, setStaffId] = useState(appt.staff_id);
  const [date, setDate] = useState(cur.date);
  const [time, setTime] = useState(cur.time);
  const [force, setForce] = useState(false);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const startsAt = toIso(date, time);
    if (!serviceIds.length || !staffId || !startsAt) return setErr('Indica servizi, operatore, data e orario.');
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase!.rpc('admin_update_appointment', {
      p_appointment_id: appt.id,
      p_service_ids: serviceIds,
      p_staff_id: staffId,
      p_starts_at: startsAt,
      p_allow_outside_hours: force,
      p_notify: notify,
    });
    setBusy(false);
    if (error) return setErr(dbMessage(error) + (error.message === 'SLOT_UNAVAILABLE' ? ' Scegli un altro orario.' : ''));
    toast('Appuntamento aggiornato.');
    await sendEmails((data as { notification_ids?: unknown })?.notification_ids);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-ink-soft">
        {appt.customers?.full_name}. Ora: {formatLongDate(appt.starts_at)}, {formatTime(appt.starts_at)}
      </p>
      <ServicePicker value={serviceIds} onChange={setServiceIds} />
      <SlotChooser serviceIds={serviceIds} staffId={staffId} onStaff={setStaffId} date={date} onDate={setDate} time={time} onTime={setTime} ignoreAppointmentId={appt.id} />
      <label className="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-1 accent-ink" />
        Consenti fuori dall'orario di lavoro (le sovrapposizioni restano bloccate)
      </label>
      <label className="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-1 accent-ink" />
        Se cambia l'orario, invia email al cliente
      </label>
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full">
        Salva modifiche
      </Button>
      <Button type="button" variant="ghost" onClick={onBack} className="w-full">
        Indietro
      </Button>
    </form>
  );
}

function CancelForm({ appt, onBack, onDone }: { appt: AppointmentRow; onBack: () => void; onDone: () => void }) {
  const { sendEmails, toast } = useAdmin();
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase!.rpc('admin_cancel_appointment', { p_appointment_id: appt.id, p_reason: reason || null, p_notify: notify });
    setBusy(false);
    if (error) return setErr(dbMessage(error));
    toast('Appuntamento annullato: orario di nuovo disponibile.');
    await sendEmails((data as { notification_ids?: unknown })?.notification_ids);
    onDone();
  };

  return (
    <div className="space-y-4">
      <p>
        Annullare {apptLabel(appt)} di {appt.customers?.full_name}, {formatLongDate(appt.starts_at)} alle {formatTime(appt.starts_at)}?
      </p>
      <Input label="Motivo (interno, facoltativo)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      <label className="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-1 accent-ink" />
        Invia email di annullamento al cliente
      </label>
      {err && <Alert>{err}</Alert>}
      <Button variant="danger" busy={busy} onClick={submit} className="w-full">
        Annulla appuntamento
      </Button>
      <Button variant="ghost" onClick={onBack} className="w-full">
        Indietro
      </Button>
    </div>
  );
}

/** Inserimento manuale, anche di appuntamenti combinati (da agenda, scheda cliente o suggerimenti). */
export function NewAppointment({
  initial,
  onDone,
}: {
  initial?: { date?: string; time?: string; staffId?: string; firstName?: string; lastName?: string; phone?: string; email?: string; serviceIds?: string[] };
  onDone: () => void;
}) {
  const { sendEmails, toast } = useAdmin();
  const [serviceIds, setServiceIds] = useState<string[]>(initial?.serviceIds ?? []);
  const [staffId, setStaffId] = useState(initial?.staffId ?? '');
  const [date, setDate] = useState(initial?.date ?? romeToday());
  const [time, setTime] = useState(initial?.time ?? '');
  const [first, setFirst] = useState(initial?.firstName ?? '');
  const [last, setLast] = useState(initial?.lastName ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [notes, setNotes] = useState('');
  const [force, setForce] = useState(false);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey()); // doppio clic → un solo appuntamento

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    const startsAt = toIso(date, time);
    if (!serviceIds.length || !staffId || !startsAt) return setErr('Indica servizi, operatore, data e orario.');
    setBusy(true);
    const { data, error } = await supabase!.rpc('admin_create_appointment', {
      p_service_ids: serviceIds,
      p_staff_id: staffId,
      p_starts_at: startsAt,
      p_first_name: first,
      p_last_name: last,
      p_phone: phone,
      p_email: email || null,
      p_internal_notes: notes || null,
      p_allow_outside_hours: force,
      p_notify: notify && !!email,
      p_idempotency_key: key.current,
    });
    setBusy(false);
    if (error) return setErr(dbMessage(error));
    toast('Appuntamento salvato.');
    await sendEmails((data as { notification_ids?: unknown })?.notification_ids);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <ServicePicker value={serviceIds} onChange={setServiceIds} />
      {serviceIds.length > 0 && (
        <SlotChooser serviceIds={serviceIds} staffId={staffId} onStaff={setStaffId} date={date} onDate={setDate} time={time} onTime={setTime} />
      )}
      <div className="space-y-4 border-t border-line pt-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Nome" value={first} onChange={(e) => setFirst(e.target.value)} required />
          <Input label="Cognome" value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
        <Input label="Telefono" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required hint="Se il numero è già registrato, l'appuntamento va sulla stessa scheda cliente." />
        <Input label="Email (facoltativa)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Textarea label="Note interne" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <label className="flex items-start gap-3 text-sm text-ink-soft">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-1 accent-ink" />
          Consenti fuori dall'orario di lavoro (le sovrapposizioni restano bloccate)
        </label>
        <label className="flex items-start gap-3 text-sm text-ink-soft">
          <input type="checkbox" checked={notify} disabled={!email} onChange={(e) => setNotify(e.target.checked)} className="mt-1 accent-ink" />
          Invia email di conferma al cliente {email ? '' : "(serve l'email)"}
        </label>
      </div>
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full">
        Salva appuntamento
      </Button>
    </form>
  );
}
