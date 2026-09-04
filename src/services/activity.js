'use strict';

const db = require('../db');
const time = require('../time');

/**
 * Hodimlarning botdagi HAR BIR harakati shu yerga yoziladi.
 * Maqsad — direktor keyinchalik "falon kuni kim nima qildi" degan savolga
 * to'liq javob ola olishi. Yozuv hech qachon asosiy oqimni to'xtatmaydi:
 * xato bo'lsa faqat konsolga chiqadi.
 */

/** Harakat turlari — belgi, nomi va hisobotda ko'rinishi */
const ACTIONS = {
  start:          { icon: '🚀', label: 'Botni ochdi',            major: true },
  checkin:        { icon: '🟢', label: 'Ishga keldi',            major: true },
  checkin_far:    { icon: '⛔️', label: 'Uzoqdan urinish',        major: true },
  checkin_repeat: { icon: 'ℹ️', label: 'Qayta kelish urinishi',  major: false },
  checkout:       { icon: '🏁', label: 'Ishdan ketdi',           major: true },
  intent_yes:     { icon: '🙋', label: 'Kelaman dedi',           major: true },
  intent_no:      { icon: '🙅', label: 'Kelmayman dedi',         major: true },
  mission_add:    { icon: '📝', label: "Missiya yozib qo'ydi",   major: true },
  mission_today:  { icon: '📌', label: "Bugungi topshiriq qo'shdi", major: true },
  mission_done:   { icon: '✅', label: 'Missiyani bajardi',      major: true },
  mission_cancel: { icon: '🗑', label: "Missiyani o'chirdi",     major: true },
  assigned:       { icon: '📥', label: 'Topshiriq oldi',         major: true },
  note:           { icon: '💬', label: 'Matn yozdi',             major: true },
  my_missions:    { icon: '📋', label: "Missiyalarini ko'rdi",   major: false },
  my_report:      { icon: '📊', label: "Hisobotini ko'rdi",      major: false },
  excel:          { icon: '📥', label: 'Excel yuklab oldi',      major: false },
  help:           { icon: '📖', label: "Qo'llanmani ochdi",      major: false },
  menu:           { icon: '🏠', label: 'Menyuga qaytdi',         major: false },
  use:            { icon: '👆', label: 'Botdan foydalandi',      major: false },
  admin:          { icon: '⚙️', label: 'Admin amali',            major: false },
};

const meta = (action) => ACTIONS[action] || { icon: '•', label: action, major: false };

const cut = (s, n) => {
  const v = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/**
 * Bitta harakatni yozadi.
 * emp — hodim qatori (yoki null), tgId — Telegram ID (hodim topilmasa ham yoziladi).
 */
const log = async (emp, action, { title = null, detail = null, tgId = null, date = null } = {}) => {
  try {
    await db.query(
      `INSERT INTO activity_log (employee_id, tg_id, work_date, action, title, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        emp ? emp.id : null,
        Number(tgId || (emp && emp.tg_id) || 0) || null,
        date || time.today(),
        action,
        title ? cut(title, 300) : null,
        detail ? cut(detail, 500) : null,
        time.stamp(),
      ],
    );
  } catch (err) {
    console.error('[activity] yozib bolmadi:', err.message);
  }
};

/** Xatoni yutadigan "otib ket" varianti — handler ichida await qilish shart emas */
const track = (emp, action, opts) => {
  log(emp, action, opts).catch(() => {});
};

/** Bir kunlik harakatlar (vaqt bo'yicha) */
const forDay = (employeeId, date) =>
  db.query(
    `SELECT * FROM activity_log WHERE employee_id = $1 AND work_date = $2
     ORDER BY created_at ASC, id ASC`,
    [employeeId, date],
  );

/** Davr bo'yicha harakatlar */
const forRange = (employeeId, from, to) =>
  db.query(
    `SELECT * FROM activity_log WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
     ORDER BY created_at ASC, id ASC`,
    [employeeId, from, to],
  );

/** Kunlar bo'yicha harakatlar soni — faollik o'lchovi */
const countsByDay = async (employeeId, from, to) => {
  const rows = await db.query(
    `SELECT work_date, COUNT(*) AS c FROM activity_log
     WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
     GROUP BY work_date`,
    [employeeId, from, to],
  );
  const map = new Map();
  rows.forEach((r) => map.set(r.work_date, Number(r.c)));
  return map;
};

/** Hodim eng oxirgi marta qachon botdan foydalangan */
const lastSeen = (employeeId) =>
  db.one(
    'SELECT * FROM activity_log WHERE employee_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [employeeId],
  );

/** Davr bo'yicha harakat turlarining soni */
const summary = async (employeeId, from, to) => {
  const rows = await db.query(
    `SELECT action, COUNT(*) AS c FROM activity_log
     WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
     GROUP BY action ORDER BY COUNT(*) DESC`,
    [employeeId, from, to],
  );
  return rows.map((r) => ({ action: r.action, count: Number(r.c), ...meta(r.action) }));
};

/**
 * Handler ichidan chaqiriladigan qulay yozuvchi.
 * ctx.state.logged ni belgilaydi — shunda umumiy "botdan foydalandi"
 * kuzatuvchisi bu harakatni ikkinchi marta yozmaydi.
 */
const mark = (ctx, action, opts = {}) => {
  if (ctx && ctx.state) ctx.state.logged = true;
  const emp = ctx && ctx.state ? ctx.state.employee : null;
  track(emp, action, { tgId: ctx && ctx.from ? ctx.from.id : null, ...opts });
};

module.exports = {
  ACTIONS, meta, log, track, mark, forDay, forRange, countsByDay, lastSeen, summary,
};
