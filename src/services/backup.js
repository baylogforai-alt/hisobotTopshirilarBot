'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');
const db = require('../db');
const time = require('../time');

/**
 * SQLite zaxira nusxalari (run). Postgres rejimida run() o'tkazib yuboriladi —
 * u yerda exportJson() har kuni direktorga Telegram orqali yuboriladi (jobs.js).
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

/**
 * Butun bazaning JSON eksporti (gzip) — Postgres'da (Railway) fayl tizimi vaqtinchalik, shuning uchun
 * zaxira Telegram orqali direktorga yuboriladi. Har ikki drayverda ishlaydi.
 * Tiklash: JSON dagi har jadval qatorlarini shu nomdagi jadvalga INSERT qilish kifoya.
 */
const EXPORT_TABLES = ['departments', 'employees', 'tasks', 'attendance', 'daily_reports', 'kpi_monthly', 'join_requests', 'settings', 'activity_log'];

const exportJson = async () => {
  const tables = {};
  let rows = 0;
  for (const t of EXPORT_TABLES) {
    try {
      tables[t] = await db.query(`SELECT * FROM ${t} ORDER BY id`);
    } catch (_) {
      tables[t] = await db.query(`SELECT * FROM ${t}`).catch(() => []);
    }
    rows += tables[t].length;
  }
  const json = JSON.stringify({ app: 'baylog-missiya-bot', driver: db.driver, exported_at: time.stamp(), tables });
  const buffer = zlib.gzipSync(Buffer.from(json, 'utf8'));
  return { buffer, filename: `baylog-bot-${time.today()}.json.gz`, rows, counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])) };
};

const list = () => {
  if (db.driver !== 'sqlite' || !fs.existsSync(dir())) return [];
  return fs
    .readdirSync(dir())
    .filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .map((f) => ({ file: f, size: fs.statSync(path.join(dir(), f)).size }));
};

module.exports = { run, list, dir, exportJson, EXPORT_TABLES };
