import { useEffect, useMemo, useState } from 'react';
import { addDays, daysBetween, formatCalendarDate, romeToday, startOfWeek } from '../lib/time';
import { cx } from './ui';

/** Selettore data a settimane, pensato per il pollice. */
export function DateStrip({ value, onChange, horizonDays }: { value: string | null; onChange: (d: string) => void; horizonDays: number }) {
  const today = romeToday();
  const last = addDays(today, horizonDays);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(value ?? today));
  // Se la data cambia dall'esterno (es. ricerca primo giorno libero) mostra la sua settimana
  useEffect(() => {
    if (!value) return;
    setWeekStart((ws) => (daysBetween(ws, value) < 0 || daysBetween(ws, value) > 6 ? startOfWeek(value) : ws));
  }, [value]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const canPrev = daysBetween(today, weekStart) > 0;
  const canNext = daysBetween(addDays(weekStart, 7), last) >= 0;

  const monthLabel = formatCalendarDate(weekStart, { month: 'long', year: 'numeric' });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          disabled={!canPrev}
          className="rounded-full px-3 py-2 text-sm text-ink-soft hover:bg-champagne-wash disabled:invisible"
          aria-label="Settimana precedente"
        >
          ‹ Prima
        </button>
        <span className="font-display text-lg capitalize">{monthLabel}</span>
        <button
          type="button"
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          disabled={!canNext}
          className="rounded-full px-3 py-2 text-sm text-ink-soft hover:bg-champagne-wash disabled:invisible"
          aria-label="Settimana successiva"
        >
          Dopo ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1.5" role="group" aria-label="Scegli il giorno">
        {days.map((d) => {
          const disabled = daysBetween(today, d) < 0 || daysBetween(d, last) < 0;
          const selected = d === value;
          return (
            <button
              key={d}
              type="button"
              disabled={disabled}
              onClick={() => onChange(d)}
              aria-pressed={selected}
              aria-label={formatCalendarDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}
              className={cx(
                'flex flex-col items-center rounded-2xl border py-2.5 transition-colors',
                selected ? 'border-ink bg-ink text-ivory' : 'border-line bg-paper text-ink hover:border-champagne-deep',
                disabled && 'cursor-not-allowed border-transparent bg-transparent text-taupe/40 hover:border-transparent',
              )}
            >
              <span className="text-[11px]">{formatCalendarDate(d, { weekday: 'short' }).replace('.', '')}</span>
              <span className="font-display text-xl leading-tight">{formatCalendarDate(d, { day: 'numeric' })}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
