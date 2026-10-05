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

/**
 * employee — id yoki hodim obyekti (work_start uchun).
 * location: { lat, lon, dist, at?, mode?, proof?: {type, fileId}, note? } — at berilsa kelish vaqti shu (lokatsiya yuborilgan payt).
 */
const checkIn = async (employee, location = null, date = time.today()) => {
  const emp = typeof employee === 'object' && employee ? employee : null;
  const employeeId = emp ? emp.id : employee;
  const existing = await get(employeeId, date);
  if (existing && existing.checked_in) return { already: true, row: existing };
  const stamp = (location && location.at) || time.stamp();
  const late = lateMinutesOf(stamp, emp);
  const proof = location && location.proof ? location.proof : null;
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, checked_in, checkin_lat, checkin_lon, checkin_dist, late_minutes,
       checkin_mode, checkin_proof_type, checkin_proof_file_id, checkin_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       checked_in = EXCLUDED.checked_in, checkin_lat = EXCLUDED.checkin_lat, checkin_lon = EXCLUDED.checkin_lon,
       checkin_dist = EXCLUDED.checkin_dist, late_minutes = EXCLUDED.late_minutes, checkin_mode = EXCLUDED.checkin_mode,
       checkin_proof_type = EXCLUDED.checkin_proof_type, checkin_proof_file_id = EXCLUDED.checkin_proof_file_id,
       checkin_note = EXCLUDED.checkin_note`,
    [
      Number(employeeId), date, stamp,
      location ? String(location.lat) : null, location ? String(location.lon) : null,
      location && location.dist != null ? String(Math.round(location.dist)) : null, late,
      (location && location.mode) || null, proof ? proof.type : null, proof ? proof.fileId : null,
      location && location.note ? String(location.note).slice(0, 300) : null,
    ],
  );
  return { already: false, late, row: await get(employeeId, date) };
};

/** Kechikish sababi (kelgandan keyin). proof — video/audio/rasm isboti (ixtiyoriy) */
const setLateReason = async (employeeId, reason, date = time.today(), proof = null) => {
  await db.query(
    `UPDATE attendance SET late_reason = $1, late_proof_type = COALESCE($2, late_proof_type), late_proof_file_id = COALESCE($3, late_proof_file_id)
     WHERE employee_id = $4 AND work_date = $5`,
    [reason, proof ? proof.type : null, proof ? proof.fileId : null, Number(employeeId), date],
  );
  return get(employeeId, date);
};

/** «Kech qolaman» — kelishdan OLDIN ogohlantirish (qator check-insiz yaratiladi, Keldim keyin ustiga yozadi) */
const lateNotice = async (employeeId, reason, proof = null, date = time.today()) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, late_reason, late_notice_at, late_proof_type, late_proof_file_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       late_reason = EXCLUDED.late_reason, late_notice_at = EXCLUDED.late_notice_at,
       late_proof_type = EXCLUDED.late_proof_type, late_proof_file_id = EXCLUDED.late_proof_file_id`,
    [Number(employeeId), date, String(reason).slice(0, 300), time.stamp(), proof ? proof.type : null, proof ? proof.fileId : null],
  );
  return get(employeeId, date);
};

/** place — { lat, lon, dist } (Ketdim lokatsiyasi), note — izoh */
const checkOut = async (employeeId, date = time.today(), { place = null, note = null } = {}) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, checked_out, checkout_lat, checkout_lon, checkout_dist, checkout_note) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET checked_out = EXCLUDED.checked_out, checkout_lat = EXCLUDED.checkout_lat,
       checkout_lon = EXCLUDED.checkout_lon, checkout_dist = EXCLUDED.checkout_dist, checkout_note = EXCLUDED.checkout_note`,
    [Number(employeeId), date, time.stamp(), place ? String(place.lat) : null, place ? String(place.lon) : null,
      place && place.dist != null ? String(Math.round(place.dist)) : null, note ? String(note).slice(0, 300) : null],
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
const requestExcuse = async (employeeId, reason, date = time.today(), proof = null) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, excuse_status, excuse_reason, excuse_at, excuse_proof_type, excuse_proof_file_id)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       excuse_status = 'pending', excuse_reason = EXCLUDED.excuse_reason, excuse_at = EXCLUDED.excuse_at, excuse_by = NULL,
       excuse_proof_type = EXCLUDED.excuse_proof_type, excuse_proof_file_id = EXCLUDED.excuse_proof_file_id`,
    [Number(employeeId), date, String(reason).slice(0, 300), time.stamp(), proof ? proof.type : null, proof ? proof.fileId : null],
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
/**
 * «Kech qolaman» o'z vaqtida (ish boshlanishidan ≥ LATE_NOTICE_MIN_BEFORE daqiqa oldin, o'sha kuni) yuborilganmi.
 * Shunday bo'lsa o'sha kungi kechikish «vaqtida» hisoblanadi (KPI va davomat % ga ta'sir qilmaydi).
 */
const noticedInTime = (row, emp = null) => {
  if (!row || !row.late_notice_at || !config.lateNoticeMinBefore) return false;
  if (String(row.late_notice_at).slice(0, 10) !== row.work_date) return false;
  const m = time.minutesOfDay(row.late_notice_at);
  return m !== null && m <= startMinutesOf(emp) - config.lateNoticeMinBefore;
};

/** Kechikish hisoblanmaydimi: oldindan ogohlantirgan yoki rahbariyat sababli deb belgilagan */
const lateForgiven = (row, emp = null) => Boolean(row && (row.late_excused_at || noticedInTime(row, emp)));

/**
 * Kun holati. Kelgan bo'lsa — «sababli» so'rov tasdiqlangan bo'lsa ham oddiy kun (kech kelsa — kech).
 * Dam olish kuni kelgan — 'extra' (ishlagan kun, kechikish hisoblanmaydi, ish kunlariga qo'shilmaydi).
 */
const dayStatus = (row, date, today = time.today(), emp = null) => {
  if (row && row.checked_in) {
    if (!time.isWorkDay(date)) return 'extra';
    return Number(row.late_minutes) > 0 && !lateForgiven(row, emp) ? 'late' : 'ontime';
  }
  if (!time.isWorkDay(date)) return 'off';
  if (row && row.excuse_status === 'approved') return 'excused';
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
  const res = { workDays: 0, ontime: 0, late: 0, absent: 0, excused: 0, pending: 0, extra: 0, lateMinutes: 0, days: [] };
  const flexible = Number(emp.flexible) === 1;
  // Hodim qo'shilgan kundan oldingi kunlar hisobga olinmaydi (oy o'rtasida qo'shilgan hodim "kelmagan" bo'lib qolmasin)
  const hired = emp.created_at ? String(emp.created_at).slice(0, 10) : null;
  for (let d = from; d <= to; d = time.addDays(d, 1)) {
    const row = map.get(d) || null;
    // qo'shilgan kunning o'zi ham — faqat o'sha kuni kelgan/sabab yozgan bo'lsa (kunduzi qo'shilgan hodim «kelmagan» bo'lmasin)
    if (hired && d <= hired && !(row && (row.checked_in || row.excuse_status))) continue;
    let st = dayStatus(row, d, today, emp);
    if (flexible && st === 'late') st = 'ontime';
    if (flexible && st === 'absent') st = 'excused';
    res.days.push({ date: d, status: st, row });
    if (st === 'off' || st === 'future') continue;
    if (st === 'extra') { res.extra += 1; continue; }
    if (st === 'excused') { res.excused += 1; continue; }
    // hal qilinmagan «Kelmayman» — sababli hisoblanadi (rad etilsa — kelmagan bo'ladi)
    if (st === 'pending') { res.pending += 1; res.excused += 1; continue; }
    res.workDays += 1;
    if (st === 'ontime') res.ontime += 1;
    else if (st === 'late') { res.late += 1; res.lateMinutes += Number(row.late_minutes) || 0; }
    else res.absent += 1;
  }
  res.pct = res.workDays ? Math.round(((res.ontime + res.late * 0.5) / res.workDays) * 100) : 100;
  return res;
};

/** Kech kelgan kunni rahbariyat «sababli» qiladi — kechikish hisoblanmaydi. Bir marta: allaqachon bo'lsa false */
const excuseLate = async (attId, byTgId) => {
  const rows = await db.query(
    `UPDATE attendance SET late_excused_at = $1, late_excused_by = $2
     WHERE id = $3 AND checked_in IS NOT NULL AND late_minutes > 0 AND late_excused_at IS NULL RETURNING id`,
    [time.stamp(), Number(byTgId), Number(attId)],
  );
  return rows.length > 0;
};

module.exports = {
  excuseLate, lateForgiven,
  get, byId, startMinutesOf, lateMinutesOf, checkIn, setLateReason, lateNotice, checkOut, setIntent, workingNow, isCheckedIn, isCheckedOut,
  requestExcuse, decideExcuse, pendingExcuses, presentToday, absentToday, lateToday, range, workedMinutes,
  dayStatus, stats, noticedInTime,
};
