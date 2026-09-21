'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const { render, guard, args } = require('../render');
const employees = require('../services/employees');
const history = require('../services/history');
const activity = require('../services/activity');
const excel = require('../services/excel');
const notify = require('../services/notify');
const reports = require('../services/reports');
const period = require('../services/period');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * «HODIMLAR ARXIVI» — direktor uchun ilova ko'rinishidagi panel.
 * Bitta xabar ichida tugmalar orqali yuriladi: hodim → kun daftari → harakatlar →
 * davr hisoboti → Excel. Har bosishda o'sha xabar yangilanadi (render).
 */

// 1) Bosh sahifa
const homeText = async () => {
  const list = await employees.listActive();
  if (!list.length) return "Hodimlar ro'yxati bo'sh. Panel → «➕ Hodim qo'shish».";
  const t = time.today();
  const lines = [];
  for (const emp of list) {
    const { status, st } = await history.statusLine(emp, t);
    const last = await activity.lastSeen(emp.id);
    const seen = last && last.work_date === t ? `bugun ${time.clock(last.created_at)}` : last ? time.prettyDate(last.work_date) : 'hali kirmagan';
    lines.push(
      `${ui.roleIcon(emp.role)} <b>${esc(emp.full_name)}</b>${emp.position ? ` · <i>${esc(emp.position)}</i>` : ''}\n` +
        `   ${status} · ✅ ${st.done}  ⏳ ${st.open}${st.overdue ? `  🔴 ${st.overdue}` : ''}\n   <i>oxirgi faollik: ${esc(seen)}</i>`,
    );
  }
  return `🗂 <b>HODIMLAR ARXIVI</b>\n<i>${esc(config.companyName)} · ${time.prettyDate(t)}</i>\n\n${lines.join('\n\n')}\n\n👇 Kimning faoliyatini ko'rmoqchisiz?`;
};

const homeKeyboard = async () => {
  const rows = (await employees.listActive()).map((e) => [cb(`👤 ${e.full_name}`, `hr:emp:${e.id}`)]);
  rows.push([cb('🏢 Jamoa · 7 kun', 'hr:team:7'), cb('🏢 30 kun', 'hr:team:30')]);
  rows.push([cb('📥 Excel yuklab olish (kun / hafta / oy)', 'xl:home')]);
  rows.push([cb('📈 Davr hisoboti (sana tanlab)', 'pr:home')]);
  rows.push([cb('🔄 Yangilash', 'hr:home'), cb('⬅️ Panel', 'adm:home')]);
  return inline(rows);
};

const showHome = async (ctx) => {
  if (!(await guard(ctx))) return null;
  return render(ctx, await homeText(), await homeKeyboard());
};

// 2) Kun daftari
const dayKeyboard = (empId, date) => {
  const prev = time.addDays(date, -1);
  const next = time.addDays(date, 1);
  const t = time.today();
  const rows = [];
  const nav = [cb('◀️ Oldingi kun', `hr:d:${empId}:${prev}`)];
  if (date < t) nav.push(cb('Keyingi kun ▶️', `hr:d:${empId}:${next}`));
  rows.push(nav);
  if (date !== t) rows.push([cb('📅 Bugunga qaytish', `hr:d:${empId}:${t}`)]);
  rows.push([cb('📜 Harakatlar tarixi', `hr:t:${empId}:${date}`), cb('🗓 Kun tanlash', `hr:pick:${empId}:${date}`)]);
  rows.push([cb('📊 7 kunlik', `hr:r:${empId}:7`), cb('📊 30 kunlik', `hr:r:${empId}:30`), cb('📊 Oylik / KPI', `rp:emp:${empId}:${time.month()}`)]);
  rows.push([cb('🎯 Missiyalari', `hr:m:${empId}`), cb('📥 Excel (davr)', `xl:emp:${empId}`)]);
  rows.push([cb('👤 Kartochka', `emp:${empId}`), cb('⬅️ Hodimlar', 'hr:home')]);
  return inline(rows);
};

const showDay = async (ctx, empId, date) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  return render(ctx, await history.dayCard(emp, date), dayKeyboard(emp.id, date));
};

// 3) Kun tanlash — oxirgi 14 kun
const showPicker = async (ctx, empId, date) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  const t = time.today();
  const buttons = [];
  let row = [];
  for (let i = 0; i < 14; i += 1) {
    const d = time.addDays(t, -i);
    const label = `${time.weekdayShort(d)} ${time.shortDate(d)}`;
    row.push(cb(i === 0 ? `📅 ${label}` : label, `hr:d:${empId}:${d}`));
    if (row.length === 3) { buttons.push(row); row = []; }
  }
  if (row.length) buttons.push(row);
  buttons.push([cb('📈 Boshqa sana (kalendar)', 'pr:period'), cb('⬅️ Orqaga', `hr:d:${empId}:${date}`)]);
  return render(ctx, `🗓 <b>KUN TANLASH</b>\n👤 <b>${esc(emp.full_name)}</b>\n\nQaysi kunning daftarini ochamiz?\n<i>Oxirgi 14 kun ko'rsatilgan.</i>`, inline(buttons));
};

// 4) Harakatlar lentasi
const showTimeline = async (ctx, empId, date) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  return render(ctx, await history.timeline(emp, date), inline([
    [cb('◀️ Oldingi kun', `hr:t:${empId}:${time.addDays(date, -1)}`), cb('Keyingi kun ▶️', `hr:t:${empId}:${time.addDays(date, 1)}`)],
    [cb('🗂 Kun daftariga qaytish', `hr:d:${empId}:${date}`)],
    [cb('⬅️ Hodimlar', 'hr:home')],
  ]));
};

// 5) 7 / 30 kunlik — davr hisoboti servisidan
const showRange = async (ctx, empId, days) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  const to = time.today();
  const from = time.addDays(to, -(days - 1));
  return render(ctx, await period.employeeReport(emp, from, to, { maxItems: 12 }), inline([
    [cb(days === 7 ? '• 7 kun •' : '7 kun', `hr:r:${empId}:7`), cb(days === 30 ? '• 30 kun •' : '30 kun', `hr:r:${empId}:30`)],
    [cb(`📥 Excel (${days} kun)`, `hr:x:${empId}:${days}`)],
    [cb('🗂 Kun daftari', `hr:d:${empId}:${to}`), cb('⬅️ Hodimlar', 'hr:home')],
  ]));
};

// 6) Missiyalari / jamoa / Excel
const showTasks = async (ctx, empId) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  return render(ctx, await reports.buildEmployeeTasks(emp), inline([
    [cb('📤 Topshiriq berish', `as:emp:${empId}`), cb('📋 Boshqarish', `emp:tasks:${empId}`)],
    [cb('🗂 Kun daftari', `hr:d:${empId}:${time.today()}`), cb('⬅️ Hodimlar', 'hr:home')],
  ]));
};

const showTeam = async (ctx, days) => {
  if (!(await guard(ctx))) return null;
  return render(ctx, await history.teamOverview(days), inline([
    [cb(days === 7 ? '• 7 kun •' : '7 kun', 'hr:team:7'), cb(days === 30 ? '• 30 kun •' : '30 kun', 'hr:team:30')],
    [cb(`📥 Jamoa jamlanmasi (${days} kun)`, `hr:tx:${days}`)],
    [cb('⬅️ Hodimlar', 'hr:home')],
  ]));
};

const sendTeamExcel = async (ctx, days) => {
  if (!(await guard(ctx))) return null;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('Tayyorlanmoqda…');
  activity.mark(ctx, 'excel', { title: `Jamoa jamlanmasi ${days} kun` });
  const { buffer, filename } = await excel.buildTeamSummary(days);
  return notify.docToUser(botOf(ctx), ctx.from.id, buffer, filename, `📥 <b>${esc(config.companyName)}</b> — jamoa jamlanmasi, so'nggi ${days} kun.`);
};

const sendExcel = async (ctx, empId, days) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return null;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('Tayyorlanmoqda…');
  activity.mark(ctx, 'excel', { title: `${emp.full_name} — ${days} kun` });
  const { buffer, filename } = await excel.buildEmployeeHistory(emp, days);
  return notify.docToUser(botOf(ctx), ctx.from.id, buffer, filename,
    `📥 <b>${esc(emp.full_name)}</b> — so'nggi ${days} kunlik to'liq faoliyat arxivi.\n<i>Varaqlar: Xulosa · Bajarilgan ishlar · Kunlar · Missiyalar · Kunlik hisobotlar · Harakatlar</i>`);
};

const register = (bot) => {
  bot.command(['arxiv', 'hodim_arxiv'], showHome);
  bot.hears(ui.BTN.archive, showHome);

  /** /hodim_hisobot <tg_id> — to'g'ridan-to'g'ri bitta hodim kun daftari */
  bot.command('hodim_hisobot', async (ctx) => {
    if (!(await guard(ctx))) return null;
    const arg = args(ctx);
    if (!arg) return showHome(ctx);
    const emp = await employees.byTgId(Number(arg));
    if (!emp) return ctx.reply("❌ Bunday hodim topilmadi. /arxiv orqali ro'yxatdan tanlang.");
    return showDay(ctx, emp.id, time.today());
  });

  bot.action('hr:home', async (ctx) => { await ctx.answerCbQuery(); return showHome(ctx); });
  bot.action(/^hr:emp:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); return showDay(ctx, Number(ctx.match[1]), time.today()); });
  bot.action(/^hr:d:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); return showDay(ctx, Number(ctx.match[1]), ctx.match[2]); });
  bot.action(/^hr:t:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); return showTimeline(ctx, Number(ctx.match[1]), ctx.match[2]); });
  bot.action(/^hr:pick:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); return showPicker(ctx, Number(ctx.match[1]), ctx.match[2]); });
  bot.action(/^hr:r:(\d+):(\d+)$/, async (ctx) => { await ctx.answerCbQuery('Hisoblanmoqda…'); return showRange(ctx, Number(ctx.match[1]), Number(ctx.match[2])); });
  bot.action(/^hr:m:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); return showTasks(ctx, Number(ctx.match[1])); });
  bot.action(/^hr:team:(\d+)$/, async (ctx) => { await ctx.answerCbQuery('Hisoblanmoqda…'); return showTeam(ctx, Number(ctx.match[1])); });
  bot.action(/^hr:x:(\d+):(\d+)$/, (ctx) => sendExcel(ctx, Number(ctx.match[1]), Number(ctx.match[2])));
  bot.action(/^hr:tx:(\d+)$/, (ctx) => sendTeamExcel(ctx, Number(ctx.match[1])));
};

module.exports = { register, showHome, showDay };
