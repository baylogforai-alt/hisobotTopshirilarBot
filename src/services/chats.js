'use strict';

const db = require('../db');
const time = require('../time');

/**
 * «💬 SAVOL-JAVOB» CHATLARI — bitta hodim bilan, bir nechta hodim, bo'lim(lar) yoki hammasi bilan.
 *   mode 'all'     — har bir xabar hamma ishtirokchiga boradi (guruh chat)
 *   mode 'starter' — ishtirokchilar javobi faqat boshlovchiga; boshlovchi hammaga yoki bitta odamga yozadi
 * Xabarlar bazada qoladi (o'chirilmaydi). to_tg — bitta odamga yozilgan bo'lsa, NULL — hammaga.
 */

const create = async ({ starterTg, starterName, title, target, mode = 'all' }) => {
  const rows = await db.query(
    `INSERT INTO chats (starter_tg, starter_name, title, target, mode, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [Number(starterTg), starterName || null, title || null, target || null, mode === 'starter' ? 'starter' : 'all', time.stamp()],
  );
  return byId(rows[0].id);
};

const byId = (id) => db.one('SELECT * FROM chats WHERE id = $1', [Number(id)]);

const addMember = (chatId, emp, delivered = false) =>
  db.query(
    `INSERT INTO chat_members (chat_id, tg_id, employee_id, name, delivered) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chat_id, tg_id) DO UPDATE SET delivered = EXCLUDED.delivered`,
    [Number(chatId), Number(emp.tg_id), emp.id ? Number(emp.id) : null, emp.full_name || null, delivered ? 1 : 0],
  );

/** Ishtirokchilar (boshlovchidan tashqari) — ism, username (lichka havolasi uchun) */
const members = (chatId) =>
  db.query(
    `SELECT m.*, e.username, e.position, e.is_hr, e.role FROM chat_members m LEFT JOIN employees e ON e.id = m.employee_id
     WHERE m.chat_id = $1 ORDER BY lower(m.name)`,
    [Number(chatId)],
  );

const isStarter = (chat, tgId) => Number(chat.starter_tg) === Number(tgId);

const isParticipant = async (chat, tgId) => {
  if (!chat) return false;
  if (isStarter(chat, tgId)) return true;
  return Boolean(await db.one('SELECT id FROM chat_members WHERE chat_id = $1 AND tg_id = $2', [Number(chat.id), Number(tgId)]));
};

const addMessage = async ({ chatId, fromTg, fromName, toTg = null, body = null, media = null }) => {
  const rows = await db.query(
    `INSERT INTO chat_messages (chat_id, from_tg, from_name, to_tg, body, media_type, file_id, file_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [Number(chatId), Number(fromTg), fromName || null, toTg ? Number(toTg) : null, body, media ? media.type : null, media ? media.fileId : null, media && media.fileName ? media.fileName : null, time.stamp()],
  );
  return messageById(rows[0].id);
};

const messageById = (id) => db.one('SELECT * FROM chat_messages WHERE id = $1', [Number(id)]);

/**
 * Shu odamga ko'rinadigan xabarlar (oxirgi `limit` ta, eskidan yangiga).
 * 'starter' rejimida oddiy ishtirokchi faqat o'zinikini, o'ziga yozilganini va boshlovchining umumiy xabarlarini ko'radi.
 */
const messagesFor = async (chat, tgId, limit = 15) => {
  const lim = Math.min(50, Math.max(1, Number(limit) || 15));
  const rows = chat.mode === 'all' || isStarter(chat, tgId)
    ? await db.query(`SELECT * FROM chat_messages WHERE chat_id = $1 ORDER BY id DESC LIMIT ${lim}`, [Number(chat.id)])
    : await db.query(
      `SELECT * FROM chat_messages WHERE chat_id = $1 AND (from_tg = $2 OR to_tg = $2 OR (to_tg IS NULL AND from_tg = $3))
       ORDER BY id DESC LIMIT ${lim}`,
      [Number(chat.id), Number(tgId), Number(chat.starter_tg)],
    );
  return rows.reverse();
};

/** Shu odam ishtirok etgan chatlar — oxirgi yozishma bo'yicha */
const listFor = (tgId, limit = 15) => {
  const lim = Math.min(50, Math.max(1, Number(limit) || 15));
  return db.query(
    `SELECT c.*, (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) AS members_count,
            COALESCE((SELECT MAX(x.id) FROM chat_messages x WHERE x.chat_id = c.id), 0) AS last_msg
     FROM chats c
     WHERE c.starter_tg = $1 OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.tg_id = $1)
     ORDER BY last_msg DESC, c.id DESC LIMIT ${lim}`,
    [Number(tgId)],
  );
};

module.exports = { create, byId, addMember, members, isStarter, isParticipant, addMessage, messageById, messagesFor, listFor };
