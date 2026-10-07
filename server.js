'use strict';
/* Firstcall: website leads in one place, ready to call, track and send to ServiceM8.
   This server lets the app screens in index.html (which also run inside Claude) run on their own:
   it keeps the leads, receives website form emails through the mail link, talks to ServiceM8 and sends phone notifications. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError, createRouter, sendJson, sendText, isHttps } = require('./http');
const secure = require('./secure');
const db = require('./db');
const push = require('./push');
const registerApi = require('./api');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

function buildPage() {
  const app = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const inline = /<script>([\s\S]*?)<\/script>/.exec(app);
  const hash = inline ? crypto.createHash('sha256').update(inline[1]).digest('base64') : '';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#141A40"><meta name="apple-mobile-web-app-capable" content="yes">' +
    '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
    '<meta name="apple-mobile-web-app-title" content="Firstcall"><meta name="format-detection" content="telephone=no">' +
    '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
    '<link rel="icon" href="/icon.svg" type="image/svg+xml">' +
    '<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
    'html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}' +
    'img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>' +
    '<link rel="stylesheet" href="/gate.css"><script src="/shim.js"></script></head><body>\n' +
    app + '\n<script src="/gate.js"></script></body></html>\n';
  const csp = "default-src 'self'; script-src 'self'" + (hash ? " 'sha256-" + hash + "'" : '') +
    "; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; " +
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  return { body: Buffer.from(html), csp };
}

const STATIC = {
  '/shim.js': 'text/javascript; charset=utf-8',
  '/gate.js': 'text/javascript; charset=utf-8',
  '/gate.css': 'text/css; charset=utf-8',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  '/icon.svg': 'image/svg+xml',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
  '/icon-maskable-512.png': 'image/png',
  '/apple-touch-icon.png': 'image/png',
};

function start(options) {
  const opts = options || {};
  const dataDir = opts.dataDir || DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  const store = db.open(dataDir);
  const masterKey = secure.loadMasterKey(dataDir);
  const identity = push.loadIdentity(store, secure, masterKey);
  const ctx = {
    store, secure, masterKey, identity,
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    /* Apple and Google ask who is sending a notification: a contact email if one is set, otherwise the app's own address. */
    pushSubject: process.env.CONTACT_EMAIL ? 'mailto:' + process.env.CONTACT_EMAIL : ((process.env.PUBLIC_URL || '').replace(/\/+$/, '') || 'mailto:owner@firstcall.invalid'),
  };
  const router = createRouter();
  registerApi(router, ctx);

  const page = buildPage();
  const files = {};
  Object.keys(STATIC).forEach((p) => { files[p] = fs.readFileSync(path.join(ROOT, p.slice(1))); });
  const version = crypto.createHash('sha256').update(page.body).update(Object.values(files).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest('hex').slice(0, 12);
  files['/sw.js'] = Buffer.from(files['/sw.js'].toString('utf8').replace('__VERSION__', version));

  const cleaner = setInterval(() => { try { store.st.dropOldSessions.run(Date.now() - 61 * 864e5); } catch (e) { /* next time */ } }, 6 * 3600e3);
  cleaner.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { return sendText(res, 400, 'Bad request'); }
    const p = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/' || p === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.body.length, 'Cache-Control': 'no-cache', 'Content-Security-Policy': page.csp });
          return res.end(req.method === 'HEAD' ? undefined : page.body);
        }
        if (STATIC[p]) {
          const body = files[p];
          res.writeHead(200, { 'Content-Type': STATIC[p], 'Content-Length': body.length, 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=3600' });
          return res.end(req.method === 'HEAD' ? undefined : body);
        }
      }
      const m = router.match(req.method, p);
      if (!m) return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
      await m.handler(req, res, m.params, url);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (x) { /* gone */ } return; }
      if (e instanceof HttpError) return sendJson(res, e.status, { error: Object.assign({ code: e.code, message: e.message }, e.extra || {}) });
      console.error(new Date().toISOString(), req.method, p, e && e.stack ? e.stack : e);
      sendJson(res, 500, { error: { code: 'server', message: 'Something went wrong on the server' } });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 20000;

  return new Promise((resolve) => {
    server.listen(opts.port === undefined ? PORT : opts.port, () => {
      resolve({ server, port: server.address().port, store, ctx, close: () => new Promise((r) => server.close(() => { store.close(); r(); })) });
    });
  });
}

if (require.main === module) {
  /* Last-resort safety net: log the problem and keep serving rather than going down. */
  process.on('uncaughtException', (e) => console.error(new Date().toISOString(), 'uncaught', e && e.stack ? e.stack : e));
  process.on('unhandledRejection', (e) => console.error(new Date().toISOString(), 'unhandled', e && e.stack ? e.stack : e));
  start().then((s) => console.log('Firstcall is running on port ' + s.port + ', data in ' + DATA_DIR));
}

module.exports = { start };
