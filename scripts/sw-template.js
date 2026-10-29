/* Service worker Maylana Coiffeur Booking — generato in fase di build da
 * scripts/build-sw.mjs (non modificare dist/sw.js a mano).
 *
 * Regole:
 *  - mette in cache SOLO file statici (app, icone, pagina offline)
 *  - non intercetta /api/* né Supabase: nessun dato di appuntamenti in cache
 *  - navigazione: rete prima; offline → app in cache (che mostra l'avviso) o offline.html
 *  - aggiornamento: la nuova versione attende finché l'utente sceglie "Aggiorna"
 */
const VERSION = '__BUILD_ID__';
const CACHE = `maylana-static-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('maylana-static-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase e terze parti: mai in cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return; // dati: sempre dalla rete
  if (url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('/index.html')) || (await caches.match('/offline.html')) || Response.error()),
    );
    return;
  }

  const isStatic = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/splash/') ||
    /\.(?:css|js|png|svg|webmanifest|woff2?)$/.test(url.pathname);
  if (!isStatic) return;

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
