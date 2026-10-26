'use strict';

const db = require('../db');
const time = require('../time');

/**
 * ISHDAN JAVOB SO'RASH (7-okt): hodim ish vaqtida «javob» so'raydi — bir necha soatga chiqib kelish yoki bugunga erta ketish.
 * Bo'lim rahbari yoki boshliq ruxsat beradi / bermaydi (access.canDecideExcuse), HR — faqat ko'radi.
 * Yozuvlar o'chirilmaydi. kind: '60' | '120' | '180' (daqiqa — chiqib kelish) yoki 'day' (bugunga ketish).
 */

const KINDS = {
  60: { label: '1 soatga chiqib kelish', short: '1 soatga' },
  120: { label: '2 soatga chiqib kelish', short: '2 soatga' },
  180: { label: '3 soatga chiqib kelish', short: '3 soatga' },
  day: { label: 'bugunga ertaroq ketish', short: 'bugunga (erta ketish)' },
};
const isKind = (k) => Object.prototype.hasOwnProperty.call(KINDS, String(k));
const kindLabel = (k) => (KINDS[String(k)] || KINDS.day).label;

const SELECT = `SELECT l.*, e.full_name, e.tg_id, e.position FROM leave_requests l JOIN employees e ON e.id = l.employee_id`;

const byId = (id) => db.one(`${SELECT} WHERE l.id = $1`, [Number(id)]);

/** Bugungi oxirgi so'rov (har qanday holatda) */
const latest = (employeeId, date = time.today()) =>
  db.one(`${SELECT} WHERE l.employee_id = $1 AND l.work_date = $2 ORDER BY l.id DESC LIMIT 1`, [Number(employeeId), date]);

/** Hal qilinmagan so'rov (bugun) */
const pendingFor = (employeeId, date = time.today()) =>
  db.one(`${SELECT} WHERE l.employee_id = $1 AND l.work_date = $2 AND l.status = 'pending' ORDER BY l.id DESC LIMIT 1`, [Number(employeeId), date]);

/** Bugunga ketishga berilgan ruxsat (Ketdimda «erta ketdi» o'rniga «javob olgan») */
const approvedDay = (employeeId, date = time.today()) =>
  db.one(`${SELECT} WHERE l.employee_id = $1 AND l.work_date = $2 AND l.kind = 'day' AND l.status = 'approved' ORDER BY l.id DESC LIMIT 1`, [Number(employeeId), date]);

const create = async ({ employeeId, kind, reason, proof = null }) => {
  const rows = await db.query(
    `INSERT INTO leave_requests (employee_id, work_date, kind, reason, proof_type, proof_file_id, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
    [Number(employeeId), time.today(), String(kind), reason, proof ? proof.type : null, proof ? proof.fileId : null, time.stamp()],
  );
  return byId(rows[0].id);
};

/** Qaror — faqat pending dan, bir marta (ikki rahbar bir vaqtda bossa ham). null — allaqachon hal qilingan */
const decide = async (id, status, byTgId, byName = null) => {
  const rows = await db.query(
    `UPDATE leave_requests SET status = $1, decided_by = $2, decided_name = $3, decided_at = $4 WHERE id = $5 AND status = 'pending' RETURNING id`,
    [status, Number(byTgId), byName, time.stamp(), Number(id)],
  );
  return rows.length ? byId(id) : null;
};

/** Ruxsat berilgan bo'lsa — qachongacha qaytishi kerak ('HH:mm'), 'day' — null */
const untilOf = (row) => {
  if (!row || row.kind === 'day' || !row.decided_at) return null;
  return time.clock(time.stampOf(Math.floor(new Date(row.decided_at).getTime() / 1000) + Number(row.kind) * 60));
};

module.exports = { KINDS, isKind, kindLabel, byId, latest, pendingFor, approvedDay, create, decide, untilOf };
