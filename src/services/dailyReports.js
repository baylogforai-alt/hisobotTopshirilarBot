'use strict';

const db = require('../db');
const time = require('../time');

/**
 * KUNLIK HISOBOT — hodim kun oxirida nima qilganini o'z so'zi bilan yozadi
 * (+ ixtiyoriy rasm). Bitta hodim, bitta kun = bitta hisobot (qayta yozsa yangilanadi).
 * Boshliq/direktor «👁 Ko'rdim» yoki izoh qoldiradi; hisobot arxiv, davr hisoboti
 * va Excel'ga tushadi.
 */

const SELECT = `SELECT r.*, e.full_name, e.tg_id, e.position, e.department_id
                FROM daily_reports r JOIN employees e ON e.id = r.employee_id`;

const byId = (id) => db.one(`${SELECT} WHERE r.id = $1`, [Number(id)]);

const get = (employeeId, date = time.today()) =>
  db.one(`${SELECT} WHERE r.employee_id = $1 AND r.work_date = $2`, [Number(employeeId), date]);

/** Yangi hisobot yoki shu kungi hisobotni yangilash */
const submit = async (employeeId, { text, photoFileId = null }, date = time.today()) => {
  const clean = String(text || '').trim().slice(0, 3000);
  await db.query(
    `INSERT INTO daily_reports (employee_id, work_date, text, photo_file_id, submitted_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       text = EXCLUDED.text, photo_file_id = COALESCE(EXCLUDED.photo_file_id, daily_reports.photo_file_id),
       submitted_at = EXCLUDED.submitted_at, reviewed_by = NULL, reviewed_at = NULL, review_note = NULL`,
    [Number(employeeId), date, clean, photoFileId, time.stamp()],
  );
  return get(employeeId, date);
};

const review = async (id, byTgId, note = null) => {
  await db.query('UPDATE daily_reports SET reviewed_by = $1, reviewed_at = $2, review_note = COALESCE($3, review_note) WHERE id = $4', [
    Number(byTgId), time.stamp(), note ? String(note).slice(0, 500) : null, Number(id),
  ]);
  return byId(id);
};

/** Bir kunning barcha hisobotlari (bo'lim bo'yicha filtrlash mumkin) */
const forDate = (date = time.today(), deptId = null) =>
  db.query(
    `${SELECT} WHERE r.work_date = $1 AND e.active = 1 ${deptId ? 'AND e.department_id = $2' : ''} ORDER BY r.submitted_at`,
    deptId ? [date, Number(deptId)] : [date],
  );

/** Hodimning davr bo'yicha hisobotlari */
const range = (employeeId, from, to) =>
  db.query(`${SELECT} WHERE r.employee_id = $1 AND r.work_date BETWEEN $2 AND $3 ORDER BY r.work_date`, [Number(employeeId), from, to]);

/** Jamoa bo'yicha davr hisobotlari */
const rangeAll = (from, to) =>
  db.query(`${SELECT} WHERE r.work_date BETWEEN $1 AND $2 AND e.active = 1 ORDER BY r.work_date, lower(e.full_name)`, [from, to]);

/** Bugun kelgan, lekin hali hisobot topshirmagan hodimlar */
const missingToday = (date = time.today()) =>
  db.query(
    `SELECT e.* FROM employees e
     JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1 AND a.checked_in IS NOT NULL
     LEFT JOIN daily_reports r ON r.employee_id = e.id AND r.work_date = $1
     WHERE e.active = 1 AND r.id IS NULL ORDER BY lower(e.full_name)`,
    [date],
  );

/** Davr: nechta ish kunida hisobot topshirgan */
const countBetween = (employeeId, from, to) =>
  db.count('SELECT COUNT(*) AS c FROM daily_reports WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3', [Number(employeeId), from, to]);

module.exports = { byId, get, submit, review, forDate, range, rangeAll, missingToday, countBetween };
