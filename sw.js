/**
 * Pharmacy Tracker Service Worker v4.0.0
 */

const CACHE_VERSION = 'v4.0.0';
const CACHE_NAME = `pharmacy-tracker-${CACHE_VERSION}`;

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/icon-72.png',
  '/icon-96.png',
  '/icon-128.png',
  '/icon-144.png',
  '/icon-152.png',
  '/icon-192.png',
  '/icon-384.png',
  '/icon-512.png'
];

const EXTERNAL_CACHE = [
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

// Install
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing ${CACHE_NAME}`);
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(ASSETS_TO_CACHE);
        
        for (const url of EXTERNAL_CACHE) {
          try {
            await cache.add(url);
          } catch (e) {
            console.log('[SW] Could not cache:', url);
          }
        }
      })
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating ${CACHE_NAME}`);
  
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('pharmacy-tracker-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  const url = new URL(event.request.url);
  
  // CDN - cache first
  if (url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request))
    );
    return;
  }
  
  // Skip cross-origin
  if (!event.request.url.startsWith(self.location.origin)) return;
  
  // App shell - cache first, network fallback
  event.respondWith(
    caches.match(event.request)
      .then((cached) => {
        if (cached) return cached;
        
        return fetch(event.request)
          .then((response) => {
            if (response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
          });
      })
  );
});

console.log(`[SW] Loaded ${CACHE_VERSION}`);
