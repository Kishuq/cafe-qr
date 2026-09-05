/* Cafe QR — offline-first service worker (v2) */
const CACHE = 'cafe-v2';
const CORE = ['/menu.html', '/manifest.json', '/api/menu', '/api/info'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // API: network first, fall back to cache (menu stays visible offline)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // Images: cache first
  if (/\.(png|jpg|jpeg|webp|svg|gif)$/.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    })));
    return;
  }
  // Pages: network first, fall back to cache
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
