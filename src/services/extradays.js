'use strict';

const db = require('../db');
const time = require('../time');

/**
 * DAM OLISH KUNIGA CHAQIRUV (5-okt qarori): boshliq oldindan «shu kuni ishlab ber — qo'shimcha haq to'layman» deydi.
 * Faqat chaqirilgan hodim o'sha kuni «Keldim» qilsa — summa oylikka qo'shiladi. O'zi kelgan dam olish kuni — bonussiz.
 * Yozuvlar o'chirilmaydi: bekor qilish = cancelled_at.
 */

const SELECT = `SELECT x.*, e.full_name, e.tg_id FROM extra_days x JOIN employees e ON e.id = x.employee_id`;

const byId = (id) => db.one(`${SELECT} WHERE x.id = $1`, [Number(id)]);

/** Shu kun uchun faol chaqiruv (bekor qilinmagan) */
const forDay = (employeeId, date) =>
  db.one(`${SELECT} WHERE x.employee_id = $1 AND x.work_date = $2 AND x.cancelled_at IS NULL`, [Number(employeeId), date]);

/** Chaqiruv yaratadi; shu kunga faol chaqiruv bo'lsa — summasini yangilaydi */
const create = async ({ employeeId, date, amount, createdBy, note = null }) => {
  const cur = await forDay(employeeId, date);
  if (cur) {
    await db.query('UPDATE extra_days SET amount = $1, note = $2, created_by = $3 WHERE id = $4', [Number(amount), note, Number(createdBy), Number(cur.id)]);
    return byId(cur.id);
  }
  const rows = await db.query(
    `INSERT INTO extra_days (employee_id, work_date, amount, note, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [Number(employeeId), date, Number(amount), note, Number(createdBy), time.stamp()],
  );
  return byId(rows[0].id);
};

/** «Keldim» bo'lganda — ishlagan deb belgilash (bir marta) */
const markWorked = async (id) => {
  const rows = await db.query('UPDATE extra_days SET worked_at = $1 WHERE id = $2 AND worked_at IS NULL AND cancelled_at IS NULL RETURNING id', [time.stamp(), Number(id)]);
  return rows.length > 0;
};

const cancel = async (id, byTgId) => {
  const rows = await db.query('UPDATE extra_days SET cancelled_at = $1, cancelled_by = $2 WHERE id = $3 AND cancelled_at IS NULL AND worked_at IS NULL RETURNING id', [time.stamp(), Number(byTgId), Number(id)]);
  return rows.length > 0;
};

/** Bugundan keyingi (va bugungi) faol chaqiruvlar */
const upcoming = () => db.query(`${SELECT} WHERE x.work_date >= $1 AND x.cancelled_at IS NULL ORDER BY x.work_date, e.full_name`, [time.today()]);

/** Oy bo'yicha: ishlangan chaqiruvlar va ularning summasi */
const workedInMonth = (employeeId, month) => {
  const { from, to } = time.monthRange(month);
  return db.query(`${SELECT} WHERE x.employee_id = $1 AND x.work_date BETWEEN $2 AND $3 AND x.worked_at IS NOT NULL AND x.cancelled_at IS NULL ORDER BY x.work_date`, [Number(employeeId), from, to]);
};
const sumForMonth = async (employeeId, month) => (await workedInMonth(employeeId, month)).reduce((s, x) => s + (Number(x.amount) || 0), 0);

module.exports = { byId, forDay, create, markWorked, cancel, upcoming, workedInMonth, sumForMonth };
