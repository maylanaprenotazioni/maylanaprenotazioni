/**
 * MaylanaAIChat — assistente virtuale della pagina di prenotazione.
 *
 * Regole di funzionamento:
 *  - Comunica SOLO con /api/ai/chat (nessuna chiave o modello nel browser).
 *  - Servizi, prezzi e orari mostrati nelle card arrivano dal server (database),
 *    mai dal testo del modello.
 *  - I dati personali si inseriscono in un modulo e vanno DIRETTAMENTE a
 *    /api/book o /api/request (il backend esistente), non al fornitore AI.
 *  - "Il tuo appuntamento è confermato." compare solo dopo l'esito reale
 *    del server; le consulenze restano richieste in attesa di approvazione.
 *  - La conversazione resta solo in memoria (nessuna cache, nessuno storage).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type EmailOutcome } from '../../lib/api';
import type { AiAction, AiCard, AiHistoryItem, AiServiceCard } from '../../lib/ai-types';
import type { BookedAppointment, Catalog } from '../../lib/types';
import { addDays, formatCalendarDate, formatDuration, formatLongDate, formatPrice, formatTime, romeToday } from '../../lib/time';
import { newIdempotencyKey } from '../../lib/bundle';
import { buildIcs, downloadIcs } from '../../lib/ics';
import { customerMessages, waLink } from '../../lib/whatsapp';
import { useOnline } from '../Online';
import { cx, Spinner } from '../ui';

export type ChatContext = 'booking' | 'services' | 'consulenze';

type Msg = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  cards?: AiCard[];
  quick?: string[];
  failed?: boolean;
};

type Suggestion = { label: string; message?: string; action?: AiAction; local?: 'contact' };

const SUGGESTIONS: Suggestion[] = [
  { label: 'Prenota un taglio', message: 'Vorrei prenotare un taglio' },
  { label: 'Taglio e piega', message: 'Vorrei prenotare taglio e piega' },
  { label: 'Consulenza Capelli For You', action: { type: 'consultation', serviceId: null } },
  { label: 'Prezzi dei servizi', action: { type: 'prices' } },
  { label: 'Contatta il salone', local: 'contact' },
];

const looksEnglish = (s: string) => /\b(hello|hi|please|appointment|book|haircut|price|how much|thank|english)\b/i.test(s);

let nextId = 1;

export default function MaylanaAIChat({
  catalog,
  welcome,
  maxInputChars,
  context,
  lifted,
  onOpenForm,
}: {
  catalog: Catalog;
  welcome: string;
  maxInputChars: number;
  context: ChatContext;
  /** Alza il pulsante quando in basso c'è la barra del totale. */
  lifted?: boolean;
  /** Collega la chat al modulo tradizionale con i servizi già scelti. */
  onOpenForm: (serviceIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ id: nextId++, role: 'assistant', text: welcome }]);
  const [history, setHistory] = useState<AiHistoryItem[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [lang, setLang] = useState<'it' | 'en'>('it');
  const online = useOnline();
  const panelId = useId();
  const titleId = useId();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => {
    if (context !== 'consulenze') return SUGGESTIONS;
    const c = SUGGESTIONS.find((s) => s.label.startsWith('Consulenza'))!;
    return [c, ...SUGGESTIONS.filter((s) => s !== c)];
  }, [context]);

  // Focus all'apertura, ritorno al pulsante alla chiusura
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);
  const close = useCallback(() => {
    setOpen(false);
    setTimeout(() => launcherRef.current?.focus(), 0);
  }, []);

  // Nuova risposta: si mostra dal suo inizio (le card possono essere lunghe); altrimenti in fondo.
  useEffect(() => {
    const last = msgs[msgs.length - 1];
    const el = last && last.role === 'assistant' && msgs.length > 1 ? panelRef.current?.querySelector(`[data-msg="${last.id}"]`) : null;
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [msgs, busy]);

  // Escape chiude; Tab resta dentro la finestra (focus trap)
  const onKeyDown = (e: { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]):not([tabindex="-1"]), select, textarea:not([disabled])')].filter(
      (el) => el.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const push = (m: Omit<Msg, 'id'>) => setMsgs((list) => [...list, { ...m, id: nextId++ }]);

  const send = useCallback(
    async (payload: { message?: string; action?: AiAction; label?: string }) => {
      if (busy) return;
      if (!online) {
        push({ role: 'assistant', text: 'Sei offline: per usare l\'assistente serve la connessione a Internet.', failed: true });
        return;
      }
      const shown = payload.message ?? payload.label;
      if (shown) push({ role: 'user', text: shown });
      let l = lang;
      if (payload.message && looksEnglish(payload.message)) {
        l = 'en';
        setLang('en');
      }
      setBusy(true);
      try {
        const r = await api.aiChat({ sessionToken: token, message: payload.message, action: payload.action, history, lang: l });
        setToken(r.sessionToken);
        // Cronologia firmata dal server; una nuova sessione azzera la precedente.
        setHistory((h) => {
          const base = r.sessionToken !== token ? [] : h;
          return [...base, ...(r.user ? [r.user] : []), r.reply].slice(-8);
        });
        push({ role: 'assistant', text: r.reply.text, cards: r.cards, quick: r.quickReplies });
      } catch (e) {
        const err = e as ApiError;
        push({
          role: 'assistant',
          text:
            err.code === 'RATE_LIMITED'
              ? 'Hai inviato molti messaggi in poco tempo. Attendi qualche minuto oppure usa il modulo di prenotazione.'
              : err.message || 'Maylana AI non è disponibile in questo momento. Puoi prenotare con il modulo della pagina.',
          cards: [{ type: 'contact' }],
          failed: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, online, token, history, lang],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = input.trim();
    if (!t || busy) return;
    setInput('');
    void send({ message: t.slice(0, maxInputChars) });
  };

  const useSuggestion = (s: Suggestion) => {
    if (s.local === 'contact') {
      push({ role: 'user', text: s.label });
      push({ role: 'assistant', text: 'Ecco come contattare direttamente Maylana.', cards: [{ type: 'contact' }] });
      return;
    }
    void send(s.message ? { message: s.message } : { action: s.action, label: s.label });
  };

  const talkToSalon = () => {
    push({ role: 'assistant', text: 'Ecco come parlare direttamente con Maylana.', cards: [{ type: 'contact' }] });
  };

  const showSuggestions = msgs.length === 1;
  const remaining = maxInputChars - input.length;

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
        className={cx(
          'fixed right-4 z-40 flex min-h-12 items-center gap-2 rounded-full border border-champagne/60 bg-ink px-4 text-[14px] font-medium text-ivory shadow-lg shadow-ink/15 transition-[bottom] hover:bg-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne-deep',
          lifted ? 'bottom-24' : 'bottom-5',
          open && 'hidden sm:flex',
        )}
      >
        <Sparkle />
        <span>{open ? 'Chiudi assistente' : 'Maylana AI'}</span>
      </button>

      {open && (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 flex flex-col bg-ivory sm:inset-auto sm:bottom-20 sm:right-4 sm:h-[min(680px,calc(100dvh-7rem))] sm:w-[400px] sm:rounded-3xl sm:border sm:border-line sm:shadow-2xl sm:shadow-ink/20"
        >
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="min-w-0">
              <h2 id={titleId} className="font-display text-xl leading-tight">
                Maylana AI
              </h2>
              <p className="text-xs text-taupe">Assistente virtuale, non una persona</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={talkToSalon} className="min-h-10 rounded-full px-3 text-sm text-champagne-deep hover:bg-champagne-wash">
                Parla con Maylana
              </button>
              <button type="button" onClick={close} aria-label="Chiudi l'assistente" className="grid size-10 place-items-center rounded-full text-ink-soft hover:bg-champagne-wash">
                <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            <p className="mb-4 rounded-2xl bg-champagne-wash/60 px-3 py-2 text-xs leading-relaxed text-ink-soft">
              Le risposte sono generate con l'intelligenza artificiale (fornitore OpenAI) e possono contenere imprecisioni: servizi, prezzi e orari nelle schede provengono dal sistema del salone. Non scrivere in chat
              dati sulla salute, foto o dati personali: nome e recapiti si inseriscono solo nel modulo di conferma.
              {catalog.settings.privacy_url && (
                <>
                  {' '}
                  <a href={catalog.settings.privacy_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    Informativa privacy
                  </a>
                </>
              )}
            </p>

            <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversazione con Maylana AI" className="space-y-4">
              {msgs.map((m) => (
                <MessageView key={m.id} m={m} catalog={catalog} busy={busy} send={send} onOpenForm={onOpenForm} closeChat={close} />
              ))}
            </div>

            {showSuggestions && (
              <div className="mt-4 flex flex-wrap gap-2" aria-label="Suggerimenti">
                {suggestions.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    disabled={busy}
                    onClick={() => useSuggestion(s)}
                    className="min-h-10 rounded-full border border-line bg-paper px-3.5 text-sm hover:border-champagne-deep disabled:opacity-50"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}

            {busy && (
              <div role="status" className="mt-4 flex items-center gap-2 text-sm text-taupe">
                <Spinner small />
                Maylana AI sta scrivendo…
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={submit} className="border-t border-line bg-ivory px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            {!online && <p className="mb-2 text-xs text-danger">Sei offline: l'assistente non è disponibile.</p>}
            <div className="flex items-end gap-2">
              <label htmlFor={`${panelId}-input`} className="sr-only">
                Scrivi un messaggio a Maylana AI
              </label>
              <textarea
                id={`${panelId}-input`}
                ref={inputRef}
                rows={1}
                value={input}
                maxLength={maxInputChars}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit(e as unknown as FormEvent);
                  }
                }}
                placeholder="Scrivi un messaggio…"
                aria-describedby={`${panelId}-count`}
                className="max-h-32 min-h-12 flex-1 resize-none rounded-2xl border border-line bg-paper px-4 py-3 text-[15px] focus:border-ink focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !input.trim() || !online}
                aria-label="Invia messaggio"
                className="grid size-12 shrink-0 place-items-center rounded-full bg-ink text-ivory disabled:bg-taupe/50"
              >
                <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
                  <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor" />
                </svg>
              </button>
            </div>
            <p id={`${panelId}-count`} className={cx('mt-1 text-right text-[11px]', remaining < 40 ? 'text-danger' : 'text-taupe')}>
              {remaining < 100 ? `${remaining} caratteri rimasti` : ' '}
            </p>
          </form>
        </div>
      )}
    </>
  );
}

function Sparkle() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-champagne" aria-hidden="true">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" fill="currentColor" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" fill="currentColor" opacity=".7" />
    </svg>
  );
}

/* ================================================================== */
/* Messaggi e card                                                     */
/* ================================================================== */

type Send = (p: { message?: string; action?: AiAction; label?: string }) => Promise<void>;

function MessageView({ m, catalog, busy, send, onOpenForm, closeChat }: { m: Msg; catalog: Catalog; busy: boolean; send: Send; onOpenForm: (ids: string[]) => void; closeChat: () => void }) {
  const mine = m.role === 'user';
  return (
    <div data-msg={m.id} className={cx('flex scroll-mt-3 flex-col', mine ? 'items-end' : 'items-start')}>
      <div
        className={cx(
          'max-w-[88%] whitespace-pre-line rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed',
          mine ? 'rounded-br-md bg-ink text-ivory' : m.failed ? 'rounded-bl-md border border-danger/30 bg-danger/5' : 'rounded-bl-md border border-line bg-paper',
        )}
      >
        <span className="sr-only">{mine ? 'Tu: ' : 'Maylana AI: '}</span>
        {m.text}
      </div>
      {m.cards?.map((c, i) => (
        <div key={i} className="mt-2 w-full">
          <CardView card={c} catalog={catalog} busy={busy} send={send} onOpenForm={onOpenForm} closeChat={closeChat} />
        </div>
      ))}
      {!!m.quick?.length && (
        <div className="mt-2 flex flex-wrap gap-2">
          {m.quick.map((q) => (
            <button key={q} type="button" disabled={busy} onClick={() => void send({ message: q })} className="min-h-10 rounded-full border border-line bg-paper px-3.5 text-sm hover:border-champagne-deep disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CardShell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-paper p-3.5" aria-label={title}>
      {title && <h3 className="mb-2 text-sm font-medium">{title}</h3>}
      {children}
    </section>
  );
}

const price = (cents: number | null, from: boolean) => (cents === null ? 'Prezzo in salone' : formatPrice(cents, from));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function CardView(props: { card: AiCard; catalog: Catalog; busy: boolean; send: Send; onOpenForm: (ids: string[]) => void; closeChat: () => void }) {
  const { card } = props;
  switch (card.type) {
    case 'services':
      return <ServicesCard services={card.services} {...props} />;
    case 'slots':
      return <SlotsCard {...props} card={card} />;
    case 'booking':
      return <BookingCard {...props} card={card} />;
    case 'request':
      return <RequestCard {...props} card={card} />;
    case 'contact':
      return <ContactCard catalog={props.catalog} />;
    case 'open_form':
      return (
        <button type="button" className="min-h-10 rounded-full border border-ink/70 px-4 text-sm" onClick={() => (props.closeChat(), props.onOpenForm(card.serviceIds))}>
          Continua nel modulo di prenotazione
        </button>
      );
  }
}

/** Giorni selezionabili (solo date: gli orari li calcola sempre il server). */
function DayPicker({ horizon, onPick, disabled, label = 'Scegli il giorno' }: { horizon: number; onPick: (d: string) => void; disabled?: boolean; label?: string }) {
  const today = romeToday();
  const days = Array.from({ length: Math.min(14, horizon) }, (_, i) => addDays(today, i));
  return (
    <div>
      <p className="mb-1.5 text-xs text-taupe">{label}</p>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {days.map((d) => (
          <button
            key={d}
            type="button"
            disabled={disabled}
            onClick={() => onPick(d)}
            className="flex min-h-12 min-w-12 shrink-0 flex-col items-center justify-center rounded-xl border border-line bg-ivory px-2 text-xs hover:border-champagne-deep disabled:opacity-50"
            aria-label={capitalize(formatCalendarDate(d, { weekday: 'long', day: 'numeric', month: 'long' }))}
          >
            <span className="text-taupe">{formatCalendarDate(d, { weekday: 'short' })}</span>
            <span className="text-[15px]">{formatCalendarDate(d, { day: 'numeric' })}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ServicesCard({ services, catalog, busy, send, onOpenForm, closeChat }: { services: AiServiceCard[]; catalog: Catalog; busy: boolean; send: Send; onOpenForm: (ids: string[]) => void; closeChat: () => void }) {
  const [picking, setPicking] = useState<string | null>(null);
  return (
    <CardShell title="Servizi">
      <ul className="divide-y divide-line">
        {services.map((s) => (
          <li key={s.id} className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium">{s.name}</p>
              <p className="shrink-0 text-sm tabular-nums">{price(s.priceCents, s.priceFrom)}</p>
            </div>
            <p className="text-xs text-taupe">
              {s.durationMinutes ? formatDuration(s.durationMinutes) : 'Durata da definire'}
              {s.bookable === 'request' && ' · su richiesta, da approvare'}
            </p>
            {s.description && <p className="mt-1 text-sm text-ink-soft">{s.description}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {s.bookable === 'online' ? (
                <button type="button" disabled={busy} onClick={() => setPicking(picking === s.id ? null : s.id)} className="min-h-9 rounded-full bg-ink px-3.5 text-sm text-ivory disabled:opacity-50">
                  Cerca orari
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => void send({ action: { type: 'consultation', serviceId: s.id }, label: `Richiedi: ${s.name}` })} className="min-h-9 rounded-full bg-ink px-3.5 text-sm text-ivory disabled:opacity-50">
                  Invia una richiesta
                </button>
              )}
              <button type="button" onClick={() => (closeChat(), onOpenForm([s.id]))} className="min-h-9 rounded-full border border-line px-3.5 text-sm">
                Apri nel modulo
              </button>
            </div>
            {picking === s.id && (
              <div className="mt-3">
                <DayPicker
                  horizon={catalog.settings.booking_horizon_days}
                  disabled={busy}
                  onPick={(d) => {
                    setPicking(null);
                    void send({ action: { type: 'availability', serviceIds: [s.id], date: d, staffId: null }, label: `${s.name}, ${formatCalendarDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}` });
                  }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function SlotsCard({ card, catalog, busy, send }: { card: Extract<AiCard, { type: 'slots' }>; catalog: Catalog; busy: boolean; send: Send }) {
  const [otherDay, setOtherDay] = useState(false);
  const rec = card.times.filter((t) => t.recommended);
  const rest = card.times.filter((t) => !t.recommended);
  const pick = (startsAt: string) =>
    void send({ action: { type: 'select_slot', serviceIds: card.serviceIds, startsAt, staffId: card.staffId }, label: `Scelgo le ${formatTime(startsAt)}` });
  const TimeBtn = ({ t, gold }: { t: (typeof card.times)[number]; gold?: boolean }) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => pick(t.startsAt)}
      className={cx('min-h-11 rounded-xl border px-3 text-[15px] tabular-nums disabled:opacity-50', gold ? 'border-champagne-deep bg-champagne-wash' : 'border-line bg-ivory hover:border-ink')}
      aria-label={`${formatTime(t.startsAt)}${gold ? ', consigliato' : ''}`}
    >
      {formatTime(t.startsAt)}
    </button>
  );
  return (
    <CardShell title={`${card.label} · ${capitalize(formatCalendarDate(card.date, { weekday: 'long', day: 'numeric', month: 'long' }))}`}>
      <p className="-mt-1 mb-3 text-xs text-taupe">
        Durata {formatDuration(card.durationMinutes)} · {price(card.priceCents, card.priceIsEstimate)}
        {card.priceIsEstimate && card.priceCents !== null && ' (indicativo)'}
      </p>
      {rec.length > 0 && (
        <>
          <p className="mb-1.5 text-xs text-champagne-deep">Consigliati</p>
          <div className="mb-3 grid grid-cols-4 gap-2">
            {rec.map((t) => (
              <TimeBtn key={t.startsAt} t={t} gold />
            ))}
          </div>
        </>
      )}
      {rest.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {rest.map((t) => (
            <TimeBtn key={t.startsAt} t={t} />
          ))}
        </div>
      )}
      <button type="button" onClick={() => setOtherDay((v) => !v)} className="mt-3 text-sm text-champagne-deep underline-offset-4 hover:underline">
        Un altro giorno
      </button>
      {otherDay && (
        <div className="mt-2">
          <DayPicker
            horizon={catalog.settings.booking_horizon_days}
            disabled={busy}
            onPick={(d) => {
              setOtherDay(false);
              void send({ action: { type: 'availability', serviceIds: card.serviceIds, date: d, staffId: card.staffId }, label: capitalize(formatCalendarDate(d, { weekday: 'long', day: 'numeric', month: 'long' })) });
            }}
          />
        </div>
      )}
    </CardShell>
  );
}

/* ------------------------- modulo dati sicuro ------------------------- */

type Contact = { firstName: string; lastName: string; phone: string; email: string; privacy: boolean; marketing: boolean; website: string };
const emptyContact: Contact = { firstName: '', lastName: '', phone: '', email: '', privacy: false, marketing: false, website: '' };

function validateContact(c: Contact): string | null {
  if (!c.firstName.trim() || !c.lastName.trim()) return 'Inserisci nome e cognome.';
  if (c.phone.replace(/\D/g, '').length < 6) return 'Inserisci un numero di telefono valido.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email.trim())) return 'Inserisci un indirizzo email valido.';
  if (!c.privacy) return "Per continuare accetta l'informativa privacy.";
  return null;
}

function ContactFields({ value, onChange, catalog, consultation }: { value: Contact; onChange: (c: Contact) => void; catalog: Catalog; consultation?: boolean }) {
  const id = useId();
  const set = <K extends keyof Contact>(k: K, v: Contact[K]) => onChange({ ...value, [k]: v });
  const field = (k: 'firstName' | 'lastName' | 'phone' | 'email', label: string, extra: Record<string, unknown>) => (
    <div>
      <label htmlFor={`${id}-${k}`} className="mb-1 block text-xs text-ink-soft">
        {label}
      </label>
      <input
        id={`${id}-${k}`}
        value={value[k]}
        onChange={(e) => set(k, e.target.value)}
        required
        className="min-h-11 w-full rounded-xl border border-line bg-ivory px-3 text-[15px] focus:border-ink focus:outline-none"
        {...extra}
      />
    </div>
  );
  return (
    <div className="space-y-2.5">
      <p className="text-xs text-taupe">I dati vanno direttamente al sistema di prenotazione del salone, non all'assistente AI.</p>
      <div className="grid grid-cols-2 gap-2">
        {field('firstName', 'Nome', { autoComplete: 'given-name', maxLength: 60 })}
        {field('lastName', 'Cognome', { autoComplete: 'family-name', maxLength: 60 })}
      </div>
      {field('phone', 'Telefono', { type: 'tel', inputMode: 'tel', autoComplete: 'tel', maxLength: 40 })}
      {field('email', 'Email', { type: 'email', inputMode: 'email', autoComplete: 'email', maxLength: 200 })}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
        <label>
          Sito web
          <input tabIndex={-1} autoComplete="off" value={value.website} onChange={(e) => set('website', e.target.value)} />
        </label>
      </div>
      <label className="flex items-start gap-2.5 text-[13px] leading-relaxed">
        <input type="checkbox" checked={value.privacy} onChange={(e) => set('privacy', e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-ink" />
        <span>
          Ho letto l'
          {catalog.settings.privacy_url ? (
            <a href={catalog.settings.privacy_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              informativa privacy
            </a>
          ) : (
            'informativa privacy'
          )}{' '}
          e acconsento al trattamento dei dati per gestire {consultation ? 'la richiesta' : "l'appuntamento"}. <span className="text-taupe">(obbligatorio)</span>
        </span>
      </label>
      <label className="flex items-start gap-2.5 text-[13px] leading-relaxed">
        <input type="checkbox" checked={value.marketing} onChange={(e) => set('marketing', e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-ink" />
        <span>
          Desidero ricevere novità e promozioni. <span className="text-taupe">(facoltativo)</span>
        </span>
      </label>
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

function BookingCard({ card, catalog, send }: { card: Extract<AiCard, { type: 'booking' }>; catalog: Catalog; busy: boolean; send: Send }) {
  const [contact, setContact] = useState<Contact>(emptyContact);
  const [error, setError] = useState<string | null>(null);
  const [slotGone, setSlotGone] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ appt: BookedAppointment; email: EmailOutcome } | null>(null);
  const startedAt = useRef(Date.now());
  const key = useRef(newIdempotencyKey()); // stessa chiave per i reinvii dello stesso riepilogo
  const s = catalog.settings;

  if (done) {
    const a = done.appt;
    return (
      <CardShell>
        <div role="status">
          <p className="font-display text-lg text-ok">Il tuo appuntamento è confermato.</p>
          <p className="mt-1 text-sm">
            Codice <span className="font-medium tracking-wider">{a.code}</span>
          </p>
          <p className="mt-2 text-[15px]">{a.service_name}</p>
          <p className="text-sm">
            {capitalize(formatLongDate(a.starts_at))}, ore {formatTime(a.starts_at)} · {formatDuration(a.duration_minutes)}
          </p>
          <p className="text-sm text-taupe">con {a.staff_name}</p>
          <p className="mt-2 text-xs text-ink-soft">
            {done.email === 'sent'
              ? "Ti abbiamo inviato un'email con i dettagli e il link per gestire l'appuntamento."
              : "L'email di conferma non è partita subito: conserva il codice, la prenotazione è comunque registrata."}
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="min-h-10 rounded-full border border-ink/70 px-4 text-sm"
            onClick={() =>
              downloadIcs(`maylana-${a.code}.ics`, buildIcs({ uid: a.code, title: `${s.business_name}: ${a.service_name}`, startsAt: a.starts_at, endsAt: a.ends_at, location: s.address, description: `Riferimento ${a.code}` }))
            }
          >
            Aggiungi al calendario
          </button>
          {s.whatsapp_number && (
            <a href={waLink(s.whatsapp_number, customerMessages.aboutBooking(a.code, a.starts_at))} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm">
              WhatsApp
            </a>
          )}
        </div>
      </CardShell>
    );
  }

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const v = validateContact(contact);
    if (v) return setError(v);
    setError(null);
    setSending(true);
    try {
      const r = await api.book({
        serviceIds: card.serviceIds,
        staffId: card.staffId,
        startsAt: card.startsAt,
        firstName: contact.firstName.trim(),
        lastName: contact.lastName.trim(),
        phone: contact.phone.trim(),
        email: contact.email.trim(),
        notes: null,
        privacyAccepted: true,
        marketingConsent: contact.marketing,
        website: contact.website,
        formStartedAt: startedAt.current,
        idempotencyKey: key.current,
      });
      setDone({ appt: r.appointment, email: r.email }); // solo con un appuntamento realmente salvato (api.book lo verifica)
    } catch (err) {
      const x = err as ApiError;
      if (x.code === 'SLOT_UNAVAILABLE') setSlotGone(true);
      setError(x.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <CardShell title="Riepilogo dell'appuntamento">
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-taupe">Servizi</dt>
        <dd>{card.label}</dd>
        <dt className="text-taupe">Quando</dt>
        <dd>
          {capitalize(formatLongDate(card.startsAt))}, ore {formatTime(card.startsAt)}
        </dd>
        <dt className="text-taupe">Durata</dt>
        <dd>{formatDuration(card.durationMinutes)}</dd>
        <dt className="text-taupe">Prezzo</dt>
        <dd>
          {price(card.priceCents, card.priceIsEstimate)}
          {card.priceIsEstimate && card.priceCents !== null && ' (indicativo)'}
        </dd>
        <dt className="text-taupe">Operatore</dt>
        <dd>{card.staffName ?? 'In base alla disponibilità'}</dd>
        <dt className="text-taupe">Stato</dt>
        <dd>Da confermare</dd>
      </dl>
      <form onSubmit={confirm} noValidate className="space-y-3">
        <ContactFields value={contact} onChange={(c) => (setContact(c), setError(null))} catalog={catalog} />
        {error && <ErrorLine>{error}</ErrorLine>}
        {slotGone ? (
          <button
            type="button"
            className="min-h-11 w-full rounded-full border border-ink/70 text-sm"
            onClick={() => void send({ action: { type: 'availability', serviceIds: card.serviceIds, date: romeDate(card.startsAt), staffId: card.staffId }, label: 'Vedi altri orari' })}
          >
            Vedi altri orari
          </button>
        ) : (
          <button type="submit" disabled={sending} aria-busy={sending || undefined} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-medium text-ivory disabled:bg-taupe/50">
            {sending && <Spinner small />}
            Conferma prenotazione
          </button>
        )}
      </form>
    </CardShell>
  );
}

/** Data di calendario a Roma di un istante. */
function romeDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function RequestCard({ card, catalog }: { card: Extract<AiCard, { type: 'request' }>; catalog: Catalog; busy: boolean; send: Send }) {
  const [contact, setContact] = useState<Contact>(emptyContact);
  const [date, setDate] = useState(card.preferredDate ?? '');
  const [win, setWin] = useState(card.timeWindow);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ code: string; email: EmailOutcome } | null>(null);
  const startedAt = useRef(Date.now());
  const key = useRef(newIdempotencyKey());
  const id = useId();

  if (done) {
    return (
      <CardShell>
        <div role="status">
          <p className="font-display text-lg text-champagne-deep">Richiesta inviata, in attesa di approvazione</p>
          <p className="mt-1 text-sm">
            Codice richiesta <span className="font-medium tracking-wider">{done.code}</span>
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            Non è ancora un appuntamento: Maylana deve approvare la richiesta e ti ricontatterà con la conferma o una proposta di data.
          </p>
          <p className="mt-2 text-xs text-ink-soft">
            {done.email === 'sent' ? "Ti abbiamo inviato un'email di riepilogo." : "L'email di riepilogo non è partita subito: la richiesta è comunque registrata."}
          </p>
        </div>
      </CardShell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const v = validateContact(contact);
    if (v) return setError(v);
    setError(null);
    setSending(true);
    try {
      const r = await api.request({
        serviceIds: card.serviceIds,
        preferredDate: date || null,
        preferredTimeWindow: win,
        preferredStaffId: null,
        firstName: contact.firstName.trim(),
        lastName: contact.lastName.trim(),
        phone: contact.phone.trim(),
        email: contact.email.trim(),
        notes: null,
        privacyAccepted: true,
        marketingConsent: contact.marketing,
        website: contact.website,
        formStartedAt: startedAt.current,
        idempotencyKey: key.current,
      });
      setDone({ code: r.code, email: r.email });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <CardShell title={card.isConsultation ? 'Richiesta di consulenza Capelli For You' : 'Richiesta al salone'}>
      <p className="-mt-1 mb-3 text-sm">{card.label}</p>
      <form onSubmit={submit} noValidate className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={`${id}-d`} className="mb-1 block text-xs text-ink-soft">
              Data preferita
            </label>
            <select id={`${id}-d`} value={date} onChange={(e) => setDate(e.target.value)} className="min-h-11 w-full rounded-xl border border-line bg-ivory px-2 text-sm">
              <option value="">Nessuna preferenza</option>
              {card.dates.map((d) => (
                <option key={d} value={d}>
                  {capitalize(formatCalendarDate(d, { weekday: 'short', day: 'numeric', month: 'short' }))}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-w`} className="mb-1 block text-xs text-ink-soft">
              Fascia
            </label>
            <select id={`${id}-w`} value={win} onChange={(e) => setWin(e.target.value as typeof win)} className="min-h-11 w-full rounded-xl border border-line bg-ivory px-2 text-sm">
              <option value="indifferente">Indifferente</option>
              <option value="mattina">Mattina</option>
              <option value="pomeriggio">Pomeriggio</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-taupe">Le date sono indicative: la data definitiva la conferma Maylana. Non indicare informazioni sulla salute.</p>
        <ContactFields value={contact} onChange={(c) => (setContact(c), setError(null))} catalog={catalog} consultation />
        {error && <ErrorLine>{error}</ErrorLine>}
        <button type="submit" disabled={sending} aria-busy={sending || undefined} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-medium text-ivory disabled:bg-taupe/50">
          {sending && <Spinner small />}
          Invia la richiesta
        </button>
      </form>
    </CardShell>
  );
}

function ContactCard({ catalog }: { catalog: Catalog }) {
  const s = catalog.settings;
  const btn = 'inline-flex min-h-10 items-center rounded-full border border-line bg-ivory px-4 text-sm hover:border-ink';
  const none = !s.contact_phone && !s.contact_email && !s.whatsapp_number;
  return (
    <CardShell title={`Contatta ${s.business_name}`}>
      {none ? (
        <p className="text-sm text-ink-soft">I recapiti non sono ancora disponibili online.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {s.contact_phone && (
            <a className={btn} href={`tel:${s.contact_phone.replace(/\s/g, '')}`}>
              Chiama {s.contact_phone}
            </a>
          )}
          {s.whatsapp_number && (
            <a className={btn} href={waLink(s.whatsapp_number, customerMessages.general())} target="_blank" rel="noreferrer">
              WhatsApp
            </a>
          )}
          {s.contact_email && (
            <a className={btn} href={`mailto:${s.contact_email}`}>
              Email
            </a>
          )}
        </div>
      )}
      {s.address && <p className="mt-2 text-xs text-taupe">{s.address}</p>}
    </CardShell>
  );
}
