'use strict';
/* Password hashing, session tokens, and encryption of stored credentials (the ServiceM8 key and the mail link key). */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [kind, N, r, p, salt, hash] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(want, got);
  } catch (e) {
    return false;
  }
}

/* The same check without holding up other requests while it runs. An account that does not exist is checked against
   a throwaway password, so the answer takes just as long and does not give away which emails have accounts. */
let dummy = null;
function checkPassword(password, stored) {
  if (!stored) stored = dummy || (dummy = hashPassword(crypto.randomBytes(18).toString('base64')));
  return new Promise((resolve) => {
    try {
      const [kind, N, r, p, salt, hash] = String(stored).split('$');
      if (kind !== 'scrypt') return resolve(false);
      const want = Buffer.from(hash, 'base64');
      crypto.scrypt(String(password), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p }, (err, got) => {
        resolve(!err && got.length === want.length && crypto.timingSafeEqual(want, got));
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 32).toString('base64url');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/* The key that seals stored credentials. Taken from SECRET_KEY if set, otherwise made once and kept on the data disk. */
function loadMasterKey(dataDir) {
  if (process.env.SECRET_KEY) return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  const file = path.join(dataDir, 'secret.key');
  try {
    const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (k.length === 32) return k;
  } catch (e) { /* made below */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString('base64') + '\n', { mode: 0o600 });
  return k;
}

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

function unseal(key, sealed) {
  try {
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, loadMasterKey, seal, unseal, checkPassword };
