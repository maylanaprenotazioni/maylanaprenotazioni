import { useCallback, useEffect, useState } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import { api } from '../../lib/api';
import type { AppointmentRow, NotificationRow } from '../../lib/types';
import { addDays, formatCalendarDate, formatTime, isoToRome, romeDaysRange, romeToday } from '../../lib/time';
import { Alert, Badge, Button, EmptyState, Modal, Spinner, cx } from '../../components/ui';
import { APPT_BLOCK, NOTIF_LABEL, useAdmin } from './context';
import { APPT_SELECT, AppointmentDetail, apptLabel } from './shared';

interface OverviewData {
  today_count: number;
  upcoming_count: number;
  pending_requests: number;
  pending_consultations: number;
  upcoming_consultations: number;
  cancelled_7d: number;
  failed_notifications: number;
  skipped_notifications_7d: number;
  staff: { id: string; name: string; shifts: { start: string; end: string }[]; time_off: boolean; appointments: number; booked_minutes: number; work_minutes: number }[];
}

export default function Overview() {
  const { go, sendEmails } = useAdmin();
  const today = romeToday();
  const [data, setData] = useState<OverviewData | null>(null);
  const [todayList, setTodayList] = useState<AppointmentRow[] | null>(null);
  const [upcoming, setUpcoming] = useState<AppointmentRow[]>([]);
  const [cancelled, setCancelled] = useState<AppointmentRow[]>([]);
  const [failed, setFailed] = useState<NotificationRow[]>([]);
  const [emailStatus, setEmailStatus] = useState<{ configured: boolean; problem: string | null } | null | 'unreachable'>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AppointmentRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { from, to } = romeDaysRange(today);
    const week = romeDaysRange(addDays(today, 1), 7);
    const [ov, t, up, c, f] = await Promise.all([
      supabase!.rpc('admin_overview', { p_date: today }),
      supabase!.from('appointments').select(APPT_SELECT).gte('starts_at', from).lt('starts_at', to).neq('status', 'cancelled').order('starts_at'),
      supabase!.from('appointments').select(APPT_SELECT).gte('starts_at', week.from).lt('starts_at', week.to).eq('status', 'confirmed').order('starts_at').limit(8),
      supabase!.from('appointments').select(APPT_SELECT).eq('status', 'cancelled').gte('cancelled_at', new Date(Date.now() - 7 * 86400000).toISOString()).order('cancelled_at', { ascending: false }).limit(5),
      supabase!.from('notifications').select('*').eq('status', 'failed').order('created_at', { ascending: false }).limit(5),
    ]);
    const err = ov.error || t.error || up.error || c.error || f.error;
    if (err) setError(dbMessage(err));
    setData(ov.data as OverviewData);
    setTodayList((t.data as AppointmentRow[]) ?? []);
    setUpcoming((up.data as AppointmentRow[]) ?? []);
    setCancelled((c.data as AppointmentRow[]) ?? []);
    setFailed((f.data as NotificationRow[]) ?? []);
  }, [today]);

  useEffect(() => {
    load();
    supabase!.auth.getSession().then(async ({ data: s }) => {
      try {
        const r = await api.adminStatus(s.session?.access_token ?? '');
        setEmailStatus(r.email);
      } catch {
        setEmailStatus('unreachable');
      }
    });
  }, [load]);

  const retryAll = async () => {
    for (const n of failed) await supabase!.rpc('admin_retry_notification', { p_id: n.id });
    await sendEmails(failed.map((n) => n.id));
    load();
  };

  if (!data && !error) return <Spinner />;

  return (
    <div className="space-y-6">
      <h1 className="font-display text-[28px] leading-tight first-letter:uppercase">{formatCalendarDate(today, { weekday: 'long', day: 'numeric', month: 'long' })}</h1>
      {error && <Alert>{error}</Alert>}

      {/* Errori operativi email */}
      {emailStatus === 'unreachable' && <Alert>Impossibile verificare il servizio email (funzioni server non raggiungibili).</Alert>}
      {emailStatus && emailStatus !== 'unreachable' && !emailStatus.configured && (
        <Alert>
          Servizio email non configurato: conferme, promemoria e avvisi NON vengono inviati ({emailStatus.problem}). Imposta le variabili EMAIL_* su Netlify e
          avvisa i clienti per telefono nel frattempo.
        </Alert>
      )}
      {data && data.failed_notifications > 0 && (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
          <p className="font-medium text-danger">{data.failed_notifications === 1 ? "1 email non inviata" : `${data.failed_notifications} email non inviate`}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {failed.map((n) => (
              <li key={n.id}>
                {NOTIF_LABEL[n.kind] ?? n.kind}
                {n.recipient ? ` a ${n.recipient}` : ''}: <span className="text-danger">{n.last_error}</span>
              </li>
            ))}
          </ul>
          <Button variant="secondary" className="mt-3 min-h-10" onClick={retryAll}>
            Riprova invio
          </Button>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Oggi" value={data.today_count} onClick={() => go('agenda', { date: today })} />
          <Stat label="Prossimi 7 giorni" value={data.upcoming_count} onClick={() => go('agenda', { date: addDays(today, 1) })} />
          <Stat label="Richieste in attesa" value={data.pending_requests} highlight={data.pending_requests > 0} onClick={() => go('richieste')} />
          <Stat label="Capelli For You in attesa" value={data.pending_consultations} highlight={data.pending_consultations > 0} onClick={() => go('richieste')} />
          <Stat label="Consulenze in agenda" value={data.upcoming_consultations} onClick={() => go('agenda')} />
          <Stat label="Annullati (7 giorni)" value={data.cancelled_7d} onClick={() => go('storico')} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-display text-xl">Appuntamenti di oggi</h2>
            <button onClick={() => go('agenda', { date: today })} className="text-sm text-champagne-deep underline underline-offset-4">
              Apri agenda
            </button>
          </div>
          {!todayList ? (
            <Spinner small />
          ) : todayList.length === 0 ? (
            <EmptyState>Nessun appuntamento oggi.</EmptyState>
          ) : (
            <ul className="space-y-1.5">
              {todayList.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setSelected(r)} className={cx('flex w-full gap-3 rounded-xl border-l-4 px-3 py-2.5 text-left', APPT_BLOCK[r.status])}>
                    <span className="w-12 shrink-0 font-medium tabular-nums">{formatTime(r.starts_at)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.customers?.full_name}</span>
                      <span className="block truncate text-sm opacity-80">
                        {apptLabel(r)}, {r.staff?.display_name}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-2 mt-6 font-display text-xl">Prossimi appuntamenti</h2>
          {upcoming.length === 0 ? (
            <p className="text-sm text-taupe">Nessun appuntamento nei prossimi 7 giorni.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-paper">
              {upcoming.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setSelected(r)} className="flex w-full gap-3 px-3 py-2.5 text-left text-sm">
                    <span className="w-24 shrink-0 tabular-nums text-ink-soft">
                      {formatCalendarDate(isoToRome(r.starts_at).date, { weekday: 'short', day: 'numeric' })} {formatTime(r.starts_at)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.customers?.full_name}, {r.services?.category === 'consultation' ? 'Capelli For You' : apptLabel(r)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 font-display text-xl">Operatori oggi</h2>
          {data && data.staff.length === 0 && <EmptyState>Nessun operatore attivo.</EmptyState>}
          <ul className="space-y-2">
            {data?.staff.map((s) => {
              const pct = s.work_minutes ? Math.min(100, Math.round((s.booked_minutes / s.work_minutes) * 100)) : 0;
              return (
                <li key={s.id} className="rounded-xl border border-line bg-paper p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{s.name}</span>
                    {s.time_off ? <Badge tone="muted">Assenza/chiusura</Badge> : s.shifts.length === 0 ? <Badge tone="muted">Riposo</Badge> : <Badge tone="ok">In servizio</Badge>}
                  </div>
                  {s.shifts.length > 0 && (
                    <>
                      <p className="mt-1 text-sm tabular-nums text-ink-soft">{s.shifts.map((x) => `${x.start}–${x.end}`).join(', ')}</p>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line/60" aria-hidden>
                        <div className="h-full rounded-full bg-champagne-deep" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-taupe">
                        {s.appointments} appuntamenti, occupato {pct}% dell'orario
                      </p>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <h2 className="mb-2 mt-6 font-display text-xl">Annullati di recente</h2>
          {cancelled.length === 0 ? (
            <p className="text-sm text-taupe">Nessun annullamento negli ultimi 7 giorni.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-paper text-sm">
              {cancelled.map((r) => (
                <li key={r.id} className="px-3 py-2.5">
                  <span className="text-ink-soft">
                    {formatCalendarDate(isoToRome(r.starts_at).date, { day: 'numeric', month: 'short' })} {formatTime(r.starts_at)}
                  </span>{' '}
                  {r.customers?.full_name}, {apptLabel(r)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Modal open={!!selected} onClose={() => setSelected(null)} title="Appuntamento">
        {selected && (
          <AppointmentDetail
            appt={selected}
            onChanged={() => {
              setSelected(null);
              load();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function Stat({ label, value, onClick, highlight }: { label: string; value: number; onClick: () => void; highlight?: boolean }) {
  return (
    <button onClick={onClick} className={cx('rounded-2xl border p-3 text-left', highlight ? 'border-champagne-deep bg-champagne-wash' : 'border-line bg-paper')}>
      <span className="block font-display text-3xl leading-none tabular-nums">{value}</span>
      <span className="mt-1.5 block text-xs leading-tight text-ink-soft">{label}</span>
    </button>
  );
}
