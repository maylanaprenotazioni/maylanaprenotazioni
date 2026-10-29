import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { TimeOff } from '../../lib/types';
import { addDays, formatCalendarDate, formatTime, isoToRome, romeLocalToIso, romeToday } from '../../lib/time';
import { Alert, Button, EmptyState, Input, Select, Spinner } from '../../components/ui';
import { useAdmin } from './context';

const KINDS: TimeOff['kind'][] = ['chiusura', 'ferie', 'pausa', 'permesso', 'altro'];

function describe(o: TimeOff): string {
  const a = isoToRome(o.starts_at);
  const b = isoToRome(o.ends_at);
  const fullDays = a.time === '00:00' && b.time === '00:00';
  if (fullDays) {
    const lastDay = addDays(b.date, -1);
    const f = (d: string) => formatCalendarDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
    return lastDay === a.date ? `${f(a.date)}, tutto il giorno` : `dal ${f(a.date)} al ${f(lastDay)} compreso`;
  }
  const f = (d: string) => formatCalendarDate(d, { day: 'numeric', month: 'short' });
  return a.date === b.date
    ? `${f(a.date)}, ${formatTime(o.starts_at)}–${formatTime(o.ends_at)}`
    : `dal ${f(a.date)} ${formatTime(o.starts_at)} al ${f(b.date)} ${formatTime(o.ends_at)}`;
}

export default function TimeOffPage() {
  const { staff } = useAdmin();
  const [rows, setRows] = useState<TimeOff[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [who, setWho] = useState('');
  const [kind, setKind] = useState<TimeOff['kind']>('chiusura');
  const [allDay, setAllDay] = useState(true);
  const [fromDate, setFromDate] = useState(romeToday());
  const [toDate, setToDate] = useState(romeToday());
  const [fromTime, setFromTime] = useState('13:00');
  const [toTime, setToTime] = useState('14:00');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase!
      .from('time_off')
      .select('*')
      .gte('ends_at', new Date().toISOString())
      .order('starts_at')
      .limit(200);
    if (error) setErr(dbMessage(error));
    setRows((data as TimeOff[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const starts_at = allDay ? romeLocalToIso(fromDate, '00:00') : romeLocalToIso(fromDate, fromTime);
    const ends_at = allDay ? romeLocalToIso(addDays(toDate, 1), '00:00') : romeLocalToIso(toDate, toTime);
    if (ends_at <= starts_at) return setErr("La fine deve essere successiva all'inizio.");
    setBusy(true);
    const { error } = await supabase!.from('time_off').insert({ staff_id: who || null, kind, starts_at, ends_at, reason: reason.trim() || null });
    setBusy(false);
    if (error) return setErr(dbMessage(error));
    setReason('');
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Eliminare questo blocco? Gli orari torneranno prenotabili.')) return;
    const { error } = await supabase!.from('time_off').delete().eq('id', id);
    if (error) return setErr(dbMessage(error));
    load();
  };

  const staffName = (id: string | null) => (id ? staff.find((s) => s.id === id)?.display_name ?? '—' : 'Tutto il salone');

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_1.2fr]">
      <form onSubmit={submit} className="space-y-4">
        <h3 className="font-display text-xl">Blocca giorni o orari</h3>
        <Select label="Chi" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Tutto il salone</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name}
            </option>
          ))}
        </Select>
        <Select label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as TimeOff['kind'])}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k[0].toUpperCase() + k.slice(1)}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-ink" />
          Giornate intere
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Input label={allDay ? 'Dal giorno' : 'Inizio'} type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); if (e.target.value > toDate) setToDate(e.target.value); }} />
          <Input label={allDay ? 'Al giorno (compreso)' : 'Fine'} type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
          {!allDay && (
            <>
              <Input label="Dalle" type="time" step={300} value={fromTime} onChange={(e) => setFromTime(e.target.value)} />
              <Input label="Alle" type="time" step={300} value={toTime} onChange={(e) => setToTime(e.target.value)} />
            </>
          )}
        </div>
        <Input label="Motivo (interno, facoltativo)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        {err && <Alert>{err}</Alert>}
        <Button type="submit" busy={busy} className="w-full">
          Blocca
        </Button>
        <p className="text-xs text-taupe">Il blocco non annulla appuntamenti già presenti: controlla l'agenda e avvisa i clienti interessati.</p>
      </form>

      <div>
        <h3 className="mb-3 font-display text-xl">In programma</h3>
        {!rows && <Spinner />}
        {rows && rows.length === 0 && <EmptyState>Nessuna chiusura o assenza in programma.</EmptyState>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
            {rows.map((o) => (
              <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {o.kind[0].toUpperCase() + o.kind.slice(1)}: {staffName(o.staff_id)}
                  </p>
                  <p className="text-sm text-ink-soft">{describe(o)}</p>
                  {o.reason && <p className="text-xs text-taupe">{o.reason}</p>}
                </div>
                <Button variant="ghost" className="min-h-9 px-3 text-sm" onClick={() => remove(o.id)}>
                  Elimina
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
