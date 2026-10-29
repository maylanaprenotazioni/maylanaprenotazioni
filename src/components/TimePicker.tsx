import { useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../lib/api';
import type { TimeOption } from '../lib/types';
import { addDays, formatCalendarDate, formatTime, romeToday } from '../lib/time';
import { DateStrip } from './DateStrip';
import { Alert, Button, Spinner, cx } from './ui';
import { StepTitle } from './BookingBits';

/**
 * Scelta giorno + orario. Gli orari arrivano SOLO dal server (loadTimes).
 * Gli "orari consigliati" (che riempiono meglio l'agenda) sono mostrati per primi,
 * ma tutti gli orari validi restano selezionabili.
 */
export function TimePicker({
  loadTimes,
  reloadKey,
  horizonDays,
  date,
  onDate,
  onPick,
  title = 'Quando?',
  step,
  durationLabel,
}: {
  loadTimes: (date: string) => Promise<TimeOption[]>;
  reloadKey: string;
  horizonDays: number;
  date: string | null;
  onDate: (d: string) => void;
  onPick: (t: TimeOption) => void;
  title?: string;
  step?: number;
  durationLabel?: string;
}) {
  const [times, setTimes] = useState<TimeOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const day = date ?? romeToday();

  useEffect(() => {
    if (!date) onDate(romeToday());
  }, [date, onDate]);

  useEffect(() => {
    let alive = true;
    setTimes(null);
    setError(null);
    loadTimes(day)
      .then((t) => alive && setTimes(t))
      .catch((e: ApiError) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, day]);

  // Ricerca del primo giorno libero (max 14 giorni)
  const findNext = async () => {
    setSearching(true);
    try {
      for (let i = 1; i <= Math.min(14, horizonDays); i++) {
        const d = addDays(day, i);
        const t = await loadTimes(d);
        if (t.length) {
          onDate(d);
          return;
        }
      }
      setError('Nessun orario libero nei prossimi 14 giorni. Prova più avanti o contatta il salone.');
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setSearching(false);
    }
  };

  const recommended = useMemo(() => (times ?? []).filter((t) => t.recommended), [times]);
  const groups = useMemo(() => {
    const morning: TimeOption[] = [];
    const afternoon: TimeOption[] = [];
    for (const t of times ?? []) (Number(formatTime(t.starts_at).slice(0, 2)) < 13 ? morning : afternoon).push(t);
    return [
      ['Mattina', morning],
      ['Pomeriggio', afternoon],
    ] as const;
  }, [times]);

  const btn = (t: TimeOption, highlight = false) => (
    <button
      key={t.starts_at + (highlight ? 'r' : '')}
      onClick={() => onPick(t)}
      className={cx(
        'min-h-12 rounded-xl border text-[15px] tabular-nums hover:border-ink hover:bg-ink hover:text-ivory',
        highlight ? 'border-champagne-deep bg-champagne-wash' : 'border-line bg-paper',
      )}
    >
      {formatTime(t.starts_at)}
    </button>
  );

  return (
    <div className="rise">
      <StepTitle n={step}>{title}</StepTitle>
      {durationLabel && <p className="-mt-2 mb-4 text-sm text-taupe">Durata prevista: {durationLabel}. Vedi solo orari in cui c'è tutto il tempo necessario.</p>}
      <DateStrip value={day} onChange={onDate} horizonDays={horizonDays} />
      <p className="mb-3 mt-5 text-sm text-ink-soft first-letter:uppercase">{formatCalendarDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      {error && <Alert>{error}</Alert>}
      {!times && !error && (
        <div className="flex justify-center py-8 text-taupe" aria-live="polite">
          <Spinner />
        </div>
      )}
      {times && times.length === 0 && (
        <div className="space-y-3 rounded-2xl border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-taupe">Nessun orario libero in questo giorno per i servizi scelti.</p>
          <Button variant="secondary" busy={searching} onClick={findNext}>
            Cerca il primo giorno libero
          </Button>
        </div>
      )}
      {times && times.length > 0 && (
        <div className="space-y-5">
          {recommended.length > 0 && (
            <div>
              <p className="mb-2 text-xs text-champagne-deep">Consigliati</p>
              <div className="grid grid-cols-4 gap-2">{recommended.map((t) => btn(t, true))}</div>
            </div>
          )}
          {groups.map(([label, list]) =>
            list.length ? (
              <div key={label}>
                <p className="mb-2 text-xs text-taupe">{label}</p>
                <div className="grid grid-cols-4 gap-2">{list.map((t) => btn(t))}</div>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
