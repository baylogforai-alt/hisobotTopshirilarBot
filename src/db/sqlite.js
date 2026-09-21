'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const schema = require('./schema');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * $1, $2 ... → ? (SQLite anonim parametrlari).
 * `order` — har bir `?` qaysi params indeksidan qiymat olishini saqlaydi,
 * shuning uchun takrorlangan yoki tartibsiz $N lar ham to'g'ri bog'lanadi.
 */
const compile = (sql) => {
  const order = [];
  const text = sql.replace(/\$(\d+)/g, (_, n) => {
    order.push(Number(n) - 1);
    return '?';
  });
  return { statement: db.prepare(text), order };
};

const cache = new Map();
const prepare = (sql) => {
  let c = cache.get(sql);
  if (!c) {
    c = compile(sql);
    cache.set(sql, c);
  }
  return c;
};

const query = async (sql, params = []) => {
  const { statement, order } = prepare(sql);
  const values = order.map((i) => {
    const v = params[i];
    if (typeof v === 'boolean') return v ? 1 : 0; // better-sqlite3 boolean qabul qilmaydi
    return v === undefined ? null : v;
  });
  if (statement.reader) return statement.all(values);
  statement.run(values);
  return [];
};

const init = async () => {
  db.exec(schema.SQLITE);
  for (const m of schema.MIGRATIONS) {
    try {
      db.exec(m.sqlite);
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) console.warn("[db] migratsiya o'tkazib yuborildi:", e.message);
    }
  }
  for (const sql of schema.POST_MIGRATION) db.exec(sql);
  await migrateLegacy();
  console.log(`[db] SQLite ulandi → ${config.dbPath}`);
  console.log('[db] ⚠️  Postgres ulanmagan — mahalliy fayl bazasi ishlatilmoqda.');
};

const hasTable = async (name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** v1 `missions` → `tasks` (bir marta, tranzaksiyada) */
const migrateLegacy = async () => {
  if (!(await hasTable('missions'))) return;
  const tasksCount = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  if (tasksCount > 0) return;
  const n = db.transaction(() => {
    const r = db.prepare(schema.LEGACY_COPY).run();
    db.exec(schema.LEGACY_RENAME);
    return r.changes;
  })();
  console.log(`[db] v1 missions → tasks: ${n} ta yozuv ko'chirildi (eski jadval: missions_v1)`);
};

const close = () => db.close();

/** Bazaning izchil nusxasini faylga yozadi (WAL rejimida ham xavfsiz) */
const backup = async (destPath) => {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await db.backup(destPath);
  return destPath;
};

module.exports = { name: 'sqlite', query, init, close, backup, hasTable };
