'use strict';

const db = require('../db');
const config = require('../config');

/**
 * TOPSHIRIQ ESLATMALARI JADVALI.
 *   Umumiy: har N soatda (settings.remind_step, standart REMINDER_INTERVAL_HOURS) — ish boshlanish soatidan N soat keyin, ish oxirigacha.
 *   Bo'lim: departments.remind_times — boshliq qo'yadi (o'z vaqti yo'q a'zolarga).
 *   Hodimning o'zi: «🔔 Eslatmalar» da so'raydi → FAQAT BOSHLIQ tasdiqlaydi (HR emas), yoki boshliq o'zi qo'yadi →
 *   employees.remind_times ('10:00,14:00,17:30'). Tasdiq kutilayotgani — employees.remind_pending.
 *   Ustuvorlik: hodim → bo'lim → umumiy.
 */

const STEP_KEY = 'remind_step';
const MIN_MIN = 6 * 60;       // 06:00
const MAX_MIN = 21 * 60 + 55; // 21:55 (tick oralig'i)
const MAX_COUNT = 8;

const globalStep = async () => {
  const v = Number(await db.getSetting(STEP_KEY));
  return Number.isInteger(v) && v >= 1 && v <= 6 ? v : Math.max(1, Math.round(config.reminderIntervalHours) || 3);
};
const setGlobalStep = (n) => db.setSetting(STEP_KEY, String(n));

const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Ish boshlanishidan har `step` soatda (butun soatlarda), ish oxirigacha */
const intervalTimes = (startMin, step) => {
  const out = [];
  for (let h = Math.floor(startMin / 60) + step; h < config.workEndHour; h += step) out.push(fmt(h * 60));
  return out;
};

/** '10:00, 14:30 17' → ['10:00','14:30','17:00']; noto'g'ri bo'lsa null */
const parseTimes = (raw) => {
  const parts = String(raw || '').split(/[\s,;]+/).filter(Boolean);
  if (!parts.length || parts.length > MAX_COUNT) return null;
  const set = new Set();
  for (const p of parts) {
    const m = p.match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
    if (!m) return null;
    const min = Number(m[1]) * 60 + Number(m[2] || 0);
    if (Number(m[1]) > 23 || Number(m[2] || 0) > 59 || min < MIN_MIN || min > MAX_MIN) return null;
    set.add(fmt(min));
  }
  return [...set].sort();
};

const listOf = (s) => (s ? String(s).split(',').filter(Boolean) : []);

/** Qaysi jadval amalda: 'own' (hodim) · 'dept' (bo'lim) · 'global' (umumiy) */
const sourceOf = (emp) => (emp.remind_times ? 'own' : emp.dept_remind_times ? 'dept' : 'global');

/** Hodimning amaldagi eslatma vaqtlari: hodim → bo'lim → umumiy */
const timesFor = (emp, step, startMin) => {
  if (emp.remind_times) return listOf(emp.remind_times);
  if (emp.dept_remind_times) return listOf(emp.dept_remind_times);
  return intervalTimes(startMin, step);
};

/** Boshliq qo'yadi (times null — tozalash) */
const setOwn = (empId, times) =>
  db.query('UPDATE employees SET remind_times = $1, remind_pending = NULL WHERE id = $2', [times && times.length ? times.join(',') : null, Number(empId)]);
const setDept = (deptId, times) =>
  db.query('UPDATE departments SET remind_times = $1 WHERE id = $2', [times && times.length ? times.join(',') : null, Number(deptId)]);

const request = (empId, times) => db.query('UPDATE employees SET remind_pending = $1 WHERE id = $2', [times.join(','), Number(empId)]);
const approve = (empId) =>
  db.query('UPDATE employees SET remind_times = remind_pending, remind_pending = NULL WHERE id = $1 AND remind_pending IS NOT NULL', [Number(empId)]);
const reject = (empId) => db.query('UPDATE employees SET remind_pending = NULL WHERE id = $1', [Number(empId)]);
const reset = (empId) => db.query('UPDATE employees SET remind_times = NULL, remind_pending = NULL WHERE id = $1', [Number(empId)]);

module.exports = { globalStep, setGlobalStep, intervalTimes, parseTimes, listOf, sourceOf, timesFor, setOwn, setDept, request, approve, reject, reset, toMin, fmt };
