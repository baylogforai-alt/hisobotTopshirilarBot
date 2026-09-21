'use strict';

const db = require('../db');
const time = require('../time');

/**
 * Bo'limlar va ularning KPI vaznlari.
 * Vaznlar yig'indisi 100 bo'lishi shart (setWeights tekshiradi).
 *   w_tasks      — topshiriqlarni muddatida bajarish %
 *   w_attendance — davomat %
 *   w_head       — bo'lim boshlig'i bahosi (1–10 → %)
 *   w_custom     — bo'limga xos mezon (custom_name, admin qo'lda % kiritadi)
 */

const DEFAULT_WEIGHTS = { w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 };

const byId = (id) => db.one('SELECT * FROM departments WHERE id = $1', [Number(id)]);

const byName = (name) => db.one('SELECT * FROM departments WHERE lower(name) = lower($1)', [String(name).trim()]);

const listActive = () => db.query('SELECT * FROM departments WHERE active = 1 ORDER BY lower(name)');

const listAll = () => db.query('SELECT * FROM departments ORDER BY active DESC, lower(name)');

const create = async (name) => {
  const clean = String(name).trim().slice(0, 60);
  const existing = await byName(clean);
  if (existing) {
    if (!existing.active) await db.query('UPDATE departments SET active = 1 WHERE id = $1', [existing.id]);
    return { department: await byId(existing.id), created: false };
  }
  const rows = await db.query(
    `INSERT INTO departments (name, w_tasks, w_attendance, w_head, w_custom, active, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING *`,
    [clean, DEFAULT_WEIGHTS.w_tasks, DEFAULT_WEIGHTS.w_attendance, DEFAULT_WEIGHTS.w_head, DEFAULT_WEIGHTS.w_custom, time.stamp()],
  );
  return { department: rows[0], created: true };
};

const rename = (id, name) => db.query('UPDATE departments SET name = $1 WHERE id = $2', [String(name).trim().slice(0, 60), Number(id)]);

/** Bo'limni yopish — hodimlar bo'limsiz qoladi (department_id NULL) */
const deactivate = async (id) => {
  await db.query('UPDATE employees SET department_id = NULL WHERE department_id = $1', [Number(id)]);
  await db.query('UPDATE departments SET active = 0 WHERE id = $1', [Number(id)]);
};

/**
 * "40 20 20 20" ko'rinishidagi matnni vaznlarga o'giradi. Yig'indi 100 bo'lmasa null.
 */
const parseWeights = (raw) => {
  const nums = String(raw || '')
    .replace(/%/g, ' ')
    .split(/[\s,/;]+/)
    .filter(Boolean)
    .map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 100)) return null;
  if (nums.reduce((a, b) => a + b, 0) !== 100) return null;
  return { w_tasks: nums[0], w_attendance: nums[1], w_head: nums[2], w_custom: nums[3] };
};

const setWeights = async (id, w) => {
  await db.query(
    'UPDATE departments SET w_tasks = $1, w_attendance = $2, w_head = $3, w_custom = $4 WHERE id = $5',
    [w.w_tasks, w.w_attendance, w.w_head, w.w_custom, Number(id)],
  );
  return byId(id);
};

const setCustomName = (id, name) =>
  db.query('UPDATE departments SET custom_name = $1 WHERE id = $2', [name ? String(name).trim().slice(0, 60) : null, Number(id)]);

/** Bo'lim vaznlari; bo'lim yo'q bo'lsa standart */
const weightsOf = (dept) => ({
  w_tasks: Number(dept ? dept.w_tasks : DEFAULT_WEIGHTS.w_tasks),
  w_attendance: Number(dept ? dept.w_attendance : DEFAULT_WEIGHTS.w_attendance),
  w_head: Number(dept ? dept.w_head : DEFAULT_WEIGHTS.w_head),
  w_custom: Number(dept ? dept.w_custom : DEFAULT_WEIGHTS.w_custom),
});

const weightsText = (dept) => {
  const w = weightsOf(dept);
  const custom = dept && dept.custom_name ? dept.custom_name : "Qo'shimcha mezon";
  return `Topshiriq ${w.w_tasks}% · Davomat ${w.w_attendance}% · Boshliq bahosi ${w.w_head}% · ${custom} ${w.w_custom}%`;
};

/** Bo'lim boshliqlari (role='head') */
const headsOf = (id) =>
  db.query("SELECT * FROM employees WHERE active = 1 AND role = 'head' AND department_id = $1 ORDER BY lower(full_name)", [Number(id)]);

/** Bo'limdagi faol hodimlar soni */
const memberCount = (id) => db.count('SELECT COUNT(*) AS c FROM employees WHERE active = 1 AND department_id = $1', [Number(id)]);

module.exports = {
  DEFAULT_WEIGHTS, byId, byName, listActive, listAll, create, rename, deactivate,
  parseWeights, setWeights, setCustomName, weightsOf, weightsText, headsOf, memberCount,
};
