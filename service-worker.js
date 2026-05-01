// ============================================
// LogisBJ — Service Worker
// Cache basique pour fonctionnement hors-ligne minimal
// ============================================

const CACHE_NAME = 'logisbj-v1';
const ASSETS_A_METTRE_EN_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.socket.io/4.7.5/socket.io.min.js'
];

// ─── Installation ────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_A_METTRE_EN_CACHE).catch((err) => {
        console.warn('Erreur cache initial:', err);
      });
    })
  );
  self.skipWaiting();
});

// ─── Activation ──────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((noms) => {
      return Promise.all(
        noms.map((nom) => {
          if (nom !== CACHE_NAME) {
            return caches.delete(nom);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// ─── Stratégie de récupération ───────────────
// Network-first pour API (toujours frais)
// Cache-first pour assets statiques (rapidité)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Ne pas mettre en cache les requêtes API (elles doivent être toujours fraîches)
  if (url.pathname.includes('/api/') || url.hostname.includes('onrender.com')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'Pas de connexion internet' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503
        });
      })
    );
    return;
  }
  
  // Pour le reste : cache-first
  event.respondWith(
    caches.match(event.request).then((reponseEnCache) => {
      if (reponseEnCache) return reponseEnCache;
      
      return fetch(event.request).then((reponse) => {
        // Mettre en cache si la requête a réussi
        if (reponse && reponse.status === 200 && reponse.type === 'basic') {
          const reponseClonee = reponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, reponseClonee);
          });
        }
        return reponse;
      }).catch(() => {
        // Hors-ligne : retourner la page d'accueil si on a la racine en cache
        return caches.match('/');
      });
    })
  );
});
