const CACHE_VERSION = 'v3.0.0';
const CACHE_NAME = `oasis-pharmacy-${CACHE_VERSION}`;

const STATIC_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const API_DOMAINS = [
  'api.fda.gov',
  'dailymed.nlm.nih.gov',
  'rxnav.nlm.nih.gov',
  'openfoodfacts.org'
];

// Install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('oasis-pharmacy-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // API requests - network only
  if (API_DOMAINS.some(domain => url.hostname.includes(domain))) {
    event.respondWith(fetch(event.request).catch(() => new Response('{"error":"offline"}', { status: 503 })));
    return;
  }
  
  // Static files - cache first
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(response => {
            if (response.ok && event.request.method === 'GET') {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          });
      })
      .catch(() => caches.match('./index.html'))
  );
});
