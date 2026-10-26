'use strict';

const db = require('../db');
const time = require('../time');

/**
 * «📆 DAVRIY ESLATMA» — boshliq/direktor yoki HR yozadi: har oy (kun + soat) yoki har hafta (kun(lar) + soat).
 *   kind: 'remind' — e'lon bo'lib boradi («👀 Tanishdim»); 'task' — har safar yangi topshiriq (muddat = yuborilgan kun + due_offset).
 *   freq: 'month' — days = '5' (0 = oyning oxirgi kuni; 29–31 qisqa oyda oxirgi kunga tushadi); 'week' — days = '1,5' (luxon: Du=1 … Ya=7).
 * next_run_at — keyingi yuborish (ISO, Toshkent); cron har daqiqa (flows.runRecurring). claim() — bir marta (ikki marta yuborilmaydi).
 * Hech narsa o'chirilmaydi: to'xtatish — active=0, bekor qilish — cancelled_at.
 */

const KINDS = ['remind', 'task'];
const FREQS = ['month', 'week'];

const parseDays = (days) => String(days || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 31);

/** Keyingi yuborish payti — after dan keyin (qat'iy). luxon DateTime yoki null */
const nextRun = ({ freq, days, at_time: at }, after = time.now()) => {
  const [h, m] = String(at || '').split(':').map(Number);
  const list = parseDays(days);
  if (!list.length || !Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (freq === 'week') {
    for (let i = 0; i <= 7; i += 1) {
      const d = after.startOf('day').plus({ days: i }).set({ hour: h, minute: m });
      if (list.includes(d.weekday) && d > after) return d;
    }
    return null;
  }
  for (let i = 0; i <= 2; i += 1) {
    const base = after.startOf('month').plus({ months: i });
    const day = list[0] === 0 ? base.daysInMonth : Math.min(list[0], base.daysInMonth);
    const d = base.set({ day, hour: h, minute: m });
    if (d > after) return d;
  }
  return null;
};

/** «har oy 5-kuni» / «har oy oxirgi kuni» / «har hafta: Du, Ju» */
const daysText = (r) => {
  const list = parseDays(r.days);
  if (r.freq === 'week') return `har hafta: ${list.map((d) => time.UZ_SHORT[d - 1]).join(', ')}`;
  return `har oy ${list[0] === 0 ? 'oxirgi kuni' : `${list[0]}-kuni`}`;
};
/** «har oy 5-kuni, 10:00» / «har hafta: Du, Ju — 16:00» */
const scheduleText = (r) => `${daysText(r)}${r.freq === 'week' ? ' —' : ','} ${r.at_time}`;

const byId = (id) => db.one('SELECT * FROM recurring WHERE id = $1', [Number(id)]);

const create = async ({ kind, freq, days, atTime, body = null, media = null, dueOffset = 0, target, createdBy, creatorName, memberIds }) => {
  if (!KINDS.includes(kind) || !FREQS.includes(freq)) throw new Error(`recurring: noto'g'ri tur ${kind}/${freq}`);
  const daysStr = [...new Set(days.map(Number))].sort((a, b) => a - b).join(',');
  const next = nextRun({ freq, days: daysStr, at_time: atTime });
  const rows = await db.query(
    `INSERT INTO recurring (kind, freq, days, at_time, body, media_type, file_id, file_name, due_offset, target, created_by, creator_name, created_at, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [kind, freq, daysStr, atTime, body, media ? media.type : null, media ? media.fileId : null, media && media.fileName ? String(media.fileName).slice(0, 200) : null,
      Number(dueOffset) || 0, target || null, Number(createdBy), creatorName || null, time.stamp(), next ? next.toISO() : null],
  );
  const id = rows[0].id;
  for (const empId of [...new Set(memberIds.map(Number))]) {
    await db.query('INSERT INTO recurring_members (recurring_id, employee_id) VALUES ($1, $2) ON CONFLICT (recurring_id, employee_id) DO NOTHING', [Number(id), empId]);
  }
  return byId(id);
};

/** Qabul qiluvchilar (ishdan bo'shaganlar ham — ro'yxatda ko'rinadi; yuborishda faqat faollar) */
const members = (id) =>
  db.query(
    `SELECT e.* FROM recurring_members rm JOIN employees e ON e.id = rm.employee_id WHERE rm.recurring_id = $1 ORDER BY lower(e.full_name)`,
    [Number(id)],
  );

/** Yozgan odamning davriy eslatmalari (bekor qilinganlarsiz) */
const listBy = (createdBy) =>
  db.query('SELECT * FROM recurring WHERE created_by = $1 AND cancelled_at IS NULL ORDER BY active DESC, id DESC', [Number(createdBy)]);

/** Vaqti kelganlar */
const due = (now = time.now()) =>
  db.query('SELECT * FROM recurring WHERE active = 1 AND cancelled_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at, id', [now.toISO()]);

/**
 * Navbatdagi yuborishni band qilish: next_run_at keyingisiga suriladi. Faqat bitta chaqiruv true oladi.
 * count=false — o'tkazib yuborilgan (bot o'chiq turgan kun) — hisobga kirmaydi.
 */
const claim = async (r, now = time.now(), { count = true } = {}) => {
  const next = nextRun(r, now);
  const rows = await db.query(
    `UPDATE recurring SET next_run_at = $1, last_run_at = CASE WHEN $2 = 1 THEN $3 ELSE last_run_at END, run_count = run_count + $2
     WHERE id = $4 AND next_run_at = $5 AND active = 1 AND cancelled_at IS NULL RETURNING id`,
    [next ? next.toISO() : null, count ? 1 : 0, now.toISO(), Number(r.id), r.next_run_at],
  );
  return rows.length > 0;
};

/** To'xtatish / davom ettirish (davom etganda keyingi vaqt hozirdan hisoblanadi). O'zgargan bo'lsa true */
const setActive = async (id, on) => {
  const r = await byId(id);
  if (!r || r.cancelled_at || Boolean(Number(r.active)) === Boolean(on)) return false;
  const next = on ? nextRun(r) : null;
  await db.query('UPDATE recurring SET active = $1, next_run_at = $2 WHERE id = $3', [on ? 1 : 0, next ? next.toISO() : r.next_run_at, Number(id)]);
  return true;
};

/** Bekor qilish — bir marta (ikkinchisi false) */
const cancel = async (id, byTg) => {
  const rows = await db.query('UPDATE recurring SET cancelled_at = $1, cancelled_by = $2, active = 0 WHERE id = $3 AND cancelled_at IS NULL RETURNING id', [time.stamp(), Number(byTg), Number(id)]);
  return rows.length > 0;
};

/** Shu davriy eslatmadan yuborilgan oxirgi e'lon (kim tanishganini ko'rish uchun) */
const lastAnnouncement = (id) => db.one('SELECT * FROM announcements WHERE recurring_id = $1 ORDER BY id DESC LIMIT 1', [Number(id)]);

// ---------------------------------------------------------------------------
// 19-okt: DAVRIY TOPSHIRIQNI BAJARMASA
//   keyingi yuborishdan oldingi ish kuni ASK_HOUR da — hodimga savol (Bajardim / ⏳ Bajaraman / ❌ Yo'q; tasks.rec_ask_at, rec_answer);
//   keyingisi kelganda eski topshiriq hali «Bajardim» qilinmagan (active) — rec_result='missed', yozgan odamga xabar (ketma-ket 2+ — bo'lim rahbariga ham);
//   missed topshiriq yopilguncha (accepted / cancelled) — har 2 soatda (NAG_HOURS, ish kunlari): active — hodimga, done — yozgan odamga «qabul qiling».
// ---------------------------------------------------------------------------

const ASK_HOUR = 17;
const NAG_HOURS = [10, 12, 14, 16, 18];
const ANSWERS = ['will', 'no'];
const ANSWER_LABEL = { will: '⏳ Bajaraman', no: "❌ Yo'q" };

const TASK_SELECT = `SELECT t.*, e.full_name, e.tg_id, e.department_id FROM tasks t JOIN employees e ON e.id = t.employee_id`;

/** Savol kuni: keyingi yuborish kunidan oldingi ish kuni ('yyyy-MM-dd') yoki null */
const askDateOf = (r) => {
  if (!r.next_run_at) return null;
  let d = time.addDays(String(r.next_run_at).slice(0, 10), -1);
  for (let i = 0; i < 7 && !time.isWorkDay(d); i += 1) d = time.addDays(d, -1);
  return d;
};

/**
 * Vaqti kelgan topshiriq-davriylar: savol kuni bugun bo'lganlari. Keyingisi bugun ASK_HOUR dan keyin bo'lsa (masalan har kuni 18:00) —
 * kechagi topshiriq kecha ASK_HOUR dan keyin berilgan, savol bugun beriladi
 */
const askDue = async (now = time.now()) => {
  const day = now.toFormat('yyyy-MM-dd');
  const rows = await db.query("SELECT * FROM recurring WHERE kind = 'task' AND active = 1 AND cancelled_at IS NULL AND next_run_at IS NOT NULL");
  return rows.filter((r) => askDateOf(r) === day || String(r.next_run_at).slice(0, 10) === day);
};

/** Savol beriladigan topshiriqlar: shu davriydan, hali «Bajardim» qilinmagan, savol berilmagan */
const askable = (recId) =>
  db.query(`${TASK_SELECT} WHERE t.recurring_id = $1 AND t.status = 'active' AND t.rec_ask_at IS NULL AND t.rec_result IS NULL AND e.active = 1 ORDER BY t.id`, [Number(recId)]);

/** Bir marta (ikkinchisi false) */
const markAsked = async (taskId, now = time.now()) =>
  (await db.query('UPDATE tasks SET rec_ask_at = $1 WHERE id = $2 AND rec_ask_at IS NULL RETURNING id', [now.toISO(), Number(taskId)])).length > 0;

/**
 * Hodim javobi (will | no). Faqat o'z topshirig'i, hali faol va natijasi chiqmagan; o'sha javob takrorlansa — null.
 * Yangilangan topshiriq yoki null
 */
const answer = async (taskId, employeeId, ans) => {
  if (!ANSWERS.includes(ans)) return null;
  const rows = await db.query(
    `UPDATE tasks SET rec_answer = $1, rec_answer_at = $2
     WHERE id = $3 AND employee_id = $4 AND recurring_id IS NOT NULL AND status = 'active' AND rec_result IS NULL AND (rec_answer IS NULL OR rec_answer <> $1) RETURNING id`,
    [ans, time.stamp(), Number(taskId), Number(employeeId)],
  );
  return rows.length ? db.one(`${TASK_SELECT} WHERE t.id = $1`, [Number(taskId)]) : null;
};

/**
 * Keyingisi kelganda: shu hodimdagi oldingi topshiriqlarning natijasi — active → missed, cancelled → skip, qolgani (done/accepted) → ok.
 * «Bajarmadi» bo'lganlar (title bilan)
 */
const evaluate = async (recId, employeeId, now = time.now()) => {
  const rows = await db.query(
    `UPDATE tasks SET rec_result = CASE status WHEN 'active' THEN 'missed' WHEN 'cancelled' THEN 'skip' ELSE 'ok' END, rec_result_at = $1
     WHERE recurring_id = $2 AND employee_id = $3 AND rec_result IS NULL RETURNING id, rec_result`,
    [now.toISO(), Number(recId), Number(employeeId)],
  );
  const missed = rows.filter((x) => x.rec_result === 'missed').map((x) => Number(x.id));
  return missed.length ? db.query(`${TASK_SELECT} WHERE t.id IN (${missed.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY t.id`, missed) : [];
};

/**
 * Ketma-ket necha marta bajarmadi — yuborishlar bo'yicha (bir yuborishda bir nechta topshiriq bo'lsa, bittasi bajarilmasa ham — bajarmadi;
 * hammasi bekor qilingan yuborish o'tkazib yuboriladi). Bir yuborish = bitta rec_result_at
 */
const streak = async (recId, employeeId) => {
  const rows = await db.query(
    'SELECT rec_result, rec_result_at FROM tasks WHERE recurring_id = $1 AND employee_id = $2 AND rec_result IS NOT NULL ORDER BY rec_result_at DESC, id DESC',
    [Number(recId), Number(employeeId)],
  );
  const runs = [];
  for (const x of rows) {
    if (!runs.length || runs[runs.length - 1].at !== x.rec_result_at) runs.push({ at: x.rec_result_at, res: new Set() });
    runs[runs.length - 1].res.add(x.rec_result);
  }
  let n = 0;
  for (const { res } of runs) {
    if (res.has('missed')) { n += 1; continue; }
    if (res.has('ok')) break;
  }
  return n;
};

/** Hodim bo'yicha natija bormi (kartochkada — hali baholanmaganlar ko'rsatilmaydi) */
const hasResults = async (recId, employeeId) =>
  (await db.count("SELECT COUNT(*) AS c FROM tasks WHERE recurring_id = $1 AND employee_id = $2 AND rec_result IN ('missed', 'ok')", [Number(recId), Number(employeeId)])) > 0;

/** Har 2 soatlik eslatma: bajarilmagan (missed) va hali yopilmagan topshiriqlar */
const unresolvedMissed = () =>
  db.query(`${TASK_SELECT} WHERE t.rec_result = 'missed' AND t.status IN ('active', 'done') AND e.active = 1 ORDER BY t.employee_id, t.id`);

module.exports = {
  KINDS, FREQS, parseDays, nextRun, daysText, scheduleText, byId, create, members, listBy, due, claim, setActive, cancel, lastAnnouncement,
  ASK_HOUR, NAG_HOURS, ANSWERS, ANSWER_LABEL, askDateOf, askDue, askable, markAsked, answer, evaluate, streak, hasResults, unresolvedMissed,
};
