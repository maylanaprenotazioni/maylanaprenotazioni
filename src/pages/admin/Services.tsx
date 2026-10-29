import { useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { Service } from '../../lib/types';
import { formatDuration, formatPrice } from '../../lib/time';
import { Alert, Badge, Button, EmptyState, Input, Modal, Select, Textarea } from '../../components/ui';
import { GROUPS } from '../../lib/bundle';
import type { PublicGroup } from '../../lib/types';
import { useAdmin } from './context';

export default function Services() {
  const { services } = useAdmin();
  const [editing, setEditing] = useState<Service | 'new' | null>(null);

  const groups = GROUPS.map((g) => [g.key, g.label] as const);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-taupe">Un servizio compare online solo se è attivo, ha una durata e (se automatico) almeno un operatore abilitato con orari di lavoro.</p>
        <Button className="min-h-10 shrink-0" onClick={() => setEditing('new')}>
          Nuovo servizio
        </Button>
      </div>
      {groups.map(([cat, label]) => {
        const list = services.filter((s) => s.public_group === cat);
        return (
          <section key={cat} className="mb-8">
            <h3 className="mb-2 font-display text-xl">{label}</h3>
            {list.length === 0 ? (
              <EmptyState>Nessun servizio.</EmptyState>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
                {list.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => setEditing(s)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-champagne-wash/40">
                      <span className="min-w-40 flex-1 font-medium">{s.name}</span>
                      <span className="text-sm tabular-nums">{formatPrice(s.price_cents, s.price_from)}</span>
                      <span className="w-20 text-sm text-taupe">{formatDuration(s.duration_minutes) || 'durata ?'}</span>
                      <Badge tone={s.booking_mode === 'automatic' ? 'neutral' : 'gold'}>{s.booking_mode === 'automatic' ? 'Automatica' : 'Su richiesta'}</Badge>
                      <Badge tone={s.active ? 'ok' : 'muted'}>{s.active ? 'Attivo' : 'Disattivo'}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Nuovo servizio' : 'Modifica servizio'}>
        {editing && <ServiceForm service={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}

function ServiceForm({ service, onDone }: { service: Service | null; onDone: () => void }) {
  const { staff, staffServices, reloadRefs } = useAdmin();
  const [group, setGroup] = useState<PublicGroup>(service?.public_group ?? 'donna');
  const category: Service['category'] = group === 'consulenze' ? 'consultation' : 'hair';
  const [buffer, setBuffer] = useState(String(service?.buffer_after_minutes ?? 0));
  const [name, setName] = useState(service?.name ?? '');
  const [description, setDescription] = useState(service?.description ?? '');
  const [price, setPrice] = useState(service?.price_cents != null ? (service.price_cents / 100).toFixed(2).replace('.', ',') : '');
  const [priceFrom, setPriceFrom] = useState(service?.price_from ?? false);
  const [duration, setDuration] = useState(service?.duration_minutes?.toString() ?? '');
  const [mode, setMode] = useState<Service['booking_mode']>(service?.booking_mode ?? 'automatic');
  const [active, setActive] = useState(service?.active ?? false);
  const [sort, setSort] = useState(service?.sort_order?.toString() ?? '0');
  const [assigned, setAssigned] = useState<Set<string>>(() => new Set(staffServices.filter((x) => x.service_id === service?.id).map((x) => x.staff_id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const effectiveMode = category === 'consultation' ? 'manual' : mode;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const p = price.trim().replace(/\s|€/g, '');
    const normalized = p.includes(',') ? p.replace(/\./g, '').replace(',', '.') : p;
    const priceNum = p === '' ? null : Math.round(Number(normalized) * 100);
    if (priceNum !== null && (!Number.isFinite(priceNum) || priceNum < 0)) return setErr('Prezzo non valido (es. 25 oppure 25,50).');
    const dur = duration.trim() === '' ? null : Number(duration);
    if (dur !== null && (!Number.isInteger(dur) || dur < 5 || dur > 600)) return setErr('Durata in minuti tra 5 e 600.');
    if (active && !dur) return setErr('Per attivare il servizio indica la durata.');

    const buf = Number(buffer || 0);
    if (!Number.isInteger(buf) || buf < 0 || buf > 120) return setErr('Tempo di preparazione tra 0 e 120 minuti.');
    const payload = {
      category,
      public_group: group,
      buffer_after_minutes: buf,
      name: name.trim(),
      description: description.trim() || null,
      price_cents: priceNum,
      price_from: priceFrom,
      duration_minutes: dur,
      booking_mode: effectiveMode,
      active,
      sort_order: Number(sort) || 0,
    };
    setBusy(true);
    let id = service?.id;
    if (service) {
      const { error } = await supabase!.from('services').update(payload).eq('id', service.id);
      if (error) {
        setBusy(false);
        return setErr(dbMessage(error));
      }
    } else {
      const { data, error } = await supabase!.from('services').insert(payload).select('id').single();
      if (error) {
        setBusy(false);
        return setErr(dbMessage(error));
      }
      id = data.id as string;
    }
    // Sincronizza operatori abilitati
    const before = new Set(staffServices.filter((x) => x.service_id === id).map((x) => x.staff_id));
    const toAdd = [...assigned].filter((s) => !before.has(s)).map((staff_id) => ({ staff_id, service_id: id! }));
    const toRemove = [...before].filter((s) => !assigned.has(s));
    const r1 = toAdd.length ? await supabase!.from('staff_services').insert(toAdd) : { error: null };
    const r2 = toRemove.length ? await supabase!.from('staff_services').delete().eq('service_id', id!).in('staff_id', toRemove) : { error: null };
    setBusy(false);
    if (r1.error || r2.error) return setErr(dbMessage(r1.error || r2.error));
    await reloadRefs();
    onDone();
  };

  const remove = async () => {
    if (!service || !confirm(`Eliminare "${service.name}"? Se ha appuntamenti collegati non sarà possibile: in quel caso disattivalo.`)) return;
    const { error } = await supabase!.from('services').delete().eq('id', service.id);
    if (error) return setErr(dbMessage(error));
    await reloadRefs();
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Select label="Categoria (come la vede il cliente)" value={group} onChange={(e) => setGroup(e.target.value as PublicGroup)}>
        {GROUPS.map((g) => (
          <option key={g.key} value={g.key}>
            {g.label}
            {g.key === 'consulenze' ? ' (sempre su richiesta, non combinabile)' : ''}
          </option>
        ))}
      </Select>
      <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      <Textarea label="Descrizione" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Prezzo (€)" inputMode="decimal" placeholder="vuoto = in salone" value={price} onChange={(e) => setPrice(e.target.value)} />
        <Input label="Durata (minuti)" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
      </div>
      <Input
        label="Tempo di preparazione dopo il servizio (minuti)"
        inputMode="numeric"
        hint="Riserva l'operatore anche per questo tempo (es. sistemazione postazione). Non mostrato come durata al cliente."
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
      />
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={priceFrom} onChange={(e) => setPriceFrom(e.target.checked)} className="accent-ink" />
        Mostra come prezzo di partenza ("da …")
      </label>
      {group !== 'consulenze' && (
        <Select label="Modalità di prenotazione" value={mode} onChange={(e) => setMode(e.target.value as Service['booking_mode'])}>
          <option value="automatic">Automatica: il cliente sceglie l'orario ed è confermato subito</option>
          <option value="manual">Su richiesta: il salone approva e fissa l'orario</option>
        </Select>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-ink-soft">Operatori abilitati</legend>
        {staff.length === 0 && <p className="text-sm text-taupe">Crea prima gli operatori.</p>}
        {staff.map((s) => (
          <label key={s.id} className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="accent-ink"
              checked={assigned.has(s.id)}
              onChange={(e) => {
                const n = new Set(assigned);
                if (e.target.checked) n.add(s.id);
                else n.delete(s.id);
                setAssigned(n);
              }}
            />
            {s.display_name}
            {!s.active && <span className="text-taupe">(disattivo)</span>}
          </label>
        ))}
      </fieldset>
      <Input label="Ordine nel listino" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
      <label className="flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-ink" />
        Attivo (visibile online)
      </label>
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full">
        Salva servizio
      </Button>
      {service && (
        <Button type="button" variant="danger" className="w-full" onClick={remove}>
          Elimina servizio
        </Button>
      )}
    </form>
  );
}
