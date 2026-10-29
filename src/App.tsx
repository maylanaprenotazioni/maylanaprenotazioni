import { lazy, Suspense, useEffect } from 'react';
import BookingPage from './pages/BookingPage';
import { Spinner } from './components/ui';
import { OfflineBanner, UpdatePrompt } from './components/Online';
import { ErrorBoundary } from './components/ErrorBoundary';

const AdminApp = lazy(() => import('./pages/admin/AdminApp'));
const ManagePage = lazy(() => import('./pages/ManagePage'));
const ResetPassword = lazy(() => import('./pages/admin/ResetPassword'));

const RESET_PATH = '/admin/reset-password';

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-taupe">
      <Spinner />
    </div>
  );
}

/** Rotte: /prenota (pubblica), /gestisci (link personale cliente), /admin (riservata), /admin/reset-password (link email). */
export default function App() {
  let path = window.location.pathname;
  // Link di recupero password arrivato su un altro indirizzo (es. Site URL): lo porta alla pagina dedicata.
  if (path !== RESET_PATH && /(?:^|[#?&])type=recovery(?:&|$)/.test(window.location.search + window.location.hash)) {
    window.history.replaceState(null, '', RESET_PATH + window.location.search + window.location.hash);
    path = RESET_PATH;
  }
  const isReset = path.replace(/\/+$/, '') === RESET_PATH;
  if (path === '/' || path === '') {
    window.history.replaceState(null, '', '/prenota' + window.location.search);
  }
  const isAdmin = path.startsWith('/admin');

  // Installata dall'area riservata, la PWA si apre sull'agenda.
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) link.href = isAdmin ? '/manifest-admin.webmanifest' : '/manifest.webmanifest';
  }, [isAdmin]);

  let page;
  if (isReset) {
    // Pubblica: NON passa dal controllo di accesso di AdminApp, verifica solo il link email.
    page = <ResetPassword />;
  } else if (isAdmin) {
    document.title = 'Area riservata — Maylana';
    page = <AdminApp />;
  } else if (path.startsWith('/gestisci')) {
    page = <ManagePage />;
  } else {
    page = <BookingPage />;
  }

  return (
    <>
      <OfflineBanner />
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>{page}</Suspense>
      </ErrorBoundary>
      <UpdatePrompt />
    </>
  );
}
