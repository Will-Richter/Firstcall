'use strict';
/* Phone notifications when a new lead arrives.
   Uses the standard Web Push protocol (RFC 8291 message encryption, RFC 8292 server identification),
   built on Node's own crypto so there is nothing to install. */
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

/* Only real push services are ever contacted, so a made-up address cannot be used to make this server call
   somewhere else. PUSH_TEST_ORIGIN adds one extra address and is only honoured by the automated test. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

function allowedEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  if (process.env.NODE_ENV === 'test' && process.env.PUSH_TEST_ORIGIN && u.origin === process.env.PUSH_TEST_ORIGIN) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/* ---------- this server's identity for push services (made once, kept sealed in the database) ---------- */
function loadIdentity(store, secure, masterKey) {
  const row = store.st.getKv.get('vapid');
  if (row) {
    const plain = secure.unseal(masterKey, row.value);
    if (plain) {
      const j = JSON.parse(plain);
      return { publicKey: j.publicKey, privateKey: crypto.createPrivateKey({ key: j.privateJwk, format: 'jwk' }) };
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  const id = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) };
  store.st.setKv.run('vapid', secure.seal(masterKey, JSON.stringify(id)));
  return { publicKey: id.publicKey, privateKey };
}

function vapidHeader(identity, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + identity.publicKey;
}

/* ---------- message encryption: only the phone that subscribed can read it ---------- */
function encrypt(p256dh, auth, plaintext) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/* Resolves 'sent', 'gone' (the phone unsubscribed; forget it) or 'failed'. */
async function send(identity, sub, payload, subject) {
  if (!allowedEndpoint(sub.endpoint)) return 'gone';
  let body;
  try { body = encrypt(sub.p256dh, sub.auth, JSON.stringify(payload)); } catch (e) { return 'gone'; }
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: vapidHeader(identity, sub.endpoint, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.status >= 200 && res.status < 300 ? 'sent' : 'failed';
  } catch (e) {
    return 'failed';
  }
}

/* Sends one notification to every phone of an account that has notifications on. */
async function notify(ctx, accountId, payload) {
  const subs = ctx.store.st.pushSubs.all(accountId);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    const r = await send(ctx.identity, s, payload, ctx.pushSubject);
    if (r === 'sent') { sent++; ctx.store.st.okPush.run(s.endpoint); }
    else if (r === 'gone') ctx.store.st.delPush.run(s.endpoint);
    else { ctx.store.st.failPush.run(s.endpoint); if (s.fails >= 20) ctx.store.st.delPush.run(s.endpoint); }
  }));
  return { phones: subs.length, sent };
}

module.exports = { loadIdentity, allowedEndpoint, encrypt, vapidHeader, send, notify };
