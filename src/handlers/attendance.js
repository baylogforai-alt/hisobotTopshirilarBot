'use strict';

const ui = require('../ui');
const time = require('../time');
const missions = require('../services/missions');
const attendance = require('../services/attendance');
const notify = require('../services/notify');
const reports = require('../services/reports');
const { notRegistered } = require('./common');

const doCheckIn = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);

  const res = await attendance.checkIn(emp.id);
  await missions.activateDue(emp.id);
  const open = await missions.openFor(emp.id);
  const carried = open.filter((m) => m.start_date < time.today());

  if (res.already) {
    return ctx.reply(
      `ℹ️ Siz bugun allaqachon ishga kelgansiz (${time.clock(res.row.checked_in)}).\n\n` +
        `<b>Bugungi missiyalar (${open.length} ta):</b>\n${ui.missionList(open)}`,
      { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
    );
  }

  await ctx.reply(
    `✅ <b>Ishga kelganingiz qayd etildi</b> — ${time.clock(res.row.checked_in)}\n` +
      `<i>${time.prettyDate(time.today())}</i>\n\n` +
      (open.length
        ? `🎯 <b>Bugungi missiyalaringiz (${open.length} ta):</b>\n${ui.missionList(open)}\n\n` +
          (carried.length ? `🔁 Shundan <b>${carried.length} tasi</b> oldingi kunlardan qolgan.\n\n` : '') +
          `Har birini bajargach «✔️ Bajardim» tugmasi bilan belgilang.`
        : `📭 Bugunga yozilgan missiya yo'q. «➕ Missiya qo'shish» orqali qo'shing.`),
    { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
  );

  await notify.toGroup(
    { telegram: ctx.telegram },
    `🟢 ${reports.mentionHtml(emp)} <b>ishga keldi</b> · ${time.clock(res.row.checked_in)}\n` +
      (open.length
        ? `\n🎯 Bugungi missiyalari (${open.length} ta):\n${ui.missionList(open)}`
        : `\n<i>Bugunga missiya yozilmagan.</i>`),
  );
};

const doCheckOut = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);

  const row = await attendance.checkOut(emp.id);
  const st = await missions.dayStats(emp.id);
  const open = await missions.openFor(emp.id);
  const pending = await missions.pendingFor(emp.id);

  await ctx.reply(
    `🏁 <b>Ish kuni yakunlandi</b> — ${time.clock(row.checked_out)}\n\n` +
      `✅ Bajarildi: <b>${st.done}</b>\n⏳ Bajarilmadi: <b>${st.open}</b>\n\n` +
      (open.length
        ? `Quyidagilar <b>ertangi kunga o'tadi</b>:\n${ui.missionList(open)}\n\n`
        : `Barcha missiyalar bajarildi. Barakalla! 👏\n\n`) +
      (pending.length
        ? `📅 Keyingi kunlarga yozib qo'ygan missiyalaringiz: <b>${pending.length} ta</b>\n\n`
        : `📝 <b>Ertangi missiyalaringizni hozir yozib qo'ying</b> — «➕ Missiya qo'shish».\n\n`) +
      `Ertaga kelganingizda «✅ Ishga keldim» tugmasini bosishni unutmang.`,
    { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
  );

  await notify.toGroup(
    { telegram: ctx.telegram },
    `🏁 ${reports.mentionHtml(emp)} <b>ishdan ketdi</b> · ${time.clock(row.checked_out)}\n` +
      `✅ ${st.done} bajarildi · ⏳ ${st.open} qoldi` +
      (open.length ? `\n\nErtaga o'tadigan ishlar:\n${ui.missionList(open)}` : ''),
  );
};

const register = (bot) => {
  bot.hears(ui.BTN.checkIn, doCheckIn);
  bot.command(['keldim', 'ishga_keldim'], doCheckIn);

  bot.hears(ui.BTN.checkOut, doCheckOut);
  bot.command(['ketdim', 'ishdan_ketdim'], doCheckOut);
};

module.exports = { register };
