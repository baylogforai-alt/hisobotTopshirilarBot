'use strict';

const { Markup } = require('telegraf');
const time = require('./time');

const esc = (s) =>
  String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const BTN = {
  checkIn: '✅ Ishga keldim',
  checkOut: '🏁 Ishdan ketdim',
  myTasks: '📋 Missiyalarim',
  done: '✔️ Bajardim',
  selfTask: "➕ Missiya qo'shish",
  dailyReport: '📝 Kunlik hisobot',
  myReport: '📊 Hisobotim',
  absence: '🙋 Kelmayman (sabab)',
  assign: '📤 Topshiriq berish',
  review: '🔎 Tekshiruv',
  myDept: "🏢 Bo'limim",
  score: '⭐ Baholash',
  panel: '⚙️ Panel',
  kpi: '💰 KPI',
  reports: '📈 Hisobotlar',
  archive: '🗂 Arxiv',
  sendLocation: '📍 Joylashuvni yuborish',
  cancel: '❌ Bekor qilish',
  skip: "⏭ O'tkazib yuborish",
};

const LINE = '━'.repeat(18);

/** Rolga qarab asosiy klaviatura */
const mainKeyboard = ({ isAdmin = false, isHead = false } = {}) => {
  const rows = [
    [BTN.checkIn, BTN.checkOut],
    [BTN.myTasks, BTN.done],
    [BTN.selfTask, BTN.dailyReport],
  ];
  if (isAdmin || isHead) rows.push([BTN.assign, BTN.review]);
  if (isAdmin) rows.push([BTN.panel, BTN.kpi], [BTN.reports, BTN.archive], [BTN.myReport, BTN.absence]);
  else if (isHead) rows.push([BTN.myDept, BTN.score], [BTN.myReport, BTN.absence]);
  else rows.push([BTN.myReport, BTN.absence]);
  return Markup.keyboard(rows).resize();
};

const kbFor = (ctx) => mainKeyboard({ isAdmin: ctx.state.isAdmin, isHead: ctx.state.isHead });

/**
 * Ishga kelishni tasdiqlash klaviaturasi — request_location tugmasi qurilmaning
 * HAQIQIY joriy GPS'ini yuboradi (xaritadan ixtiyoriy nuqta tanlab bo'lmaydi).
 */
const locationKeyboard = () =>
  Markup.keyboard([[Markup.button.locationRequest(BTN.sendLocation)], [BTN.cancel]]).resize().oneTime();

const skipKeyboard = () => Markup.keyboard([[BTN.skip], [BTN.cancel]]).resize().oneTime();
const cancelKeyboard = () => Markup.keyboard([[BTN.cancel]]).resize().oneTime();

const cb = (label, data) => Markup.button.callback(label, data);
const inline = (rows) => Markup.inlineKeyboard(rows);

/** Muddat tanlash — prefix: 'st' (o'zimga) yoki 'as' (topshiriq berish) */
const dueKeyboard = (prefix) =>
  inline([
    [cb('📅 Bugun', `${prefix}:due:0`), cb('☀️ Ertaga', `${prefix}:due:1`)],
    [cb('2 kun', `${prefix}:due:2`), cb('3 kun', `${prefix}:due:3`), cb('1 hafta', `${prefix}:due:7`)],
    [cb('2 hafta', `${prefix}:due:14`), cb('1 oy', `${prefix}:due:30`), cb('📆 Sana yozish', `${prefix}:due:type`)],
    [cb(BTN.cancel, `${prefix}:cancel`)],
  ]);

const PRIO_ICON = { high: '🔥', normal: '', low: '' };
const SOURCE_LABEL = { self: "o'zi", head: 'boshliq', admin: 'direktor' };

/** Bitta topshiriq qatori */
const taskLine = (t, i, { withName = false } = {}) => {
  const today = time.today();
  const overdue = t.status === 'active' && t.due_date < today;
  const icon = overdue ? '🔴' : t.status === 'done' ? '🕓' : t.status === 'accepted' ? '✅' : t.priority === 'high' ? '🔥' : '🔹';
  const marks = [];
  if (overdue) marks.push(`${time.diffDays(t.due_date, today)} kun kechikdi`);
  else if (t.status === 'active' && t.due_date === today) marks.push('bugun');
  else if (t.status === 'active') marks.push(`muddat: ${time.prettyDate(t.due_date)}`);
  if (t.status === 'done') marks.push('tekshiruvda');
  if (Number(t.returned_count) > 0) marks.push(`↩️ ${t.returned_count} marta qaytarilgan`);
  if (t.source !== 'self') marks.push(`bergan: ${SOURCE_LABEL[t.source] || t.source}`);
  const name = withName ? `<b>${esc(t.full_name)}</b>: ` : '';
  const suffix = marks.length ? `\n   <i>${esc(marks.join(' • '))}</i>` : '';
  return `${i}. ${icon} ${name}${esc(t.title)}${suffix}`;
};

const taskList = (list, opts) => (list.length ? list.map((t, i) => taskLine(t, i + 1, opts)).join('\n') : "<i>— bo'sh —</i>");

/** "Bajardim" — ochiq topshiriqlar tugma bo'ladi */
const doneKeyboard = (open) =>
  inline([
    ...open.map((t, i) => [cb(`☐ ${i + 1}. ${t.due_date < time.today() ? '🔴 ' : ''}${t.title.slice(0, 40)}`, `done:${t.id}`)]),
    [cb('🔄 Yangilash', 'done:list')],
  ]);

/**
 * "Bajardim" oynasi matni — checklist ko'rinishida: bugun bajarilganlar ✅ (chizilgan),
 * qolganlar ☐ raqamlangan.
 */
const doneChecklist = (open, doneToday) => {
  const lines = [];
  doneToday.forEach((t) => lines.push(`${t.status === 'accepted' ? '✅' : '🕓'} <s>${esc(t.title)}</s> <i>${time.clock(t.done_at)}</i>`));
  open.forEach((t, i) => lines.push(`☐ <b>${i + 1}.</b> ${t.priority === 'high' ? '🔥 ' : ''}${esc(t.title)}${t.due_date < time.today() ? ' 🔴' : ''}`));
  const total = open.length + doneToday.length;
  const header = open.length
    ? `✔️ <b>Qaysi birini bajardingiz?</b>\n<i>Bugun bajarilgan: ${doneToday.length} / ${total}</i>\n`
    : `🎉 <b>Ochiq topshiriq yo'q.</b>\n<i>Bugun bajarilgan: ${doneToday.length} / ${total}</i>\n`;
  return `${header}\n${lines.join('\n') || "<i>— bo'sh —</i>"}` + (open.length ? `\n\n👇 Bajarganingizni pastdan bosing.` : '');
};

const proofKeyboard = () => inline([[cb('⏭ Isbotsiz yuborish', 'done:noproof')], [cb(BTN.cancel, 'done:cancel')]]);

/** Tekshiruvchi uchun: qabul / qaytarish */
const reviewKeyboard = (taskId) => inline([[cb('✅ Qabul qilish', `rv:ok:${taskId}`), cb('↩️ Qaytarish', `rv:back:${taskId}`)]]);

/** Sababli kun so'rovi: tasdiqlash / rad etish */
const excuseKeyboard = (attId) => inline([[cb('✅ Sababli', `ab:ok:${attId}`), cb('❌ Sababsiz', `ab:no:${attId}`)]]);

/** "Ishga kelyapsizmi?" — ish boshlanishidan oldingi so'rov */
const intentKeyboard = () => inline([[cb('✅ Ha, kelyapman', 'intent:yes'), cb("❌ Yo'q, kelmayman", 'intent:no')]]);

/** Kunlik hisobotni ko'rgan boshliq uchun */
const dailyReviewKeyboard = (reportId) => inline([[cb("👁 Ko'rdim", `dr:seen:${reportId}`), cb('💬 Izoh yozish', `dr:note:${reportId}`)]]);

/** Ro'yxatda yo'q odam uchun direktor tugmalari */
const joinKeyboard = (reqId) => inline([[cb("➕ Hodim qilib qo'shish", `jr:add:${reqId}`), cb('🚫 Rad etish', `jr:no:${reqId}`)]]);

/** Topshiriqlarni boshqarish ro'yxati */
const manageKeyboard = (list, prefix = 'tk') =>
  inline([...list.map((t, i) => [cb(`⚙️ ${i + 1}. ${t.title.slice(0, 40)}`, `${prefix}:${t.id}`)]), [cb('🔄 Yangilash', `${prefix}:list`)]]);

const taskMenuKeyboard = (t, { canDelete = true } = {}) => {
  const rows = [[cb('✏️ Matnni tahrirlash', `tk:edit:${t.id}`), cb(t.priority === 'high' ? '🔹 Oddiy qilish' : '🔥 Muhim qilish', `tk:prio:${t.id}`)]];
  rows.push([cb("📆 Muddatni o'zgartirish", `tk:due:${t.id}`)]);
  if (canDelete) rows.push([cb("🗑 O'chirish", `tk:del:${t.id}`)]);
  rows.push([cb("⬅️ Ro'yxatga", 'tk:list')]);
  return inline(rows);
};

const confirmKeyboard = (yesData, noData, yesLabel = '✅ Ha', noLabel = "⬅️ Yo'q") => inline([[cb(yesLabel, yesData), cb(noLabel, noData)]]);

/** Admin panel */
const panelKeyboard = () =>
  inline([
    [cb('👥 Hodimlar', 'emp:list'), cb("🏢 Bo'limlar", 'dp:list')],
    [cb("➕ Hodim qo'shish", 'ea:start'), cb("📝 So'rovlar", 'jr:list')],
    [cb('📊 Bugungi holat', 'adm:today'), cb('📋 Kunlik hisobotlar', 'dr:today')],
    [cb('⚠️ Kechikkan ishlar', 'adm:overdue'), cb("🙋 Sababli kun so'rovlari", 'adm:excuses')],
    [cb('🗂 Hodimlar arxivi', 'hr:home'), cb('📈 Davr hisoboti', 'pr:home')],
    [cb('📥 Excel yuklab olish', 'xl:home'), cb('🔔 Eslatma yuborish', 'adm:remind')],
    [cb('📍 Ofis joylashuvi', 'adm:office'), cb('🩺 Tizim holati', 'adm:status')],
  ]);

const backKeyboard = (data, label = '⬅️ Orqaga') => inline([[cb(label, data)]]);

/** 1–10 baho tugmalari */
const scoreKeyboard = (prefix) =>
  inline([
    [1, 2, 3, 4, 5].map((n) => cb(String(n), `${prefix}:${n}`)),
    [6, 7, 8, 9, 10].map((n) => cb(String(n), `${prefix}:${n}`)),
    [cb('⬅️ Orqaga', `${prefix}:back`)],
  ]);

/** Foizni ko'rsatish: 85 → '█████████░ 85%' */
const pctBar = (pct) => {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round(p / 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${p}%`;
};

const roleIcon = (role) => (role === 'admin' ? '👑' : role === 'head' ? '🎖' : '👤');

module.exports = {
  esc, BTN, LINE, mainKeyboard, kbFor, locationKeyboard, skipKeyboard, cancelKeyboard, cb, inline, dueKeyboard,
  PRIO_ICON, SOURCE_LABEL, taskLine, taskList, doneKeyboard, doneChecklist, proofKeyboard, reviewKeyboard, excuseKeyboard,
  intentKeyboard, dailyReviewKeyboard, joinKeyboard, manageKeyboard, taskMenuKeyboard, confirmKeyboard, panelKeyboard,
  backKeyboard, scoreKeyboard, pctBar, roleIcon,
};
