'use strict';

const db = require('../db');
const config = require('../config');
const time = require('../time');

/**
 * Rollar:
 *   admin    — direktor / HR: hamma narsani ko'radi, hodim qo'shadi, KPI tasdiqlaydi
 *   head     — bo'lim boshlig'i: o'z bo'limiga topshiriq beradi, tekshiradi, baholaydi
 *   employee — hodim
 * .env dagi ADMIN_IDS bazada bo'lmasa ham admin hisoblanadi.
 */
const ROLES = { admin: 'Direktor / HR', head: "Bo'lim boshlig'i", employee: 'Hodim' };

const SELECT = `SELECT e.*, d.name AS department_name
                FROM employees e LEFT JOIN departments d ON d.id = e.department_id`;

const byTgId = (tgId) => db.one(`${SELECT} WHERE e.tg_id = $1`, [Number(tgId)]);
const byId = (id) => db.one(`${SELECT} WHERE e.id = $1`, [Number(id)]);

const listActive = () => db.query(`${SELECT} WHERE e.active = 1 ORDER BY lower(d.name), lower(e.full_name)`);
const listAll = () => db.query(`${SELECT} ORDER BY e.active DESC, lower(d.name), lower(e.full_name)`);

/** Bo'limdagi faol hodimlar (boshliqning o'zi ham kiradi) */
const listByDepartment = (deptId) =>
  db.query(`${SELECT} WHERE e.active = 1 AND e.department_id = $1 ORDER BY lower(e.full_name)`, [Number(deptId)]);

/** Bo'limsiz faol hodimlar */
const listWithoutDepartment = () =>
  db.query(`${SELECT} WHERE e.active = 1 AND e.department_id IS NULL ORDER BY lower(e.full_name)`);

const listAdmins = () => db.query(`${SELECT} WHERE e.active = 1 AND e.role = 'admin' ORDER BY lower(e.full_name)`);

const listHeads = () => db.query(`${SELECT} WHERE e.active = 1 AND e.role = 'head' ORDER BY lower(e.full_name)`);

const add = async ({ tgId, fullName, position = null, role = 'employee', departmentId = null, username = null }) => {
  const existing = await byTgId(tgId);
  if (existing) {
    await db.query(
      'UPDATE employees SET full_name = $1, position = $2, role = $3, department_id = $4, active = 1 WHERE id = $5',
      [fullName, position, role, departmentId, existing.id],
    );
    return { employee: await byId(existing.id), created: false };
  }
  const rows = await db.query(
    `INSERT INTO employees (tg_id, full_name, position, username, role, department_id, active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7) RETURNING id`,
    [Number(tgId), fullName, position, username, role, departmentId, time.stamp()],
  );
  return { employee: await byId(rows[0].id), created: true };
};

/**
 * Ro'yxatdagi (hodimlar.js) BAZADA YO'Q hodimlarni qo'shadi; mavjudlariga tegmaydi.
 * Bot ishga tushganda chaqiriladi — yangi hodim kodga yozilsa, deploy bilan bazaga tushadi.
 */
const ensureMany = async (list) => {
  const added = [];
  for (const h of list) {
    if (await byTgId(h.tgId)) continue;
    const { employee } = await add(h);
    added.push(employee);
  }
  return added;
};

const deactivate = (id) => db.query('UPDATE employees SET active = 0 WHERE id = $1', [Number(id)]);
const activate = (id) => db.query('UPDATE employees SET active = 1 WHERE id = $1', [Number(id)]);
const setRole = (id, role) => db.query('UPDATE employees SET role = $1 WHERE id = $2', [role, Number(id)]);
const setPosition = (id, position) => db.query('UPDATE employees SET position = $1 WHERE id = $2', [position || null, Number(id)]);
const rename = (id, fullName) => db.query('UPDATE employees SET full_name = $1 WHERE id = $2', [fullName, Number(id)]);
const setDepartment = (id, deptId) =>
  db.query('UPDATE employees SET department_id = $1 WHERE id = $2', [deptId ? Number(deptId) : null, Number(id)]);
const setBonusFund = (id, amount) =>
  db.query('UPDATE employees SET bonus_fund = $1 WHERE id = $2', [amount === null ? null : Math.round(Number(amount)), Number(id)]);
/** Alohida ish boshlanish vaqti 'HH:mm' (null = umumiy WORK_START_HOUR) */
const setWorkStart = (id, hhmm) => db.query('UPDATE employees SET work_start = $1 WHERE id = $2', [hhmm || null, Number(id)]);

/** '10:00' / '9.30' / '8' → 'HH:mm'; tushunilmasa null */
const parseWorkStart = (raw) => {
  const m = String(raw || '').trim().match(/^(\d{1,2})(?:[:.\s](\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (h > 23 || mm > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/** Hodimning ish boshlanishi — kun boshidan daqiqalarda */
const startMinutesOf = (emp) => {
  const m = emp && emp.work_start ? String(emp.work_start).match(/^(\d{2}):(\d{2})$/) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : config.workStartHour * 60;
};

/** Erkin jadval — kechikish va geofence'dan ozod */
const setFlexible = (id, flexible) => db.query('UPDATE employees SET flexible = $1 WHERE id = $2', [flexible ? 1 : 0, Number(id)]);

const isFlexible = (emp) => Boolean(emp && Number(emp.flexible) === 1);

const touchUsername = async (tgId, username) => {
  if (!username) return;
  await db.query("UPDATE employees SET username = $1 WHERE tg_id = $2 AND COALESCE(username, '') <> $3", [
    username, Number(tgId), username,
  ]);
};

/** .env dagi ADMIN_IDS yoki bazadagi role='admin' */
const isAdminId = (tgId) => config.adminIds.includes(Number(tgId));
const isAdmin = (emp, tgId) => isAdminId(tgId) || Boolean(emp && emp.active && emp.role === 'admin');
const isHead = (emp) => Boolean(emp && emp.active && emp.role === 'head');

/**
 * Kim kimni boshqara oladi:
 *   admin → hamma;  head → o'z bo'limi (o'zidan tashqari);  employee → faqat o'zi
 */
const canManage = (actor, isActorAdmin, target) => {
  if (isActorAdmin) return true;
  if (!actor || !target) return false;
  if (Number(actor.id) === Number(target.id)) return true;
  return isHead(actor) && actor.department_id && Number(actor.department_id) === Number(target.department_id);
};

/**
 * Hodimning "tekshiruvchisi" — topshiriqni kim qabul qiladi / sababli kunni kim tasdiqlaydi.
 * Bo'lim boshliqlari (o'zidan tashqari); bo'lmasa adminlar.
 */
const reviewersOf = async (emp) => {
  let list = [];
  if (emp.department_id) {
    list = (await db.query(
      `${SELECT} WHERE e.active = 1 AND e.role = 'head' AND e.department_id = $1 AND e.id <> $2`,
      [Number(emp.department_id), Number(emp.id)],
    ));
  }
  if (!list.length) list = (await listAdmins()).filter((a) => Number(a.id) !== Number(emp.id));
  const ids = new Set(list.map((e) => Number(e.tg_id)));
  for (const id of config.adminIds) if (Number(id) !== Number(emp.tg_id)) ids.add(Number(id));
  return [...ids];
};

const roleLabel = (role) => ROLES[role] || ROLES.employee;
const mention = (e) => (e.username ? `@${e.username}` : e.full_name);

module.exports = {
  ROLES, byTgId, byId, listActive, listAll, listByDepartment, listWithoutDepartment, listAdmins, listHeads,
  add, ensureMany, deactivate, activate, setRole, setPosition, rename, setDepartment, setBonusFund, setWorkStart, parseWorkStart, startMinutesOf, setFlexible, isFlexible,
  touchUsername, isAdminId, isAdmin, isHead, canManage, reviewersOf, roleLabel, mention,
};
