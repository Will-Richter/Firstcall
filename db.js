'use strict';
/* One SQLite file holds everything. Every business ("account") only ever sees rows with its own account_id. */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'firstcall.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      pass TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (account_id, key)
    );
    CREATE TABLE IF NOT EXISTS subs (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      mid TEXT NOT NULL,
      at INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, mid)
    );
    CREATE TABLE IF NOT EXISTS leads (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, key)
    );
    CREATE TABLE IF NOT EXISTS docs (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (account_id, path)
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      fails INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
    CREATE INDEX IF NOT EXISTS push_account ON push_subs(account_id);
  `);

  const q = (sql) => db.prepare(sql);
  const st = {
    countAccounts: q('SELECT COUNT(*) AS n FROM accounts'),
    accountByEmail: q('SELECT * FROM accounts WHERE email = ?'),
    accountById: q('SELECT * FROM accounts WHERE id = ?'),
    insertAccount: q('INSERT INTO accounts (email, pass, created_at) VALUES (?, ?, ?)'),
    setPass: q('UPDATE accounts SET pass = ? WHERE id = ?'),
    bump: q('UPDATE accounts SET rev = rev + 1 WHERE id = ?'),
    insertSession: q('INSERT INTO sessions (token_hash, account_id, created_at, last_seen) VALUES (?, ?, ?, ?)'),
    session: q('SELECT * FROM sessions WHERE token_hash = ?'),
    touchSession: q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
    dropSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    dropOtherSessions: q('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?'),
    dropOldSessions: q('DELETE FROM sessions WHERE last_seen < ?'),
    getSetting: q('SELECT value FROM settings WHERE account_id = ? AND key = ?'),
    setSetting: q('INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value'),
    delSetting: q('DELETE FROM settings WHERE account_id = ? AND key = ?'),
    accountBySetting: q('SELECT account_id FROM settings WHERE key = ? AND value = ?'),
    subs: q('SELECT mid, data FROM subs WHERE account_id = ? ORDER BY at DESC LIMIT 2000'),
    hasSub: q('SELECT 1 AS x FROM subs WHERE account_id = ? AND mid = ?'),
    insertSub: q('INSERT OR IGNORE INTO subs (account_id, mid, at, data, created_at) VALUES (?, ?, ?, ?, ?)'),
    countSubs: q('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM subs WHERE account_id = ?'),
    leads: q('SELECT key, data FROM leads WHERE account_id = ? ORDER BY updated_at DESC LIMIT 5000'),
    hasLead: q('SELECT 1 AS x FROM leads WHERE account_id = ? AND key = ?'),
    countLeads: q('SELECT COUNT(*) AS n FROM leads WHERE account_id = ?'),
    setLead: q('INSERT INTO leads (account_id, key, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
    docs: q('SELECT path, data FROM docs WHERE account_id = ?'),
    setDoc: q('INSERT INTO docs (account_id, path, data) VALUES (?, ?, ?) ON CONFLICT(account_id, path) DO UPDATE SET data = excluded.data'),
    pushSubs: q('SELECT * FROM push_subs WHERE account_id = ?'),
    countPush: q('SELECT COUNT(*) AS n FROM push_subs WHERE account_id = ?'),
    addPush: q('INSERT INTO push_subs (endpoint, account_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth, fails = 0'),
    delPush: q('DELETE FROM push_subs WHERE endpoint = ?'),
    delPushAll: q('DELETE FROM push_subs WHERE account_id = ?'),
    delPushFor: q('DELETE FROM push_subs WHERE endpoint = ? AND account_id = ?'),
    failPush: q('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?'),
    okPush: q('UPDATE push_subs SET fails = 0 WHERE endpoint = ?'),
    getKv: q('SELECT value FROM kv WHERE key = ?'),
    setKv: q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };
  return { db, st, close: () => db.close() };
}

module.exports = { open };
