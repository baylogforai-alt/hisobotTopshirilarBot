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
  // Supabase va aksariyat bulutli Postgres'lar SSL talab qiladi
  ssl: isSupabase || /sslmode=require/.test(config.databaseUrl) ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => console.error('[db] pool xatosi:', err.message));

const query = async (sql, params = []) => {
  const res = await pool.query(sql, params);
  return res.rows;
};

const init = async () => {
  await pool.query(schema.POSTGRES);
  const { rows } = await pool.query('SELECT current_database() AS db, version() AS v');
  console.log(`[db] PostgreSQL ulandi → ${rows[0].db}${isSupabase ? ' (Supabase)' : ''}`);
};

const close = () => pool.end().catch(() => {});

module.exports = { name: 'postgres', query, init, close };
