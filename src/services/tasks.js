'use strict';

const db = require('../db');
const config = require('../config');
const time = require('../time');

/**
 * TOPSHIRIQLAR.
 * status:  active → (Bajardim) done → (✅) accepted
 *                                    → (↩) active (returned_count+1, review_note)
 *          cancelled — o'chirilgan
 * source:  self | head | admin — kim bergan
 * proof:   rasm/video file_id — "Bajardim"ga biriktirilgan isbot
 */

const SELECT = `SELECT t.*, e.full_name, e.tg_id, e.department_id, e.username
                FROM tasks t JOIN employees e ON e.id = t.employee_id`;

const byId = (id) => db.one(`${SELECT} WHERE t.id = $1`, [Number(id)]);

const create = async ({ employeeId, title, dueDate, createdBy, source = 'self', priority = 'normal', startDate = time.today() }) => {
  const rows = await db.query(
    `INSERT INTO tasks (employee_id, title, status, priority, source, created_by, created_at, start_date, due_date)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [Number(employeeId), String(title).trim().slice(0, 500), priority, source, createdBy ? Number(createdBy) : null, time.stamp(), startDate, dueDate],
  );
  return byId(rows[0].id);
};

/** Ochiq topshiriqlar: kechikkanlar → muhim → muddat bo'yicha */
const openFor = (employeeId) =>
  db.query(
    `${SELECT} WHERE t.employee_id = $1 AND t.status = 'active'
     ORDER BY CASE WHEN t.due_date < $2 THEN 0 ELSE 1 END,
              CASE WHEN t.priority = 'high' THEN 0 ELSE 1 END, t.due_date, t.id`,
    [Number(employeeId), time.today()],
  );

/** Tekshiruvni kutayotganlar (hodim bo'yicha) */
const awaitingReviewFor = (employeeId) =>
  db.query(`${SELECT} WHERE t.employee_id = $1 AND t.status = 'done' ORDER BY t.done_at DESC`, [Number(employeeId)]);

/** Bugun bajarilgan / qabul qilinganlar */
const doneOn = (employeeId, date = time.today()) =>
  db.query(
    `${SELECT} WHERE t.employee_id = $1 AND t.status IN ('done','accepted') AND substr(t.done_at, 1, 10) = $2 ORDER BY t.done_at`,
    [Number(employeeId), date],
  );

/** Muddati o'tgan faol topshiriqlar (hamma yoki bo'lim) */
const overdue = (deptId = null) =>
  db.query(
    `${SELECT} WHERE t.status = 'active' AND t.due_date < $1 ${deptId ? 'AND e.department_id = $2' : ''} AND e.active = 1
     ORDER BY t.due_date, lower(e.full_name)`,
    deptId ? [time.today(), Number(deptId)] : [time.today()],
  );

/** Tekshiruvni kutayotganlar — tekshiruvchi ko'ra oladiganlari */
const pendingReview = (deptId = null) =>
  db.query(
    `${SELECT} WHERE t.status = 'done' ${deptId ? 'AND e.department_id = $1' : ''} AND e.active = 1 ORDER BY t.done_at`,
    deptId ? [Number(deptId)] : [],
  );

/** Hodim "Bajardim" bosdi (isbot ixtiyoriy) */
const markDone = async (id, employeeId, proof = null) => {
  const t = await byId(id);
  if (!t || Number(t.employee_id) !== Number(employeeId)) return { ok: false, reason: 'not_found' };
  if (t.status !== 'active') return { ok: false, reason: 'not_active', task: t };
  await db.query(
    `UPDATE tasks SET status = 'done', done_at = $1, proof_type = $2, proof_file_id = $3, proof_note = $4, review_note = NULL WHERE id = $5`,
    [time.stamp(), proof ? proof.type : null, proof ? proof.fileId : null, proof && proof.note ? proof.note : null, Number(id)],
  );
  return { ok: true, task: await byId(id) };
};

const accept = async (id, byTgId) => {
  const t = await byId(id);
  if (!t || t.status !== 'done') return { ok: false, task: t };
  await db.query(`UPDATE tasks SET status = 'accepted', reviewed_by = $1, reviewed_at = $2 WHERE id = $3`, [Number(byTgId), time.stamp(), Number(id)]);
  return { ok: true, task: await byId(id) };
};

/** Qaytarish — yana faol bo'ladi, muddati kamida bugun */
const returnBack = async (id, byTgId, note = null) => {
  const t = await byId(id);
  if (!t || t.status !== 'done') return { ok: false, task: t };
  const due = t.due_date < time.today() ? time.today() : t.due_date;
  await db.query(
    `UPDATE tasks SET status = 'active', reviewed_by = $1, reviewed_at = $2, review_note = $3, returned_count = returned_count + 1,
       due_date = $4, done_at = NULL, proof_type = NULL, proof_file_id = NULL, proof_note = NULL WHERE id = $5`,
    [Number(byTgId), time.stamp(), note ? String(note).slice(0, 300) : null, due, Number(id)],
  );
  return { ok: true, task: await byId(id) };
};

const cancel = async (id) => {
  await db.query(`UPDATE tasks SET status = 'cancelled', cancelled_at = $1 WHERE id = $2 AND status IN ('active','done')`, [time.stamp(), Number(id)]);
  return byId(id);
};

const rename = (id, title) => db.query('UPDATE tasks SET title = $1 WHERE id = $2', [String(title).trim().slice(0, 500), Number(id)]);
const setDue = (id, dueDate) => db.query('UPDATE tasks SET due_date = $1 WHERE id = $2', [dueDate, Number(id)]);
const setPriority = (id, priority) => db.query('UPDATE tasks SET priority = $1 WHERE id = $2', [priority, Number(id)]);

/** Davr bo'yicha barcha topshiriqlar (muddati davr ichida) */
const range = (employeeId, from, to) =>
  db.query(`${SELECT} WHERE t.employee_id = $1 AND t.due_date BETWEEN $2 AND $3 AND t.status <> 'cancelled' ORDER BY t.due_date, t.id`, [
    Number(employeeId), from, to,
  ]);

/** Jamoa bo'yicha davr topshiriqlari */
const rangeAll = (from, to) =>
  db.query(`${SELECT} WHERE t.due_date BETWEEN $1 AND $2 AND t.status <> 'cancelled' ORDER BY lower(e.full_name), t.due_date, t.id`, [from, to]);

// ---------------------------------------------------------------------------
// ARXIV / DAVR HISOBOTI uchun so'rovlar (kun daftari, kun-kun jadval, Excel)
// ---------------------------------------------------------------------------

/** Berilgan kunda YOZIB QO'YILGAN (yaratilgan) topshiriqlar */
const createdOn = (employeeId, date) =>
  db.query(`${SELECT} WHERE t.employee_id = $1 AND substr(t.created_at, 1, 10) = $2 ORDER BY t.id`, [Number(employeeId), date]);

/** Berilgan kunda o'chirilgan topshiriqlar */
const cancelledOn = (employeeId, date) =>
  db.query(`${SELECT} WHERE t.employee_id = $1 AND t.status = 'cancelled' AND substr(t.cancelled_at, 1, 10) = $2 ORDER BY t.cancelled_at`, [
    Number(employeeId), date,
  ]);

/** O'sha kuni hodim zimmasida bo'lgan topshiriqlar (start ≤ kun ≤ muddat) */
const dueOn = (employeeId, date) =>
  db.query(
    `${SELECT} WHERE t.employee_id = $1 AND t.status <> 'cancelled' AND t.start_date <= $2 AND t.due_date >= $2 ORDER BY t.due_date, t.id`,
    [Number(employeeId), date],
  );

/** Davr ichida bajarilgan (done/accepted) topshiriqlar — done_at bo'yicha */
const doneBetween = (employeeId, from, to) =>
  db.query(
    `${SELECT} WHERE t.employee_id = $1 AND t.status IN ('done','accepted') AND substr(t.done_at, 1, 10) BETWEEN $2 AND $3 ORDER BY t.done_at`,
    [Number(employeeId), from, to],
  );

/** Davr ichida yaratilgan topshiriqlar */
const createdBetween = (employeeId, from, to) =>
  db.query(`${SELECT} WHERE t.employee_id = $1 AND substr(t.created_at, 1, 10) BETWEEN $2 AND $3 ORDER BY t.created_at, t.id`, [
    Number(employeeId), from, to,
  ]);

/**
 * Davrga tegishli BARCHA topshiriqlar (Excel uchun): shu davrda yaratilgan,
 * bajarilgan yoki muddati shu davrga tushganlari.
 */
const forRange = (employeeId, from, to) =>
  db.query(
    `${SELECT} WHERE t.employee_id = $1
       AND ( substr(t.created_at, 1, 10) BETWEEN $2 AND $3
             OR substr(COALESCE(t.done_at, ''), 1, 10) BETWEEN $2 AND $3
             OR (t.start_date <= $3 AND t.due_date >= $2) )
     ORDER BY t.start_date, t.id`,
    [Number(employeeId), from, to],
  );

/** Berilgan sana uchun hodimning rejasi bormi (ertangi reja eslatmasi uchun) */
const hasCoverageFor = async (employeeId, date) =>
  (await db.count(
    `SELECT COUNT(*) AS c FROM tasks WHERE employee_id = $1 AND status IN ('active','done') AND due_date >= $2`,
    [Number(employeeId), date],
  )) > 0;

/**
 * Bir kunlik "snapshot": har bir faol hodimning o'sha kuni bajargan + hozir ochiq ishlari
 * (kunlik Excel uchun). Ishi yo'q hodim ham bitta bo'sh qator bilan chiqadi.
 */
const dayRows = (date = time.today(), employeeId = null) =>
  db.query(
    `SELECT e.id AS employee_id, e.full_name, e.position, e.tg_id,
            t.id AS task_id, t.title, t.status, t.priority, t.source, t.start_date, t.due_date, t.done_at
       FROM employees e
       LEFT JOIN tasks t ON t.employee_id = e.id
        AND ( (t.status IN ('done','accepted') AND substr(t.done_at, 1, 10) = $1) OR t.status = 'active' )
      WHERE e.active = 1 ${employeeId ? 'AND e.id = $2' : ''}
      ORDER BY lower(e.full_name), CASE WHEN t.status IN ('done','accepted') THEN 0 ELSE 1 END, t.due_date, t.id`,
    employeeId ? [date, Number(employeeId)] : [date],
  );

const isOnTime = (t) => t.status === 'accepted' && t.done_at && String(t.done_at).slice(0, 10) <= t.due_date;

/**
 * Davr statistikasi. Hisobga faqat muddati ≤ bugun bo'lganlar kiradi
 * (hali muddati kelmagan ish "bajarilmadi" bo'lib turmasin).
 *   total, accepted, ontime, late (qabul qilingan lekin muddatdan keyin), open, overdue, awaiting,
 *   returned — qaytarilgan ishlar soni, returns — jami qaytarishlar (bitta ish 2 marta = 2),
 *   rawPct — muddatida/jami, penalty — returns × RETURN_PENALTY_PCT, pct = rawPct − penalty (0 dan kam emas)
 */
const stats = async (employeeId, from, to) => {
  const today = time.today();
  const rows = (await range(employeeId, from, to)).filter((t) => t.due_date <= today);
  const res = { total: rows.length, accepted: 0, ontime: 0, late: 0, open: 0, overdue: 0, awaiting: 0, returned: 0, returns: 0 };
  for (const t of rows) {
    if (Number(t.returned_count) > 0) { res.returned += 1; res.returns += Number(t.returned_count); }
    if (t.status === 'accepted') {
      res.accepted += 1;
      if (isOnTime(t)) res.ontime += 1; else res.late += 1;
    } else if (t.status === 'done') res.awaiting += 1;
    else if (t.status === 'active') { res.open += 1; if (t.due_date < today) res.overdue += 1; }
  }
  res.rawPct = res.total ? Math.round((res.ontime / res.total) * 100) : 100;
  res.penalty = res.returns * Math.max(0, config.returnPenaltyPct);
  res.pct = Math.max(0, res.rawPct - res.penalty);
  return res;
};

/** Kunlik: bugun muddati bo'lgan + bugun bajarilganlar (guruh hisoboti uchun) */
const dayStats = async (employeeId, date = time.today()) => {
  const doneToday = await doneOn(employeeId, date);
  const open = await openFor(employeeId);
  return { done: doneToday.length, open: open.length, overdue: open.filter((t) => t.due_date < date).length };
};

module.exports = {
  byId, create, openFor, awaitingReviewFor, doneOn, overdue, pendingReview, markDone, accept, returnBack, cancel,
  rename, setDue, setPriority, range, rangeAll, isOnTime, stats, dayStats,
  createdOn, cancelledOn, dueOn, doneBetween, createdBetween, forRange, hasCoverageFor, dayRows,
};
