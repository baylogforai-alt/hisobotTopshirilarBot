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
  checkOut: '🏁 Ishdan ketaman',
  addMission: '➕ Missiya qo\'shish',
  myMissions: '📋 Missiyalarim',
  done: '✔️ Bajardim',
  report: '📊 Hisobot',
  admin: '⚙️ Admin panel',
  sendLocation: '📍 Joylashuvni yuborish',
  cancelLocation: '❌ Bekor qilish',
};

/**
 * Ishga kelishni tasdiqlash klaviaturasi — request_location tugmasi qurilmaning
 * HAQIQIY joriy GPS'ini yuboradi. Foydalanuvchi bu tugma orqali xaritadan
 * ixtiyoriy nuqta tanlay olmaydi.
 */
const locationKeyboard = () =>
  Markup.keyboard([
    [Markup.button.locationRequest(BTN.sendLocation)],
    [BTN.cancelLocation],
  ])
    .resize()
    .oneTime();

const mainKeyboard = (isAdmin = false) => {
  const rows = [
    [BTN.checkIn, BTN.checkOut],
    [BTN.addMission, BTN.myMissions],
    [BTN.done, BTN.report],
  ];
  if (isAdmin) rows.push([BTN.admin]);
  return Markup.keyboard(rows).resize();
};

/** Missiya davomiyligini tanlash tugmalari */
const durationKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📅 Bugun', 'dur:today'), Markup.button.callback('☀️ Ertaga', 'dur:1')],
    [Markup.button.callback('2 kunlik', 'dur:2'), Markup.button.callback('3 kunlik', 'dur:3')],
    [Markup.button.callback('1 haftalik', 'dur:7'), Markup.button.callback('1 oylik', 'dur:30')],
    [Markup.button.callback('❌ Bekor qilish', 'dur:cancel')],
  ]);

/** Bitta missiya qatori */
const missionLine = (m, i) => {
  const t = time.today();
  const overdue = m.due_date < t;
  const daysOpen = Math.max(1, time.diffDays(m.start_date, t) + 1);
  const marks = [];
  if (overdue) marks.push(`⚠️ ${time.diffDays(m.due_date, t)} kun kechikdi`);
  else if (daysOpen > 1) marks.push(`🔁 ${daysOpen}-kun`);
  if (m.due_date !== m.start_date) marks.push(`muddat: ${time.prettyDate(m.due_date)}`);
  const suffix = marks.length ? `\n   <i>${esc(marks.join(' • '))}</i>` : '';
  const icon = overdue ? '🔴' : '🔹';
  return `${i}. ${icon} <b>${esc(m.title)}</b>${suffix}`;
};

const missionList = (missions) =>
  missions.length ? missions.map((m, i) => missionLine(m, i + 1)).join('\n') : '<i>— bo\'sh —</i>';

/** "Bajardim" uchun inline ro'yxat — faqat ochiq (bajarilmagan) missiyalar tugma bo'ladi */
const doneKeyboard = (missions) =>
  Markup.inlineKeyboard([
    ...missions.map((m, i) => [
      Markup.button.callback(`☐ ${i + 1}. ${m.title.slice(0, 43)}`, `done:${m.id}`),
    ]),
    [Markup.button.callback('🔄 Yangilash', 'done:refresh')],
  ]);

/**
 * "Bajardim" oynasi matni — checklist ko'rinishida.
 * Bajarilganlar ✅ (chizilgan), qolganlar ☐ (raqamlangan) bo'lib ko'rinadi,
 * shunda istalganini — 3-sini yoki 5-sini — tanlash mumkinligi aniq bo'ladi.
 */
const doneChecklist = (open, doneToday) => {
  const lines = [];
  doneToday.forEach((m) => {
    lines.push(`✅ <s>${esc(m.title)}</s> <i>${time.clock(m.done_at)}</i>`);
  });
  open.forEach((m, i) => {
    const overdue = m.due_date < time.today();
    lines.push(`☐ <b>${i + 1}.</b> ${esc(m.title)}${overdue ? ' ⚠️' : ''}`);
  });
  const total = open.length + doneToday.length;
  const header =
    open.length
      ? `✔️ <b>Qaysi birini bajardingiz?</b>\n<i>Bajarilgan: ${doneToday.length} / ${total}</i>\n`
      : `🎉 <b>Barcha missiyalar bajarildi!</b>\n<i>Bajarilgan: ${doneToday.length} / ${total}</i>\n`;
  return `${header}\n${lines.join('\n')}` +
    (open.length ? `\n\n👇 Bajarganingizni pastdagi ro'yxatdan bosing.` : '');
};

/** Missiyani o'chirish/bekor qilish ro'yxati */
const cancelKeyboard = (missions) =>
  Markup.inlineKeyboard(
    missions.map((m, i) => [Markup.button.callback(`🗑 ${i + 1}. ${m.title.slice(0, 42)}`, `cancel:${m.id}`)]),
  );

const adminKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('👥 Hodimlar', 'adm:list')],
    [Markup.button.callback('📊 Bugungi umumiy hisobot', 'adm:report')],
    [Markup.button.callback('⚠️ Kechikkan missiyalar', 'adm:overdue')],
    [Markup.button.callback('🔔 Hozir eslatma yuborish', 'adm:remind')],
  ]);

/** "Ishga kelyapsizmi?" — ish boshlanishidan oldingi so'rov */
const intentKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Ha, kelyapman', 'intent:yes'), Markup.button.callback("❌ Yo'q, kelmayman", 'intent:no')],
  ]);

module.exports = {
  esc, BTN, mainKeyboard, durationKeyboard, missionLine, missionList,
  doneKeyboard, doneChecklist, cancelKeyboard, adminKeyboard, intentKeyboard,
  locationKeyboard,
};
