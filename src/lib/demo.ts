/**
 * Modalità demo dell'area riservata: /admin/demo si apre senza login,
 * con dati di esempio tenuti solo nel browser (nessun accesso al database reale).
 * Modulo leggero: usato anche dal bundle principale.
 */
export const DEMO_PATH = '/admin/demo';

export function isDemo(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === DEMO_PATH;
}
