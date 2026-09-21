'use strict';

const db = require('./db');
const time = require('./time');

/**
 * Sehrgar (wizard) holati: "missiya yozyapti", "kechikish sababini kutyapmiz" va h.k.
 *
 * v1 da faqat xotirada edi — bot qayta ishga tushsa hodim yarim yozgan
 * missiyasi yo'qolar edi. Endi xotiradagi Map asosiy (tezkor, sinxron API),
 * har bir o'zgarish esa bazadagi `sessions` jadvaliga ham yoziladi.
 * Bot ishga tushganda `load()` bazadan qayta o'qiydi.
 */
const store = new Map();

/** Juda eski (1 kundan oshgan) sessiyalar qayta yuklanmaydi */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const persist = (key, value) => {
  const p = value
    ? db.query(
        `INSERT INTO sessions (key, data, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(value), time.stamp()],
      )
    : db.query('DELETE FROM sessions WHERE key = $1', [key]);
  p.catch((e) => console.warn('[session] saqlanmadi:', e.message));
};

const get = (key) => store.get(String(key)) || {};

const set = (key, patch) => {
  const k = String(key);
  const merged = { ...get(k), ...patch };
  store.set(k, merged);
  persist(k, merged);
  return merged;
};

const clear = (key) => {
  const k = String(key);
  if (store.has(k)) {
    store.delete(k);
    persist(k, null);
  }
};

/** Bot ishga tushganda bazadagi sessiyalarni xotiraga qaytaradi */
const load = async () => {
  const rows = await db.query('SELECT key, data, updated_at FROM sessions');
  const cutoff = Date.now() - MAX_AGE_MS;
  let loaded = 0;
  for (const r of rows) {
    const age = Date.parse(r.updated_at);
    if (Number.isFinite(age) && age < cutoff) {
      persist(r.key, null);
      continue;
    }
    try {
      store.set(String(r.key), JSON.parse(r.data));
      loaded += 1;
    } catch {
      persist(r.key, null);
    }
  }
  return loaded;
};

module.exports = { get, set, clear, load };
