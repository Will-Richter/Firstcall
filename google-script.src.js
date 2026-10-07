/* ------------------------------------------------------------------------------------------------------------
   The part below answers the Firstcall app. Every request must carry this script's key.
   ------------------------------------------------------------------------------------------------------------ */

const SEARCH = 'from:form-submission@squarespace.info';
const MAX_ENQUIRIES = 500;      /* newest kept; older ones drop off the end */
const CHUNK_BYTES = 8000;       /* Google allows about 9 KB per saved value */
const STORE_BYTES = 400000;     /* Google allows about 500 KB per store */
const SM8 = 'https://api.servicem8.com/api_1.0';
const JOB_TYPES = [{ uuid: 'Quote', name: 'Quote' }, { uuid: 'Work Order', name: 'Work order' }];

function doGet() {
  return HtmlService.createHtmlOutput('<p style="font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:3em auto;padding:0 1em">' +
    'The Firstcall script is running. Go back to Firstcall and paste this page\'s address (the Web app URL from the Deploy window) into the box there.</p>');
}

function doPost(e) {
  let out;
  try {
    out = handle(JSON.parse(e.postData.contents));
  } catch (err) {
    out = { error: { code: err.code || 'failed', message: String(err.message || err), done: err.done || undefined, step: err.step || undefined } };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* Run this from the editor to cut off every phone and computer that is connected. Then connect again from Firstcall. */
function disconnectEverything() {
  PropertiesService.getScriptProperties().deleteProperty('key');
}

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) { e.done = extra.done; e.step = extra.step; }
  return e;
}

function sameText(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function handle(req) {
  const sp = PropertiesService.getScriptProperties();
  const action = String(req.action || '');
  if (action === 'claim') {
    /* The first Firstcall page to ask becomes the owner's and is given the key. After that the key is needed. */
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (sp.getProperty('key')) throw fail('claimed', 'This script is already connected. Open Firstcall from your connection link instead, or run "disconnectEverything" in the script and connect again.');
      const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
      sp.setProperty('key', key);
      return { key: key, owner: Session.getEffectiveUser().getEmail() };
    } finally { lock.releaseLock(); }
  }
  const key = sp.getProperty('key');
  if (!key || !req.k || !sameText(key, req.k)) throw fail('bad_key', 'This device is not connected to this script any more.');
  if (action === 'sync') return sync(req);
  if (action === 'save') return saveLead(req);
  if (action === 'me') return me();
  if (action === 'mailLink') return mailLink(req);
  if (action === 'sm8.connect') return sm8Connect(req);
  if (action === 'sm8.disconnect') { const up = PropertiesService.getUserProperties(); up.deleteProperty('sm8'); up.deleteProperty('sm8name'); return { connected: false }; }
  if (action === 'sm8.search') return sm8Search(req);
  if (action === 'sm8.templates') { sm8Key(); return { job_templates: JOB_TYPES }; }
  if (action === 'sm8.job') return sm8Job(req);
  throw fail('bad_request', 'Firstcall asked for something this script does not know. Copy the latest script from Firstcall and paste it over this one.');
}

/* ---------- saved enquiries (kept in this script's own storage, in pieces small enough for Google's limits) ---------- */
function bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3; }
  return n;
}

function loadSubs(all) {
  const n = Number(all.sn || 0);
  let subs = [];
  for (let i = 0; i < n; i++) { try { subs = subs.concat(JSON.parse(all['s' + i] || '[]')); } catch (e) { /* a damaged piece is skipped */ } }
  return subs;
}

function storeSubs(sp, all, subs) {
  subs.sort((a, b) => b.at - a.at);
  if (subs.length > MAX_ENQUIRIES) subs.length = MAX_ENQUIRIES;
  let chunks;
  for (let pass = 0; pass < 60; pass++) {
    chunks = [];
    let cur = [], size = 2, total = 0;
    subs.forEach((d) => {
      const b = bytes(JSON.stringify(d)) + 1;
      if (cur.length && size + b > CHUNK_BYTES) { chunks.push(cur); cur = []; size = 2; }
      cur.push(d); size += b; total += b;
    });
    if (cur.length) chunks.push(cur);
    if (total <= STORE_BYTES || subs.length < 20) break;
    /* Over Google's storage limit. First shorten the long messages on older enquiries; if that is not enough, let the oldest go. */
    let cut = false;
    subs.forEach((d, i) => { if (i >= 100 && d.message.length > 300) { d.message = d.message.slice(0, 300) + '\u2026'; cut = true; } });
    if (!cut) subs.length = Math.floor(subs.length * 0.9);
  }
  const put = { sn: String(chunks.length) };
  chunks.forEach((c, i) => { put['s' + i] = JSON.stringify(c); });
  sp.setProperties(put);
  for (let i = chunks.length; i < Number(all.sn || 0); i++) sp.deleteProperty('s' + i);
  return subs;
}

function slim(d) {
  /* Kept small so a year of enquiries fits in Google's storage. */
  d.message = String(d.message || '').slice(0, 1500);
  d.extra = (d.extra || []).slice(0, 4).map((x) => ({ label: String(x.label).slice(0, 60), value: String(x.value).slice(0, 200) }));
  d.url = String(d.url || '').slice(0, 200);
  return d;
}

function leadsOf(up) {
  const all = up.getProperties();
  const leads = {};
  Object.keys(all).forEach((k) => { if (k.indexOf('L_') === 0) { try { leads[k.slice(2)] = JSON.parse(all[k]); } catch (e) { /* skip */ } } });
  return leads;
}

/* ---------- sync: look for new form emails, then hand back everything if anything changed ---------- */
function sync(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const started = Date.now();
    const sp = PropertiesService.getScriptProperties();
    const all = sp.getProperties();
    let subs = loadSubs(all);
    const seen = {};
    subs.forEach((d) => { seen[d.mid] = true; });
    let skipped = [];
    try { skipped = JSON.parse(all.skip || '[]'); } catch (e) { skipped = []; }
    skipped.forEach((id) => { seen[id] = true; });
    let rev = Number(all.rev || 0);
    let added = 0;
    const take = (threads) => {
      threads.forEach((t) => {
        t.getMessages().forEach((m) => {
          const id = m.getId();
          if (seen[id]) return;
          seen[id] = true;
          const d = toDoc({ id: id, threadId: t.getId(), date: m.getDate().getTime(), subject: String(m.getSubject()).slice(0, 300), from: m.getFrom(), html: String(m.getBody()).slice(0, 200000), url: t.getPermalink() });
          if (d) { subs.push(slim(d)); added++; } else skipped.push(id);
        });
      });
    };
    let more = false;
    const put = {};
    if (!all.caughtUp) {
      /* First time: the last 12 months, ten conversations at a time, a few seconds per request. Firstcall keeps asking until it is done. */
      let offset = Number(all.offset || 0);
      more = true;
      while (Date.now() - started < 12000) {
        const threads = GmailApp.search(SEARCH + ' newer_than:365d', offset, 10);
        if (!threads.length) { more = false; break; }
        take(threads);
        offset += threads.length;
      }
      if (more) put.offset = String(offset); else { put.caughtUp = '1'; put.checkedAt = String(started); sp.deleteProperty('offset'); }
    } else {
      /* After that: anything since the last look, with two days of overlap in case an email was slow to arrive. */
      const since = Math.floor((Number(all.checkedAt || started) - 2 * 864e5) / 1000);
      take(GmailApp.search(SEARCH + ' after:' + since, 0, 50));
      put.checkedAt = String(started);
    }
    if (added) { subs = storeSubs(sp, all, subs); rev++; put.rev = String(rev); }
    put.skip = JSON.stringify(skipped.slice(-150));
    sp.setProperties(put);
    if (!added && Number(req.rev) === rev) return { rev: rev, same: true, more: more, count: subs.length };
    return { rev: rev, more: more, count: subs.length, subs: subs, leads: leadsOf(PropertiesService.getUserProperties()) };
  } finally { lock.releaseLock(); }
}

/* ---------- a lead's status, notes and history ---------- */
function saveLead(req) {
  const key = String(req.lead || '');
  if (!/^[A-Za-z0-9_.~:@+-]{1,200}$/.test(key)) throw fail('bad_request', 'that lead could not be identified');
  if (!req.data || typeof req.data !== 'object') throw fail('bad_request', 'there was nothing to save');
  let text = JSON.stringify(req.data);
  if (bytes(text) > 8500 && Array.isArray(req.data.log)) {
    /* Too big for one saved value: keep the notes and the most recent history. */
    const d = JSON.parse(text);
    while (bytes(text) > 8500 && d.log.length > 1) { d.log.shift(); text = JSON.stringify(d); }
  }
  if (bytes(text) > 8500) throw fail('too_big', 'the notes on this lead are too long to save. Shorten them and try again.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    PropertiesService.getUserProperties().setProperty('L_' + key, text);
    const sp = PropertiesService.getScriptProperties();
    const rev = Number(sp.getProperty('rev') || 0) + 1;
    sp.setProperty('rev', String(rev));
    return { rev: rev };
  } finally { lock.releaseLock(); }
}

function me() {
  const up = PropertiesService.getUserProperties();
  const sp = PropertiesService.getScriptProperties();
  return { owner: Session.getEffectiveUser().getEmail(), sm8: { connected: !!up.getProperty('sm8'), business: up.getProperty('sm8name') || '' }, caughtUp: !!sp.getProperty('caughtUp') };
}

/* Emails the owner (and nobody else) the link that opens Firstcall already connected, to get it onto their phone. */
function mailLink(req) {
  const link = String(req.link || '');
  if (!/^(https:\/\/[a-z0-9.-]+|http:\/\/localhost(:\d+)?)\//i.test(link) || link.length > 1500) throw fail('bad_request', 'that link is not valid');
  const sp = PropertiesService.getScriptProperties();
  if (Date.now() - Number(sp.getProperty('mailedAt') || 0) < 60000) throw fail('slow_down', 'A link was emailed a moment ago. Check your inbox, or try again in a minute.');
  sp.setProperty('mailedAt', String(Date.now()));
  const to = Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(to, 'Open Firstcall on your phone',
    'Open this link on your phone to connect Firstcall, then add it to your Home Screen.\n\n' + link +
    '\n\nKeep this link to yourself: anyone who has it can see your website leads. If it gets out, open the Firstcall script and run "disconnectEverything".');
  return { sent: true, to: to };
}

/* ---------- ServiceM8, using the business's own API key (kept in this Google account, never sent back to the app) ---------- */
function sm8Key() {
  const key = PropertiesService.getUserProperties().getProperty('sm8');
  if (!key) throw fail('sm8_not_connected', 'it is not connected yet. Tap the account button at the top to connect it.');
  return key;
}

function sm8Call(key, method, path, body) {
  let res;
  try {
    const opt = { method: method.toLowerCase(), headers: { 'X-API-Key': key, Accept: 'application/json' }, muteHttpExceptions: true, followRedirects: false };
    if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
    res = UrlFetchApp.fetch(SM8 + path, opt);
  } catch (e) {
    throw fail('sm8_unreachable', "it didn't answer");
  }
  const status = res.getResponseCode();
  if (status === 401 || status === 403) throw fail('sm8_denied', status === 401 ? 'the API key was not accepted' : 'the API key is not allowed to do this');
  if (status === 429) throw fail('sm8_busy', 'it is rate limiting requests, try again in a minute');
  const text = res.getContentText() || '';
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (status < 200 || status >= 300) {
    const detail = (json && (json.message || json.error || json.errorMessage)) || text.slice(0, 200) || ('status ' + status);
    throw fail(status >= 500 ? 'sm8_unreachable' : 'sm8_refused', String(detail));
  }
  const headers = {};
  const raw = res.getHeaders() || {};
  Object.keys(raw).forEach((k) => { headers[k.toLowerCase()] = raw[k]; });
  return { json: json, uuid: headers['x-record-uuid'] || (json && json.uuid) || '', next: headers['x-next-cursor'] || '' };
}

function sm8Connect(req) {
  const key = String(req.apiKey || '').trim();
  if (key.length < 16 || key.length > 400 || /\s/.test(key)) throw fail('bad_request', 'That does not look like a ServiceM8 API key');
  const r = sm8Call(key, 'GET', '/vendor.json');
  const v = Array.isArray(r.json) ? r.json[0] : r.json;
  const business = (v && (v.name || v.business_name)) ? String(v.name || v.business_name).slice(0, 120) : '';
  const up = PropertiesService.getUserProperties();
  up.setProperty('sm8', key);
  up.setProperty('sm8name', business);
  return { connected: true, business: business };
}

function sm8Companies(key) {
  const list = [];
  let cursor = '-1';
  for (let page = 0; page < 30 && cursor; page++) {
    const r = sm8Call(key, 'GET', '/company.json?cursor=' + encodeURIComponent(cursor));
    (Array.isArray(r.json) ? r.json : []).forEach((c) => {
      if (c && c.uuid && c.name && String(c.active) !== '0') list.push({ uuid: String(c.uuid), name: String(c.name), address: String(c.address || '') });
    });
    cursor = r.next;
  }
  return list;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function sameName(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const x = a.split(' ');
  const y = b.split(' ');
  return x.length > 1 && y.length > 1 && x[x.length - 1] === y[y.length - 1] && x[0].charAt(0) === y[0].charAt(0);
}

/* Answers in the same shape as the ServiceM8 connector's "search", so one set of screens works everywhere. */
function sm8Search(req) {
  const query = String(req.query || '').slice(0, 200);
  const results = sm8Companies(sm8Key()).filter((c) => sameName(c.name, query)).slice(0, 10).map((c) => ({
    id: 'company-' + c.uuid, title: 'Company', text: JSON.stringify({ uuid: c.uuid, name: c.name, address: c.address }),
  }));
  return { results: results };
}

function contactFields(name, digits, email) {
  const w = String(name || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const c = { first: (w.length > 1 ? w.slice(0, -1).join(' ') : (w[0] || 'Customer')).slice(0, 60), last: (w.length > 1 ? w[w.length - 1] : '-').slice(0, 60) };
  if (digits) { if (/^04/.test(digits)) c.mobile = digits; else c.phone = digits; }
  if (email) c.email = email;
  return c;
}

/* Uses the existing client when one has exactly this name; otherwise creates the client and its contact first.
   Each step that worked is listed in "done", so a failure part-way can say exactly what now exists in ServiceM8. */
function sm8Job(req) {
  const key = sm8Key();
  const name = clean(req.company_name).slice(0, 100);
  const address = clean(req.job_address).slice(0, 500);
  const status = String(req.job_template_uuid || '');
  if (!name) throw fail('bad_request', 'the client needs a name');
  if (!address) throw fail('bad_request', 'the job needs an address');
  if (!JOB_TYPES.some((t) => t.uuid === status)) throw fail('bad_request', 'choose a job type');
  const description = String(req.job_description || '').slice(0, 4000) || 'Website enquiry';
  const email = emailIn(req.email);
  let digits = phoneDigits(req.phone);
  if (digits.length < 8) digits = '';
  const done = [];
  const at = (step, fn) => { try { return fn(); } catch (e) { e.done = done.slice(); e.step = step; throw e; } };
  const list = at('reading your clients', () => sm8Companies(key));
  const existing = list.filter((c) => norm(c.name) === norm(name))[0];
  let company = existing ? existing.uuid : '';
  const contact = contactFields(name, digits, email);
  if (!company) {
    company = at('creating the client', () => {
      const r = sm8Call(key, 'POST', '/company.json', { name: name, address: address, billing_address: address });
      if (!r.uuid) throw fail('sm8_refused', 'it did not return the new client');
      return r.uuid;
    });
    done.push('client');
    at('adding the contact details to the client', () => sm8Call(key, 'POST', '/companycontact.json', Object.assign({ company_uuid: company, type: 'BILLING', is_primary_contact: '1' }, contact)));
    done.push('client contact');
  }
  const job = at('creating the job', () => {
    const r = sm8Call(key, 'POST', '/job.json', { status: status, company_uuid: company, job_address: address, billing_address: address, job_description: description });
    if (!r.uuid) throw fail('sm8_refused', 'it did not return the new job');
    return r.uuid;
  });
  done.push('job');
  let contactSaved = true;
  try { sm8Call(key, 'POST', '/jobcontact.json', Object.assign({ job_uuid: job, type: 'JOB' }, contact)); done.push('job contact'); } catch (e) { contactSaved = false; }
  let number = '';
  try { const r = sm8Call(key, 'GET', '/job/' + encodeURIComponent(job) + '.json'); number = r.json && r.json.generated_job_id ? String(r.json.generated_job_id) : ''; } catch (e) { /* the job exists; its number is a nicety */ }
  return { uuid: job, job_number: number, company_uuid: company, existing_client: !!existing, job_contact_saved: contactSaved, done: done };
}
