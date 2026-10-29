import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { RequestRow, RequestStatus } from '../../lib/types';
import { formatCalendarDate, formatLongDate, formatTime, isoToRome, romeToday } from '../../lib/time';
import { Alert, Badge, Button, EmptyState, Modal, Spinner, Textarea, cx } from '../../components/ui';
import { REQ_STATUS, useAdmin } from './context';
import { ChangeLog, ContactLinks, EmailLog, SlotChooser, toIso } from './shared';

export const REQUEST_SELECT =
  '*, customers(id, first_name, last_name, full_name, phone, email, marketing_consent), services(name, category, duration_minutes), booking_request_items(position, service_id, services(name, duration_minutes)), appointments!appointments_booking_request_id_fkey(id, starts_at, status, staff(display_name))';

/** Servizi della richiesta nell'ordine scelto dal cliente. */
export function requestServiceIds(r: RequestRow): string[] {
  const items = [...(r.booking_request_items ?? [])].sort((a, b) => a.position - b.position);
  return items.length ? items.map((i) => i.service_id) : [r.service_id];
}

export function requestLabel(r: RequestRow): string {
  const items = [...(r.booking_request_items ?? [])].sort((a, b) => a.position - b.position);
  return items.length ? items.map((i) => i.services?.name ?? '').join(' + ') : r.services?.name ?? '';
}

const FILTERS: { key: string; label: string; statuses: RequestStatus[] }[] = [
  { key: 'open', label: 'Da gestire', statuses: ['pending', 'reschedule'] },
  { key: 'confirmed', label: 'Approvate', statuses: ['confirmed'] },
  { key: 'closed', label: 'Storico chiuse', statuses: ['rejected', 'cancelled'] },
];

export default function Requests({ onChange }: { onChange: () => void }) {
  const [section, setSection] = useState<'consultation' | 'hair'>('consultation');
  const [filter, setFilter] = useState('open');
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [counts, setCounts] = useState<{ consultation: number; hair: number }>({ consultation: 0, hair: 0 });
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ row: RequestRow; kind: 'confirm' | 'propose' | RequestStatus | 'detail' } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const statuses = FILTERS.find((f) => f.key === filter)!.statuses;
    const [{ data, error }, open] = await Promise.all([
      supabase!
        .from('booking_requests')
        .select(REQUEST_SELECT)
        .in('status', statuses)
        .order('created_at', { ascending: filter === 'open' })
        .limit(300),
      supabase!.from('booking_requests').select('id, services(category)').in('status', ['pending', 'reschedule']),
    ]);
    if (error) setError(dbMessage(error));
    const all = (data as RequestRow[]) ?? [];
    setRows(all.filter((r) => r.services?.category === section));
    const o = (open.data as unknown as { services: { category: string } | null }[]) ?? [];
    setCounts({ consultation: o.filter((x) => x.services?.category === 'consultation').length, hair: o.filter((x) => x.services?.category === 'hair').length });
  }, [filter, section]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const done = () => {
    setAction(null);
    load();
    onChange();
  };

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 rounded-full border border-ink/15 bg-paper p-1">
        {(
          [
            ['consultation', 'Capelli For You'],
            ['hair', 'Parrucchiere'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => setSection(k)} className={cx('min-h-11 rounded-full text-[15px]', section === k ? 'bg-ink text-ivory' : 'text-ink-soft')}>
            {label}
            {counts[k] > 0 && <span className="ml-1.5 rounded-full bg-champagne px-1.5 text-xs font-semibold text-ink">{counts[k]}</span>}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} className={cx('min-h-9 rounded-full border px-4 text-sm', filter === f.key ? 'border-ink bg-ink text-ivory' : 'border-line bg-paper text-ink-soft')}>
            {f.label}
          </button>
        ))}
      </div>
      {section === 'consultation' && (
        <p className="mb-4 max-w-prose text-sm text-taupe">
          Consulenze riservate in collaborazione con Capelli For You. Le richieste in attesa non bloccano l'agenda: l'orario si occupa solo quando approvi, e
          l'approvazione riesce solo se l'orario è ancora libero.
        </p>
      )}

      {error && <Alert>{error}</Alert>}
      {!rows && !error && <Spinner />}
      {rows && rows.length === 0 && <EmptyState>{filter === 'open' ? 'Nessuna richiesta da gestire.' : 'Nessuna richiesta in questo elenco.'}</EmptyState>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows?.map((r) => (
          <RequestCard key={r.id} r={r} onAction={(kind) => setAction({ row: r, kind })} />
        ))}
      </div>

      <Modal open={!!action} onClose={() => setAction(null)} title={action ? modalTitle(action.kind) : ''}>
        {action?.kind === 'confirm' && <ConfirmForm row={action.row} onDone={done} />}
        {action?.kind === 'propose' && <ProposeForm row={action.row} onDone={done} />}
        {action?.kind === 'detail' && <RequestHistory row={action.row} />}
        {action && ['pending', 'rejected', 'reschedule', 'cancelled'].includes(action.kind) && (
          <StatusForm row={action.row} status={action.kind as RequestStatus} onDone={done} />
        )}
      </Modal>
    </div>
  );
}

function modalTitle(k: string): string {
  if (k === 'confirm') return 'Approva richiesta';
  if (k === 'propose') return 'Proponi nuova data';
  if (k === 'detail') return 'Storico richiesta';
  return REQ_STATUS[k]?.label ?? '';
}

function RequestCard({ r, onAction }: { r: RequestRow; onAction: (k: 'confirm' | 'propose' | RequestStatus | 'detail') => void }) {
  const st = REQ_STATUS[r.status];
  const appt = r.appointments?.find((a) => a.status !== 'cancelled');
  const open = r.status === 'pending' || r.status === 'reschedule';
  return (
    <article className={cx('rounded-2xl border bg-paper p-4', open ? 'border-champagne-deep/50' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone}>{st.label}</Badge>
        {r.reschedule_of_appointment_id && <Badge>Spostamento chiesto dal cliente</Badge>}
        <span className="ml-auto text-xs text-taupe">{r.code}</span>
      </div>
      <h3 className="mt-2 font-display text-xl">{requestLabel(r)}</h3>
      <p className="mt-1 font-medium">{r.customers?.full_name}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-taupe">Preferenza</dt>
        <dd>
          {r.preferred_date ? formatCalendarDate(r.preferred_date, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Qualsiasi giorno'}, {r.preferred_time_window}
        </dd>
        <dt className="text-taupe">Ricevuta</dt>
        <dd>
          {formatCalendarDate(isoToRome(r.created_at).date, { day: 'numeric', month: 'short' })} alle {formatTime(r.created_at)}
        </dd>
        {r.proposed_starts_at && r.status === 'reschedule' && (
          <>
            <dt className="text-taupe">Proposta</dt>
            <dd className="first-letter:uppercase">
              {formatLongDate(r.proposed_starts_at)}, {formatTime(r.proposed_starts_at)}
            </dd>
          </>
        )}
        {appt && (
          <>
            <dt className="text-taupe">Fissata</dt>
            <dd className="first-letter:uppercase">
              {formatLongDate(appt.starts_at)}, {formatTime(appt.starts_at)} con {appt.staff?.display_name}
            </dd>
          </>
        )}
      </dl>
      {r.customer_notes && <p className="mt-3 rounded-lg bg-ivory px-3 py-2 text-sm">{r.customer_notes}</p>}
      {r.admin_notes && <p className="mt-2 text-sm text-taupe">Nota interna: {r.admin_notes}</p>}
      {r.customers && (
        <div className="mt-3">
          <ContactLinks
            phone={r.customers.phone}
            email={r.customers.email}
            firstName={r.customers.first_name}
            code={r.code}
            startsAt={r.proposed_starts_at ?? appt?.starts_at ?? null}
            template={r.proposed_starts_at && r.status === 'reschedule' ? 'proposta' : appt ? 'conferma' : 'contatto'}
          />
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        {open && (
          <Button className="min-h-11" onClick={() => onAction('confirm')}>
            Approva
          </Button>
        )}
        {open && (
          <Button variant="secondary" className="min-h-11" onClick={() => onAction('propose')}>
            Proponi data
          </Button>
        )}
        {r.status === 'pending' && (
          <Button variant="danger" className="min-h-11" onClick={() => onAction('rejected')}>
            Rifiuta
          </Button>
        )}
        {(open || r.status === 'confirmed') && (
          <Button variant="ghost" className="min-h-11" onClick={() => onAction('cancelled')}>
            Annulla
          </Button>
        )}
        {(r.status === 'rejected' || r.status === 'cancelled') && (
          <Button variant="ghost" className="min-h-11" onClick={() => onAction('pending')}>
            Riapri
          </Button>
        )}
        <Button variant="ghost" className="min-h-11" onClick={() => onAction('detail')}>
          Storico
        </Button>
      </div>
    </article>
  );
}

export function ConfirmForm({
  row,
  onDone,
  initial,
}: {
  row: RequestRow;
  onDone: () => void;
  initial?: { staffId?: string; date?: string; time?: string };
}) {
  const { sendEmails, toast } = useAdmin();
  const proposed = row.proposed_starts_at ? isoToRome(row.proposed_starts_at) : null;
  const [staffId, setStaffId] = useState(initial?.staffId ?? row.proposed_staff_id ?? row.preferred_staff_id ?? '');
  const [date, setDate] = useState(initial?.date ?? proposed?.date ?? row.preferred_date ?? romeToday());
  const [time, setTime] = useState(initial?.time ?? proposed?.time ?? '');
  const [notes, setNotes] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const startsAt = toIso(date, time);
    if (!staffId || !startsAt) return setErr('Scegli operatore, data e orario.');
    setBusy(true);
    const { data, error } = await supabase!.rpc('admin_confirm_request', {
      p_request_id: row.id,
      p_staff_id: staffId,
      p_starts_at: startsAt,
      p_internal_notes: notes || null,
      p_allow_outside_hours: force,
    });
    setBusy(false);
    if (error) {
      if (error.message === 'SLOT_UNAVAILABLE') {
        setTime('');
        return setErr("Questo orario non è più libero. Scegli un nuovo orario tra quelli disponibili.");
      }
      return setErr(dbMessage(error));
    }
    toast('Richiesta approvata: appuntamento in agenda.');
    await sendEmails((data as { notification_ids?: unknown })?.notification_ids);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-ink-soft">
        {requestLabel(row)}, per {row.customers?.full_name}
        {row.reschedule_of_appointment_id ? '. È uno spostamento: verrà modificato l\'appuntamento esistente.' : ''}
      </p>
      <SlotChooser
        serviceIds={requestServiceIds(row)}
        staffId={staffId}
        onStaff={setStaffId}
        date={date}
        onDate={setDate}
        time={time}
        onTime={setTime}
        ignoreAppointmentId={row.reschedule_of_appointment_id ?? undefined}
      />
      <Textarea label="Note interne" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <label className="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-1 accent-ink" />
        Consenti fuori dall'orario di lavoro
      </label>
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full">
        Approva e invia conferma
      </Button>
    </form>
  );
}

function ProposeForm({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const { sendEmails, toast } = useAdmin();
  const [staffId, setStaffId] = useState(row.preferred_staff_id ?? '');
  const [date, setDate] = useState(row.preferred_date ?? romeToday());
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const startsAt = toIso(date, time);
    if (!staffId || !startsAt) return setErr('Scegli operatore, data e orario da proporre.');
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase!.rpc('admin_propose_request_time', { p_request_id: row.id, p_staff_id: staffId, p_starts_at: startsAt, p_admin_notes: note || null });
    setBusy(false);
    if (error) return setErr(dbMessage(error));
    toast('Proposta registrata.');
    await sendEmails((data as { notification_ids?: unknown })?.notification_ids);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Alert tone="info">La proposta non occupa l'orario. Quando il cliente accetta, usa "Approva": l'orario verrà verificato di nuovo.</Alert>
      <SlotChooser
        serviceIds={requestServiceIds(row)}
        staffId={staffId}
        onStaff={setStaffId}
        date={date}
        onDate={setDate}
        time={time}
        onTime={setTime}
        ignoreAppointmentId={row.reschedule_of_appointment_id ?? undefined}
      />
      <Textarea label="Nota interna (facoltativa)" value={note} onChange={(e) => setNote(e.target.value)} />
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full">
        Invia proposta al cliente
      </Button>
    </form>
  );
}

function StatusForm({ row, status, onDone }: { row: RequestRow; status: RequestStatus; onDone: () => void }) {
  const { sendEmails, toast } = useAdmin();
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasAppt = row.appointments?.some((a) => a.status === 'confirmed');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await supabase!.rpc('admin_set_request_status', { p_request_id: row.id, p_status: status, p_admin_notes: note || null, p_notify: notify });
    setBusy(false);
    if (error) return setErr(dbMessage(error));
    toast(`Richiesta: ${REQ_STATUS[status].label.toLowerCase()}.`);
    await sendEmails((data as { notification_ids?: unknown })?.notification_ids);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p>
        {requestLabel(row)}, {row.customers?.full_name}
      </p>
      {hasAppt && <Alert tone="info">L'appuntamento già fissato verrà annullato e l'orario tornerà libero.</Alert>}
      <Textarea label="Nota interna (facoltativa)" value={note} onChange={(e) => setNote(e.target.value)} />
      {(status === 'rejected' || hasAppt) && (
        <label className="flex items-start gap-3 text-sm text-ink-soft">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-1 accent-ink" />
          Avvisa il cliente via email
        </label>
      )}
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} variant={status === 'rejected' || status === 'cancelled' ? 'danger' : 'primary'} className="w-full">
        Imposta "{REQ_STATUS[status].label}"
      </Button>
    </form>
  );
}

function RequestHistory({ row }: { row: RequestRow }) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 font-medium">Email</h3>
        <EmailLog requestId={row.id} />
      </section>
      <section>
        <h3 className="mb-2 font-medium">Modifiche</h3>
        <ChangeLog table="booking_requests" rowId={row.id} />
      </section>
    </div>
  );
}
