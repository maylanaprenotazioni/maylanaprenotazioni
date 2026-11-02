import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Input } from '../../components/ui';
import { Shell } from './AuthShell';

export const EMERGENCY_PATH = '/admin/recupero-emergenza';

/** Nuova password senza email, con il codice ADMIN_RECOVERY_CODE impostato su Netlify. */
export default function EmergencyReset() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = 'Recupero di emergenza — Maylana';
    fetch('/api/admin/emergency-reset', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b: { enabled?: boolean }) => setEnabled(b.enabled === true))
      .catch(() => setEnabled(false));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('Le due password non coincidono.');
    setBusy(true);
    try {
      const res = await fetch('/api/admin/emergency-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) setError(body?.error?.message ?? 'Operazione non riuscita. Riprova.');
      else setDone(true);
    } catch {
      setError('Connessione non riuscita. Riprova.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-center font-display text-2xl">Recupero di emergenza</h1>
        {enabled === null ? null : done ? (
          <>
            <Alert tone="ok">Password aggiornata. Ora puoi accedere con la nuova password. Per sicurezza cancella la variabile ADMIN_RECOVERY_CODE da Netlify.</Alert>
            <Button className="w-full" onClick={() => location.assign('/admin')}>
              Vai all'accesso
            </Button>
          </>
        ) : !enabled ? (
          <Alert>
            Il recupero di emergenza non è attivo. Su Netlify apri Configurazione progetto → Variabili d'ambiente, aggiungi ADMIN_RECOVERY_CODE con un codice segreto di almeno 20
            caratteri e ripubblica il sito. Poi torna su questa pagina.
          </Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-center text-sm text-taupe">Usa questa pagina se l'email di recupero non arriva. Serve il codice impostato su Netlify.</p>
            <Input label="Email dell'area riservata" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Input label="Codice di recupero" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} required />
            <Input label="Nuova password" type="password" autoComplete="new-password" minLength={10} maxLength={72} hint="Almeno 10 caratteri" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Input label="Ripeti la nuova password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            {error && <Alert>{error}</Alert>}
            <Button type="submit" busy={busy} className="w-full">
              Imposta nuova password
            </Button>
          </form>
        )}
        <a href="/admin" className="block text-center text-sm text-taupe underline underline-offset-4 hover:text-ink">
          Torna all'accesso
        </a>
      </div>
    </Shell>
  );
}
