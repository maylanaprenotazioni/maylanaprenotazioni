import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { Staff, WorkingHour } from '../../lib/types';
import { Alert, Badge, Button, EmptyState, Input, Modal, Spinner, Textarea } from '../../components/ui';
import { useAdmin } from './context';

const WEEKDAYS = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];

export default function StaffPage() {
  const { staff } = useAdmin();
  const [editing, setEditing] = useState<Staff | 'new' | null>(null);
  const [hoursFor, setHoursFor] = useState<Staff | null>(null);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-taupe">Gli orari di lavoro di ogni operatore generano gli slot prenotabili. Usa due fasce nello stesso giorno per la pausa pranzo.</p>
        <Button className="min-h-10 shrink-0" onClick={() => setEditing('new')}>
          Nuovo operatore
        </Button>
      </div>
      {staff.length === 0 ? (
        <EmptyState>Aggiungi il primo operatore per iniziare a ricevere prenotazioni.</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
          {staff.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="flex-1 font-medium">{s.display_name}</span>
              <Badge tone={s.active ? 'ok' : 'muted'}>{s.active ? 'Attivo' : 'Disattivo'}</Badge>
              <Button variant="secondary" className="min-h-9 px-4 text-sm" onClick={() => setHoursFor(s)}>
                Orari
              </Button>
              <Button variant="ghost" className="min-h-9 px-4 text-sm" onClick={() => setEditing(s)}>
                Modifica
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Nuovo operatore' : 'Modifica operatore'}>
        {editing && <StaffForm staff={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
      <Modal open={!!hoursFor} onClose={() => setHoursFor(null)} title={hoursFor ? `Orari di ${hoursFor.display_name}` : ''}>
        {hoursFor && <HoursEditor staff={hoursFor} />}
      </Modal>
    </div>
  );
}

function StaffForm({ staff, onDone }: { staff: Staff | null; onDone: () => void }) {
  const { reloadRefs } = useAdmin();
  const [name, setName] = useState(staff?.display_name ?? '');
  const [bio, setBio] = useState(staff?.bio ?? '');
  const [active, setActive] = useState(staff?.active ?? true);
  const [sort, setSort] = useState(staff?.sort_order?.toString() ?? '0');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const payload = { display_name: name.trim(), bio: bio.trim() || null, active, sort_order: Number(sort) || 0 };
    const { error } = staff ? await supabase!.from('staff').update(payload).eq('id', staff.id) : await supabase!.from('staff').insert(payload);
    setBusy(false);
    if (error) return setErr(dbMessage(error));
    await reloadRefs();
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Input label="Nome visualizzato" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      <Textarea label="Breve descrizione (facoltativa, visibile online)" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} />
      <Input label="Ordine" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
      <label className="flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-ink" />
        Attivo (prenotabile)
      </label>
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full">
        Salva operatore
      </Button>
      <p className="text-xs text-taupe">Per servizi abilitati vai in Servizi. Un operatore con appuntamenti non può essere eliminato: disattivalo.</p>
    </form>
  );
}

export function HoursEditor({ staff }: { staff: Staff }) {
  const [rows, setRows] = useState<WorkingHour[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<number, { start: string; end: string }>>({});

  const load = useCallback(async () => {
    const { data, error } = await supabase!.from('working_hours').select('*').eq('staff_id', staff.id).order('weekday').order('start_time');
    if (error) setErr(dbMessage(error));
    setRows((data as WorkingHour[]) ?? []);
  }, [staff.id]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (weekday: number) => {
    const d = draft[weekday];
    setErr(null);
    if (!d?.start || !d?.end || d.end <= d.start) return setErr("Indica un orario di inizio e uno di fine successivo all'inizio.");
    const { error } = await supabase!.from('working_hours').insert({ staff_id: staff.id, weekday, start_time: d.start, end_time: d.end });
    if (error) return setErr(dbMessage(error));
    setDraft({ ...draft, [weekday]: { start: '', end: '' } });
    load();
  };

  const remove = async (id: string) => {
    const { error } = await supabase!.from('working_hours').delete().eq('id', id);
    if (error) return setErr(dbMessage(error));
    load();
  };

  const copyMonday = async () => {
    const monday = rows?.filter((r) => r.weekday === 1) ?? [];
    if (!monday.length) return setErr('Imposta prima gli orari del lunedì.');
    if (!confirm('Copiare gli orari del lunedì su martedì–sabato? Gli orari esistenti di quei giorni verranno sostituiti.')) return;
    const del = await supabase!.from('working_hours').delete().eq('staff_id', staff.id).in('weekday', [2, 3, 4, 5, 6]);
    if (del.error) return setErr(dbMessage(del.error));
    const ins = await supabase!
      .from('working_hours')
      .insert([2, 3, 4, 5, 6].flatMap((wd) => monday.map((m) => ({ staff_id: staff.id, weekday: wd, start_time: m.start_time, end_time: m.end_time }))));
    if (ins.error) setErr(dbMessage(ins.error));
    load();
  };

  if (!rows) return <Spinner />;

  return (
    <div className="space-y-5">
      <p className="text-sm text-taupe">Orari in ora italiana. Lascia vuoto un giorno per indicarlo come giorno libero.</p>
      {err && <Alert>{err}</Alert>}
      {WEEKDAYS.map((label, i) => {
        const wd = i + 1;
        const list = rows.filter((r) => r.weekday === wd);
        const d = draft[wd] ?? { start: '', end: '' };
        return (
          <div key={wd} className="border-b border-line pb-4">
            <p className="mb-2 font-medium">{label}</p>
            {list.length === 0 && <p className="mb-2 text-sm text-taupe">Libero</p>}
            <div className="mb-2 flex flex-wrap gap-2">
              {list.map((r) => (
                <span key={r.id} className="inline-flex items-center gap-2 rounded-full border border-line bg-paper py-1 pl-3 pr-1 text-sm tabular-nums">
                  {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
                  <button onClick={() => remove(r.id)} className="rounded-full px-2 text-taupe hover:bg-danger/10 hover:text-danger" aria-label={`Rimuovi fascia ${label}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <input type="time" step={300} value={d.start} onChange={(e) => setDraft({ ...draft, [wd]: { ...d, start: e.target.value } })} className="rounded-lg border border-line bg-paper px-2 py-2 text-sm" aria-label={`${label} inizio`} />
              <span className="pb-2 text-taupe">–</span>
              <input type="time" step={300} value={d.end} onChange={(e) => setDraft({ ...draft, [wd]: { ...d, end: e.target.value } })} className="rounded-lg border border-line bg-paper px-2 py-2 text-sm" aria-label={`${label} fine`} />
              <Button variant="secondary" className="min-h-9 px-4 text-sm" onClick={() => add(wd)}>
                Aggiungi
              </Button>
            </div>
          </div>
        );
      })}
      <Button variant="ghost" onClick={copyMonday} className="w-full">
        Copia gli orari del lunedì su martedì–sabato
      </Button>
    </div>
  );
}
