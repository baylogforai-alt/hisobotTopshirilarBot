'use strict';

const db = require('../db');
const time = require('../time');

/**
 * OGOHLANTIRISHLAR (intizom) — 20-okt-2026, HR so'rovi: «intizom yaxshi emas, nega vaqtida kelmayapsiz»
 * kabi rasmiy ogohlantirishni hodimga yuborish va bazada qoldirish.
 *
 * Kim yuboradi — access.canWarn: direktor/boshliq va HR — hamma hodimga; bo'lim rahbari — o'z bo'limiga.
 * Hodim «👀 Tanishdim» bosadi (seen_at). Takroriy (2 va undan ko'p) ogohlantirish boshliqqa ham boradi.
 * Hech narsa o'chirilmaydi (loyiha qoidasi).
 */

const byId = (id) => db.one('SELECT * FROM warnings WHERE id = $1', [Number(id)]);

const create = async ({ employeeId, fromTg, fromName = null, body = null, media = null }) => {
  const rows = await db.query(
    `INSERT INTO warnings (employee_id, from_tg, from_name, body, media_type, file_id, file_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [Number(employeeId), Number(fromTg), fromName || null, body || null,
      media ? media.type : null, media ? media.fileId : null, media && media.fileName ? media.fileName : null, time.stamp()],
  );
  return byId(rows[0].id);
};

/** Hodimning ogohlantirishlari — yangisi birinchi */
const listFor = (employeeId) =>
  db.query('SELECT * FROM warnings WHERE employee_id = $1 ORDER BY id DESC', [Number(employeeId)]);

const countFor = async (employeeId) =>
  db.count('SELECT COUNT(*) AS c FROM warnings WHERE employee_id = $1', [Number(employeeId)]);

/** «👀 Tanishdim» — birinchi marta bo'lsa true (takror bosilsa yuboruvchiga ikkinchi xabar bormaydi) */
const markSeen = async (id) => {
  const rows = await db.query('UPDATE warnings SET seen_at = $1 WHERE id = $2 AND seen_at IS NULL RETURNING id', [time.stamp(), Number(id)]);
  return rows.length > 0;
};

/**
 * Ro'yxat: fromTg berilsa — faqat shu odam yuborganlari (rahbar o'zinikini ko'radi),
 * aks holda hammasi (boshliq/direktor va HR).
 */
const list = ({ fromTg = null, limit = 30 } = {}) =>
  db.query(
    `SELECT w.*, e.full_name, e.tg_id FROM warnings w JOIN employees e ON e.id = w.employee_id
     ${fromTg ? 'WHERE w.from_tg = $1' : ''} ORDER BY w.id DESC LIMIT ${Number(limit)}`,
    fromTg ? [Number(fromTg)] : [],
  );

module.exports = { byId, create, listFor, countFor, markSeen, list };
