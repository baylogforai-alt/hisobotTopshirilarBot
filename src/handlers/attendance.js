'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const session = require('../session');
const { render } = require('../render');
const tasks = require('../services/tasks');
const attendance = require('../services/attendance');
const employees = require('../services/employees');
const office = require('../services/office');
const notify = require('../services/notify');
const reports = require('../services/reports');
const activity = require('../services/activity');
const dailyReports = require('../services/dailyReports');
const { notRegistered } = require('./common');

const { esc } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

// ---------------------------------------------------------------------------
// KELDIM
// ---------------------------------------------------------------------------

const doCheckIn = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz — davomat faqat hodimlar uchun.") : notRegistered(ctx);

  const row = await attendance.get(emp.id);
  if (row && row.checked_in) {
    const open = await tasks.openFor(emp.id);
    activity.mark(ctx, 'checkin_repeat', { detail: `allaqachon kelgan (${time.clock(row.checked_in)})` });
    return ctx.reply(
      `ℹ️ Siz bugun allaqachon kelgansiz (${time.clock(row.checked_in)}).\n\n<b>Ochiq missiyalar (${open.length}):</b>\n${ui.taskList(open)}`,
      { parse_mode: 'HTML', ...ui.kbFor(ctx) },
    );
  }
  session.set(ctx.from.id, { step: 'awaiting_checkin_location' });
  return ctx.reply(
    `📍 <b>Ishga kelganingizni tasdiqlang</b>\n\nPastdagi <b>«${ui.BTN.sendLocation}»</b> tugmasini bosing — bot hozirgi joylashuvingizni ofis bilan solishtiradi.\n\n` +
      `<i>⚠️ Faqat shu tugma orqali yuborilgan joriy joylashuv qabul qilinadi; xaritadan tanlangan yoki forward qilingan joylashuv rad etiladi.</i>`,
    { parse_mode: 'HTML', ...ui.locationKeyboard() },
  );
};

const askLateReason = (ctx, lateMinutes) => {
  session.set(ctx.from.id, { step: 'late_reason' });
  return ctx.reply(
    `⏰ Siz bugun <b>${time.prettyDuration(lateMinutes)}</b> kech keldingiz.\n\nSababini qisqacha yozing (boshliq ko'radi) yoki «${ui.BTN.skip}».`,
    { parse_mode: 'HTML', ...ui.skipKeyboard() },
  );
};

const handleLateReason = async (ctx, { skip = false } = {}) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  if (skip) return ctx.reply('Tushunarli. Yaxshi ish kuni tilayman! 💪', ui.kbFor(ctx));
  const reason = ctx.message.text.trim().slice(0, 300);
  const row = await attendance.setLateReason(emp.id, reason);
  activity.mark(ctx, 'late_reason', { title: reason });
  await ctx.reply('✅ Sabab qayd etildi. Yaxshi ish kuni tilayman! 💪', ui.kbFor(ctx));
  await notify.toReviewers(botOf(ctx), emp, `💬 <b>${esc(emp.full_name)}</b> kechikish sababi (${time.prettyDuration(Number(row.late_minutes))}):\n«${esc(reason)}»`);
};

const onLocation = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const s = session.get(ctx.from.id);

  if (s.step === 'awaiting_office_location') {
    if (!ctx.state.isAdmin) { session.clear(ctx.from.id); return; }
    if (!ctx.message.location) return;
    const radius = s.radius || office.DEFAULT_RADIUS;
    await office.set(ctx.message.location.latitude, ctx.message.location.longitude, radius);
    session.clear(ctx.from.id);
    activity.mark(ctx, 'admin', { title: 'Ofis joylashuvi belgilandi', detail: `radius ${radius} m` });
    return ctx.reply(
      `✅ <b>Ofis joylashuvi saqlandi.</b> Radius: <b>${geo.prettyDistance(radius)}</b>.\nEndi hodimlar faqat shu joydan «${ui.BTN.checkIn}» qila oladi.\n\nRadiusni o'zgartirish: <code>/ofis_radius 300</code>`,
      { parse_mode: 'HTML', ...ui.kbFor(ctx) },
    );
  }

  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  if (s.step !== 'awaiting_checkin_location') return ctx.reply(`Avval «${ui.BTN.checkIn}» tugmasini bosing.`, ui.kbFor(ctx));

  if (ctx.message.forward_date || ctx.message.forward_origin || ctx.message.forward_from) {
    activity.mark(ctx, 'checkin_far', { detail: 'forward qilingan joylashuv' });
    return ctx.reply(`❌ Bu joylashuv boshqa joydan yuborilgan. «${ui.BTN.sendLocation}» tugmasini bosing.`, ui.locationKeyboard());
  }
  const loc = ctx.message.location;
  if (!loc) return;

  const officeConf = await office.get();
  let dist = null;
  if (officeConf) {
    dist = geo.distanceMeters(officeConf.lat, officeConf.lon, loc.latitude, loc.longitude);
    if (!employees.isFlexible(emp) && dist > officeConf.radius) {
      activity.mark(ctx, 'checkin_far', { detail: `ofisdan ${geo.prettyDistance(dist)}` });
      return ctx.reply(
        `❌ <b>Siz ofisdan uzoqdasiz</b> (${geo.prettyDistance(dist)}). Ruxsat: ${geo.prettyDistance(officeConf.radius)}.\nOfisga yetib borgach qaytadan «${ui.BTN.checkIn}» bosing.`,
        { parse_mode: 'HTML', ...ui.kbFor(ctx) },
      );
    }
  }

  const res = await attendance.checkIn(emp, { lat: loc.latitude, lon: loc.longitude, dist });
  session.clear(ctx.from.id);
  if (res.already) return ctx.reply('ℹ️ Siz allaqachon kelgansiz.', ui.kbFor(ctx));

  const isLate = res.late > 0 && !employees.isFlexible(emp);
  const open = await tasks.openFor(emp.id);
  activity.mark(ctx, 'checkin', { title: `Ishga keldi: ${time.clock(res.row.checked_in)}`, detail: `${dist != null ? `ofisdan ${geo.prettyDistance(dist)}` : ''}${isLate ? ` · ${time.prettyDuration(res.late)} kech` : ''}`.trim() || null });
  await ctx.reply(
    `✅ <b>Kelganingiz qayd etildi</b> — ${time.clock(res.row.checked_in)}${isLate ? ` ⏰ <i>${time.prettyDuration(res.late)} kech</i>` : ''}\n` +
      `<i>${time.prettyDate(time.today())}</i>${dist != null ? ` · 📍 ofisdan ${geo.prettyDistance(dist)}` : ''}\n\n` +
      (open.length ? `📋 <b>Bugungi missiyalar (${open.length}):</b>\n${ui.taskList(open)}\n\nBajargach «${ui.BTN.done}» bilan belgilang.` : `📭 Hozircha ochiq missiya yo'q. «${ui.BTN.selfTask}» bilan reja yozing.`),
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );

  const line = `🟢 <b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''} ishga keldi · ${time.clock(res.row.checked_in)}${reports.lateTag(res.row)}` +
    (dist != null ? ` · 📍 ${geo.prettyDistance(dist)}` : '');
  await notify.toReviewers(botOf(ctx), emp, `${line}${open.length ? `\n📋 ochiq: ${open.length}${open.some((t) => t.due_date < time.today()) ? ' (🔴 kechikkan bor)' : ''}` : ''}`);
  if (config.announceDone) await notify.toGroup(botOf(ctx), `${line}${open.length ? `\n🎯 Bugungi missiyalari: ${open.length} ta` : ''}`);

  if (isLate && config.askLateReason) return askLateReason(ctx, res.late);
};

// ---------------------------------------------------------------------------
// KETDIM
// ---------------------------------------------------------------------------

const doCheckOut = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  if (!(await attendance.isCheckedIn(emp.id))) return ctx.reply(`ℹ️ Bugun «${ui.BTN.checkIn}» qilmagansiz.`, ui.kbFor(ctx));
  if (await attendance.isCheckedOut(emp.id)) {
    const r = await attendance.get(emp.id);
    return ctx.reply(`ℹ️ Ketganingiz allaqachon belgilangan (${time.clock(r.checked_out)}).`, ui.kbFor(ctx));
  }
  const row = await attendance.checkOut(emp.id);
  const worked = attendance.workedMinutes(row);
  const done = await tasks.doneOn(emp.id);
  const open = await tasks.openFor(emp.id);
  activity.mark(ctx, 'checkout', { title: `Ishdan ketdi: ${time.clock(row.checked_out)}`, detail: `${done.length} ta bajarildi, ${open.length} ta qoldi` });
  await ctx.reply(
    `🏁 <b>Ish kuni yakunlandi</b> — ${time.clock(row.checked_out)}${worked !== null ? ` · ⏱ ${time.prettyDuration(worked)}` : ''}\n\n` +
      `✅ Bugun bajardingiz: <b>${done.length}</b> ta\n` +
      (open.length ? `⏳ Ochiq qoldi (${open.length}) — ertangi ro'yxatda turadi:\n${ui.taskList(open)}` : `🎉 Ochiq missiya qolmadi. Barakalla!`),
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );
  const summary = `🏁 <b>${esc(emp.full_name)}</b> ketdi · ${time.clock(row.checked_out)}${worked !== null ? ` · ⏱ ${time.prettyDuration(worked)}` : ''} · ✅ ${done.length} · ⏳ ${open.length}`;
  await notify.toReviewers(botOf(ctx), emp, summary);
  if (config.announceDone) await notify.toGroup(botOf(ctx), summary);

  // Kunlik hisobot hali topshirilmagan bo'lsa — hozir so'raymiz
  if (config.dailyReportRequired && !(await dailyReports.get(emp.id))) {
    return require('./dailyReport').askReport(ctx, { afterCheckout: true });
  }
};

// ---------------------------------------------------------------------------
// KELMAYMAN (sababli kun so'rovi)
// ---------------------------------------------------------------------------

const startAbsence = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  if (await attendance.isCheckedIn(emp.id)) return ctx.reply('ℹ️ Siz bugun allaqachon kelgansiz.', ui.kbFor(ctx));
  const row = await attendance.get(emp.id);
  if (row && row.excuse_status === 'approved') return ctx.reply('ℹ️ Bugungi kun allaqachon sababli deb belgilangan.', ui.kbFor(ctx));
  session.set(ctx.from.id, { step: 'absence_reason' });
  return ctx.reply(
    `🙋 <b>Bugun (${time.prettyDate(time.today())}) kelmaslik sababini yozing.</b>\nMasalan: kasal bo'ldim, ta'til, komandirovka, oilaviy sabab.\n\nBoshliq tasdiqlasa — kun sababli hisoblanadi (KPI ga ta'sir qilmaydi).`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const handleAbsenceReason = async (ctx) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  const reason = ctx.message.text.trim().slice(0, 300);
  const row = await attendance.requestExcuse(emp.id, reason);
  activity.mark(ctx, 'absence', { title: reason });
  await ctx.reply(`📨 So'rov yuborildi: «${esc(reason)}». Boshliq ko'rib chiqadi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  await notify.toReviewers(
    botOf(ctx), emp,
    `🙋 <b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''} bugun kelmasligini bildirdi:\n«${esc(reason)}»\n\nSababli deb hisoblaymizmi?`,
    ui.excuseKeyboard(row.id),
  );
};

const onExcuseDecision = async (ctx) => {
  const [, verdict, id] = ctx.match;
  const row = await attendance.byId(id);
  if (!row) return ctx.answerCbQuery('Topilmadi');
  const emp = await employees.byId(row.employee_id);
  if (!employees.canManage(ctx.state.employee, ctx.state.isAdmin, emp) || Number(emp.id) === Number(ctx.state.employee && ctx.state.employee.id)) {
    return ctx.answerCbQuery("⛔️ Bu sizning bo'limingiz emas");
  }
  const status = verdict === 'ok' ? 'approved' : 'rejected';
  await attendance.decideExcuse(emp.id, row.work_date, status, ctx.from.id);
  await ctx.answerCbQuery(status === 'approved' ? 'Sababli' : 'Sababsiz');
  await render(ctx, `${status === 'approved' ? '✅ Sababli' : '❌ Sababsiz'} — <b>${esc(emp.full_name)}</b>, ${time.prettyDate(row.work_date)}${row.excuse_reason ? `\n«${esc(row.excuse_reason)}»` : ''}`);
  await notify.toUser(
    botOf(ctx), emp.tg_id,
    status === 'approved'
      ? `✅ ${time.prettyDate(row.work_date)} kuni <b>sababli</b> deb tasdiqlandi.`
      : `❌ ${time.prettyDate(row.work_date)} uchun so'rovingiz tasdiqlanmadi — kun <b>kelmagan</b> hisoblanadi.`,
  );
};

// ---------------------------------------------------------------------------
// "ISHGA KELYAPSIZMI?" (ertalabki so'rov, cron)
// ---------------------------------------------------------------------------

const onIntent = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("Ro'yxatda yo'qsiz");
  const answer = ctx.match[1];
  if (await attendance.isCheckedIn(emp.id)) { await ctx.answerCbQuery('Siz allaqachon kelgansiz'); return render(ctx, '✅ Siz allaqachon ishga kelgansiz.'); }
  await attendance.setIntent(emp.id, answer);
  activity.mark(ctx, answer === 'yes' ? 'intent_yes' : 'intent_no');
  await ctx.answerCbQuery(answer === 'yes' ? 'Rahmat!' : 'Qabul qilindi');
  if (answer === 'yes') return render(ctx, `✅ <b>Yaxshi, kutamiz!</b>\n\nIshga kelganingizda «${ui.BTN.checkIn}» tugmasini bosib, joylashuvingizni yuboring.`);
  await render(ctx, `Tushunarli, ma'lumot uchun rahmat.\n\n<i>Sababli kun bo'lishi uchun «${ui.BTN.absence}» tugmasi orqali sababini yozing — boshliq tasdiqlaydi.</i>`);
  await notify.toReviewers(botOf(ctx), emp, `🙅 <b>${esc(emp.full_name)}</b> bugun ishga <b>kelmasligini</b> bildirdi.`);
  if (config.announceDone) await notify.toGroup(botOf(ctx), `🔴 ${reports.mentionHtml(emp)} <b>bugun ishga kelmasligini</b> bildirdi.`);
};

/** Bekor qilish — istalgan matn/joylashuv bosqichini to'xtatadi */
const cancelStep = async (ctx) => {
  session.clear(ctx.from.id);
  if (!ctx.state.employee && !ctx.state.isAdmin) return ctx.reply('Bekor qilindi.', { reply_markup: { remove_keyboard: true } });
  return ctx.reply('Bekor qilindi.', ui.kbFor(ctx));
};

const register = (bot) => {
  bot.hears(ui.BTN.checkIn, doCheckIn);
  bot.command(['keldim', 'ishga_keldim'], doCheckIn);
  bot.hears(ui.BTN.checkOut, doCheckOut);
  bot.command(['ketdim', 'ishdan_ketdim'], doCheckOut);
  bot.hears(ui.BTN.absence, startAbsence);
  bot.command('kelmayman', startAbsence);
  bot.hears(ui.BTN.cancel, cancelStep);
  bot.on('location', onLocation);
  bot.action(/^ab:(ok|no):(\d+)$/, onExcuseDecision);
  bot.action(/^intent:(yes|no)$/, onIntent);
};

module.exports = { register, onLocation, handleLateReason, handleAbsenceReason, cancelStep };
