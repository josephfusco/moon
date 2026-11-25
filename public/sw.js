// Offline support. After one visit the whole app (code, Moon textures, Artemis photos) is kept on the
// device and works with no network. Nothing is fetched from any other site.
const CACHE = 'moon';
const SHELL = self.registration.scope; // the page itself, whatever ?t= it was opened with

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// The page sends the list of files it uses. Store any that are missing and drop code from older builds.
self.addEventListener('message', (e) => {
  const keep = e.data?.keep;
  if (!Array.isArray(keep)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const have = new Set((await cache.keys()).map((r) => r.url));
    await Promise.all(keep.filter((u) => !have.has(u)).map((u) => cache.add(u).catch(() => {})));
    const wanted = new Set(keep);
    for (const r of await cache.keys()) {
      if (new URL(r.url).pathname.includes('/assets/') && !wanted.has(r.url)) await cache.delete(r);
    }
    e.source?.postMessage({ offlineReady: true });
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const store = (key, res) => { if (res.ok) cache.put(key, res.clone()); return res; };
    // The page: newest when online, the saved copy when not.
    if (req.mode === 'navigate') {
      try { return store(SHELL, await fetch(req)); } catch { return (await cache.match(SHELL)) ?? Response.error(); }
    }
    const hit = await cache.match(req);
    // Built code has a fingerprint in its name and never changes, so the saved copy is always right.
    if (hit && url.pathname.includes('/assets/')) return hit;
    // Textures and photos: answer from the device at once, and refresh quietly when online.
    const fresh = fetch(req).then((res) => store(req, res));
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  })());
});
