'use strict';
/* End-to-end check of the server, run with: npm test
   It starts the real server on a throwaway database, with stand-ins for ServiceM8 and for a phone's push service,
   then walks through sign-up, receiving form emails, saving a lead, sending one to ServiceM8 and a notification. */
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SM8_KEY = 'testkey_1234567890abcdef';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const bodyOf = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

/* The exact shape Squarespace sends: every answer twice, first in a hidden preview block. Names and details are made up. */
function formEmail(fields) {
  const block = (pad) => fields.map(([l, v]) => `${pad}<p>\r\n${pad}  <b>${l}:</b>\r\n${pad}  <span>${v}</span>\r\n${pad}</p>\r\n`).join('\r\n');
  return '<!DOCTYPE html>\r\n<html lang="en">\r\n  <head>\r\n    <title>Form Submission - Detailed Contact Form</title>\r\n    <meta charset="utf-8" />\r\n  </head>\r\n  <body class="no-mail-styles">\r\n' +
    '    <div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">\r\n' + block('      ') + '    </div>\r\n' +
    '    <p>Sent via form submission from <i><a href="https://example.invalid/?ref=abc">Test Site</a></i></p>\r\n' + block('    ') +
    '    <p>Does this submission look like spam? <a href="https://example.invalid/?ref=def">Report it here.</a></p>\r\n<img src="https://example.invalid/l.gif" alt="" width=0 height=0></body></html>\r\n';
}
const NEW_FORM = [['Name', 'Test Person One'], ['Email', 'one@example.com'], ['Phone', '+61 0 4000 00001'], ['What would you like done?', 'Solar panel cleaning, Other cleaning (gutters, driveways, paths, etc.), Solar health check'], ['How many stories is your building?', '1'], ['How many solar panels? (if applicable)', '19'], ['Address', '1 Example Street, Moore Park Beach Qld 4670, Australia'], ['How did you hear about us?', 'Google Search'], ['Message', 'Quote on cleaning &amp; checking  panels, &lt;thanks&gt;.']];
const OLD_FORM = [['Name', 'Sample Two'], ['Email', ''], ['Phone', '+61 4 0000 0002'], ['How many stories is your building?', '2'], ['How many solar panels do you need cleaned?', 'Bout 40'], ['Address', '2 Sample Grove, Branyan QLD 4670, Australia'], ['How did you hear about us?', 'Facebook'], ['Message', '']];

(async () => {
  /* ---------- stand-in ServiceM8 ---------- */
  const sm8 = { companies: [{ uuid: 'c-existing', name: 'Existing Client', address: '9 Old Road', active: 1 }, { uuid: 'c-gone', name: 'Gone Away', address: '', active: 0 }], contacts: [], jobs: [], jobContacts: [], calls: [] };
  const sm8Server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await bodyOf(req);
    sm8.calls.push(req.method + ' ' + url.pathname);
    const send = (status, obj, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(JSON.stringify(obj)); };
    if (req.headers['x-api-key'] !== SM8_KEY) return send(401, { message: 'Unauthorised' });
    const json = body.length ? JSON.parse(body.toString()) : null;
    const id = (p) => p + '-' + crypto.randomBytes(4).toString('hex');
    if (req.method === 'GET' && url.pathname === '/vendor.json') return send(200, [{ uuid: 'v1', name: 'Test Solar Co' }]);
    if (req.method === 'GET' && url.pathname === '/company.json') {
      /* two pages, to prove the cursor is followed */
      if (url.searchParams.get('cursor') === '-1') return send(200, sm8.companies.slice(0, 1), { 'x-next-cursor': 'page2' });
      return send(200, sm8.companies.slice(1));
    }
    if (req.method === 'POST' && url.pathname === '/company.json') { const u = id('c'); sm8.companies.push(Object.assign({ uuid: u, active: 1 }, json)); return send(200, { errorCode: 0, message: 'OK' }, { 'x-record-uuid': u }); }
    if (req.method === 'POST' && url.pathname === '/companycontact.json') { sm8.contacts.push(json); return send(200, { errorCode: 0 }, { 'x-record-uuid': id('cc') }); }
    if (req.method === 'POST' && url.pathname === '/job.json') { const u = id('j'); sm8.jobs.push(Object.assign({ uuid: u, generated_job_id: String(600 + sm8.jobs.length + 1) }, json)); return send(200, { errorCode: 0 }, { 'x-record-uuid': u }); }
    if (req.method === 'POST' && url.pathname === '/jobcontact.json') { sm8.jobContacts.push(json); return send(200, { errorCode: 0 }, { 'x-record-uuid': id('jc') }); }
    const m = /^\/job\/([^/]+)\.json$/.exec(url.pathname);
    if (req.method === 'GET' && m) { const j = sm8.jobs.find((x) => x.uuid === m[1]); return j ? send(200, j) : send(404, { message: 'No such job' }); }
    send(404, { message: 'Unknown' });
  });
  const sm8Port = await listen(sm8Server);

  /* ---------- stand-in push service (what Apple or Google run for a phone) ---------- */
  const pushed = [];
  const pushServer = http.createServer(async (req, res) => { pushed.push({ path: req.url, headers: req.headers, body: await bodyOf(req) }); res.writeHead(201); res.end(); });
  const pushPort = await listen(pushServer);

  process.env.NODE_ENV = 'test';
  process.env.SM8_API_BASE = 'http://127.0.0.1:' + sm8Port;
  process.env.PUSH_TEST_ORIGIN = 'http://127.0.0.1:' + pushPort;
  delete process.env.SECRET_KEY;
  delete process.env.SIGNUPS;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firstcall-test-'));
  const app = await require('./server').start({ port: 0, dataDir });
  const base = 'http://127.0.0.1:' + app.port;

  let cookie = '';
  async function call(method, p, body, headers) {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: Object.assign({ 'X-Firstcall': '1' }, cookie ? { Cookie: cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  let n = 0;
  const ok = (name) => { n++; console.log('  ok  ' + name); };

  /* ---------- the page and its files ---------- */
  let r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<script src="\/shim\.js"><\/script>/);
  assert.match(r.text, /Firstcall Lead Desk/);
  const inline = /<script>([\s\S]*?)<\/script>/.exec(r.text)[1];
  assert.ok(r.headers.get('content-security-policy').includes("'sha256-" + crypto.createHash('sha256').update(inline).digest('base64') + "'"), 'the page script is the one the security policy allows');
  for (const f of ['/shim.js', '/gate.js', '/gate.css', '/sw.js', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png']) assert.equal((await call('GET', f)).status, 200, f);
  for (const f of ['/server.js', '/api.js', '/data/firstcall.db', '/package.json', '/secure.js']) assert.equal((await call('GET', f)).status, 404, f + ' must not be served');
  assert.ok(!(await call('GET', '/sw.js')).text.includes('__VERSION__'));
  ok('serves the app page and only its public files');

  /* ---------- accounts ---------- */
  r = await call('GET', '/api/me');
  assert.deepEqual([r.json.signedIn, r.json.firstRun, r.json.signups], [false, true, true]);
  assert.equal((await call('GET', '/api/data')).status, 401);
  assert.equal((await call('POST', '/api/signup', { email: 'owner@example.com', password: 'short' })).status, 400);
  assert.equal((await fetch(base + '/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'a request without the app header is refused');
  r = await call('POST', '/api/signup', { email: 'Owner@Example.com', password: 'correct horse' });
  assert.equal(r.status, 200);
  assert.equal(r.json.email, 'owner@example.com');
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const ownerCookie = cookie;
  cookie = '';
  assert.equal((await call('POST', '/api/signup', { email: 'second@example.com', password: 'another one' })).status, 403, 'sign-ups close after the first account');
  assert.equal((await call('POST', '/api/login', { email: 'owner@example.com', password: 'wrong wrong' })).status, 401);
  r = await call('POST', '/api/login', { email: 'owner@example.com', password: 'correct horse' });
  assert.equal(r.status, 200);
  ok('sign-up, log-in, and sign-ups closing after the first account');

  /* ---------- mail link ---------- */
  r = await call('GET', '/api/mail');
  assert.equal(r.status, 200);
  const ingest = r.json;
  assert.match(ingest.key, /^fcin_/);
  assert.ok(ingest.script.includes(ingest.key) && ingest.script.includes(ingest.url) && ingest.script.includes('everyMinutes(1)'));
  new Function(ingest.script); /* the script must at least be valid JavaScript */
  const post = (p, body, key) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, json: await x.json() }));
  assert.equal((await post('/in/mail', { messages: [] }, 'fcin_wrong')).status, 401);
  const now = Date.now();
  const messages = [
    { id: '1a1042cd8683ff6b', threadId: '1a1042cd8683ff6b', date: now - 3 * 3600e3, subject: 'Form Submission - Detailed Contact Form', from: 'Squarespace <form-submission@squarespace.info>', html: formEmail(NEW_FORM), url: 'https://mail.google.com/mail/u/0/#all/1a1042cd8683ff6b' },
    { id: '1a0b6ccf7c281193', threadId: '1a0b6ccf7c281193', date: now - 40 * 864e5, subject: 'Form Submission - Detailed Contact Form 5', from: 'form-submission@squarespace.info', html: formEmail(OLD_FORM), url: 'javascript:alert(1)' },
    { id: 'notaform00000001', threadId: 'x', date: now, subject: 'Hello', from: 'someone@example.com', html: '<p>Just saying hi</p>' },
  ];
  r = await post('/in/mail', { messages }, ingest.key);
  assert.deepEqual(r.json, { received: 3, added: 2 });
  r = await post('/in/mail', { messages }, ingest.key);
  assert.deepEqual(r.json, { received: 3, added: 0 }, 'the same emails sent twice are only stored once');
  r = await call('GET', '/api/data');
  const subs = r.json.subs;
  assert.equal(subs.length, 2);
  const one = subs.find((s) => s.mid === '1a1042cd8683ff6b');
  assert.deepEqual({ name: one.name, email: one.email, phone: one.phone, address: one.address, panels: one.panels, storeys: one.storeys, services: one.services, source: one.source, message: one.message, form: one.form, url: one.url },
    { name: 'Test Person One', email: 'one@example.com', phone: '+61 0 4000 00001', address: '1 Example Street, Moore Park Beach Qld 4670, Australia', panels: '19', storeys: '1', services: 'Solar panel cleaning, Other cleaning (gutters, driveways, paths, etc.), Solar health check', source: 'Google Search', message: 'Quote on cleaning & checking  panels, <thanks>.', form: 'Detailed Contact Form', url: 'https://mail.google.com/mail/u/0/#all/1a1042cd8683ff6b' });
  const two = subs.find((s) => s.mid === '1a0b6ccf7c281193');
  assert.deepEqual([two.name, two.email, two.phone, two.panels, two.storeys, two.message, two.form, two.url], ['Sample Two', '', '+61 4 0000 0002', 'Bout 40', '2', '', 'Detailed Contact Form 5', '']);
  r = await post('/in/lead', { name: 'Direct Dana', phone: '0400 000 003', message: 'Rang the after-hours line', source: 'Phone' }, ingest.key);
  assert.equal(r.json.added, 1);
  ok('receives form emails, reads every field, ignores repeats and non-form emails');

  /* ---------- emails built to cause trouble ---------- */
  {
    const mailer = require('./mail');
    const big = 240000;
    const nasty = {
      'unfinished fields': '<p><b>x:</b><span>'.repeat(Math.floor(big / 18)),
      'stray brackets': '<'.repeat(big),
      'endless spaces': '<p><b>Name:</b><span>A' + ' '.repeat(big) + '\nB</span></p>',
      'no at sign': '<p><b>Email:</b><span>' + 'a'.repeat(big) + '</span></p>',
      'unclosed entities': '<p><b>Name:</b><span>' + '&amp'.repeat(big / 4) + '</span></p>',
      'one long line': '<div>Name: ' + ' '.repeat(big) + 'x</div>',
    };
    for (const kind of Object.keys(nasty)) {
      const t0 = Date.now();
      mailer.toDoc({ id: 'hostile000000001', date: now, subject: ' '.repeat(5000) + 'Form Submission', html: nasty[kind] });
      assert.ok(Date.now() - t0 < 1500, 'an email with ' + kind + ' is read quickly (' + (Date.now() - t0) + 'ms)');
    }
    const d = mailer.toDoc({ id: 'future0000000001', date: now + 400 * 864e5, subject: 'Form Submission - X', html: formEmail([['Name', 'Tomorrow Person'], ['Email', 'real@example.com?bcc=other@example.net&body=hi'], ['Phone', '0400 000 010']]) });
    assert.ok(d.at <= Date.now(), 'an email dated in the future is filed as arriving now');
    assert.equal(d.email, 'real@example.com', 'only the address itself is kept from the email field');
    assert.equal(mailer.fromDirect({ id: 'direct1', name: 'A', email: 'x@example.com?cc=y@example.net' }).email, 'x@example.com');
    assert.equal(mailer.fieldsFromHtml('<P CLASS="a">\n<B>Name:</B> <SPAN>Upper <span>Case</span></SPAN>\n</P><pre>skip</pre><p>text only</p><p><b>Phone:</b><span>0400</span></p>').map((f) => f.label + '=' + f.value).join('|'), 'Name=Upper Case|Phone=0400');
  }
  ok('reads awkward or hostile emails quickly and safely');

  /* ---------- saving a lead ---------- */
  const rev0 = (await call('GET', '/api/data')).json.rev;
  assert.equal((await call('GET', '/api/data?rev=' + rev0)).json.same, true);
  r = await call('PUT', '/api/leads/p0400000001', { data: { status: 'contacted', notes: 'Gate code 4411', attempts: 1, log: [{ t: now, text: 'Called, no answer' }] } });
  assert.equal(r.json.rev, rev0 + 1);
  assert.equal((await call('PUT', '/api/leads/bad%20key', { data: {} })).status, 400);
  r = await call('GET', '/api/data?rev=' + rev0);
  assert.equal(r.json.leads.p0400000001.notes, 'Gate code 4411');
  r = await call('PUT', '/api/docs/meta/app', { data: { lastSyncAt: now } });
  assert.equal(r.status, 200);
  assert.equal(r.json.rev, undefined, 'saving the last-checked time does not count as having seen newer leads');
  assert.equal((await call('GET', '/api/data')).json.docs['meta/app'].lastSyncAt, now);
  ok('saves and returns lead status, notes and history');

  /* ---------- ServiceM8 ---------- */
  assert.equal((await call('POST', '/api/sm8/search', { query: 'Test Person One' })).status, 409, 'asks to connect first');
  r = await call('POST', '/api/sm8/connect', { apiKey: 'wrongkey_1234567890abcdef' });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /not accepted/);
  r = await call('POST', '/api/sm8/connect', { apiKey: SM8_KEY });
  assert.deepEqual(r.json, { connected: true, business: 'Test Solar Co' });
  assert.ok(!fs.readFileSync(path.join(dataDir, 'firstcall.db')).includes(SM8_KEY), 'the ServiceM8 key is not stored in the clear');
  r = await call('POST', '/api/sm8/search', { query: 'Existing Client' });
  assert.equal(r.json.results.length, 1);
  assert.equal(JSON.parse(r.json.results[0].text).name, 'Existing Client');
  assert.equal((await call('POST', '/api/sm8/search', { query: 'Test Person One' })).json.results.length, 0);
  assert.equal((await call('POST', '/api/sm8/search', { query: 'Gone Away' })).json.results.length, 0, 'inactive clients are not offered');
  assert.equal((await call('GET', '/api/sm8/templates')).json.job_templates[0].uuid, 'Quote');
  r = await call('POST', '/api/sm8/job', { company_name: 'Test Person One', job_address: '1 Example Street, Moore Park Beach Qld 4670', job_description: 'Website enquiry\nPhone: 0400 000 001', job_template_uuid: 'Quote', phone: '0400 000 001', email: 'one@example.com' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.job_number, r.json.existing_client, r.json.job_contact_saved], ['601', false, true]);
  const made = sm8.companies.find((c) => c.name === 'Test Person One');
  assert.ok(made && made.address === '1 Example Street, Moore Park Beach Qld 4670');
  assert.deepEqual(sm8.contacts[0], { company_uuid: made.uuid, type: 'BILLING', is_primary_contact: '1', first: 'Test Person', last: 'One', mobile: '0400000001', email: 'one@example.com' });
  assert.deepEqual([sm8.jobs[0].status, sm8.jobs[0].company_uuid, sm8.jobs[0].job_address], ['Quote', made.uuid, '1 Example Street, Moore Park Beach Qld 4670']);
  assert.deepEqual([sm8.jobContacts[0].job_uuid, sm8.jobContacts[0].mobile, sm8.jobContacts[0].type], [sm8.jobs[0].uuid, '0400000001', 'JOB']);
  r = await call('POST', '/api/sm8/job', { company_name: 'existing client', job_address: '9 Old Road', job_description: 'Repeat clean', job_template_uuid: 'Work Order', phone: '', email: '' });
  assert.deepEqual([r.json.existing_client, sm8.jobs[1].company_uuid, sm8.jobs[1].status, sm8.contacts.length], [true, 'c-existing', 'Work Order', 1], 'an existing client gets a job, not a duplicate client');
  assert.equal((await call('POST', '/api/sm8/job', { company_name: 'X', job_address: 'Y', job_description: '', job_template_uuid: 'Completed' })).status, 400);
  ok('connects ServiceM8, spots existing clients, creates client, contact, job and job contact');

  /* ---------- notifications ---------- */
  const phone = crypto.createECDH('prime256v1');
  const phonePublic = phone.generateKeys();
  const phoneAuth = crypto.randomBytes(16);
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://evil.example.com/x', keys: { p256dh: phonePublic.toString('base64url'), auth: phoneAuth.toString('base64url') } })).status, 400, 'only real push services are accepted');
  r = await call('POST', '/api/push/subscribe', { endpoint: process.env.PUSH_TEST_ORIGIN + '/push/abc', keys: { p256dh: phonePublic.toString('base64url'), auth: phoneAuth.toString('base64url') } });
  assert.equal(r.status, 200);
  r = await post('/in/mail', { messages: [{ id: '1a1137221b026d66', threadId: 't', date: Date.now() - 60000, subject: 'Form Submission - Detailed Contact Form', from: 'form-submission@squarespace.info', html: formEmail([['Name', 'Fresh Lead'], ['Phone', '0400 000 009'], ['How many solar panels? (if applicable)', '24'], ['Address', '5 New Street, Bargara QLD 4670, Australia'], ['Message', 'Please call']]) }] }, ingest.key);
  assert.equal(r.json.added, 1);
  for (let i = 0; i < 40 && !pushed.length; i++) await new Promise((x) => setTimeout(x, 50));
  assert.equal(pushed.length, 1, 'one notification for the new lead, none for the old ones');
  const got = pushed[0];
  assert.equal(got.headers['content-encoding'], 'aes128gcm');
  /* read it the way the phone would (RFC 8291) */
  const salt = got.body.subarray(0, 16), idLen = got.body[20], serverPublic = got.body.subarray(21, 21 + idLen), cipherText = got.body.subarray(21 + idLen);
  const shared = phone.computeSecret(serverPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, phoneAuth, Buffer.concat([Buffer.from('WebPush: info\0'), phonePublic, serverPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipherText.subarray(cipherText.length - 16));
  const plain = Buffer.concat([d.update(cipherText.subarray(0, cipherText.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, plain.length - 1).toString()), { title: 'New website lead', body: 'Fresh Lead · Bargara · 24 panels', key: 'p0400000009' });
  /* and check the server proved who it is (RFC 8292) */
  const auth = /^vapid t=([^,]+), k=(.+)$/.exec(got.headers.authorization);
  const [h64, p64, s64] = auth[1].split('.');
  const raw = Buffer.from(auth[2], 'base64url');
  const pub = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(h64 + '.' + p64), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')));
  const claims = JSON.parse(Buffer.from(p64, 'base64url').toString());
  assert.equal(claims.aud, process.env.PUSH_TEST_ORIGIN);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
  assert.equal((await call('GET', '/api/me')).json.push.key, auth[2]);
  /* the encryption itself, against the worked example published in the standard (RFC 8291, Appendix A) */
  {
    const b = (s) => Buffer.from(s, 'base64url');
    const V = { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', salt: 'DGv6ra1nlYgDCS1FRnbzlw', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN' };
    const realRandom = crypto.randomBytes, realECDH = crypto.createECDH;
    crypto.randomBytes = (len) => (len === 16 ? b(V.salt) : realRandom(len));
    crypto.createECDH = (curve) => { const e = realECDH(curve); e.generateKeys = () => { e.setPrivateKey(b(V.asPrivate)); return e.getPublicKey(); }; return e; };
    let out;
    try { out = require('./push').encrypt(V.uaPublic, V.auth, 'When I grow up, I want to be a watermelon'); } finally { crypto.randomBytes = realRandom; crypto.createECDH = realECDH; }
    assert.ok(out.equals(b(V.body)), 'matches the standard\'s worked example byte for byte');
  }
  r = await call('POST', '/api/push/test');
  assert.deepEqual(r.json, { phones: 1, sent: 1 });
  ok('sends an encrypted notification the phone can read, signed by this server');

  /* ---------- passwords, reset, log out ---------- */
  assert.equal((await call('POST', '/api/password', { current: 'nope nope', next: 'brand new pass' })).status, 401);
  assert.equal((await call('POST', '/api/password', { current: 'correct horse', next: 'brand new pass' })).status, 200);
  assert.equal((await call('GET', '/api/me')).json.push.phones, 0, 'changing the password stops notifications to devices set up before it');
  const keep = cookie;
  cookie = ownerCookie;
  assert.equal((await call('GET', '/api/data')).status, 401, 'changing the password logs other devices out');
  cookie = '';
  assert.equal((await call('POST', '/api/reset', { email: 'owner@example.com', apiKey: 'not the key', next: 'reset pass 1' })).status, 401);
  assert.equal((await call('POST', '/api/reset', { email: 'owner@example.com', apiKey: SM8_KEY, next: 'reset pass 1' })).status, 200);
  cookie = keep;
  assert.equal((await call('GET', '/api/data')).status, 401, 'a reset logs every device out');
  cookie = '';
  assert.equal((await call('POST', '/api/login', { email: 'owner@example.com', password: 'reset pass 1' })).status, 200);
  assert.equal((await call('POST', '/api/logout', {})).status, 200);
  assert.equal((await call('GET', '/api/data')).status, 401);
  ok('password change, reset with the ServiceM8 key, and log-out');

  /* ---------- wrong guesses are slowed down ---------- */
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await call('POST', '/api/login', { email: 'owner@example.com', password: 'guess ' + i }, { 'X-Forwarded-For': '10.0.0.' + i })).status;
  assert.equal(last, 429, 'pretending to come from a different address each time does not get round it');
  assert.equal((await call('POST', '/api/login', { email: 'owner@example.com', password: 'reset pass 1' })).status, 429, 'and the right password has to wait too');
  const t1 = Date.now();
  assert.equal((await call('POST', '/api/login', { email: 'x'.repeat(300000) + '@example.com', password: 'whatever 1' })).status, 413);
  assert.equal((await call('POST', '/api/login', { email: 'nobody@example.com', password: 'whatever 1' })).status, 401);
  for (let i = 0; i < 6; i++) last = (await call('POST', '/api/reset', { email: 'owner@example.com', apiKey: 'guess' + i, next: 'another pass' })).status;
  assert.equal(last, 429, 'reset attempts are limited as well');
  assert.ok(Date.now() - t1 < 5000);
  ok('repeated wrong passwords are blocked for a while');

  /* ---------- the Google script, run here against stand-ins for Gmail and Google's script services ---------- */
  {
    const vm = require('node:vm');
    const inbox = []; /* newest first, as Gmail returns them */
    for (let i = 0; i < 27; i++) inbox.push({ id: 'thread' + i, age: i * 5, msgs: [{ id: 'msg' + i + 'a' }, ...(i % 9 === 0 ? [{ id: 'msg' + i + 'b' }] : [])] });
    const g = { props: {}, posts: [], triggers: [], searches: [], answer: () => 200 };
    const days = (q) => Number(/newer_than:(\d+)d/.exec(q)[1]);
    const sandbox = {
      JSON, Date, String, Number, Error,
      GmailApp: { search: (q, start, max) => { g.searches.push(q); return inbox.filter((t) => t.age < days(q)).slice(start, start + max).map((t) => ({ getId: () => t.id, getPermalink: () => 'https://mail.google.com/mail/u/0/#all/' + t.id, getMessages: () => t.msgs.map((m) => ({ getId: () => m.id, getDate: () => new Date(now - t.age * 864e5), getSubject: () => 'Form Submission - Test', getFrom: () => 'form-submission@squarespace.info', getBody: () => '<p><b>Name:</b><span>' + m.id + '</span></p>' })) })); } },
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in g.props ? g.props[k] : null), setProperty: (k, v) => { assert.ok(String(v).length < 9000, 'stays inside Google\'s size limit for a saved value'); g.props[k] = String(v); }, deleteProperty: (k) => { delete g.props[k]; } }) },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
      ScriptApp: { getProjectTriggers: () => g.triggers, deleteTrigger: (t) => { g.triggers.splice(g.triggers.indexOf(t), 1); }, newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (m) => ({ create: () => { g.triggers.push({ getHandlerFunction: () => fn, minutes: m }); } }) }) }) },
      UrlFetchApp: { fetch: (url, o) => { const body = JSON.parse(o.payload); assert.equal(url, ingest.url); assert.equal(o.headers.Authorization, 'Bearer ' + ingest.key); const code = g.answer(body.messages); g.posts.push({ ids: body.messages.map((m) => m.id), code }); return { getResponseCode: () => code }; } },
    };
    vm.createContext(sandbox);
    vm.runInContext(ingest.script, sandbox);
    const run = (fn) => vm.runInContext(fn + '()', sandbox);
    const delivered = () => new Set(g.posts.filter((x) => x.code === 200).flatMap((x) => x.ids));
    run('setup'); run('setup');
    assert.equal(g.triggers.length, 1, 'running setup twice leaves one timer, not two');
    assert.equal(delivered().size, 30, 'the first run sends every form email from the last 12 months');
    assert.equal(g.props.caughtUp, '1');
    assert.ok(g.posts.every((x) => x.ids.length <= 10));
    g.posts.length = 0;
    run('sendNewLeads');
    const firstRegular = g.posts.flatMap((x) => x.ids).length;
    g.posts.length = 0; g.searches.length = 0;
    run('sendNewLeads'); run('sendNewLeads');
    assert.equal(g.posts.length, 0, 'nothing is sent again once it has been delivered (' + firstRegular + ' re-checked once)');
    assert.ok(g.searches.every((q) => /newer_than:1d$/.test(q)), 'quiet runs only look at the last day');
    inbox.unshift({ id: 'threadNew', age: 0, msgs: [{ id: 'msgNew1' }] });
    g.answer = () => 503;
    assert.throws(() => run('sendNewLeads'), /Firstcall answered 503/, 'an outage is reported, not swallowed');
    g.answer = () => 200; g.posts.length = 0;
    run('sendNewLeads');
    assert.deepEqual(g.posts.map((x) => x.ids), [['msgNew1']], 'and the lead goes through on the next run');
    inbox.unshift({ id: 'threadOdd', age: 0, msgs: [{ id: 'msgOdd' }, { id: 'msgFine' }] });
    g.answer = (ms) => (ms.some((m) => m.id === 'msgOdd') ? 413 : 200); g.posts.length = 0;
    run('sendNewLeads');
    assert.ok(delivered().has('msgFine'), 'one email the server refuses does not hold up the others');
    g.posts.length = 0;
    run('sendNewLeads');
    assert.equal(g.posts.length, 0, 'and the refused one is not retried forever');
    /* the script's own output is accepted by the real server */
    const real = [];
    sandbox.UrlFetchApp.fetch = (url, o) => { real.push(o.payload); return { getResponseCode: () => 200 }; };
    inbox.unshift({ id: 'threadReal', age: 0, msgs: [{ id: 'msgReal0001' }] });
    run('sendNewLeads');
    const sentOn = await fetch(base + '/in/mail', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ingest.key }, body: real[0] });
    assert.deepEqual(await sentOn.json(), { received: 1, added: 1 });
  }
  ok('the Google script catches up, stays quiet when there is nothing new, and recovers from failures');

  await app.close();
  sm8Server.close();
  pushServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('\nAll ' + n + ' checks passed.');
})().catch((e) => { console.error('\nFAILED:', e && e.stack ? e.stack : e); process.exit(1); });
