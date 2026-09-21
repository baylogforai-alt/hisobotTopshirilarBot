'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const { render, guard } = require('../render');
const employees = require('../services/employees');
const excel = require('../services/excel');
const notify = require('../services/notify');
const activity = require('../services/activity');
const { notRegistered } = require('./common');

const { esc, cb, inline, LINE } = ui;

/**
 * «EXCEL YUKLAB OLISH» — ikki bosishda tayyor fayl.
 *   1-qadam: DAVR   — bugun · shu hafta · o'tgan hafta · shu oy · o'tgan oy
 *   2-qadam: KIM    — butun jamoa (bitta fayl) · har bir hodim alohida · bitta hodim
 * Oy — kalendar oy. Hodimlar uchun (/excel) faqat o'zining fayli.
 */

const PERIODS = {
  today: { icon: '📅', name: 'Bugun', range: () => [time.today(), time.today()] },
  week: { icon: '📆', name: 'Shu hafta', range: () => [time.startOfWeek(time.today()), time.today()] },
  lastweek: { icon: '📆', name: "O'tgan hafta", range: () => { const d = time.addDays(time.startOfWeek(time.today()), -1); return [time.startOfWeek(d), time.endOfWeek(d)]; } },
  month: { icon: '🗓', name: 'Shu oy', range: () => [time.startOfMonth(time.today()), time.today()] },
  lastmonth: { icon: '🗓', name: "O'tgan oy", range: () => { const d = time.addDays(time.startOfMonth(time.today()), -1); return [time.startOfMonth(d), time.endOfMonth(d)]; } },
};

const resolve = (key) => {
  const p = PERIODS[key];
  if (!p) return null;
  const [from, to] = p.range();
  const days = time.daysIn(from, to);
  const title = key === 'month' || key === 'lastmonth' ? `${p.name} — ${time.monthLabel(from)}` : p.name;
  return { key, from, to, days, name: p.name, icon: p.icon, title };
};

const periodLabel = (key) => {
  const r = resolve(key);
  if (key === 'today') return `${r.icon} ${r.name} · ${time.shortDate(r.from)}`;
  if (key === 'month' || key === 'lastmonth') return `${r.icon} ${r.name} · ${time.monthLabel(r.from).split(' ')[0]} (${r.days} kun)`;
  return `${r.icon} ${r.name} · ${time.shortDate(r.from)}–${time.shortDate(r.to)} (${r.days} kun)`;
};

const periodText = (r) => `${time.prettyRange(r.from, r.to)} · <b>${r.days} kun</b>`;
const sendDoc = (ctx, file, caption) => notify.docToUser({ telegram: ctx.telegram }, ctx.from.id, file.buffer, file.filename, caption);

const employeeFile = (emp, r) => (r.key === 'today' ? excel.buildDay(r.from, { employeeId: emp.id }) : excel.buildEmployeePeriod(emp, r.from, r.to));
const employeeCaption = (emp, r) =>
  `📥 <b>${esc(emp.full_name)}</b> — ${esc(r.title)}\n🗓 ${periodText(r)}\n` +
  (r.key === 'today' ? '<i>Bugungi missiyalari, davomati va kunlik hisoboti</i>' : '<i>Varaqlar: Xulosa · Bajarilgan ishlar · Kunlar · Missiyalar · Kunlik hisobotlar · Harakatlar</i>');
const teamFile = (r) => (r.key === 'today' ? excel.buildDay(r.from) : excel.buildTeamPeriod(r.from, r.to));
const teamCaption = (r) =>
  `📥 <b>${esc(config.companyName)}</b> — butun jamoa, ${esc(r.title)}\n🗓 ${periodText(r)}\n` +
  (r.key === 'today' ? '<i>Har bir hodimning bugungi ishlari, davomati va kunlik hisobotlari</i>' : '<i>Varaqlar: Jamlanma · Kunlar · Missiyalar · Kechikkanlar · Bajarilganlar · Kunlik hisobotlar</i>');

// 1) ADMIN: davrni tanlash
const periodKeyboard = (empId = null) => {
  const data = (key) => `xl:p:${key}${empId ? `:${empId}` : ''}`;
  return inline([
    [cb(periodLabel('today'), data('today'))],
    [cb(periodLabel('week'), data('week'))],
    [cb(periodLabel('lastweek'), data('lastweek'))],
    [cb(periodLabel('month'), data('month'))],
    [cb(periodLabel('lastmonth'), data('lastmonth'))],
    [cb("🗓 Boshqa sana oralig'i (kalendar)", 'pr:period')],
    [cb('⬅️ Orqaga', empId ? `hr:d:${empId}:${time.today()}` : 'adm:home')],
  ]);
};

const showHome = async (ctx, empId = null) => {
  if (!(await guard(ctx))) return null;
  let who = '';
  if (empId) {
    const emp = await employees.byId(empId);
    if (!emp) return render(ctx, '❌ Hodim topilmadi.', periodKeyboard());
    who = `👤 <b>${esc(emp.full_name)}</b>\n\n`;
  }
  return render(ctx,
    `📥 <b>EXCEL YUKLAB OLISH</b>\n${LINE}\n\n${who}<b>1-qadam:</b> qaysi davr uchun?\n\n<i>Oy — kalendar oy: 30 kunlik oyda 30 kun, 31 kunlik oyda 31 kun chiqadi. Hafta dushanbadan boshlanadi.</i>`,
    periodKeyboard(empId));
};

// 2) ADMIN: kimni
const showWho = async (ctx, key) => {
  if (!(await guard(ctx))) return null;
  const r = resolve(key);
  if (!r) return showHome(ctx);
  const list = await employees.listActive();
  const rows = [
    [cb('🏢 Butun jamoa — bitta fayl', `xl:s:${key}:team`)],
    [cb(`👥 Har bir hodim alohida — ${list.length} ta fayl`, `xl:s:${key}:each`)],
  ];
  list.forEach((e) => rows.push([cb(`👤 ${e.full_name}`, `xl:s:${key}:${e.id}`)]));
  rows.push([cb("⬅️ Davrni o'zgartirish", 'xl:home')]);
  return render(ctx,
    `📥 <b>EXCEL YUKLAB OLISH</b>\n${LINE}\n\n🗓 <b>Davr:</b> ${esc(r.title)}\n      ${periodText(r)}\n\n<b>2-qadam:</b> kimning hisoboti?\n\n` +
      `🏢 <b>Butun jamoa</b> — hamma hodim bitta faylda\n👥 <b>Har bir hodim alohida</b> — har biriga o'zining to'liq fayli\n👤 <b>Bitta hodim</b> — faqat o'shaning fayli`,
    inline(rows));
};

// 3) ADMIN: yuborish
const send = async (ctx, key, scope) => {
  if (!(await guard(ctx))) return null;
  const r = resolve(key);
  if (!r) return showHome(ctx);
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('📥 Fayl tayyorlanmoqda…');
  activity.mark(ctx, 'excel', { title: `Excel: ${r.title}`, detail: `${r.from} → ${r.to} · ${scope}` });
  if (scope === 'team') return sendDoc(ctx, await teamFile(r), teamCaption(r));
  if (scope === 'each') {
    const list = await employees.listActive();
    if (!list.length) return ctx.reply("Hodimlar ro'yxati bo'sh.");
    await ctx.reply(`📥 <b>${list.length} ta fayl</b> tayyorlanmoqda — ${esc(r.title)} (${r.days} kun).`, { parse_mode: 'HTML' });
    let sent = 0;
    for (const emp of list) if (await sendDoc(ctx, await employeeFile(emp, r), employeeCaption(emp, r))) sent += 1;
    return ctx.reply(`✅ ${sent} / ${list.length} ta fayl yuborildi.`);
  }
  const emp = await employees.byId(Number(scope));
  if (!emp) return ctx.reply('❌ Hodim topilmadi.');
  return sendDoc(ctx, await employeeFile(emp, r), employeeCaption(emp, r));
};

// 4) HODIM: o'z fayli (/excel)
const myKeyboard = () =>
  inline([
    [cb(periodLabel('today'), 'xlme:today')], [cb(periodLabel('week'), 'xlme:week')], [cb(periodLabel('lastweek'), 'xlme:lastweek')],
    [cb(periodLabel('month'), 'xlme:month')], [cb(periodLabel('lastmonth'), 'xlme:lastmonth')],
  ]);

const showMine = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) {
    if (ctx.updateType === 'callback_query') return ctx.answerCbQuery("Ro'yxatda yo'qsiz");
    return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  }
  return render(ctx, `📥 <b>MENING EXCEL HISOBOTIM</b>\n${LINE}\n\n👤 <b>${esc(emp.full_name)}</b>\n\nQaysi davr uchun yuklab olamiz?`, myKeyboard());
};

const sendMine = async (ctx, key) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("Ro'yxatda yo'qsiz");
  const r = resolve(key);
  if (!r) return showMine(ctx);
  await ctx.answerCbQuery('📥 Fayl tayyorlanmoqda…');
  activity.mark(ctx, 'excel', { title: `Shaxsiy Excel: ${r.title}`, detail: `${r.from} → ${r.to}` });
  return sendDoc(ctx, await employeeFile(emp, r), employeeCaption(emp, r));
};

const register = (bot) => {
  bot.command(['jamoa_excel', 'excel_yuklash'], (ctx) => showHome(ctx));
  bot.action('xl:home', async (ctx) => { await ctx.answerCbQuery(); return showHome(ctx); });
  bot.action(/^xl:emp:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); return showHome(ctx, Number(ctx.match[1])); });
  bot.action(/^xl:p:(\w+)(?::(\d+))?$/, async (ctx) => {
    if (ctx.match[2]) return send(ctx, ctx.match[1], ctx.match[2]);
    await ctx.answerCbQuery();
    return showWho(ctx, ctx.match[1]);
  });
  bot.action(/^xl:s:(\w+):(team|each|\d+)$/, (ctx) => send(ctx, ctx.match[1], ctx.match[2]));

  bot.command('excel', showMine);
  bot.action('excel:me', async (ctx) => { await ctx.answerCbQuery(); return showMine(ctx); });
  bot.action(/^xlme:(\w+)$/, (ctx) => sendMine(ctx, ctx.match[1]));
};

module.exports = { register, showHome, showMine, resolve, PERIODS };
