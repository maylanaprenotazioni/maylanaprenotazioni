import { lazy, Suspense, useEffect } from 'react';
import BookingPage from './pages/BookingPage';
import { Spinner } from './components/ui';
import { OfflineBanner, UpdatePrompt } from './components/Online';
import { ErrorBoundary } from './components/ErrorBoundary';

const AdminApp = lazy(() => import('./pages/admin/AdminApp'));
const ManagePage = lazy(() => import('./pages/ManagePage'));

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-taupe">
      <Spinner />
    </div>
  );
}

/** Rotte: /prenota (pubblica), /gestisci (link personale cliente), /admin (riservata). */
export default function App() {
  const path = window.location.pathname;
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
  if (isAdmin) {
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
