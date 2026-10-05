// Service worker: makes the app installable and lets the shell open offline.
// - /api/* and non-GET requests are never touched, so data and the auth cookie
//   always go straight to the network.
// - Page loads are network-first (you always get the latest deploy when online),
//   falling back to the last cached app shell when offline.
// - Hashed build files under /assets/ are cache-first (their names change on
//   every deploy); files no longer referenced by the latest shell are pruned.
// - Other static files (icons, manifest) are served from cache and refreshed
//   in the background.
const CACHE = 'em-static-v1';
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function pruneAssets(cache, html) {
  const live = new Set(html.match(/\/assets\/[^"'\s)]+/g) || []);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/') && !live.has(path)) await cache.delete(req);
  }
}

async function shell(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      const copy = res.clone();
      copy.text().then(async (html) => {
        await cache.put(SHELL, new Response(html, { headers: { 'content-type': 'text/html' } }));
        await pruneAssets(cache, html);
      });
    }
    return res;
  } catch (err) {
    const cached = await cache.match(SHELL);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Leave standalone static pages (e.g. /privacy.html) alone.
    if (/\.[a-z0-9]+$/i.test(url.pathname)) return;
    event.respondWith(shell(req));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
  } else if (/^\/(icons\/|manifest\.webmanifest$)/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
