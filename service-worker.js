// ============================================
// LogisBJ — Service Worker
// Stratégies : network-first (navigation) · stale-while-revalidate (assets + liste d'annonces)
// network-only (API sensible). Purge auto des anciens caches à l'activation.
// ============================================

// Version pilotée par le paramètre ?v= passé à l'enregistrement dans index.html.
// Grâce au network-first + SWR, les mises à jour arrivent SANS bump. Ce paramètre
// n'est que le levier de purge totale : bumpez-le (ou injectez le hash de commit au
// déploiement, ex. Vercel VERCEL_GIT_COMMIT_SHA) pour effacer d'un coup les anciens caches.
const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE_STATIC = 'logisbj-static-' + VERSION;
const CACHE_API = 'logisbj-api-' + VERSION;

const ASSETS_STATIQUES = [
  '/', '/index.html', '/manifest.json', '/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.socket.io/4.7.5/socket.io.min.js'
];

// ─── Installation ────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) =>
      cache.addAll(ASSETS_STATIQUES).catch((err) => console.warn('Cache initial partiel:', err))
    )
  );
  self.skipWaiting();
});

// ─── Activation : purge des anciennes versions ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((noms) => Promise.all(
      noms.filter((nom) => nom !== CACHE_STATIC && nom !== CACHE_API).map((nom) => caches.delete(nom))
    )).then(() => self.clients.claim())
  );
});

// ─── Utilitaires ─────────────────────────────
async function signalerClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((c) => c.postMessage(message));
}

function estNavigation(request) {
  return request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
}

// ─── Stratégie de récupération ───────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // On ne gère que les GET ; POST/PUT (auth, messages, paiement) passent sans interception.
  if (request.method !== 'GET') return;

  // 1) Navigation / index.html → NETWORK-FIRST (plus jamais de fichier principal figé)
  if (estNavigation(request)) {
    event.respondWith(
      fetch(request).then((reponse) => {
        const clone = reponse.clone();
        caches.open(CACHE_STATIC).then((c) => c.put('/index.html', clone));
        return reponse;
      }).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 2) Liste d'annonces → STALE-WHILE-REVALIDATE + signal hors-ligne
  //    (endsWith ne matche que la liste, pas /api/annonces/:id ni /:id/signaler)
  if (url.pathname.endsWith('/api/annonces')) {
    event.respondWith(strategieAnnonces(request));
    return;
  }

  // 3) Autres appels API / backend → NETWORK-ONLY (données sensibles, jamais cachées)
  if (url.pathname.includes('/api/') || url.hostname.includes('onrender.com')) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'Pas de connexion internet' }),
        { headers: { 'Content-Type': 'application/json' }, status: 503 }
      ))
    );
    return;
  }

  // 4) Assets statiques (icônes, CDN Leaflet/Socket.io) → STALE-WHILE-REVALIDATE
  event.respondWith(
    caches.match(request).then((enCache) => {
      const reseau = fetch(request).then((reponse) => {
        if (reponse && reponse.status === 200) {
          const clone = reponse.clone();
          caches.open(CACHE_STATIC).then((c) => c.put(request, clone));
        }
        return reponse;
      }).catch(() => enCache);
      return enCache || reseau;
    })
  );
});

// ─── Stale-while-revalidate pour la liste d'annonces ──
async function strategieAnnonces(request) {
  const cache = await caches.open(CACHE_API);
  try {
    const reponse = await fetch(request);
    if (!reponse || reponse.status !== 200) throw new Error('Réponse non-200');
    // On stocke une copie horodatée pour dater le mode hors-ligne.
    const corps = await reponse.clone().text();
    cache.put(request, new Response(corps, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-SW-Cached-At': new Date().toISOString() }
    }));
    signalerClients({ type: 'reseau-ok' });
    return reponse;
  } catch (err) {
    const enCache = await cache.match(request);
    if (enCache) {
      signalerClients({ type: 'hors-ligne', depuis: enCache.headers.get('X-SW-Cached-At') });
      return enCache;
    }
    return new Response(
      JSON.stringify({ error: 'Pas de connexion internet', annonces: [] }),
      { headers: { 'Content-Type': 'application/json' }, status: 503 }
    );
  }
}
