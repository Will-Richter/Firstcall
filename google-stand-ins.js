'use strict';
/* Stand-ins for the Google services the Firstcall script uses, so it can be run and tested outside Google.
   The storage stand-in enforces Google's real limits (about 9 KB per saved value, 500 KB per store). */
const vm = require('node:vm');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function store(name) {
  const data = {};
  const size = (s) => Buffer.byteLength(String(s));
  const check = () => {
    let total = 0;
    for (const k of Object.keys(data)) {
      if (size(k) + size(data[k]) > 9216) throw new Error(name + ': the value saved as "' + k + '" is over 9 KB');
      total += size(k) + size(data[k]);
    }
    if (total > 512000) throw new Error(name + ': more than 500 KB saved in total');
  };
  return {
    data,
    api: {
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
      getProperties: () => Object.assign({}, data),
      setProperty: (k, v) => { data[k] = String(v); check(); },
      setProperties: (o) => { Object.keys(o).forEach((k) => { data[k] = String(o[k]); }); check(); },
      deleteProperty: (k) => { delete data[k]; },
    },
  };
}

/* world: { owner, inbox: [{ id, at (ms), msgs: [{ id, html, subject, from }] }] newest first, sm8(method, path, body, key) -> { status, json, headers } } */
function load(world) {
  const script = store('script storage');
  const user = store('user storage');
  const g = { script, user, sent: [], bodiesRead: 0, searches: [] };
  const thread = (t) => ({
    getId: () => t.id,
    getPermalink: () => 'https://mail.google.com/mail/u/0/#all/' + t.id,
    getMessages: () => t.msgs.map((m) => ({
      getId: () => m.id, getDate: () => new Date(m.at || t.at), getSubject: () => m.subject || 'Form Submission - Detailed Contact Form',
      getFrom: () => m.from || 'Squarespace <form-submission@squarespace.info>', getBody: () => { g.bodiesRead++; return m.html; },
    })),
  });
  /* world.slow (ms) makes every mailbox search appear to take that long, to exercise work that is split across requests. */
  let skew = 0;
  class Clock extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + skew); }
    static now() { return Date.now() + skew; }
  }
  const sandbox = {
    JSON, Date: Clock, String, Number, Error, Math, Object, Array, RegExp,
    GmailApp: {
      search: (q, start, max) => {
        g.searches.push(q);
        skew += world.slow || 0;
        let list = world.inbox.slice().sort((a, b) => b.at - a.at);
        const days = /newer_than:(\d+)d/.exec(q);
        const after = /after:(\d+)/.exec(q);
        if (days) list = list.filter((t) => Date.now() - t.at < Number(days[1]) * 864e5);
        if (after) list = list.filter((t) => t.at / 1000 > Number(after[1]));
        return list.slice(start, start + max).map(thread);
      },
      sendEmail: (to, subject, body) => { g.sent.push({ to, subject, body }); },
    },
    PropertiesService: { getScriptProperties: () => script.api, getUserProperties: () => user.api },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    Session: { getEffectiveUser: () => ({ getEmail: () => world.owner }) },
    HtmlService: { createHtmlOutput: (html) => ({ html }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) },
    UrlFetchApp: {
      fetch: (url, opt) => {
        const u = new URL(url);
        if (u.origin !== 'https://api.servicem8.com') throw new Error('unexpected address ' + url);
        const r = world.sm8(String(opt.method || 'get').toUpperCase(), u.pathname.replace(/^\/api_1\.0/, '') + u.search, opt.payload ? JSON.parse(opt.payload) : null, opt.headers['X-API-Key']);
        return { getResponseCode: () => r.status, getContentText: () => JSON.stringify(r.json === undefined ? null : r.json), getHeaders: () => r.headers || {} };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'docs', 'script.txt'), 'utf8'), sandbox);
  g.post = (body) => JSON.parse(vm.runInContext('doPost', sandbox)({ postData: { contents: JSON.stringify(body) } }).text);
  g.get = () => vm.runInContext('doGet', sandbox)().html;
  g.run = (fn) => vm.runInContext(fn + '()', sandbox);
  return g;
}

/* A made-up ServiceM8 that behaves like the documented API for the handful of calls Firstcall makes. */
function fakeSm8(key) {
  const s = { companies: [{ uuid: 'c-existing', name: 'Existing Client', address: '9 Old Road', active: 1 }, { uuid: 'c-gone', name: 'Gone Away', address: '', active: 0 }], contacts: [], jobs: [], jobContacts: [], failOn: '' };
  let n = 0;
  const id = (p) => p + '-' + (++n);
  s.handle = (method, pathAndQuery, json, given) => {
    const u = new URL(pathAndQuery, 'http://x');
    const p = u.pathname;
    if (given !== key) return { status: 401, json: { message: 'Unauthorised' } };
    if (s.failOn && method + ' ' + p === s.failOn) return { status: 400, json: { message: 'Bad Request: made-up refusal' } };
    if (method === 'GET' && p === '/vendor.json') return { status: 200, json: [{ uuid: 'v1', name: 'Test Solar Co' }] };
    if (method === 'GET' && p === '/company.json') return u.searchParams.get('cursor') === '-1' ? { status: 200, json: s.companies.slice(0, 1), headers: { 'X-Next-Cursor': 'page2' } } : { status: 200, json: s.companies.slice(1) };
    if (method === 'POST' && p === '/company.json') { const x = id('c'); s.companies.push(Object.assign({ uuid: x, active: 1 }, json)); return { status: 200, json: { errorCode: 0 }, headers: { 'x-record-uuid': x } }; }
    if (method === 'POST' && p === '/companycontact.json') { s.contacts.push(json); return { status: 200, json: { errorCode: 0 }, headers: { 'x-record-uuid': id('cc') } }; }
    if (method === 'POST' && p === '/job.json') { const x = id('j'); s.jobs.push(Object.assign({ uuid: x, generated_job_id: String(600 + s.jobs.length + 1) }, json)); return { status: 200, json: { errorCode: 0 }, headers: { 'x-record-uuid': x } }; }
    if (method === 'POST' && p === '/jobcontact.json') { s.jobContacts.push(json); return { status: 200, json: { errorCode: 0 }, headers: { 'x-record-uuid': id('jc') } }; }
    const m = /^\/job\/([^/]+)\.json$/.exec(p);
    if (method === 'GET' && m) { const j = s.jobs.find((x) => x.uuid === m[1]); return j ? { status: 200, json: j } : { status: 404, json: { message: 'No such job' } }; }
    return { status: 404, json: { message: 'Unknown' } };
  };
  return s;
}

/* The exact shape Squarespace sends: every answer twice, first in a hidden preview block. */
function formEmail(fields) {
  const block = (pad) => fields.map(([l, v]) => `${pad}<p>\r\n${pad}  <b>${l}:</b>\r\n${pad}  <span>${v}</span>\r\n${pad}</p>\r\n`).join('\r\n');
  return '<!DOCTYPE html>\r\n<html lang="en">\r\n  <head>\r\n    <title>Form Submission - Detailed Contact Form</title>\r\n  </head>\r\n  <body class="no-mail-styles">\r\n' +
    '    <div style="display:none;">\r\n' + block('      ') + '    </div>\r\n' +
    '    <p>Sent via form submission from <i><a href="https://example.invalid/?ref=abc">Test Site</a></i></p>\r\n' + block('    ') +
    '    <p>Does this submission look like spam? <a href="https://example.invalid/?ref=def">Report it here.</a></p></body></html>\r\n';
}

module.exports = { load, fakeSm8, formEmail };
