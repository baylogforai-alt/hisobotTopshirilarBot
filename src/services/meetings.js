'use strict';

const { DateTime } = require('luxon');
const db = require('../db');
const time = require('../time');

/**
 * «🗓 MAJLIS» — boshliq/direktor yoki HR yozadi: sana + soat + mavzu (matn yoki media), kimga.
 * Har bir qatnashchi javob beradi: ✅ yes (boraman) · ⏰ late (kech qolaman, sabab majburiy) · 🙋 no (kelmayman, sabab majburiy).
 * 30 daqiqa oldin eslatma (reminded_at — bir marta). Bekor qilish — cancelled_at; yozuvlar o'chirilmaydi.
 */

const REMIND_BEFORE_MIN = 30;
const ANSWERS = ['yes', 'late', 'no'];
const ANSWER_LABEL = { yes: '✅ Boraman', late: '⏰ Kech qolaman', no: '🙋 Kelmayman' };

/** 'yyyy-MM-dd' + 'HH:mm' → luxon DateTime (Toshkent) */
const startOf = (m) => DateTime.fromISO(`${m.meet_date}T${m.meet_time}`, { zone: time.TZ });
/** Boshlanishiga necha daqiqa qoldi (o'tgan bo'lsa manfiy) */
const minutesLeft = (m, now = time.now()) => Math.round(startOf(m).diff(now, 'minutes').minutes);

const create = async ({ senderTg, senderName, body = null, media = null, date, hhmm, target }) => {
  const draft = { meet_date: date, meet_time: hhmm };
  // eslatma vaqti allaqachon o'tgan bo'lsa (masalan 20 daqiqadan keyingi majlis) — eslatmasiz
  const reminded = minutesLeft(draft) <= REMIND_BEFORE_MIN ? time.stamp() : null;
  const rows = await db.query(
    `INSERT INTO meetings (sender_tg, sender_name, body, media_type, file_id, file_name, meet_date, meet_time, target, created_at, reminded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [Number(senderTg), senderName || null, body, media ? media.type : null, media ? media.fileId : null, media && media.fileName ? String(media.fileName).slice(0, 200) : null,
      date, hhmm, target || null, time.stamp(), reminded],
  );
  return byId(rows[0].id);
};

const byId = (id) => db.one('SELECT * FROM meetings WHERE id = $1', [Number(id)]);

const addMember = (meetingId, employeeId, delivered) =>
  db.query(
    `INSERT INTO meeting_members (meeting_id, employee_id, delivered) VALUES ($1, $2, $3)
     ON CONFLICT (meeting_id, employee_id) DO UPDATE SET delivered = EXCLUDED.delivered`,
    [Number(meetingId), Number(employeeId), delivered ? 1 : 0],
  );

const member = (meetingId, employeeId) =>
  db.one('SELECT * FROM meeting_members WHERE meeting_id = $1 AND employee_id = $2', [Number(meetingId), Number(employeeId)]);

/** Javob (yes / late / no) + sabab. Qatnashchi bo'lmasa null */
const answer = async (meetingId, employeeId, ans, { reason = null, proof = null } = {}) => {
  if (!ANSWERS.includes(ans)) return null;
  if (!(await member(meetingId, employeeId))) return null;
  await db.query(
    `UPDATE meeting_members SET answer = $1, reason = $2, proof_type = $3, proof_file_id = $4, answered_at = $5
     WHERE meeting_id = $6 AND employee_id = $7`,
    [ans, ans === 'yes' ? null : reason, proof ? proof.type : null, proof ? proof.fileId : null, time.stamp(), Number(meetingId), Number(employeeId)],
  );
  return member(meetingId, employeeId);
};

/** Qatnashchilar: ism, tg, yetkazildimi, javob, sabab */
const members = (meetingId) =>
  db.query(
    `SELECT mm.*, e.full_name, e.tg_id, e.username FROM meeting_members mm JOIN employees e ON e.id = mm.employee_id
     WHERE mm.meeting_id = $1 ORDER BY lower(e.full_name)`,
    [Number(meetingId)],
  );

const counts = async (meetingId) => {
  const list = await members(meetingId);
  const c = { total: list.length, yes: 0, late: 0, no: 0, none: 0, delivered: 0 };
  for (const r of list) {
    c[r.answer && ANSWERS.includes(r.answer) ? r.answer : 'none'] += 1;
    if (Number(r.delivered)) c.delivered += 1;
  }
  return c;
};

/** Oxirgi majlislar (senderTg berilsa — faqat uniki; yaqin kelayotganlari birinchi) + soni */
const list = async ({ limit = 15, senderTg = null } = {}) => {
  const lim = Math.min(50, Math.max(1, Number(limit) || 15));
  const rows = senderTg
    ? await db.query(`SELECT * FROM meetings WHERE sender_tg = $1 ORDER BY meet_date DESC, meet_time DESC, id DESC LIMIT ${lim}`, [Number(senderTg)])
    : await db.query(`SELECT * FROM meetings ORDER BY meet_date DESC, meet_time DESC, id DESC LIMIT ${lim}`);
  const out = [];
  for (const m of rows) out.push({ ...m, ...(await counts(m.id)) });
  return out;
};

/** Hodimning kelayotgan (bugun va keyin, bekor qilinmagan, hali tugamagan kun) majlislari — javobi bilan */
const upcomingFor = (employeeId) =>
  db.query(
    `SELECT m.*, mm.answer, mm.reason, mm.answered_at FROM meeting_members mm JOIN meetings m ON m.id = mm.meeting_id
     WHERE mm.employee_id = $1 AND m.cancelled_at IS NULL AND m.meet_date >= $2 ORDER BY m.meet_date, m.meet_time, m.id`,
    [Number(employeeId), time.today()],
  );

/** Eslatma vaqti kelgan majlislar (bugun/ertaga, 30 daqiqa yoki kamroq qoldi, hali boshlanmagan) */
const dueReminders = async (now = time.now()) => {
  const rows = await db.query(
    'SELECT * FROM meetings WHERE cancelled_at IS NULL AND reminded_at IS NULL AND meet_date >= $1 AND meet_date <= $2 ORDER BY meet_date, meet_time',
    [time.today(), time.addDays(time.today(), 1)],
  );
  return rows.filter((m) => { const left = minutesLeft(m, now); return left <= REMIND_BEFORE_MIN && left > 0; });
};
/** Bir marta — ikkinchi chaqiruv false */
const markReminded = async (id) => {
  const rows = await db.query('UPDATE meetings SET reminded_at = $1 WHERE id = $2 AND reminded_at IS NULL RETURNING id', [time.stamp(), Number(id)]);
  return rows.length > 0;
};

/** Bekor qilish — bir marta (ikkinchisi false) */
const cancel = async (id, byTg) => {
  const rows = await db.query('UPDATE meetings SET cancelled_at = $1, cancelled_by = $2 WHERE id = $3 AND cancelled_at IS NULL RETURNING id', [time.stamp(), Number(byTg), Number(id)]);
  return rows.length > 0;
};

/** Majlis kuni o'tib ketganmi (javob berib bo'lmaydi) */
const isOver = (m) => m.meet_date < time.today();

module.exports = {
  REMIND_BEFORE_MIN, ANSWERS, ANSWER_LABEL, minutesLeft, create, byId, addMember, member, answer, members, counts, list, upcomingFor,
  dueReminders, markReminded, cancel, isOver,
};
