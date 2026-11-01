'use strict';

const { DateTime } = require('luxon');
const db = require('../db');
const time = require('../time');
const employees = require('./employees');

/**
 * NARX SO'ROVLARI (deklarant) — 31-okt-2026: sotuvchi mijozning yuki bo'yicha deklarantdan narx so'raydi,
 * deklarant narx beradi (yoki aniqlashtiruvchi savol qo'yadi).
 *
 * Holatlar: open (narx kutilmoqda) → asked (deklarant savol berdi, so'rovchi javobini kutmoqda) → open (javob keldi)
 * → priced (narx berildi) | cancelled. Holat o'tishi faqat `UPDATE … WHERE status IN (…) RETURNING id` bilan —
 * ikki marta bosilgan / eskirgan tugma `false` qaytaradi.
 * Barcha *_id ustunlar — employee id (tg_id emas). Hech narsa o'chirilmaydi (loyiha qoidasi).
 */

const OPEN = "('open','asked')";

/** So'rov + so'rovchi va deklarant ma'lumotlari */
const SELECT = `SELECT r.*, rq.full_name AS requester_name, rq.tg_id AS requester_tg,
    d.full_name AS declarant_name, d.tg_id AS declarant_tg, d.active AS declarant_active, d.is_declarant AS declarant_flag
  FROM price_requests r
  JOIN employees rq ON rq.id = r.requester_id
  JOIN employees d ON d.id = r.declarant_id`;

/** Ertaga — keyingi ISH kuni (dam olish kuniga tushmaydi); sana yyyy-MM-dd */
const nextWorkDate = (now) => {
  let d = time.addDays(now.toFormat('yyyy-MM-dd'), 1);
  for (let i = 0; i < 7 && !time.isWorkDay(d); i += 1) d = time.addDays(d, 1);
  return d;
};

/** Muddat kaliti → ISO (yoki null = muddatsiz). Noma'lum kalit → undefined */
const dueAtFor = (key, now = time.now()) => {
  switch (key) {
    case '1h': return now.plus({ minutes: 60 }).toISO();
    case '3h': return now.plus({ minutes: 180 }).toISO();
    case 'today': return time.stampAt(now.toFormat('yyyy-MM-dd'), employees.workEndOf(null));
    case 'tomorrow': return time.stampAt(nextWorkDate(now), employees.workEndOf(null));
    case 'none': return null;
    default: return undefined;
  }
};

const byId = (id) => db.one(`${SELECT} WHERE r.id = $1`, [Number(id)]);

const create = async ({ requesterId, declarantId, description, media = null, dueAt = null, parentId = null }) => {
  const rows = await db.query(
    `INSERT INTO price_requests (requester_id, declarant_id, description, media_type, media_file_id, due_at, status, created_at, parent_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8) RETURNING id`,
    [Number(requesterId), Number(declarantId), description,
      media ? media.type : null, media ? media.fileId : null, dueAt || null, time.stamp(), parentId ? Number(parentId) : null],
  );
  return byId(rows[0].id);
};

/** Deklarantning kutayotgan so'rovlari: muddatlisi birinchi, muddatsizlar oxirida */
const inbox = (declarantId) =>
  db.query(`${SELECT} WHERE r.declarant_id = $1 AND r.status IN ${OPEN}
    ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at, r.id`, [Number(declarantId)]);

/** So'rovchining ochiq so'rovlari — yangisi birinchi */
const mine = (requesterId) =>
  db.query(`${SELECT} WHERE r.requester_id = $1 AND r.status IN ${OPEN} ORDER BY r.id DESC`, [Number(requesterId)]);

/** Rahbar uchun: barcha ochiq so'rovlar (deklarant bo'yicha) */
const allOpen = () =>
  db.query(`${SELECT} WHERE r.status IN ${OPEN} ORDER BY d.full_name, r.id`);

const addMsg = (requestId, authorId, kind, { text = null, media = null } = {}) =>
  db.query(
    `INSERT INTO price_request_msgs (request_id, author_id, kind, text, media_type, media_file_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [Number(requestId), Number(authorId), kind, text || null, media ? media.type : null, media ? media.fileId : null, time.stamp()],
  );

/** Narx berish — faqat tayinlangan deklarant, open|asked → priced */
const setPrice = async (id, declarantId, price, note = null) => {
  const rows = await db.query(
    `UPDATE price_requests SET status = 'priced', price = $1, price_note = $2, priced_at = $3
     WHERE id = $4 AND declarant_id = $5 AND status IN ${OPEN} RETURNING id`,
    [price, note || null, time.stamp(), Number(id), Number(declarantId)],
  );
  return rows.length > 0;
};

/** Deklarant savol beradi: open|asked → asked */
const ask = async (id, declarantId, { text = null, media = null } = {}) => {
  const now = time.stamp();
  const rows = await db.query(
    `UPDATE price_requests SET status = 'asked', asked_at = $1, asked_nudged_at = NULL
     WHERE id = $2 AND declarant_id = $3 AND status IN ${OPEN} RETURNING id`,
    [now, Number(id), Number(declarantId)],
  );
  if (!rows.length) return false;
  await addMsg(id, declarantId, 'question', { text, media });
  return true;
};

/** So'rovchi javob beradi: asked → open (eslatma soati qaytadan boshlanadi) */
const answer = async (id, requesterId, { text = null, media = null } = {}) => {
  const rows = await db.query(
    `UPDATE price_requests SET status = 'open', last_reminded_at = $1
     WHERE id = $2 AND requester_id = $3 AND status = 'asked' RETURNING id`,
    [time.stamp(), Number(id), Number(requesterId)],
  );
  if (!rows.length) return false;
  await addMsg(id, requesterId, 'answer', { text, media });
  return true;
};

/** Bekor qilish (o'chirilmaydi): open|asked → cancelled */
const cancel = async (id, byEmployeeId) => {
  const rows = await db.query(
    `UPDATE price_requests SET status = 'cancelled', cancelled_at = $1, cancelled_by = $2
     WHERE id = $3 AND status IN ${OPEN} RETURNING id`,
    [time.stamp(), Number(byEmployeeId), Number(id)],
  );
  return rows.length > 0;
};

/** Savol-javoblar yozuvi */
const messages = (id) =>
  db.query(
    `SELECT m.*, e.full_name AS author_name FROM price_request_msgs m
     JOIN employees e ON e.id = m.author_id WHERE m.request_id = $1 ORDER BY m.id`,
    [Number(id)],
  );

/** Narx berilganlar tarixi (qidiruv — tavsif bo'yicha, katta-kichik harfsiz) */
const history = ({ q = null, limit = 10 } = {}) => {
  const where = q ? "AND LOWER(r.description) LIKE LOWER($1)" : '';
  return db.query(
    `${SELECT} WHERE r.status = 'priced' ${where} ORDER BY r.priced_at DESC, r.id DESC LIMIT ${Number(limit)}`,
    q ? [`%${q}%`] : [],
  );
};

/** Davr (yyyy-MM-dd, ikkala chegara kiradi) bo'yicha yaratilgan so'rovlar */
const forPeriod = (from, to) =>
  db.query(`${SELECT} WHERE substr(r.created_at, 1, 10) >= $1 AND substr(r.created_at, 1, 10) <= $2 ORDER BY r.id`, [from, to]);

/** Deklarantlar bo'yicha statistika: jami, narx berilgan, o'rtacha daqiqa, kechikkan, ochiq */
const stats = async (from, to, now = time.now()) => {
  const rows = await forPeriod(from, to);
  const nowIso = now.toISO();
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.declarant_id)) by.set(r.declarant_id, { declarantId: r.declarant_id, name: r.declarant_name, total: 0, priced: 0, late: 0, open: 0, mins: [] });
    const s = by.get(r.declarant_id);
    s.total += 1;
    if (r.status === 'priced') {
      s.priced += 1;
      s.mins.push(DateTime.fromISO(r.priced_at).diff(DateTime.fromISO(r.created_at), 'minutes').minutes);
      if (r.due_at && r.priced_at > r.due_at) s.late += 1;
    } else if (r.status === 'open' || r.status === 'asked') {
      s.open += 1;
      if (r.due_at && r.due_at <= nowIso) s.late += 1;
    }
  }
  return [...by.values()].map(({ mins, ...s }) => ({
    ...s,
    avgMinutes: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
  }));
};

/** So'rovchilar bo'yicha so'rovlar soni (davrda yaratilgan), ko'pidan kamiga */
const byRequester = async (from, to) => {
  const by = new Map();
  for (const r of await forPeriod(from, to)) {
    if (!by.has(r.requester_id)) by.set(r.requester_id, { requesterId: r.requester_id, name: r.requester_name, total: 0 });
    by.get(r.requester_id).total += 1;
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
};

// ---- Eslatma (cron) so'rovlari ----

/**
 * Narx kutilayotgan (open) so'rovlar: oxirgi eslatmadan `minutes` o'tgan, deklarant faol va bayroqli.
 * Qaytgan qator bo'yicha deklarant aniqlanadi — unga BARCHA ochiq so'rovlari bitta ro'yxatda yuboriladi (qarang: handlers/price.js nag).
 */
const dueForReminder = (nowIso, minutes) => {
  const cutoff = DateTime.fromISO(nowIso, { zone: time.TZ }).minus({ minutes: Number(minutes) }).toISO();
  return db.query(
    `${SELECT} WHERE r.status = 'open' AND d.active = 1 AND d.is_declarant = 1 AND COALESCE(r.last_reminded_at, r.created_at) <= $1
     ORDER BY r.declarant_id, r.id`,
    [cutoff],
  );
};

const markReminded = async (ids, nowIso) => {
  const list = (ids || []).map(Number);
  if (!list.length) return;
  await db.query(
    `UPDATE price_requests SET last_reminded_at = $1 WHERE id IN (${list.map((_, i) => `$${i + 2}`).join(',')})`,
    [nowIso, ...list],
  );
};

/** Muddati o'tgan, hali xabar berilmagan so'rovlar */
const overdue = (nowIso) =>
  db.query(
    `${SELECT} WHERE r.status IN ${OPEN} AND r.due_at IS NOT NULL AND r.due_at <= $1 AND r.overdue_notified_at IS NULL
     ORDER BY r.id`,
    [nowIso],
  );

const markOverdue = (id, nowIso) =>
  db.query('UPDATE price_requests SET overdue_notified_at = $1 WHERE id = $2', [nowIso, Number(id)]);

/** Deklarant savol bergan, so'rovchi `minutes` dan beri javob bermagan va hali turtilmagan so'rovlar */
const askedStale = (nowIso, minutes) => {
  const cutoff = DateTime.fromISO(nowIso, { zone: time.TZ }).minus({ minutes: Number(minutes) }).toISO();
  return db.query(
    `${SELECT} WHERE r.status = 'asked' AND r.asked_nudged_at IS NULL AND r.asked_at <= $1 ORDER BY r.id`,
    [cutoff],
  );
};

const markAskedNudged = (id, nowIso) =>
  db.query('UPDATE price_requests SET asked_nudged_at = $1 WHERE id = $2', [nowIso, Number(id)]);

const countInbox = (declarantId) =>
  db.count(`SELECT COUNT(*) AS c FROM price_requests WHERE declarant_id = $1 AND status IN ${OPEN}`, [Number(declarantId)]);

const countMine = (requesterId) =>
  db.count(`SELECT COUNT(*) AS c FROM price_requests WHERE requester_id = $1 AND status IN ${OPEN}`, [Number(requesterId)]);

module.exports = {
  dueAtFor, create, byId, inbox, mine, allOpen, setPrice, ask, answer, cancel, messages, history, forPeriod, stats,
  byRequester, dueForReminder, markReminded, overdue, markOverdue, askedStale, markAskedNudged, countInbox, countMine,
};
