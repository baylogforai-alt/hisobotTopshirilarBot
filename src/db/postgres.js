'use strict';

const { Pool, types } = require('pg');
const config = require('../config');
const schema = require('./schema');

// BIGINT (oid 20) ni satr emas, son sifatida o'qiymiz — Telegram ID lari 2^53 dan kichik.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const isSupabase = /supabase\.(co|com)/i.test(config.databaseUrl);

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  ssl: isSupabase || /sslmode=require/.test(config.databaseUrl) ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => console.error('[db] pool xatosi:', err.message));

const query = async (sql, params = []) => {
  const res = await pool.query(sql, params);
  return res.rows;
};

const init = async () => {
  await pool.query(schema.POSTGRES);
  for (const m of schema.MIGRATIONS) {
    await pool.query(m.postgres).catch((e) => console.warn("[db] migratsiya o'tkazib yuborildi:", e.message));
  }
  for (const sql of schema.POST_MIGRATION) await pool.query(sql).catch((e) => console.warn('[db] indeks yaratilmadi:', e.message));
  await migrateLegacy();
  const { rows } = await pool.query('SELECT current_database() AS db');
  console.log(`[db] PostgreSQL ulandi → ${rows[0].db}${isSupabase ? ' (Supabase)' : ''}`);
};

const hasTable = async (name) => {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', [name]);
  return Boolean(rows[0] && rows[0].t);
};

/** v1 `missions` → `tasks` (bir marta, tranzaksiyada) */
const migrateLegacy = async () => {
  if (!(await hasTable('missions'))) return;
  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM tasks');
  if (Number(rows[0].c) > 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(schema.LEGACY_COPY);
    await client.query(schema.LEGACY_RENAME);
    await client.query('COMMIT');
    console.log(`[db] v1 missions → tasks: ${r.rowCount} ta yozuv ko'chirildi (eski jadval: missions_v1)`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[db] v1 migratsiyasi bajarilmadi:', e.message);
  } finally {
    client.release();
  }
};

const close = () => pool.end().catch(() => {});

/** Postgres'da fayl zaxirasi yo'q — bulut provayder o'zi qiladi */
const backup = async () => null;

module.exports = { name: 'postgres', query, init, close, backup, hasTable };
