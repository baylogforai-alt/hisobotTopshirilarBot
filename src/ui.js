'use strict';

const { Markup } = require('telegraf');
const time = require('./time');

const esc = (s) =>
  String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Eski (BayLog) tugma nomlari — foydalanuvchi telefonidagi eski klaviatura ham ishlashi uchun yangisiga o'giriladi */
const LEGACY_BTN = {
  '✅ Ishga keldim': '✅ Keldim',
  '🏁 Ishdan ketdim': '🏁 Ketdim',
  '📋 Missiyalarim': '📋 Topshiriqlarim',
  "➕ Missiya qo'shish": "➕ O'zimga vazifa",
};

const BTN = {
  checkIn: '✅ Keldim',
  checkOut: '🏁 Ketdim',
  myTasks: '📋 Topshiriqlarim',
  done: '✔️ Bajardim',
  selfTask: "➕ O'zimga vazifa",
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
  late: '⏰ Kech qolaman',
  salary: '💵 Oylik va KPI',
  myTeam: '👥 Hodimlarim',
  reminders: '🔔 Eslatmalar',
  attView: '👁 Davomat nazorati',
  journal: '📋 Barcha topshiriqlar',
  announce: "📢 E'lon",
  chat: '💬 Savol-javob',
  stActive: '⏳ Faol',
  stReview: '🕓 Kutilmoqda',
  stFix: "🔁 Ko'rib chiqish",
  stDone: '✅ Bajarilgan',
  visit: '📍 Hududga keldim',
  cancel: '❌ Bekor qilish',
  skip: "⏭ O'tkazib yuborish",
};

const LINE = '━'.repeat(18);

/** Rolga va ish turiga qarab asosiy klaviatura (isField — hudud agenti: «Hududga keldim» tugmasi) */
const mainKeyboard = ({ isAdmin = false, isHead = false, isField = false, isHr = false, isViewer = false, isBoss = false } = {}) => {
  const rows = isBoss ? [] : [[BTN.checkIn, BTN.checkOut]];
  if (isField && !isBoss) rows.push([BTN.visit]);
  rows.push([BTN.myTasks, BTN.done], [BTN.stActive, BTN.stFix], [BTN.stReview, BTN.stDone], isBoss ? [BTN.selfTask] : [BTN.selfTask, BTN.dailyReport]);
  if (isAdmin || isHead) rows.push([BTN.assign, BTN.review]);
  if (isAdmin) rows.push([BTN.journal, BTN.announce], [BTN.myTeam, BTN.panel], [BTN.kpi, BTN.reports], [BTN.archive, BTN.myReport]);
  else if (isHr) rows.push([BTN.journal, BTN.announce], [BTN.myTeam, BTN.reports], [BTN.kpi, BTN.attView], [BTN.score, BTN.myReport]);
  else if (isHead) rows.push([BTN.myTeam, BTN.myDept], [BTN.score, BTN.announce], [BTN.myReport]);
  else rows.push([BTN.myReport]);
  if (isViewer && !isAdmin && !isHr) rows.push([BTN.attView]);
  // boshliq (direktor, role='admin' hodim) — hodim emas: kech qolaman / kelmayman / oylik yo'q
  // HR — eslatma sozlamalari yo'q (faqat boshliq boshqaradi)
  if (isBoss) rows.push([BTN.reminders]);
  else rows.push([BTN.late, BTN.absence], isHr && !isAdmin ? [BTN.salary] : [BTN.salary, BTN.reminders]);
  return Markup.keyboard(rows).resize();
};

const isFieldEmp = (emp) => Boolean(emp && emp.work_mode === 'field');
const flag = (emp, key) => Boolean(emp && Number(emp[key]) === 1);
const isBossEmp = (emp) => Boolean(emp && emp.role === 'admin');
const kbFor = (ctx) => mainKeyboard({
  isAdmin: ctx.state.isAdmin, isHead: ctx.state.isHead, isField: isFieldEmp(ctx.state.employee),
  isHr: flag(ctx.state.employee, 'is_hr'), isViewer: flag(ctx.state.employee, 'can_view_att'), isBoss: isBossEmp(ctx.state.employee),
});
const kbForEmp = (emp) => mainKeyboard({
  isAdmin: emp.role === 'admin', isHead: emp.role === 'head', isField: isFieldEmp(emp), isHr: flag(emp, 'is_hr'), isViewer: flag(emp, 'can_view_att'), isBoss: isBossEmp(emp),
});

/**
 * Ishga kelishni tasdiqlash klaviaturasi — request_location tugmasi qurilmaning
 * HAQIQIY joriy GPS'ini yuboradi (xaritadan ixtiyoriy nuqta tanlab bo'lmaydi).
 */
const locationKeyboard = () =>
  Markup.keyboard([[Markup.button.locationRequest(BTN.sendLocation)], [BTN.cancel]]).resize().oneTime();

const skipKeyboard = () => Markup.keyboard([[BTN.skip], [BTN.cancel]]).resize().oneTime();
const cancelKeyboard = () => Markup.keyboard([[BTN.cancel]]).resize().oneTime();

const cb = (label, data) => Markup.button.callback(label, data);
const urlButton = (label, url) => Markup.button.url(label, url);
const inline = (rows) => Markup.inlineKeyboard(rows);

/** Muddat tanlash — prefix: 'st' (o'zimga) yoki 'as' (topshiriq berish) */
const dueKeyboard = (prefix) =>
  inline([
    [cb('📅 Bugun', `${prefix}:due:0`), cb('☀️ Ertaga', `${prefix}:due:1`)],
    [cb('2 kun', `${prefix}:due:2`), cb('3 kun', `${prefix}:due:3`), cb('1 hafta', `${prefix}:due:7`)],
    [cb('2 hafta', `${prefix}:due:14`), cb('1 oy', `${prefix}:due:30`), cb('📆 Sana yozish', `${prefix}:due:type`)],
    [cb(BTN.cancel, `${prefix}:cancel`)],
  ]);

/** Boshlanish soati — prefix 'st' / 'as'. Bugun uchun faqat hali o'tmagan soatlar */
const START_SLOTS = ['08:00', '09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'];
const startTimeKeyboard = (prefix, dueDate) => {
  const now = time.now();
  const nowMin = now.hour * 60 + now.minute;
  const slots = START_SLOTS.filter((t) => dueDate !== time.today() || Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) > nowMin);
  const rows = [];
  for (let i = 0; i < slots.length; i += 3) rows.push(slots.slice(i, i + 3).map((t) => cb(`🕘 ${t}`, `${prefix}:tm:${t.replace(':', '')}`)));
  rows.push([cb('✍️ Soatni yozish', `${prefix}:tm:type`), cb('⏭ Soatsiz', `${prefix}:tm:-`)]);
  rows.push([cb(BTN.cancel, `${prefix}:cancel`)]);
  return inline(rows);
};

const PRIO_ICON = { high: '🔥', normal: '', low: '' };
const SOURCE_LABEL = { self: "o'zi", head: 'boshliq', admin: 'direktor' };

/** Topshiriqning o'zi media bo'lsa — belgi */
const MEDIA_ICON = { voice: '🎤', audio: '🎵', video: '🎥', video_note: '🎥', photo: '🖼', document: '📄' };
const MEDIA_LABEL = { voice: '🎤 Ovozli topshiriq', audio: '🎵 Audio topshiriq', video: '🎥 Video topshiriq', video_note: '🎥 Video topshiriq', photo: '🖼 Rasmli topshiriq', document: '📄 Fayl' };

/** «Eshitdim, tushundim» tugmalari (bitta — bitta tugma; ko'p — har biri + hammasi) */
const ackRows = (list) => {
  if (!list.length) return [];
  if (list.length === 1) return [[cb('✅ Eshitdim, tushundim', `ak:${list[0].id}`)]];
  const rows = list.slice(0, 5).map((t) => [cb(`✅ Tushundim: ${t.title}`.slice(0, 50), `ak:${t.id}`)]);
  rows.push([cb('✅ Hammasini tushundim', `ak:l:${list.slice(0, 10).map((t) => t.id).join(',')}`)]);
  return rows;
};

/** Bitta topshiriq qatori */
/** Topshiriq nomi izohsiz media uchun standart nom («🖼 Rasmli topshiriq» …) — mazmuni faqat faylning o'zida */
const isGenericMediaTitle = (t) => Boolean(t && t.task_media_type && Object.values(MEDIA_LABEL).includes(String(t.title || '').trim()));

/** Ro'yxatdagi media topshiriqlar uchun «ko'rish / eshitish» tugmalari (raqam — ro'yxatdagi tartib) */
const mediaRows = (list, startAt = 1) =>
  list
    .map((t, i) => ({ t, n: startAt + i }))
    .filter(({ t }) => t.task_file_id)
    .map(({ t, n }) => [cb(`${MEDIA_ICON[t.task_media_type] || '📎'} ${n}-topshiriqni ${t.task_media_type === 'voice' || t.task_media_type === 'audio' ? 'eshitish' : "ko'rish"}${isGenericMediaTitle(t) ? '' : ` — ${t.title.slice(0, 30)}`}`, `tk:media:${t.id}`)]);

const taskLine = (t, i, { withName = false } = {}) => {
  const today = time.today();
  const overdue = t.status === 'active' && t.due_date < today;
  const icon = overdue ? '🔴' : t.status === 'done' ? '🕓' : t.status === 'accepted' ? '✅' : t.priority === 'high' ? '🔥' : '🔹';
  const marks = [];
  if (overdue) marks.push(`${time.diffDays(t.due_date, today)} kun kechikdi`);
  else if (t.status === 'active' && t.due_date === today) marks.push('bugun');
  else if (t.status === 'active') marks.push(`muddat: ${time.prettyDate(t.due_date)}`);
  if (t.status === 'active' && t.start_time) marks.push(`⏰ ${t.start_time} da boshlanadi`);
  if (t.status === 'done') marks.push('tekshiruvda');
  if (Number(t.returned_count) > 0) marks.push(`↩️ ${t.returned_count} marta qaytarilgan`);
  if (t.source !== 'self') marks.push(`bergan: ${t.giver_name || SOURCE_LABEL[t.source] || t.source}`);
  // izohsiz ovoz/rasm/video topshiriq («🎤 Ovozli topshiriq») — qachon berilgani bilan ajralsin, mazmuni tugma orqali ochiladi
  const generic = isGenericMediaTitle(t);
  if (generic && t.created_at) marks.push(`berilgan: ${time.prettyDate(String(t.created_at).slice(0, 10))} ${time.clock(t.created_at)}`);
  const name = withName ? `<b>${esc(t.full_name)}</b>: ` : '';
  const suffix = marks.length ? `\n   <i>${esc(marks.join(' • '))}</i>` : '';
  const media = t.task_media_type && !generic ? `${MEDIA_ICON[t.task_media_type] || '📎'} ` : '';
  return `${i}. ${icon} ${name}${media}${esc(t.title)}${suffix}`;
};

const taskList = (list, opts) => (list.length ? list.map((t, i) => taskLine(t, i + 1, opts)).join('\n') : "<i>— bo'sh —</i>");

/** "Bajardim" — ochiq topshiriqlar tugma bo'ladi */
const doneKeyboard = (open) =>
  inline([
    // eski izohsiz media topshiriq («🎤 Ovozli topshiriq») — bir-biridan ajralsin: muddat sanasi bilan
    ...open.map((t, i) => [cb(`☐ ${i + 1}. ${t.due_date < time.today() ? '🔴 ' : ''}${t.title.slice(0, 40)}${Object.values(MEDIA_LABEL).includes(t.title) ? ` · ${t.due_date.slice(8, 10)}.${t.due_date.slice(5, 7)}` : ''}`, `done:${t.id}`)]),
    ...(open.length > 1 ? [[cb('☑️ Bir nechtasini birdaniga belgilash', 'done:multi')]] : []),
    [cb('🔄 Yangilash', 'done:list')],
  ]);

/** «Bir nechtasini birdaniga» — belgilash (☑️/☐) + «Davom etish» */
const doneMultiKeyboard = (open, picked) => {
  const set = new Set(picked.map(Number));
  return inline([
    ...open.map((t, i) => [cb(`${set.has(Number(t.id)) ? '☑️' : '☐'} ${i + 1}. ${t.due_date < time.today() ? '🔴 ' : ''}${t.title.slice(0, 38)}`, `done:t:${t.id}`)]),
    [cb(set.size === open.length ? '☐ Hammasini olib tashlash' : '☑️ Hammasini belgilash', 'done:all')],
    [cb(`✅ Davom etish (${set.size} ta)`, 'done:go')],
    [cb('⬅️ Orqaga', 'done:list')],
  ]);
};

/** Tekshiruvchi uchun: bir nechta ish bitta xabarda — har biriga qabul / qaytarish (+ hammasini qabul) */
const reviewMultiKeyboard = (list) => {
  const rows = list.map((t, i) => [cb(`✅ ${i + 1}. ${t.title.slice(0, 28)}`, `rv:ok:${t.id}`), cb(`↩️ ${i + 1}`, `rv:back:${t.id}`)]);
  const all = `rv:okm:${list.map((t) => t.id).join(',')}`;
  if (list.length > 1 && all.length <= 64) rows.push([cb('✅ Hammasini qabul qilish', all)]);
  return inline(rows);
};

/**
 * "Bajardim" oynasi matni — checklist ko'rinishida: bugun bajarilganlar ✅ (chizilgan),
 * qolganlar ☐ raqamlangan.
 */
const doneChecklist = (open, doneToday) => {
  const lines = [];
  doneToday.forEach((t) => lines.push(`${t.status === 'accepted' ? '✅' : '🕓'} <s>${esc(t.title)}</s> <i>${time.clock(t.done_at)}</i>`));
  open.forEach((t, i) => lines.push(`☐ <b>${i + 1}.</b> ${t.priority === 'high' ? '🔥 ' : ''}${t.task_media_type && !isGenericMediaTitle(t) ? `${MEDIA_ICON[t.task_media_type] || '📎'} ` : ''}${esc(t.title)}${isGenericMediaTitle(t) ? ` <i>(${time.prettyDate(String(t.created_at).slice(0, 10))} ${time.clock(t.created_at)})</i>` : ''}${t.due_date < time.today() ? ' 🔴' : ''}`));
  const total = open.length + doneToday.length;
  const header = open.length
    ? `✔️ <b>Qaysi birini bajardingiz?</b>\n<i>Bugun bajarilgan: ${doneToday.length} / ${total}</i>\n`
    : `🎉 <b>Ochiq topshiriq yo'q.</b>\n<i>Bugun bajarilgan: ${doneToday.length} / ${total}</i>\n`;
  return `${header}\n${lines.join('\n') || "<i>— bo'sh —</i>"}` + (open.length ? `\n\n👇 Bajarganingizni pastdan bosing.` : '');
};

/**
 * Isbot so'rash: noProof — «✅ Isbotsiz bajardim» (boshliqning o'z missiyasi); optional — «⏭ Isbotsiz yuborish» (PROOF_REQUIRED=0);
 * extra — qo'shimcha qatorlar (masalan topshiriqni qayta eshitish)
 */
const proofKeyboard = ({ noProof = false, optional = false, extra = [] } = {}) =>
  inline([
    ...(noProof ? [[cb('✅ Isbotsiz bajardim', 'done:np')]] : optional ? [[cb('⏭ Isbotsiz yuborish', 'done:noproof')]] : []),
    ...extra,
    [cb(BTN.cancel, 'done:cancel')],
  ]);

/** Tekshiruvchi uchun: qabul / qaytarish */
const reviewKeyboard = (taskId) => inline([[cb('✅ Qabul qilish', `rv:ok:${taskId}`)], [cb("📝 Kamchilik bor — javob qaytarish", `rv:back:${taskId}`)]]);

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

const taskMenuKeyboard = (t, { canDelete = true, extra = [] } = {}) => {
  const rows = [...extra, [cb('✏️ Matnni tahrirlash', `tk:edit:${t.id}`), cb(t.priority === 'high' ? '🔹 Oddiy qilish' : '🔥 Muhim qilish', `tk:prio:${t.id}`)]];
  rows.push([cb("📆 Muddatni o'zgartirish", `tk:due:${t.id}`)]);
  if (canDelete) rows.push([cb('🗑 Bekor qilish', `tk:del:${t.id}`)]);
  rows.push([cb("⬅️ Ro'yxatga", 'tk:list')]);
  return inline(rows);
};

const confirmKeyboard = (yesData, noData, yesLabel = '✅ Ha', noLabel = "⬅️ Yo'q") => inline([[cb(yesLabel, yesData), cb(noLabel, noData)]]);

/** Admin panel */
const panelKeyboard = ({ quiet = false, bossAtt = false, headCopy = true, hrBoss = false, headMoney = false, gate = { minDays: 25, minTaskPct: 90 } } = {}) =>
  inline([
    [cb('👥 Hodimlar', 'emp:list'), cb("🏢 Bo'limlar", 'dp:list')],
    [cb('💵 Oyliklar (oklad, KPI)', 'sal:list')],
    [cb("➕ Hodim qo'shish", 'ea:start'), cb("📝 So'rovlar", 'jr:list')],
    [cb('📢 E\'lon yuborish', 'an:start'), cb('📢 E\'lonlar tarixi', 'an:list')],
    [cb('📊 Bugungi holat', 'adm:today'), cb('📋 Kunlik hisobotlar', 'dr:today')],
    [cb('⚠️ Kechikkan ishlar', 'adm:overdue'), cb("🙋 Sababli kun so'rovlari", 'adm:excuses')],
    [cb('🗂 Hodimlar arxivi', 'hr:home'), cb('📈 Davr hisoboti', 'pr:home')],
    [cb('📥 Excel yuklab olish', 'xl:home'), cb('🔔 Eslatma yuborish', 'adm:remind')],
    [cb('📍 Ofis joylashuvi', 'adm:office'), cb('🏙 Filiallar', 'br:list')],
    [cb('🗓 Oy boshi tasdiqlari', 'adm:months'), cb('🚶 Tashriflar (bugun)', 'adm:visits')],
    [cb('🕘 Ish vaqti', 'adm:worktime'), cb('🏷 Nomlar', 'adm:names')],
    [cb('📅 Dam olish kuniga chaqirish', 'xc:home')],
    [cb("🧭 Yo'nalishlar", 'dn:list'), cb('👁 Davomat nazorati', 'vw:today')],
    [cb('🔔 Eslatmalar jadvali', 'rm:adm'), cb('💾 Zaxira nusxa', 'adm:backup')],
    [cb(`📤 Rahbar topshiriq nusxasi: ${headCopy ? '✅ yoqilgan' : "🚫 o'chiq"}`, `adm:htc:${headCopy ? 0 : 1}`)],
    [cb(`👁 HR boshliq topshiriqlarini: ${hrBoss ? "✅ ko'radi" : "🚫 ko'rmaydi"}`, `adm:hbt:${hrBoss ? 0 : 1}`)],
    [cb(`🔕 Menga topshiriq / keldi-ketdi xabarlari: ${quiet ? '🔕 kelmaydi' : '🔔 keladi'}`, `adm:qt:${quiet ? 0 : 1}`)],
    [cb(`👁 Boshliq keldi-ketdini: ${bossAtt ? "✅ ko'radi" : "🚫 ko'rmaydi"}`, `adm:bat:${bossAtt ? 0 : 1}`)],
    [cb(`💵 Rahbar KPI summasini: ${headMoney ? "✅ ko'radi" : "🚫 ko'rmaydi"}`, `adm:hm:${headMoney ? 0 : 1}`)],
    [cb(`🚦 KPI sharti: ${gate.minDays} kun · ${gate.minTaskPct}%`, 'adm:kg')],
    [cb('🩺 Tizim holati', 'adm:status')],
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
  esc, BTN, LEGACY_BTN, LINE, mainKeyboard, kbFor, kbForEmp, urlButton, locationKeyboard, skipKeyboard, cancelKeyboard, cb, inline, dueKeyboard, startTimeKeyboard,
  PRIO_ICON, SOURCE_LABEL, MEDIA_ICON, MEDIA_LABEL, isGenericMediaTitle, mediaRows, ackRows, taskLine, taskList, doneKeyboard, doneMultiKeyboard, doneChecklist, proofKeyboard, reviewKeyboard, reviewMultiKeyboard, excuseKeyboard,
  intentKeyboard, dailyReviewKeyboard, joinKeyboard, manageKeyboard, taskMenuKeyboard, confirmKeyboard, panelKeyboard,
  backKeyboard, scoreKeyboard, pctBar, roleIcon,
};
