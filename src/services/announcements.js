'use strict';

const db = require('../db');
const time = require('../time');
const ui = require('../ui');
const tg = require('../telegram');
const notify = require('./notify');
const activity = require('./activity');

/**
 * E'LONLAR — direktor / HR (hammaga) va bo'lim rahbari (o'z jamoasiga) bitta xabarni birdaniga yuboradi.
 *   target 'all'  — hamma faol hodim (rahbar uchun — o'z jamoasi), yuboruvchining o'zidan tashqari
 *   target 'some' — tanlangan 1, 2 … hodim
 * Har bir oluvchi yozuvi saqlanadi (yetkazildimi, qachon «👁 O'qidim» bosdi) — yuboruvchi kim o'qiganini ko'radi.
 * Yozuvlar o'chirilmaydi.
 */

const byId = (id) => db.one('SELECT * FROM announcements WHERE id = $1', [Number(id)]);

/** Oxirgi e'lonlar (createdBy berilsa — faqat uniki) */
const list = (limit = 10, createdBy = null) =>
  createdBy
    ? db.query('SELECT * FROM announcements WHERE created_by = $1 ORDER BY id DESC LIMIT $2', [Number(createdBy), Number(limit)])
    : db.query('SELECT * FROM announcements ORDER BY id DESC LIMIT $1', [Number(limit)]);

/** Oluvchilar (hodim ma'lumoti bilan): o'qiganlar avval, keyin o'qimaganlar */
const recipientsOf = (annId) =>
  db.query(
    `SELECT r.*, e.full_name, e.tg_id, e.position, e.active
       FROM announcement_recipients r JOIN employees e ON e.id = r.employee_id
      WHERE r.announcement_id = $1
      ORDER BY CASE WHEN r.read_at IS NULL THEN 1 ELSE 0 END, r.read_at, lower(e.full_name)`,
    [Number(annId)],
  );

const stats = async (annId) => {
  const rows = await recipientsOf(annId);
  return {
    total: rows.length,
    delivered: rows.filter((r) => Number(r.delivered) === 1).length,
    read: rows.filter((r) => r.read_at).length,
    rows,
  };
};

/** Hodim «👁 O'qidim» bosdi. Birinchi marta bo'lsa — yozuv, aks holda null */
const markRead = async (annId, employeeId) => {
  const rows = await db.query(
    'UPDATE announcement_recipients SET read_at = $1 WHERE announcement_id = $2 AND employee_id = $3 AND read_at IS NULL RETURNING id',
    [time.stamp(), Number(annId), Number(employeeId)],
  );
  return rows.length ? rows[0] : null;
};

/** O'qilmagan e'lonlar soni (hodim uchun) */
const unreadCountFor = (employeeId) =>
  db.count('SELECT COUNT(*) AS c FROM announcement_recipients WHERE employee_id = $1 AND delivered = 1 AND read_at IS NULL', [Number(employeeId)]);

const readKeyboard = (annId) => ui.inline([[ui.cb("👁 O'qidim", `an:r:${annId}`)]]);

/** E'lon matni (oluvchi ko'radigan ko'rinish) */
const bodyOf = (ann) =>
  `📢 <b>E'LON</b>${ann.sender_name ? ` — <i>${ui.esc(ann.sender_name)}</i>` : ''}\n` +
  `<i>${time.prettyDate(String(ann.created_at).slice(0, 10))} · ${time.clock(ann.created_at)}</i>` +
  (ann.text ? `\n\n${ui.esc(ann.text)}` : '');

/** Bitta odamga e'lonni yuboradi (matn yoki media + izoh) */
const deliver = (bot, chatId, ann, extra = {}) =>
  ann.file_id
    ? notify.sendProof(bot, chatId, { type: ann.media_type, fileId: ann.file_id }, bodyOf(ann), extra)
    : notify.toUser(bot, chatId, bodyOf(ann), extra);

/**
 * E'lon yaratadi va yuboradi.
 *   sender  — { tgId, name }
 *   targets — hodimlar ro'yxati
 *   content — { text, media: {type, fileId, fileName} | null }
 * Natija: { ann, delivered, failed: [hodimlar] }
 */
const send = async (bot, sender, targets, content, { target = 'all', toGroup = false } = {}) => {
  const media = content.media || null;
  const rows = await db.query(
    `INSERT INTO announcements (created_by, sender_name, target, text, media_type, file_id, file_name, recipients, delivered, to_group, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10) RETURNING id`,
    [Number(sender.tgId), sender.name || null, target, content.text || null, media ? media.type : null, media ? media.fileId : null,
      media ? media.fileName || null : null, targets.length, toGroup ? 1 : 0, time.stamp()],
  );
  const ann = await byId(rows[0].id);
  let delivered = 0;
  const failed = [];
  for (const e of targets) {
    const ok = await deliver(bot, e.tg_id, ann, readKeyboard(ann.id));
    await db.query(
      `INSERT INTO announcement_recipients (announcement_id, employee_id, delivered) VALUES ($1, $2, $3)
       ON CONFLICT (announcement_id, employee_id) DO UPDATE SET delivered = EXCLUDED.delivered`,
      [ann.id, Number(e.id), ok ? 1 : 0],
    );
    if (ok) delivered += 1; else failed.push(e);
    await tg.throttle();
  }
  if (toGroup) {
    const gid = await notify.getGroupId();
    if (gid) await deliver(bot, gid, ann);
  }
  await db.query('UPDATE announcements SET delivered = $1 WHERE id = $2', [delivered, ann.id]);
  if (sender.employee) activity.track(sender.employee, 'announce', { title: content.text || (media ? media.fileName || media.type : ''), detail: `${targets.length} kishiga` });
  return { ann: await byId(ann.id), delivered, failed };
};

/** O'qimaganlarga qayta yuborish (yetkazilmaganlarga ham). Yuborilganlar soni */
const resendUnread = async (bot, annId) => {
  const ann = await byId(annId);
  if (!ann) return 0;
  let n = 0;
  for (const r of await recipientsOf(annId)) {
    if (r.read_at || !Number(r.active)) continue;
    const ok = await deliver(bot, r.tg_id, ann, readKeyboard(ann.id));
    if (ok) {
      n += 1;
      if (!Number(r.delivered)) await db.query('UPDATE announcement_recipients SET delivered = 1 WHERE id = $1', [r.id]);
    }
    await tg.throttle();
  }
  const d = await db.count('SELECT COUNT(*) AS c FROM announcement_recipients WHERE announcement_id = $1 AND delivered = 1', [Number(annId)]);
  await db.query('UPDATE announcements SET delivered = $1 WHERE id = $2', [d, Number(annId)]);
  return n;
};

module.exports = { byId, list, recipientsOf, stats, markRead, unreadCountFor, readKeyboard, bodyOf, deliver, send, resendUnread };
