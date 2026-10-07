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
const ROLES = { admin: 'Direktor', head: "Rahbar (bo'lim boshlig'i)", employee: 'Hodim' };

const SELECT = `SELECT e.*, d.name AS department_name, d.remind_times AS dept_remind_times, b.name AS branch_name
                FROM employees e LEFT JOIN departments d ON d.id = e.department_id
                LEFT JOIN branches b ON b.id = e.branch_id`;

const byTgId = (tgId) => db.one(`${SELECT} WHERE e.tg_id = $1`, [Number(tgId)]);
const byId = (id) => db.one(`${SELECT} WHERE e.id = $1`, [Number(id)]);

const listActive = () => db.query(`${SELECT} WHERE e.active = 1 ORDER BY lower(d.name), lower(e.full_name)`);
const listAll = () => db.query(`${SELECT} ORDER BY e.active DESC, lower(d.name), lower(e.full_name)`);

/**
 * Boshliq (direktor, role='admin' hodim) — hodim emas (BOSS_IS_STAFF=1 bo'lsa — oddiy hodim kabi hisoblanadi):
 * davomat, KPI, oylik, ertalabki/kun yakuni ro'yxatlari va oy boshiga kirmaydi.
 */
const isBoss = (emp) => Boolean(emp && emp.role === 'admin') && !config.bossIsStaff;
const isStaff = (emp) => Boolean(emp) && !isBoss(emp);
/** Davomat/KPI hisoblanadigan faol hodimlar (boshliqsiz); deptId berilsa — shu bo'lim */
const listStaff = async (deptId = null) => (deptId ? await listByDepartment(deptId) : await listActive()).filter(isStaff);

/** Bo'limdagi faol hodimlar (boshliqning o'zi ham kiradi) */
const listByDepartment = (deptId) =>
  db.query(`${SELECT} WHERE e.active = 1 AND e.department_id = $1 ORDER BY lower(e.full_name)`, [Number(deptId)]);

/** Bo'limsiz faol hodimlar */
const listWithoutDepartment = () =>
  db.query(`${SELECT} WHERE e.active = 1 AND e.department_id IS NULL ORDER BY lower(e.full_name)`);

const listAdmins = () => db.query(`${SELECT} WHERE e.active = 1 AND e.role = 'admin' ORDER BY lower(e.full_name)`);

const listHeads = () => db.query(`${SELECT} WHERE e.active = 1 AND e.role = 'head' ORDER BY lower(e.full_name)`);

const add = async ({ tgId, fullName, position = null, role = 'employee', departmentId = null, username = null, isHr = false }) => {
  const existing = await byTgId(tgId);
  if (existing) {
    await db.query(
      'UPDATE employees SET full_name = $1, position = $2, role = $3, department_id = $4, is_hr = $5, active = 1 WHERE id = $6',
      [fullName, position, role, departmentId, isHr ? 1 : 0, existing.id],
    );
    return { employee: await byId(existing.id), created: false };
  }
  const rows = await db.query(
    `INSERT INTO employees (tg_id, full_name, position, username, role, department_id, is_hr, active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8) RETURNING id`,
    [Number(tgId), fullName, position, username, role, departmentId, isHr ? 1 : 0, time.stamp()],
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
/** Alohida ish boshlanish vaqti 'HH:mm' (null = umumiy vaqt, services/worktime.js) */
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
  return m ? Number(m[1]) * 60 + Number(m[2]) : require('./worktime').minutes();
};

/** Alohida ish tugashi ('HH:mm', null — umumiy WORK_END_HOUR) — boshliq kartochkadan qo'yadi */
const setWorkEnd = (id, hhmm) => db.query('UPDATE employees SET work_end = $1 WHERE id = $2', [hhmm || null, Number(id)]);
const workEndOf = (emp) => (emp && /^\d{2}:\d{2}$/.test(String(emp.work_end || '')) ? emp.work_end : `${String(config.workEndHour).padStart(2, '0')}:00`);
/** Hodimning ish tugashi — kun boshidan daqiqalarda */
const endMinutesOf = (emp) => {
  const [h, m] = workEndOf(emp).split(':').map(Number);
  return h * 60 + m;
};

/** Erkin jadval — kechikish va geofence'dan ozod */
const setFlexible = (id, flexible) => db.query('UPDATE employees SET flexible = $1 WHERE id = $2', [flexible ? 1 : 0, Number(id)]);

const isFlexible = (emp) => Boolean(emp && Number(emp.flexible) === 1);

// --- Filial, ish turi (ofis / hudud), uy joylashuvi, video, oklad ---
const setBranch = (id, branchId) => db.query('UPDATE employees SET branch_id = $1 WHERE id = $2', [branchId ? Number(branchId) : null, Number(id)]);
/** 'office' — ofisga keladi (geofence + video); 'field' — hudud agenti (uydan FIELD_MIN_DISTANCE_M uzoqda) */
const setWorkMode = (id, mode) => db.query('UPDATE employees SET work_mode = $1 WHERE id = $2', [mode === 'field' ? 'field' : 'office', Number(id)]);
const isField = (emp) => Boolean(emp && emp.work_mode === 'field');
const setHome = (id, lat, lon) => db.query('UPDATE employees SET home_lat = $1, home_lon = $2 WHERE id = $3', [String(lat), String(lon), Number(id)]);
const clearHome = (id) => db.query('UPDATE employees SET home_lat = NULL, home_lon = NULL WHERE id = $1', [Number(id)]);
const homeOf = (emp) => (emp && emp.home_lat && emp.home_lon ? { lat: Number(emp.home_lat), lon: Number(emp.home_lon) } : null);
const setVideoRequired = (id, on) => db.query('UPDATE employees SET video_required = $1 WHERE id = $2', [on ? 1 : 0, Number(id)]);
/** "Keldim" uchun video shartmi: ofis — OFFICE_CHECKIN_VIDEO, hudud — kartochkadagi belgi */
const needsCheckinVideo = (emp) => (isField(emp) ? Number(emp.video_required) === 1 : config.officeCheckinVideo);
const setSalary = (id, amount) =>
  db.query('UPDATE employees SET salary = $1 WHERE id = $2', [amount === null ? null : Math.round(Number(amount)), Number(id)]);
// --- HR va jamoalar ---
/** HR — rahbar (head) + barcha hodimlarning kelmaslik/kechikish xabarlarini oladi, sababli kunni tasdiqlaydi */
const isHr = (emp) => Boolean(emp && emp.active && Number(emp.is_hr) === 1);
const setHr = async (id, on) => {
  await db.query('UPDATE employees SET is_hr = $1 WHERE id = $2', [on ? 1 : 0, Number(id)]);
  if (on) await db.query("UPDATE employees SET role = 'head' WHERE id = $1 AND role = 'employee'", [Number(id)]);
};
/** HR «Bajardim» (tekshiruv) xabarlarini o'zi xohlasa oladi — standart o'chiq */
const wantsDoneNotify = (emp) => Boolean(emp && Number(emp.notify_done) === 1);
const setNotifyDone = (id, on) => db.query('UPDATE employees SET notify_done = $1 WHERE id = $2', [on ? 1 : 0, Number(id)]);
const listHr = () => db.query(`${SELECT} WHERE e.active = 1 AND e.is_hr = 1 ORDER BY lower(e.full_name)`);
/** Ko'rinadigan unvon: lavozim, bo'lmasa HR / rol */
const titleOf = (e) => e.position || (Number(e.is_hr) === 1 ? 'HR' : ROLES[e.role] || '');
const personIcon = (e) => (Number(e.is_hr) === 1 ? '🧑‍💼' : e.role === 'admin' ? '👑' : e.role === 'head' ? '🎖' : '👤');
/** Davomat nazoratchisi: hamma hodimning kelgan-ketgani, davomat % va KPI % — topshiriqlarsiz. HR / direktor beradi */
const isViewer = (emp) => Boolean(emp && emp.active && Number(emp.can_view_att) === 1);
const setViewer = (id, on) => db.query('UPDATE employees SET can_view_att = $1 WHERE id = $2', [on ? 1 : 0, Number(id)]);
/** Telegram lichkasiga havola (HTML) */
const contactHtml = (e) => {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<a href="tg://user?id=${Number(e.tg_id)}">${esc(e.full_name)}</a>${e.username ? ` · @${esc(e.username)}` : ''}`;
};

/** Rahbarning jamoasi — uning bo'limidagi faol hodimlar (o'zidan tashqari) */
const teamOf = async (manager) => {
  if (!manager || !manager.department_id) return [];
  return (await listByDepartment(manager.department_id)).filter((e) => Number(e.id) !== Number(manager.id));
};
/** Rahbari yo'q hodimlar (bo'limsiz yoki bo'limida head yo'q), rahbar va direktorlardan tashqari */
const listUnmanaged = async () => {
  const heads = await listHeads();
  const covered = new Set(heads.filter((h) => h.department_id).map((h) => Number(h.department_id)));
  return (await listActive()).filter((e) => e.role === 'employee' && !(e.department_id && covered.has(Number(e.department_id))));
};

const modeLabel = (emp) => (isField(emp) ? '🚶 Hudud (agent)' : '🏢 Ofis');

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
  if (isActorAdmin || isHr(actor)) return true;
  if (!actor || !target) return false;
  if (Number(actor.id) === Number(target.id)) return true;
  return isHead(actor) && actor.department_id && Number(actor.department_id) === Number(target.department_id);
};

/**
 * Hodimning "tekshiruvchisi" — real vaqt xabarlari (keldi/ketdi/bajardi/tashrif) va tasdiqlash kimga boradi.
 * Bo'lim boshliqlari (o'zidan tashqari); bo'lmasa adminlar; + ADMIN_IDS; + HR (direktor ko'rgan hamma narsani ko'radi).
 */
const reviewersOf = async (emp) => {
  const ids = new Set();
  if (emp.department_id) {
    const heads = await db.query(
      `${SELECT} WHERE e.active = 1 AND e.role = 'head' AND e.department_id = $1 AND e.id <> $2`,
      [Number(emp.department_id), Number(emp.id)],
    );
    heads.forEach((e) => ids.add(Number(e.tg_id)));
  }
  for (const id of await bossTgIds()) ids.add(Number(id));
  for (const h of await listHr()) ids.add(Number(h.tg_id));
  ids.delete(Number(emp.tg_id));
  return require('./org').dropQuiet([...ids]);
};

/** Hodimning bo'lim rahbarlari (o'zidan tashqari) — tg_id lar */
const deptHeadIdsOf = async (emp) => {
  if (!emp.department_id) return [];
  const heads = await db.query(
    `${SELECT} WHERE e.active = 1 AND e.role = 'head' AND e.department_id = $1 AND e.id <> $2`,
    [Number(emp.department_id), Number(emp.id)],
  );
  return heads.map((e) => Number(e.tg_id));
};

/**
 * Keldi / ketdi / tashrif xabarlari — bo'lim rahbarlari + HR (boshliqqa EMAS — 2-okt qarori; Panelda yoqsa — boshliqqa ham).
 * Hech kim bo'lmasa (bo'limsiz va HR yo'q) — boshliq, xabar yo'qolmasin.
 */
const attendanceWatchersOf = async (emp) => {
  const ids = new Set(await deptHeadIdsOf(emp));
  for (const h of await listHr()) ids.add(Number(h.tg_id));
  ids.delete(Number(emp.tg_id));
  if (!ids.size || (await require('./org').bossSeesAttendance())) for (const id of await bossTgIds()) ids.add(Number(id));
  ids.delete(Number(emp.tg_id));
  return require('./org').dropQuiet([...ids]);
};

/**
 * «Bajardim» — tekshiruv so'rovi kimga: bo'lim rahbarlari + boshliq + topshiriqni bergan odam;
 * HR — faqat o'zi yoqqan bo'lsa (notify_done). task — topshiriq (beruvchini bilish uchun), ixtiyoriy.
 */
const doneReviewersOf = async (emp, task = null) => {
  const ids = new Set(await deptHeadIdsOf(emp));
  for (const id of await bossTgIds()) ids.add(Number(id));
  // HR — o'zi yoqsa; boshliq/direktor bergan topshiriq va boshliq missiyasi HR ga bormaydi
  const hidden = Boolean(task && require('./tasks').hiddenFromHr(task)) && !(await require('./org').hrSeesBossTasks());
  for (const h of await listHr()) if (wantsDoneNotify(h) && !hidden) ids.add(Number(h.tg_id));
  ids.delete(Number(emp.tg_id));
  // jim rejimdagilar — o'zi bergan topshiriqdan tashqari; hech kim qolmasa o'zgarishsiz (qabul qiladigan odam qolsin)
  const giver = task && task.created_by && task.source !== 'self' && Number(task.created_by) !== Number(emp.tg_id) ? Number(task.created_by) : null;
  const rest = await require('./org').dropQuiet([...ids].filter((id) => id !== giver));
  const out = giver ? [...rest, giver] : rest;
  return out.length ? out : [...ids];
};

/**
 * RAHBARIYAT = boshliq (bazada role='admin' faol hodim — direktor) + HR. Tasdiqlash so'rovlari faqat shularga boradi.
 * ADMIN_IDS dagi, lekin hodim bo'lmagan direktorlar — «texnik direktor»: hamma narsani ko'radi, ma'lumot xabarlarini
 * oladi, lekin ulardan hech narsa so'ralmaydi (tugmasiz). Bazada boshliq-hodim bo'lmasa — ADMIN_IDS boshliq hisoblanadi.
 */
const bossTgIds = async () => {
  const list = await listAdmins();
  return list.length ? list.map((e) => Number(e.tg_id)) : config.adminIds.map(Number);
};
/** Rahbariyat a'zosimi (boshliq yoki HR) — o'z so'rovlari tasdiqsiz kuchga kiradi */
const isTop = (emp) => Boolean(emp && emp.active && (emp.role === 'admin' || Number(emp.is_hr) === 1));

const roleLabel = (role) => ROLES[role] || ROLES.employee;
const mention = (e) => (e.username ? `@${e.username}` : e.full_name);

module.exports = {
  ROLES, byTgId, byId, listActive, listStaff, isBoss, isStaff, listAll, listByDepartment, listWithoutDepartment, listAdmins, listHeads,
  add, ensureMany, deactivate, activate, setRole, setPosition, rename, setDepartment, setBonusFund, setWorkStart, parseWorkStart, startMinutesOf, setWorkEnd, workEndOf, endMinutesOf, setFlexible, isFlexible,
  isHr, setHr, listHr, wantsDoneNotify, setNotifyDone, attendanceWatchersOf, doneReviewersOf, isViewer, setViewer, contactHtml, titleOf, personIcon, teamOf, listUnmanaged,
  setBranch, setWorkMode, isField, setHome, clearHome, homeOf, setVideoRequired, needsCheckinVideo, setSalary, modeLabel,
  touchUsername, isAdminId, isAdmin, isHead, canManage, reviewersOf, deptHeadIdsOf, bossTgIds, isTop, roleLabel, mention,
};
