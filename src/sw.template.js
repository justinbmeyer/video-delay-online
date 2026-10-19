// Template: vite.config.ts fills in the version and precache list at build time.
const CACHE = 'video-delay-__VERSION__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Bypass the HTTP cache (GitHub Pages sends max-age=600) so a new worker never precaches a stale page.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  // Built assets have hashed names, so cached copies never go stale.
  event.respondWith(
    (async () => (await caches.match(request, { ignoreSearch: true })) ?? fetch(request))(),
  );
});

// Always try for the latest page so deploys show up on the next load; use the cached page offline.
async function networkFirstPage(request) {
  const key = self.registration.scope;
  try {
    const response = await fetch(request.url, { cache: 'no-cache' });
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(key, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(key)) ?? Response.error();
  }
}
