'use strict';

const db = require('../db');
const time = require('../time');
const office = require('./office');

/**
 * FILIALLAR (Toshkent, Andijon …). Har birining o'z ofis nuqtasi va radiusi bor.
 * Hodim filialga biriktirilmagan yoki filialning nuqtasi belgilanmagan bo'lsa — umumiy ofis (/ofis) ishlatiladi.
 */

const byId = (id) => db.one('SELECT * FROM branches WHERE id = $1', [Number(id)]);
const byName = (name) => db.one('SELECT * FROM branches WHERE lower(name) = lower($1)', [String(name).trim()]);
const listActive = () => db.query('SELECT * FROM branches WHERE active = 1 ORDER BY lower(name)');

const create = async (name) => {
  const clean = String(name).trim().slice(0, 60);
  const existing = await byName(clean);
  if (existing) {
    if (!Number(existing.active)) await db.query('UPDATE branches SET active = 1 WHERE id = $1', [existing.id]);
    return { branch: await byId(existing.id), created: false };
  }
  const rows = await db.query('INSERT INTO branches (name, active, created_at) VALUES ($1, 1, $2) RETURNING id', [clean, time.stamp()]);
  return { branch: await byId(rows[0].id), created: true };
};

const rename = (id, name) => db.query('UPDATE branches SET name = $1 WHERE id = $2', [String(name).trim().slice(0, 60), Number(id)]);

const setOffice = (id, lat, lon, radius) =>
  db.query('UPDATE branches SET office_lat = $1, office_lon = $2, radius_m = $3 WHERE id = $4', [String(lat), String(lon), Math.round(Number(radius)), Number(id)]);

const setRadius = (id, radius) => db.query('UPDATE branches SET radius_m = $1 WHERE id = $2', [Math.round(Number(radius)), Number(id)]);

const deactivate = async (id) => {
  await db.query('UPDATE employees SET branch_id = NULL WHERE branch_id = $1', [Number(id)]);
  await db.query('UPDATE branches SET active = 0 WHERE id = $1', [Number(id)]);
};

const memberCount = (id) => db.count('SELECT COUNT(*) AS c FROM employees WHERE active = 1 AND branch_id = $1', [Number(id)]);

/** Filial ofisi {lat, lon, radius, name} yoki null */
const officeOfBranch = (b) =>
  b && b.office_lat && b.office_lon
    ? { lat: Number(b.office_lat), lon: Number(b.office_lon), radius: Number(b.radius_m) || office.DEFAULT_RADIUS, name: b.name }
    : null;

/** Hodim qaysi ofisga keladi: filial ofisi → bo'lmasa umumiy ofis */
const officeFor = async (emp) => {
  if (emp && emp.branch_id) {
    const own = officeOfBranch(await byId(emp.branch_id));
    if (own) return own;
  }
  const main = await office.get();
  return main ? { ...main, name: 'Asosiy ofis' } : null;
};

module.exports = { byId, byName, listActive, create, rename, setOffice, setRadius, deactivate, memberCount, officeOfBranch, officeFor };
