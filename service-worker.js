// Schedule Manager — offline app shell (PWA)
// Strategy: TRUE network-first. Every online request goes to the server with
// {cache:'no-store'} so the newest code/data is always used; the cache is only
// a fallback when offline. Data calls (Firebase, Cloud Functions) go to other
// origins and are never touched by the SW.
const CACHE = 'schedule-mgr-v131';
// The punch page's manifest is built by Vite under a hashed name in /assets/
// (not listed here: addAll fails on a missing file); like the pages' built
// files, it is kept on its first fetch.
const CORE = [
  './',
  './schedule-manager.html',
  './worker-punch.html',
  './supplier-portal.html',
  './client-portal.html',
  './payroll.js',
  './og.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './fonts/fonts.css',
  './icons/tabler-icons.css',
  './icons/tabler-icons.woff2'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(()=>{}));
  self.skipWaiting();                    // activate the new SW immediately
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())  // take control of open pages at once
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                               // never touch POSTs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                // 3rd-party (fonts/CDN): let the browser handle it

  const isNav = req.mode === 'navigate';

  // Font files never change under the same URL (the icon font's URL carries
  // its version): cache first, so they are not fetched again on every page load.
  if (/\.woff2$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{}); }
      return res;
    })));
    return;
  }

  e.respondWith(
    // Bypass the browser HTTP cache so we always get the freshest file from the server.
    fetch(req, { cache: 'no-store' }).then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(() =>
      // Offline: fall back to cache. ignoreSearch so "worker-punch.html?t=TOKEN" matches the cached page.
      caches.match(req, { ignoreSearch: true }).then(r => {
        if (r) return r;
        if (isNav) {
          const page = url.pathname.indexOf('worker-punch') !== -1 ? './worker-punch.html'
            : url.pathname.indexOf('supplier') !== -1 ? './supplier-portal.html'
            : url.pathname.indexOf('client') !== -1 ? './client-portal.html'
            : './schedule-manager.html';
          return caches.match(page);
        }
        return undefined;
      })
    )
  );
});

// Push (for the future, once a real sender exists)
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (_) { data = { title: 'Schedule Manager', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Schedule Manager', {
    body: data.body || '', tag: data.tag || 'general', data: { url: data.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow((e.notification.data && e.notification.data.url) || './'));
});
