'use strict';

const { Markup } = require('telegraf');
const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const employees = require('../services/employees');
const excel = require('../services/excel');
const notify = require('../services/notify');
const activity = require('../services/activity');

/**
 * «EXCEL YUKLAB OLISH» — ikki bosishda tayyor fayl.
 *
 *   1-qadam: DAVR   — bugun · shu hafta · o'tgan hafta · shu oy · o'tgan oy
 *   2-qadam: KIM    — butun jamoa (bitta fayl) · har bir hodim alohida · bitta hodim
 *
 * Oy — kalendar oy: 30 kunlik oyda 30 kun, 31 kunlik oyda 31 kun chiqadi.
 * Hodimlar uchun (/excel) faqat o'zining fayli: davrni tanlaydi, fayl keladi.
 */

const LINE = '━'.repeat(18);

// ---------------------------------------------------------------------------
// DAVRLAR
// ---------------------------------------------------------------------------

const PERIODS = {
  today: {
    icon: '📅',
    name: 'Bugun',
    range: () => [time.today(), time.today()],
  },
  week: {
    icon: '📆',
    name: 'Shu hafta',
    range: () => [time.startOfWeek(time.today()), time.today()],
  },
  lastweek: {
    icon: '📆',
    name: "O'tgan hafta",
    range: () => {
      const d = time.addDays(time.startOfWeek(time.today()), -1);
      return [time.startOfWeek(d), time.endOfWeek(d)];
    },
  },
  month: {
    icon: '🗓',
    name: 'Shu oy',
    range: () => [time.startOfMonth(time.today()), time.today()],
  },
  lastmonth: {
    icon: '🗓',
    name: "O'tgan oy",
    range: () => {
      const d = time.addDays(time.startOfMonth(time.today()), -1);
      return [time.startOfMonth(d), time.endOfMonth(d)];
    },
  },
};

/** Davr kaliti → { key, from, to, days, name, title } */
const resolve = (key) => {
  const p = PERIODS[key];
  if (!p) return null;
  const [from, to] = p.range();
  const days = time.daysIn(from, to);
  let title = p.name;
  if (key === 'lastmonth') title = `${p.name} — ${time.monthLabel(from)}`;
  if (key === 'month') title = `${p.name} — ${time.monthLabel(from)}`;
  return { key, from, to, days, name: p.name, icon: p.icon, title };
};

/** Tugma yorlig'i: «🗓 O'tgan oy · avgust (31 kun)» */
const periodLabel = (key) => {
  const r = resolve(key);
  if (key === 'today') return `${r.icon} ${r.name} · ${time.shortDate(r.from)}`;
  if (key === 'month' || key === 'lastmonth') {
    return `${r.icon} ${r.name} · ${time.monthLabel(r.from).split(' ')[0]} (${r.days} kun)`;
  }
  return `${r.icon} ${r.name} · ${time.shortDate(r.from)}–${time.shortDate(r.to)} (${r.days} kun)`;
};

const periodText = (r) => `${time.prettyRange(r.from, r.to)} · <b>${r.days} kun</b>`;

// ---------------------------------------------------------------------------
// XABAR YORDAMCHILARI
// ---------------------------------------------------------------------------

const render = async (ctx, text, keyboard) => {
  const extra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(keyboard || {}) };
  if (ctx.updateType === 'callback_query') {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (err) {
      if (/message is not modified/i.test(err.description || err.message || '')) return null;
      return ctx.reply(text, extra);
    }
  }
  return ctx.reply(text, extra);
};

const guard = async (ctx) => {
  if (ctx.state.isAdmin) return true;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('⛔️ Faqat administrator uchun');
  else await ctx.reply("⛔️ Bu bo'lim faqat administrator uchun.");
  return false;
};

const sendDoc = (ctx, file, caption) =>
  notify.docToUser({ telegram: ctx.telegram }, ctx.from.id, file.buffer, file.filename, caption);

// ---------------------------------------------------------------------------
// FAYL YASASH — bitta joyda, hamma tugmalar shu orqali
// ---------------------------------------------------------------------------

/** Bitta hodimning fayli: bugun → kunlik jadval, aks holda davr arxivi */
const employeeFile = async (emp, r) => {
  if (r.key === 'today') {
    return excel.buildDayReport(r.from, { employeeId: emp.id, scopeName: emp.full_name });
  }
  return excel.buildEmployeePeriod(emp, r.from, r.to);
};

const employeeCaption = (emp, r) =>
  `📥 <b>${ui.esc(emp.full_name)}</b> — ${ui.esc(r.title)}\n` +
  `🗓 ${periodText(r)}\n` +
  (r.key === 'today'
    ? '<i>Bugungi missiyalari va holati</i>'
    : "<i>Varaqlar: Xulosa · Bajarilgan ishlar · Kunlar · Missiyalar · Harakatlar</i>");

/** Butun jamoa — bitta fayl */
const teamFile = async (r) => {
  if (r.key === 'today') return excel.buildDayReport(r.from, { scopeName: 'Butun jamoa' });
  return excel.buildTeamPeriod(r.from, r.to);
};

const teamCaption = (r) =>
  `📥 <b>${ui.esc(config.companyName)}</b> — butun jamoa, ${ui.esc(r.title)}\n` +
  `🗓 ${periodText(r)}\n` +
  (r.key === 'today'
    ? '<i>Har bir hodimning bugungi ishlari</i>'
    : "<i>Varaqlar: Jamlanma · Kunlar · Missiyalar · Kechikkanlar · Bajarilganlar</i>");

// ---------------------------------------------------------------------------
// 1) ADMIN: DAVRNI TANLASH
// ---------------------------------------------------------------------------

/** empId berilsa — faqat shu hodim uchun davr tanlanadi (arxivdan kelganda) */
const periodKeyboard = (empId = null) => {
  const cb = (key) => `xl:p:${key}${empId ? `:${empId}` : ''}`;
  const rows = [
    [Markup.button.callback(periodLabel('today'), cb('today'))],
    [Markup.button.callback(periodLabel('week'), cb('week'))],
    [Markup.button.callback(periodLabel('lastweek'), cb('lastweek'))],
    [Markup.button.callback(periodLabel('month'), cb('month'))],
    [Markup.button.callback(periodLabel('lastmonth'), cb('lastmonth'))],
    [Markup.button.callback('🗓 Boshqa sana oralig\'i (kalendar)', 'pr:period')],
  ];
  rows.push([
    Markup.button.callback('⬅️ Orqaga', empId ? `hr:d:${empId}:${time.today()}` : 'hr:home'),
  ]);
  return Markup.inlineKeyboard(rows);
};

const showHome = async (ctx, empId = null) => {
  if (!(await guard(ctx))) return null;
  let who = '';
  if (empId) {
    const emp = await employees.byId(empId);
    if (!emp) return render(ctx, '❌ Hodim topilmadi.', periodKeyboard());
    who = `👤 <b>${ui.esc(emp.full_name)}</b>\n\n`;
  }
  return render(
    ctx,
    `📥 <b>EXCEL YUKLAB OLISH</b>\n${LINE}\n\n${who}` +
      `<b>1-qadam:</b> qaysi davr uchun?\n\n` +
      `<i>Oy — kalendar oy: 30 kunlik oyda 30 kun, 31 kunlik oyda 31 kun chiqadi.\n` +
      `Hafta dushanbadan boshlanadi.</i>`,
    periodKeyboard(empId),
  );
};

// ---------------------------------------------------------------------------
// 2) ADMIN: KIMNI
// ---------------------------------------------------------------------------

const showWho = async (ctx, key) => {
  if (!(await guard(ctx))) return null;
  const r = resolve(key);
  if (!r) return showHome(ctx);
  const list = await employees.listActive();

  const rows = [
    [Markup.button.callback('🏢 Butun jamoa — bitta fayl', `xl:s:${key}:team`)],
    [Markup.button.callback(`👥 Har bir hodim alohida — ${list.length} ta fayl`, `xl:s:${key}:each`)],
  ];
  list.forEach((e) => rows.push([Markup.button.callback(`👤 ${e.full_name}`, `xl:s:${key}:${e.id}`)]));
  rows.push([Markup.button.callback('⬅️ Davrni o\'zgartirish', 'xl:home')]);

  return render(
    ctx,
    `📥 <b>EXCEL YUKLAB OLISH</b>\n${LINE}\n\n` +
      `🗓 <b>Davr:</b> ${ui.esc(r.title)}\n      ${periodText(r)}\n\n` +
      `<b>2-qadam:</b> kimning hisoboti?\n\n` +
      `🏢 <b>Butun jamoa</b> — hamma hodim bitta faylda (jamlanma + kun-kun + ishlar)\n` +
      `👥 <b>Har bir hodim alohida</b> — har biriga o'zining to'liq fayli\n` +
      `👤 <b>Bitta hodim</b> — faqat o'shaning fayli`,
    Markup.inlineKeyboard(rows),
  );
};

// ---------------------------------------------------------------------------
// 3) ADMIN: YUBORISH
// ---------------------------------------------------------------------------

const send = async (ctx, key, scope) => {
  if (!(await guard(ctx))) return null;
  const r = resolve(key);
  if (!r) return showHome(ctx);
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('📥 Fayl tayyorlanmoqda…');

  activity.mark(ctx, 'excel', { title: `Excel: ${r.title}`, detail: `${r.from} → ${r.to} · ${scope}` });

  if (scope === 'team') {
    return sendDoc(ctx, await teamFile(r), teamCaption(r));
  }

  if (scope === 'each') {
    const list = await employees.listActive();
    if (!list.length) return ctx.reply("Hodimlar ro'yxati bo'sh.");
    await ctx.reply(
      `📥 <b>${list.length} ta fayl</b> tayyorlanmoqda — ${ui.esc(r.title)} (${r.days} kun).\n` +
        `<i>Har bir hodim uchun alohida fayl keladi…</i>`,
      { parse_mode: 'HTML' },
    );
    let sent = 0;
    for (const emp of list) {
      const ok = await sendDoc(ctx, await employeeFile(emp, r), employeeCaption(emp, r));
      if (ok) sent += 1;
    }
    return ctx.reply(`✅ ${sent} / ${list.length} ta fayl yuborildi.`);
  }

  const emp = await employees.byId(Number(scope));
  if (!emp) return ctx.reply('❌ Hodim topilmadi.');
  return sendDoc(ctx, await employeeFile(emp, r), employeeCaption(emp, r));
};

// ---------------------------------------------------------------------------
// 4) HODIM: O'Z FAYLI (/excel)
// ---------------------------------------------------------------------------

const myKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback(periodLabel('today'), 'xlme:today')],
    [Markup.button.callback(periodLabel('week'), 'xlme:week')],
    [Markup.button.callback(periodLabel('lastweek'), 'xlme:lastweek')],
    [Markup.button.callback(periodLabel('month'), 'xlme:month')],
    [Markup.button.callback(periodLabel('lastmonth'), 'xlme:lastmonth')],
  ]);

const showMine = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) {
    if (ctx.updateType === 'callback_query') return ctx.answerCbQuery("Ro'yxatdan o'tmagansiz");
    return ctx.reply("❌ Siz hodimlar ro'yxatida yo'qsiz. /id yozib ID ni administratorga bering.");
  }
  return render(
    ctx,
    `📥 <b>MENING EXCEL HISOBOTIM</b>\n${LINE}\n\n` +
      `👤 <b>${ui.esc(emp.full_name)}</b>\n\n` +
      `Qaysi davr uchun yuklab olamiz?`,
    myKeyboard(),
  );
};

const sendMine = async (ctx, key) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("Ro'yxatdan o'tmagansiz");
  const r = resolve(key);
  if (!r) return showMine(ctx);
  await ctx.answerCbQuery('📥 Fayl tayyorlanmoqda…');
  activity.mark(ctx, 'excel', { title: `Shaxsiy Excel: ${r.title}`, detail: `${r.from} → ${r.to}` });
  return sendDoc(ctx, await employeeFile(emp, r), employeeCaption(emp, r));
};

// ---------------------------------------------------------------------------

const register = (bot) => {
  bot.command(['jamoa_excel', 'excel_yuklash'], (ctx) => showHome(ctx));

  bot.action('xl:home', async (ctx) => {
    await ctx.answerCbQuery();
    return showHome(ctx);
  });
  /** Arxivdan: faqat shu hodim uchun davr tanlash */
  bot.action(/^xl:emp:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showHome(ctx, Number(ctx.match[1]));
  });
  /** Davr tanlandi: hodim oldindan ma'lum bo'lsa — darrov yuboriladi, aks holda «kim?» */
  bot.action(/^xl:p:(\w+)(?::(\d+))?$/, async (ctx) => {
    if (ctx.match[2]) return send(ctx, ctx.match[1], ctx.match[2]);
    await ctx.answerCbQuery();
    return showWho(ctx, ctx.match[1]);
  });
  bot.action(/^xl:s:(\w+):(team|each|\d+)$/, (ctx) => send(ctx, ctx.match[1], ctx.match[2]));

  bot.command('excel', showMine);
  bot.action('excel:me', async (ctx) => {
    await ctx.answerCbQuery();
    return showMine(ctx);
  });
  bot.action(/^xlme:(\w+)$/, (ctx) => sendMine(ctx, ctx.match[1]));
};

module.exports = { register, showHome, showMine, resolve, PERIODS };
