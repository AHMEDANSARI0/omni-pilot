/*
 * PostPilot service worker.
 *
 * Two jobs, deliberately kept small:
 *
 *   1. Make the app installable and fast on a second visit. Static assets are cache-first; navigations
 *      are network-first with the cached shell as the fallback, because a dashboard showing a stale
 *      approval state is worse than showing "you are offline".
 *   2. Receive web push and open the right page when the notification is tapped.
 *
 * Nothing here caches API responses: the dashboard depends on /api/v1/* being honest, and a cached
 * "nothing pending" is exactly the kind of lie that makes an owner miss a post.
 */
const VERSION = 'postpilot-v1';
const SHELL = ['/', '/queue/', '/approvals/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // A failed precache must not break the install: the app still works online.
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never serve an API response from cache - see the note above.
  if (url.pathname.startsWith('/api/')) return;

  const isStatic = /\/_next\/static\/|\.(?:css|js|woff2?|png|jpg|svg|webmanifest)$/.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match('/'))),
    );
  }
});

self.addEventListener('push', (event) => {
  let payload = { title: 'PostPilot', body: 'Something needs your attention.', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url || '/' },
      tag: payload.tag || 'postpilot',
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
