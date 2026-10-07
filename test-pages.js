'use strict';
/* Checks the Google script behind the GitHub Pages copy of Firstcall, run with: npm test
   The script (docs/script.txt) is run here against stand-ins for Gmail, Google's storage and ServiceM8.
   Names and details are made up. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, fakeSm8, formEmail } = require('./google-stand-ins');

require('./build-pages'); /* the script under test is always the freshly built one */

const SM8_KEY = 'testkey_1234567890abcdef';
const now = Date.now();
const DAY = 864e5;
let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

const person = (i, extra) => formEmail([['Name', 'Person ' + i], ['Email', 'p' + i + '@example.com'], ['Phone', '+61 0 4000 ' + String(10000 + i)], ['How many stories is your building?', '1'], ['How many solar panels? (if applicable)', String(10 + (i % 30))], ['Address', i + ' Example Street, Bargara QLD 4670, Australia'], ['How did you hear about us?', 'Google Search'], ['Message', (extra || 'Please call about a clean.')]]);
const inbox = [];
for (let i = 0; i < 43; i++) inbox.push({ id: 'thread' + String(i).padStart(4, '0'), at: now - (i + 1) * 3 * DAY, msgs: [{ id: 'msg' + String(i).padStart(4, '0') + 'a', html: person(i) }].concat(i % 10 === 0 ? [{ id: 'msg' + String(i).padStart(4, '0') + 'b', at: now - (i + 1) * 3 * DAY + 3600e3, html: person(i, 'Second enquiry from the same person.') }] : []) });
inbox.push({ id: 'threadold', at: now - 500 * DAY, msgs: [{ id: 'msgtooold001', html: person(900) }] });
inbox.push({ id: 'threadnotform', at: now - 2 * DAY, msgs: [{ id: 'msgnotaform01', html: '<p>Your Squarespace invoice is ready.</p>', subject: 'Invoice' }] });

const sm8 = fakeSm8(SM8_KEY);
const world = { owner: 'owner@example.com', inbox, sm8: sm8.handle };
const g = load(world);

/* ---------- who may talk to it ---------- */
assert.match(g.get(), /Firstcall script is running/);
assert.equal(g.post({ action: 'sync' }).error.code, 'bad_key', 'nothing is answered before it is connected');
const claim = g.post({ action: 'claim' });
assert.match(claim.key, /^[a-f0-9]{64}$/);
assert.equal(claim.owner, 'owner@example.com');
assert.equal(g.post({ action: 'claim' }).error.code, 'claimed', 'a second page cannot take it over');
assert.equal(g.post({ action: 'sync', k: 'x'.repeat(64) }).error.code, 'bad_key');
assert.equal(g.post({ action: 'sync', k: claim.key.slice(0, 63) }).error.code, 'bad_key');
const call = (action, body) => g.post(Object.assign({ k: claim.key, action }, body || {}));
assert.equal(call('nonsense').error.code, 'bad_request');
ok('answers only a Firstcall that has its key, and only the first page can claim it');

/* ---------- first run: the last 12 months, in pieces ---------- */
let r = call('sync', { rev: -1 });
let rounds = 1;
/* force several rounds the way a slow mailbox would: pretend each request runs out of time after one page */
while (r.more && rounds < 40) { r = call('sync', { rev: r.rev }); rounds++; }
assert.equal(r.more, false);
assert.equal(r.subs.length, 48, '43 people, 5 of them twice; the one from 500 days ago and the invoice are left out');
assert.ok(!r.subs.some((d) => d.name === 'Person 900'));
const p3 = r.subs.find((d) => d.mid === 'msg0003a');
assert.deepEqual({ name: p3.name, email: p3.email, phone: p3.phone, panels: p3.panels, storeys: p3.storeys, address: p3.address, source: p3.source, message: p3.message, form: p3.form, url: p3.url },
  { name: 'Person 3', email: 'p3@example.com', phone: '+61 0 4000 10003', panels: '13', storeys: '1', address: '3 Example Street, Bargara QLD 4670, Australia', source: 'Google Search', message: 'Please call about a clean.', form: 'Detailed Contact Form', url: 'https://mail.google.com/mail/u/0/#all/thread0003' });
assert.ok(r.subs.every((d, i) => i === 0 || r.subs[i - 1].at >= d.at), 'newest first');
const revA = r.rev;
const read = g.bodiesRead;
r = call('sync', { rev: revA });
assert.deepEqual([r.same, r.more, r.count], [true, false, 48]);
assert.equal(g.bodiesRead, read, 'a quiet check reads no email it has already dealt with, including the invoice');
assert.match(g.searches[g.searches.length - 1], /after:\d+$/, 'and only looks at recent mail');
{
  /* a slow mailbox: the first run is spread over several requests and ends with the same result */
  const slowWorld = { owner: 'owner@example.com', inbox: inbox.slice(), sm8: sm8.handle, slow: 5000 };
  const g3 = load(slowWorld);
  const k3 = g3.post({ action: 'claim' }).key;
  let x = g3.post({ k: k3, action: 'sync', rev: -1 });
  let turns = 1;
  const counts = [x.count];
  while (x.more && turns < 40) { x = g3.post({ k: k3, action: 'sync', rev: x.rev }); turns++; counts.push(x.count); }
  assert.ok(turns >= 2 && turns <= 6, 'spread over a few requests (' + turns + ')');
  assert.ok(counts[0] > 0 && counts[0] < 48, 'the first request already brings some leads back');
  assert.deepEqual([x.more, x.subs.length], [false, 48]);
}
ok('brings in the last 12 months once, then only looks for what is new');

/* ---------- a new enquiry, and coming back after a week away ---------- */
inbox.push({ id: 'threadnew1', at: Date.now() - 60000, msgs: [{ id: 'msgnew000001', html: person(501, 'Just sent this.') }] });
r = call('sync', { rev: revA });
assert.equal(r.subs.length, 49);
assert.equal(r.subs[0].name, 'Person 501');
assert.equal(r.rev, revA + 1);
g.script.api.setProperty('checkedAt', String(Date.now() - 9 * DAY)); /* the app was not opened for nine days */
inbox.push({ id: 'threadmissed', at: Date.now() - 6 * DAY, msgs: [{ id: 'msgmissed001', html: person(502) }] });
r = call('sync', { rev: r.rev });
assert.ok(r.subs.some((d) => d.name === 'Person 502'), 'an enquiry that arrived while the app was closed for days is still picked up');
ok('picks up new enquiries, including ones that arrived while the app was closed');

/* ---------- statuses and notes ---------- */
const revB = r.rev;
r = call('save', { lead: 'p0400010003', data: { status: 'contacted', notes: 'Gate code 4411', log: [{ t: now, text: 'Called' }] } });
assert.equal(r.rev, revB + 1);
assert.equal(call('save', { lead: 'bad key!', data: {} }).error.code, 'bad_request');
r = call('sync', { rev: revB });
assert.equal(r.leads.p0400010003.notes, 'Gate code 4411', 'another device sees the change');
const longLog = []; for (let i = 0; i < 400; i++) longLog.push({ t: now + i, text: 'Called, no answer, left a message number ' + i });
assert.ok(call('save', { lead: 'p0400010004', data: { status: 'contacted', notes: 'x', log: longLog } }).rev, 'a very long history is trimmed to fit rather than refused');
const kept = call('sync', { rev: -1 }).leads.p0400010004.log;
assert.ok(kept.length < 400 && kept[kept.length - 1].text.endsWith('399'), 'the most recent history is what is kept');
assert.equal(call('save', { lead: 'p0400010005', data: { notes: 'n'.repeat(9000) } }).error.code, 'too_big');
ok('saves statuses and notes for every device, within Google\'s size limits');

/* ---------- a very busy inbox stays inside Google's storage limits ---------- */
{
  const big = [];
  for (let i = 0; i < 640; i++) big.push({ id: 'big' + String(i).padStart(5, '0'), at: now - (i + 1) * 3600e3 * 12, msgs: [{ id: 'bigmsg' + String(i).padStart(6, '0'), html: person(2000 + i, 'Long message with accents: café — ' + 'detail '.repeat(300)) }] });
  const g2 = load({ owner: 'owner@example.com', inbox: big, sm8: sm8.handle });
  const k2 = g2.post({ action: 'claim' }).key;
  let x = g2.post({ k: k2, action: 'sync', rev: -1 });
  for (let i = 0; x.more && i < 100; i++) x = g2.post({ k: k2, action: 'sync', rev: x.rev });
  assert.equal(x.more, false);
  assert.ok(x.subs.length <= 500 && x.subs.length >= 300, 'keeps the newest enquiries (' + x.subs.length + ' of 640)');
  assert.ok(x.subs[0].message.length > 1000 && x.subs[x.subs.length - 1].message.length < 320, 'recent messages are kept whole; old long ones are shortened before anything is dropped');
  assert.equal(x.subs[0].name, 'Person 2000');
  assert.equal(g2.post({ k: k2, action: 'sync', rev: x.rev }).same, true, 'and does not re-read the ones it let go');
}
ok('a very busy inbox stays inside Google\'s storage limits');

/* ---------- ServiceM8 ---------- */
assert.equal(call('sm8.search', { query: 'Person 3' }).error.code, 'sm8_not_connected');
assert.equal(call('sm8.connect', { apiKey: 'short' }).error.code, 'bad_request');
r = call('sm8.connect', { apiKey: 'wrongkey_1234567890abcdef' });
assert.deepEqual([r.error.code, r.error.message], ['sm8_denied', 'the API key was not accepted']);
assert.deepEqual(call('sm8.connect', { apiKey: SM8_KEY }), { connected: true, business: 'Test Solar Co' });
assert.deepEqual(call('me'), { owner: 'owner@example.com', sm8: { connected: true, business: 'Test Solar Co' }, caughtUp: true });
assert.ok(!JSON.stringify(call('me')).includes(SM8_KEY) && !JSON.stringify(call('sync', { rev: -1 })).includes(SM8_KEY), 'the ServiceM8 key is never sent back to the app');
assert.equal(JSON.parse(call('sm8.search', { query: 'Existing Client' }).results[0].text).name, 'Existing Client');
assert.equal(call('sm8.search', { query: 'Gone Away' }).results.length, 0, 'inactive clients are not offered');
assert.equal(call('sm8.templates').job_templates[0].uuid, 'Quote');
r = call('sm8.job', { company_name: 'Person 3', job_address: '3 Example Street, Bargara QLD 4670', job_description: 'Website enquiry\nPhone: 0400 010 003', job_template_uuid: 'Quote', phone: '0400 010 003', email: 'p3@example.com' });
assert.deepEqual([r.job_number, r.existing_client, r.job_contact_saved], ['601', false, true]);
const made = sm8.companies.find((c) => c.name === 'Person 3');
assert.deepEqual(sm8.contacts[0], { company_uuid: made.uuid, type: 'BILLING', is_primary_contact: '1', first: 'Person', last: '3', mobile: '0400010003', email: 'p3@example.com' });
assert.deepEqual([sm8.jobs[0].status, sm8.jobs[0].company_uuid, sm8.jobs[0].job_address], ['Quote', made.uuid, '3 Example Street, Bargara QLD 4670']);
assert.deepEqual([sm8.jobContacts[0].job_uuid, sm8.jobContacts[0].type], [sm8.jobs[0].uuid, 'JOB']);
r = call('sm8.job', { company_name: 'existing client', job_address: '9 Old Road', job_description: 'Repeat clean', job_template_uuid: 'Work Order' });
assert.deepEqual([r.existing_client, sm8.jobs[1].company_uuid, sm8.contacts.length], [true, 'c-existing', 1], 'an existing client gets a job, not a duplicate client');
assert.equal(call('sm8.job', { company_name: 'X', job_address: 'Y', job_template_uuid: 'Completed' }).error.code, 'bad_request');
sm8.failOn = 'POST /job.json';
r = call('sm8.job', { company_name: 'Half Done', job_address: '1 Part Way', job_description: 'x', job_template_uuid: 'Quote', phone: '0400 000 111' });
assert.deepEqual([r.error.code, r.error.step, r.error.done], ['sm8_refused', 'creating the job', ['client', 'client contact']], 'a failure part-way says what was already created');
sm8.failOn = '';
assert.deepEqual(call('sm8.disconnect'), { connected: false });
assert.equal(call('sm8.templates').error.code, 'sm8_not_connected');
ok('connects ServiceM8, spots existing clients, creates client, contact, job and job contact');

/* ---------- the link for another device, and cutting everything off ---------- */
r = call('mailLink', { link: 'https://will-richter.github.io/Firstcall/#c=abc' });
assert.deepEqual(r, { sent: true, to: 'owner@example.com' });
assert.equal(g.sent.length, 1);
assert.ok(g.sent[0].to === 'owner@example.com' && g.sent[0].body.includes('https://will-richter.github.io/Firstcall/#c=abc'), 'the link only ever goes to the owner of the script');
assert.equal(call('mailLink', { link: 'https://will-richter.github.io/Firstcall/#c=abc' }).error.code, 'slow_down');
assert.equal(call('mailLink', { link: 'javascript:alert(1)' }).error.code, 'bad_request');
g.run('disconnectEverything');
assert.equal(call('sync', { rev: -1 }).error.code, 'bad_key', 'after "disconnectEverything" the old key no longer works');
assert.match(g.post({ action: 'claim' }).key, /^[a-f0-9]{64}$/);
ok('emails the connection link to the owner only, and can cut every device off');

/* ---------- the built site ---------- */
const page = fs.readFileSync(path.join(__dirname, 'docs', 'index.html'), 'utf8');
const inline = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
assert.ok(page.includes("'sha256-" + require('node:crypto').createHash('sha256').update(inline).digest('base64') + "'"), 'the page script is the one its security policy allows');
for (const f of ['link.js', 'setup.js', 'setup.css', 'sw.js', 'manifest.webmanifest', 'script.txt', 'icon-192.png', 'apple-touch-icon.png', '.nojekyll']) assert.ok(fs.existsSync(path.join(__dirname, 'docs', f)), f);
assert.ok(!/(src|href)="\//.test(page), 'every file is addressed relative to the page, so it works under /Firstcall/');
ok('the GitHub Pages site is complete and self-consistent');

console.log('\nAll ' + n + ' checks passed.');
