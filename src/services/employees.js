'use strict';

const db = require('../db');
const config = require('../config');
const time = require('../time');

const byTgId = (tgId) =>
  db.one('SELECT * FROM employees WHERE tg_id = $1', [Number(tgId)]);

const byId = (id) => db.one('SELECT * FROM employees WHERE id = $1', [id]);

const listActive = () =>
  db.query('SELECT * FROM employees WHERE active = 1 ORDER BY lower(full_name)');

const listAll = () =>
  db.query('SELECT * FROM employees ORDER BY active DESC, lower(full_name)');

/** Bazadagi admin rolli faol hodimlar (xabarlarni shu yerga yuborish uchun) */
const listAdmins = () =>
  db.query("SELECT * FROM employees WHERE active = 1 AND role = 'admin' ORDER BY lower(full_name)");

const add = async ({ tgId, fullName, position = null, role = 'employee' }) => {
  const existing = await byTgId(tgId);
  if (existing) {
    await db.query('UPDATE employees SET full_name = $1, position = $2, active = 1 WHERE id = $3', [
      fullName,
      position,
      existing.id,
    ]);
    return { employee: await byId(existing.id), created: false };
  }
  const rows = await db.query(
    `INSERT INTO employees (tg_id, full_name, position, role, active, created_at)
     VALUES ($1, $2, $3, $4, 1, $5) RETURNING *`,
    [Number(tgId), fullName, position, role, time.stamp()],
  );
  return { employee: rows[0], created: true };
};

const deactivate = (tgId) =>
  db.query('UPDATE employees SET active = 0 WHERE tg_id = $1', [Number(tgId)]);

const activate = (tgId) =>
  db.query('UPDATE employees SET active = 1 WHERE tg_id = $1', [Number(tgId)]);

const setRole = (tgId, role) =>
  db.query('UPDATE employees SET role = $1 WHERE tg_id = $2', [role, Number(tgId)]);

const touchUsername = async (tgId, username) => {
  if (!username) return;
  await db.query(
    "UPDATE employees SET username = $1 WHERE tg_id = $2 AND COALESCE(username, '') <> $3",
    [username, Number(tgId), username],
  );
};

/** .env dagi ADMIN_IDS yoki bazadagi role='admin' */
const isAdmin = async (tgId) => {
  if (config.adminIds.includes(Number(tgId))) return true;
  const e = await byTgId(tgId);
  return Boolean(e && e.active && e.role === 'admin');
};

const mention = (employee) => (employee.username ? `@${employee.username}` : employee.full_name);

module.exports = {
  byTgId, byId, listActive, listAll, listAdmins, add, deactivate, activate,
  setRole, touchUsername, isAdmin, mention,
};
