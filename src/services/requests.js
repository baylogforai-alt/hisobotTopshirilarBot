'use strict';

const db = require('../db');
const time = require('../time');

/**
 * Ro'yxatda yo'q odam /start bosganda yaratiladi. Bitta tg_id uchun bitta pending so'rov —
 * direktorga faqat birinchi marta xabar boradi.
 */

const byId = (id) => db.one('SELECT * FROM join_requests WHERE id = $1', [Number(id)]);

const pendingOf = (tgId) => db.one("SELECT * FROM join_requests WHERE tg_id = $1 AND status = 'pending'", [Number(tgId)]);

const listPending = () => db.query("SELECT * FROM join_requests WHERE status = 'pending' ORDER BY created_at");

/** Yangi so'rov; allaqachon pending bo'lsa {created:false} */
const create = async ({ tgId, fullName, username }) => {
  const existing = await pendingOf(tgId);
  if (existing) return { request: existing, created: false };
  const rows = await db.query(
    `INSERT INTO join_requests (tg_id, full_name, username, status, created_at) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
    [Number(tgId), String(fullName || '').slice(0, 100) || `ID ${tgId}`, username || null, time.stamp()],
  );
  return { request: await byId(rows[0].id), created: true };
};

const decide = async (id, status, byTgId) => {
  await db.query('UPDATE join_requests SET status = $1, decided_at = $2, decided_by = $3 WHERE id = $4', [status, time.stamp(), Number(byTgId), Number(id)]);
  return byId(id);
};

/** Shu tg_id ning barcha pending so'rovlarini yopadi (hodim qo'shilganda) */
const closeFor = (tgId, status, byTgId) =>
  db.query("UPDATE join_requests SET status = $1, decided_at = $2, decided_by = $3 WHERE tg_id = $4 AND status = 'pending'", [
    status, time.stamp(), Number(byTgId), Number(tgId),
  ]);

module.exports = { byId, pendingOf, listPending, create, decide, closeFor };
