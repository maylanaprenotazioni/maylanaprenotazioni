import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, dbMessage } from '../../lib/supabase';
import { api } from '../../lib/api';
import type { Service, Staff } from '../../lib/types';
import { Alert, Button, Input, Spinner, cx } from '../../components/ui';
import { Brand } from '../../components/Brand';
import { AdminContext, type AdminCtx, type Role, type Tab } from './context';
import Overview from './Overview';
import Agenda from './Agenda';
import Requests from './Requests';
import Customers from './Customers';
import History from './History';
import Hours from './Hours';
import Services from './Services';
import StaffPage from './StaffPage';
import SettingsPage from './SettingsPage';
import AiPage from './AiPage';

const TABS: { key: Tab; label: string; owner?: boolean; primary?: boolean }[] = [
  { key: 'panoramica', label: 'Panoramica', primary: true },
  { key: 'agenda', label: 'Agenda', primary: true },
  { key: 'richieste', label: 'Richieste', primary: true },
  { key: 'clienti', label: 'Clienti', primary: true },
  { key: 'storico', label: 'Storico' },
  { key: 'orari', label: 'Orari e chiusure' },
  { key: 'servizi', label: 'Servizi e prezzi', owner: true },
  { key: 'operatori', label: 'Operatori', owner: true },
  { key: 'impostazioni', label: 'Impostazioni', owner: true },
  { key: 'ai', label: 'Maylana AI', owner: true },
];

export default function AdminApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase) {
    return (
      <Shell>
        <Alert>Area riservata non configurata: imposta VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY e ripubblica il sito.</Alert>
      </Shell>
    );
  }
  if (session === undefined) return <Loading />;
  if (!session) return <Login />;
  return <Authorized session={session} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-5 py-10">
      <Brand name="Maylana Coiffeur" />
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-taupe">
      <Spinner />
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase!.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'Email o password non corretti.' : error.message);
  };

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-4">
        <h1 className="text-center font-display text-2xl">Area riservata</h1>
        <Input label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" busy={busy} className="w-full">
          Accedi
        </Button>
      </form>
    </Shell>
  );
}

interface ToastMsg {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
}

function Authorized({ session }: { session: Session }) {
  const [role, setRole] = useState<Role | null | undefined>(undefined);
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffServices, setStaffServices] = useState<{ staff_id: string; service_id: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const h = location.hash.slice(1) as Tab;
    return TABS.some((t) => t.key === h) ? h : 'panoramica';
  });
  const [agendaDate, setAgendaDate] = useState<string | null>(null);
  const [focusCustomerId, setFocusCustomerId] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [businessName, setBusinessName] = useState('Maylana Coiffeur');
  const [menuOpen, setMenuOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    supabase!
      .from('admin_users')
      .select('role')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) setError(dbMessage(error));
        setRole((data?.role as Role) ?? null);
      });
  }, [session.user.id]);

  const reloadRefs = useCallback(async () => {
    const [sv, st, ss, pr, bs] = await Promise.all([
      supabase!.from('services').select('*').order('sort_order').order('name'),
      supabase!.from('staff').select('*').order('sort_order').order('display_name'),
      supabase!.from('staff_services').select('staff_id, service_id'),
      supabase!.from('booking_requests').select('id', { count: 'exact', head: true }).in('status', ['pending', 'reschedule']),
      supabase!.from('business_settings').select('business_name').eq('id', 1).maybeSingle(),
    ]);
    if (bs.data?.business_name) setBusinessName(bs.data.business_name as string);
    const err = sv.error || st.error || ss.error;
    if (err) setError(dbMessage(err));
    setServices((sv.data as Service[]) ?? []);
    setStaff((st.data as Staff[]) ?? []);
    setStaffServices(ss.data ?? []);
    setPending(pr.count ?? 0);
  }, []);

  useEffect(() => {
    if (role) reloadRefs();
  }, [role, reloadRefs]);

  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
    window.scrollTo({ top: 0 });
  }, [tab]);

  const toast = useCallback((text: string, tone: ToastMsg['tone'] = 'ok') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 4500);
  }, []);

  const sendEmails = useCallback(
    async (ids: unknown) => {
      const list = (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === 'string');
      if (!list.length) return;
      try {
        const { data } = await supabase!.auth.getSession();
        const jwt = data.session?.access_token;
        if (!jwt) throw new Error('Sessione scaduta');
        const r = await api.adminDispatch(jwt, list);
        const sent = r.results.filter((x) => x.status === 'sent').length;
        const notSent = r.results.filter((x) => x.status !== 'sent');
        if (!r.email_configured) {
          toast('Email NON inviata: il servizio email non è configurato. Avvisa il cliente per telefono.', 'error');
        } else if (notSent.length) {
          const why = notSent[0].error ?? (notSent[0].status === 'pending' ? 'nuovo tentativo programmato' : 'errore');
          toast(`Email non inviata (${why}).${sent ? ` Altre ${sent} inviate.` : ''}`, 'error');
        } else if (sent) {
          toast(sent === 1 ? 'Email inviata al cliente.' : `${sent} email inviate.`);
        }
      } catch (e) {
        toast(`Esito email non verificabile: ${(e as Error).message}. Controlla la Panoramica.`, 'error');
      }
    },
    [toast],
  );

  const go = useCallback<AdminCtx['go']>((t, opts) => {
    if (opts?.date) setAgendaDate(opts.date);
    setFocusCustomerId(opts?.customerId ?? null);
    setTab(t);
    setMenuOpen(false);
  }, []);

  const logout = () => supabase!.auth.signOut();

  if (role === undefined) return <Loading />;
  if (role === null) {
    return (
      <Shell>
        <Alert>Questo account ({session.user.email}) non è abilitato all'area riservata.</Alert>
        {error && <Alert>{error}</Alert>}
        <Button variant="secondary" onClick={logout}>
          Esci
        </Button>
      </Shell>
    );
  }

  const ctx: AdminCtx = {
    role,
    services,
    staff,
    staffServices,
    reloadRefs,
    userEmail: session.user.email ?? '',
    go,
    agendaDate,
    focusCustomerId,
    toast,
    sendEmails,
    businessName,
  };
  const visible = TABS.filter((t) => !t.owner || role === 'owner');
  const badge = (k: Tab) => (k === 'richieste' ? pending : 0);
  const current = TABS.find((t) => t.key === tab)?.label ?? '';

  return (
    <AdminContext.Provider value={ctx}>
      <div className="min-h-dvh pb-28 sm:pb-10">
        <header className="sticky top-0 z-20 border-b border-line bg-ivory/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
            <Brand name="Maylana Coiffeur" size="sm" />
            <span className="hidden min-w-0 truncate font-display text-lg min-[360px]:inline sm:hidden">{current}</span>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-taupe md:inline">{session.user.email}</span>
              <Button variant="ghost" className="min-h-9 px-3 text-sm" onClick={logout}>
                Esci
              </Button>
            </div>
          </div>
          <nav className="mx-auto hidden max-w-6xl flex-wrap gap-1 px-3 pb-2 sm:flex" aria-label="Sezioni">
            {visible.map((t) => (
              <TabButton key={t.key} active={tab === t.key} onClick={() => go(t.key)} badge={badge(t.key)}>
                {t.label}
              </TabButton>
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-5">
          {error && (
            <div className="mb-4">
              <Alert>{error}</Alert>
            </div>
          )}
          {tab === 'panoramica' && <Overview />}
          {tab === 'agenda' && <Agenda />}
          {tab === 'richieste' && <Requests onChange={reloadRefs} />}
          {tab === 'clienti' && <Customers />}
          {tab === 'storico' && <History />}
          {tab === 'orari' && <Hours />}
          {tab === 'servizi' && role === 'owner' && <Services />}
          {tab === 'operatori' && role === 'owner' && <StaffPage />}
          {tab === 'impostazioni' && role === 'owner' && <SettingsPage />}
          {tab === 'ai' && role === 'owner' && <AiPage />}
        </main>

        {/* Menu inferiore su smartphone: 4 sezioni principali + "Altro" */}
        <nav
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-ivory/95 px-1 pb-[max(env(safe-area-inset-bottom),0.4rem)] pt-1.5 backdrop-blur sm:hidden"
          aria-label="Sezioni principali"
        >
          {visible
            .filter((t) => t.primary)
            .map((t) => (
              <BottomButton key={t.key} active={tab === t.key} onClick={() => go(t.key)} badge={badge(t.key)}>
                {t.label}
              </BottomButton>
            ))}
          <BottomButton active={menuOpen || !visible.find((t) => t.key === tab)?.primary} onClick={() => setMenuOpen(true)}>
            Altro
          </BottomButton>
        </nav>

        {menuOpen && (
          <div className="fixed inset-0 z-40 sm:hidden" role="dialog" aria-modal="true" aria-label="Altre sezioni">
            <button className="absolute inset-0 bg-ink/40" aria-label="Chiudi menu" onClick={() => setMenuOpen(false)} />
            <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-ivory px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
              <ul className="divide-y divide-line">
                {visible
                  .filter((t) => !t.primary)
                  .map((t) => (
                    <li key={t.key}>
                      <button onClick={() => go(t.key)} className={cx('flex w-full items-center justify-between px-2 py-4 text-left text-[17px]', tab === t.key && 'text-champagne-deep')}>
                        {t.label}
                        <span aria-hidden className="text-taupe">
                          ›
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
              <p className="px-2 pt-3 text-xs text-taupe">{session.user.email}</p>
            </div>
          </div>
        )}

        <div className="pointer-events-none fixed inset-x-3 bottom-24 z-50 flex flex-col items-center gap-2 sm:bottom-6" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cx(
                'pointer-events-auto max-w-md rounded-2xl px-4 py-3 text-sm shadow-lg',
                t.tone === 'error' ? 'bg-danger text-white' : t.tone === 'info' ? 'bg-paper text-ink border border-line' : 'bg-ink text-ivory',
              )}
            >
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </AdminContext.Provider>
  );
}

function TabButton({ active, onClick, children, badge }: { active: boolean; onClick: () => void; children: ReactNode; badge?: number }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx('relative shrink-0 rounded-full px-4 py-2 text-sm transition-colors', active ? 'bg-ink text-ivory' : 'text-ink-soft hover:bg-champagne-wash')}
    >
      {children}
      {!!badge && <span className="ml-1.5 rounded-full bg-champagne px-1.5 text-[11px] font-semibold text-ink">{badge}</span>}
    </button>
  );
}

function BottomButton({ active, onClick, children, badge }: { active: boolean; onClick: () => void; children: ReactNode; badge?: number }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx('relative flex min-h-12 min-w-0 flex-col items-center justify-center rounded-xl px-0.5 text-[11.5px] font-medium min-[375px]:text-[12px]', active ? 'bg-ink text-ivory' : 'text-ink-soft')}
    >
      <span className="block max-w-full truncate">{children}</span>
      {!!badge && (
        <span className="absolute right-1 top-0 h-4 min-w-4 rounded-full bg-champagne px-1 text-center text-[11px] font-semibold leading-4 text-ink">{badge}</span>
      )}
    </button>
  );
}
