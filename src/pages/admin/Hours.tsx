import { useCallback, useEffect, useState } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { Staff, WorkingHour } from '../../lib/types';
import { Alert, Button, EmptyState, Modal, Spinner } from '../../components/ui';
import { useAdmin } from './context';
import { HoursEditor } from './StaffPage';
import TimeOffPage from './TimeOffPage';

const DAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

/** Orari di apertura (per operatore) e chiusure/ferie/pause in un'unica sezione. */
export default function Hours() {
  const { staff, role } = useAdmin();
  const [rows, setRows] = useState<WorkingHour[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Staff | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase!.from('working_hours').select('*').order('start_time');
    if (error) setErr(dbMessage(error));
    setRows((data as WorkingHour[]) ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const active = staff.filter((s) => s.active);

  return (
    <div className="space-y-10">
      <OpeningHours canEdit={role === 'owner'} />
      <section>
        <h2 className="mb-1 font-display text-2xl">Turni degli operatori</h2>
        <p className="mb-4 max-w-prose text-sm text-taupe">
          Gli orari di ciascun operatore generano gli orari prenotabili online. Due fasce nello stesso giorno indicano la pausa.
          {role !== 'owner' && ' Solo il titolare può modificarli.'}
        </p>
        {err && <Alert>{err}</Alert>}
        {!rows && <Spinner />}
        {rows && active.length === 0 && <EmptyState>Nessun operatore attivo.</EmptyState>}
        {rows && active.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-line bg-paper">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-taupe">
                  <th className="px-3 py-2 font-normal">Operatore</th>
                  {DAYS.map((d) => (
                    <th key={d} className="px-2 py-2 font-normal">
                      {d}
                    </th>
                  ))}
                  {role === 'owner' && <th />}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {active.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2.5 font-medium">{s.display_name}</td>
                    {DAYS.map((_, i) => {
                      const list = rows.filter((r) => r.staff_id === s.id && r.weekday === i + 1);
                      return (
                        <td key={i} className="px-2 py-2.5 align-top tabular-nums">
                          {list.length === 0 ? (
                            <span className="text-taupe">—</span>
                          ) : (
                            list.map((r) => (
                              <span key={r.id} className="block whitespace-nowrap">
                                {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
                              </span>
                            ))
                          )}
                        </td>
                      );
                    })}
                    {role === 'owner' && (
                      <td className="px-2 py-2.5">
                        <Button variant="secondary" className="min-h-9 px-3 text-sm" onClick={() => setEditing(s)}>
                          Modifica
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 font-display text-2xl">Chiusure, ferie e pause</h2>
        <TimeOffPage />
      </section>

      <Modal
        open={!!editing}
        onClose={() => {
          setEditing(null);
          load();
        }}
        title={editing ? `Orari di ${editing.display_name}` : ''}
      >
        {editing && <HoursEditor staff={editing} />}
      </Modal>
    </div>
  );
}

interface OpeningRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

/**
 * Orari di apertura del salone. Gli orari prenotabili sono l'intersezione tra
 * apertura del salone e turno dell'operatore. Se non ci sono righe, valgono solo i turni.
 */
function OpeningHours({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<OpeningRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<number, { start: string; end: string }>>({});

  const load = useCallback(async () => {
    const { data, error } = await supabase!.from('opening_hours').select('*').order('weekday').order('start_time');
    if (error) setErr(dbMessage(error));
    setRows((data as OpeningRow[]) ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const add = async (weekday: number) => {
    const d = draft[weekday];
    setErr(null);
    if (!d?.start || !d?.end || d.end <= d.start) return setErr("Indica un orario di apertura e uno di chiusura successivo all'apertura.");
    const { error } = await supabase!.from('opening_hours').insert({ weekday, start_time: d.start, end_time: d.end });
    if (error) return setErr(/opening_hours_no_overlap/.test(error.message) ? 'La fascia si sovrappone a una esistente.' : dbMessage(error));
    setDraft({ ...draft, [weekday]: { start: '', end: '' } });
    load();
  };
  const remove = async (id: string) => {
    const { error } = await supabase!.from('opening_hours').delete().eq('id', id);
    if (error) return setErr(dbMessage(error));
    load();
  };

  return (
    <section>
      <h2 className="mb-1 font-display text-2xl">Orari di apertura del salone</h2>
      <p className="mb-4 max-w-prose text-sm text-taupe">
        Si prenota solo quando il salone è aperto <em>e</em> l'operatore è in turno. Un giorno senza fasce è un giorno di chiusura.
        {rows && rows.length === 0 && ' Al momento non è impostato nessun orario: valgono solo i turni degli operatori.'}
      </p>
      {err && <Alert>{err}</Alert>}
      {!rows && <Spinner />}
      {rows && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {DAYS.map((label, i) => {
            const wd = i + 1;
            const list = rows.filter((r) => r.weekday === wd);
            const d = draft[wd] ?? { start: '', end: '' };
            return (
              <div key={wd} className="rounded-xl border border-line bg-paper p-3">
                <p className="font-medium">{label}</p>
                {list.length === 0 && <p className="text-sm text-taupe">{rows.length ? 'Chiuso' : '—'}</p>}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {list.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1 rounded-full border border-line py-0.5 pl-3 pr-1 text-sm tabular-nums">
                      {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
                      {canEdit && (
                        <button onClick={() => remove(r.id)} className="rounded-full px-2 text-taupe hover:text-danger" aria-label={`Rimuovi fascia ${label}`}>
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {canEdit && (
                  <div className="mt-2 flex items-center gap-1">
                    <input type="time" step={300} value={d.start} onChange={(e) => setDraft({ ...draft, [wd]: { ...d, start: e.target.value } })} className="min-w-0 flex-1 rounded-lg border border-line px-1.5 py-1.5 text-sm" aria-label={`${label} apertura`} />
                    <input type="time" step={300} value={d.end} onChange={(e) => setDraft({ ...draft, [wd]: { ...d, end: e.target.value } })} className="min-w-0 flex-1 rounded-lg border border-line px-1.5 py-1.5 text-sm" aria-label={`${label} chiusura`} />
                    <button onClick={() => add(wd)} className="min-h-9 rounded-full border border-ink px-3 text-sm">
                      +
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
