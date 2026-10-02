'use strict';

const db = require('../db');
const config = require('../config');

/**
 * UMUMIY ISH BOSHLANISHI (hamma hodim uchun, alohida vaqt qo'yilmaganlarga).
 * Standart — WORK_START (.env, standart 08:50). Direktor botda o'zgartirsa settings.work_start ga yoziladi va ustun bo'ladi.
 * Hodimning alohida vaqti — employees.work_start (kartochkada «🕘 Ish boshlanishi»).
 * startMinutesOf sinxron ishlatiladi, shuning uchun qiymat xotirada keshlanadi: ishga tushganda load(), o'zgarganda set().
 */

const KEY = 'work_start';
let current = config.workStart;

const toMinutes = (hhmm) => {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60;
};

const load = async () => {
  const v = await db.getSetting(KEY);
  if (v && /^\d{2}:\d{2}$/.test(v)) current = v;
  return current;
};

/** 'HH:mm' */
const get = () => current;
const minutes = () => toMinutes(current);

/** Umumiy vaqtni o'zgartirish. resetIndividual — alohida vaqt qo'yilgan hodimlarni ham umumiyga o'tkazish */
const set = async (hhmm, { resetIndividual = false } = {}) => {
  await db.setSetting(KEY, hhmm);
  current = hhmm;
  if (resetIndividual) await db.query('UPDATE employees SET work_start = NULL WHERE work_start IS NOT NULL');
  return current;
};

const resetIndividual = () => db.query('UPDATE employees SET work_start = NULL WHERE work_start IS NOT NULL');

/** Alohida vaqti bor faol hodimlar soni */
const individualCount = () => db.count("SELECT COUNT(*) AS c FROM employees WHERE active = 1 AND work_start IS NOT NULL AND work_start <> ''");

module.exports = { load, get, minutes, set, resetIndividual, individualCount, toMinutes };
