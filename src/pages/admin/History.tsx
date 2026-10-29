import { useCallback, useEffect, useState } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { AppointmentRow } from '../../lib/types';
import { addDays, formatCalendarDate, formatTime, isoToRome, romeDaysRange, romeToday } from '../../lib/time';
import { Alert, Badge, Button, EmptyState, Input, Modal, Spinner } from '../../components/ui';
import { APPT_STATUS, useAdmin } from './context';
import { APPT_SELECT, AppointmentDetail, apptGroups, apptLabel } from './shared';
import { GROUPS } from '../../lib/bundle';
import type { PublicGroup } from '../../lib/types';

const PAGE = 50;

/** Storico appuntamenti: filtri per periodo, operatore, stato e ricerca testuale. */
export default function History() {
  const { staff, services } = useAdmin();
  const [group, setGroup] = useState<PublicGroup | ''>('');
  const today = romeToday();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [staffId, setStaffId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AppointmentRow[] | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<AppointmentRow | null>(null);

  const load = useCallback(
    async (p: number) => {
      setErr(null);
      const range = { from: romeDaysRange(from).from, to: romeDaysRange(to).to };
      let ids: string[] | null = null;
      if (q.trim().length >= 2) {
        const { data, error } = await supabase!.rpc('admin_search_appointments', { p_query: q.trim() });
        if (error) return setErr(dbMessage(error));
        ids = ((data as { id: string }[]) ?? []).map((x) => x.id);
        if (!ids.length) {
          setRows([]);
          setHasMore(false);
          return;
        }
      }
      let query = supabase!
        .from('appointments')
        .select(APPT_SELECT)
        .gte('starts_at', range.from)
        .lt('starts_at', range.to)
        .order('starts_at', { ascending: false })
        .range(p * PAGE, p * PAGE + PAGE);
      if (staffId) query = query.eq('staff_id', staffId);
      if (status) query = query.eq('status', status);
      if (ids) query = query.in('id', ids);
      const { data, error } = await query;
      if (error) return setErr(dbMessage(error));
      const list = (data as AppointmentRow[]) ?? [];
      setHasMore(list.length > PAGE);
      setRows((prev) => (p === 0 ? list.slice(0, PAGE) : [...(prev ?? []), ...list.slice(0, PAGE)]));
    },
    [from, to, staffId, status, q],
  );

  useEffect(() => {
    setPage(0);
    setRows(null);
    const t = setTimeout(() => load(0), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Input label="Cerca" type="search" placeholder="Nome, telefono, email, codice" value={q} onChange={(e) => setQ(e.target.value)} />
        <Input label="Dal" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <Input label="Al" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-soft">
          Operatore
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="min-h-12 rounded-xl border border-line bg-paper px-3 text-ink">
            <option value="">Tutti</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-soft">
          Categoria
          <select value={group} onChange={(e) => setGroup(e.target.value as PublicGroup | '')} className="min-h-12 rounded-xl border border-line bg-paper px-3 text-ink">
            <option value="">Tutte</option>
            {GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.key === 'consulenze' ? 'Capelli For You' : g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-soft">
          Stato
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="min-h-12 rounded-xl border border-line bg-paper px-3 text-ink">
            <option value="">Tutti</option>
            {Object.entries(APPT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {err && <Alert>{err}</Alert>}
      {!rows && !err && <Spinner />}
      {rows && rows.length === 0 && <EmptyState>Nessun appuntamento con questi filtri.</EmptyState>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
          {rows.filter((a) => !group || apptGroups(a, services).has(group)).map((a) => (
            <li key={a.id}>
              <button onClick={() => setOpen(a)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-champagne-wash/40">
                <span className="w-32 text-sm tabular-nums">
                  {formatCalendarDate(isoToRome(a.starts_at).date, { day: '2-digit', month: '2-digit', year: '2-digit' })} {formatTime(a.starts_at)}
                </span>
                <span className="min-w-40 flex-1">
                  <span className="block font-medium">{a.customers?.full_name}</span>
                  <span className="block text-sm text-taupe">
                    {apptLabel(a)}, {a.staff?.display_name}
                  </span>
                </span>
                <span className="text-xs text-taupe">{a.code}</span>
                <Badge tone={APPT_STATUS[a.status].tone}>{APPT_STATUS[a.status].label}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <Button
          variant="secondary"
          className="mt-4 w-full"
          onClick={() => {
            const n = page + 1;
            setPage(n);
            load(n);
          }}
        >
          Carica altri
        </Button>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title="Appuntamento">
        {open && (
          <AppointmentDetail
            appt={open}
            onChanged={() => {
              setOpen(null);
              load(0);
            }}
          />
        )}
      </Modal>
    </div>
  );
}
