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
  const values = order.map((i) => params[i]);
  if (statement.reader) return statement.all(values);
  statement.run(values);
  return [];
};

const init = async () => {
  db.exec(schema.SQLITE);
  console.log(`[db] SQLite ulandi → ${config.dbPath}`);
  console.log("[db] ⚠️  Supabase ulanmagan — mahalliy fayl bazasi ishlatilmoqda.");
};

const close = () => db.close();

module.exports = { name: 'sqlite', query, init, close };
