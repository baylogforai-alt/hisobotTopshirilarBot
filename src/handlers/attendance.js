'use strict';

const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const session = require('../session');
const missions = require('../services/missions');
const attendance = require('../services/attendance');
const employees = require('../services/employees');
const office = require('../services/office');
const notify = require('../services/notify');
const reports = require('../services/reports');
const { notRegistered } = require('./common');

/**
 * "Ishga keldim" — endi darhol qayd etmaydi, avval JOYLASHUV so'raydi.
 * Faqat request_location tugmasi orqali kelgan haqiqiy GPS qabul qilinadi.
 */
const doCheckIn = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);

  if (await attendance.isCheckedIn(emp.id)) {
    await missions.activateDue(emp.id);
    const open = await missions.openFor(emp.id);
    const row = await attendance.get(emp.id);
    return ctx.reply(
      `ℹ️ Siz bugun allaqachon ishga kelgansiz (${time.clock(row.checked_in)}).\n\n` +
        `<b>Bugungi missiyalar (${open.length} ta):</b>\n${ui.missionList(open)}`,
      { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
    );
  }

  session.set(ctx.from.id, { step: 'awaiting_checkin_location' });
  return ctx.reply(
    `📍 <b>Ishga kelganingizni tasdiqlang</b>\n\n` +
      `Pastdagi <b>«📍 Joylashuvni yuborish»</b> tugmasini bosing — bot sizning ` +
      `<b>hozirgi joylashuvingizni</b> tekshiradi.\n\n` +
      `⚠️ Faqat shu tugma orqali yuborilgan joriy joylashuv qabul qilinadi. ` +
      `Qo'lda xaritadan tanlangan yoki boshqa joydan yuborilgan joylashuv qabul qilinmaydi.`,
    { parse_mode: 'HTML', ...ui.locationKeyboard() },
  );
};

/** Ofisdagi adminlarni bir zumlik xabardor qilish uchun matn tuzadi */
const managerCheckinText = (emp, open, row) => {
  const distNote =
    row.checkin_dist != null && row.checkin_dist !== ''
      ? ` · 📍 ofisdan ${geo.prettyDistance(Number(row.checkin_dist))}`
      : '';
  return (
    `🟢 <b>${ui.esc(emp.full_name)}</b>${emp.position ? ` (${ui.esc(emp.position)})` : ''} ` +
    `ishga keldi · ${time.clock(row.checked_in)}${distNote}\n\n` +
    (open.length
      ? `🎯 <b>Bugungi missiyalari (${open.length} ta):</b>\n${ui.missionList(open)}`
      : `<i>Bugunga missiya yozilmagan.</i>`)
  );
};

/** request_location tugmasidan kelgan joylashuvni qayta ishlash */
const onLocation = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);

  const s = session.get(ctx.from.id);

  // Admin ofis joylashuvini o'rnatyapti
  if (s.step === 'awaiting_office_location') {
    if (!ctx.state.isAdmin) {
      session.clear(ctx.from.id);
      return;
    }
    if (!ctx.message.location) return;
    const radius = s.radius || office.DEFAULT_RADIUS;
    await office.set(ctx.message.location.latitude, ctx.message.location.longitude, radius);
    session.clear(ctx.from.id);
    return ctx.reply(
      `✅ <b>Ofis joylashuvi saqlandi.</b>\n\n` +
        `Ruxsat etilgan radius: <b>${geo.prettyDistance(radius)}</b>.\n` +
        `Endi hodimlar faqat shu joydan «Ishga keldim» qila oladi.\n\n` +
        `Radiusni o'zgartirish: <code>/ofis_radius 300</code>`,
      { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
    );
  }

  if (s.step !== 'awaiting_checkin_location') {
    return ctx.reply(
      "Ishga kelishni tasdiqlash uchun avval «✅ Ishga keldim» tugmasini bosing.",
      ui.mainKeyboard(ctx.state.isAdmin),
    );
  }

  // Boshqa joydan yuborilgan (forward qilingan) joylashuvni rad etamiz
  if (ctx.message.forward_date || ctx.message.forward_origin || ctx.message.forward_from) {
    return ctx.reply(
      "❌ Bu joylashuv boshqa joydan yuborilgan. Iltimos, <b>«📍 Joylashuvni yuborish»</b> " +
        "tugmasini bosing.",
      { parse_mode: 'HTML', ...ui.locationKeyboard() },
    );
  }

  const loc = ctx.message.location;
  if (!loc) return;

  if (await attendance.isCheckedIn(emp.id)) {
    session.clear(ctx.from.id);
    return ctx.reply('ℹ️ Siz allaqachon ishga kelgansiz.', ui.mainKeyboard(ctx.state.isAdmin));
  }

  // Geofence — ofis o'rnatilgan bo'lsa masofani tekshiramiz.
  // Erkin jadvaldagilar (o'qish/kurs) istalgan joydan kela oladi.
  const officeConf = await office.get();
  let dist = null;
  if (officeConf) {
    dist = geo.distanceMeters(officeConf.lat, officeConf.lon, loc.latitude, loc.longitude);
    if (!employees.isFlexible(emp) && dist > officeConf.radius) {
      return ctx.reply(
        `❌ <b>Siz ish joyidan uzoqdasiz</b> (${geo.prettyDistance(dist)}).\n\n` +
          `Ruxsat etilgan masofa: ${geo.prettyDistance(officeConf.radius)}.\n` +
          `Ish joyiga yetib borganingizda qaytadan «✅ Ishga keldim» tugmasini bosing.`,
        { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
      );
    }
  }

  const res = await attendance.checkIn(emp.id, {
    lat: loc.latitude,
    lon: loc.longitude,
    dist,
  });
  session.clear(ctx.from.id);
  await missions.activateDue(emp.id);
  const open = await missions.openFor(emp.id);
  const carried = open.filter((m) => m.start_date < time.today());

  const distLine =
    dist != null ? `📍 Ofisdan masofa: ${geo.prettyDistance(dist)}\n` : '';

  await ctx.reply(
    `✅ <b>Ishga kelganingiz tasdiqlandi</b> — ${time.clock(res.row.checked_in)}\n` +
      `<i>${time.prettyDate(time.today())}</i>\n${distLine}\n` +
      (open.length
        ? `🎯 <b>Bugungi missiyalaringiz (${open.length} ta):</b>\n${ui.missionList(open)}\n\n` +
          (carried.length ? `🔁 Shundan <b>${carried.length} tasi</b> oldingi kunlardan qolgan.\n\n` : '') +
          `Har birini bajargach «✔️ Bajardim» tugmasi bilan belgilang.`
        : `📭 Bugunga yozilgan missiya yo'q. «➕ Missiya qo'shish» orqali qo'shing.`),
    { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
  );

  // Guruhga e'lon
  await notify.toGroup(
    { telegram: ctx.telegram },
    `🟢 ${reports.mentionHtml(emp)} <b>ishga keldi</b> · ${time.clock(res.row.checked_in)}\n` +
      (open.length
        ? `\n🎯 Bugungi missiyalari (${open.length} ta):\n${ui.missionList(open)}`
        : `\n<i>Bugunga missiya yozilmagan.</i>`),
  );

  // Boshqaruvchi(lar)ga shaxsiy xabar + bugungi missiyalar
  const admins = await employees.listAdmins();
  const text = managerCheckinText(emp, open, res.row);
  for (const adm of admins) {
    if (Number(adm.tg_id) === Number(emp.tg_id)) continue; // o'ziga yubormaymiz
    await notify.toUser({ telegram: ctx.telegram }, adm.tg_id, text);
  }
};

/** Joylashuv so'ralganda "Bekor qilish" bosilsa */
const cancelCheckin = async (ctx) => {
  session.clear(ctx.from.id);
  return ctx.reply('Bekor qilindi.', ui.mainKeyboard(ctx.state.isAdmin));
};

/** Bajarilgan ishlar ro'yxatini ✅ chizib beradi */
const doneListHtml = (done) =>
  done.length ? done.map((m) => `   ✅ ${ui.esc(m.title)}`).join('\n') : '   <i>— hech narsa —</i>';

const doCheckOut = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);

  const row = await attendance.checkOut(emp.id);
  const done = await missions.doneOn(emp.id);
  const open = await missions.openFor(emp.id);
  const pending = await missions.pendingFor(emp.id);

  await ctx.reply(
    `🏁 <b>Ish kuni yakunlandi</b> — ${time.clock(row.checked_out)}\n\n` +
      `✅ <b>Bugun bajardingiz (${done.length} ta):</b>\n${doneListHtml(done)}\n\n` +
      (open.length
        ? `⏳ <b>Bajarilmadi (${open.length} ta)</b> — ertangi kunga o'tadi:\n${ui.missionList(open)}\n\n`
        : `🎉 Barcha missiyalar bajarildi. Barakalla! 👏\n\n`) +
      (pending.length
        ? `📅 Keyingi kunlarga yozib qo'ygan missiyalaringiz: <b>${pending.length} ta</b>\n\n`
        : `📝 <b>Ertangi missiyalaringizni hozir yozib qo'ying</b> — «➕ Missiya qo'shish».\n\n`) +
      `Ertaga kelganingizda «✅ Ishga keldim» tugmasini bosishni unutmang.`,
    { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
  );

  // Guruhga — bajargan ishlari ro'yxati bilan
  await notify.toGroup(
    { telegram: ctx.telegram },
    `🏁 ${reports.mentionHtml(emp)} <b>ishdan ketdi</b> · ${time.clock(row.checked_out)}\n` +
      `✅ <b>Bajardi (${done.length} ta):</b>\n${doneListHtml(done)}` +
      (open.length ? `\n\n⏳ Ertaga o'tadigan (${open.length} ta):\n${ui.missionList(open)}` : ''),
  );

  // Boshqaruvchi(lar)ga — kim ketdi va nima bajardi
  const admins = await employees.listAdmins();
  const admText =
    `🏁 <b>${ui.esc(emp.full_name)}</b>${emp.position ? ` (${ui.esc(emp.position)})` : ''} ` +
    `ishdan ketdi · ${time.clock(row.checked_out)}\n\n` +
    `✅ <b>Bajargan ishlari (${done.length} ta):</b>\n${doneListHtml(done)}` +
    (open.length ? `\n\n⏳ Bajarilmagan (${open.length} ta):\n${ui.missionList(open)}` : '');
  for (const adm of admins) {
    if (Number(adm.tg_id) === Number(emp.tg_id)) continue;
    await notify.toUser({ telegram: ctx.telegram }, adm.tg_id, admText);
  }
};

/** 8:55 dagi "Ishga kelyapsizmi?" so'roviga javob */
const onIntent = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("Ro'yxatdan o'tmagansiz");

  if (await attendance.isCheckedIn(emp.id)) {
    await ctx.answerCbQuery('Siz allaqachon ishga kelgansiz');
    try {
      await ctx.editMessageText('✅ Siz allaqachon ishga kelgansiz. Rahmat!');
    } catch { /* noop */ }
    return;
  }

  const answer = ctx.match[1]; // 'yes' | 'no'
  await attendance.setIntent(emp.id, answer);
  await ctx.answerCbQuery(answer === 'yes' ? 'Rahmat!' : 'Qabul qilindi');

  if (answer === 'yes') {
    try {
      await ctx.editMessageText(
        `✅ <b>Yaxshi, kutamiz!</b>\n\nIshga kelganingizda «✅ Ishga keldim» tugmasini bosib, joylashuvingizni yuboring.`,
        { parse_mode: 'HTML' },
      );
    } catch { /* noop */ }
    return;
  }

  try {
    await ctx.editMessageText("Tushunarli, ma'lumot uchun rahmat.");
  } catch { /* noop */ }

  await notify.toGroup(
    { telegram: ctx.telegram },
    `🔴 ${reports.mentionHtml(emp)} <b>bugun ishga kelmasligini</b> bildirdi.`,
  );
};

const register = (bot) => {
  bot.hears(ui.BTN.checkIn, doCheckIn);
  bot.command(['keldim', 'ishga_keldim'], doCheckIn);
  bot.hears(ui.BTN.cancelLocation, cancelCheckin);
  bot.on('location', onLocation);

  bot.hears(ui.BTN.checkOut, doCheckOut);
  bot.command(['ketdim', 'ishdan_ketdim'], doCheckOut);

  bot.action(/^intent:(yes|no)$/, onIntent);
};

module.exports = { register, onLocation };
