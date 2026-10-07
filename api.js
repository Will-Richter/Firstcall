'use strict';
/* The app's own API. Every query is limited to the signed-in user's business (account_id). */
const { HttpError, readJson, sendJson, sendText, parseCookies, clientIp, isHttps, createLimiter } = require('./http');
const mail = require('./mail');
const sm8 = require('./sm8');
const push = require('./push');

const SESSION_DAYS = 60;
const COOKIE = 'fc_s';
const KEY_RE = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

module.exports = function register(router, ctx) {
  const { store, secure, masterKey } = ctx;
  const st = store.st;
  /* Wrong passwords are counted three ways: per caller and email (8), per email from anywhere (40) and per caller (60),
     each over 15 minutes. Resets are counted separately and more tightly. */
  const loginLimiter = createLimiter(8, 15 * 60 * 1000);
  const emailLimiter = createLimiter(40, 15 * 60 * 1000);
  const callerLimiter = createLimiter(60, 15 * 60 * 1000);
  const resetLimiter = createLimiter(5, 15 * 60 * 1000);
  const badKeyLimiter = createLimiter(30, 60 * 1000);
  const MAX_ENQUIRIES = 20000;
  const MAX_LEADS = 20000;
  const signupLimiter = createLimiter(5, 60 * 60 * 1000);
  const ingestLimiter = createLimiter(240, 60 * 1000);

  /* ---------- sessions ---------- */
  function sessionOf(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const hash = secure.sha256(token);
    const s = st.session.get(hash);
    if (!s) return null;
    const now = Date.now();
    if (now - s.last_seen > SESSION_DAYS * 864e5) { st.dropSession.run(hash); return null; }
    if (now - s.last_seen > 3600e3) st.touchSession.run(now, hash);
    const account = st.accountById.get(s.account_id);
    return account ? { account, hash } : null;
  }
  function startSession(req, res, accountId) {
    const token = secure.randomToken(32);
    const now = Date.now();
    st.insertSession.run(secure.sha256(token), accountId, now, now);
    res.setHeader('Set-Cookie', COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400 + (isHttps(req) ? '; Secure' : ''));
  }
  function endSession(req, res, hash) {
    if (hash) st.dropSession.run(hash);
    res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isHttps(req) ? '; Secure' : ''));
  }
  /* Changes are only accepted from the app's own pages: the custom header cannot be sent by another site's form. */
  function guard(req) {
    if (req.method !== 'GET' && req.headers['x-firstcall'] !== '1') throw new HttpError(403, 'forbidden', 'Not allowed');
  }
  function authed(handler) {
    return async (req, res, params, url) => {
      guard(req);
      const s = sessionOf(req);
      if (!s) throw new HttpError(401, 'signed_out', 'Log in again');
      return handler(req, res, { params, url, account: s.account, sessionHash: s.hash });
    };
  }
  function open(handler) {
    return async (req, res, params, url) => { guard(req); return handler(req, res, { params, url }); };
  }
  const bump = (accountId) => { st.bump.run(accountId); return st.accountById.get(accountId).rev; };
  const setting = (accountId, key) => { const r = st.getSetting.get(accountId, key); return r ? r.value : null; };
  const sameSecret = (a, b) => require('node:crypto').timingSafeEqual(Buffer.from(secure.sha256(a), 'hex'), Buffer.from(secure.sha256(b), 'hex'));
  const signupsOpen = () => st.countAccounts.get().n === 0 || process.env.SIGNUPS === 'on';

  function publicUrl(req) {
    if (ctx.publicUrl) return ctx.publicUrl;
    return (isHttps(req) ? 'https' : 'http') + '://' + String(req.headers.host || 'localhost');
  }
  function newIngestKey(accountId) {
    const key = 'fcin_' + secure.randomToken(24);
    st.setSetting.run(accountId, 'ingest_hash', secure.sha256(key));
    st.setSetting.run(accountId, 'ingest_enc', secure.seal(masterKey, key));
    return key;
  }
  function ingestKey(accountId) {
    const enc = setting(accountId, 'ingest_enc');
    return (enc && secure.unseal(masterKey, enc)) || newIngestKey(accountId);
  }
  function sm8Key(accountId) {
    const enc = setting(accountId, 'sm8_enc');
    return enc ? secure.unseal(masterKey, enc) : null;
  }
  function describe(req, account) {
    const subs = st.countSubs.get(account.id);
    return {
      email: account.email,
      sm8: { connected: !!setting(account.id, 'sm8_enc'), business: setting(account.id, 'sm8_business') || '' },
      mail: { count: subs.n, lastAt: subs.last || null },
      push: { key: ctx.identity.publicKey, phones: st.countPush.get(account.id).n },
    };
  }

  /* ---------- account ---------- */
  router.get('/api/me', async (req, res) => {
    const s = sessionOf(req);
    if (!s) return sendJson(res, 200, { signedIn: false, firstRun: st.countAccounts.get().n === 0, signups: signupsOpen() });
    sendJson(res, 200, Object.assign({ signedIn: true }, describe(req, s.account)));
  });

  router.post('/api/signup', open(async (req, res) => {
    if (!signupsOpen()) throw new HttpError(403, 'closed', 'New accounts are switched off on this server');
    if (!signupLimiter.hit(clientIp(req))) throw new HttpError(429, 'slow_down', 'Too many attempts. Try again in an hour.');
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'bad_email', 'Enter a valid email address');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'bad_password', 'Use a password of at least 8 characters');
    const owner = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
    if (owner && st.countAccounts.get().n === 0 && email !== owner) throw new HttpError(403, 'closed', 'This Firstcall is waiting for its owner to create the first account');
    if (st.accountByEmail.get(email)) throw new HttpError(409, 'exists', 'There is already an account with that email. Log in instead.');
    const r = st.insertAccount.run(email, secure.hashPassword(password), Date.now());
    const id = Number(r.lastInsertRowid);
    newIngestKey(id);
    startSession(req, res, id);
    sendJson(res, 200, Object.assign({ signedIn: true }, describe(req, st.accountById.get(id))));
  }));

  router.post('/api/login', open(async (req, res) => {
    const b = await readJson(req, 4096);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const wrong = () => new HttpError(401, 'wrong', 'That email and password do not match');
    if (!EMAIL_RE.test(email) || email.length > 200 || !password || password.length > 200) throw wrong();
    const ip = clientIp(req);
    const who = ip + '|' + email;
    if (loginLimiter.blocked(who) || emailLimiter.blocked(email) || callerLimiter.blocked(ip)) throw new HttpError(429, 'slow_down', 'Too many wrong attempts. Try again in 15 minutes.');
    const account = st.accountByEmail.get(email);
    const good = await secure.checkPassword(password, account ? account.pass : null);
    if (!account || !good) {
      loginLimiter.hit(who);
      emailLimiter.hit(email);
      callerLimiter.hit(ip);
      throw wrong();
    }
    loginLimiter.clear(who);
    startSession(req, res, account.id);
    sendJson(res, 200, Object.assign({ signedIn: true }, describe(req, account)));
  }));

  router.post('/api/logout', open(async (req, res) => {
    const s = sessionOf(req);
    endSession(req, res, s && s.hash);
    sendJson(res, 200, { signedIn: false });
  }));

  router.post('/api/password', authed(async (req, res, c) => {
    const b = await readJson(req, 4096);
    if (!loginLimiter.hit('pw|' + c.account.id)) throw new HttpError(429, 'slow_down', 'Too many attempts. Try again in 15 minutes.');
    if (!(await secure.checkPassword(String(b.current || '').slice(0, 200), c.account.pass))) throw new HttpError(401, 'wrong', 'Your current password is not right');
    const next = String(b.next || '');
    if (next.length < 8 || next.length > 200) throw new HttpError(400, 'bad_password', 'Use a password of at least 8 characters');
    st.setPass.run(secure.hashPassword(next), c.account.id);
    st.dropOtherSessions.run(c.account.id, c.sessionHash);
    st.delPushAll.run(c.account.id); /* other devices stop getting notifications too; this one turns its own back on */
    loginLimiter.clear('pw|' + c.account.id);
    sendJson(res, 200, { ok: true });
  }));

  /* Forgot password. This server cannot email a reset link, so the ServiceM8 API key connected to the account is the
     proof of ownership: whoever holds it can already reach the same clients. It resets the password and logs every device out. */
  router.post('/api/reset', open(async (req, res) => {
    const b = await readJson(req, 4096);
    const email = String(b.email || '').trim().toLowerCase();
    const wrong = () => new HttpError(401, 'wrong', 'That email and ServiceM8 API key do not match an account here');
    const next = String(b.next || '');
    if (next.length < 8 || next.length > 200) throw new HttpError(400, 'bad_password', 'Use a password of at least 8 characters');
    if (!EMAIL_RE.test(email) || email.length > 200) throw wrong();
    const ip = clientIp(req);
    if (!resetLimiter.hit('e|' + email) || !resetLimiter.hit('c|' + ip)) throw new HttpError(429, 'slow_down', 'Too many attempts. Try again in 15 minutes.');
    const account = st.accountByEmail.get(email);
    const key = account ? sm8Key(account.id) : null;
    const given = String(b.apiKey || '').trim().slice(0, 400);
    if (!key || !given || !sameSecret(key, given)) throw wrong();
    st.setPass.run(secure.hashPassword(next), account.id);
    st.dropOtherSessions.run(account.id, '');
    st.delPushAll.run(account.id);
    startSession(req, res, account.id);
    sendJson(res, 200, Object.assign({ signedIn: true }, describe(req, st.accountById.get(account.id))));
  }));

  /* ---------- leads ---------- */
  router.get('/api/data', authed(async (req, res, c) => {
    const have = Number(c.url.searchParams.get('rev') || 0);
    if (have === c.account.rev) return sendJson(res, 200, { rev: c.account.rev, same: true });
    const subs = st.subs.all(c.account.id).map((r) => JSON.parse(r.data));
    const leads = {};
    st.leads.all(c.account.id).forEach((r) => { leads[r.key] = JSON.parse(r.data); });
    const docs = {};
    st.docs.all(c.account.id).forEach((r) => { docs[r.path] = JSON.parse(r.data); });
    sendJson(res, 200, { rev: c.account.rev, subs, leads, docs });
  }));

  router.put('/api/leads/:key', authed(async (req, res, c) => {
    if (!KEY_RE.test(c.params.key)) throw new HttpError(400, 'bad_request', 'Bad lead id');
    const b = await readJson(req, 131072);
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw new HttpError(400, 'bad_request', 'Nothing to save');
    if (!st.hasLead.get(c.account.id, c.params.key) && st.countLeads.get(c.account.id).n >= MAX_LEADS) throw new HttpError(409, 'full', 'This account has reached its limit of saved leads');
    st.setLead.run(c.account.id, c.params.key, JSON.stringify(b.data), Date.now());
    sendJson(res, 200, { rev: bump(c.account.id) });
  }));

  router.put('/api/docs/meta/app', authed(async (req, res, c) => {
    const b = await readJson(req, 16384);
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw new HttpError(400, 'bad_request', 'Nothing to save');
    st.setDoc.run(c.account.id, 'meta/app', JSON.stringify(b.data));
    sendJson(res, 200, { ok: true });
  }));

  /* ---------- mail link ---------- */
  router.get('/api/mail', authed(async (req, res, c) => {
    const subs = st.countSubs.get(c.account.id);
    const url = publicUrl(req) + '/in/mail';
    const key = ingestKey(c.account.id);
    sendJson(res, 200, { url, key, count: subs.n, lastAt: subs.last || null, script: mailScript(url, key) });
  }));

  router.post('/api/mail/rotate', authed(async (req, res, c) => {
    const key = newIngestKey(c.account.id);
    const url = publicUrl(req) + '/in/mail';
    sendJson(res, 200, { url, key, script: mailScript(url, key) });
  }));

  function accountForIngest(req) {
    const m = /^Bearer\s+(\S{1,200})$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, 'no_key', 'Missing key');
    const ip = clientIp(req);
    if (badKeyLimiter.blocked(ip)) throw new HttpError(429, 'slow_down', 'Too many requests');
    const hash = secure.sha256(m[1]);
    const row = st.accountBySetting.get('ingest_hash', hash);
    if (!row) { badKeyLimiter.hit(ip); throw new HttpError(401, 'bad_key', 'That key is not recognised'); }
    if (!ingestLimiter.hit(row.account_id)) throw new HttpError(429, 'slow_down', 'Too many requests');
    return row.account_id;
  }

  async function store_(accountId, docs) {
    const fresh = [];
    const now = Date.now();
    let room = MAX_ENQUIRIES - st.countSubs.get(accountId).n;
    docs.forEach((d) => {
      if (!d || !/^[A-Za-z0-9_-]{4,64}$/.test(d.mid) || room <= 0) return;
      room--;
      const r = st.insertSub.run(accountId, d.mid, d.at, JSON.stringify(d), now);
      if (r.changes) fresh.push(d);
    });
    if (fresh.length) {
      bump(accountId);
      const recent = fresh.filter((d) => now - d.at < 24 * 3600e3).sort((a, b) => b.at - a.at);
      if (recent.length) {
        const payload = recent.length === 1
          ? { title: 'New website lead', body: mail.summary(recent[0]), key: mail.leadKey(recent[0]) }
          : { title: recent.length + ' new website leads', body: recent.slice(0, 3).map((d) => d.name).join(', ') + (recent.length > 3 ? ' and more' : ''), key: mail.leadKey(recent[0]) };
        push.notify(ctx, accountId, payload).catch(() => {});
      }
    }
    return fresh.length;
  }

  /* Form emails, sent by the mail link script running in the owner's own Google account. */
  router.post('/in/mail', async (req, res) => {
    const accountId = accountForIngest(req);
    const b = await readJson(req, 3 * 1024 * 1024);
    const list = Array.isArray(b.messages) ? b.messages.slice(0, 60) : [];
    const docs = list.map((m) => {
      if (!m || typeof m !== 'object' || st.hasSub.get(accountId, String(m.id || ''))) return null;
      return mail.toDoc({ id: m.id, threadId: m.threadId, date: m.date, subject: m.subject, from: m.from, html: String(m.html || '').slice(0, 250000), plain: String(m.plain || '').slice(0, 60000), url: m.url });
    });
    const added = await store_(accountId, docs);
    sendJson(res, 200, { received: list.length, added });
  });

  /* A lead pushed in directly by another tool (a call-answering service, an automation, a different form builder). */
  router.post('/in/lead', async (req, res) => {
    const accountId = accountForIngest(req);
    const b = await readJson(req, 65536);
    if (!mail.clean(b.name) && !mail.clean(b.phone) && !mail.clean(b.email)) throw new HttpError(400, 'bad_request', 'A lead needs a name, phone or email');
    const id = /^[A-Za-z0-9_-]{4,64}$/.test(String(b.id || '')) ? String(b.id) : 'd' + secure.randomToken(12);
    const added = await store_(accountId, [mail.fromDirect(Object.assign({}, b, { id }))]);
    sendJson(res, 200, { received: 1, added, id });
  });

  /* ---------- ServiceM8 ---------- */
  function sm8Fail(e) {
    if (e instanceof sm8.Sm8Error) {
      const status = e.code === 'denied' ? 409 : e.code === 'refused' ? 422 : 502;
      throw new HttpError(status, 'sm8_' + e.code, e.message, { done: e.done || [], step: e.step || '' });
    }
    throw e;
  }
  function needKey(accountId) {
    const key = sm8Key(accountId);
    if (!key) throw new HttpError(409, 'sm8_not_connected', 'it is not connected yet. Tap the account button at the top to connect it.');
    return key;
  }

  router.post('/api/sm8/connect', authed(async (req, res, c) => {
    const b = await readJson(req);
    const key = String(b.apiKey || '').trim();
    if (key.length < 16 || key.length > 300 || /\s/.test(key)) throw new HttpError(400, 'bad_key', 'That does not look like a ServiceM8 API key');
    let info;
    try { info = await sm8.verify(key); } catch (e) { sm8Fail(e); }
    st.setSetting.run(c.account.id, 'sm8_enc', secure.seal(masterKey, key));
    st.setSetting.run(c.account.id, 'sm8_business', info.business || '');
    sm8.forget(c.account.id);
    sendJson(res, 200, { connected: true, business: info.business || '' });
  }));

  router.del('/api/sm8', authed(async (req, res, c) => {
    st.delSetting.run(c.account.id, 'sm8_enc');
    st.delSetting.run(c.account.id, 'sm8_business');
    sm8.forget(c.account.id);
    sendJson(res, 200, { connected: false });
  }));

  router.post('/api/sm8/search', authed(async (req, res, c) => {
    const b = await readJson(req);
    const key = needKey(c.account.id);
    try { sendJson(res, 200, await sm8.search(c.account.id, key, String(b.query || '').slice(0, 200))); } catch (e) { sm8Fail(e); }
  }));

  router.get('/api/sm8/templates', authed(async (req, res, c) => {
    needKey(c.account.id);
    sendJson(res, 200, { job_templates: sm8.JOB_TYPES });
  }));

  router.post('/api/sm8/job', authed(async (req, res, c) => {
    const b = await readJson(req);
    const key = needKey(c.account.id);
    const name = mail.clean(b.company_name);
    const address = mail.clean(b.job_address);
    const status = String(b.job_template_uuid || '');
    if (!name) throw new HttpError(400, 'bad_request', 'the client needs a name');
    if (!address) throw new HttpError(400, 'bad_request', 'the job needs an address');
    if (!sm8.JOB_TYPES.some((t) => t.uuid === status)) throw new HttpError(400, 'bad_request', 'choose a job type');
    const email = EMAIL_RE.test(String(b.email || '').trim()) ? String(b.email).trim().slice(0, 200) : '';
    const digits = mail.phoneDigits(b.phone);
    try {
      sendJson(res, 200, await sm8.createJob(c.account.id, key, {
        name, address: address.slice(0, 500), description: String(b.job_description || '').slice(0, 4000) || 'Website enquiry', status,
        phoneDigits: digits.length >= 8 ? digits : '', email,
      }));
    } catch (e) { sm8Fail(e); }
  }));

  /* ---------- notifications ---------- */
  router.post('/api/push/subscribe', authed(async (req, res, c) => {
    const b = await readJson(req, 8192);
    const endpoint = String(b.endpoint || '');
    const k = b.keys || {};
    if (!push.allowedEndpoint(endpoint) || endpoint.length > 1000) throw new HttpError(400, 'bad_request', 'This phone gave a notification address that is not supported');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(String(k.p256dh || '')) || !/^[A-Za-z0-9_-]{16,40}$/.test(String(k.auth || ''))) throw new HttpError(400, 'bad_request', 'This phone gave notification keys that are not valid');
    if (st.countPush.get(c.account.id).n >= 12) throw new HttpError(409, 'too_many', 'Notifications are already on for 12 devices. Turn one off first.');
    st.addPush.run(endpoint, c.account.id, k.p256dh, k.auth, Date.now());
    sendJson(res, 200, { ok: true, phones: st.countPush.get(c.account.id).n });
  }));

  router.post('/api/push/unsubscribe', authed(async (req, res, c) => {
    const b = await readJson(req, 8192);
    st.delPushFor.run(String(b.endpoint || ''), c.account.id);
    sendJson(res, 200, { ok: true, phones: st.countPush.get(c.account.id).n });
  }));

  router.post('/api/push/test', authed(async (req, res, c) => {
    const r = await push.notify(ctx, c.account.id, { title: 'Firstcall', body: 'Notifications are on. New website leads will show up like this.' });
    sendJson(res, 200, r);
  }));

  router.get('/health', async (req, res) => sendText(res, 200, 'ok'));
};

/* The script the owner pastes into Google Apps Script. It runs in their own Google account every minute,
   finds website form emails it has not sent before, and posts only those to this server. */
function mailScript(url, key) {
  return [
    '/**',
    ' * Firstcall mail link.',
    ' * Sends new website form emails from this Gmail account to your Firstcall app.',
    ' * It only ever reads emails that match SEARCH below, and it sends them nowhere except FIRSTCALL_URL.',
    ' *',
    ' * To switch it on: choose "setup" in the function list at the top, press Run, and allow access when asked.',
    ' * Running "setup" again is safe; it re-sends the last 12 months and Firstcall ignores what it already has.',
    ' * To switch it off: open Triggers (the clock icon on the left) and delete the trigger.',
    ' */',
    'const FIRSTCALL_URL = ' + JSON.stringify(url) + ';',
    'const FIRSTCALL_KEY = ' + JSON.stringify(key) + ';',
    "const SEARCH = 'from:form-submission@squarespace.info';",
    '',
    'function setup() {',
    '  ScriptApp.getProjectTriggers().forEach(function (t) {',
    "    if (t.getHandlerFunction() === 'sendNewLeads') ScriptApp.deleteTrigger(t);",
    '  });',
    '  var props = PropertiesService.getScriptProperties();',
    "  props.deleteProperty('caughtUp');",
    "  props.deleteProperty('offset');",
    "  ScriptApp.newTrigger('sendNewLeads').timeBased().everyMinutes(1).create();",
    '  sendNewLeads();',
    '}',
    '',
    'function sendNewLeads() {',
    '  var lock = LockService.getScriptLock();',
    '  if (!lock.tryLock(1000)) return;',
    '  try {',
    '    var props = PropertiesService.getScriptProperties();',
    "    if (props.getProperty('caughtUp')) checkRecent(props); else catchUp(props);",
    '  } finally {',
    '    lock.releaseLock();',
    '  }',
    '}',
    '',
    '// First run: the last 12 months, 10 conversations at a time. If Google stops it part-way, the next run carries on.',
    'function catchUp(props) {',
    '  var started = Date.now();',
    "  var offset = Number(props.getProperty('offset') || 0);",
    '  while (Date.now() - started < 3 * 60 * 1000) {',
    "    var threads = GmailApp.search(SEARCH + ' newer_than:365d', offset, 10);",
    '    if (!threads.length) {',
    "      props.setProperty('caughtUp', '1');",
    "      props.deleteProperty('offset');",
    '      return;',
    '    }',
    '    var batch = [];',
    '    threads.forEach(function (t) {',
    '      t.getMessages().forEach(function (m) { batch.push(pack(m, t)); });',
    '    });',
    '    deliver(batch);',
    '    offset += threads.length;',
    "    props.setProperty('offset', String(offset));",
    '  }',
    '}',
    '',
    '// Every minute after that: the last day, and every six hours the last week in case anything was missed.',
    'function checkRecent(props) {',
    "  var sent = JSON.parse(props.getProperty('sent') || '[]');",
    '  var seen = {};',
    '  sent.forEach(function (id) { seen[id] = true; });',
    "  var wide = Date.now() - Number(props.getProperty('wideAt') || 0) > 6 * 60 * 60 * 1000;",
    "  var threads = GmailApp.search(SEARCH + ' newer_than:' + (wide ? '7d' : '1d'), 0, 50);",
    '  var batch = [];',
    '  threads.forEach(function (t) {',
    '    t.getMessages().forEach(function (m) {',
    '      if (!seen[m.getId()]) batch.push(pack(m, t));',
    '    });',
    '  });',
    '  if (batch.length) {',
    '    deliver(batch).forEach(function (id) { sent.push(id); });',
    "    props.setProperty('sent', JSON.stringify(sent.slice(-400)));",
    '  }',
    "  if (wide) props.setProperty('wideAt', String(Date.now()));",
    '}',
    '',
    'function pack(m, t) {',
    '  return {',
    '    id: m.getId(), threadId: t.getId(), date: m.getDate().getTime(),',
    '    subject: String(m.getSubject()).slice(0, 300), from: String(m.getFrom()).slice(0, 300),',
    '    html: String(m.getBody()).slice(0, 200000), url: t.getPermalink()',
    '  };',
    '}',
    '',
    'function post(messages) {',
    '  return UrlFetchApp.fetch(FIRSTCALL_URL, {',
    "    method: 'post', contentType: 'application/json',",
    "    headers: { Authorization: 'Bearer ' + FIRSTCALL_KEY },",
    '    payload: JSON.stringify({ messages: messages }), muteHttpExceptions: true',
    '  }).getResponseCode();',
    '}',
    '',
    '// Sends ten at a time and returns the ids that are dealt with. If a group is refused, its emails are sent one by',
    '// one, so a single odd email (400, 413 or 422) is set aside instead of holding up the rest. Anything else, such as',
    '// Firstcall being offline or the key being wrong, stops here and is tried again on the next run.',
    'function deliver(batch) {',
    '  var ok = [];',
    '  for (var i = 0; i < batch.length; i += 10) {',
    '    var part = batch.slice(i, i + 10);',
    '    var code = post(part);',
    '    if (code === 200) { part.forEach(function (p) { ok.push(p.id); }); continue; }',
    '    part.forEach(function (p) {',
    '      var one = post([p]);',
    '      if (one === 200 || one === 400 || one === 413 || one === 422) ok.push(p.id);',
    "      else throw new Error('Firstcall answered ' + one + '. Check the app is online and that this script is the latest copy from it.');",
    '    });',
    '  }',
    '  return ok;',
    '}',
    '',
  ].join('\n');
}

module.exports.mailScript = mailScript;
