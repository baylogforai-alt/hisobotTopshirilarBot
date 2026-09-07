'use strict';

const { Markup } = require('telegraf');
const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const employees = require('../services/employees');
const period = require('../services/period');
const excel = require('../services/excel');
const notify = require('../services/notify');
const activity = require('../services/activity');

/**
 * «DAVR HISOBOTI» — direktor uchun hisobot markazi.
 *
 * Uch qadam: 1) davrni tanlash (tayyor tugma / kalendar / qo'lda yozish)
 *            2) kimni (bitta hodim yoki butun jamoa)
 *            3) ko'rish yoki Excel qilib yuklab olish.
 *
 * Tanlov sessiyada saqlanadi, shuning uchun davrni bir marta tanlab,
 * hodimdan hodimga o'tib chiqish mumkin.
 */

const TG_LIMIT = 3800;

const guard = async (ctx) => {
  if (ctx.state.isAdmin) return true;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('⛔️ Faqat administrator uchun');
  else await ctx.reply("⛔️ Bu bo'lim faqat administrator uchun.");
  return false;
};

// --- sessiyadagi tanlov ------------------------------------------------------

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

// --- uzun matnni bo'lib yuborish --------------------------------------------

/** Callback bo'lsa xabarni yangilaydi, sig'masa — bo'lib yuboradi */
const render = async (ctx, text, keyboard) => {
  const extra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(keyboard || {}) };
  const parts = period.splitText(text, TG_LIMIT);

  if (parts.length === 1 && ctx.updateType === 'callback_query') {
    try {
      return await ctx.editMessageText(parts[0], extra);
    } catch (err) {
      if (/message is not modified/i.test(err.description || err.message || '')) return null;
      return ctx.reply(parts[0], extra);
    }
  }
  let last = null;
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    last = await ctx.reply(parts[i], isLast ? extra : { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }
  return last;
};

// ---------------------------------------------------------------------------
// 1) BOSH PANEL
// ---------------------------------------------------------------------------

const homeText = async (sel) =>
  `📈 <b>DAVR HISOBOTI</b>\n<i>${ui.esc(config.companyName)}</i>\n` +
  `${'━'.repeat(18)}\n\n` +
  `🗓 <b>Davr:</b> ${time.prettyRange(sel.from, sel.to)}\n` +
  `      <i>${sel.from} → ${sel.to} · ${sel.days} kun</i>\n` +
  `👥 <b>Kim:</b> ${ui.esc(await scopeName(sel.empId))}\n\n` +
  `Boshlanish va tugash sanasini o'zingiz tanlaysiz.\n` +
  `Keyin hisobotni ekranda ko'rasiz yoki Excel qilib yuklab olasiz.`;

const homeKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🗓 Davrni tanlash', 'pr:period')],
    [Markup.button.callback('👥 Kimni ko\'ramiz?', 'pr:who')],
    [Markup.button.callback('📊 Hisobotni ko\'rish', 'pr:go')],
    [Markup.button.callback('📥 Excel yuklab olish', 'pr:x')],
    [Markup.button.callback('🗂 Hodimlar arxivi', 'hr:home')],
  ]);

const showHome = async (ctx) => {
  if (!(await guard(ctx))) return null;
  return render(ctx, await homeText(getSel(ctx)), homeKeyboard());
};

// ---------------------------------------------------------------------------
// 2) DAVRNI TANLASH
// ---------------------------------------------------------------------------

const showPeriod = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  const b = (key) => Markup.button.callback(period.PRESETS[key].label, `pr:pre:${key}`);
  return render(
    ctx,
    `🗓 <b>DAVRNI TANLASH</b>\n${'━'.repeat(18)}\n\n` +
      `Hozirgi tanlov: <b>${time.prettyRange(sel.from, sel.to)}</b> <i>(${sel.days} kun)</i>\n\n` +
      `Tayyor davrlardan birini bosing yoki kalendardan aniq sanani tanlang.`,
    Markup.inlineKeyboard([
      [b('today'), b('yesterday')],
      [b('week'), b('lastweek')],
      [b('month'), b('lastmonth')],
      [b('d7'), b('d30'), b('d90')],
      [b('year')],
      [Markup.button.callback('🗓 Kalendardan tanlash', `pr:cal:f:${sel.from.slice(0, 7)}`)],
      [Markup.button.callback("⌨️ Sanani qo'lda yozish", 'pr:type')],
      [Markup.button.callback('⬅️ Orqaga', 'pr:home')],
    ]),
  );
};

// ---------------------------------------------------------------------------
// 3) KALENDAR
// ---------------------------------------------------------------------------

const NOP = 'pr:nop';

/** Bir oylik kalendar tugmalari. which: 'f' — boshlanish, 't' — tugash */
const calendarKeyboard = (which, month, sel) => {
  const first = `${month}-01`;
  const rows = [];

  rows.push([
    Markup.button.callback('◀️', `pr:cal:${which}:${time.addMonths(first, -1).slice(0, 7)}`),
    Markup.button.callback(time.monthLabel(first), NOP),
    Markup.button.callback('▶️', `pr:cal:${which}:${time.addMonths(first, 1).slice(0, 7)}`),
  ]);
  rows.push(time.UZ_SHORT.map((w) => Markup.button.callback(w, NOP)));

  const last = time.endOfMonth(first);
  const lead = time.UZ_SHORT.indexOf(time.weekdayShort(first)); // dushanba = 0
  const t = time.today();

  let row = [];
  for (let i = 0; i < lead; i += 1) row.push(Markup.button.callback(' ', NOP));
  for (let d = 1; d <= Number(last.slice(8, 10)); d += 1) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    let label = String(d);
    if (date === t) label = `[${d}]`;
    if (date === sel.from) label = `🟢${d}`;
    if (date === sel.to) label = `🔴${d}`;
    if (date === sel.from && date === sel.to) label = `🟢${d}`;
    row.push(
      date > t
        ? Markup.button.callback('·', NOP)
        : Markup.button.callback(label, `pr:set:${which}:${date}`),
    );
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) {
    while (row.length < 7) row.push(Markup.button.callback(' ', NOP));
    rows.push(row);
  }

  rows.push([
    Markup.button.callback('📅 Bugun', `pr:set:${which}:${t}`),
    Markup.button.callback(`🗓 ${time.monthLabel(t)}`, `pr:cal:${which}:${t.slice(0, 7)}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Orqaga', 'pr:period')]);
  return Markup.inlineKeyboard(rows);
};

const showCalendar = async (ctx, which, month) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  const title = which === 'f' ? '🟢 <b>BOSHLANISH SANASI</b>' : '🔴 <b>TUGASH SANASI</b>';
  return render(
    ctx,
    `${title}\n${'━'.repeat(18)}\n\n` +
      `🟢 Boshlanish: <b>${time.prettyDate(sel.from)}</b>\n` +
      `🔴 Tugash: <b>${time.prettyDate(sel.to)}</b>\n\n` +
      `<i>Quyidagi kalendardan ${which === 'f' ? 'boshlanish' : 'tugash'} kunini bosing.\n` +
      `[ ] — bugun · 🟢/🔴 — tanlangan sanalar</i>`,
    calendarKeyboard(which, month, sel),
  );
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

// ---------------------------------------------------------------------------
// 4) QO'LDA YOZISH
// ---------------------------------------------------------------------------

const askTyped = async (ctx) => {
  if (!(await guard(ctx))) return null;
  session.set(ctx.from.id, { step: 'period_dates' });
  return render(
    ctx,
    `⌨️ <b>SANALARNI QO'LDA YOZISH</b>\n${'━'.repeat(18)}\n\n` +
      `Ikkita sanani bitta qatorda yozing:\n\n` +
      `<code>01.09.2026 - 07.09.2026</code>\n` +
      `<code>2026-09-01 2026-09-07</code>\n` +
      `<code>1-sentabr 7-sentabr</code>\n\n` +
      `<i>Bitta sana yozsangiz — o'sha kunning hisoboti chiqadi.</i>`,
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Orqaga', 'pr:period')]]),
  );
};

/**
 * Foydalanuvchi yozgan matndan ikkita sanani ajratadi.
 * '01.09.2026 - 07.09.2026', '2026-09-01 2026-09-07', '1-sentabr 7-sentabr',
 * '01.09.2026 dan 07.09.2026 gacha' — hammasi tushuniladi.
 * Bitta sana yozilsa — o'sha kunning o'zi (from = to). Tushunilmasa null.
 */
const parseRange = (raw) => {
  const text = String(raw || '').trim();
  const dates = [];

  // Avval "7-sentabr" ko'rinishidagilar — ular bo'shliq bilan bo'linib ketmasin
  (text.match(/\d{1,2}\s*[-\s]\s*[a-zA-Zʼ'`]{3,}/g) || []).forEach((m) => {
    const d = time.parseDate(m.replace(/\s+/g, ''));
    if (d && dates.length < 2) dates.push(d);
  });

  if (dates.length < 2) {
    const tokens = text
      .split(/\s*(?:[—–]|,|\s+)\s*/)
      .map((s) => s.replace(/^-+|-+$/g, '').trim())
      .filter(Boolean);
    for (const tk of tokens) {
      const d = time.parseDate(tk);
      if (d && !dates.includes(d)) dates.push(d);
      if (dates.length === 2) break;
    }
  }

  if (!dates.length) return null;
  return period.normalize(dates[0], dates[1] || dates[0]);
};

/** index.js dagi matn ushlagichidan chaqiriladi */
const handleTypedDates = async (ctx) => {
  session.clear(ctx.from.id);
  const norm = parseRange(ctx.message.text);

  if (!norm) {
    return ctx.reply(
      "❌ Sanani tushunmadim.\n\nMisol: <code>01.09.2026 - 07.09.2026</code>\nQaytadan urinib ko'ring yoki /davr bosing.",
      { parse_mode: 'HTML' },
    );
  }

  setSel(ctx, { pFrom: norm.from, pTo: norm.to });
  activity.mark(ctx, 'admin', { title: 'Davr tanladi', detail: `${norm.from} → ${norm.to}` });

  return ctx.reply(await homeText(getSel(ctx)), {
    parse_mode: 'HTML',
    ...homeKeyboard(),
  });
};

// ---------------------------------------------------------------------------
// 5) KIMNI
// ---------------------------------------------------------------------------

const showWho = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  const list = await employees.listActive();
  const rows = [[Markup.button.callback('🏢 Butun jamoa (hammasi bitta hisobotda)', 'pr:w:all')]];
  list.forEach((e) => {
    const mark = String(e.id) === String(sel.empId) ? '✅ ' : '👤 ';
    rows.push([Markup.button.callback(`${mark}${e.full_name}`, `pr:w:${e.id}`)]);
  });
  rows.push([Markup.button.callback('⬅️ Orqaga', 'pr:home')]);

  return render(
    ctx,
    `👥 <b>KIMNING HISOBOTI?</b>\n${'━'.repeat(18)}\n\n` +
      `🗓 Davr: <b>${time.prettyRange(sel.from, sel.to)}</b>\n\n` +
      `Butun jamoani bitta hisobotda ko'rish yoki bitta hodimni alohida tanlash mumkin.`,
    Markup.inlineKeyboard(rows),
  );
};

// ---------------------------------------------------------------------------
// 6) HISOBOT VA EXCEL
// ---------------------------------------------------------------------------

const reportKeyboard = (sel) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📥 Excel yuklab olish', 'pr:x')],
    [
      Markup.button.callback('🗓 Boshqa davr', 'pr:period'),
      Markup.button.callback('👥 Boshqa hodim', 'pr:who'),
    ],
    [
      Markup.button.callback('🔄 Yangilash', 'pr:go'),
      Markup.button.callback(sel.empId ? '🏢 Butun jamoa' : '👤 Bitta hodim', sel.empId ? 'pr:w:all' : 'pr:who'),
    ],
    [Markup.button.callback('⬅️ Panelga qaytish', 'pr:home')],
  ]);

const showReport = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  activity.mark(ctx, 'admin', {
    title: 'Davr hisobotini ochdi',
    detail: `${sel.from} → ${sel.to} · ${sel.empId ? `hodim #${sel.empId}` : 'jamoa'}`,
  });

  if (sel.empId) {
    const emp = await employees.byId(sel.empId);
    if (!emp) {
      setSel(ctx, { pEmp: null });
      return render(ctx, '❌ Hodim topilmadi.', homeKeyboard());
    }
    return render(ctx, await period.employeeReport(emp, sel.from, sel.to), reportKeyboard(sel));
  }
  return render(ctx, await period.teamReport(sel.from, sel.to), reportKeyboard(sel));
};

const sendExcel = async (ctx) => {
  if (!(await guard(ctx))) return null;
  const sel = getSel(ctx);
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('📥 Fayl tayyorlanmoqda…');
  activity.mark(ctx, 'excel', { title: 'Davr hisoboti (Excel)', detail: `${sel.from} → ${sel.to}` });

  let file;
  let caption;
  if (sel.empId) {
    const emp = await employees.byId(sel.empId);
    if (!emp) return ctx.reply('❌ Hodim topilmadi.');
    file = await excel.buildEmployeePeriod(emp, sel.from, sel.to);
    caption =
      `📥 <b>${ui.esc(emp.full_name)}</b> — davr hisoboti\n` +
      `🗓 <i>${time.prettyRange(sel.from, sel.to)} (${sel.days} kun)</i>\n` +
      `<i>Varaqlar: Xulosa · Kunlar · Missiyalar · Harakatlar</i>`;
  } else {
    file = await excel.buildTeamPeriod(sel.from, sel.to);
    caption =
      `📥 <b>${ui.esc(config.companyName)}</b> — jamoa davr hisoboti\n` +
      `🗓 <i>${time.prettyRange(sel.from, sel.to)} (${sel.days} kun)</i>\n` +
      `<i>Varaqlar: Jamlanma · Kunlar · Missiyalar · Kechikkanlar · Bajarilganlar</i>`;
  }

  return notify.docToUser({ telegram: ctx.telegram }, ctx.from.id, file.buffer, file.filename, caption);
};

// ---------------------------------------------------------------------------

const register = (bot) => {
  bot.command(['davr', 'davr_hisobot', 'hisobot_markazi'], showHome);
  bot.hears(ui.BTN.periodReport, showHome);

  /** /oraliq 2026-09-01 2026-09-07 [tg_id] — bir buyruq bilan to'g'ridan-to'g'ri */
  bot.command('oraliq', async (ctx) => {
    if (!(await guard(ctx))) return null;
    const parts = ctx.message.text.replace(/^\/\S+\s*/, '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return ctx.reply(
        '📌 <code>/oraliq 2026-09-01 2026-09-07</code>\n' +
          "Bitta hodim uchun: <code>/oraliq 2026-09-01 2026-09-07 123456789</code>\n\n" +
          'Yoki tugmali ko\'rinish uchun /davr yozing.',
        { parse_mode: 'HTML' },
      );
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

  bot.action('pr:home', async (ctx) => {
    await ctx.answerCbQuery();
    return showHome(ctx);
  });
  bot.action('pr:period', async (ctx) => {
    await ctx.answerCbQuery();
    return showPeriod(ctx);
  });
  bot.action('pr:who', async (ctx) => {
    await ctx.answerCbQuery();
    return showWho(ctx);
  });
  bot.action('pr:type', async (ctx) => {
    await ctx.answerCbQuery();
    return askTyped(ctx);
  });
  bot.action('pr:nop', (ctx) => ctx.answerCbQuery());

  bot.action(/^pr:pre:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await guard(ctx))) return null;
    const range = period.presetRange(ctx.match[1]);
    if (!range) return showPeriod(ctx);
    setSel(ctx, { pFrom: range[0], pTo: range[1] });
    return showHome(ctx);
  });

  bot.action(/^pr:cal:([ft]):(\d{4}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showCalendar(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action(/^pr:set:([ft]):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    return pickDate(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action(/^pr:w:(all|\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await guard(ctx))) return null;
    setSel(ctx, { pEmp: ctx.match[1] === 'all' ? null : Number(ctx.match[1]) });
    return showReport(ctx);
  });

  bot.action('pr:go', async (ctx) => {
    await ctx.answerCbQuery('Hisoblanmoqda…');
    return showReport(ctx);
  });
  bot.action('pr:x', sendExcel);
};

module.exports = { register, showHome, showReport, handleTypedDates, parseRange, calendarKeyboard };
