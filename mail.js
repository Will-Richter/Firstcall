'use strict';
/* Turns a website form email into a lead record. The field rules match the app screens (index.html), so a lead
   reads the same whether it arrived through Claude's Gmail connector or through this server's mail link. */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}

/* Removes tags in one pass. (A pattern like <[^>]*> re-scans the rest of the text for every stray "<", which a
   hostile email could use to stall the server.) */
function stripTags(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf('<', i);
    if (a < 0) { out += s.slice(i); break; }
    const b = s.indexOf('>', a + 1);
    if (b < 0) { out += s.slice(i); break; }
    out += s.slice(i, a);
    i = b + 1;
  }
  return out;
}

function htmlToText(html) {
  const text = decodeEntities(stripTags(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr)>/gi, '\n')
  )).replace(/\r/g, '');
  return text.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* Squarespace writes each answer as <p><b>Label:</b> <span>Value</span></p>, and writes the whole set twice
   (once hidden as the inbox preview). The first complete set is used. */
function fieldsFromHtml(html) {
  const s = String(html);
  const low = s.replace(/[A-Z]/g, (c) => c.toLowerCase()); /* same length as s, so positions line up */
  const out = [];
  const seen = new Set();
  const blank = (a, b) => s.slice(a, b).trim() === '';
  let pos = 0;
  /* Walks the email one <p>...</p> at a time with plain text searches, so the work grows in step with the size of
     the email whatever it contains. */
  while (out.length < 60) {
    const p = low.indexOf('<p', pos);
    if (p < 0) break;
    const after = low.charAt(p + 2);
    if (after !== '>' && after !== ' ' && after !== '\t' && after !== '\r' && after !== '\n') { pos = p + 2; continue; }
    const end = low.indexOf('</p>', p);
    if (end < 0) break;
    pos = end + 4;
    const open = low.indexOf('>', p);
    const b0 = low.indexOf('<b', open);
    if (open < 0 || b0 < 0 || b0 > end || !blank(open + 1, b0)) continue;
    const b0e = low.indexOf('>', b0);
    const b1 = b0e < 0 ? -1 : low.indexOf('</b>', b0e);
    if (b1 < 0 || b1 > end) continue;
    const s0 = low.indexOf('<span', b1);
    if (s0 < 0 || s0 > end || !blank(b1 + 4, s0)) continue;
    const s0e = low.indexOf('>', s0);
    const s1 = low.lastIndexOf('</span>', end);
    if (s0e < 0 || s1 < s0e || !blank(s1 + 7, end)) continue;
    let label = htmlToText(s.slice(b0e + 1, b1)).replace(/\s+/g, ' ').trim();
    if (!/:$/.test(label)) continue;
    label = label.slice(0, -1).trim();
    if (!label || label.length > 140) continue;
    if (seen.has(label)) break;
    seen.add(label);
    out.push({ label, value: htmlToText(s.slice(s0e + 1, s1)) });
  }
  return out;
}

/* Plain-text fallback: "Label: value" lines, as other form tools and forwarded emails write them. */
function fieldsFromText(text) {
  const out = [];
  let cur = null;
  let head = String(text || '');
  const cut = head.search(/Sent via form submission/i);
  if (cut >= 0) head = head.slice(0, cut);
  head.split(/\r?\n/).forEach((line) => {
    const m = /^\s*\*{0,2}([^*:\n]{1,140}?\??):\*{0,2}[ \t]?(.*)$/.exec(line);
    if (m && /^(name|first name|last name|e-?mail|phone|mobile|address|suburb|message|comments?|how |what |where |when |which )/i.test(m[1].trim())) {
      cur = { label: m[1].trim(), value: m[2].trim() };
      out.push(cur);
    } else if (cur) {
      const t = line.trim();
      if (t) cur.value = cur.value ? cur.value + '\n' + t : t;
    }
  });
  return out;
}

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/* An address safe to put in a mailto: link: one plain address, nothing that could add recipients or text. */
const EMAIL = /[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}/;
const emailIn = (v) => { const m = EMAIL.exec(String(v == null ? '' : v).slice(0, 400)); return m ? m[0] : ''; };

function classify(fields) {
  const d = { name: '', email: '', phone: '', address: '', panels: '', storeys: '', services: '', source: '', message: '', extra: [] };
  fields.forEach((f) => {
    const l = f.label.toLowerCase();
    const v = f.value;
    if (/e-?mail/.test(l)) d.email = emailIn(v);
    else if (/phone|mobile/.test(l)) d.phone = clean(v);
    else if (/hear about/.test(l)) d.source = clean(v);
    else if (/stor(ie|ey|y)/.test(l)) d.storeys = clean(v);
    else if (/panel/.test(l)) d.panels = clean(v);
    else if (/what would you like|service/.test(l)) d.services = clean(v);
    else if (/address|suburb|location/.test(l)) d.address = clean(v);
    else if (/name/.test(l)) d.name = clean(d.name ? d.name + ' ' + v : v);
    else if (/message|comment|detail|note/.test(l)) d.message = v.trim();
    else if (v) d.extra.push({ label: f.label.slice(0, 80), value: v.slice(0, 600) });
  });
  return d;
}

const cap = (s, n) => String(s == null ? '' : s).slice(0, n);

/* m: { id, threadId, date (ms), subject, from, html, plain, url } */
function toDoc(m) {
  let fields = m.html ? fieldsFromHtml(m.html) : [];
  if (!fields.some((f) => /name|phone|e-?mail/i.test(f.label))) fields = fieldsFromText(String(m.plain || (m.html ? htmlToText(m.html) : '')).slice(0, 60000));
  if (!fields.some((f) => /name|phone|e-?mail/i.test(f.label))) return null;
  const d = classify(fields);
  const at = Number(m.date);
  d.mid = String(m.id);
  d.tid = cap(m.threadId || m.id, 64);
  d.at = Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now();
  d.url = /^https:\/\/mail\.google\.com\//.test(String(m.url || '')) ? cap(m.url, 400) : '';
  d.form = clean(String(m.subject || '').slice(0, 300).replace(/^\s*Form Submission\s*-?\s*/i, '')).slice(0, 120) || 'Website form';
  d.name = cap(d.name, 160) || 'Unnamed enquiry';
  d.email = cap(d.email, 200);
  d.phone = cap(d.phone, 60);
  d.address = cap(d.address, 300);
  d.panels = cap(d.panels, 200);
  d.storeys = cap(d.storeys, 100);
  d.services = cap(d.services, 400);
  d.source = cap(d.source, 200);
  d.message = cap(d.message, 4000);
  d.extra = d.extra.slice(0, 12);
  d.v = 1;
  return d;
}

/* A lead pushed in directly (from another tool) rather than read from an email. */
function fromDirect(x) {
  const name = clean(cap(x.name, 2000));
  const d = {
    name: cap(name, 160) || 'Unnamed enquiry', email: emailIn(x.email), phone: cap(clean(x.phone), 60),
    address: cap(clean(x.address), 300), panels: cap(clean(x.panels), 200), storeys: cap(clean(x.storeys), 100),
    services: cap(clean(x.services), 400), source: cap(clean(x.source), 200), message: cap(String(x.message || '').trim(), 4000), extra: [],
  };
  const at = Number(x.date);
  d.mid = String(x.id);
  d.tid = d.mid;
  d.at = Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now();
  d.url = '';
  d.form = cap(clean(x.form), 120) || 'Direct';
  d.v = 1;
  return d;
}

function phoneDigits(p) {
  const raw = String(p || '');
  let d = raw.replace(/\D/g, '');
  if (d.indexOf('61') === 0 && (raw.indexOf('+61') >= 0 || d.length >= 11)) d = d.slice(2);
  if (d.length === 9 && d.charAt(0) !== '0') d = '0' + d;
  return d;
}

function showPhone(p) {
  const d = phoneDigits(p);
  if (/^04\d{8}$/.test(d)) return d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7);
  if (/^0\d{9}$/.test(d)) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + ' ' + d.slice(6);
  return clean(p);
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unnamed';

/* The same person sending the form twice is one lead. Must match leadKey() in index.html. */
function leadKey(d) {
  const p = phoneDigits(d.phone);
  if (p.length >= 8) return 'p' + p;
  if (d.email) return 'e' + d.email.toLowerCase().replace(/[^a-z0-9_.@+~:-]/g, '_').slice(0, 150);
  return 'n' + slug(d.name);
}

const title = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function suburb(a) {
  a = String(a || '').replace(/\s+/g, ' ').trim();
  if (!a) return '';
  const parts = a.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^(.*?)\s*\b(QLD|NSW|VIC|TAS|ACT|SA|WA|NT)\b\.?\s*\d{0,4}$/i.exec(parts[i]);
    if (m) {
      let s = m[1].trim();
      if (!s && i > 0) s = parts[i - 1];
      if (/^\d/.test(s)) {
        const w = s.split(' ');
        let k = -1;
        w.forEach((x, j) => { if (/^(st|street|rd|road|ave|avenue|dr|drive|ct|court|ln|lane|cres|crescent|pl|place|pde|parade|tce|terrace|way|hwy|highway|cl|close|esp|esplanade|gr|grove|blvd|cct|circuit)\.?$/i.test(x)) k = j; });
        s = k >= 0 ? w.slice(k + 1).join(' ') : '';
      }
      return s ? title(s) : '';
    }
  }
  const p = parts.filter((x) => !/^australia$/i.test(x));
  return p.length > 1 ? title(p[p.length - 1].replace(/\d{4}$/, '').trim()) : '';
}

/* One line for a phone notification: "Lesley Woodall · Moore Park Beach · 19 panels". */
function summary(d) {
  const bits = [d.name];
  const s = suburb(d.address);
  if (s) bits.push(s);
  if (/^\d+$/.test(d.panels)) bits.push(d.panels + (d.panels === '1' ? ' panel' : ' panels'));
  return bits.join(' · ');
}

module.exports = { toDoc, fromDirect, fieldsFromHtml, fieldsFromText, htmlToText, leadKey, phoneDigits, showPhone, suburb, summary, clean };
