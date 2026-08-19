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

const init = () => impl.init();
const close = () => impl.close();

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

module.exports = { query, one, init, close, getSetting, setSetting, driver: impl.name };
