import { useCallback, useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import type { BookingMode, Service, WorkingHour } from '../../lib/types';
import { GROUPS } from '../../lib/bundle';
import { Alert, Badge, Button, Input, Select, Spinner, cx } from '../../components/ui';
import { useAdmin } from './context';
import SettingsPage from './SettingsPage';
import Hours from './Hours';
import StaffPage from './StaffPage';
import Services from './Services';

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

interface Status {
  hours: WorkingHour[];
  onlineEnabled: boolean;
  hasContacts: boolean;
}

/**
 * Pagina iniziale del titolare: stato della configurazione e tutti i moduli
 * necessari per rendere prenotabile la pagina pubblica, in un unico posto.
 */
export default function SetupPage() {
  const { services, staff, staffServices } = useAdmin();
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [wh, bs] = await Promise.all([
      supabase!.from('working_hours').select('*'),
      supabase!.from('business_settings').select('online_booking_enabled, contact_phone, address').eq('id', 1).maybeSingle(),
    ]);
    const e = wh.error || bs.error;
    if (e) setErr(dbMessage(e));
    setStatus({
      hours: (wh.data as WorkingHour[]) ?? [],
      onlineEnabled: !!bs.data?.online_booking_enabled,
      hasContacts: !!(bs.data?.contact_phone || bs.data?.address),
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, services, staff, staffServices]);

  const activeStaff = staff.filter((s) => s.active);
  const staffWithHours = activeStaff.filter((s) => status?.hours.some((h) => h.staff_id === s.id));
  const bookable = services.filter(
    (s) => s.active && s.duration_minutes && staffServices.some((x) => x.service_id === s.id && staffWithHours.some((st) => st.id === x.staff_id)),
  );
  const ready = !!status?.onlineEnabled && bookable.length > 0;

  const steps: { ok: boolean; label: string; detail: string; anchor: string }[] = [
    { ok: activeStaff.length > 0, label: 'Operatori', detail: `${activeStaff.length} attivi`, anchor: 'operatori' },
    { ok: activeStaff.length > 0 && staffWithHours.length === activeStaff.length, label: 'Orari di lavoro', detail: `${staffWithHours.length} di ${activeStaff.length} operatori con turni`, anchor: 'operatori' },
    { ok: bookable.length > 0, label: 'Servizi prenotabili', detail: `${bookable.length} di ${services.length} attivi, con durata e operatore`, anchor: 'servizi' },
    { ok: !!status?.hasContacts, label: 'Contatti del salone', detail: status?.hasContacts ? 'Telefono o indirizzo presenti' : 'Telefono e indirizzo mancanti', anchor: 'regole' },
    { ok: !!status?.onlineEnabled, label: 'Prenotazioni online', detail: status?.onlineEnabled ? 'Attive' : 'Disattivate', anchor: 'regole' },
  ];

  return (
    <div className="space-y-8">
      <section>
        <h1 className="font-display text-3xl">Configura le prenotazioni</h1>
        <p className="mt-1 max-w-prose text-sm text-taupe">
          Tutto ciò che serve per ricevere prenotazioni online: operatori e turni, servizi con durata e prezzo, regole e contatti. Ogni modulo salva subito.
        </p>
        {err && (
          <div className="mt-3">
            <Alert>{err}</Alert>
          </div>
        )}
        {!status ? (
          <Spinner />
        ) : (
          <>
            <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {steps.map((s, i) => (
                <li key={s.label}>
                  <a href={`#setup-${s.anchor}`} onClick={(e) => jump(e, s.anchor)} className={cx('block h-full rounded-xl border px-4 py-3', s.ok ? 'border-ok/40 bg-ok/5' : 'border-champagne-deep/50 bg-champagne-wash')}>
                    <span className="flex items-center justify-between gap-2 text-sm font-medium">
                      {i + 1}. {s.label}
                      <Badge tone={s.ok ? 'ok' : 'gold'}>{s.ok ? 'Fatto' : 'Da fare'}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-taupe">{s.detail}</span>
                  </a>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Alert tone={ready ? 'ok' : 'info'}>
                {ready
                  ? `La pagina prenotazioni è attiva: ${bookable.length} servizi prenotabili.`
                  : 'La pagina prenotazioni non mostra ancora orari: completa i passaggi "Da fare".'}
              </Alert>
              <a href="/prenota" target="_blank" rel="noopener" className="rounded-full border border-line px-4 py-2 text-sm hover:bg-champagne-wash">
                Apri la pagina prenotazioni ↗
              </a>
            </div>
          </>
        )}
      </section>

      <Card id="operatori" title="1. Operatore e orari di lavoro" hint="Crea un operatore con i suoi turni settimanali in un solo passaggio. Due fasce nello stesso giorno indicano la pausa pranzo.">
        <QuickStaff onSaved={refresh} />
      </Card>

      <Card id="servizi" title="2. Servizi, durate e prezzi" hint="Un servizio compare online quando è attivo, ha una durata e almeno un operatore abilitato con orari di lavoro.">
        <QuickServices />
      </Card>

      <Card id="regole" title="3. Regole di prenotazione e contatti" hint="Preavviso, giorni prenotabili, intervallo degli orari, promemoria, contatti mostrati ai clienti.">
        <SettingsPage />
      </Card>

      <section className="space-y-3">
        <h2 className="font-display text-2xl">Gestione avanzata</h2>
        <More title="Orari di apertura del salone, chiusure, ferie e pause" onToggle={refresh}>
          <Hours />
        </More>
        <More title="Operatori: modifica, disattiva, turni per giorno" onToggle={refresh}>
          <StaffPage />
        </More>
        <More title="Servizi: descrizioni, categorie, tempi di preparazione, operatori abilitati" onToggle={refresh}>
          <Services />
        </More>
      </section>
    </div>
  );
}

function jump(e: MouseEvent, anchor: string) {
  e.preventDefault();
  document.getElementById(`setup-${anchor}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Card({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section id={`setup-${id}`} className="scroll-mt-32 rounded-2xl border border-line bg-paper p-5 sm:p-6">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mb-5 mt-1 max-w-prose text-sm text-taupe">{hint}</p>
      {children}
    </section>
  );
}

function More({ title, children, onToggle }: { title: string; children: ReactNode; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl border border-line bg-paper">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (open) onToggle();
        }}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left font-medium"
      >
        {title}
        <span aria-hidden className="text-taupe">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && <div className="border-t border-line px-5 py-5">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- operatore + turni

function QuickStaff({ onSaved }: { onSaved: () => void }) {
  const { staff, services, reloadRefs, toast } = useAdmin();
  const [name, setName] = useState('');
  const [days, setDays] = useState<number[]>([2, 3, 4, 5, 6]);
  const [m1, setM1] = useState('09:00');
  const [m2, setM2] = useState('13:00');
  const [p1, setP1] = useState('15:00');
  const [p2, setP2] = useState('19:30');
  const [allServices, setAllServices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleDay = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr("Indica il nome dell'operatore.");
    if (!days.length) return setErr('Scegli almeno un giorno di lavoro.');
    const shifts = [
      [m1, m2],
      [p1, p2],
    ].filter(([a, b]) => a || b);
    if (!shifts.length) return setErr('Indica almeno una fascia oraria.');
    if (shifts.some(([a, b]) => !a || !b || b <= a)) return setErr("Ogni fascia deve avere un inizio e una fine successiva all'inizio.");
    if (shifts.length === 2 && shifts[1][0] < shifts[0][1]) return setErr('La fascia del pomeriggio deve iniziare dopo la fine della mattina.');

    setBusy(true);
    const ins = await supabase!
      .from('staff')
      .insert({ display_name: name.trim(), bio: null, active: true, sort_order: staff.length + 1 })
      .select('id')
      .single();
    if (ins.error || !ins.data) {
      setBusy(false);
      return setErr(dbMessage(ins.error));
    }
    const staffId = ins.data.id as string;
    const wh = await supabase!.from('working_hours').insert(days.flatMap((wd) => shifts.map(([a, b]) => ({ staff_id: staffId, weekday: wd, start_time: a, end_time: b }))));
    const ss = allServices && services.length ? await supabase!.from('staff_services').insert(services.map((s) => ({ staff_id: staffId, service_id: s.id }))) : { error: null };
    setBusy(false);
    const e2 = wh.error || ss.error;
    if (e2) setErr(`Operatore creato, ma: ${dbMessage(e2)}`);
    else toast(`${name.trim()} aggiunto con i suoi orari.`);
    setName('');
    await reloadRefs();
    onSaved();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {staff.length > 0 && (
        <p className="text-sm text-ink-soft">
          Operatori già presenti: <strong>{staff.map((s) => s.display_name + (s.active ? '' : ' (disattivo)')).join(', ')}</strong>. Puoi aggiungerne un altro qui sotto; per modificare i turni usa "Gestione avanzata".
        </p>
      )}
      <Input label="Nome dell'operatore" placeholder="es. Maylana" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink-soft">Giorni di lavoro</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d, i) => (
            <label key={d} className={cx('cursor-pointer rounded-full border px-4 py-2 text-sm', days.includes(i + 1) ? 'border-ink bg-ink text-ivory' : 'border-line')}>
              <input type="checkbox" className="sr-only" checked={days.includes(i + 1)} onChange={() => toggleDay(i + 1)} />
              {d}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Input label="Mattina dalle" type="time" value={m1} onChange={(e) => setM1(e.target.value)} />
        <Input label="alle" type="time" value={m2} onChange={(e) => setM2(e.target.value)} />
        <Input label="Pomeriggio dalle" type="time" hint="Vuoto = solo mattina" value={p1} onChange={(e) => setP1(e.target.value)} />
        <Input label="alle" type="time" value={p2} onChange={(e) => setP2(e.target.value)} />
      </div>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={allServices} onChange={(e) => setAllServices(e.target.checked)} className="size-5 accent-ink" />
        Abilita a tutti i servizi (modificabile in seguito per singolo servizio)
      </label>
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full sm:w-auto">
        Aggiungi operatore con orari
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- servizi in tabella

interface Draft {
  duration: string;
  price: string;
  from: boolean;
  mode: BookingMode;
  active: boolean;
}

const toDraft = (s: Service): Draft => ({
  duration: s.duration_minutes ? String(s.duration_minutes) : '',
  price: s.price_cents != null ? (s.price_cents / 100).toFixed(2).replace('.', ',').replace(',00', '') : '',
  from: s.price_from,
  mode: s.booking_mode,
  active: !!s.active,
});

function QuickServices() {
  const { services, staff, staffServices, reloadRefs, toast } = useAdmin();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [linkStaff, setLinkStaff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(Object.fromEntries(services.map((s) => [s.id, toDraft(s)])));
  }, [services]);

  const set = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const updates: { s: Service; payload: Partial<Service> }[] = [];
    for (const s of services) {
      const d = drafts[s.id];
      if (!d) continue;
      const dur = d.duration.trim() === '' ? null : Number(d.duration);
      if (dur !== null && (!Number.isInteger(dur) || dur < 5 || dur > 600)) return setErr(`${s.name}: durata tra 5 e 600 minuti.`);
      if (d.active && !dur) return setErr(`${s.name}: per attivarlo indica la durata.`);
      const p = d.price.trim().replace(/\s|€/g, '');
      const price = p === '' ? null : Math.round(Number(p.includes(',') ? p.replace(/\./g, '').replace(',', '.') : p) * 100);
      if (price !== null && (!Number.isFinite(price) || price < 0)) return setErr(`${s.name}: prezzo non valido (es. 25 oppure 25,50).`);
      const mode: BookingMode = s.category === 'consultation' ? 'manual' : d.mode;
      const payload = { duration_minutes: dur, price_cents: price, price_from: price !== null && d.from, booking_mode: mode, active: d.active };
      const changed =
        payload.duration_minutes !== s.duration_minutes ||
        payload.price_cents !== s.price_cents ||
        payload.price_from !== s.price_from ||
        payload.booking_mode !== s.booking_mode ||
        payload.active !== !!s.active;
      if (changed) updates.push({ s, payload });
    }

    const activeStaff = staff.filter((x) => x.active);
    const links = linkStaff
      ? services
          .filter((s) => drafts[s.id]?.active && !staffServices.some((x) => x.service_id === s.id))
          .flatMap((s) => activeStaff.map((st) => ({ staff_id: st.id, service_id: s.id })))
      : [];
    if (!updates.length && !links.length) return toast('Nessuna modifica da salvare.', 'info');

    setBusy(true);
    for (const u of updates) {
      const { error } = await supabase!.from('services').update(u.payload).eq('id', u.s.id);
      if (error) {
        setBusy(false);
        await reloadRefs();
        return setErr(`${u.s.name}: ${dbMessage(error)}`);
      }
    }
    if (links.length) {
      const { error } = await supabase!.from('staff_services').insert(links);
      if (error) setErr(`Servizi salvati, ma non è stato possibile abilitare gli operatori: ${dbMessage(error)}`);
    }
    setBusy(false);
    await reloadRefs();
    toast(`${updates.length} servizi aggiornati.`);
  };

  if (!services.length) return <p className="text-sm text-taupe">Nessun servizio: aggiungilo da "Gestione avanzata".</p>;

  return (
    <form onSubmit={submit} className="space-y-5">
      {GROUPS.map((g) => {
        const list = services.filter((s) => s.public_group === g.key);
        if (!list.length) return null;
        return (
          <div key={g.key}>
            <h3 className="mb-2 font-display text-lg">{g.label}</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {list.map((s) => {
                const d = drafts[s.id];
                if (!d) return null;
                const enabled = staffServices.filter((x) => x.service_id === s.id).length;
                return (
                  <li key={s.id} className={cx('grid grid-cols-2 items-end gap-3 px-4 py-3 sm:grid-cols-[minmax(10rem,1fr)_6rem_7rem_9rem_auto]', !d.active && 'bg-ivory/60')}>
                    <div className="col-span-2 sm:col-span-1 sm:self-center">
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-taupe">{enabled ? `${enabled} operatori abilitati` : 'Nessun operatore abilitato'}</p>
                    </div>
                    <Input label="Durata (min)" inputMode="numeric" placeholder="es. 30" value={d.duration} onChange={(e) => set(s.id, { duration: e.target.value })} />
                    <div>
                      <Input label="Prezzo (€)" inputMode="decimal" placeholder="in salone" value={d.price} onChange={(e) => set(s.id, { price: e.target.value })} />
                      <label className="mt-1 flex items-center gap-1.5 text-xs text-taupe">
                        <input type="checkbox" checked={d.from} onChange={(e) => set(s.id, { from: e.target.checked })} className="accent-ink" />
                        prezzo "da"
                      </label>
                    </div>
                    <Select
                      label="Prenotazione"
                      value={s.category === 'consultation' ? 'manual' : d.mode}
                      disabled={s.category === 'consultation'}
                      onChange={(e) => set(s.id, { mode: e.target.value as BookingMode })}
                    >
                      <option value="automatic">Immediata</option>
                      <option value="manual">Su richiesta</option>
                    </Select>
                    <label className="col-span-2 flex min-h-12 items-center gap-2 text-sm sm:col-span-1">
                      <input type="checkbox" checked={d.active} onChange={(e) => set(s.id, { active: e.target.checked })} className="size-5 accent-ink" />
                      Attivo
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <p className="text-xs text-taupe">
        "Immediata": il cliente sceglie l'orario e l'appuntamento è confermato subito. "Su richiesta": il cliente invia una richiesta che approvi tu dalla sezione Richieste. Le consulenze Capelli For You sono sempre su richiesta.
      </p>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={linkStaff} onChange={(e) => setLinkStaff(e.target.checked)} className="size-5 accent-ink" />
        Abilita gli operatori attivi ai servizi attivi che non hanno ancora nessun operatore
      </label>
      {err && <Alert>{err}</Alert>}
      <Button type="submit" busy={busy} className="w-full sm:w-auto">
        Salva servizi
      </Button>
    </form>
  );
}
