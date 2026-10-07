'use strict';
/* A small router and response helpers on top of Node's built-in http module, so the app has no dependencies to install. */
const fs = require('node:fs');

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || null; }
}

function createRouter() {
  const routes = [];
  function add(method, pattern, handler) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:[a-z]+/gi, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, handler });
  }
  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      try { r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); }); } catch (e) { return null; }
      return { handler: r.handler, params };
    }
    return null;
  }
  return { add, match, get: (p, h) => add('GET', p, h), post: (p, h) => add('POST', p, h), put: (p, h) => add('PUT', p, h), del: (p, h) => add('DELETE', p, h) };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        /* Say so properly rather than hanging up, but stop listening if the sender carries on regardless. */
        fail(new HttpError(413, 'too_large', 'That request is too large'));
        chunks.length = 0;
        if (size > limit + 4 * 1024 * 1024) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => fail(new HttpError(400, 'bad_request', 'The request was cut off')));
    req.on('aborted', () => fail(new HttpError(400, 'bad_request', 'The request was cut off')));
  });
}

async function readJson(req, limit) {
  const type = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'bad_request', 'Send JSON');
  const buf = await readBody(req, limit || 262144);
  try {
    const v = JSON.parse(buf.toString('utf8') || 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (e) {
    throw new HttpError(400, 'bad_request', 'That was not valid JSON');
  }
}

function sendJson(res, status, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function sendText(res, status, text, type, headers) {
  const body = Buffer.from(String(text));
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': body.length }, headers || {}));
  res.end(body);
}

/* Small static files, read once at start and served from memory. */
function loadStatic(file, type) {
  const body = fs.readFileSync(file);
  return { body, type };
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

/* The caller's address. A caller can write anything into X-Forwarded-For, so it is only believed when the host says
   it has its own proxy in front (TRUST_PROXY=1, or the number of proxies), and then only the entry that proxy added. */
function clientIp(req) {
  const direct = (req.socket && req.socket.remoteAddress) || '';
  const hops = Number(process.env.TRUST_PROXY || 0);
  if (!(hops >= 1)) return direct;
  const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = list[list.length - Math.min(hops, list.length)];
  return (ip || direct).slice(0, 64);
}

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!(req.socket && req.socket.encrypted);
}

/* Counts events per key inside a rolling window, to slow down password guessing and runaway senders.
   The table has a size limit: once it is full, unknown keys are refused until old entries expire. */
function createLimiter(max, windowMs, maxKeys) {
  const hits = new Map();
  const cap = maxKeys || 20000;
  const sweep = () => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k); };
  const timer = setInterval(sweep, Math.min(windowMs, 60000));
  timer.unref();
  return {
    hit(key) {
      key = String(key).slice(0, 300);
      const now = Date.now();
      let v = hits.get(key);
      if (!v || now - v.start > windowMs) {
        if (!v && hits.size >= cap) { sweep(); if (hits.size >= cap) return false; }
        v = { start: now, n: 0 };
        hits.set(key, v);
      }
      v.n++;
      return v.n <= max;
    },
    blocked(key) { const v = hits.get(String(key).slice(0, 300)); return !!v && Date.now() - v.start <= windowMs && v.n >= max; },
    clear(key) { hits.delete(String(key).slice(0, 300)); },
  };
}

module.exports = { HttpError, createRouter, readJson, sendJson, sendText, loadStatic, parseCookies, clientIp, isHttps, createLimiter };
