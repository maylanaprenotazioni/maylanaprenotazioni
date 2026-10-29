import { useEffect, useState } from 'react';
import { api, ApiError, type EmailOutcome } from '../lib/api';
import type { Catalog, ManagedAppointment, TimeOption } from '../lib/types';
import { addDays, formatDuration, formatLongDate, formatPrice, formatTime, romeToday } from '../lib/time';
import { buildIcs, downloadIcs } from '../lib/ics';
import { customerMessages } from '../lib/whatsapp';
import { Alert, Button, Input, Select, Spinner, Textarea } from '../components/ui';
import { Brand } from '../components/Brand';
import { useOnline } from '../components/Online';
import { TimePicker } from '../components/TimePicker';
import { EmailNote, StepTitle, WhatsAppButton, priceText } from '../components/BookingBits';

type Mode = 'view' | 'reschedule' | 'request' | 'cancel';
type Done = { kind: 'cancelled' | 'moved' | 'requested'; email: EmailOutcome; startsAt?: string; code?: string };

function readToken(): string | null {
  const m = /[#&]t=([A-Za-z0-9_-]{32,128})/.exec(window.location.hash);
  return m ? m[1] : null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Pagina personale del cliente: annulla o sposta senza account, tramite link ricevuto via email. */
export default function ManagePage() {
  const [token] = useState(readToken);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [appt, setAppt] = useState<ManagedAppointment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [done, setDone] = useState<Done | null>(null);
  const online = useOnline();

  useEffect(() => {
    document.title = 'Il tuo appuntamento — Maylana';
    api.catalog().then(setCatalog).catch(() => undefined);
    if (!token) {
      setError('Link incompleto. Apri il link dall\'email ricevuta oppure contatta il salone.');
      return;
    }
    api
      .manageView(token)
      .then((r) => setAppt(r.appointment))
      .catch((e: ApiError) => setError(e.message));
  }, [token]);

  const s = catalog?.settings;
  const phone = s?.contact_phone;

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-5 pb-16 pt-10 sm:pt-14">
      <header className="mb-8">
        <Brand name={s?.business_name ?? 'Maylana Coiffeur'} logoUrl={s?.logo_url} />
      </header>

      {!appt && !error && (
        <div className="flex justify-center py-16 text-taupe">
          <Spinner />
        </div>
      )}
      {error && !done && (
        <div className="space-y-4">
          <Alert>{error}</Alert>
          {phone && (
            <a href={`tel:${phone.replace(/\s/g, '')}`} className="block text-center text-champagne-deep underline underline-offset-4">
              Chiama il salone: {phone}
            </a>
          )}
        </div>
      )}

      {done && <Outcome done={done} phone={phone ?? null} />}

      {appt && !done && (
        <main className="rise">
          <p className="text-sm text-taupe">Ciao {appt.first_name}, ecco il tuo appuntamento</p>
          <div className="mt-3 rounded-3xl border border-champagne/50 bg-paper px-6 py-6">
            <p className="text-[15px] font-medium">{cap(formatLongDate(appt.starts_at))}</p>
            <p className="text-[15px]">
              ore {formatTime(appt.starts_at)}, con {appt.staff_name}
            </p>
            <ul className="mt-4 space-y-1 border-t border-line pt-4">
              {appt.items.map((it, i) => (
                <li key={i} className="flex items-baseline gap-3">
                  <span className="font-display text-xl">{it.name}</span>
                  <span className="leader" aria-hidden />
                  <span className="shrink-0 text-sm tabular-nums text-ink-soft">{formatPrice(it.price_cents, it.price_from)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-ink-soft">
              Durata {formatDuration(appt.duration_minutes)}, {priceText(appt.total_price_cents, appt.price_is_estimate)}
            </p>
            <p className="mt-3 text-xs text-taupe">Riferimento {appt.code}</p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="min-h-11"
              onClick={() =>
                downloadIcs(
                  `maylana-${appt.code}.ics`,
                  buildIcs({
                    uid: appt.code,
                    title: `${s?.business_name ?? 'Maylana Coiffeur'}: ${appt.service_name}`,
                    startsAt: appt.starts_at,
                    endsAt: appt.ends_at,
                    location: s?.address,
                    description: `Riferimento ${appt.code}`,
                  }),
                )
              }
            >
              Aggiungi al calendario
            </Button>
            {phone && (
              <a href={`tel:${phone.replace(/\s/g, '')}`} className="inline-flex min-h-11 items-center rounded-full border border-line bg-paper px-5 text-[15px] hover:border-ink">
                Chiama il salone
              </a>
            )}
            <WhatsAppButton number={s?.whatsapp_number ?? null} text={customerMessages.aboutBooking(appt.code, appt.starts_at)} label="WhatsApp" />
            {s?.contact_email && (
              <a href={`mailto:${s.contact_email}?subject=${encodeURIComponent('Prenotazione ' + appt.code)}`} className="inline-flex min-h-11 items-center rounded-full border border-line bg-paper px-5 text-[15px] hover:border-ink">
                Email
              </a>
            )}
          </div>

          {appt.pending_reschedule_request && (
            <div className="mt-5">
              <Alert tone="info">Hai già chiesto uno spostamento: il salone ti contatterà. Fino ad allora questo appuntamento resta valido.</Alert>
            </div>
          )}

          {!appt.can_change ? (
            <div className="mt-6">
              <Alert tone="info">
                Le modifiche online erano possibili fino a {formatLongDate(appt.change_deadline)} alle {formatTime(appt.change_deadline)}.
                {phone ? ` Per cambiamenti chiama il ${phone}.` : ' Per cambiamenti contatta il salone.'}
              </Alert>
            </div>
          ) : (
            <>
              <p className="mt-4 text-sm text-taupe">
                Puoi modificare online fino a {formatLongDate(appt.change_deadline)} alle {formatTime(appt.change_deadline)}.
              </p>
              {!online && (
                <div className="mt-4">
                  <Alert tone="info">Sei offline: per modificare l'appuntamento serve la connessione a Internet.</Alert>
                </div>
              )}

              {mode === 'view' && (
                <div className="mt-6 grid gap-2">
                  {!appt.pending_reschedule_request && appt.self_reschedule && (
                    <Button variant="secondary" disabled={!online} onClick={() => setMode('reschedule')}>
                      Scegli un nuovo orario
                    </Button>
                  )}
                  {!appt.pending_reschedule_request && (
                    <Button variant={appt.self_reschedule ? 'ghost' : 'secondary'} disabled={!online} onClick={() => setMode('request')}>
                      Chiedi una nuova data al salone
                    </Button>
                  )}
                  <Button variant="danger" disabled={!online} onClick={() => setMode('cancel')}>
                    Annulla appuntamento
                  </Button>
                </div>
              )}

              {mode === 'cancel' && token && <CancelBox token={token} onBack={() => setMode('view')} onDone={setDone} />}
              {mode === 'reschedule' && token && (
                <RescheduleBox token={token} horizon={s?.booking_horizon_days ?? 60} current={appt.starts_at} onBack={() => setMode('view')} onDone={setDone} />
              )}
              {mode === 'request' && token && <RequestBox token={token} horizon={s?.booking_horizon_days ?? 60} onBack={() => setMode('view')} onDone={setDone} />}
            </>
          )}
        </main>
      )}
    </div>
  );
}

function CancelBox({ token, onBack, onDone }: { token: string; onBack: () => void; onDone: (d: Done) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.manageCancel(token);
      onDone({ kind: 'cancelled', email: r.email });
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rise mt-6 space-y-3 rounded-2xl border border-danger/30 bg-paper p-5">
      <p className="text-[15px]">Vuoi davvero annullare l'appuntamento? L'orario tornerà disponibile per altri clienti.</p>
      {err && <Alert>{err}</Alert>}
      <Button variant="danger" busy={busy} onClick={run} className="w-full">
        Sì, annulla l'appuntamento
      </Button>
      <Button variant="ghost" onClick={onBack} className="w-full">
        No, torna indietro
      </Button>
    </div>
  );
}

function RescheduleBox({
  token,
  horizon,
  current,
  onBack,
  onDone,
}: {
  token: string;
  horizon: number;
  current: string;
  onBack: () => void;
  onDone: (d: Done) => void;
}) {
  const [date, setDate] = useState<string | null>(null);
  const [picked, setPicked] = useState<TimeOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const confirm = async () => {
    if (!picked) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.manageReschedule(token, picked.starts_at);
      onDone({ kind: 'moved', email: r.email, startsAt: r.starts_at });
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae.message);
      if (ae.code === 'SLOT_UNAVAILABLE') {
        setPicked(null);
        setReloadKey((k) => k + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-8">
      {err && (
        <div className="mb-4">
          <Alert>{err}</Alert>
        </div>
      )}
      {!picked ? (
        <TimePicker
          title="Scegli il nuovo orario"
          loadTimes={(d) => api.manageAvailability(token, d).then((r) => r.times)}
          reloadKey={String(reloadKey)}
          horizonDays={horizon}
          date={date}
          onDate={setDate}
          onPick={setPicked}
        />
      ) : (
        <div className="rise space-y-3 rounded-2xl border border-line bg-paper p-5">
          <StepTitle>Confermi il nuovo orario?</StepTitle>
          <p className="text-[15px]">
            {cap(formatLongDate(picked.starts_at))}, ore {formatTime(picked.starts_at)}
          </p>
          <p className="text-sm text-taupe">Prima: {formatLongDate(current)}, ore {formatTime(current)}</p>
          <Button busy={busy} onClick={confirm} className="w-full">
            Conferma spostamento
          </Button>
          <Button variant="ghost" onClick={() => setPicked(null)} className="w-full">
            Scegli un altro orario
          </Button>
        </div>
      )}
      <Button variant="ghost" onClick={onBack} className="mt-4 w-full">
        Annulla modifica
      </Button>
    </div>
  );
}

function RequestBox({ token, horizon, onBack, onDone }: { token: string; horizon: number; onBack: () => void; onDone: (d: Done) => void }) {
  const today = romeToday();
  const [date, setDate] = useState('');
  const [win, setWin] = useState('indifferente');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.manageRequest(token, date || null, win, notes.trim() || null);
      onDone({ kind: 'requested', email: r.email, code: r.request_code });
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rise mt-8 space-y-4">
      <StepTitle>Quando preferiresti?</StepTitle>
      <p className="text-sm text-ink-soft">Il salone ti ricontatterà. L'appuntamento attuale resta valido finché non viene confermato il nuovo orario.</p>
      <Input label="Giorno preferito (facoltativo)" type="date" min={today} max={addDays(today, horizon)} value={date} onChange={(e) => setDate(e.target.value)} />
      <Select label="Fascia oraria" value={win} onChange={(e) => setWin(e.target.value)}>
        <option value="indifferente">Indifferente</option>
        <option value="mattina">Mattina</option>
        <option value="pomeriggio">Pomeriggio</option>
      </Select>
      <Textarea label="Note (facoltative)" hint="Esigenze organizzative. Non inserire informazioni sulla salute." maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <Alert>{err}</Alert>}
      <Button busy={busy} onClick={submit} className="w-full">
        Invia richiesta di spostamento
      </Button>
      <Button variant="ghost" onClick={onBack} className="w-full">
        Torna indietro
      </Button>
    </div>
  );
}

function Outcome({ done, phone }: { done: Done; phone: string | null }) {
  const title = done.kind === 'cancelled' ? 'Appuntamento annullato' : done.kind === 'moved' ? 'Appuntamento spostato' : 'Richiesta inviata';
  return (
    <section className="rise text-center" aria-live="polite">
      <h1 className="font-display text-[32px] leading-tight">{title}</h1>
      {done.kind === 'moved' && done.startsAt && (
        <p className="mt-4 text-[15px]">
          Nuovo orario: {formatLongDate(done.startsAt)}, ore {formatTime(done.startsAt)}
        </p>
      )}
      {done.kind === 'requested' && (
        <p className="mx-auto mt-4 max-w-sm text-[15px] text-ink-soft">
          Il salone ti contatterà per il nuovo orario. Fino ad allora il tuo appuntamento resta valido. Riferimento {done.code}.
        </p>
      )}
      <EmailNote
        email={done.email}
        sentText={done.kind === 'moved' ? "Ti abbiamo inviato un'email con il nuovo orario e un nuovo link personale." : "Ti abbiamo inviato un'email di conferma."}
        savedText={done.kind === 'cancelled' ? "l'annullamento è comunque registrato" : done.kind === 'moved' ? 'lo spostamento è comunque registrato' : 'la richiesta è comunque registrata'}
      />
      <p className="mx-auto mt-3 max-w-sm text-xs text-taupe">
        Per sicurezza questo link non è più valido{done.kind === 'moved' ? ': usa quello nella nuova email' : ''}.
        {phone ? ` Per informazioni: ${phone}.` : ''}
      </p>
    </section>
  );
}
