'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const time = require('../time');

/**
 * SQLite zaxira nusxalari. Postgres rejimida hech narsa qilmaydi
 * (bulut bazasi o'zi zaxiralaydi).
 *
 * Fayllar: data/backups/bot-YYYY-MM-DD.db — eng eski nusxalar BACKUP_KEEP dan
 * oshsa o'chiriladi.
 */

const dir = () => path.join(path.dirname(config.dbPath), 'backups');

const run = async () => {
  if (db.driver !== 'sqlite') return { skipped: true, reason: 'postgres' };
  const dest = path.join(dir(), `bot-${time.today()}.db`);
  await db.backup(dest);

  // eskilarini tozalash
  const files = fs
    .readdirSync(dir())
    .filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  const extra = files.length - Math.max(1, config.backupKeep);
  const removed = [];
  for (let i = 0; i < extra; i += 1) {
    fs.rmSync(path.join(dir(), files[i]), { force: true });
    removed.push(files[i]);
  }
  return { skipped: false, file: dest, kept: files.length - removed.length, removed };
};

const list = () => {
  if (db.driver !== 'sqlite' || !fs.existsSync(dir())) return [];
  return fs
    .readdirSync(dir())
    .filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .map((f) => ({ file: f, size: fs.statSync(path.join(dir(), f)).size }));
};

module.exports = { run, list, dir };
