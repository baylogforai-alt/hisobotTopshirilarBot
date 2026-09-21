'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render, guard, args } = require('../render');
const employees = require('../services/employees');
const period = require('../services/period');
const excel = require('../services/excel');
const notify = require('../services/notify');
const activity = require('../services/activity');

const { esc, cb, inline, LINE } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * «DAVR HISOBOTI» — direktor uchun hisobot markazi.
 *   1) davrni tanlash (tayyor tugma / kalendar / qo'lda yozish)
 *   2) kimni (bitta hodim yoki butun jamoa)
 *   3) ko'rish yoki Excel qilib yuklab olish.
 * Tanlov sessiyada saqlanadi (pFrom/pTo/pEmp) — davrni bir marta tanlab, hodimdan hodimga o'tish mumkin.
 */

const getSel = (ctx) => {
  const s = session.get(ctx.from.id);
  const from = time.isValidDate(s.pFrom) ? s.pFrom : time.startOfMonth(time.today());
  const to = time.isValidDate(s.pTo) ? s.pTo : time.today();
  const norm = period.normalize(from, to);
  return { from: norm.from, to: norm.to, days: norm.days, empId: s.pEmp || null };
};
const setSel = (ctx, patch) => session.set(ctx.from.id, patch);

const scopeName = async (empId) => {
  if (!empId) return '🏢 Butun jamoa';
  const emp = await employees.byId(empId);
  return emp ? `👤 ${emp.full_name}` : '🏢 Butun jamoa';
};

// 1) Bosh panel
const homeText = async (sel) =>
  `📈 <b>DAVR HISOBOTI</b>\n<i>${esc(config.companyName)}</i>\n${LINE}\n\n` +
  `🗓 <b>Davr:</b> ${time.prettyRange(sel.from, sel.to)}\n      <i>${sel.from} → ${sel.to} · ${sel.days} kun</i>\n` +
  `👥 <b>Kim:</b> ${esc(await scopeName(sel.empId))}\n\n` +
  `Boshlanish va tugash sanasini o'zingiz tanlaysiz. Keyin hisobotni ekranda ko'rasiz yoki Excel qilib yuklab olasiz.`;

const homeKeyboard = () =>
  inline([
    [cb('🗓 Davrni tanlash', 'pr:period')],
    [cb("👥 Kimni ko'ramiz?", 'pr:who')],
    [cb("📊 Hisobotni ko'rish", 'pr:go')],
    [cb('📥 Excel yuklab olish', 'pr:x')],
    [cb('🗂 Hodimlar arxivi', 'hr:home'), cb('⬅️ Hisobotlar', 'rp:home')],
  ]);

const showHome = async (ctx) => {
  if (!(await guard(ctx))) return null;
  return render(ctx, await homeText(getSel(ctx)), homeKeyboard());
};

// 2) Davrni tanlash
const showPeriod = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  const b = (key) => cb(period.PRESETS[key].label, `pr:pre:${key}`);
  return render(ctx,
    `🗓 <b>DAVRNI TANLASH</b>\n${LINE}\n\nHozirgi tanlov: <b>${time.prettyRange(sel.from, sel.to)}</b> <i>(${sel.days} kun)</i>\n\nTayyor davrlardan birini bosing yoki kalendardan aniq sanani tanlang.`,
    inline([
      [b('today'), b('yesterday')], [b('week'), b('lastweek')], [b('month'), b('lastmonth')], [b('d7'), b('d30'), b('d90')], [b('year')],
      [cb('🗓 Kalendardan tanlash', `pr:cal:f:${sel.from.slice(0, 7)}`)],
      [cb("⌨️ Sanani qo'lda yozish", 'pr:type')],
      [cb('⬅️ Orqaga', 'pr:home')],
    ]));
};

// 3) Kalendar
const NOP = 'pr:nop';

/** Bir oylik kalendar tugmalari. which: 'f' — boshlanish, 't' — tugash */
const calendarKeyboard = (which, month, sel) => {
  const first = `${month}-01`;
  const rows = [];
  rows.push([cb('◀️', `pr:cal:${which}:${time.addMonths(first, -1).slice(0, 7)}`), cb(time.monthLabel(first), NOP), cb('▶️', `pr:cal:${which}:${time.addMonths(first, 1).slice(0, 7)}`)]);
  rows.push(time.UZ_SHORT.map((w) => cb(w, NOP)));
  const last = time.endOfMonth(first);
  const lead = time.UZ_SHORT.indexOf(time.weekdayShort(first));
  const t = time.today();
  let row = [];
  for (let i = 0; i < lead; i += 1) row.push(cb(' ', NOP));
  for (let d = 1; d <= Number(last.slice(8, 10)); d += 1) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    let label = String(d);
    if (date === t) label = `[${d}]`;
    if (date === sel.to) label = `🔴${d}`;
    if (date === sel.from) label = `🟢${d}`;
    row.push(date > t ? cb('·', NOP) : cb(label, `pr:set:${which}:${date}`));
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(cb(' ', NOP)); rows.push(row); }
  rows.push([cb('📅 Bugun', `pr:set:${which}:${t}`), cb(`🗓 ${time.monthLabel(t)}`, `pr:cal:${which}:${t.slice(0, 7)}`)]);
  rows.push([cb('⬅️ Orqaga', 'pr:period')]);
  return inline(rows);
};

const showCalendar = async (ctx, which, month) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  const title = which === 'f' ? '🟢 <b>BOSHLANISH SANASI</b>' : '🔴 <b>TUGASH SANASI</b>';
  return render(ctx,
    `${title}\n${LINE}\n\n🟢 Boshlanish: <b>${time.prettyDate(sel.from)}</b>\n🔴 Tugash: <b>${time.prettyDate(sel.to)}</b>\n\n` +
      `<i>Quyidagi kalendardan ${which === 'f' ? 'boshlanish' : 'tugash'} kunini bosing.\n[ ] — bugun · 🟢/🔴 — tanlangan sanalar</i>`,
    calendarKeyboard(which, month, sel));
};

const pickDate = async (ctx, which, date) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  if (which === 'f') {
    const to = date > sel.to ? date : sel.to;
    setSel(ctx, { pFrom: date, pTo: to });
    return showCalendar(ctx, 't', to.slice(0, 7));
  }
  const from = date < sel.from ? date : sel.from;
  setSel(ctx, { pFrom: from, pTo: date });
  return showHome(ctx);
};

// 4) Qo'lda yozish
const askTyped = async (ctx) => {
  if (!(await guard(ctx))) return null;
  session.set(ctx.from.id, { step: 'period_dates' });
  return render(ctx,
    `⌨️ <b>SANALARNI QO'LDA YOZISH</b>\n${LINE}\n\nIkkita sanani bitta qatorda yozing:\n\n` +
      `<code>01.09.2026 - 07.09.2026</code>\n<code>2026-09-01 2026-09-07</code>\n<code>1-sentabr 7-sentabr</code>\n\n<i>Bitta sana yozsangiz — o'sha kunning hisoboti chiqadi.</i>`,
    inline([[cb('⬅️ Orqaga', 'pr:period')]]));
};

/**
 * Foydalanuvchi yozgan matndan ikkita sanani ajratadi.
 * '01.09.2026 - 07.09.2026', '2026-09-01 2026-09-07', '1-sentabr 7-sentabr', '01.09.2026 dan 07.09.2026 gacha'.
 */
const parseRange = (raw) => {
  const text = String(raw || '').trim();
  const dates = [];
  (text.match(/\d{1,2}\s*[-\s]\s*[a-zA-Zʼ'`]{3,}/g) || []).forEach((m) => {
    const d = time.parseDate(m.replace(/\s+/g, ''));
    if (d && dates.length < 2) dates.push(d);
  });
  if (dates.length < 2) {
    const tokens = text.split(/\s*(?:[—–]|,|\s+)\s*/).map((s) => s.replace(/^-+|-+$/g, '').trim()).filter(Boolean);
    for (const tk of tokens) {
      const d = time.parseDate(tk);
      if (d && !dates.includes(d)) dates.push(d);
      if (dates.length === 2) break;
    }
  }
  if (!dates.length) return null;
  return period.normalize(dates[0], dates[1] || dates[0]);
};

const handleTypedDates = async (ctx) => {
  session.clear(ctx.from.id);
  const norm = parseRange(ctx.message.text);
  if (!norm) {
    return ctx.reply("❌ Sanani tushunmadim.\n\nMisol: <code>01.09.2026 - 07.09.2026</code>\nQaytadan urinib ko'ring yoki /davr bosing.", { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  }
  setSel(ctx, { pFrom: norm.from, pTo: norm.to });
  activity.mark(ctx, 'admin', { title: 'Davr tanladi', detail: `${norm.from} → ${norm.to}` });
  await ctx.reply('👌', ui.kbFor(ctx));
  return ctx.reply(await homeText(getSel(ctx)), { parse_mode: 'HTML', ...homeKeyboard() });
};

// 5) Kimni
const showWho = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  const list = await employees.listActive();
  const rows = [[cb('🏢 Butun jamoa (hammasi bitta hisobotda)', 'pr:w:all')]];
  list.forEach((e) => rows.push([cb(`${String(e.id) === String(sel.empId) ? '✅ ' : '👤 '}${e.full_name}`, `pr:w:${e.id}`)]));
  rows.push([cb('⬅️ Orqaga', 'pr:home')]);
  return render(ctx, `👥 <b>KIMNING HISOBOTI?</b>\n${LINE}\n\n🗓 Davr: <b>${time.prettyRange(sel.from, sel.to)}</b>\n\nButun jamoani bitta hisobotda ko'rish yoki bitta hodimni alohida tanlash mumkin.`, inline(rows));
};

// 6) Hisobot va Excel
const reportKeyboard = (sel) =>
  inline([
    [cb('📥 Excel yuklab olish', 'pr:x')],
    [cb('🗓 Boshqa davr', 'pr:period'), cb('👥 Boshqa hodim', 'pr:who')],
    [cb('🔄 Yangilash', 'pr:go'), cb(sel.empId ? '🏢 Butun jamoa' : '👤 Bitta hodim', sel.empId ? 'pr:w:all' : 'pr:who')],
    [cb('⬅️ Panelga qaytish', 'pr:home')],
  ]);

const showReport = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  activity.mark(ctx, 'admin', { title: 'Davr hisobotini ochdi', detail: `${sel.from} → ${sel.to} · ${sel.empId ? `hodim #${sel.empId}` : 'jamoa'}` });
  if (sel.empId) {
    const emp = await employees.byId(sel.empId);
    if (!emp) { setSel(ctx, { pEmp: null }); return render(ctx, '❌ Hodim topilmadi.', homeKeyboard()); }
    return render(ctx, await period.employeeReport(emp, sel.from, sel.to), reportKeyboard(sel));
  }
  return render(ctx, await period.teamReport(sel.from, sel.to), reportKeyboard(sel));
};

const sendExcel = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('📥 Fayl tayyorlanmoqda…');
  activity.mark(ctx, 'excel', { title: 'Davr hisoboti (Excel)', detail: `${sel.from} → ${sel.to}` });
  let file, caption;
  if (sel.empId) {
    const emp = await employees.byId(sel.empId);
    if (!emp) return ctx.reply('❌ Hodim topilmadi.');
    file = await excel.buildEmployeePeriod(emp, sel.from, sel.to);
    caption = `📥 <b>${esc(emp.full_name)}</b> — davr hisoboti\n🗓 <i>${time.prettyRange(sel.from, sel.to)} (${sel.days} kun)</i>\n<i>Varaqlar: Xulosa · Bajarilgan ishlar · Kunlar · Missiyalar · Kunlik hisobotlar · Harakatlar</i>`;
  } else {
    file = await excel.buildTeamPeriod(sel.from, sel.to);
    caption = `📥 <b>${esc(config.companyName)}</b> — jamoa davr hisoboti\n🗓 <i>${time.prettyRange(sel.from, sel.to)} (${sel.days} kun)</i>\n<i>Varaqlar: Jamlanma · Kunlar · Missiyalar · Kechikkanlar · Bajarilganlar · Kunlik hisobotlar</i>`;
  }
  return notify.docToUser(botOf(ctx), ctx.from.id, file.buffer, file.filename, caption);
};

const register = (bot) => {
  bot.command(['davr', 'davr_hisobot', 'hisobot_markazi'], showHome);

  /** /oraliq 2026-09-01 2026-09-07 [tg_id] */
  bot.command('oraliq', async (ctx) => {
    if (!(await guard(ctx))) return null;
    const parts = args(ctx).split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return ctx.reply("📌 <code>/oraliq 2026-09-01 2026-09-07</code>\nBitta hodim uchun: <code>/oraliq 2026-09-01 2026-09-07 123456789</code>\n\nYoki tugmali ko'rinish uchun /davr yozing.", { parse_mode: 'HTML' });
    }
    const from = time.parseDate(parts[0]);
    const to = time.parseDate(parts[1]);
    if (!from || !to) return ctx.reply('❌ Sanalarni tushunmadim. Misol: /oraliq 2026-09-01 2026-09-07');
    let empId = null;
    if (parts[2]) {
      const emp = await employees.byTgId(Number(parts[2]));
      if (!emp) return ctx.reply('❌ Bunday hodim topilmadi.');
      empId = emp.id;
    }
    const norm = period.normalize(from, to);
    setSel(ctx, { pFrom: norm.from, pTo: norm.to, pEmp: empId });
    return showReport(ctx);
  });

  bot.action('pr:home', async (ctx) => { await ctx.answerCbQuery(); return showHome(ctx); });
  bot.action('pr:period', async (ctx) => { await ctx.answerCbQuery(); return showPeriod(ctx); });
  bot.action('pr:who', async (ctx) => { await ctx.answerCbQuery(); return showWho(ctx); });
  bot.action('pr:type', async (ctx) => { await ctx.answerCbQuery(); return askTyped(ctx); });
  bot.action('pr:nop', (ctx) => ctx.answerCbQuery());
  bot.action(/^pr:pre:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await guard(ctx))) return null;
    const range = period.presetRange(ctx.match[1]);
    if (!range) return showPeriod(ctx);
    setSel(ctx, { pFrom: range[0], pTo: range[1] });
    return showHome(ctx);
  });
  bot.action(/^pr:cal:([ft]):(\d{4}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); return showCalendar(ctx, ctx.match[1], ctx.match[2]); });
  bot.action(/^pr:set:([ft]):(\d{4}-\d{2}-\d{2})$/, async (ctx) => { await ctx.answerCbQuery(); return pickDate(ctx, ctx.match[1], ctx.match[2]); });
  bot.action(/^pr:w:(all|\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await guard(ctx))) return null;
    setSel(ctx, { pEmp: ctx.match[1] === 'all' ? null : Number(ctx.match[1]) });
    return showReport(ctx);
  });
  bot.action('pr:go', async (ctx) => { await ctx.answerCbQuery('Hisoblanmoqda…'); return showReport(ctx); });
  bot.action('pr:x', sendExcel);
};

module.exports = { register, showHome, showReport, handleTypedDates, parseRange, calendarKeyboard };
