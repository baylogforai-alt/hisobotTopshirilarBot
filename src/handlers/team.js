'use strict';

const ui = require('../ui');
const time = require('../time');
const { render } = require('../render');
const employees = require('../services/employees');
const attendance = require('../services/attendance');
const tasks = require('../services/tasks');
const reports = require('../services/reports');

const { esc, cb, inline } = ui;

/**
 * «👥 HODIMLARIM» — tashkiliy tuzilma.
 *   Rahbarlar = role 'head' (HR — is_hr belgisi, sotuv rahbari va h.k. — lavozimi bilan). Rahbarning jamoasi — uning bo'limidagi hodimlar.
 *   Direktor: rahbarlar ro'yxati → rahbar (jamoasi, bugungi holat) → hodim kartochkasi; «Rahbarsiz» — rahbari yo'q hodimlar.
 *   Rahbar: o'z jamoasi → hodim (oylik hisobot + topshiriq berish).
 */

const DAY_ICON = { ontime: '🟢', late: '🟡', absent: '🔴', excused: '📄', pending: '🙋', future: '⚪', off: '⚪' };

const todayIcon = async (e) => DAY_ICON[attendance.dayStatus(await attendance.get(e.id), time.today(), time.today(), e)] || '⚪';

const personLine = async (e) => `${await todayIcon(e)} ${employees.personIcon(e)} <b>${esc(e.full_name)}</b>${employees.titleOf(e) ? ` · ${esc(employees.titleOf(e))}` : ''}`;

const seeAll = (ctx) => ctx.state.isAdmin || ctx.state.isHr;

const teamHome = async (ctx) => {
  if (!ctx.state.isManager) return ctx.reply('⛔️ Faqat rahbarlar uchun.');
  if (!seeAll(ctx)) return managerView(ctx, ctx.state.employee.id);
  const managers = await employees.listHeads();
  const lines = [];
  const rows = [];
  for (const m of managers) {
    const team = await employees.teamOf(m);
    lines.push(`${await personLine(m)} — ${team.length} hodim`);
    rows.push([cb(`${employees.personIcon(m)} ${m.full_name} · ${employees.titleOf(m)} (${team.length})`.slice(0, 60), `tm:m:${m.id}`)]);
  }
  const loose = await employees.listUnmanaged();
  if (loose.length) rows.push([cb(`👤 Rahbarsiz hodimlar (${loose.length})`, 'tm:none')]);
  rows.push([cb('📤 Topshiriq berish', 'as:start'), ctx.state.isAdmin ? cb("👥 Hamma ro'yxat", 'emp:list') : cb('👁 Davomat', 'vw:today')]);
  return render(
    ctx,
    `👥 <b>HODIMLARIM</b>\n<i>🟢 vaqtida · 🟡 kech · 🔴 kelmagan · 📄 sababli · ⚪ hali yo'q</i>\n${ui.LINE}\n` +
      `${lines.join('\n') || "<i>Hali rahbar (HR, sotuv rahbari) yo'q — hodim kartochkasida rolni «Bo'lim boshlig'i» qiling.</i>"}` +
      (loose.length ? `\n\n👤 Rahbarsiz: ${loose.length} hodim` : ''),
    inline(rows),
  );
};

const managerView = async (ctx, mgrId) => {
  const m = await employees.byId(mgrId);
  if (!m || !m.active) return teamHome(ctx);
  const own = ctx.state.employee && Number(ctx.state.employee.id) === Number(m.id);
  if (!seeAll(ctx) && !own) return ctx.reply('⛔️');
  const team = await employees.teamOf(m);
  const lines = [];
  for (const e of team) lines.push(await personLine(e));
  const rows = team.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}${e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `tm:e:${e.id}`)]);
  if (seeAll(ctx) && !own) {
    rows.push([cb(`📤 ${m.full_name.split(' ')[0]}ga topshiriq`, `as:emp:${m.id}`), cb('👥 Hodimlariga topshiriq', `as:team:${m.id}`)]);
    rows.push([cb('👤 Kartochka', ctx.state.isAdmin ? `emp:${m.id}` : `tm:e:${m.id}`), cb('⬅️ Hodimlarim', 'tm:home')]);
  } else {
    rows.push([cb('📤 Topshiriq berish', 'as:start')]);
  }
  const head = own
    ? `👥 <b>MENING JAMOAM</b> · ${esc(m.department_name || '')}`
    : `${await personLine(m)}\n🏢 ${esc(m.department_name || "bo'lim biriktirilmagan")}`;
  return render(
    ctx,
    `${head}\n${ui.LINE}\n${lines.join('\n') || (m.department_id ? "<i>Jamoada hodim yo'q.</i>" : "<i>Bo'lim biriktirilmagan — kartochkada bo'lim tanlang, shu bo'lim hodimlari jamoasi bo'ladi.</i>")}`,
    inline(rows),
  );
};

const memberView = async (ctx, empId) => {
  const e = await employees.byId(empId);
  if (!e) return teamHome(ctx);
  if (ctx.state.isAdmin) return require('./admin').employeeCard(ctx, e.id);
  if (!employees.canManage(ctx.state.employee, false, e)) return ctx.answerCbQuery ? ctx.answerCbQuery('⛔️') : null;
  const open = await tasks.openFor(e.id);
  const text = `${await reports.buildMyReport(e, time.month())}\n\n💬 Lichka: ${employees.contactHtml(e)}`;
  const rows = [[cb('📤 Topshiriq berish', `as:emp:${e.id}`), cb(`📋 Ochiq (${open.length})`, `rp:emp:${e.id}:${time.month()}`)]];
  if (ctx.state.isHr) {
    rows.push([cb("🧭 Yo'nalishlari", `ed:${e.id}`), cb(employees.isViewer(e) ? '👁 Nazorat: ha' : "👁 Nazorat: yo'q", `vw:grant:${e.id}`)]);
  }
  rows.push([cb('⬅️ Hodimlarim', 'tm:home')]);
  return render(ctx, text, inline(rows));
};

const unmanagedView = async (ctx) => {
  const list = await employees.listUnmanaged();
  const lines = [];
  for (const e of list) lines.push(await personLine(e));
  const rows = list.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}`.slice(0, 60), ctx.state.isAdmin ? `emp:${e.id}` : `tm:e:${e.id}`)]);
  rows.push([cb('⬅️ Hodimlarim', 'tm:home')]);
  return render(ctx, `👤 <b>RAHBARSIZ HODIMLAR</b>\n<i>Bo'limida rahbar (HR / sotuv rahbari) yo'q. Kartochkada bo'limini o'zgartiring.</i>\n${ui.LINE}\n${lines.join('\n') || "<i>yo'q</i>"}`, inline(rows));
};

const guardMgr = async (ctx) => {
  if (ctx.state.isManager) return true;
  await ctx.answerCbQuery('⛔️ Faqat rahbarlar uchun');
  return false;
};

const register = (bot) => {
  bot.hears(ui.BTN.myTeam, teamHome);
  bot.command('hodimlarim', teamHome);
  bot.action('tm:home', async (ctx) => { if (await guardMgr(ctx)) { await ctx.answerCbQuery(); await teamHome(ctx); } });
  bot.action(/^tm:m:(\d+)$/, async (ctx) => { if (await guardMgr(ctx)) { await ctx.answerCbQuery(); await managerView(ctx, ctx.match[1]); } });
  bot.action(/^tm:e:(\d+)$/, async (ctx) => { if (await guardMgr(ctx)) { await ctx.answerCbQuery(); await memberView(ctx, ctx.match[1]); } });
  bot.action('tm:none', async (ctx) => {
    if (!seeAll(ctx)) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    return unmanagedView(ctx);
  });
};

module.exports = { register, teamHome, managerView, memberView };
