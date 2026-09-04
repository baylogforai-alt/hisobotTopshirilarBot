'use strict';

const { Markup } = require('telegraf');
const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const employees = require('../services/employees');
const missions = require('../services/missions');
const history = require('../services/history');
const activity = require('../services/activity');
const excel = require('../services/excel');
const notify = require('../services/notify');
const reports = require('../services/reports');

/**
 * «HODIMLAR ARXIVI» — direktor uchun ilova ko'rinishidagi panel.
 * Bitta xabar ichida tugmalar orqali yuriladi: hodim → kun → harakatlar →
 * davr hisoboti → Excel. Har bosishda o'sha xabar yangilanadi, shuning uchun
 * chat toza qoladi va haqiqiy ilovaga o'xshaydi.
 */

const TG_LIMIT = 3900;

/** Telegram chegarasidan oshib ketmasligi uchun matnni xavfsiz qisqartiradi */
const fit = (text) =>
  text.length <= TG_LIMIT
    ? text
    : `${text.slice(0, TG_LIMIT)}\n\n<i>…hisobot juda uzun. To'liq ko'rinish uchun Excel faylni yuklab oling.</i>`;

/** Callback bo'lsa xabarni yangilaydi, aks holda yangi xabar yuboradi */
const render = async (ctx, text, keyboard) => {
  const extra = {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(keyboard || {}),
  };
  if (ctx.updateType === 'callback_query') {
    try {
      return await ctx.editMessageText(fit(text), extra);
    } catch (err) {
      // Matn o'zgarmagan bo'lsa Telegram xato beradi — jim o'tkazamiz
      if (/message is not modified/i.test(err.description || err.message || '')) return null;
      return ctx.reply(fit(text), extra);
    }
  }
  return ctx.reply(fit(text), extra);
};

const guard = async (ctx) => {
  if (ctx.state.isAdmin) return true;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('⛔️ Faqat administrator uchun');
  else await ctx.reply('⛔️ Bu bo\'lim faqat administrator uchun.');
  return false;
};

// ---------------------------------------------------------------------------
// 1) BOSH SAHIFA — hodimlar ro'yxati
// ---------------------------------------------------------------------------

const homeText = async () => {
  const list = await employees.listActive();
  if (!list.length) return "Hodimlar ro'yxati bo'sh. /hodim_qosh bilan qo'shing.";

  const t = time.today();
  const lines = [];
  for (const emp of list) {
    const { status, st } = await history.statusLine(emp, t);
    const last = await activity.lastSeen(emp.id);
    const seen =
      last && last.work_date === t
        ? `bugun ${time.clock(last.created_at)}`
        : last
          ? time.prettyDate(last.work_date)
          : "hali kirmagan";
    lines.push(
      `👤 <b>${ui.esc(emp.full_name)}</b>${emp.position ? ` · <i>${ui.esc(emp.position)}</i>` : ''}\n` +
        `   ${status} · ✅ ${st.done}  ⏳ ${st.open}${st.overdue ? `  ⚠️ ${st.overdue}` : ''}\n` +
        `   <i>oxirgi faollik: ${ui.esc(seen)}</i>`,
    );
  }

  return (
    `🗂 <b>HODIMLAR ARXIVI</b>\n` +
    `<i>${config.companyName} · ${time.prettyDate(t)}</i>\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `👇 Kimning faoliyatini ko'rmoqchisiz?`
  );
};

const homeKeyboard = async () => {
  const list = await employees.listActive();
  const rows = list.map((e) => [Markup.button.callback(`👤 ${e.full_name}`, `hr:emp:${e.id}`)]);
  rows.push([
    Markup.button.callback('🏢 Jamoa · 7 kun', 'hr:team:7'),
    Markup.button.callback('🏢 30 kun', 'hr:team:30'),
  ]);
  rows.push([Markup.button.callback('🔄 Yangilash', 'hr:home')]);
  return Markup.inlineKeyboard(rows);
};

const showHome = async (ctx) => {
  if (!(await guard(ctx))) return null;
  return render(ctx, await homeText(), await homeKeyboard());
};

// ---------------------------------------------------------------------------
// 2) KUN DAFTARI — bitta hodim, bitta kun
// ---------------------------------------------------------------------------

const dayKeyboard = (empId, date) => {
  const prev = time.addDays(date, -1);
  const next = time.addDays(date, 1);
  const t = time.today();
  const rows = [];

  const nav = [Markup.button.callback('◀️ Oldingi kun', `hr:d:${empId}:${prev}`)];
  if (date < t) nav.push(Markup.button.callback('Keyingi kun ▶️', `hr:d:${empId}:${next}`));
  rows.push(nav);
  if (date !== t) rows.push([Markup.button.callback('📅 Bugunga qaytish', `hr:d:${empId}:${t}`)]);

  rows.push([
    Markup.button.callback('📜 Harakatlar tarixi', `hr:t:${empId}:${date}`),
    Markup.button.callback('🗓 Kun tanlash', `hr:pick:${empId}:${date}`),
  ]);
  rows.push([
    Markup.button.callback('📊 7 kunlik', `hr:r:${empId}:7`),
    Markup.button.callback('📊 30 kunlik', `hr:r:${empId}:30`),
  ]);
  rows.push([
    Markup.button.callback('🎯 Missiyalari', `hr:m:${empId}`),
    Markup.button.callback('📥 Excel', `hr:x:${empId}:30`),
  ]);
  rows.push([Markup.button.callback('⬅️ Hodimlar', 'hr:home')]);
  return Markup.inlineKeyboard(rows);
};

const showDay = async (ctx, empId, date) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  await missions.activateDue(emp.id);
  return render(ctx, await history.dayCard(emp, date), dayKeyboard(emp.id, date));
};

// ---------------------------------------------------------------------------
// 3) KUN TANLASH — oxirgi 14 kun tugmalari
// ---------------------------------------------------------------------------

const UZ_SHORT = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

const showPicker = async (ctx, empId, date) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());

  const t = time.today();
  const buttons = [];
  let row = [];
  for (let i = 0; i < 14; i += 1) {
    const d = time.addDays(t, -i);
    const dt = new Date(`${d}T00:00:00`);
    const label = `${UZ_SHORT[(dt.getDay() + 6) % 7]} ${d.slice(8, 10)}.${d.slice(5, 7)}`;
    row.push(Markup.button.callback(i === 0 ? `📅 ${label}` : label, `hr:d:${empId}:${d}`));
    if (row.length === 3) {
      buttons.push(row);
      row = [];
    }
  }
  if (row.length) buttons.push(row);
  buttons.push([Markup.button.callback('⬅️ Orqaga', `hr:d:${empId}:${date}`)]);

  return render(
    ctx,
    `🗓 <b>KUN TANLASH</b>\n👤 <b>${ui.esc(emp.full_name)}</b>\n\n` +
      `Qaysi kunning daftarini ochamiz?\n<i>Oxirgi 14 kun ko'rsatilgan.</i>`,
    Markup.inlineKeyboard(buttons),
  );
};

// ---------------------------------------------------------------------------
// 4) HARAKATLAR LENTASI
// ---------------------------------------------------------------------------

const showTimeline = async (ctx, empId, date) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  return render(
    ctx,
    await history.timeline(emp, date),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('◀️ Oldingi kun', `hr:t:${empId}:${time.addDays(date, -1)}`),
        Markup.button.callback('Keyingi kun ▶️', `hr:t:${empId}:${time.addDays(date, 1)}`),
      ],
      [Markup.button.callback('🗂 Kun daftariga qaytish', `hr:d:${empId}:${date}`)],
      [Markup.button.callback('⬅️ Hodimlar', 'hr:home')],
    ]),
  );
};

// ---------------------------------------------------------------------------
// 5) DAVR HISOBOTI
// ---------------------------------------------------------------------------

const showRange = async (ctx, empId, days) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  return render(
    ctx,
    await history.rangeReport(emp, days),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(days === 7 ? '• 7 kun •' : '7 kun', `hr:r:${empId}:7`),
        Markup.button.callback(days === 30 ? '• 30 kun •' : '30 kun', `hr:r:${empId}:30`),
      ],
      [Markup.button.callback(`📥 Excel (${days} kun)`, `hr:x:${empId}:${days}`)],
      [Markup.button.callback('🗂 Kun daftari', `hr:d:${empId}:${time.today()}`)],
      [Markup.button.callback('⬅️ Hodimlar', 'hr:home')],
    ]),
  );
};

// ---------------------------------------------------------------------------
// 6) MISSIYALARI / JAMOA / EXCEL
// ---------------------------------------------------------------------------

const showMissions = async (ctx, empId) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return render(ctx, '❌ Hodim topilmadi.', await homeKeyboard());
  return render(
    ctx,
    await reports.buildEmployeeMissions(emp),
    Markup.inlineKeyboard([
      [Markup.button.callback('🗂 Kun daftari', `hr:d:${empId}:${time.today()}`)],
      [Markup.button.callback('⬅️ Hodimlar', 'hr:home')],
    ]),
  );
};

const showTeam = async (ctx, days) => {
  if (!(await guard(ctx))) return null;
  return render(
    ctx,
    await history.teamOverview(days),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(days === 7 ? '• 7 kun •' : '7 kun', 'hr:team:7'),
        Markup.button.callback(days === 30 ? '• 30 kun •' : '30 kun', 'hr:team:30'),
      ],
      [Markup.button.callback(`📥 Jamoa jamlanmasi (${days} kun)`, `hr:tx:${days}`)],
      [Markup.button.callback('⬅️ Hodimlar', 'hr:home')],
    ]),
  );
};

/** Butun jamoa uchun bitta jamlanma Excel */
const sendTeamExcel = async (ctx, days) => {
  if (!(await guard(ctx))) return null;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('Tayyorlanmoqda…');
  const { buffer, filename } = await excel.buildTeamSummary(days);
  return notify.docToUser(
    { telegram: ctx.telegram },
    ctx.from.id,
    buffer,
    filename,
    `📥 <b>${ui.esc(config.companyName)}</b> — jamoa jamlanmasi, so'nggi ${days} kun.`,
  );
};

const sendExcel = async (ctx, empId, days) => {
  if (!(await guard(ctx))) return null;
  const emp = await employees.byId(empId);
  if (!emp) return null;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('Tayyorlanmoqda…');
  const { buffer, filename } = await excel.buildEmployeeHistory(emp, days);
  return notify.docToUser(
    { telegram: ctx.telegram },
    ctx.from.id,
    buffer,
    filename,
    `📥 <b>${ui.esc(emp.full_name)}</b> — so'nggi ${days} kunlik to'liq faoliyat arxivi.\n` +
      `<i>Varaqlar: Kunlar · Missiyalar · Harakatlar</i>`,
  );
};

// ---------------------------------------------------------------------------

const register = (bot) => {
  bot.command(['arxiv', 'hodim_arxiv'], showHome);
  bot.hears(ui.BTN.archive, showHome);

  /** /hodim_hisobot <tg_id> — to'g'ridan-to'g'ri bitta hodim kartochkasi */
  bot.command('hodim_hisobot', async (ctx) => {
    if (!(await guard(ctx))) return null;
    const arg = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
    if (!arg) return showHome(ctx);
    const emp = await employees.byTgId(Number(arg));
    if (!emp) return ctx.reply('❌ Bunday hodim topilmadi. /arxiv orqali ro\'yxatdan tanlang.');
    return showDay(ctx, emp.id, time.today());
  });

  bot.action('hr:home', async (ctx) => {
    await ctx.answerCbQuery();
    return showHome(ctx);
  });
  bot.action(/^hr:emp:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showDay(ctx, Number(ctx.match[1]), time.today());
  });
  bot.action(/^hr:d:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showDay(ctx, Number(ctx.match[1]), ctx.match[2]);
  });
  bot.action(/^hr:t:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showTimeline(ctx, Number(ctx.match[1]), ctx.match[2]);
  });
  bot.action(/^hr:pick:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showPicker(ctx, Number(ctx.match[1]), ctx.match[2]);
  });
  bot.action(/^hr:r:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Hisoblanmoqda…');
    return showRange(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.action(/^hr:m:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showMissions(ctx, Number(ctx.match[1]));
  });
  bot.action(/^hr:team:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Hisoblanmoqda…');
    return showTeam(ctx, Number(ctx.match[1]));
  });
  bot.action(/^hr:x:(\d+):(\d+)$/, (ctx) => sendExcel(ctx, Number(ctx.match[1]), Number(ctx.match[2])));
  bot.action(/^hr:tx:(\d+)$/, (ctx) => sendTeamExcel(ctx, Number(ctx.match[1])));
};

module.exports = { register, showHome, showDay };
