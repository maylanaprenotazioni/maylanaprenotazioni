import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type EmailOutcome } from '../lib/api';
import type { BookedAppointment, Catalog, PublicGroup, PublicStaff, Service, TimeOption } from '../lib/types';
import { addDays, formatCalendarDate, formatDuration, formatLongDate, formatPrice, formatTime, romeToday } from '../lib/time';
import { GROUPS, calcBundle, newIdempotencyKey } from '../lib/bundle';
import { customerMessages } from '../lib/whatsapp';
import { buildIcs, downloadIcs } from '../lib/ics';
import { Alert, Button, Input, Select, Spinner, Textarea, cx } from '../components/ui';
import { Brand } from '../components/Brand';
import { useOnline } from '../components/Online';
import { TimePicker } from '../components/TimePicker';
import { Choice, EmailNote, StepTitle, Steps, WhatsAppButton, durationText, priceText } from '../components/BookingBits';
import type { AiPublicStatus } from '../lib/ai-types';
import type { ChatContext } from '../components/ai/MaylanaAIChat';
import { ErrorBoundary } from '../components/ErrorBoundary';

// Caricata solo se l'assistente è attivo: chi non usa l'AI non scarica il codice della chat.
const MaylanaAIChat = lazy(() => import('../components/ai/MaylanaAIChat'));

type Stage = { step: number; group: PublicGroup | null; selected: number; done: boolean };
type Preset = { ids: string[]; n: number };

const ANY = 'any';

interface Contact {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  notes: string;
  privacy: boolean;
  marketing: boolean;
  website: string; // campo trappola anti-bot
}

const emptyContact: Contact = { firstName: '', lastName: '', phone: '', email: '', notes: '', privacy: false, marketing: false, website: '' };

type Outcome =
  | { kind: 'booked'; appt: BookedAppointment; email: EmailOutcome }
  | { kind: 'requested'; code: string; label: string; email: EmailOutcome };

export default function BookingPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ai, setAi] = useState<AiPublicStatus | null>(null);
  const [stage, setStage] = useState<Stage>({ step: 1, group: null, selected: 0, done: false });
  const [preset, setPreset] = useState<Preset | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .catalog()
      .then(setCatalog)
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);
  useEffect(load, [load]);

  // Maylana AI: facoltativo. Se non è configurato o non risponde, la pagina resta identica.
  useEffect(() => {
    if (!catalog) return;
    api
      .aiStatus()
      .then((r) => setAi(r.available && r.welcome ? r : null))
      .catch(() => setAi(null));
  }, [catalog]);

  const chatContext: ChatContext = stage.group === 'consulenze' ? 'consulenze' : stage.step === 2 ? 'services' : 'booking';
  const showChat = !!ai && !!catalog && catalog.settings.online_booking_enabled && !stage.done && stage.step <= 3;

  const s = catalog?.settings;

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-5 pb-28 pt-10 sm:pt-14">
      <header className="mb-8">
        <Brand name={s?.business_name ?? 'Maylana Coiffeur'} logoUrl={s?.logo_url} />
        {s?.address && <p className="mt-3 text-center text-sm text-taupe">{s.address}</p>}
      </header>

      {!catalog && !loadError && (
        <div className="flex justify-center py-20 text-taupe" aria-live="polite">
          <Spinner />
        </div>
      )}
      {loadError && (
        <div className="space-y-4">
          <Alert>{loadError}</Alert>
          <Button variant="secondary" onClick={load} className="w-full">
            Riprova
          </Button>
        </div>
      )}

      {catalog && s && (
        <main className="flex-1">
          {s.public_notice && (
            <div className="mb-6">
              <Alert tone="info">{s.public_notice}</Alert>
            </div>
          )}
          {!s.online_booking_enabled ? (
            <Alert tone="info">
              Le prenotazioni online sono momentaneamente sospese.
              {s.contact_phone && <> Per un appuntamento chiama il {s.contact_phone}.</>}
            </Alert>
          ) : (
            <Flow catalog={catalog} onStage={setStage} preset={preset} />
          )}
        </main>
      )}

      {s && (
        <footer className="mt-14 space-y-3 border-t border-line pt-6 text-center text-xs leading-relaxed text-taupe">
          <WhatsAppButton number={s.whatsapp_number} text={customerMessages.general()} />
          {(s.contact_phone || s.contact_email) && (
            <p>
              {s.contact_phone && (
                <a className="underline-offset-4 hover:underline" href={`tel:${s.contact_phone.replace(/\s/g, '')}`}>
                  {s.contact_phone}
                </a>
              )}
              {s.contact_phone && s.contact_email && <span className="mx-2">/</span>}
              {s.contact_email && (
                <a className="underline-offset-4 hover:underline" href={`mailto:${s.contact_email}`}>
                  {s.contact_email}
                </a>
              )}
            </p>
          )}
          {s.privacy_url && (
            <p>
              <a className="underline underline-offset-4" href={s.privacy_url} target="_blank" rel="noreferrer">
                Informativa privacy
              </a>
            </p>
          )}
        </footer>
      )}

      {showChat && (
        <ErrorBoundary variant="silent">
        <Suspense fallback={null}>
          <MaylanaAIChat
            catalog={catalog!}
            welcome={ai!.welcome!}
            maxInputChars={ai!.maxInputChars}
            context={chatContext}
            lifted={stage.step === 2 && stage.selected > 0}
            onOpenForm={(ids) => setPreset({ ids, n: Date.now() })}
          />
        </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

/* ================================================================== */
/* Procedura in 5 passaggi                                            */
/* ================================================================== */

function Flow({ catalog, onStage, preset }: { catalog: Catalog; onStage?: (s: Stage) => void; preset?: Preset | null }) {
  const settings = catalog.settings;
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [group, setGroup] = useState<PublicGroup | null>(() =>
    new URLSearchParams(location.search).get('sezione') === 'capelli-for-you' ? 'consulenze' : null,
  );
  const [selected, setSelected] = useState<Service[]>([]);
  const [staffChoice, setStaffChoice] = useState<string>(ANY);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<TimeOption | null>(null);
  const [prefDate, setPrefDate] = useState('');
  const [prefWindow, setPrefWindow] = useState<'mattina' | 'pomeriggio' | 'indifferente'>('indifferente');
  const [contact, setContact] = useState<Contact>(emptyContact);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (group === 'consulenze' && step === 1) setStep(2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bundle = useMemo(() => calcBundle(selected, settings.booking_buffer_minutes ?? 0), [selected, settings.booking_buffer_minutes]);
  const eligibleStaff = useMemo(
    () => catalog.staff.filter((st) => selected.length > 0 && selected.every((sv) => st.service_ids.includes(sv.id))),
    [catalog.staff, selected],
  );
  const automatic = !bundle.needsApproval;

  const go = (n: 1 | 2 | 3 | 4 | 5) => {
    setStep(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    onStage?.({ step, group, selected: selected.length, done: !!outcome });
  }, [step, group, selected.length, outcome, onStage]);

  // Ripresa del modulo dopo una ricarica (es. connessione persa): si conservano SOLO
  // scelte non sensibili (servizi, operatore, giorno, preferenze). Mai nome,
  // telefono, email o note. Durata massima 2 ore, solo per questa scheda.
  const DRAFT = 'maylana:bozza';
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT) ?? 'null') as
        | { ids: string[]; group: PublicGroup | null; staff: string; date: string | null; prefDate: string; prefWindow: typeof prefWindow; ts: number }
        | null;
      if (!d || Date.now() - d.ts > 2 * 3600_000) return;
      const list = catalog.services.filter((sv) => d.ids.includes(sv.id));
      if (!list.length || list.length !== d.ids.length) return;
      setGroup(d.group ?? list[0].public_group);
      setSelected(list);
      setStaffChoice(d.staff || ANY);
      setDate(d.date);
      setPrefDate(d.prefDate || '');
      setPrefWindow(d.prefWindow || 'indifferente');
      setInfo('Abbiamo ripreso le scelte fatte prima: verifica giorno e orario. I dati personali vanno reinseriti.');
      setStep(3);
    } catch {
      /* storage non disponibile: si riparte da capo */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      if (outcome || !selected.length) sessionStorage.removeItem(DRAFT);
      else
        sessionStorage.setItem(
          DRAFT,
          JSON.stringify({ ids: selected.map((x) => x.id), group, staff: staffChoice, date, prefDate, prefWindow, ts: Date.now() }),
        );
    } catch {
      /* ignorato */
    }
  }, [selected, group, staffChoice, date, prefDate, prefWindow, outcome]);

  // Dalla chat: "Apri nel modulo" porta i servizi scelti nella procedura classica.
  useEffect(() => {
    if (!preset) return;
    const list = catalog.services.filter((sv) => preset.ids.includes(sv.id));
    if (!list.length) return;
    setGroup(list[0].public_group);
    setSelected(list);
    setTime(null);
    setStaffChoice(ANY);
    setNotice(null);
    go(3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  if (outcome) return <Result outcome={outcome} catalog={catalog} />;

  return (
    <div>
      <Steps current={step} />
      {notice && (
        <div className="mb-4">
          <Alert>{notice}</Alert>
        </div>
      )}
      {info && !notice && step <= 3 && (
        <div className="mb-4">
          <Alert tone="info">{info}</Alert>
        </div>
      )}

      {step === 1 && (
        <CategoryStep
          services={catalog.services}
          onPick={(g) => {
            setGroup(g);
            go(2);
          }}
        />
      )}

      {step === 2 && group && (
        <ServicesStep
          services={catalog.services}
          group={group}
          onGroup={setGroup}
          selected={selected}
          onChange={(list) => {
            setSelected(list);
            setTime(null);
            setStaffChoice(ANY);
          }}
          bundle={bundle}
          staffAvailable={eligibleStaff.length > 0}
          onBack={() => go(1)}
          onNext={() => {
            setNotice(null);
            go(3);
          }}
        />
      )}

      {step === 3 && (
        <section className="rise">
          <Choice label="Servizi" value={`${bundle.label}, ${formatDuration(bundle.duration)}`} onEdit={() => go(2)} />
          <div className="mt-8">
            {automatic ? (
              <WhenAutomatic
                selected={selected}
                staff={eligibleStaff}
                staffChoice={staffChoice}
                onStaff={(id) => {
                  setStaffChoice(id);
                  setTime(null);
                }}
                date={date}
                onDate={setDate}
                horizonDays={settings.booking_horizon_days}
                durationLabel={durationText(bundle.duration, bundle.buffer)}
                onPick={(t) => {
                  setTime(t);
                  setNotice(null);
                  go(4);
                }}
              />
            ) : (
              <WhenRequest
                isConsultation={bundle.isConsultation}
                staff={eligibleStaff}
                staffChoice={staffChoice}
                onStaff={setStaffChoice}
                prefDate={prefDate}
                onPrefDate={setPrefDate}
                prefWindow={prefWindow}
                onPrefWindow={setPrefWindow}
                horizon={settings.booking_horizon_days}
                onNext={() => go(4)}
              />
            )}
          </div>
          <Button variant="ghost" className="mt-6 w-full" onClick={() => go(2)}>
            Indietro
          </Button>
        </section>
      )}

      {step === 4 && (
        <ContactStep
          catalog={catalog}
          value={contact}
          onChange={setContact}
          isConsultation={bundle.isConsultation}
          onBack={() => go(3)}
          onNext={() => go(5)}
        />
      )}

      {step === 5 && (
        <SummaryStep
          catalog={catalog}
          selected={selected}
          bundle={bundle}
          automatic={automatic}
          time={time}
          staffName={
            automatic
              ? staffChoice === ANY
                ? eligibleStaff.length === 1
                  ? eligibleStaff[0].display_name
                  : null
                : eligibleStaff.find((x) => x.id === staffChoice)?.display_name ?? null
              : staffChoice === ANY
                ? null
                : eligibleStaff.find((x) => x.id === staffChoice)?.display_name ?? null
          }
          prefDate={prefDate}
          prefWindow={prefWindow}
          contact={contact}
          onEdit={(n) => go(n)}
          submit={async (idempotencyKey) => {
            const common = {
              serviceIds: selected.map((x) => x.id),
              firstName: contact.firstName.trim(),
              lastName: contact.lastName.trim(),
              phone: contact.phone.trim(),
              email: contact.email.trim(),
              notes: contact.notes.trim() || null,
              privacyAccepted: true as const,
              marketingConsent: contact.marketing,
              website: contact.website,
              formStartedAt: startedAt.current,
              idempotencyKey,
            };
            try {
              if (automatic) {
                const r = await api.book({ ...common, staffId: staffChoice === ANY ? null : staffChoice, startsAt: time!.starts_at });
                setOutcome({ kind: 'booked', appt: r.appointment, email: r.email });
              } else {
                const r = await api.request({
                  ...common,
                  preferredDate: prefDate || null,
                  preferredTimeWindow: prefWindow,
                  preferredStaffId: staffChoice === ANY ? null : staffChoice,
                });
                setOutcome({ kind: 'requested', code: r.code, label: r.service_name ?? bundle.label, email: r.email });
              }
              window.scrollTo({ top: 0, behavior: 'smooth' });
            } catch (e) {
              const err = e as ApiError;
              // Lo slot è stato preso da altri mentre il cliente completava i dati: si torna agli orari.
              if (err.code === 'SLOT_UNAVAILABLE') {
                setTime(null);
                setNotice(`${err.message} I tuoi dati sono stati conservati.`);
                go(3);
                return;
              }
              throw err;
            }
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ Passaggio 1 ------------------------------ */

function CategoryStep({ services, onPick }: { services: Service[]; onPick: (g: PublicGroup) => void }) {
  const counts = new Map<PublicGroup, number>();
  for (const s of services) counts.set(s.public_group, (counts.get(s.public_group) ?? 0) + 1);
  const groups = GROUPS.filter((g) => (counts.get(g.key) ?? 0) > 0);
  return (
    <section className="rise">
      <StepTitle>Cosa desideri prenotare?</StepTitle>
      {groups.length === 0 ? (
        <Alert tone="info">Al momento non ci sono servizi prenotabili online.</Alert>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {groups.map((g) => (
            <li key={g.key}>
              <button onClick={() => onPick(g.key)} className="group flex w-full items-center justify-between gap-4 py-5 text-left hover:bg-champagne-wash/40 sm:px-2">
                <span>
                  <span className="block font-display text-[24px] leading-tight group-hover:text-champagne-deep">{g.label}</span>
                  <span className="block text-sm text-taupe">{g.hint}</span>
                </span>
                <span aria-hidden className="text-2xl text-taupe">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------ Passaggio 2 ------------------------------ */

function ServicesStep({
  services,
  group,
  onGroup,
  selected,
  onChange,
  bundle,
  staffAvailable,
  onBack,
  onNext,
}: {
  services: Service[];
  group: PublicGroup;
  onGroup: (g: PublicGroup) => void;
  selected: Service[];
  onChange: (s: Service[]) => void;
  bundle: ReturnType<typeof calcBundle>;
  staffAvailable: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const isCons = group === 'consulenze';
  const otherGroups = GROUPS.filter((g) => g.key !== 'consulenze' && g.key !== group && services.some((s) => s.public_group === g.key));
  const list = services.filter((s) => s.public_group === group);
  const selectedIds = new Set(selected.map((s) => s.id));

  const toggle = (svc: Service) => {
    if (svc.category === 'consultation') {
      onChange(selectedIds.has(svc.id) ? [] : [svc]); // consulenze: una alla volta, non combinabili
      return;
    }
    const base = selected.filter((s) => s.category !== 'consultation');
    if (selectedIds.has(svc.id)) onChange(base.filter((s) => s.id !== svc.id));
    else if (base.length < 5) onChange([...base, svc]);
  };

  const blocked = selected.length > 0 && !bundle.needsApproval && !staffAvailable;

  return (
    <>
    <section className="rise">
      {isCons ? (
        <div className="mb-6">
          <p className="font-display text-[26px] leading-tight">Maylana Coiffeur × Capelli For You</p>
          <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink-soft">
            Consulenze dedicate, in collaborazione con Capelli For You. Invia una richiesta: il salone ti ricontatta per fissare l'appuntamento in un momento riservato.
          </p>
        </div>
      ) : (
        <StepTitle>Scegli uno o più servizi</StepTitle>
      )}

      <ul className="divide-y divide-line border-y border-line">
        {list.map((svc) => {
          const on = selectedIds.has(svc.id);
          return (
            <li key={svc.id}>
              <button
                onClick={() => toggle(svc)}
                aria-pressed={on}
                className={cx('group flex w-full gap-3 py-4 text-left transition-colors sm:px-2', on ? 'bg-champagne-wash/60' : 'hover:bg-champagne-wash/30')}
              >
                <span
                  aria-hidden
                  className={cx('mt-1.5 grid size-5 shrink-0 place-items-center rounded-md border text-[13px]', on ? 'border-ink bg-ink text-ivory' : 'border-taupe/60 bg-paper')}
                >
                  {on ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-3">
                    <span className="font-display text-[21px] leading-snug">{svc.name}</span>
                    <span className="leader" aria-hidden />
                    <span className="shrink-0 text-[15px] tabular-nums">{formatPrice(svc.price_cents, svc.price_from)}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-3 text-sm text-taupe">
                    {svc.duration_minutes && <span>{formatDuration(svc.duration_minutes)}</span>}
                    {svc.booking_mode === 'manual' && svc.category !== 'consultation' && <span>Su conferma del salone</span>}
                  </span>
                  {svc.description && <span className="mt-1.5 block max-w-prose text-sm leading-relaxed text-ink-soft">{svc.description}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {list.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line px-5 py-6 text-center text-[15px] text-ink-soft">
          {isCons
            ? 'Le consulenze non sono ancora prenotabili online. Contatta il salone ai recapiti in fondo alla pagina.'
            : 'Nessun servizio disponibile online in questa categoria. Scegli un\'altra categoria o contatta il salone.'}
        </div>
      )}

      {!isCons && otherGroups.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm text-taupe">Aggiungi anche da:</p>
          <div className="flex flex-wrap gap-2">
            {otherGroups.map((g) => (
              <button key={g.key} onClick={() => onGroup(g.key)} className="min-h-10 rounded-full border border-line bg-paper px-4 text-sm hover:border-ink">
                {g.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <Button variant="ghost" className="mt-6 w-full" onClick={onBack}>
        Indietro
      </Button>
    </section>

      {/* Totale sempre visibile in basso (fuori dalla sezione animata: un antenato
          con animazione di transform renderebbe "fixed" relativo a lui) */}
      {selected.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ivory/95 px-5 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 backdrop-blur">
          <div className="mx-auto max-w-xl">
            <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {selected.length === 1 ? '1 servizio' : `${selected.length} servizi`}, {formatDuration(bundle.duration)}
              </span>
              <span className="shrink-0 font-medium tabular-nums">{priceText(bundle.priceCents, bundle.priceEstimate)}</span>
            </div>
            {bundle.needsApproval && !bundle.isConsultation && (
              <p className="mb-2 text-xs text-ink-soft">Uno dei servizi richiede la conferma del salone: invierai una richiesta e ti ricontatteremo.</p>
            )}
            {blocked && <p className="mb-2 text-xs text-danger">Nessun operatore esegue tutti questi servizi nello stesso appuntamento. Togli un servizio o contatta il salone.</p>}
            <Button className="w-full" disabled={blocked} onClick={onNext}>
              Continua
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------ Passaggio 3 ------------------------------ */

function WhenAutomatic({
  selected,
  staff,
  staffChoice,
  onStaff,
  date,
  onDate,
  horizonDays,
  durationLabel,
  onPick,
}: {
  selected: Service[];
  staff: PublicStaff[];
  staffChoice: string;
  onStaff: (id: string) => void;
  date: string | null;
  onDate: (d: string) => void;
  horizonDays: number;
  durationLabel: string;
  onPick: (t: TimeOption) => void;
}) {
  const ids = selected.map((s) => s.id);
  return (
    <div>
      {staff.length > 1 && (
        <div className="mb-8">
          <StepTitle>Con chi?</StepTitle>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Operatore">
            {[{ id: ANY, display_name: 'Nessuna preferenza' }, ...staff].map((st) => (
              <button
                key={st.id}
                role="radio"
                aria-checked={staffChoice === st.id}
                onClick={() => onStaff(st.id)}
                className={cx('min-h-11 rounded-full border px-4 text-[15px]', staffChoice === st.id ? 'border-ink bg-ink text-ivory' : 'border-line bg-paper hover:border-ink')}
              >
                {st.display_name}
              </button>
            ))}
          </div>
        </div>
      )}
      <TimePicker
        title="Giorno e orario"
        loadTimes={(d) => api.availability(ids, d, staffChoice === ANY ? null : staffChoice).then((r) => r.times)}
        reloadKey={`${ids.join(',')}:${staffChoice}`}
        horizonDays={horizonDays}
        date={date}
        onDate={onDate}
        onPick={onPick}
        durationLabel={durationLabel}
      />
    </div>
  );
}

function WhenRequest({
  isConsultation,
  staff,
  staffChoice,
  onStaff,
  prefDate,
  onPrefDate,
  prefWindow,
  onPrefWindow,
  horizon,
  onNext,
}: {
  isConsultation: boolean;
  staff: PublicStaff[];
  staffChoice: string;
  onStaff: (id: string) => void;
  prefDate: string;
  onPrefDate: (d: string) => void;
  prefWindow: 'mattina' | 'pomeriggio' | 'indifferente';
  onPrefWindow: (w: 'mattina' | 'pomeriggio' | 'indifferente') => void;
  horizon: number;
  onNext: () => void;
}) {
  const today = romeToday();
  return (
    <div className="space-y-4">
      <StepTitle>Quando preferisci?</StepTitle>
      <Alert tone="info">
        {isConsultation
          ? 'La consulenza viene fissata dal salone: indica le tue preferenze, ti ricontatteremo.'
          : "Questa combinazione richiede la conferma del salone: indica le tue preferenze, ti proporremo l'orario."}
      </Alert>
      <Input label="Giorno preferito (facoltativo)" type="date" min={today} max={addDays(today, horizon)} value={prefDate} onChange={(e) => onPrefDate(e.target.value)} />
      <Select label="Fascia oraria" value={prefWindow} onChange={(e) => onPrefWindow(e.target.value as typeof prefWindow)}>
        <option value="indifferente">Indifferente</option>
        <option value="mattina">Mattina</option>
        <option value="pomeriggio">Pomeriggio</option>
      </Select>
      {!isConsultation && staff.length > 1 && (
        <Select label="Operatore (facoltativo)" value={staffChoice} onChange={(e) => onStaff(e.target.value)}>
          <option value={ANY}>Nessuna preferenza</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name}
            </option>
          ))}
        </Select>
      )}
      <Button className="w-full" onClick={onNext}>
        Continua
      </Button>
    </div>
  );
}

/* ------------------------------ Passaggio 4 ------------------------------ */

function ContactStep({
  catalog,
  value,
  onChange,
  isConsultation,
  onBack,
  onNext,
}: {
  catalog: Catalog;
  value: Contact;
  onChange: (c: Contact) => void;
  isConsultation: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Contact>(k: K, v: Contact[K]) => onChange({ ...value, [k]: v });
  const privacyUrl = catalog.settings.privacy_url;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.firstName.trim() || !value.lastName.trim()) return setError('Inserisci nome e cognome.');
    if (value.phone.replace(/\D/g, '').length < 6) return setError('Inserisci un numero di telefono valido.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.email.trim())) return setError('Inserisci un indirizzo email valido.');
    if (!value.privacy) return setError("Per continuare accetta l'informativa privacy.");
    setError(null);
    onNext();
  };

  return (
    <form onSubmit={submit} className="rise space-y-4" noValidate>
      <StepTitle>I tuoi dati</StepTitle>
      <p className="-mt-2 text-sm text-taupe">Non serve registrarsi.</p>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Nome" autoComplete="given-name" required maxLength={60} value={value.firstName} onChange={(e) => set('firstName', e.target.value)} />
        <Input label="Cognome" autoComplete="family-name" required maxLength={60} value={value.lastName} onChange={(e) => set('lastName', e.target.value)} />
      </div>
      <Input label="Telefono" type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} value={value.phone} onChange={(e) => set('phone', e.target.value)} />
      <Input label="Email" type="email" inputMode="email" autoComplete="email" required maxLength={200} value={value.email} onChange={(e) => set('email', e.target.value)} hint="Riceverai la conferma e il link per gestire l'appuntamento." />
      <Textarea
        label="Note (facoltative)"
        hint={isConsultation ? 'Solo esigenze organizzative. Non inserire informazioni sulla salute né foto.' : 'Esigenze organizzative. Non inserire informazioni sulla salute.'}
        maxLength={500}
        value={value.notes}
        onChange={(e) => set('notes', e.target.value)}
      />

      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
        <label>
          Sito web
          <input tabIndex={-1} autoComplete="off" value={value.website} onChange={(e) => set('website', e.target.value)} />
        </label>
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-line bg-paper px-4 py-3 text-sm leading-relaxed">
        <input type="checkbox" checked={value.privacy} onChange={(e) => set('privacy', e.target.checked)} className="mt-1 size-5 shrink-0 accent-ink" />
        <span>
          Ho letto l'
          {privacyUrl ? (
            <a href={privacyUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              informativa privacy
            </a>
          ) : (
            'informativa privacy'
          )}{' '}
          e acconsento al trattamento dei dati per gestire l'appuntamento. <span className="text-taupe">(obbligatorio)</span>
        </span>
      </label>
      <label className="flex items-start gap-3 rounded-xl border border-line bg-paper px-4 py-3 text-sm leading-relaxed">
        <input type="checkbox" checked={value.marketing} onChange={(e) => set('marketing', e.target.checked)} className="mt-1 size-5 shrink-0 accent-ink" />
        <span>
          Desidero ricevere novità e promozioni da {catalog.settings.business_name}. <span className="text-taupe">(facoltativo, non influisce sulla prenotazione)</span>
        </span>
      </label>

      {error && <Alert>{error}</Alert>}
      <Button type="submit" className="w-full">
        Vai al riepilogo
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
        Indietro
      </Button>
    </form>
  );
}

/* ------------------------------ Passaggio 5 ------------------------------ */

function SummaryStep({
  catalog,
  selected,
  bundle,
  automatic,
  time,
  staffName,
  prefDate,
  prefWindow,
  contact,
  onEdit,
  submit,
}: {
  catalog: Catalog;
  selected: Service[];
  bundle: ReturnType<typeof calcBundle>;
  automatic: boolean;
  time: TimeOption | null;
  staffName: string | null;
  prefDate: string;
  prefWindow: string;
  contact: Contact;
  onEdit: (n: 2 | 3 | 4) => void;
  submit: (idempotencyKey: string) => Promise<void>;
}) {
  // Una chiave per questo riepilogo: doppio clic o ripetizioni non creano duplicati.
  const key = useRef(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit(key.current);
    } catch (e) {
      setError((e as Error).message || 'Invio non riuscito. Riprova.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rise">
      <StepTitle>Riepilogo</StepTitle>
      <div className="rounded-3xl border border-champagne/50 bg-paper px-5 py-2">
        <div className="border-b border-line py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-taupe">Servizi</p>
            <button onClick={() => onEdit(2)} className="text-sm text-champagne-deep">
              Modifica
            </button>
          </div>
          <ul className="mt-1 space-y-1">
            {selected.map((s) => (
              <li key={s.id} className="flex items-baseline gap-3 text-[15px]">
                <span>{s.name}</span>
                <span className="leader" aria-hidden />
                <span className="shrink-0 tabular-nums text-ink-soft">{formatPrice(s.price_cents, s.price_from)}</span>
              </li>
            ))}
          </ul>
        </div>
        {automatic && time ? (
          <Choice label="Data e orario" value={`${capitalize(formatLongDate(time.starts_at))}, ore ${formatTime(time.starts_at)}`} onEdit={() => onEdit(3)} />
        ) : (
          <Choice
            label="Preferenza"
            value={`${prefDate ? capitalize(formatCalendarDate(prefDate, { weekday: 'long', day: 'numeric', month: 'long' })) : 'Qualsiasi giorno'}, ${prefWindow}`}
            onEdit={() => onEdit(3)}
          />
        )}
        <Choice label="Durata" value={durationText(bundle.duration, bundle.buffer)} />
        <Choice label="Prezzo previsto" value={priceText(bundle.priceCents, bundle.priceEstimate)} />
        {staffName && <Choice label="Operatore" value={staffName} />}
        {automatic && !staffName && <Choice label="Operatore" value="Assegnato dal salone tra quelli disponibili" />}
        <Choice label="Cliente" value={`${contact.firstName} ${contact.lastName}, ${contact.phone}`} onEdit={() => onEdit(4)} />
        <div className="py-3">
          <p className="text-xs text-taupe">Stato</p>
          <p className="text-[15px]">{automatic ? 'Confermato subito dopo il tuo invio' : 'Richiesta da approvare: ti ricontatteremo'}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-taupe">Il prezzo è indicativo e può variare in salone in base alla lunghezza e al tipo di capello.</p>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {!online && (
        <div className="mt-4">
          <Alert tone="info">Sei offline: per prenotare serve la connessione a Internet.</Alert>
        </div>
      )}
      <Button className="mt-5 w-full" busy={busy} disabled={!online} onClick={confirm}>
        {automatic ? 'Conferma prenotazione' : 'Invia richiesta'}
      </Button>
      <p className="mt-2 text-center text-xs text-taupe">{catalog.settings.business_name} riceverà i tuoi dati solo per gestire l'appuntamento.</p>
    </section>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ------------------------------ Esito ------------------------------ */

function Result({ outcome, catalog }: { outcome: Outcome; catalog: Catalog }) {
  const s = catalog.settings;
  if (outcome.kind === 'requested') {
    return (
      <section className="rise text-center" aria-live="polite">
        <p className="text-sm text-champagne-deep">Richiesta inviata, in attesa di approvazione</p>
        <h2 className="mt-2 font-display text-[30px] leading-tight">Ti ricontatteremo</h2>
        <div className="mx-auto mt-6 max-w-sm rounded-3xl border border-line bg-paper px-6 py-6">
          <p className="text-xs text-taupe">Codice richiesta</p>
          <p className="mt-1 font-display text-[28px] tracking-[0.08em]">{outcome.code}</p>
          <p className="mt-3 text-[15px]">{outcome.label}</p>
        </div>
        <EmailNote email={outcome.email} sentText="Ti abbiamo inviato un'email di riepilogo della richiesta." savedText="la richiesta è comunque registrata" />
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-soft">
          Questa non è ancora una prenotazione: l'appuntamento sarà valido solo dopo la conferma del salone.
        </p>
        <div className="mt-6 flex flex-col items-center gap-2">
          <WhatsAppButton number={s.whatsapp_number} text={customerMessages.general()} />
          <Button variant="ghost" onClick={() => location.reload()}>
            Torna all'inizio
          </Button>
        </div>
      </section>
    );
  }

  const a = outcome.appt;
  const ics = () =>
    downloadIcs(
      `maylana-${a.code}.ics`,
      buildIcs({
        uid: a.code,
        title: `${s.business_name}: ${a.service_name}`,
        startsAt: a.starts_at,
        endsAt: a.ends_at,
        location: s.address,
        description: `Riferimento ${a.code}`,
      }),
    );

  return (
    <section className="rise text-center" aria-live="polite">
      <p className="text-sm text-ok">Prenotazione confermata</p>
      <h2 className="mt-2 font-display text-[34px] leading-tight">Ti aspettiamo</h2>
      <div className="mx-auto mt-8 max-w-sm rounded-3xl border border-champagne/50 bg-paper px-6 py-7">
        <p className="text-xs text-taupe">Codice appuntamento</p>
        <p className="mt-1 font-display text-[32px] tracking-[0.08em]">{a.code}</p>
        <div className="my-5 h-px bg-line" />
        <p className="font-display text-xl">{a.service_name}</p>
        <p className="mt-2 text-[15px]">{capitalize(formatLongDate(a.starts_at))}</p>
        <p className="text-[15px]">
          ore {formatTime(a.starts_at)}, durata {formatDuration(a.duration_minutes)}
        </p>
        <p className="mt-2 text-sm text-taupe">con {a.staff_name}</p>
        <p className="mt-1 text-sm text-taupe">{priceText(a.total_price_cents, a.price_is_estimate)}</p>
      </div>
      <EmailNote email={outcome.email} sentText="Ti abbiamo inviato un'email con i dettagli e il link per spostare o annullare l'appuntamento." />
      <div className="mt-6 flex flex-col items-center gap-2">
        <Button variant="secondary" onClick={ics}>
          Aggiungi al calendario
        </Button>
        <WhatsAppButton number={s.whatsapp_number} text={customerMessages.aboutBooking(a.code, a.starts_at)} label="Contatta il salone" />
        <Button variant="ghost" onClick={() => location.reload()}>
          Nuova prenotazione
        </Button>
      </div>
    </section>
  );
}
