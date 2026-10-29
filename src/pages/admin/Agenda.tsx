import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { AppointmentRow, RequestRow, TimeOff, WorkingHour } from '../../lib/types';
import { addDays, formatCalendarDate, formatTime, isoToRome, isoWeekday, romeDaysRange, romeToday, startOfWeek } from '../../lib/time';
import { Alert, Badge, Button, EmptyState, Modal, Spinner, cx } from '../../components/ui';
import type { PublicGroup } from '../../lib/types';
import { GROUPS } from '../../lib/bundle';
import { APPT_BLOCK, APPT_STATUS, useAdmin } from './context';
import { APPT_SELECT, AppointmentDetail, NewAppointment, apptGroups, apptLabel } from './shared';
import { ConfirmForm, REQUEST_SELECT, requestLabel } from './Requests';

type View = 'day' | 'week' | 'month';
const PX_PER_MIN = 1.3;

function startOfMonthGrid(date: string): string {
  return startOfWeek(date.slice(0, 8) + '01');
}

export default function Agenda() {
  const { staff, agendaDate, services } = useAdmin();
  const [groupFilter, setGroupFilter] = useState<PublicGroup | ''>('');
  const [view, setView] = useState<View>('day');
  const [date, setDate] = useState(agendaDate ?? romeToday());
  const [staffFilter, setStaffFilter] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [rows, setRows] = useState<AppointmentRow[] | null>(null);
  const [offs, setOffs] = useState<TimeOff[]>([]);
  const [hours, setHours] = useState<WorkingHour[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AppointmentRow | null>(null);
  const [creating, setCreating] = useState<{ date?: string; time?: string; staffId?: string; serviceIds?: string[] } | null>(null);
  const [confirming, setConfirming] = useState<{ row: RequestRow; staffId?: string; date?: string; time?: string } | null>(null);
  const [gapKey, setGapKey] = useState(0);

  useEffect(() => {
    if (agendaDate) setDate(agendaDate);
  }, [agendaDate]);

  const start = view === 'day' ? date : view === 'week' ? startOfWeek(date) : startOfMonthGrid(date);
  const days = view === 'day' ? 1 : view === 'week' ? 7 : 42;

  const load = useCallback(async () => {
    setError(null);
    const { from, to } = romeDaysRange(start, days);
    let q = supabase!.from('appointments').select(APPT_SELECT).gte('starts_at', from).lt('starts_at', to).order('starts_at');
    if (staffFilter) q = q.eq('staff_id', staffFilter);
    if (!showCancelled) q = q.neq('status', 'cancelled');
    const [a, t, w, r] = await Promise.all([
      q,
      supabase!.from('time_off').select('*').lt('starts_at', to).gt('ends_at', from),
      supabase!.from('working_hours').select('*'),
      supabase!
        .from('booking_requests')
        .select(REQUEST_SELECT)
        .in('status', ['pending', 'reschedule'])
        .or(`preferred_date.is.null,and(preferred_date.gte.${start},preferred_date.lte.${addDays(start, days - 1)})`)
        .order('created_at'),
    ]);
    const err = a.error || t.error || w.error || r.error;
    if (err) setError(dbMessage(err));
    setRows((a.data as AppointmentRow[]) ?? []);
    setGapKey((k) => k + 1);
    setOffs((t.data as TimeOff[]) ?? []);
    setHours((w.data as WorkingHour[]) ?? []);
    setRequests((r.data as RequestRow[]) ?? []);
  }, [start, days, staffFilter, showCancelled]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, AppointmentRow[]>();
    for (let i = 0; i < days; i++) m.set(addDays(start, i), []);
    for (const r of rows ?? []) {
      if (groupFilter && !apptGroups(r, services).has(groupFilter)) continue;
      m.get(isoToRome(r.starts_at).date)?.push(r);
    }
    return m;
  }, [rows, start, days, groupFilter, services]);

  const step = view === 'day' ? 1 : view === 'week' ? 7 : 0;
  const move = (dir: number) => {
    if (view === 'month') {
      const [y, m] = date.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + dir, 1));
      setDate(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`);
    } else setDate(addDays(date, dir * step));
  };

  const today = romeToday();
  const title =
    view === 'month'
      ? formatCalendarDate(date, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${formatCalendarDate(start, { day: 'numeric', month: 'short' })} – ${formatCalendarDate(addDays(start, 6), { day: 'numeric', month: 'short' })}`
        : formatCalendarDate(date, { weekday: 'long', day: 'numeric', month: 'long' });

  const visibleStaff = staff.filter((s) => s.active && (!staffFilter || s.id === staffFilter));
  const dayRequests = (d: string) => requests.filter((r) => r.preferred_date === d);
  const undated = requests.filter((r) => !r.preferred_date);

  return (
    <div>
      {/* Barra comandi */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-line bg-paper p-0.5" role="tablist" aria-label="Vista">
          {(['day', 'week', 'month'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cx('min-h-9 rounded-full px-3 text-sm min-[375px]:px-3.5', view === v ? 'bg-ink text-ivory' : 'text-ink-soft')}>
              {v === 'day' ? 'Giorno' : v === 'week' ? 'Settimana' : 'Mese'}
            </button>
          ))}
        </div>
        <Button className="ml-auto min-h-10 px-4" onClick={() => setCreating({ date })} aria-label="Nuovo appuntamento">
          + Nuovo
        </Button>
      </div>
      <div className="mb-3 flex items-center gap-1">
        <button onClick={() => move(-1)} className="min-h-11 min-w-11 rounded-full text-xl hover:bg-champagne-wash" aria-label="Precedente">
          ‹
        </button>
        {/* Il titolo apre il selettore data nativo */}
        <label className="relative min-w-0 flex-1 cursor-pointer text-center">
          <span className="block truncate font-display text-xl first-letter:uppercase">{title}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Vai alla data"
          />
        </label>
        <button onClick={() => move(1)} className="min-h-11 min-w-11 rounded-full text-xl hover:bg-champagne-wash" aria-label="Successivo">
          ›
        </button>
        <button onClick={() => setDate(today)} className="min-h-11 rounded-full border border-line bg-paper px-3 text-sm" disabled={date === today}>
          Oggi
        </button>
      </div>
      <div className="mb-4 flex items-center gap-2">
        <select value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)} className="min-h-10 min-w-0 flex-1 rounded-full border border-line bg-paper px-3 text-sm sm:flex-none" aria-label="Filtra operatore">
          <option value="">Tutti gli operatori</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name}
            </option>
          ))}
        </select>
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value as PublicGroup | '')} className="min-h-10 min-w-0 flex-1 rounded-full border border-line bg-paper px-3 text-sm sm:flex-none" aria-label="Filtra categoria">
          <option value="">Tutte le categorie</option>
          {GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.key === 'consulenze' ? 'Capelli For You' : g.label}
            </option>
          ))}
        </select>
      </div>
      <div className="-mt-2 mb-4 flex items-center gap-2">
        <label className="flex min-h-10 shrink-0 items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} className="accent-ink" />
          Annullati
        </label>
        <details className="relative shrink-0 sm:hidden">
          <summary className="min-h-10 cursor-pointer list-none rounded-full px-2 py-2 text-sm text-champagne-deep">Legenda</summary>
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-line bg-paper p-3 shadow-lg">
            <Legend />
          </div>
        </details>
        <div className="hidden sm:block">
          <Legend />
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      {/* Richieste da gestire nel periodo */}
      {requests.length > 0 && (
        <div className="mb-4 rounded-2xl border border-dashed border-champagne-deep/60 bg-champagne-wash/30 p-3">
          <p className="mb-2 text-sm font-medium">Richieste da confermare {view !== 'month' ? 'per questo periodo' : 'per questo mese'}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[...requests.filter((r) => r.preferred_date), ...undated].map((r) => (
              <button key={r.id} onClick={() => setConfirming({ row: r })} className="shrink-0 rounded-xl border border-dashed border-champagne-deep bg-paper px-3 py-2 text-left text-sm">
                <span className="block font-medium">{r.customers?.full_name}</span>
                <span className="block text-xs text-taupe">
                  {r.services?.category === 'consultation' ? 'Capelli For You' : requestLabel(r)},{' '}
                  {r.preferred_date ? formatCalendarDate(r.preferred_date, { weekday: 'short', day: 'numeric' }) : 'qualsiasi giorno'} ({r.preferred_time_window})
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!rows && !error && (
        <div className="flex justify-center py-10 text-taupe">
          <Spinner />
        </div>
      )}

      {rows && view === 'day' && (
        <DayGrid
          date={date}
          staff={visibleStaff}
          rows={byDay.get(date) ?? []}
          offs={offs}
          hours={hours}
          onSelect={setSelected}
          onEmpty={(staffId, time) => setCreating({ date, time, staffId })}
        />
      )}
      {rows && view === 'day' && (
        <GapSuggestions
          date={date}
          refreshKey={gapKey}
          onService={(staffId, time, serviceId) => setCreating({ date, time, staffId, serviceIds: [serviceId] })}
          onRequest={(row, staffId, time) => setConfirming({ row, staffId, date, time })}
        />
      )}

      {rows && view === 'week' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[...byDay.entries()].map(([d, list]) => (
            <section key={d}>
              <button onClick={() => { setDate(d); setView('day'); }} className={cx('mb-2 font-display text-xl first-letter:uppercase hover:underline', d === today && 'text-champagne-deep')}>
                {formatCalendarDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}
              </button>
              <DayOffs date={d} offs={offs} staffFilter={staffFilter} />
              {list.length === 0 ? <p className="text-sm text-taupe">Nessun appuntamento.</p> : <ApptList list={list} onSelect={setSelected} />}
              {dayRequests(d).length > 0 && <p className="mt-1 text-xs text-champagne-deep">{dayRequests(d).length} richiesta/e da confermare per questo giorno</p>}
            </section>
          ))}
        </div>
      )}

      {rows && view === 'month' && (
        <MonthGrid
          start={start}
          month={date.slice(0, 7)}
          byDay={byDay}
          offs={offs}
          requests={requests}
          onPick={(d) => {
            setDate(d);
            setView('day');
          }}
        />
      )}

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
      <Modal open={!!creating} onClose={() => setCreating(null)} title="Nuovo appuntamento">
        {creating && (
          <NewAppointment
            initial={creating}
            onDone={() => {
              setCreating(null);
              load();
            }}
          />
        )}
      </Modal>
      <Modal open={!!confirming} onClose={() => setConfirming(null)} title="Conferma richiesta">
        {confirming && (
          <ConfirmForm
            row={confirming.row}
            initial={{ staffId: confirming.staffId, date: confirming.date, time: confirming.time }}
            onDone={() => {
              setConfirming(null);
              load();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Legenda colori">
      {(['confirmed', 'completed', 'no_show', 'cancelled'] as const).map((s) => (
        <span key={s} className={cx('rounded-md border-l-4 px-2 py-0.5', APPT_BLOCK[s])}>
          {APPT_STATUS[s].label}
        </span>
      ))}
      <span className="rounded-md border border-dashed border-champagne-deep px-2 py-0.5 text-ink-soft">Richiesta</span>
    </div>
  );
}

function DayOffs({ date, offs, staffFilter }: { date: string; offs: TimeOff[]; staffFilter: string }) {
  const { staff } = useAdmin();
  const { from, to } = romeDaysRange(date);
  const list = offs.filter((o) => o.starts_at < to && o.ends_at > from && (!staffFilter || !o.staff_id || o.staff_id === staffFilter));
  return (
    <>
      {list.map((o) => (
        <p key={o.id} className="mb-2 rounded-lg bg-line/40 px-3 py-2 text-sm text-ink-soft">
          {o.kind[0].toUpperCase() + o.kind.slice(1)}: {o.staff_id ? staff.find((s) => s.id === o.staff_id)?.display_name : 'tutto il salone'}
          {o.reason ? ` (${o.reason})` : ''}
        </p>
      ))}
    </>
  );
}

function ApptList({ list, onSelect }: { list: AppointmentRow[]; onSelect: (r: AppointmentRow) => void }) {
  return (
    <ul className="space-y-1.5">
      {list.map((r) => (
        <li key={r.id}>
          <button onClick={() => onSelect(r)} className={cx('flex w-full gap-3 rounded-xl border-l-4 px-3 py-2.5 text-left', APPT_BLOCK[r.status])}>
            <span className="w-12 shrink-0 tabular-nums">
              <span className="block font-medium">{formatTime(r.starts_at)}</span>
              <span className="block text-xs opacity-70">{formatTime(r.ends_at)}</span>
            </span>
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
  );
}

/** Vista giorno: colonne per operatore con blocchi proporzionali alla durata. Scorre in orizzontale su smartphone. */
function DayGrid({
  date,
  staff,
  rows,
  offs,
  hours,
  onSelect,
  onEmpty,
}: {
  date: string;
  staff: { id: string; display_name: string }[];
  rows: AppointmentRow[];
  offs: TimeOff[];
  hours: WorkingHour[];
  onSelect: (r: AppointmentRow) => void;
  onEmpty: (staffId: string, time: string) => void;
}) {
  const wd = isoWeekday(date);
  const dayHours = hours.filter((h) => h.weekday === wd);
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const apptMin = rows.flatMap((r) => [toMin(isoToRome(r.starts_at).time), toMin(isoToRome(r.ends_at).time) || 24 * 60]);
  const startMin = Math.floor(Math.min(8 * 60, ...dayHours.map((h) => toMin(h.start_time)), ...apptMin) / 60) * 60;
  const endMin = Math.ceil(Math.max(19 * 60, ...dayHours.map((h) => toMin(h.end_time)), ...apptMin) / 60) * 60;
  const height = (endMin - startMin) * PX_PER_MIN;
  const { from, to } = romeDaysRange(date);

  if (!staff.length) return <EmptyState>Nessun operatore attivo. Aggiungili in Operatori.</EmptyState>;

  const minutesOf = (iso: string) => {
    const d = isoToRome(iso);
    if (d.date < date) return startMin;
    if (d.date > date) return endMin;
    return toMin(d.time);
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-paper">
      <div className="flex min-w-max">
        {/* colonna orari */}
        <div className="sticky left-0 z-10 w-12 shrink-0 border-r border-line bg-paper">
          <div className="h-10 border-b border-line" />
          <div className="relative" style={{ height }}>
            {Array.from({ length: (endMin - startMin) / 60 + 1 }, (_, i) => (
              <span key={i} className="absolute right-1.5 -translate-y-1/2 text-[11px] tabular-nums text-taupe" style={{ top: i * 60 * PX_PER_MIN }}>
                {String(startMin / 60 + i).padStart(2, '0')}:00
              </span>
            ))}
          </div>
        </div>
        {staff.map((s) => {
          const shifts = dayHours.filter((h) => h.staff_id === s.id);
          const list = rows.filter((r) => r.staff_id === s.id);
          const sOffs = offs.filter((o) => (!o.staff_id || o.staff_id === s.id) && o.starts_at < to && o.ends_at > from);
          return (
            <div key={s.id} className="w-40 shrink-0 border-r border-line last:border-r-0 sm:w-48">
              <div className="flex h-10 items-center justify-center border-b border-line px-2 text-sm font-medium">
                <span className="truncate">{s.display_name}</span>
              </div>
              <div
                className="relative cursor-copy bg-line/25"
                style={{ height }}
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const y = e.nativeEvent.offsetY;
                  const m = Math.floor((startMin + y / PX_PER_MIN) / 15) * 15;
                  onEmpty(s.id, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
                }}
              >
                {/* righe ore */}
                {Array.from({ length: (endMin - startMin) / 60 }, (_, i) => (
                  <div key={i} className="pointer-events-none absolute inset-x-0 border-t border-line/70" style={{ top: i * 60 * PX_PER_MIN }} />
                ))}
                {/* fasce di lavoro (sfondo chiaro) */}
                {shifts.map((h) => (
                  <div
                    key={h.id}
                    className="pointer-events-none absolute inset-x-0 bg-paper"
                    style={{ top: (toMin(h.start_time) - startMin) * PX_PER_MIN, height: (toMin(h.end_time) - toMin(h.start_time)) * PX_PER_MIN }}
                  />
                ))}
                {/* assenze */}
                {sOffs.map((o) => {
                  const a = minutesOf(o.starts_at);
                  const b = minutesOf(o.ends_at);
                  return (
                    <div
                      key={o.id}
                      className="pointer-events-none absolute inset-x-0 bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgba(138,123,106,0.18)_6px,rgba(138,123,106,0.18)_12px)]"
                      style={{ top: (a - startMin) * PX_PER_MIN, height: Math.max(0, b - a) * PX_PER_MIN }}
                    >
                      <span className="m-1 inline-block rounded bg-paper/90 px-1.5 text-[11px] text-taupe">{o.kind}</span>
                    </div>
                  );
                })}
                {list.map((r) => {
                  const a = minutesOf(r.starts_at);
                  const b = minutesOf(r.ends_at);
                  const h = Math.max(22, (b - a) * PX_PER_MIN - 2);
                  return (
                    <button
                      key={r.id}
                      onClick={() => onSelect(r)}
                      className={cx('absolute inset-x-1 overflow-hidden rounded-lg border-l-4 px-2 py-1 text-left text-xs shadow-sm', APPT_BLOCK[r.status])}
                      style={{ top: (a - startMin) * PX_PER_MIN + 1, height: h }}
                      aria-label={`${formatTime(r.starts_at)} ${r.customers?.full_name}, ${apptLabel(r)}, ${APPT_STATUS[r.status].label}`}
                    >
                      <span className="block font-medium tabular-nums">
                        {formatTime(r.starts_at)} {r.customers?.full_name}
                      </span>
                      {h > 34 && <span className="block truncate opacity-80">{r.services?.category === 'consultation' ? 'Capelli For You' : apptLabel(r)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-line px-3 py-2 text-xs text-taupe">Tocca uno spazio vuoto per inserire un appuntamento a quell'ora.</p>
    </div>
  );
}

function MonthGrid({
  start,
  month,
  byDay,
  offs,
  requests,
  onPick,
}: {
  start: string;
  month: string;
  byDay: Map<string, AppointmentRow[]>;
  offs: TimeOff[];
  requests: RequestRow[];
  onPick: (d: string) => void;
}) {
  const today = romeToday();
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const closed = (d: string) => {
    const { from, to } = romeDaysRange(d);
    return offs.some((o) => !o.staff_id && o.starts_at <= from && o.ends_at >= to);
  };
  return (
    <div>
      <div className="mb-1 grid grid-cols-7 text-center text-xs text-taupe">
        {['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const active = list.filter((r) => r.status !== 'cancelled');
          const counts = {
            confirmed: active.filter((r) => r.status === 'confirmed').length,
            done: active.filter((r) => r.status === 'completed').length,
            noshow: active.filter((r) => r.status === 'no_show').length,
          };
          const req = requests.filter((r) => r.preferred_date === d).length;
          const inMonth = d.startsWith(month);
          return (
            <button
              key={d}
              onClick={() => onPick(d)}
              className={cx(
                'flex min-h-16 flex-col items-start rounded-xl border p-1.5 text-left sm:min-h-24 sm:p-2',
                inMonth ? 'border-line bg-paper' : 'border-transparent bg-transparent opacity-50',
                d === today && 'border-ink',
                closed(d) && 'bg-line/40',
              )}
              aria-label={`${formatCalendarDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${active.length} appuntamenti${req ? `, ${req} richieste` : ''}`}
            >
              <span className={cx('text-sm tabular-nums', d === today && 'font-semibold')}>{Number(d.slice(8))}</span>
              {active.length > 0 && <span className="mt-auto font-display text-lg leading-none sm:text-2xl">{active.length}</span>}
              <span className="mt-0.5 flex flex-wrap gap-0.5">
                {counts.confirmed > 0 && <span className="size-2 rounded-full bg-champagne-deep" />}
                {counts.done > 0 && <span className="size-2 rounded-full bg-ok" />}
                {counts.noshow > 0 && <span className="size-2 rounded-full bg-danger" />}
                {req > 0 && <span className="size-2 rounded-full border border-dashed border-champagne-deep" />}
              </span>
              {closed(d) && <span className="text-[10px] text-taupe">chiuso</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-taupe">Il numero indica gli appuntamenti attivi del giorno. Tocca un giorno per aprirlo.</p>
      {requests.length > 0 && <Badge tone="gold">{requests.length} richieste da confermare</Badge>}
    </div>
  );
}

interface Gap {
  staff_id: string;
  staff_name: string;
  gap_start: string;
  gap_end: string;
  minutes: number;
  services: { id: string; name: string; block: number; waste: number }[];
  requests: { id: string; code: string; customer_name: string; label: string; block: number }[];
}

/**
 * Spazi liberi del giorno e cosa potrebbe riempirli. Solo suggerimenti:
 * nulla viene spostato o confermato senza un'azione esplicita.
 */
function GapSuggestions({
  date,
  refreshKey,
  onService,
  onRequest,
}: {
  date: string;
  refreshKey: number;
  onService: (staffId: string, time: string, serviceId: string) => void;
  onRequest: (row: RequestRow, staffId: string, time: string) => void;
}) {
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase!.rpc('admin_gap_suggestions', { p_date: date }).then(({ data, error }) => {
      if (!alive) return;
      if (error) setErr(dbMessage(error));
      setGaps((data as Gap[]) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [date, refreshKey]);

  const openRequest = async (staffId: string, time: string, id: string) => {
    const { data } = await supabase!.from('booking_requests').select(REQUEST_SELECT).eq('id', id).single();
    if (data) onRequest(data as RequestRow, staffId, time);
  };

  if (err) return <Alert>{err}</Alert>;
  if (!gaps) return null;
  const useful = gaps.filter((g) => g.services.length || g.requests.length);
  return (
    <section className="mt-5 rounded-2xl border border-line bg-paper p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left" aria-expanded={open}>
        <span>
          <span className="block font-medium">Spazi liberi da riempire</span>
          <span className="block text-sm text-taupe">
            {gaps.length === 0 ? 'Nessuno spazio libero rilevante.' : `${gaps.length} spazi liberi, ${useful.length} con suggerimenti`}
          </span>
        </span>
        <span aria-hidden className="text-taupe">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <ul className="mt-3 space-y-3">
          {gaps.map((g, i) => {
            const t = formatTime(g.gap_start);
            return (
              <li key={i} className="rounded-xl border border-line p-3">
                <p className="text-sm">
                  <span className="font-medium">{g.staff_name}</span>, {t}–{formatTime(g.gap_end)} <span className="text-taupe">({g.minutes}')</span>
                </p>
                {g.requests.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-taupe">Richieste in attesa che entrano qui</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {g.requests.map((r) => (
                        <button key={r.id} onClick={() => openRequest(g.staff_id, t, r.id)} className="min-h-9 rounded-full border border-dashed border-champagne-deep px-3 text-sm">
                          {r.customer_name}: {r.label} ({r.block}')
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {g.services.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-taupe">Servizi che riempiono lo spazio (inserimento manuale)</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {g.services.map((sv) => (
                        <button key={sv.id} onClick={() => onService(g.staff_id, t, sv.id)} className={cx('min-h-9 rounded-full border px-3 text-sm', sv.waste === 0 ? 'border-champagne-deep bg-champagne-wash' : 'border-line')}>
                          {sv.name} ({sv.block}'){sv.waste === 0 ? ', esatto' : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
