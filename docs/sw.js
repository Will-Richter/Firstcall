/* Keeps Firstcall opening from the Home Screen with or without reception.
   Leads and changes themselves are handled by the page (link.js); this only looks after the app's own files. */
const VERSION = '980160194ee1';
const CACHE = 'firstcall-pages-' + VERSION;
const SHELL = ['./', 'link.js', 'setup.js', 'setup.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const BASE = new URL('./', self.location).pathname;

self.addEventListener('install', (event) => {
  /* Only a complete set of good replies is kept. One missing file and the previous saved set stays in use. */
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.indexOf('firstcall-pages-') === 0 && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf(BASE) !== 0) return;
    const rest = url.pathname.slice(BASE.length);
    const key = req.mode === 'navigate' || rest === '' || rest === 'index.html' ? './' : rest;
    if (SHELL.indexOf(key) < 0) return;
    /* The live copy when there is reception (so an update is picked up straight away), the saved copy when there is not. */
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      }).catch(() => caches.open(CACHE).then((c) => c.match(key)).then((hit) => hit || Response.error()))
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
