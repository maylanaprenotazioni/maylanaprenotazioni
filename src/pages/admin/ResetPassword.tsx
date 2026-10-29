import { useEffect, useState, type FormEvent } from 'react';
import { supabase, authUrlParams } from '../../lib/supabase';
import { Alert, Button, Input } from '../../components/ui';
import { FORGOT_HASH, Loading, Shell } from './AuthShell';

type Status = 'checking' | 'ready' | 'missing' | 'expired' | 'invalid' | 'done';

const MIN_LENGTH = 8;
const RESET_PATH = '/admin/reset-password';

const isExpired = (text: string) => /expired|scadut/i.test(text);

/**
 * Verifica (una sola volta per caricamento, anche con StrictMode) il link ricevuto via email.
 * Gestisce tutti i formati di Supabase:
 *  - implicit: #access_token=…&type=recovery (sessione creata dal client all'avvio)
 *  - PKCE:     ?code=… (scambiato qui se il client non l'ha già fatto)
 *  - OTP:      ?token_hash=…&type=recovery (template email personalizzato)
 *  - errore:   #error_code=otp_expired… (link scaduto o già usato)
 */
let verification: Promise<Status> | null = null;

function verifyLink(): Promise<Status> {
  verification ??= (async (): Promise<Status> => {
    const auth = supabase!.auth;
    const p = authUrlParams();
    let recoveryEvent = false;
    const { data: sub } = auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') recoveryEvent = true;
    });
    try {
      // Attende che il client abbia elaborato l'URL (getSession aspetta l'inizializzazione).
      const { data } = await auth.getSession();
      const session = data.session;
      await new Promise((r) => setTimeout(r, 0)); // l'evento PASSWORD_RECOVERY è emesso subito dopo

      if (p.error || p.error_code || p.error_description) {
        return isExpired(`${p.error_code ?? ''} ${p.error_description ?? ''}`) ? 'expired' : 'invalid';
      }
      if (p.access_token) {
        // Accetta solo la sessione creata da QUESTO link, non una eventualmente già salvata.
        return p.type === 'recovery' && (recoveryEvent || session?.access_token === p.access_token) ? 'ready' : 'invalid';
      }
      if (p.code) {
        if (session && recoveryEvent) return 'ready'; // già scambiato dal client (flowType pkce)
        const { data: ex, error } = await auth.exchangeCodeForSession(p.code);
        if (error || !ex.session) return error && isExpired(error.message) ? 'expired' : 'invalid';
        return 'ready';
      }
      if (p.token_hash) {
        const { data: v, error } = await auth.verifyOtp({ token_hash: p.token_hash, type: 'recovery' });
        if (error || !v.session) return error && isExpired(error.message) ? 'expired' : 'invalid';
        return 'ready';
      }
      return 'missing';
    } catch {
      return 'invalid';
    } finally {
      sub.subscription.unsubscribe();
      // Rimuove token/codici dalla barra degli indirizzi e dalla cronologia.
      if (location.pathname !== RESET_PATH || location.search || location.hash) history.replaceState(null, '', RESET_PATH);
    }
  })();
  return verification;
}

/** /admin/reset-password — pagina pubblica: non richiede login, solo un link di recupero valido. */
export default function ResetPassword() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    document.title = 'Nuova password — Maylana';
    if (!supabase) return;
    let alive = true;
    verifyLink().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);

  if (!supabase) {
    return (
      <Shell>
        <Alert>Area riservata non configurata: imposta VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY e ripubblica il sito.</Alert>
      </Shell>
    );
  }
  if (status === 'checking') return <Loading />;
  if (status === 'ready') return <NewPasswordForm onDone={() => setStatus('done')} onExpired={() => setStatus('expired')} />;

  const goLogin = () => location.assign('/admin');
  const goForgot = () => location.assign('/admin' + FORGOT_HASH);

  if (status === 'done') {
    return (
      <Shell>
        <div className="space-y-4">
          <h1 className="text-center font-display text-2xl">Password aggiornata</h1>
          <Alert tone="ok">La nuova password è stata salvata. Ora puoi accedere all'area riservata.</Alert>
          <Button className="w-full" onClick={goLogin}>
            Vai al login amministratore
          </Button>
        </div>
      </Shell>
    );
  }

  const message =
    status === 'missing'
      ? 'Per impostare una nuova password apri il link ricevuto via email. Se non hai ancora un link, richiedilo dalla pagina di accesso con "Password dimenticata?".'
      : status === 'expired'
        ? 'Il link per reimpostare la password è scaduto o è già stato usato. Richiedine uno nuovo.'
        : 'Il link per reimpostare la password non è valido. Richiedine uno nuovo e aprilo dall\'ultima email ricevuta, nello stesso browser in cui lo hai richiesto.';

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-center font-display text-2xl">Reimposta password</h1>
        <Alert tone={status === 'missing' ? 'info' : 'error'}>{message}</Alert>
        <Button className="w-full" onClick={goForgot}>
          Richiedi un nuovo link
        </Button>
        <Button variant="ghost" className="w-full" onClick={goLogin}>
          Torna al login amministratore
        </Button>
      </div>
    </Shell>
  );
}

function NewPasswordForm({ onDone, onExpired }: { onDone: () => void; onExpired: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) return setError(`La password deve contenere almeno ${MIN_LENGTH} caratteri.`);
    if (password !== confirm) return setError('Le due password non coincidono.');
    setBusy(true);
    const { error } = await supabase!.auth.updateUser({ password });
    if (error) {
      setBusy(false);
      const code = (error as { code?: string }).code;
      if (code === 'same_password') return setError('La nuova password deve essere diversa da quella attuale.');
      if (code === 'weak_password') return setError('Password troppo debole: usa più caratteri, con lettere, numeri e simboli.');
      if (code === 'session_expired' || code === 'session_not_found' || error.status === 401) return onExpired();
      return setError(/failed to fetch|network/i.test(error.message) ? 'Connessione assente: la password NON è stata salvata. Riprova.' : error.message);
    }
    // Chiude la sessione di recupero: l'accesso si fa con la nuova password.
    await supabase!.auth.signOut({ scope: 'local' }).catch(() => undefined);
    setPassword('');
    setConfirm('');
    setBusy(false);
    onDone();
  };

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-4">
        <h1 className="text-center font-display text-2xl">Nuova password</h1>
        <Input
          label="Nuova password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Input
          label="Conferma password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" busy={busy} className="w-full">
          Salva nuova password
        </Button>
      </form>
    </Shell>
  );
}
