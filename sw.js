/* Keeps the app opening from the Home Screen with or without reception, and shows new-lead notifications.
   Leads and changes themselves are handled by the page (shim.js); this only looks after the app's own files. */
const VERSION = '__VERSION__';
const CACHE = 'firstcall-' + VERSION;
const SHELL = ['/', '/shim.js', '/gate.js', '/gate.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  /* Only a complete set of good replies is kept. One missing file and the previous saved set stays in use. */
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.indexOf('firstcall-') === 0 && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/in/') === 0 || url.pathname === '/sw.js' || url.pathname === '/health') return;
    const key = req.mode === 'navigate' ? '/' : url.pathname;
    if (SHELL.indexOf(key) < 0) return;
    /* The live copy when there is reception (so an update is picked up straight away), the saved copy when there is not. */
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      }).catch(() => caches.match(key, { cacheName: CACHE }).then((hit) => hit || Response.error()))
    );
    return;
  }
  /* Fonts: use the saved copy straight away and refresh it in the background. */
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open('firstcall-fonts').then((c) => c.match(req).then((hit) => {
      const live = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
      return hit || live;
    })));
  }
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Firstcall', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.key ? 'lead-' + d.key : undefined,
    data: { key: d.key || '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const key = (event.notification.data && event.notification.data.key) || '';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    /* Use the app itself if it is already open; otherwise open it on the lead. */
    const open = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { open.postMessage({ type: 'lead', key }); return open.focus(); }
    return self.clients.openWindow(key ? '/?lead=' + encodeURIComponent(key) : '/');
  }));
});
