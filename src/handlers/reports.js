'use strict';

const ui = require('../ui');
const time = require('../time');
const { render, guard } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const reports = require('../services/reports');
const excel = require('../services/excel');
const notify = require('../services/notify');
const activity = require('../services/activity');
const { notRegistered } = require('./common');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

const monthNav = (prefix, month, extra = []) => {
  const prev = time.shiftMonth(month, -1);
  const next = time.shiftMonth(month, 1);
  const rows = [[cb(`◀️ ${time.monthName(prev)}`, `${prefix}:${prev}`), ...(next <= time.month() ? [cb(`${time.monthName(next)} ▶️`, `${prefix}:${next}`)] : [])]];
  return inline([...rows, ...extra]);
};

// --- hodim ---
const myReport = async (ctx, month = time.month()) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  activity.mark(ctx, 'my_report', { detail: month });
  const text = await reports.buildMyReport(emp, month);
  return render(ctx, text, monthNav('rp:me', month, [[cb('📥 Excel (oy)', `rp:xlme:${month}`), cb('📥 Excel (kun/hafta)', 'excel:me')]]));
};

const myExcel = async (ctx, month) => {
  const emp = ctx.state.employee;
  if (!emp) return;
  activity.mark(ctx, 'excel', { title: `Oylik Excel ${month}` });
  const { buffer, filename } = await excel.buildEmployeeMonth(emp, month);
  await notify.docToUser(botOf(ctx), ctx.from.id, buffer, filename, `📥 <b>${esc(emp.full_name)}</b> — ${time.monthName(month)}`);
};

// --- bo'lim boshlig'i ---
const myDept = async (ctx, month = time.month()) => {
  if (!ctx.state.isManager) return ctx.reply('⛔️ Faqat boshliq va direktor uchun.');
  const deptId = ctx.state.isAdmin ? null : ctx.state.employee.department_id;
  if (!ctx.state.isAdmin && !deptId) return ctx.reply("Sizga bo'lim biriktirilmagan — direktorga ayting.");
  const today = await reports.buildToday({ deptId, title: deptId ? `${(await departments.byId(deptId)).name.toUpperCase()} — BUGUN` : 'BUGUNGI HOLAT' });
  const table = await reports.buildMonthTable({ month, deptId });
  return render(ctx, `${today.text}\n\n${table}`, monthNav('rp:dept', month, [
    [cb('⚠️ Kechikkan ishlar', 'rp:overdue'), cb('🔎 Tekshiruv', 'rv:list')],
    [cb('📋 Kunlik hisobotlar', 'dr:today')],
  ]));
};

// --- direktor ---
const reportsHome = (ctx) =>
  render(ctx, `📈 <b>HISOBOTLAR</b>\n<i>${time.prettyDate(time.today())}</i>`, inline([
    [cb('📊 Bugungi holat', 'adm:today'), cb('📋 Kun yakuni (batafsil)', 'rp:daily')],
    [cb('📈 Davr hisoboti (sana tanlab)', 'pr:home'), cb('🗂 Hodimlar arxivi', 'hr:home')],
    [cb(`👥 Jamoa — ${time.monthName(time.month())}`, `rp:team:${time.month()}`)],
    [cb(`👥 Jamoa — ${time.monthName(time.prevMonth())}`, `rp:team:${time.prevMonth()}`)],
    [cb("🏢 Bo'lim bo'yicha", 'rp:depts'), cb("👤 Hodim bo'yicha", 'emp:list')],
    [cb('📥 Excel yuklab olish (kun / hafta / oy)', 'xl:home')],
    [cb(`📥 KPI Excel — ${time.monthName(time.prevMonth())}`, `kpi:xl:${time.prevMonth()}`), cb(`📥 KPI Excel — ${time.monthName(time.month())}`, `kpi:xl:${time.month()}`)],
  ]));

const teamMonth = async (ctx, month) => {
  const text = await reports.buildMonthTable({ month });
  return render(ctx, text, monthNav('rp:team', month, [[cb('📥 Excel', `kpi:xl:${month}`), cb('💰 KPI', `kpi:m:${month}`)], [cb('⬅️ Hisobotlar', 'rp:home')]]));
};

const deptPick = async (ctx) => {
  const rows = (await departments.listActive()).map((d) => [cb(`🏢 ${d.name}`, `rp:d:${d.id}:${time.month()}`)]);
  rows.push([cb('⬅️ Hisobotlar', 'rp:home')]);
  return render(ctx, rows.length > 1 ? "🏢 Qaysi bo'lim?" : "🏢 Hali bo'lim yaratilmagan (Panel → Bo'limlar).", inline(rows));
};

const deptMonth = async (ctx, deptId, month) => {
  const today = await reports.buildToday({ deptId, title: `${(await departments.byId(deptId)).name.toUpperCase()} — BUGUN` });
  const table = await reports.buildMonthTable({ month, deptId });
  return render(ctx, `${today.text}\n\n${table}`, monthNav(`rp:d:${deptId}`, month, [[cb("⬅️ Bo'limlar", 'rp:depts')]]));
};

const empMonth = async (ctx, empId, month) => {
  const e = await employees.byId(empId);
  if (!e) return render(ctx, 'Hodim topilmadi.');
  if (!employees.canManage(ctx.state.employee, ctx.state.isAdmin, e)) return ctx.answerCbQuery('⛔️');
  const text = await reports.buildMyReport(e, month);
  return render(ctx, text, monthNav(`rp:emp:${e.id}`, month, [[cb('📥 Excel', `rp:xlemp:${e.id}:${month}`), cb('🗂 Arxiv', `hr:emp:${e.id}`), cb('👤 Kartochka', `emp:${e.id}`)]]));
};

const register = (bot) => {
  bot.hears(ui.BTN.myReport, (ctx) => myReport(ctx));
  bot.command('hisobot', (ctx) => myReport(ctx));
  bot.action(/^rp:me:(\d{4}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); await myReport(ctx, ctx.match[1]); });
  bot.action(/^rp:xlme:(\d{4}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery('Tayyorlanmoqda…'); await myExcel(ctx, ctx.match[1]); });

  bot.hears(ui.BTN.myDept, (ctx) => myDept(ctx));
  bot.command('bolim', (ctx) => myDept(ctx));
  bot.action(/^rp:dept:(\d{4}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); await myDept(ctx, ctx.match[1]); });
  bot.action('rp:overdue', async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await require('./admin').showOverdue(ctx); });

  bot.hears(ui.BTN.reports, async (ctx) => { if (await guard(ctx)) await reportsHome(ctx); });
  bot.command('hisobotlar', async (ctx) => { if (await guard(ctx)) await reportsHome(ctx); });
  bot.action('rp:home', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await reportsHome(ctx); } });
  bot.action('rp:daily', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await render(ctx, await reports.buildDailyGroupText(), inline([[cb('📥 Excel (bugun)', 'rp:xlday'), cb('⬅️ Hisobotlar', 'rp:home')]])); } });
  bot.action(/^rp:team:(\d{4}-\d{2})$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await teamMonth(ctx, ctx.match[1]); } });
  bot.action('rp:depts', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await deptPick(ctx); } });
  bot.action(/^rp:d:(\d+):(\d{4}-\d{2})$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await deptMonth(ctx, Number(ctx.match[1]), ctx.match[2]); } });
  bot.action(/^rp:emp:(\d+):(\d{4}-\d{2})$/, async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await empMonth(ctx, ctx.match[1], ctx.match[2]); });
  bot.action(/^rp:xlemp:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️');
    const e = await employees.byId(ctx.match[1]);
    if (!e || !employees.canManage(ctx.state.employee, ctx.state.isAdmin, e)) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery('Tayyorlanmoqda…');
    const { buffer, filename } = await excel.buildEmployeeMonth(e, ctx.match[2]);
    await notify.docToUser(botOf(ctx), ctx.from.id, buffer, filename, `📥 <b>${esc(e.full_name)}</b> — ${time.monthName(ctx.match[2])}`);
  });
  bot.action('rp:xlday', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery('Tayyorlanmoqda…');
    const { buffer, filename } = await excel.buildDay();
    await notify.docToUser(botOf(ctx), ctx.from.id, buffer, filename, `📥 <b>${time.prettyDate(time.today())}</b> — davomat, topshiriqlar, kunlik hisobotlar`);
  });
};

module.exports = { register, myReport, myDept };
