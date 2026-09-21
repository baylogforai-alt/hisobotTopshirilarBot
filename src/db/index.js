'use strict';

const config = require('../config');

// DATABASE_URL bor bo'lsa — PostgreSQL (Supabase), aks holda mahalliy SQLite fayl.
const impl = config.databaseUrl ? require('./postgres') : require('./sqlite');

/** SELECT → qatorlar massivi; INSERT/UPDATE → [] yoki RETURNING natijasi */
const query = (sql, params = []) => impl.query(sql, params);

/** Birinchi qator yoki null */
const one = async (sql, params = []) => {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
};

/** `SELECT COUNT(*) AS c ...` natijasini son sifatida qaytaradi */
const count = async (sql, params = []) => {
  const row = await one(sql, params);
  return row ? Number(row.c || 0) : 0;
};

const init = () => impl.init();
const close = () => impl.close();
const backup = (dest) => impl.backup(dest);
const hasTable = (name) => impl.hasTable(name);

const getSetting = async (key, fallback = null) => {
  const row = await one('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
};

const setSetting = async (key, value) => {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)],
  );
};

module.exports = { query, one, count, init, close, backup, hasTable, getSetting, setSetting, driver: impl.name };
