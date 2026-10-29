import { useEffect, useState } from 'react';

/** Stato della connessione (navigator.onLine + eventi). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Avviso fisso quando manca la connessione: nessuna operazione viene simulata offline. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="sticky top-0 z-50 bg-ink px-4 py-2.5 text-center text-sm text-ivory">
      Sei offline. Per effettuare o modificare prenotazioni è necessaria la connessione Internet.
    </div>
  );
}

/**
 * Registrazione del service worker e avviso di nuova versione.
 * L'aggiornamento non è forzato durante una prenotazione: l'utente sceglie quando.
 */
export function UpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
    // Ricarica solo quando l'utente ha scelto "Aggiorna" (non alla prima installazione)
    const onController = () => {
      if (sessionStorage.getItem('maylana-sw-update') !== '1') return;
      sessionStorage.removeItem('maylana-sw-update');
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onController);

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) setWaiting(sw);
          });
        });
        // controlla aggiornamenti quando l'app torna in primo piano
        const check = () => document.visibilityState === 'visible' && reg.update().catch(() => undefined);
        document.addEventListener('visibilitychange', check);
      })
      .catch(() => undefined);

    return () => navigator.serviceWorker.removeEventListener('controllerchange', onController);
  }, []);

  if (!waiting) return null;
  return (
    <div role="status" className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-sm text-ivory shadow-lg sm:bottom-6">
      <span className="flex-1">È disponibile una nuova versione dell'app.</span>
      <button
        onClick={() => {
          try {
            sessionStorage.setItem('maylana-sw-update', '1');
          } catch {
            /* storage non disponibile: la nuova versione si attiverà alla prossima apertura */
          }
          waiting.postMessage({ type: 'SKIP_WAITING' });
        }}
        className="rounded-full bg-champagne px-4 py-2 font-medium text-ink">
        Aggiorna
      </button>
    </div>
  );
}
