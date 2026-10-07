'use strict';
/* Client for the ServiceM8 REST API, using the business's own API key.
   Reads the client list (to spot people who are already clients) and writes exactly four kinds of record,
   only when the owner presses "Create in ServiceM8": a client, its contact, a job, and the job's contact.
   Redirects are never followed, so the key can never be passed on to another address. */

const BASE = (process.env.SM8_API_BASE || 'https://api.servicem8.com/api_1.0').replace(/\/+$/, '');
const TIMEOUT_MS = 20000;

class Sm8Error extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || 0; }
}

async function call(key, method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: Object.assign({ 'X-API-Key': key, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Sm8Error('unreachable', "it didn't answer", 0);
  }
  if (res.status === 401 || res.status === 403) throw new Sm8Error('denied', res.status === 401 ? 'the API key was not accepted' : 'the API key is not allowed to do this', res.status);
  if (res.status === 429) throw new Sm8Error('busy', 'it is rate limiting requests, try again in a minute', 429);
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (res.status < 200 || res.status >= 300) {
    const detail = (json && (json.message || json.error || json.errorMessage)) || text.slice(0, 200) || ('status ' + res.status);
    throw new Sm8Error(res.status >= 500 ? 'unreachable' : 'refused', String(detail), res.status);
  }
  return { json, uuid: res.headers.get('x-record-uuid') || (json && json.uuid) || '', next: res.headers.get('x-next-cursor') || '' };
}

/* Proves a key works and names the business it belongs to. */
async function verify(key) {
  const r = await call(key, 'GET', '/vendor.json');
  const v = Array.isArray(r.json) ? r.json[0] : r.json;
  return { business: (v && (v.name || v.business_name)) ? String(v.name || v.business_name).slice(0, 120) : '' };
}

const cache = new Map(); // accountId -> { at, list }
const CACHE_MS = 5 * 60 * 1000;

async function companies(accountId, key) {
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const list = [];
  let cursor = '-1';
  for (let page = 0; page < 30 && cursor; page++) {
    const r = await call(key, 'GET', '/company.json?cursor=' + encodeURIComponent(cursor));
    (Array.isArray(r.json) ? r.json : []).forEach((c) => {
      if (c && c.uuid && c.name && String(c.active) !== '0') list.push({ uuid: String(c.uuid), name: String(c.name), address: String(c.address || '') });
    });
    cursor = r.next;
  }
  cache.set(accountId, { at: Date.now(), list });
  return list;
}

function forget(accountId) { cache.delete(accountId); }

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function sameName(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const x = a.split(' ');
  const y = b.split(' ');
  return x.length > 1 && y.length > 1 && x[x.length - 1] === y[y.length - 1] && x[0].charAt(0) === y[0].charAt(0);
}

/* Answers in the same shape as the ServiceM8 connector's "search", so one set of screens works in both places. */
async function search(accountId, key, query) {
  const list = await companies(accountId, key);
  const results = list.filter((c) => sameName(c.name, query)).slice(0, 10).map((c) => ({
    id: 'company-' + c.uuid,
    title: 'Company',
    text: JSON.stringify({ uuid: c.uuid, name: c.name, address: c.address }),
  }));
  return { results };
}

const JOB_TYPES = [{ uuid: 'Quote', name: 'Quote' }, { uuid: 'Work Order', name: 'Work order' }];

function splitName(name) {
  const w = String(name || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!w.length) return { first: 'Customer', last: '' };
  if (w.length === 1) return { first: w[0], last: '' };
  return { first: w.slice(0, -1).join(' '), last: w[w.length - 1] };
}

function contactFields(name, phoneDigits, email) {
  const n = splitName(name);
  const c = { first: n.first.slice(0, 60), last: (n.last || '-').slice(0, 60) };
  if (phoneDigits) { if (/^04/.test(phoneDigits)) c.mobile = phoneDigits; else c.phone = phoneDigits; }
  if (email) c.email = email;
  return c;
}

/* in: { name, address, description, status, phoneDigits, email }
   Uses the existing client when one has exactly this name; otherwise creates the client and its contact first.
   Each step that succeeded is listed in `done`, so a failure part-way can say exactly what now exists in ServiceM8. */
async function createJob(accountId, key, input) {
  const done = [];
  const fail = (e, step) => { e.done = done; e.step = step; throw e; };
  const name = String(input.name).slice(0, 100);
  let company = null;
  let list = [];
  try { list = await companies(accountId, key); } catch (e) { fail(e, 'reading your clients'); }
  const existing = list.find((c) => norm(c.name) === norm(name));
  if (existing) company = existing.uuid;
  const contact = contactFields(name, input.phoneDigits, input.email);
  if (!company) {
    try {
      const r = await call(key, 'POST', '/company.json', { name, address: input.address, billing_address: input.address });
      company = r.uuid;
      if (!company) throw new Sm8Error('refused', 'it did not return the new client', 0);
      done.push('client');
      forget(accountId);
    } catch (e) { fail(e, 'creating the client'); }
    try {
      await call(key, 'POST', '/companycontact.json', Object.assign({ company_uuid: company, type: 'BILLING', is_primary_contact: '1' }, contact));
      done.push('client contact');
    } catch (e) { fail(e, 'adding the contact details to the client'); }
  }
  let job = '';
  try {
    const r = await call(key, 'POST', '/job.json', { status: input.status, company_uuid: company, job_address: input.address, billing_address: input.address, job_description: input.description });
    job = r.uuid;
    if (!job) throw new Sm8Error('refused', 'it did not return the new job', 0);
    done.push('job');
  } catch (e) { fail(e, 'creating the job'); }
  let contactSaved = true;
  try {
    await call(key, 'POST', '/jobcontact.json', Object.assign({ job_uuid: job, type: 'JOB' }, contact));
    done.push('job contact');
  } catch (e) { contactSaved = false; }
  let number = '';
  try {
    const r = await call(key, 'GET', '/job/' + encodeURIComponent(job) + '.json');
    number = r.json && r.json.generated_job_id ? String(r.json.generated_job_id) : '';
  } catch (e) { /* the job exists; its number is a nicety */ }
  return { uuid: job, job_number: number, company_uuid: company, existing_client: !!existing, job_contact_saved: contactSaved, done };
}

module.exports = { verify, search, createJob, forget, JOB_TYPES, Sm8Error, sameName };
