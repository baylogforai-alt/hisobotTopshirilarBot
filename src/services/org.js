'use strict';

const db = require('../db');
const config = require('../config');

/**
 * TASHKILOT NOMLARI VA XABAR OLUVCHILAR.
 *   Boshliq (direktor) ismi — settings.boss_name (standart BOSS_NAME yoki 'Direktor'), panel → «🏷 Nomlar» da o'zgartiriladi.
 *   HR — employees.is_hr (ismi hodim kartochkasidan o'zgartiriladi).
 *   Kelmaslik / kechikish sabablari: HR + boshliq (direktorlar) + hodimning bo'lim rahbari.
 */

const BOSS_KEY = 'boss_name';

const bossName = async () => (await db.getSetting(BOSS_KEY)) || config.bossName;
const setBossName = (name) => db.setSetting(BOSS_KEY, String(name).trim().slice(0, 60));

/** Rahbar bergan topshiriq nusxasi direktor/HR ga boradimi (standart — ha). Faqat direktor o'zgartiradi */
const HEAD_COPY_KEY = 'head_task_copy';
// BayLog: standart YOQIQ (BAYOMA'da 7-okt dan o'chiq) — Panel «📤 Rahbar topshiriq nusxasi» bilan o'zgaradi
const headTaskCopy = async () => (await db.getSetting(HEAD_COPY_KEY)) !== '0';
const setHeadTaskCopy = (on) => db.setSetting(HEAD_COPY_KEY, on ? '1' : '0');

/**
 * HR boshliq/direktor bergan topshiriqlarni va boshliq missiyalarini ko'radimi (standart — yo'q).
 * Boshliq Panel → «👁 HR va boshliq topshiriqlari» bilan o'zi yoqadi/o'chiradi
 */
const HR_BOSS_KEY = 'hr_boss_tasks';
const hrSeesBossTasks = async () => (await db.getSetting(HR_BOSS_KEY)) === '1';
const setHrSeesBossTasks = (on) => db.setSetting(HR_BOSS_KEY, on ? '1' : '0');

/**
 * Boshliq (Odilxon — bazadagi role='admin' hodim) davomat xabarlarini oladimi: keldi, ketdi, kech qolaman, kelmayman,
 * ertalabki holat, kun yakuni (standart — BOSS_SEES_ATTENDANCE, BayLog'da ha). Boshliq Panel → «👁 Boshliq keldi-ketdini» bilan o'zi yoqadi
 */
/** Bo'lim rahbari jamoasining KPI summasini ko'radimi (standart — yo'q). Boshliq Panel → «💵 Rahbar KPI summasini» */
const HEAD_MONEY_KEY = 'head_money';
const headSeesMoney = async () => (await db.getSetting(HEAD_MONEY_KEY)) === '1';
const setHeadSeesMoney = (on) => db.setSetting(HEAD_MONEY_KEY, on ? '1' : '0');

const BOSS_ATT_KEY = 'boss_attendance';
// Sozlama hali qo'yilmagan bo'lsa — config.bossSeesAttendance (BayLog: BOSS_SEES_ATTENDANCE, standart ha — direktorlar hisobotni oladi)
const bossSeesAttendance = async () => {
  const v = await db.getSetting(BOSS_ATT_KEY);
  return v === null || v === undefined || v === '' ? config.bossSeesAttendance : v === '1';
};
const setBossSeesAttendance = (on) => db.setSetting(BOSS_ATT_KEY, on ? '1' : '0');

/**
 * 🔕 JIM REJIM (7-okt) — shu odamlarga (tg_id) topshiriq berildi/qo'shildi/bajarildi va keldi/ketdi xabarlari bormaydi
 * (arxiv, jurnal, hisobotlarda baribir ko'rinadi). Har kim Panel → «🔕 Menga xabarlar» bilan o'zi yoqadi; Odilxon — fixes.js.
 */
const QUIET_KEY = 'quiet_ids';
const quietIds = async () => new Set(String((await db.getSetting(QUIET_KEY)) || '').split(',').map(Number).filter(Boolean));
const isQuiet = async (tgId) => (await quietIds()).has(Number(tgId));
const setQuiet = async (tgId, on) => {
  const q = await quietIds();
  if (on) q.add(Number(tgId)); else q.delete(Number(tgId));
  await db.setSetting(QUIET_KEY, [...q].join(','));
};
/**
 * Jim rejimdagilarni chiqaradi. keepIfEmpty — hech kim qolmasa o'zgarishsiz (qaror kerak bo'lgan xabar yo'qolmasin).
 * 29-okt: kimdir chiqarilsa — o'rniga ADMIN_IDS (texnik direktor, hodim bo'lishi mumkin) oladi; `self` — xabar egasi, unga emas.
 */
const dropQuiet = async (ids, { keepIfEmpty = false, self = null } = {}) => {
  const q = await quietIds();
  if (!q.size) return ids;
  const rest = ids.filter((id) => !q.has(Number(id)));
  if (rest.length < ids.length) {
    for (const id of config.adminIds) {
      if (!q.has(Number(id)) && Number(id) !== Number(self) && !rest.some((x) => Number(x) === Number(id))) rest.push(Number(id));
    }
  }
  return rest.length || !keepIfEmpty ? rest : ids;
};

/**
 * 👁 FAQAT O'Z TOPSHIRIQLARI (23-okt) — shu odamlar (tg_id) botda faqat o'zlari bergan (va o'zlariga berilgan) topshiriqlarni
 * ko'radi: holat ro'yxatlari, Tekshiruv, jurnal, hodim kartochkasi, Excel (tasks.visibleTo). Odilxon — fixes.js.
 */
const OWN_TASKS_KEY = 'own_tasks_ids';
const ownTasksIds = async () => new Set(String((await db.getSetting(OWN_TASKS_KEY)) || '').split(',').map(Number).filter(Boolean));
const isOwnTasksOnly = async (tgId) => (await ownTasksIds()).has(Number(tgId));
const setOwnTasksOnly = async (tgId, on) => {
  const q = await ownTasksIds();
  if (on) q.add(Number(tgId)); else q.delete(Number(tgId));
  await db.setSetting(OWN_TASKS_KEY, [...q].join(','));
};

/**
 * Boshliq «Bajardim» (bajarilgan topshiriq, isbot bilan) xabarlarini oladimi. BayLog'da standart — HA (Jaxongir tekshiradi;
 * BAYOMA'da standart yo'q). Odilxonga baribir bormaydi — jim rejim. Panel → «✅ Boshliqqa «Bajardim»»
 */
const BOSS_DONE_KEY = 'boss_done';
const bossSeesDone = async () => (await db.getSetting(BOSS_DONE_KEY)) !== '0';
const setBossSeesDone = (on) => db.setSetting(BOSS_DONE_KEY, on ? '1' : '0');

/**
 * Sozlama o'chiq bo'lsa — boshliq(lar)ni chiqarib tashlaydi. keepIfEmpty — hech kim qolmasa o'zgarishsiz
 * (faqat qaror tugmalari uchun: aks holda hal qiladigan odam qolmaydi; 8-okt — ma'lumot xabarlari boshliqqa zaxira sifatida ham bormaydi)
 */
const withoutHiddenBoss = async (ids, { keepIfEmpty = false } = {}) => {
  if (await bossSeesAttendance()) return ids;
  const bosses = new Set((await require('./employees').listAdmins()).map((e) => Number(e.tg_id)));
  const rest = ids.filter((id) => !bosses.has(Number(id)));
  return rest.length || !keepIfEmpty ? rest : ids;
};

/** Kelmaslik/kechikish xabarini oladiganlar (tg_id lar), hodimning o'zidan tashqari */
const absenceRecipientsOf = async (emp) => {
  const employees = require('./employees');
  const ids = new Set(await employees.reviewersOf(emp));
  for (const h of await employees.listHr()) ids.add(Number(h.tg_id));
  ids.delete(Number(emp.tg_id));
  return withoutHiddenBoss([...ids]);
};

/** Hodimning bo'lim rahbarlari (HR emas, o'zidan tashqari) — tg_id lar */
const deptApproverIdsOf = async (emp) => {
  const employees = require('./employees');
  const hr = new Set((await employees.listHr()).map((h) => Number(h.tg_id)));
  return (await employees.deptHeadIdsOf(emp)).map(Number).filter((id) => !hr.has(id) && id !== Number(emp.tg_id));
};

/**
 * Sababli qilish (kelmayman / kechikish / javob so'rash) tugmalari kimga: bo'lim rahbari (5-okt qarori).
 * 8-okt: bo'lim rahbari bo'lmasa — HR (boshliq emas); HR ning o'zi so'rasa (boshqa HR yo'q) — boshliq.
 * Boshliq Panelda keldi-ketdini yoqsa — unga ham.
 */
const approversOf = async (emp) => {
  const employees = require('./employees');
  let ids = await deptApproverIdsOf(emp);
  if (!ids.length) ids = (await employees.listHr()).map((h) => Number(h.tg_id)).filter((id) => id !== Number(emp.tg_id));
  const set = new Set(ids);
  if (!set.size || (await bossSeesAttendance())) for (const id of await employees.bossTgIds()) set.add(Number(id));
  set.delete(Number(emp.tg_id));
  return dropQuiet([...set], { keepIfEmpty: true, self: emp.tg_id });
};

/** Texnik direktorlar (ADMIN_IDS, rahbariyatda yo'q) — faqat ma'lumot oladi, tasdiqlash tugmalarisiz */
const infoOnlyIds = async (exclude = []) => {
  const employees = require('./employees');
  const notify = require('./notify');
  const top = new Set((await employees.bossTgIds()).map(Number));
  for (const h of await employees.listHr()) top.add(Number(h.tg_id));
  const ex = new Set(exclude.map(Number));
  return (await notify.adminIds()).map(Number).filter((id) => !top.has(id) && !ex.has(id));
};

/**
 * Hodimga «kimga yuborildi» matni: "bo'lim rahbari (Abdulhay), HR (Abbos)" — xabar haqiqatda kimga borsa, shular
 * (8-okt: bo'lim rahbari yozilmagani uchun «rahbarga bormayapti» deb o'ylashgan). approvers — "bo'lim rahbari (…) yoki boshliq (…)"
 */
const recipientsLabel = async (emp = null, { approvers = false } = {}) => {
  const employees = require('./employees');
  const hr = (await employees.listHr()).filter((h) => !emp || Number(h.id) !== Number(emp.id));
  const hrIds = new Set(hr.map((h) => Number(h.tg_id)));
  const heads = [];
  if (emp) {
    for (const id of await employees.deptHeadIdsOf(emp)) {
      const h = hrIds.has(Number(id)) ? null : await employees.byTgId(id);
      if (h) heads.push(h.full_name);
    }
  }
  const boss = await bossName();
  const headText = heads.length ? `bo'lim rahbari (${heads.join(', ')})` : null;
  if (approvers) return headText ? `${headText} yoki boshliq (${boss})` : hr.length ? `HR (${hr.map((h) => h.full_name).join(', ')})` : `boshliq (${boss})`;
  const parts = [headText, hr.length ? `HR (${hr.map((h) => h.full_name).join(', ')})` : null].filter(Boolean);
  if (await bossSeesAttendance()) parts.push(`boshliq (${boss})`);
  if (!parts.length) return 'rahbariyat';
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} va ${parts[parts.length - 1]}` : parts[0];
};

/**
 * Harakat qilayotgan odamning ismi (topshiriq bergan, qaror qilgan): hodim bo'lsa bazadagi ismi,
 * bo'lmasa (ADMIN_IDS dagi direktor) Telegram ismi. Direktorlar bir nechta — boss_name hammaga yozilmasin.
 */
const actorName = (ctx) => {
  if (ctx.state && ctx.state.employee) return ctx.state.employee.full_name;
  const f = ctx.from || {};
  return [f.first_name, f.last_name].filter(Boolean).join(' ').trim() || 'Direktor';
};

module.exports = { quietIds, isQuiet, setQuiet, dropQuiet, isOwnTasksOnly, setOwnTasksOnly, infoOnlyIds, actorName, bossName, setBossName, headTaskCopy, setHeadTaskCopy, hrSeesBossTasks, setHrSeesBossTasks, bossSeesAttendance, setBossSeesAttendance, bossSeesDone, setBossSeesDone, headSeesMoney, setHeadSeesMoney, absenceRecipientsOf, approversOf, deptApproverIdsOf, recipientsLabel };
