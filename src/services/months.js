'use strict';

const db = require('../db');
const config = require('../config');
const time = require('../time');

/**
 * ISH OYI BOSHLANISHI. Har oyning 1-kuni 9:00 da hammaga "yangi oy boshlandi" xabari boradi;
 * hodim «✅ Tanishdim, boshladim» bosgan paytdan oy hisobi (sekundomer) boshlanadi.
 * MONTH_START_REQUIRED=true bo'lsa tasdiqlamaguncha «Keldim» yopiq.
 */

const get = (employeeId, month = time.month()) =>
  db.one('SELECT * FROM month_starts WHERE employee_id = $1 AND month = $2', [Number(employeeId), month]);

const isConfirmed = async (employeeId, month = time.month()) => Boolean(await get(employeeId, month));

/** Keldim uchun: talab o'chirilgan bo'lsa har doim true */
const canWork = async (employeeId) => !config.monthStartRequired || isConfirmed(employeeId);

const confirm = async (employeeId, month = time.month()) => {
  const existing = await get(employeeId, month);
  if (existing) return { row: existing, created: false };
  await db.query(
    `INSERT INTO month_starts (employee_id, month, confirmed_at) VALUES ($1, $2, $3)
     ON CONFLICT (employee_id, month) DO NOTHING`,
    [Number(employeeId), month, time.stamp()],
  );
  return { row: await get(employeeId, month), created: true };
};

/** Oy bo'yicha: kim tasdiqladi, kim yo'q (faol hodimlar) */
const statusOf = async (month = time.month()) => {
  const rows = await db.query(
    `SELECT e.id, e.full_name, e.tg_id, e.department_id, m.confirmed_at FROM employees e
     LEFT JOIN month_starts m ON m.employee_id = e.id AND m.month = $1
     WHERE e.active = 1 AND e.role <> 'admin' ORDER BY lower(e.full_name)`,
    [month],
  );
  return { confirmed: rows.filter((r) => r.confirmed_at), waiting: rows.filter((r) => !r.confirmed_at) };
};

/** "12 kun 4 soat 10 daqiqa" — tasdiqlangandan beri */
const elapsedText = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return [d ? `${d} kun` : '', h ? `${h} soat` : '', `${m} daqiqa`].filter(Boolean).join(' ');
};

module.exports = { get, isConfirmed, canWork, confirm, statusOf, elapsedText };
