// Find My Device service worker
// 1. Network-first caching, so the app still opens with no internet.
// 2. Push alerts, so a ring or SOS reaches this device even when the app is closed.
// Browsers only run service workers on HTTPS (or localhost), so on plain
// http://192.168.x.x this file is skipped and the app still works without these extras.
const CACHE = 'fmd-v2';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { }
  e.waitUntil((async () => {
    // If the app is open and visible it is already ringing, so skip the notification.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible')) return;

    const maps = d.lat != null && d.lon != null ? `https://www.google.com/maps?q=${d.lat},${d.lon}` : '';
    await self.registration.showNotification(d.title || 'Find My Device', {
      body: d.body || '',
      tag: 'fmd-alert',
      renotify: true,
      requireInteraction: true,
      vibrate: d.sos ? [500, 200, 500, 200, 500, 200, 500] : [300, 150, 300],
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { maps },
      actions: maps ? [{ action: 'maps', title: 'Open Google Maps' }] : []
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const maps = e.notification.data && e.notification.data.maps;
  e.waitUntil((async () => {
    if (e.action === 'maps' && maps) return self.clients.openWindow(maps);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if ('focus' in w) return w.focus();
    return self.clients.openWindow('/');
  })());
});