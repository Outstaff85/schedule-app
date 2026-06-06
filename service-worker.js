// ═══════════════════════════════════════════════
//  Schedule Manager — Service Worker
//  Caches all app files for offline use
// ═══════════════════════════════════════════════

const CACHE_NAME = 'schedule-manager-v1';

// Files to cache for offline use
const CACHE_FILES = [
  '/schedule-manager.html',
  '/worker-punch.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  // External CDN (xlsx library)
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// ── Install: cache all files ──────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching app files');
      // Cache what we can, ignore failures for external resources
      return Promise.allSettled(
        CACHE_FILES.map(url =>
          cache.add(url).catch(e => console.warn('[SW] Could not cache:', url, e))
        )
      );
    }).then(() => {
      console.log('[SW] Install complete');
      return self.skipWaiting(); // Activate immediately
    })
  );
});

// ── Activate: clean up old caches ────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => {
      console.log('[SW] Activated');
      return self.clients.claim(); // Take control immediately
    })
  );
});

// ── Fetch: serve from cache, fallback to network ─────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go to network for Google Apps Script (live data)
  if (url.hostname.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline — data will sync when connected' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Cache-first strategy for app files
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Return cached version, but update cache in background
        const fetchPromise = fetch(event.request)
          .then(response => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {}); // Ignore network errors in background
        return cached;
      }
      // Not in cache — try network
      return fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback for HTML pages
          if (event.request.destination === 'document') {
            return caches.match('/schedule-manager.html');
          }
        });
    })
  );
});

// ── Background sync (when back online) ───────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-punches') {
    event.waitUntil(syncPunches());
  }
});

async function syncPunches() {
  // Notify all clients to flush their offline queue
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'FLUSH_QUEUE' }));
}



self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/schedule-manager.html';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || '⏰ Shift Reminder', {
      body:    data.body    || 'Your shift starts soon — tap to clock in!',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag     || 'shift-reminder',
      vibrate: [300, 100, 300],
      data:    { url: data.url || '/worker-punch.html' },
      actions: [
        { action: 'punch',   title: '⏱ Clock In Now' },
        { action: 'dismiss', title: 'Dismiss' }
      ],
      requireInteraction: true,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/worker-punch.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return clients.openWindow(url);
    })
  );
});
