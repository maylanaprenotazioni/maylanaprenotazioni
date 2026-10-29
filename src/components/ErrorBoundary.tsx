import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Evita la pagina bianca se un modulo caricato al bisogno non arriva
 * (rete instabile, nuova versione pubblicata) o se un componente fallisce.
 *  - variant "page": messaggio con pulsante "Ricarica"
 *  - variant "silent": nasconde solo la parte guasta (es. la chat AI),
 *    il resto della pagina continua a funzionare
 */
type Props = { children: ReactNode; variant?: 'page' | 'silent' };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Solo dati tecnici: nessun dato del cliente.
    console.error('[ui] componente non disponibile:', error?.name, String(error?.message ?? '').slice(0, 120), info?.componentStack ? '' : '');
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.variant === 'silent') return null;
    return (
      <div role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="font-display text-2xl">Pagina non caricata</p>
        <p className="text-[15px] text-ink-soft">
          Non è stato possibile caricare questa sezione. Controlla la connessione e ricarica la pagina. Nessuna prenotazione è stata inviata.
        </p>
        <button type="button" onClick={() => location.reload()} className="min-h-12 rounded-full bg-ink px-6 text-[15px] font-medium text-ivory">
          Ricarica
        </button>
      </div>
    );
  }
}
