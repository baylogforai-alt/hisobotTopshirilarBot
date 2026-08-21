'use strict';

const db = require('../db');
const time = require('../time');

const byId = (id) => db.one('SELECT * FROM missions WHERE id = $1', [id]);

/**
 * Yangi missiya yaratish.
 * startDate — qaysi kundan boshlab "faol" bo'ladi (odatda ertaga).
 * dueDate   — oxirgi muddat.
 */
const create = async ({ employeeId, title, startDate, dueDate, createdBy = null, note = null }) => {
  const status = startDate <= time.today() ? 'active' : 'pending';
  const rows = await db.query(
    `INSERT INTO missions (employee_id, title, status, start_date, due_date, created_at, created_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [employeeId, title.trim(), status, startDate, dueDate, time.stamp(), createdBy, note],
  );
  return rows[0];
};

/** Bugun bajarilishi kerak bo'lgan (ochiq) missiyalar — o'tgan kunlardan qolganlari ham shu yerda */
const openFor = (employeeId) =>
  db.query(
    `SELECT * FROM missions
     WHERE employee_id = $1 AND status = 'active'
     ORDER BY (due_date < $2) DESC, due_date ASC, id ASC`,
    [employeeId, time.today()],
  );

/** Hali boshlanmagan (kelajakdagi) missiyalar */
const pendingFor = (employeeId) =>
  db.query(
    `SELECT * FROM missions
     WHERE employee_id = $1 AND status = 'pending'
     ORDER BY start_date ASC, id ASC`,
    [employeeId],
  );

/** Muddati kelgan 'pending' larni 'active' ga o'tkazish */
const activateDue = async (employeeId = null) => {
  const t = time.today();
  if (employeeId) {
    await db.query(
      "UPDATE missions SET status = 'active' WHERE status = 'pending' AND start_date <= $1 AND employee_id = $2",
      [t, employeeId],
    );
    return;
  }
  await db.query(
    "UPDATE missions SET status = 'active' WHERE status = 'pending' AND start_date <= $1",
    [t],
  );
};

const markDone = async (id, employeeId = null) => {
  const m = await byId(id);
  if (!m) return { ok: false, reason: 'not_found' };
  if (employeeId && Number(m.employee_id) !== Number(employeeId)) return { ok: false, reason: 'forbidden' };
  if (m.status === 'done') return { ok: false, reason: 'already', mission: m };
  await db.query("UPDATE missions SET status = 'done', done_at = $1 WHERE id = $2", [time.stamp(), id]);
  return { ok: true, mission: await byId(id) };
};

const reopen = async (id) => {
  await db.query("UPDATE missions SET status = 'active', done_at = NULL WHERE id = $1", [id]);
  return byId(id);
};

const cancel = async (id, employeeId = null) => {
  const m = await byId(id);
  if (!m) return { ok: false, reason: 'not_found' };
  if (employeeId && Number(m.employee_id) !== Number(employeeId)) return { ok: false, reason: 'forbidden' };
  await db.query("UPDATE missions SET status = 'cancelled', cancelled_at = $1 WHERE id = $2", [
    time.stamp(),
    id,
  ]);
  return { ok: true, mission: await byId(id) };
};

/** Berilgan kunda bajarilgan missiyalar */
const doneOn = (employeeId, date = time.today()) =>
  db.query(
    `SELECT * FROM missions
     WHERE employee_id = $1 AND status = 'done' AND substr(done_at, 1, 10) = $2
     ORDER BY done_at ASC`,
    [employeeId, date],
  );

/** Kunlik hisobot uchun qisqa statistika */
const dayStats = async (employeeId, date = time.today()) => {
  const done = (await doneOn(employeeId, date)).length;
  const open = await openFor(employeeId);
  const overdue = open.filter((m) => m.due_date < date).length;
  return { done, open: open.length, overdue, total: done + open.length };
};

/** Muddati o'tib ketgan barcha ochiq missiyalar (admin uchun) */
const allOverdue = () =>
  db.query(
    `SELECT m.*, e.full_name, e.tg_id FROM missions m
     JOIN employees e ON e.id = m.employee_id
     WHERE m.status = 'active' AND m.due_date < $1 AND e.active = 1
     ORDER BY m.due_date ASC`,
    [time.today()],
  );

/** Davr bo'yicha hisobot (masalan hafta/oy) */
const rangeStats = async (employeeId, fromDate, toDate) => {
  const d = await db.one(
    `SELECT COUNT(*) AS c FROM missions
     WHERE employee_id = $1 AND status = 'done' AND substr(done_at, 1, 10) BETWEEN $2 AND $3`,
    [employeeId, fromDate, toDate],
  );
  const c = await db.one(
    `SELECT COUNT(*) AS c FROM missions
     WHERE employee_id = $1 AND start_date BETWEEN $2 AND $3`,
    [employeeId, fromDate, toDate],
  );
  return { done: Number(d.c), created: Number(c.c) };
};

/**
 * Berilgan kun uchun "snapshot": har bir faol hodimning
 *   • o'sha kuni bajargan missiyalari (done)  +
 *   • hozir ochiq (bajarilishi kerak) missiyalari
 * hodim ma'lumoti bilan qo'shib qaytaradi. Excel va itemli hisobot uchun.
 * Missiyasi yo'q hodim ham bitta bo'sh (title = null) qator bilan chiqadi.
 */
const dayRows = (date = time.today(), employeeId = null) => {
  const params = [date];
  let empFilter = '';
  if (employeeId) {
    params.push(employeeId);
    empFilter = `AND e.id = $${params.length}`;
  }
  return db.query(
    `SELECT e.id AS employee_id, e.full_name, e.position, e.tg_id,
            m.id AS mission_id, m.title, m.status, m.start_date, m.due_date, m.done_at
       FROM employees e
       LEFT JOIN missions m
         ON m.employee_id = e.id
        AND ( (m.status = 'done' AND substr(m.done_at, 1, 10) = $1)
              OR m.status = 'active' )
      WHERE e.active = 1 ${empFilter}
      ORDER BY lower(e.full_name), (m.status = 'done') DESC, m.due_date ASC, m.id ASC`,
    params,
  );
};

/** Berilgan sana uchun hodimning rejasi (davomiy yoki shu kunga yozilgan) bormi */
const hasCoverageFor = async (employeeId, date) => {
  const row = await db.one(
    `SELECT COUNT(*) AS c FROM missions
     WHERE employee_id = $1 AND status IN ('pending', 'active')
       AND start_date <= $2 AND due_date >= $2`,
    [employeeId, date],
  );
  return Number(row.c) > 0;
};

module.exports = {
  create, byId, openFor, pendingFor, activateDue, markDone, reopen,
  cancel, doneOn, dayStats, allOverdue, rangeStats, hasCoverageFor, dayRows,
};
