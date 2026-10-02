'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const tg = require('../telegram');
const { render } = require('../render');
const employees = require('../services/employees');
const kpi = require('../services/kpi');
const months = require('../services/months');
const notify = require('../services/notify');
const { notRegistered } = require('./common');

const { esc, cb, inline } = ui;

/**
 * OY BOSHI va OYLIK.
 *   ms:ok:<oy>   — hodim yangi ish oyini tasdiqlaydi → oy hisobi (sekundomer) shu paytdan boshlanadi
 *   pay:*        — «💵 Oylik va KPI»: oylar ro'yxati (oklad + KPI = jami) → oy tafsiloti (KPI sharti qanday bajarilyapti)
 */

// ---------------------------------------------------------------------------
// OY BOSHI
// ---------------------------------------------------------------------------

const monthStartText = (emp, month) =>
  `🗓 <b>${time.monthName(month)} — yangi ish oyi boshlandi!</b>\n\n` +
  `Hurmatli <b>${esc(emp.full_name)}</b>, bugundan yangi ish oyi boshlanyapti. Hamma o'z ishini bilib:\n` +
  `✅ har kuni <b>o'z vaqtida</b> kelib «${ui.BTN.checkIn}» qilsin${employees.needsCheckinVideo(emp) ? ' (video bilan)' : ''};\n` +
  `📋 topshiriqlarni <b>muddatida</b> bajarib, botga isbotini qo'yib borsin;\n` +
  (employees.isField(emp) ? `📍 borgan hududlaringizda «${ui.BTN.visit}» orqali video/audio tashlashni unutmang;\n` : '') +
  `🏆 oy davomida vaqtida kelib, vazifalarni o'z vaqtida bajarganlarga <b>KPI</b> beriladi.\n\n` +
  `Hammangizga omad! 💪\n\n👇 Tanishganingizni tasdiqlang — oy hisobi shu paytdan boshlanadi.`;

const monthStartKeyboard = (month) => inline([[cb('✅ Tanishdim, boshladim', `ms:ok:${month}`)]]);

/** Keldim / tashrifdan oldin tasdiqlanmagan bo'lsa */
const promptMonthStart = (ctx, emp) => {
  const month = time.month();
  return ctx.reply(`⛔️ Avval yangi ish oyini tasdiqlang — shundan keyin «${ui.BTN.checkIn}» ochiladi.\n\n${monthStartText(emp, month)}`, {
    parse_mode: 'HTML', ...monthStartKeyboard(month),
  });
};

const onConfirm = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz", { show_alert: true });
  const month = ctx.match[1];
  if (month !== time.month()) {
    await ctx.answerCbQuery('Bu xabar eskirgan');
    return promptMonthStart(ctx, emp);
  }
  const { row, created } = await months.confirm(emp.id, month);
  await ctx.answerCbQuery(created ? 'Oy boshlandi! Omad!' : 'Allaqachon tasdiqlangan');
  await render(
    ctx,
    `✅ <b>${time.monthName(month)}</b> — tasdiqlandi.\n⏱ Oy hisobi boshlandi: <b>${time.shortDate(String(row.confirmed_at).slice(0, 10))} ${time.clock(row.confirmed_at)}</b>\n\nOmad! 💪`,
  );
  return ctx.reply(`Endi «${ui.BTN.checkIn}» ochiq.`, ui.kbFor(ctx));
};

/** Cron: 1-kuni 9:00 — hammaga (va guruhga) yangi oy xabari */
const sendMonthStart = async (bot, month = time.month()) => {
  let sent = 0;
  for (const e of await employees.listStaff()) {
    if (await months.isConfirmed(e.id, month)) continue;
    if (await notify.toUser(bot, e.tg_id, monthStartText(e, month), monthStartKeyboard(month))) sent += 1;
    await tg.throttle();
  }
  await notify.toGroup(
    bot,
    `🗓 <b>${time.monthName(month)} — yangi ish oyi boshlandi!</b>\n\nHamma o'z vaqtida kelib, vazifalarni muddatida bajarib, isbotini botga qo'yishni unutmasin. ` +
      `Har kim botdagi xabarni tasdiqlasin — oy hisobi shundan boshlanadi.\n\nHammangizga omad! 💪`,
  );
  return sent;
};

// ---------------------------------------------------------------------------
// OYLIK VA KPI
// ---------------------------------------------------------------------------

const money = kpi.fmtMoney;

/** Oy uchun: oklad, KPI summasi, shart, jami (tasdiqlanmagan bo'lsa — taxminiy) */
const payInfo = (k) => {
  const salary = k.salary === null || k.salary === undefined ? null : Number(k.salary);
  const final = k.status !== 'draft';
  const bonus = k.status === 'excluded' ? 0 : k.bonus_amount === null || k.bonus_amount === undefined ? null : Number(k.bonus_amount);
  const total = (salary || 0) + (bonus || 0);
  return { salary, bonus, total, final };
};

const monthsOf = (emp) => {
  const cur = time.month();
  const first = String(emp.created_at || '').slice(0, 7);
  const list = [];
  for (let i = 0; i < 6; i += 1) {
    const m = time.shiftMonth(cur, -i);
    if (first && m < first) break;
    list.push(m);
  }
  return list;
};

const payHome = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  if (employees.isBoss(emp)) return ctx.reply("ℹ️ Siz kompaniya rahbarisiz — oylik va KPI siz uchun hisoblanmaydi.", ui.kbFor(ctx));
  const lines = [];
  const rows = [];
  for (const m of monthsOf(emp)) {
    const k = await kpi.compute(emp, m);
    const p = payInfo(k);
    const gate = config.kpiMode === 'gate' ? (Number(k.kpi_eligible) === 1 ? '✅' : '❌') : `${k.total} ball`;
    lines.push(
      `🗓 <b>${time.monthName(m)}</b>${m === time.month() ? ' <i>(joriy)</i>' : ''}\n` +
        `   💼 ${money(p.salary)} · 🏆 KPI ${gate} ${money(p.bonus)}\n` +
        `   💰 Jami: <b>${money(p.total)}</b> ${p.final ? kpi.statusLabel(k.status) : '<i>taxminiy</i>'}`,
    );
    rows.push([cb(`🗓 ${time.monthName(m)}`, `pay:m:${m}`)]);
  }
  return render(ctx, `💵 <b>OYLIK VA KPI</b> — ${esc(emp.full_name)}\n${ui.LINE}\n${lines.join('\n\n') || "<i>ma'lumot yo'q</i>"}\n\n👇 Batafsil — oyni tanlang.`, inline(rows));
};

const limitLine = (icon, label, value, max) => `   ${value > max ? '❌' : '✅'} ${icon} ${label}: <b>${value}</b>${max ? ` (ruxsat ${max})` : ''}`;

const payMonth = async (ctx, month) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  if (!time.isValidMonth(month)) return payHome(ctx);
  const k = await kpi.compute(emp, month);
  const p = payInfo(k);
  const ms = await months.get(emp.id, month);
  const current = month === time.month();
  const lines = [`💵 <b>Oylik va KPI — ${time.monthName(month)}</b>`];
  if (ms) {
    lines.push(`⏱ Oy hisobi: ${time.shortDate(String(ms.confirmed_at).slice(0, 10))} ${time.clock(ms.confirmed_at)} dan${current ? ` · <b>${months.elapsedText(ms.confirmed_at)}</b> o'tdi` : ''}`);
  } else if (config.monthStartRequired) {
    lines.push('⏱ <i>Oy boshi tasdiqlanmagan</i>');
  }
  lines.push(ui.LINE, `💼 Oklad: <b>${money(p.salary)}</b>`, `🏆 KPI summasi: <b>${money(k.bonus_fund)}</b>`);

  if (config.kpiMode === 'gate') {
    const ok = Number(k.kpi_eligible) === 1;
    lines.push(
      '',
      `<b>KPI sharti</b> — oy davomida vaqtida kelish va topshiriqlarni muddatida bajarish:`,
      limitLine('🕘', 'Kech kelgan kunlar', Number(k.late_days), config.kpiMaxLate),
      limitLine('🔴', 'Sababsiz kelmagan kunlar', Number(k.absent_days), config.kpiMaxAbsent),
      limitLine('📋', 'Muddatida bajarilmagan topshiriqlar', Number(k.tasks_missed) || 0, config.kpiMaxMissedTasks),
      `   📄 Sababli kunlar: ${k.excused_days}${config.kpiExcusedOk ? ' (KPI ga ta\'sir qilmaydi)' : ''}`,
      '',
      ok
        ? current ? `✅ <b>Hozircha shart bajarilyapti</b> — shu tarzda davom eting!` : `✅ <b>Shart bajarildi</b>`
        : `❌ <b>KPI berilmaydi</b>: ${esc(k.kpi_fail || '')}`,
    );
  } else {
    lines.push(`🏆 KPI ball: <b>${k.total}</b> ${ui.pctBar(k.total)}`);
  }
  if (k.status === 'excluded') lines.push(`⛔ Bu oy KPI dan chiqarilgan${k.note ? `: ${esc(k.note)}` : ''}`);
  lines.push(ui.LINE, `💰 <b>Jami: ${money(p.total)}</b> ${p.final ? kpi.statusLabel(k.status) : '<i>(taxminiy — oy yakunida direktor tasdiqlaydi)</i>'}`);
  if (k.note && k.status !== 'excluded') lines.push(`💬 ${esc(k.note)}`);
  return render(ctx, lines.join('\n'), inline([[cb('📊 Batafsil hisobot', `rp:me:${month}`), cb('⬅️ Oylar', 'pay:home')]]));
};

const register = (bot) => {
  bot.action(/^ms:ok:(\d{4}-\d{2})$/, onConfirm);
  bot.hears(ui.BTN.salary, payHome);
  bot.command('oylik', payHome);
  bot.action('pay:home', async (ctx) => { await ctx.answerCbQuery(); return payHome(ctx); });
  bot.action(/^pay:m:(\d{4}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); return payMonth(ctx, ctx.match[1]); });
};

module.exports = { register, promptMonthStart, monthStartText, monthStartKeyboard, sendMonthStart, payHome, payMonth };
