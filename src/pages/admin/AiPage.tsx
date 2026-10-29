/**
 * Dashboard → Maylana AI (solo titolare)
 *  - stato della configurazione server (senza mai mostrare la chiave)
 *  - attivazione, messaggio iniziale, limiti, prezzi per la stima dei costi
 *  - FAQ approvate (le uniche informazioni "libere" che l'assistente può usare)
 *  - consumi aggregati e costi stimati
 * Tutte le scritture passano dalla RLS di Supabase (ruolo owner).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import { api } from '../../lib/api';
import { Alert, Badge, Button, EmptyState, Input, Select, Spinner, Textarea } from '../../components/ui';
import { useAdmin } from './context';

type AiSettings = {
  enabled: boolean;
  welcome_message: string;
  daily_request_limit: number;
  daily_token_limit: number;
  daily_cost_limit_usd: number | null;
  session_message_limit: number;
  session_ttl_minutes: number;
  max_input_chars: number;
  max_output_tokens: number;
  input_price_per_mtok_usd: number | null;
  output_price_per_mtok_usd: number | null;
};

type Faq = { id: string; topic: string; language: 'it' | 'en'; question: string; answer: string; keywords: string[]; active: boolean; sort_order: number };

type Usage = {
  day: string;
  turns: number;
  model_turns: number;
  model_calls: number;
  local_answers: number;
  input_tokens: number;
  output_tokens: number;
  errors: number;
  blocked: number;
  est_cost_usd: number;
};

const TOPICS: Record<string, string> = {
  generale: 'Generale',
  servizi: 'Servizi',
  prezzi: 'Prezzi',
  prenotazioni: 'Prenotazioni',
  capelli_for_you: 'Capelli For You',
  contatti: 'Contatti e orari',
  altro: 'Altro',
};

const num = (v: string) => (v.trim() === '' ? null : Number(v));
const usd = (v: number) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(v);
const int = (v: number) => new Intl.NumberFormat('it-IT').format(v);

export default function AiPage() {
  const { toast } = useAdmin();
  const [s, setS] = useState<AiSettings | null>(null);
  const [server, setServer] = useState<{ configured: boolean; model: string | null; problems: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase!
      .from('ai_settings')
      .select('*')
      .eq('id', 1)
      .single()
      .then(({ data, error: e }) => {
        if (e) setError(dbMessage(e));
        else setS(data as AiSettings);
      });
    supabase!.auth.getSession().then(async ({ data }) => {
      try {
        const r = await api.adminStatus(data.session?.access_token ?? '');
        setServer(r.ai ?? { configured: false, model: null, problems: ['Stato non disponibile: aggiorna le funzioni server'] });
      } catch {
        setServer({ configured: false, model: null, problems: ['Funzioni server non raggiungibili'] });
      }
    });
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!s) return <Spinner />;

  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setS({ ...s, [k]: v });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error: err } = await supabase!
      .from('ai_settings')
      .update({
        enabled: s.enabled,
        welcome_message: s.welcome_message.trim(),
        daily_request_limit: Number(s.daily_request_limit),
        daily_token_limit: Number(s.daily_token_limit),
        daily_cost_limit_usd: s.daily_cost_limit_usd,
        session_message_limit: Number(s.session_message_limit),
        session_ttl_minutes: Number(s.session_ttl_minutes),
        max_input_chars: Number(s.max_input_chars),
        max_output_tokens: Number(s.max_output_tokens),
        input_price_per_mtok_usd: s.input_price_per_mtok_usd,
        output_price_per_mtok_usd: s.output_price_per_mtok_usd,
      })
      .eq('id', 1);
    setBusy(false);
    if (err) toast(dbMessage(err), 'error');
    else toast('Impostazioni di Maylana AI salvate.');
  };

  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <h2 className="font-display text-2xl">Maylana AI</h2>
        {server === null ? (
          <Spinner small />
        ) : server.configured ? (
          <Alert tone="ok">
            Collegamento OpenAI configurato sul server{server.model ? ` (modello ${server.model})` : ''}. La chiave non è mai visibile né inviata al browser.
          </Alert>
        ) : (
          <Alert tone="info">
            OpenAI non è configurato sul server: l'assistente resta nascosto ai clienti anche se lo attivi qui.
            <ul className="mt-1 list-disc pl-5 text-sm">
              {server.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            Le variabili si impostano su Netlify (vedi README, sezione Maylana AI).
          </Alert>
        )}
      </section>

      <form onSubmit={save} className="space-y-4 rounded-3xl border border-line bg-paper p-5">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 size-5 accent-ink" checked={s.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span>
            <span className="font-medium">Assistente attivo sulla pagina di prenotazione</span>
            <span className="block text-sm text-taupe">Se lo disattivi, la prenotazione con il modulo continua a funzionare normalmente.</span>
          </span>
        </label>
        <Textarea label="Messaggio iniziale" maxLength={600} rows={4} value={s.welcome_message} onChange={(e) => set('welcome_message', e.target.value)} hint="Deve far capire che si tratta di un assistente virtuale." />

        <h3 className="pt-2 font-medium">Limiti di utilizzo</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Messaggi al modello al giorno (tutti i clienti)" type="number" min={0} value={s.daily_request_limit} onChange={(e) => set('daily_request_limit', Number(e.target.value))} />
          <Input label="Token al giorno (ingresso + uscita)" type="number" min={0} value={s.daily_token_limit} onChange={(e) => set('daily_token_limit', Number(e.target.value))} />
          <Input
            label="Costo stimato massimo al giorno (USD)"
            type="number"
            min={0}
            step="0.01"
            value={s.daily_cost_limit_usd ?? ''}
            onChange={(e) => set('daily_cost_limit_usd', num(e.target.value))}
            hint="Vuoto = nessun limite di costo (restano i limiti sopra). Funziona solo con i prezzi impostati."
          />
          <Input label="Messaggi per conversazione" type="number" min={1} max={200} value={s.session_message_limit} onChange={(e) => set('session_message_limit', Number(e.target.value))} />
          <Input label="Durata conversazione inattiva (minuti)" type="number" min={5} max={1440} value={s.session_ttl_minutes} onChange={(e) => set('session_ttl_minutes', Number(e.target.value))} />
          <Input label="Lunghezza massima messaggio cliente (caratteri)" type="number" min={50} max={2000} value={s.max_input_chars} onChange={(e) => set('max_input_chars', Number(e.target.value))} />
          <Input label="Lunghezza massima risposta (token)" type="number" min={100} max={4000} value={s.max_output_tokens} onChange={(e) => set('max_output_tokens', Number(e.target.value))} />
        </div>

        <h3 className="pt-2 font-medium">Prezzi del modello (per la stima dei costi)</h3>
        <p className="-mt-2 text-sm text-taupe">Copiali dal listino OpenAI del modello in uso. Servono solo per stimare i costi: la fattura effettiva è quella del tuo account OpenAI.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Ingresso, USD per 1 milione di token" type="number" min={0} step="0.0001" value={s.input_price_per_mtok_usd ?? ''} onChange={(e) => set('input_price_per_mtok_usd', num(e.target.value))} />
          <Input label="Uscita, USD per 1 milione di token" type="number" min={0} step="0.0001" value={s.output_price_per_mtok_usd ?? ''} onChange={(e) => set('output_price_per_mtok_usd', num(e.target.value))} />
        </div>
        <Button type="submit" busy={busy}>
          Salva
        </Button>
      </form>

      <FaqEditor />
      <UsageTable />
    </div>
  );
}

/* ------------------------------------------------------------------ */

const emptyFaq = (): Omit<Faq, 'id'> => ({ topic: 'generale', language: 'it', question: '', answer: '', keywords: [], active: true, sort_order: 0 });

function FaqEditor() {
  const { toast } = useAdmin();
  const [list, setList] = useState<Faq[] | null>(null);
  const [edit, setEdit] = useState<(Omit<Faq, 'id'> & { id?: string }) | null>(null);
  const [kw, setKw] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase!.from('ai_faq').select('*').order('topic').order('sort_order').order('created_at');
    if (error) toast(dbMessage(error), 'error');
    setList((data as Faq[]) ?? []);
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (f: (Omit<Faq, 'id'> & { id?: string }) | null) => {
    setEdit(f);
    setKw(f?.keywords.join(', ') ?? '');
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    const row = {
      topic: edit.topic,
      language: edit.language,
      question: edit.question.trim(),
      answer: edit.answer.trim(),
      keywords: kw
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20),
      active: edit.active,
      sort_order: Number(edit.sort_order) || 0,
    };
    const { error } = edit.id ? await supabase!.from('ai_faq').update(row).eq('id', edit.id) : await supabase!.from('ai_faq').insert(row);
    setBusy(false);
    if (error) return toast(dbMessage(error), 'error');
    toast('FAQ salvata.');
    open(null);
    void load();
  };

  const remove = async (f: Faq) => {
    if (!confirm(`Eliminare la FAQ "${f.question}"?`)) return;
    const { error } = await supabase!.from('ai_faq').delete().eq('id', f.id);
    if (error) return toast(dbMessage(error), 'error');
    toast('FAQ eliminata.');
    void load();
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-xl">Informazioni approvate (FAQ)</h3>
        <Button variant="secondary" className="min-h-10" onClick={() => open(emptyFaq())}>
          Nuova FAQ
        </Button>
      </div>
      <p className="text-sm text-taupe">
        Sono le uniche informazioni descrittive che Maylana AI può usare oltre a servizi, prezzi e orari del sistema (es. parcheggio, pagamenti, come funziona la consulenza Capelli For You). Le domande semplici che corrispondono alle
        parole chiave ricevono questa risposta senza chiamare OpenAI. Per Capelli For You scrivi solo contenuti verificati, senza promesse di risultato o indicazioni mediche.
      </p>

      {edit && (
        <form onSubmit={save} className="space-y-3 rounded-3xl border border-champagne/60 bg-paper p-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Select label="Argomento" value={edit.topic} onChange={(e) => setEdit({ ...edit, topic: e.target.value })}>
              {Object.entries(TOPICS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select label="Lingua" value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value as 'it' | 'en' })}>
              <option value="it">Italiano</option>
              <option value="en">Inglese</option>
            </Select>
            <Input label="Ordine" type="number" value={edit.sort_order} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })} />
          </div>
          <Input label="Domanda" maxLength={300} required value={edit.question} onChange={(e) => setEdit({ ...edit, question: e.target.value })} />
          <Textarea label="Risposta approvata" maxLength={1500} rows={5} required value={edit.answer} onChange={(e) => setEdit({ ...edit, answer: e.target.value })} />
          <Input label="Parole chiave (separate da virgola)" value={kw} onChange={(e) => setKw(e.target.value)} hint="Es.: parcheggio, parcheggiare, auto" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-5 accent-ink" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
            Attiva
          </label>
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              Salva FAQ
            </Button>
            <Button type="button" variant="ghost" onClick={() => open(null)}>
              Annulla
            </Button>
          </div>
        </form>
      )}

      {list === null ? (
        <Spinner small />
      ) : list.length === 0 ? (
        <EmptyState>Nessuna FAQ: l'assistente suggerirà di contattare il salone per le informazioni non presenti nel sistema.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-3xl border border-line bg-paper">
          {list.map((f) => (
            <li key={f.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="gold">{TOPICS[f.topic] ?? f.topic}</Badge>
                  {f.language === 'en' && <Badge>EN</Badge>}
                  {!f.active && <Badge tone="muted">Disattiva</Badge>}
                </div>
                <p className="mt-1 font-medium">{f.question}</p>
                <p className="line-clamp-2 text-sm text-ink-soft">{f.answer}</p>
              </div>
              <div className="-ml-3 flex shrink-0 gap-1 sm:ml-0">
                <Button variant="ghost" className="min-h-9 px-3 text-sm" onClick={() => open(f)}>
                  Modifica
                </Button>
                <Button variant="ghost" className="min-h-9 px-3 text-sm text-danger" onClick={() => void remove(f)}>
                  Elimina
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function UsageTable() {
  const [rows, setRows] = useState<Usage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    supabase!
      .from('ai_usage_daily')
      .select('*')
      .order('day', { ascending: false })
      .limit(31)
      .then(({ data, error }) => {
        if (error) setErr(dbMessage(error));
        setRows((data as Usage[]) ?? []);
      });
  }, []);
  if (err) return <Alert>{err}</Alert>;
  if (!rows) return <Spinner small />;
  const tot = rows.reduce(
    (a, r) => ({
      turns: a.turns + r.turns,
      model: a.model + r.model_turns,
      local: a.local + r.local_answers,
      tin: a.tin + Number(r.input_tokens),
      tout: a.tout + Number(r.output_tokens),
      cost: a.cost + Number(r.est_cost_usd),
      errors: a.errors + r.errors,
      blocked: a.blocked + r.blocked,
    }),
    { turns: 0, model: 0, local: 0, tin: 0, tout: 0, cost: 0, errors: 0, blocked: 0 },
  );
  return (
    <section className="space-y-3">
      <h3 className="font-display text-xl">Consumi (ultimi 31 giorni)</h3>
      <p className="text-sm text-taupe">Dati aggregati, senza testi delle conversazioni né dati dei clienti. Il costo è una stima basata sui prezzi inseriti sopra.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Messaggi" value={int(tot.turns)} />
        <Stat label="Con OpenAI" value={int(tot.model)} />
        <Stat label="Risposte locali" value={int(tot.local)} />
        <Stat label="Costo stimato" value={usd(tot.cost)} />
      </div>
      {rows.length === 0 ? (
        <EmptyState>Nessun utilizzo registrato.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-3xl border border-line bg-paper">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-taupe">
              <tr>
                <th className="px-4 py-2 font-normal">Giorno</th>
                <th className="px-2 py-2 text-right font-normal">Messaggi</th>
                <th className="px-2 py-2 text-right font-normal">OpenAI</th>
                <th className="px-2 py-2 text-right font-normal">Locali</th>
                <th className="px-2 py-2 text-right font-normal">Token entrata</th>
                <th className="px-2 py-2 text-right font-normal">Token uscita</th>
                <th className="px-2 py-2 text-right font-normal">Errori</th>
                <th className="px-2 py-2 text-right font-normal">Bloccati</th>
                <th className="px-4 py-2 text-right font-normal">Costo stimato</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {rows.map((r) => (
                <tr key={r.day}>
                  <td className="px-4 py-2">{new Date(`${r.day}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</td>
                  <td className="px-2 py-2 text-right">{int(r.turns)}</td>
                  <td className="px-2 py-2 text-right">{int(r.model_turns)}</td>
                  <td className="px-2 py-2 text-right">{int(r.local_answers)}</td>
                  <td className="px-2 py-2 text-right">{int(Number(r.input_tokens))}</td>
                  <td className="px-2 py-2 text-right">{int(Number(r.output_tokens))}</td>
                  <td className="px-2 py-2 text-right">{r.errors}</td>
                  <td className="px-2 py-2 text-right">{r.blocked}</td>
                  <td className="px-4 py-2 text-right">{usd(Number(r.est_cost_usd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-paper px-4 py-3">
      <p className="text-xs text-taupe">{label}</p>
      <p className="mt-1 font-display text-xl tabular-nums">{value}</p>
    </div>
  );
}
