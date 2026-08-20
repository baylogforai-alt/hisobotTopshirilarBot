'use strict';

const db = require('../db');
const time = require('../time');

const get = (employeeId, date = time.today()) =>
  db.one('SELECT * FROM attendance WHERE employee_id = $1 AND work_date = $2', [employeeId, date]);

/**
 * Ishga kelishni qayd etadi. location = { lat, lon, dist } (ixtiyoriy).
 * dist — ofisdan masofa (metr), geofence yoqilgan bo'lsa.
 */
const checkIn = async (employeeId, location = null, date = time.today()) => {
  const existing = await get(employeeId, date);
  if (existing && existing.checked_in) return { already: true, row: existing };
  const lat = location ? String(location.lat) : null;
  const lon = location ? String(location.lon) : null;
  const dist = location && location.dist != null ? String(location.dist) : null;
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, checked_in, checkin_lat, checkin_lon, checkin_dist)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       checked_in = EXCLUDED.checked_in,
       checkin_lat = EXCLUDED.checkin_lat,
       checkin_lon = EXCLUDED.checkin_lon,
       checkin_dist = EXCLUDED.checkin_dist`,
    [employeeId, date, time.stamp(), lat, lon, dist],
  );
  return { already: false, row: await get(employeeId, date) };
};

const checkOut = async (employeeId, date = time.today()) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, checked_out) VALUES ($1, $2, $3)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET checked_out = EXCLUDED.checked_out`,
    [employeeId, date, time.stamp()],
  );
  return get(employeeId, date);
};

const isCheckedIn = async (employeeId, date = time.today()) => {
  const row = await get(employeeId, date);
  return Boolean(row && row.checked_in);
};

const isCheckedOut = async (employeeId, date = time.today()) => {
  const row = await get(employeeId, date);
  return Boolean(row && row.checked_out);
};

/** Bugun ishga kelgan (va hali ketmagan) hodimlar */
const workingNow = (date = time.today()) =>
  db.query(
    `SELECT e.* FROM employees e
     JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
     WHERE e.active = 1 AND a.checked_in IS NOT NULL AND a.checked_out IS NULL
     ORDER BY lower(e.full_name)`,
    [date],
  );

/** Bugun umuman kelmagan hodimlar */
const absent = (date = time.today()) =>
  db.query(
    `SELECT e.* FROM employees e
     WHERE e.active = 1 AND e.id NOT IN (
       SELECT employee_id FROM attendance WHERE work_date = $1 AND checked_in IS NOT NULL
     )
     ORDER BY lower(e.full_name)`,
    [date],
  );

/** "Ishga kelyapsizmi?" so'roviga javob (ha/yo'q) saqlash */
const setIntent = async (employeeId, intent, date = time.today()) => {
  await db.query(
    `INSERT INTO attendance (employee_id, work_date, intent, intent_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET intent = EXCLUDED.intent, intent_at = EXCLUDED.intent_at`,
    [employeeId, date, intent, time.stamp()],
  );
  return get(employeeId, date);
};

module.exports = {
  get, checkIn, checkOut, isCheckedIn, isCheckedOut, workingNow, absent, setIntent,
};
