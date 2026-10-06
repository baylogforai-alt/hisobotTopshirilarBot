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

const SELECT = `SELECT t.*, e.full_name, e.tg_id, e.department_id, e.username, e.role AS emp_role,
                (SELECT g.full_name FROM employees g WHERE g.tg_id = t.created_by ORDER BY g.id LIMIT 1) AS giver_name
                FROM tasks t JOIN employees e ON e.id = t.employee_id`;

const byId = (id) => db.one(`${SELECT} WHERE t.id = $1`, [Number(id)]);

/** 'HH:mm' (yoki 'H:mm', 'HH.mm') → 'HH:mm' yoki null */
const normTime = (raw) => {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(raw || ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
};
/** Shu kun va soat allaqachon o'tganmi */
const startPassed = (dueDate, hhmm, now = time.now()) => {
  const today = time.today();
  if (dueDate !== today) return dueDate < today;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m <= now.hour * 60 + now.minute;
};

/**
 * media — topshiriqning o'zi ovoz / video / fayl / rasm bo'lsa: { type, fileId, fileName }
 * startTime — 'HH:mm': muddat kuni shu soatda hodimga «boshlash vaqti keldi» xabari boradi (o'tgan vaqt — xabarsiz)
 */
const create = async ({ employeeId, title, dueDate, createdBy, source = 'self', priority = 'normal', startDate = time.today(), media = null, startTime = null }) => {
  const st = normTime(startTime);
  const rows = await db.query(
    `INSERT INTO tasks (employee_id, title, status, priority, source, created_by, created_at, start_date, due_date, task_media_type, task_file_id, task_file_name, start_time, start_notified_at)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [Number(employeeId), String(title).trim().slice(0, 500), priority, source, createdBy ? Number(createdBy) : null, time.stamp(), startDate, dueDate,
      media ? media.type : null, media ? media.fileId : null, media && media.fileName ? String(media.fileName).slice(0, 200) : null,
      st, st && startPassed(dueDate, st) ? time.stamp() : null],
  );
  return byId(rows[0].id);
};

/** Boshlanish soati kelgan, hali xabar berilmagan faol topshiriqlar (muddat kuni = bugun) */
const dueStarts = (now = time.now()) =>
  db.query(
    `${SELECT} WHERE t.status = 'active' AND t.start_time IS NOT NULL AND t.start_notified_at IS NULL AND t.due_date = $1 AND t.start_time <= $2 AND e.active = 1 ORDER BY t.start_time, t.id`,
    [time.today(), `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`],
  );
const markStartNotified = (id) => db.query('UPDATE tasks SET start_notified_at = $1 WHERE id = $2 AND start_notified_at IS NULL', [time.stamp(), Number(id)]);

/**
 * HR ko'rmaydigan topshiriqlar: boshliq / direktor bergani (source='admin') va boshliqning o'z missiyalari.
 * HR o'zi bergan yoki o'ziga berilgan topshiriq — ko'rinadi. Boshliq Panelda yoqsa (actor.hrSeesBoss) — HR hammasini ko'radi.
 */
const hiddenFromHr = (t) => t.source === 'admin' || (t.source === 'self' && (t.emp_role || t.role) === 'admin');
/** actor (access.resolve) bu topshiriqni ko'ra oladimi — faqat HR cheklovi (qolgan huquqlar chaqiruvchida) */
const visibleTo = (actor, t) => {
  if (!t || !actor || actor.isAdmin || !actor.isHr || actor.hrSeesBoss) return true;
  if (actor.employee && Number(t.employee_id) === Number(actor.employee.id)) return true;
  if (t.created_by && Number(t.created_by) === Number(actor.tgId)) return true;
  return !hiddenFromHr(t);
};
const visibleFor = (actor, list) => list.filter((t) => visibleTo(actor, t));

/**
 * Holat bo'yicha ro'yxat: active (jarayonda, muddati o'tganlar ham) · review (bajardi — tekshiruvda) · accepted (bajarilgan, since dan beri).
 * employeeIds — null: hamma faol hodim
 */
const listByKind = async (kind, { employeeIds = null, since = null } = {}) => {
  const params = [];
  let where = 'e.active = 1';
  if (kind === 'active') where += " AND t.status = 'active' AND COALESCE(t.returned_count, 0) = 0";
  else if (kind === 'fix') where += " AND t.status = 'active' AND COALESCE(t.returned_count, 0) > 0";
  else if (kind === 'review') where += " AND t.status = 'done'";
  else {
    params.push(since || time.monthRange(time.month()).from);
    where += ` AND t.status = 'accepted' AND substr(t.done_at, 1, 10) >= $${params.length}`;
  }
  const order = kind === 'active' || kind === 'fix' ? 't.due_date, t.id' : 't.done_at DESC, t.id DESC';
  const today = time.today();
  const rows = (await db.query(`${JOURNAL_SELECT} WHERE ${where} ORDER BY ${order}`, params)).map((t) => withKinds(t, today));
  if (!employeeIds) return rows;
  const ids = new Set(employeeIds.map(Number));
  return rows.filter((t) => ids.has(Number(t.employee_id)));
};

/** «Eshitdim, tushundim» kerakmi: boshqa odam bergan, hali tasdiqlanmagan, yopilmagan */
const needsAck = (t) => Boolean(t && t.source !== 'self' && !t.ack_at && (t.status === 'active' || t.status === 'done'));

/** Hodim «tushundim» degan topshiriqlar (bergani xabardor qilinadi) */
const unackedFor = async (employeeId) =>
  (await db.query(`${SELECT} WHERE t.employee_id = $1 AND t.source <> 'self' AND t.ack_at IS NULL AND t.status IN ('active', 'done') ORDER BY t.id`, [Number(employeeId)]));

/** Tasdiqlash — faqat o'z topshirig'i, bir marta. Tasdiqlangan topshiriq yoki null */
const ack = async (id, employeeId, note = null) => {
  const t = await byId(id);
  if (!t || Number(t.employee_id) !== Number(employeeId) || !needsAck(t)) return null;
  const rows = await db.query('UPDATE tasks SET ack_at = $1, ack_note = $2 WHERE id = $3 AND ack_at IS NULL RETURNING id', [time.stamp(), note ? String(note).slice(0, 300) : null, Number(id)]);
  return rows.length ? byId(id) : null;
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

/** Yaqinda qabul qilinganlar (since — 'yyyy-MM-dd' dan beri), yangilari birinchi */
const acceptedSince = (employeeId, since, limit = 50) =>
  db.query(
    `${SELECT} WHERE t.employee_id = $1 AND t.status = 'accepted' AND substr(t.done_at, 1, 10) >= $2 ORDER BY t.done_at DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`,
    [Number(employeeId), since],
  );

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
  const rows = await db.query(
    `UPDATE tasks SET status = 'done', done_at = $1, proof_type = $2, proof_file_id = $3, proof_note = $4, review_note = NULL WHERE id = $5 AND status = 'active' RETURNING id`,
    [time.stamp(), proof ? proof.type : null, proof ? proof.fileId : null, proof && proof.note ? proof.note : null, Number(id)],
  );
  if (!rows.length) return { ok: false, reason: 'not_active', task: await byId(id) };
  return { ok: true, task: await byId(id) };
};

/**
 * Boshliqning topshirig'i (o'zi yozgan missiya yoki HR / direktor bergani) — isbot ixtiyoriy,
 * tekshiruvsiz darhol «bajarildi» (accepted): boshliqdan yuqori tekshiruvchi yo'q.
 */
const isBossOwn = (emp, t) => Boolean(emp && t && emp.role === 'admin' && Number(t.employee_id) === Number(emp.id));

/** Boshliqning topshirig'i: done + accepted bir qadamda */
const completeOwn = async (id, emp, proof = null) => {
  const res = await markDone(id, emp.id, proof);
  if (!res.ok) return res;
  await db.query(`UPDATE tasks SET status = 'accepted', reviewed_by = $1, reviewed_at = $2 WHERE id = $3`, [Number(emp.tg_id), res.task.done_at, Number(id)]);
  return { ok: true, task: await byId(id) };
};

const accept = async (id, byTgId) => {
  const t = await byId(id);
  if (!t || t.status !== 'done') return { ok: false, task: t };
  const rows = await db.query(`UPDATE tasks SET status = 'accepted', reviewed_by = $1, reviewed_at = $2 WHERE id = $3 AND status = 'done' RETURNING id`, [Number(byTgId), time.stamp(), Number(id)]);
  if (!rows.length) return { ok: false, task: await byId(id) };
  return { ok: true, task: await byId(id) };
};

/**
 * Qaytarish («🔁 Ko'rib chiqish») — yana faol bo'ladi.
 * fixDue — tekshiruvchi bergan tuzatish muddati: shu sanagacha tuzatsa — vaqtida (5-okt qarori).
 * fixDue berilmasa — eski muddat qoladi: u o'tgan bo'lsa, tuzatilgan ish ham kechikkan hisoblanadi.
 * countLate — (ilova, eski) kechikish majburan qolsin. Holat sharti UPDATE ichida — ikki marta bosilsa ikkinchisi o'tmaydi.
 */
const returnBack = async (id, byTgId, note = null, { countLate = false, fixDue = null } = {}) => {
  const t = await byId(id);
  if (!t || t.status !== 'done') return { ok: false, task: t };
  const due = fixDue || t.due_date;
  const rows = await db.query(
    `UPDATE tasks SET status = 'active', reviewed_by = $1, reviewed_at = $2, review_note = $3, returned_count = returned_count + 1,
       due_date = $4, done_at = NULL, proof_type = NULL, proof_file_id = NULL, proof_note = NULL,
       late_forced = CASE WHEN $6 = 1 THEN 1 ELSE late_forced END WHERE id = $5 AND status = 'done' RETURNING id`,
    [Number(byTgId), time.stamp(), note ? String(note).slice(0, 300) : null, due, Number(id), countLate ? 1 : 0],
  );
  if (!rows.length) return { ok: false, task: await byId(id) };
  return { ok: true, task: await byId(id) };
};

/** Qaytarilgan topshiriq bo'yicha yozishma (hodim ↔ tekshiruvchi) — bazada qoladi */
const addReply = async ({ taskId, fromTg, fromName, toTg = null, body = null, media = null }) => {
  const rows = await db.query(
    `INSERT INTO task_replies (task_id, from_tg, from_name, to_tg, body, media_type, file_id, file_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [Number(taskId), Number(fromTg), fromName || null, toTg ? Number(toTg) : null, body, media ? media.type : null, media ? media.fileId : null, media && media.fileName ? media.fileName : null, time.stamp()],
  );
  return db.one('SELECT * FROM task_replies WHERE id = $1', [Number(rows[0].id)]);
};
const replies = (taskId) => db.query('SELECT * FROM task_replies WHERE task_id = $1 ORDER BY id', [Number(taskId)]);
/** { taskId: yozishmalar soni } — ro'yxatlar uchun bitta so'rov */
const replyCounts = async () => {
  const map = new Map();
  for (const r of await db.query('SELECT task_id, COUNT(*) AS n FROM task_replies GROUP BY task_id')) map.set(Number(r.task_id), Number(r.n));
  return map;
};

/** Bekor qilish — yozuv o'chirilmaydi, status 'cancelled' + kim va qachon */
/** Bekor qilish (faol yoki tekshiruvdagi). O'zgarmagan bo'lsa (allaqachon bekor/qabul qilingan) — null */
const cancel = async (id, byTgId = null) => {
  const rows = await db.query(`UPDATE tasks SET status = 'cancelled', cancelled_at = $1, cancelled_by = $2 WHERE id = $3 AND status IN ('active','done') RETURNING id`,
    [time.stamp(), byTgId ? Number(byTgId) : null, Number(id)]);
  return rows.length ? byId(id) : null;
};

const rename = (id, title) => db.query('UPDATE tasks SET title = $1 WHERE id = $2', [String(title).trim().slice(0, 500), Number(id)]);
const setDue = (id, dueDate) => db.query('UPDATE tasks SET due_date = $1 WHERE id = $2', [dueDate, Number(id)]);
const setPriority = (id, priority) => db.query('UPDATE tasks SET priority = $1 WHERE id = $2', [priority, Number(id)]);

/** Davr bo'yicha barcha topshiriqlar (muddati davr ichida) */
const range = (employeeId, from, to) =>
  db.query(`${SELECT} WHERE t.employee_id = $1 AND t.due_date BETWEEN $2 AND $3 AND t.status <> 'cancelled' ORDER BY t.due_date, t.id`, [
    Number(employeeId), from, to,
  ]);

// ---------------------------------------------------------------------------
// JURNAL — hamma topshiriqlar (boshliq/direktor va HR): kim, kimga, qachon, nima
// ---------------------------------------------------------------------------
const JOURNAL_SELECT = `SELECT t.*, e.full_name, e.tg_id, e.department_id, e.username, e.role AS emp_role,
         g.full_name AS giver_name, g.is_hr AS giver_is_hr, g.role AS giver_role
    FROM tasks t JOIN employees e ON e.id = t.employee_id
    LEFT JOIN employees g ON g.tg_id = t.created_by`;

/** Kim bergan: admin (direktor/boshliq) · hr · head (bo'lim rahbari) · self (o'zi yozgan) */
const giverKind = (t) => {
  if (t.source === 'self') return 'self';
  if (t.source === 'admin') return 'admin';
  return Number(t.giver_is_hr) === 1 ? 'hr' : 'head';
};
/** open · review · accepted · overdue · cancelled */
const statusKind = (t, today = time.today()) => {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'accepted') return 'accepted';
  if (t.status === 'done') return 'review';
  return t.due_date < today ? 'overdue' : 'open';
};
const withKinds = (t, today) => (t ? { ...t, giver_kind: giverKind(t), status_kind: statusKind(t, today) } : null);

/** Berilgan sana (created_at) [from, to] oralig'ida; yangisi birinchi. filter: employeeId, giver, status */
const journal = async ({ from, to, employeeId = null, giver = null, status = null } = {}) => {
  const params = [from, to];
  let where = 'substr(t.created_at, 1, 10) BETWEEN $1 AND $2';
  if (employeeId) { params.push(Number(employeeId)); where += ` AND t.employee_id = $${params.length}`; }
  const today = time.today();
  const rows = await db.query(`${JOURNAL_SELECT} WHERE ${where} ORDER BY t.created_at DESC, t.id DESC`, params);
  return rows.map((t) => withKinds(t, today)).filter((t) => (!giver || t.giver_kind === giver) && (!status || t.status_kind === status));
};
const journalItem = async (id) => withKinds(await db.one(`${JOURNAL_SELECT} WHERE t.id = $1`, [Number(id)]));

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
            t.id AS task_id, t.title, t.status, t.priority, t.source, t.created_by, e.role AS emp_role, t.start_date, t.due_date, t.done_at
       FROM employees e
       LEFT JOIN tasks t ON t.employee_id = e.id
        AND ( (t.status IN ('done','accepted') AND substr(t.done_at, 1, 10) = $1) OR t.status = 'active' )
      WHERE e.active = 1 ${employeeId ? 'AND e.id = $2' : ''}
      ORDER BY lower(e.full_name), CASE WHEN t.status IN ('done','accepted') THEN 0 ELSE 1 END, t.due_date, t.id`,
    employeeId ? [date, Number(employeeId)] : [date],
  );

/** Muddatida bajarilganmi. late_forced — tekshiruvchi qaytarishda «kechikish hisoblansin» degan */
const isOnTime = (t) => t.status === 'accepted' && t.done_at && String(t.done_at).slice(0, 10) <= t.due_date && !Number(t.late_forced);
/** Hodim muddatidan keyin topshirganmi (tekshiruvdagi ish uchun) */
const submittedLate = (t) => Boolean(t && t.done_at && String(t.done_at).slice(0, 10) > t.due_date);

/**
 * Davr statistikasi. Hisobga faqat muddati ≤ bugun bo'lganlar kiradi
 * (hali muddati kelmagan ish "bajarilmadi" bo'lib turmasin).
 *   total, accepted, ontime, late (qabul qilingan lekin muddatdan keyin), open, overdue, awaiting,
 *   returned — qaytarilgan ishlar soni, returns — jami qaytarishlar (bitta ish 2 marta = 2),
 *   missed — muddatida bajarilmaganlar (kech qabul + kech topshirilgan + muddati o'tgan ochiq) — KPI sharti uchun
 *   rawPct — muddatida/jami, penalty — returns × RETURN_PENALTY_PCT, pct = rawPct − penalty (0 dan kam emas)
 */
const stats = async (employeeId, from, to) => {
  const today = time.today();
  const rows = (await range(employeeId, from, to)).filter((t) => t.due_date <= today);
  const res = { total: rows.length, accepted: 0, ontime: 0, late: 0, open: 0, overdue: 0, awaiting: 0, awaitingOnTime: 0, returned: 0, returns: 0, missed: 0 };
  for (const t of rows) {
    if (Number(t.returned_count) > 0) { res.returned += 1; res.returns += Number(t.returned_count); }
    if (t.status === 'accepted') {
      res.accepted += 1;
      if (isOnTime(t)) res.ontime += 1; else { res.late += 1; res.missed += 1; }
    } else if (t.status === 'done') {
      res.awaiting += 1;
      if ((t.done_at && String(t.done_at).slice(0, 10) > t.due_date) || Number(t.late_forced)) res.missed += 1;
      else res.awaitingOnTime += 1;
    } else if (t.status === 'active') { res.open += 1; if (t.due_date < today) { res.overdue += 1; res.missed += 1; } }
  }
  res.rawPct = res.total ? Math.round((res.ontime / res.total) * 100) : 100;
  res.penalty = res.returns * Math.max(0, config.returnPenaltyPct);
  res.pct = Math.max(0, res.rawPct - res.penalty);
  // KPI sharti uchun: muddatida topshirilib tekshiruvda turganlar ham «muddatida» (tekshiruvchi kechiksa hodim jabr ko'rmasin)
  res.gatePct = res.total ? Math.max(0, Math.round(((res.ontime + res.awaitingOnTime) / res.total) * 100) - res.penalty) : 100;
  return res;
};

/** Kunlik: bugun muddati bo'lgan + bugun bajarilganlar (guruh hisoboti uchun) */
const dayStats = async (employeeId, date = time.today()) => {
  const doneToday = await doneOn(employeeId, date);
  const open = await openFor(employeeId);
  return { done: doneToday.length, open: open.length, overdue: open.filter((t) => t.due_date < date).length };
};

module.exports = {
  normTime, startPassed, dueStarts, markStartNotified, hiddenFromHr, visibleTo, visibleFor, listByKind,
  isBossOwn, completeOwn, addReply, replies, replyCounts, needsAck, unackedFor, ack, journal, journalItem, giverKind, statusKind, byId, create, openFor, awaitingReviewFor, acceptedSince, doneOn, overdue, pendingReview, markDone, accept, returnBack, cancel,
  rename, setDue, setPriority, range, rangeAll, isOnTime, submittedLate, stats, dayStats,
  createdOn, cancelledOn, dueOn, doneBetween, createdBetween, forRange, hasCoverageFor, dayRows,
};
