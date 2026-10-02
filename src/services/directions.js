'use strict';

const db = require('../db');
const time = require('../time');

/**
 * YO'NALISHLAR (Moliya, Ta'minot, Ishlab chiqarish, Ombor, Sotuv …) — kim nimaga mas'ul.
 * HR / direktor topshiriq yoki savol berganda avval yo'nalishni tanlaydi → mas'ul hodim(lar) → lichkasi + topshiriq.
 * Bitta hodim bir nechta yo'nalishga mas'ul bo'lishi mumkin (employee_directions).
 * Standart yo'nalishlar schema.js da bir marta qo'shiladi; direktor Panel → «🧭 Yo'nalishlar» da boshqaradi.
 */

const byId = (id) => db.one('SELECT * FROM directions WHERE id = $1', [Number(id)]);
const listActive = () => db.query('SELECT * FROM directions WHERE active = 1 ORDER BY id');

const create = async (name) => {
  const clean = String(name).trim().slice(0, 40);
  const existing = await db.one('SELECT * FROM directions WHERE lower(name) = lower($1)', [clean]);
  if (existing) {
    await db.query('UPDATE directions SET active = 1 WHERE id = $1', [existing.id]);
    return { direction: await byId(existing.id), created: false };
  }
  const rows = await db.query("INSERT INTO directions (name, icon, active, created_at) VALUES ($1, '🧭', 1, $2) RETURNING id", [clean, time.stamp()]);
  return { direction: await byId(rows[0].id), created: true };
};

const rename = (id, name) => db.query('UPDATE directions SET name = $1 WHERE id = $2', [String(name).trim().slice(0, 40), Number(id)]);
const deactivate = (id) => db.query('UPDATE directions SET active = 0 WHERE id = $1', [Number(id)]);

/** Yo'nalish mas'ullari (faol hodimlar) */
const membersOf = (dirId) =>
  db.query(
    `SELECT e.*, d.name AS department_name FROM employee_directions ed
     JOIN employees e ON e.id = ed.employee_id LEFT JOIN departments d ON d.id = e.department_id
     WHERE ed.direction_id = $1 AND e.active = 1 ORDER BY lower(e.full_name)`,
    [Number(dirId)],
  );

/** Hodimning yo'nalishlari */
const ofEmployee = (empId) =>
  db.query(
    `SELECT r.* FROM employee_directions ed JOIN directions r ON r.id = ed.direction_id
     WHERE ed.employee_id = $1 AND r.active = 1 ORDER BY r.id`,
    [Number(empId)],
  );

/** Qo'shish / olib tashlash. true — endi mas'ul */
const toggle = async (empId, dirId) => {
  const has = await db.one('SELECT 1 AS x FROM employee_directions WHERE employee_id = $1 AND direction_id = $2', [Number(empId), Number(dirId)]);
  if (has) {
    await db.query('DELETE FROM employee_directions WHERE employee_id = $1 AND direction_id = $2', [Number(empId), Number(dirId)]);
    return false;
  }
  await db.query('INSERT INTO employee_directions (employee_id, direction_id) VALUES ($1, $2) ON CONFLICT (employee_id, direction_id) DO NOTHING', [Number(empId), Number(dirId)]);
  return true;
};

const label = (r) => `${r.icon || '🧭'} ${r.name}`;

module.exports = { byId, listActive, create, rename, deactivate, membersOf, ofEmployee, toggle, label };
