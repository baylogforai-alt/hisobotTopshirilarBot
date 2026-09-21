'use strict';

const db = require('../db');
const config = require('../config');
const time = require('../time');

/**
 * DAVOMAT.
 *  - checkIn: GPS bilan, late_minutes = ish boshlanishi + LATE_GRACE dan keyingi daqiqalar
 *  - sababli kun (excuse): hodim so'raydi (pending) → boshliq/direktor tasdiqlaydi (approved) yoki rad etadi (rejected);
 *    direktor to'g'ridan-to'g'ri approved qilib qo'yishi ham mumkin. Approved kun ish kuni hisoblanmaydi.
 *
 * Kun holati (dayStatus): ontime | late | absent | excused | pending | future | off
 */

const get = (employeeId, date = time.today()) =>
  db.one('SELECT * FROM attendance WHERE employee_id = $1 AND work_date = $2', [Number(employeeId), date]);

/** Hodimning ish boshlanishi (daqiqalarda) — work_start bo'lsa o'shaniki, bo'lmasa umumiy */
const { startMinutesOf } = require('./employees');

/** Kechikish daqiqasi: hodim ish boshlanishi + LATE_GRACE_MINUTES dan keyin kelgan bo'lsa. emp berilmasa umumiy vaqt. */
const lateMinutesOf = (iso, emp = null) => {
  const mins = time.minutesOfDay(iso);
  if (mins === null) return 0;
  const late = mins - startMinutesOf(emp);
  return late > config.lateGraceMinutes ? late : 0;
};

/** employee — id yoki hodim obyekti (work_start uchun) */
const checkIn = async (employee, location = null, date = time.today()) => {
  const emp = typeof employee === 'object' && employee ? employee : null;
  const employeeId = emp ? emp.id : employee;
  const existing = await get(employeeId, date);
  if (existing && existing.checked_in) return { already: true, row: existing };
  const stamp = time.stamp();
  const late = lateMinutesOf(stamp, emp);
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, checked_in, checkin_lat, checkin_lon, checkin_dist, late_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       checked_in = EXCLUDED.checked_in, checkin_lat = EXCLUDED.checkin_lat, checkin_lon = EXCLUDED.checkin_lon,
       checkin_dist = EXCLUDED.checkin_dist, late_minutes = EXCLUDED.late_minutes`,
    [
      Number(employeeId), date, stamp,
      location ? String(location.lat) : null, location ? String(location.lon) : null,
      location && location.dist != null ? String(location.dist) : null, late,
    ],
  );
  return { already: false, late, row: await get(employeeId, date) };
};

const setLateReason = async (employeeId, reason, date = time.today()) => {
  await db.query('UPDATE attendance SET late_reason = $1 WHERE employee_id = $2 AND work_date = $3', [reason, Number(employeeId), date]);
  return get(employeeId, date);
};

const checkOut = async (employeeId, date = time.today()) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, checked_out) VALUES ($1, $2, $3)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET checked_out = EXCLUDED.checked_out`,
    [Number(employeeId), date, time.stamp()],
  );
  return get(employeeId, date);
};

/** "Ishga kelyapsizmi?" so'roviga javob (yes/no) */
const setIntent = async (employeeId, intent, date = time.today()) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, intent, intent_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET intent = EXCLUDED.intent, intent_at = EXCLUDED.intent_at`,
    [Number(employeeId), date, intent, time.stamp()],
  );
  return get(employeeId, date);
};

/** Bugun ishga kelgan va hali ketmagan hodimlar */
const workingNow = (date = time.today()) =>
  db.query(
    `SELECT e.* FROM employees e JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
     WHERE e.active = 1 AND a.checked_in IS NOT NULL AND a.checked_out IS NULL ORDER BY lower(e.full_name)`,
    [date],
  );

const isCheckedIn = async (employeeId, date = time.today()) => Boolean((await get(employeeId, date) || {}).checked_in);
const isCheckedOut = async (employeeId, date = time.today()) => Boolean((await get(employeeId, date) || {}).checked_out);

// ---------------------------------------------------------------------------
// SABABLI KUN
// ---------------------------------------------------------------------------

/** Hodim o'zi so'raydi → pending */
const requestExcuse = async (employeeId, reason, date = time.today()) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, excuse_status, excuse_reason, excuse_at)
     VALUES ($1, $2, 'pending', $3, $4)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       excuse_status = 'pending', excuse_reason = EXCLUDED.excuse_reason, excuse_at = EXCLUDED.excuse_at, excuse_by = NULL`,
    [Number(employeeId), date, String(reason).slice(0, 300), time.stamp()],
  );
  return get(employeeId, date);
};

/** Boshliq / direktor qarori yoki to'g'ridan-to'g'ri belgilash */
const decideExcuse = async (employeeId, date, status, byTgId, reason = null) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, excuse_status, excuse_reason, excuse_by, excuse_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       excuse_status = EXCLUDED.excuse_status,
       excuse_reason = COALESCE(EXCLUDED.excuse_reason, attendance.excuse_reason),
       excuse_by = EXCLUDED.excuse_by, excuse_at = EXCLUDED.excuse_at`,
    [Number(employeeId), date, status, reason ? String(reason).slice(0, 300) : null, Number(byTgId), time.stamp()],
  );
  return get(employeeId, date);
};

const byId = (id) => db.one('SELECT * FROM attendance WHERE id = $1', [Number(id)]);

const pendingExcuses = () =>
  db.query(
    `SELECT a.*, e.full_name, e.tg_id, e.department_id FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     WHERE a.excuse_status = 'pending' AND e.active = 1 ORDER BY a.work_date DESC`,
  );

// ---------------------------------------------------------------------------
// RO'YXATLAR
// ---------------------------------------------------------------------------

/** Bugun kelganlar (kech kelganlar ham) */
const presentToday = (date = time.today()) =>
  db.query(
    `SELECT e.*, a.checked_in, a.checked_out, a.late_minutes, a.late_reason FROM employees e
     JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
     WHERE e.active = 1 AND a.checked_in IS NOT NULL ORDER BY a.checked_in`,
    [date],
  );

/** Bugun kelmaganlar (sababli/pending belgisi bilan) */
const absentToday = (date = time.today()) =>
  db.query(
    `SELECT e.*, a.excuse_status, a.excuse_reason FROM employees e
     LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
     WHERE e.active = 1 AND a.checked_in IS NULL ORDER BY lower(e.full_name)`,
    [date],
  );

const lateToday = (date = time.today()) =>
  db.query(
    `SELECT e.*, a.checked_in, a.late_minutes, a.late_reason FROM employees e
     JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
     WHERE e.active = 1 AND a.late_minutes > 0 ORDER BY a.late_minutes DESC`,
    [date],
  );

const range = (employeeId, from, to) =>
  db.query('SELECT * FROM attendance WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date', [
    Number(employeeId), from, to,
  ]);

const workedMinutes = (row) => {
  if (!row || !row.checked_in || !row.checked_out) return null;
  const a = Date.parse(row.checked_in);
  const b = Date.parse(row.checked_out);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? Math.round((b - a) / 60000) : null;
};

// ---------------------------------------------------------------------------
// DAVR STATISTIKASI
// ---------------------------------------------------------------------------

/** Bitta kunning holati. emp berilsa "hali vaqti kelmagan" hodimning o'z ish boshlanishiga qarab aniqlanadi. */
const dayStatus = (row, date, today = time.today(), emp = null) => {
  if (!time.isWorkDay(date) && !(row && row.checked_in)) return 'off';
  if (row && row.excuse_status === 'approved') return 'excused';
  if (row && row.checked_in) return Number(row.late_minutes) > 0 ? 'late' : 'ontime';
  if (row && row.excuse_status === 'pending') return 'pending';
  if (date > today) return 'future';
  if (date === today) {
    const now = time.now();
    if (now.hour * 60 + now.minute < startMinutesOf(emp) + config.lateGraceMinutes) return 'future';
  }
  return 'absent';
};

/**
 * Davr bo'yicha: ish kunlari, vaqtida, kech, kelmagan, sababli, davomat %.
 * Davomat % = (vaqtida + kech×0.5) / (ish kunlari − sababli) × 100. Erkin jadvalda kech = vaqtida.
 */
const stats = async (emp, from, to) => {
  const rows = await range(emp.id, from, to);
  const map = new Map(rows.map((r) => [r.work_date, r]));
  const today = time.today();
  const res = { workDays: 0, ontime: 0, late: 0, absent: 0, excused: 0, pending: 0, lateMinutes: 0, days: [] };
  const flexible = Number(emp.flexible) === 1;
  for (let d = from; d <= to; d = time.addDays(d, 1)) {
    const row = map.get(d) || null;
    let st = dayStatus(row, d, today, emp);
    if (flexible && st === 'late') st = 'ontime';
    if (flexible && st === 'absent') st = 'excused';
    res.days.push({ date: d, status: st, row });
    if (st === 'off' || st === 'future') continue;
    if (st === 'excused') { res.excused += 1; continue; }
    res.workDays += 1;
    if (st === 'ontime') res.ontime += 1;
    else if (st === 'late') { res.late += 1; res.lateMinutes += Number(row.late_minutes) || 0; }
    else if (st === 'pending') { res.pending += 1; res.absent += 1; }
    else res.absent += 1;
  }
  res.pct = res.workDays ? Math.round(((res.ontime + res.late * 0.5) / res.workDays) * 100) : 100;
  return res;
};

module.exports = {
  get, byId, startMinutesOf, lateMinutesOf, checkIn, setLateReason, checkOut, setIntent, workingNow, isCheckedIn, isCheckedOut,
  requestExcuse, decideExcuse, pendingExcuses, presentToday, absentToday, lateToday, range, workedMinutes,
  dayStatus, stats,
};
