import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { AppointmentRow, Customer } from '../../lib/types';
import { formatCalendarDate, formatTime, isoToRome } from '../../lib/time';
import { Alert, Badge, Button, EmptyState, Input, Modal, Spinner, cx } from '../../components/ui';
import { APPT_STATUS, REQ_STATUS, useAdmin } from './context';
import { APPT_SELECT, AppointmentDetail, ChangeLog, ContactLinks, NewAppointment, apptLabel } from './shared';

interface CustomerListRow {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  created_at: string;
  past_count: number;
  upcoming_count: number;
  last_visit: string | null;
  next_visit: string | null;
}

export default function Customers() {
  const { focusCustomerId } = useAdmin();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CustomerListRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(focusCustomerId);

  const search = useCallback(async (text: string) => {
    const { data, error } = await supabase!.rpc('admin_customers', { p_query: text || null, p_limit: 100 });
    if (error) setErr(dbMessage(error));
    setRows((data as CustomerListRow[]) ?? []);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q, search]);

  useEffect(() => {
    if (focusCustomerId) setOpenId(focusCustomerId);
  }, [focusCustomerId]);

  return (
    <div>
      <div className="mb-4">
        <Input label="Cerca cliente" type="search" placeholder="Nome, cognome, telefono o email" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err && <Alert>{err}</Alert>}
      {!rows && <Spinner />}
      {rows && rows.length === 0 && <EmptyState>{q ? 'Nessun cliente trovato.' : 'Nessun cliente registrato.'}</EmptyState>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
          {rows.map((c) => (
            <li key={c.id}>
              <button onClick={() => setOpenId(c.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-champagne-wash/40">
                <span className="min-w-40 flex-1">
                  <span className="block font-medium">
                    {c.last_name} {c.first_name}
                  </span>
                  <span className="block text-sm text-ink-soft">{c.phone}</span>
                </span>
                <span className="text-xs text-taupe">
                  {c.next_visit
                    ? `Prossimo: ${formatCalendarDate(isoToRome(c.next_visit).date, { day: 'numeric', month: 'short' })}`
                    : c.last_visit
                      ? `Ultimo: ${formatCalendarDate(isoToRome(c.last_visit).date, { day: 'numeric', month: 'short', year: 'numeric' })}`
                      : 'Nessuna visita'}
                </span>
                <Badge>{c.past_count} {Number(c.past_count) === 1 ? "visita" : "visite"}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="Scheda cliente">
        {openId && (
          <CustomerCard
            id={openId}
            onChanged={() => search(q.trim())}
          />
        )}
      </Modal>
    </div>
  );
}

interface ReqLite {
  id: string;
  code: string;
  status: string;
  created_at: string;
  services: { name: string } | null;
}

function CustomerCard({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { toast } = useAdmin();
  const [c, setC] = useState<Customer | null>(null);
  const [appts, setAppts] = useState<AppointmentRow[]>([]);
  const [reqs, setReqs] = useState<ReqLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [view, setView] = useState<'card' | 'new' | 'appt' | 'log'>('card');
  const [appt, setAppt] = useState<AppointmentRow | null>(null);

  const load = useCallback(async () => {
    const [cu, ap, rq] = await Promise.all([
      supabase!.from('customers').select('*').eq('id', id).single(),
      supabase!.from('appointments').select(APPT_SELECT).eq('customer_id', id).order('starts_at', { ascending: false }).limit(200),
      supabase!.from('booking_requests').select('id, code, status, created_at, services(name)').eq('customer_id', id).order('created_at', { ascending: false }).limit(50),
    ]);
    const e = cu.error || ap.error || rq.error;
    if (e) setErr(dbMessage(e));
    setC(cu.data as Customer);
    setAppts((ap.data as AppointmentRow[]) ?? []);
    setReqs((rq.data as unknown as ReqLite[]) ?? []);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!c) return err ? <Alert>{err}</Alert> : <Spinner />;

  if (view === 'new')
    return (
      <NewAppointment
        initial={{ firstName: c.first_name, lastName: c.last_name, phone: c.phone, email: c.email ?? '' }}
        onDone={() => {
          setView('card');
          load();
          onChanged();
        }}
      />
    );
  if (view === 'appt' && appt)
    return (
      <div>
        <button onClick={() => setView('card')} className="mb-4 text-sm text-champagne-deep">
          ‹ Torna alla scheda
        </button>
        <AppointmentDetail
          appt={appt}
          onChanged={() => {
            setView('card');
            load();
          }}
        />
      </div>
    );
  if (view === 'log')
    return (
      <div>
        <button onClick={() => setView('card')} className="mb-4 text-sm text-champagne-deep">
          ‹ Torna alla scheda
        </button>
        <ChangeLog table="customers" rowId={c.id} />
      </div>
    );

  const now = Date.now();
  const future = appts.filter((a) => new Date(a.starts_at).getTime() >= now && a.status === 'confirmed').reverse();
  const past = appts.filter((a) => !(new Date(a.starts_at).getTime() >= now && a.status === 'confirmed'));

  return (
    <div className="space-y-6">
      {edit ? (
        <EditCustomer
          c={c}
          onDone={(changed) => {
            setEdit(false);
            if (changed) {
              toast('Scheda aggiornata.');
              load();
              onChanged();
            }
          }}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-display text-2xl">
                {c.first_name} {c.last_name}
              </p>
              <p className="text-ink-soft">{c.phone}</p>
              {c.email && <p className="text-sm text-ink-soft">{c.email}</p>}
            </div>
            <button onClick={() => setEdit(true)} className="text-sm text-champagne-deep underline underline-offset-4">
              Modifica
            </button>
          </div>
          <ContactLinks phone={c.phone} email={c.email} firstName={c.first_name} />
          <p className="text-xs text-taupe">
            Consenso comunicazioni promozionali:{' '}
            {c.marketing_consent && c.marketing_consent_at
              ? `sì, dal ${formatCalendarDate(isoToRome(c.marketing_consent_at).date, { day: 'numeric', month: 'long', year: 'numeric' })}`
              : 'no'}
          </p>
          <Button onClick={() => setView('new')} className="w-full">
            Nuovo appuntamento per questo cliente
          </Button>
        </div>
      )}

      <section>
        <h3 className="mb-2 font-medium">Appuntamenti futuri ({future.length})</h3>
        {future.length === 0 ? <p className="text-sm text-taupe">Nessuno.</p> : <ApptMini list={future} onOpen={(a) => { setAppt(a); setView('appt'); }} />}
      </section>
      <section>
        <h3 className="mb-2 font-medium">Appuntamenti precedenti ({past.length})</h3>
        {past.length === 0 ? <p className="text-sm text-taupe">Nessuno.</p> : <ApptMini list={past} onOpen={(a) => { setAppt(a); setView('appt'); }} />}
      </section>
      {reqs.length > 0 && (
        <section>
          <h3 className="mb-2 font-medium">Richieste</h3>
          <ul className="space-y-1 text-sm">
            {reqs.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <Badge tone={REQ_STATUS[r.status].tone}>{REQ_STATUS[r.status].label}</Badge>
                <span>{r.services?.name}</span>
                <span className="ml-auto text-xs text-taupe">{formatCalendarDate(isoToRome(r.created_at).date, { day: 'numeric', month: 'short' })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <button onClick={() => setView('log')} className="text-sm text-taupe underline underline-offset-4">
        Storico modifiche della scheda
      </button>
      <p className="text-xs text-taupe">La scheda contiene solo dati di contatto e appuntamenti: non registrare informazioni sanitarie.</p>
    </div>
  );
}

function ApptMini({ list, onOpen }: { list: AppointmentRow[]; onOpen: (a: AppointmentRow) => void }) {
  const { go } = useAdmin();
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-paper text-sm">
      {list.map((a) => (
        <li key={a.id} className="flex items-center gap-2 px-3 py-2.5">
          <button onClick={() => onOpen(a)} className="min-w-0 flex-1 text-left">
            <span className="block tabular-nums">
              {formatCalendarDate(isoToRome(a.starts_at).date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, {formatTime(a.starts_at)}
            </span>
            <span className="block truncate text-ink-soft">
              {apptLabel(a)}, {a.staff?.display_name}
            </span>
          </button>
          <Badge tone={APPT_STATUS[a.status].tone}>{APPT_STATUS[a.status].label}</Badge>
          <button onClick={() => go('agenda', { date: isoToRome(a.starts_at).date })} className={cx('shrink-0 text-xs text-champagne-deep underline underline-offset-2')}>
            Agenda
          </button>
        </li>
      ))}
    </ul>
  );
}

function EditCustomer({ c, onDone }: { c: Customer; onDone: (changed: boolean) => void }) {
  const [first, setFirst] = useState(c.first_name);
  const [last, setLast] = useState(c.last_name);
  const [phone, setPhone] = useState(c.phone);
  const [email, setEmail] = useState(c.email ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const norm = phone.replace(/[^0-9+]/g, '');
    if (!/^\+?[0-9]{6,20}$/.test(norm)) return setErr('Numero di telefono non valido.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setErr('Email non valida.');
    setBusy(true);
    const { error } = await supabase!
      .from('customers')
      .update({
        first_name: first.trim(),
        last_name: last.trim(),
        phone: phone.trim(),
        phone_normalized: norm,
        email: email.trim() || null,
        email_normalized: email.trim().toLowerCase(),
      })
      .eq('id', c.id);
    setBusy(false);
    if (error) return setErr(error.code === '23505' ? 'Esiste già una scheda con lo stesso telefono ed email.' : dbMessage(error));
    onDone(true);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input label="Nome" value={first} onChange={(e) => setFirst(e.target.value)} required maxLength={60} />
        <Input label="Cognome" value={last} onChange={(e) => setLast(e.target.value)} maxLength={60} />
      </div>
      <Input label="Telefono" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
      <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      {err && <Alert>{err}</Alert>}
      <div className="grid grid-cols-2 gap-2">
        <Button type="submit" busy={busy}>
          Salva
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone(false)}>
          Annulla
        </Button>
      </div>
    </form>
  );
}
