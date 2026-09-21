'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render, guard } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const kpi = require('../services/kpi');
const excel = require('../services/excel');
const notify = require('../services/notify');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * KPI BO'LIMI.
 *   kpi:*  — direktor: oy → hodimlar ro'yxati → kartochka (baho / mezon / fond / izoh / tasdiqlash / chiqarish) · Excel
 *   hs:*   — bo'lim boshlig'i: oy → o'z hodimlarini 1–10 baholash
 */

const monthButtons = (prefix) => {
  const cur = time.month();
  return [cb(`📅 ${time.monthName(time.shiftMonth(cur, -2))}`, `${prefix}:m:${time.shiftMonth(cur, -2)}`), cb(`📅 ${time.monthName(time.shiftMonth(cur, -1))}`, `${prefix}:m:${time.shiftMonth(cur, -1)}`), cb(`📅 ${time.monthName(cur)} (joriy)`, `${prefix}:m:${cur}`)];
};

const kpiHome = (ctx) =>
  render(ctx, `💰 <b>KPI</b>\n\nQaysi oy? Odatda o'tgan oy — oyning 1-kunida avtomatik tayyor bo'ladi.`, inline([[monthButtons('kpi')[1]], [monthButtons('kpi')[2]], [monthButtons('kpi')[0]]]));

const kpiMonth = async (ctx, month) => {
  if (!time.isValidMonth(month)) return kpiHome(ctx);
  const rows = await kpi.computeAll(month);
  const lines = [];
  let lastDept = null;
  let totalBonus = 0, confirmed = 0, excluded = 0;
  for (const k of rows) {
    if (k.department_name !== lastDept) { lastDept = k.department_name; lines.push(`\n🏢 <b>${esc(lastDept || "Bo'limsiz")}</b>`); }
    if (k.status === 'confirmed') { confirmed += 1; totalBonus += Number(k.bonus_amount) || 0; }
    if (k.status === 'excluded') excluded += 1;
    const icon = k.status === 'confirmed' ? '✅' : k.status === 'excluded' ? '⛔' : '⏳';
    const warn = (Number(k.w_head) > 0 && k.head_score === null) || (Number(k.w_custom) > 0 && k.custom_pct === null) ? ' ⚠️' : '';
    lines.push(`${icon} <b>${esc(k.full_name)}</b> — <b>${k.total}</b> ball${k.bonus_amount !== null ? ` · ${kpi.fmtMoney(k.bonus_amount)}` : ''}${warn}`);
  }
  const text =
    `💰 <b>KPI — ${time.monthName(month)}</b>\n${ui.LINE}\n` +
    `Hodimlar: ${rows.length} · ✅ tasdiqlangan ${confirmed} · ⛔ chiqarilgan ${excluded} · ⏳ kutmoqda ${rows.length - confirmed - excluded}\n` +
    `Tasdiqlangan bonus jami: <b>${kpi.fmtMoney(totalBonus)}</b>\n<i>⚠️ — boshliq bahosi yoki mezon kiritilmagan</i>\n` +
    lines.join('\n');
  const btns = rows.map((k) => [cb(`${k.status === 'confirmed' ? '✅' : k.status === 'excluded' ? '⛔' : '⏳'} ${k.full_name} · ${k.total}`.slice(0, 60), `kpi:e:${k.employee_id}:${month}`)]);
  btns.push([cb('📥 Excel', `kpi:xl:${month}`), cb('✅ Hammasini tasdiqlash', `kpi:okall:${month}`)]);
  btns.push([cb('🔄 Qayta hisoblash', `kpi:recalc:${month}`), cb('⬅️ Oylar', 'kpi:home')]);
  return render(ctx, text, inline(btns));
};

const kpiCardText = (k, dept) => {
  const customName = (dept && dept.custom_name) || "Qo'shimcha mezon";
  const headPct = k.head_score === null ? null : Number(k.head_score) * 10;
  const line = (label, pct, w) => `   ${label}: ${pct === null ? '<i>kiritilmagan</i>' : `${pct}%`} × ${w}%${pct !== null && w > 0 ? ` = <b>${Math.round((pct * w) / 100)}</b>` : ''}`;
  return (
    `💰 <b>${esc(k.full_name)}</b> — ${time.monthName(k.month)}\n` +
    `<i>${esc(k.position || '')}${k.department_name ? ` · ${esc(k.department_name)}` : ''}</i>\n${ui.LINE}\n` +
    `📋 Topshiriq: ${k.tasks_ontime}/${k.tasks_total} muddatida${Number(k.tasks_returned) ? ` · ↩️ ${k.tasks_returned} qaytarish (−${Number(k.tasks_returned) * config.returnPenaltyPct}%)` : ''}\n${line('   →', k.tasks_pct, k.w_tasks)}\n` +
    `🕘 Davomat: ${k.ontime_days} vaqtida · ${k.late_days} kech · ${k.absent_days} kelmagan · ${k.excused_days} sababli (${k.work_days} ish kuni)\n${line('   →', k.att_pct, k.w_attendance)}\n` +
    `⭐ Boshliq bahosi: ${k.head_score === null ? '—' : `${k.head_score}/10`}${k.head_note ? ` («${esc(k.head_note)}»)` : ''}\n${line('   →', headPct, k.w_head)}\n` +
    `🎯 ${esc(customName)}\n${line('   →', k.custom_pct, k.w_custom)}\n${ui.LINE}\n` +
    `🏆 <b>KPI: ${k.total} ball</b>  ${ui.pctBar(k.total)}\n` +
    `💵 Fond: ${kpi.fmtMoney(k.bonus_fund)} → Bonus: <b>${kpi.fmtMoney(k.bonus_amount)}</b>\n` +
    `Holat: ${kpi.statusLabel(k.status)}${k.note ? `\n💬 ${esc(k.note)}` : ''}` +
    (k.status === 'draft' && ((Number(k.w_head) > 0 && k.head_score === null) || (Number(k.w_custom) > 0 && k.custom_pct === null))
      ? `\n\n<i>ℹ️ Kiritilmagan komponent hisobdan chiqarilib, qolgan vaznlar 100 ga keltiriladi.</i>` : '')
  );
};

const kpiCard = async (ctx, empId, month) => {
  const emp = await employees.byId(empId);
  if (!emp) return kpiMonth(ctx, month);
  const k = await kpi.compute(emp, month);
  const dept = emp.department_id ? await departments.byId(emp.department_id) : null;
  const p = `${emp.id}:${month}`;
  const rows = [
    [cb('⭐ Boshliq bahosi', `kpi:score:${p}`), cb('🎯 Mezon %', `kpi:custom:${p}`)],
    [cb('💰 Bonus fondi', `kpi:fund:${p}`), cb('💬 Izoh', `kpi:note:${p}`)],
  ];
  if (k.status === 'draft') rows.push([cb('✅ Tasdiqlash', `kpi:ok:${p}`), cb('⛔ Bonusdan chiqarish', `kpi:ex:${p}`)]);
  else rows.push([cb('↩️ Qaytadan ochish', `kpi:reopen:${p}`)]);
  rows.push([cb('📊 Batafsil hisobot', `rp:emp:${emp.id}:${month}`), cb("⬅️ Ro'yxat", `kpi:m:${month}`)]);
  return render(ctx, kpiCardText(k, dept), inline(rows));
};

const notifyDecision = async (ctx, k) => {
  const dept = k.department_id ? await departments.byId(k.department_id) : null;
  if (k.status === 'confirmed') {
    await notify.toUser(
      botOf(ctx), k.tg_id,
      `🏆 <b>${time.monthName(k.month)} — KPI natijangiz tasdiqlandi</b>\n\n` +
        `📋 Topshiriq: ${k.tasks_pct}% · 🕘 Davomat: ${k.att_pct}% · ⭐ Boshliq: ${k.head_score === null ? '—' : `${k.head_score}/10`} · 🎯 ${esc((dept && dept.custom_name) || 'Mezon')}: ${k.custom_pct === null ? '—' : `${k.custom_pct}%`}\n\n` +
        `<b>KPI: ${k.total} ball</b>${k.bonus_amount !== null ? `\n💵 Bonus: <b>${kpi.fmtMoney(k.bonus_amount)}</b>` : ''}${k.note ? `\n💬 ${esc(k.note)}` : ''}`,
    );
  } else if (k.status === 'excluded') {
    await notify.toUser(botOf(ctx), k.tg_id, `⛔ <b>${time.monthName(k.month)}</b> — bu oy bonusdan chiqarildingiz.${k.note ? `\n💬 ${esc(k.note)}` : ''}\n\nSavollar bo'lsa rahbariyatga murojaat qiling.`);
  }
};

const handleKpiText = async (ctx, field, { skip = false } = {}) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  if (!s.empId || !s.month) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const text = ctx.message.text.trim();
  if (field === 'custom') {
    const n = Number(text.replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) { session.set(ctx.from.id, { step: 'kpi_custom', empId: s.empId, month: s.month }); return ctx.reply('0–100 oralig\'ida son yozing:', ui.cancelKeyboard()); }
    await kpi.setCustomPct(s.empId, s.month, n);
  }
  if (field === 'fund') {
    const n = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n)) { session.set(ctx.from.id, { step: 'kpi_fund', empId: s.empId, month: s.month }); return ctx.reply('Faqat raqam (so\'mda):', ui.cancelKeyboard()); }
    await kpi.setBonusFund(s.empId, s.month, n > 0 ? n : null);
  }
  if (field === 'note') await kpi.setNote(s.empId, s.month, skip ? null : text);
  if (field === 'exclude_note') {
    await kpi.setNote(s.empId, s.month, skip ? null : text);
    const k = await kpi.decide(s.empId, s.month, 'excluded', ctx.from.id);
    await notifyDecision(ctx, k);
  }
  if (field === 'head_note') {
    const k = await kpi.get(s.empId, s.month);
    await kpi.setHeadScore(s.empId, s.month, k.head_score, skip ? null : text);
    await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
    return s.from === 'hs' ? hsList(ctx, s.month) : kpiCard(ctx, s.empId, s.month);
  }
  await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
  return kpiCard(ctx, s.empId, s.month);
};

// ---------------------------------------------------------------------------
// BOSHLIQ BAHOLASHI (hs:)
// ---------------------------------------------------------------------------

const hsScope = (ctx) => (ctx.state.isAdmin ? null : ctx.state.employee.department_id);

const hsHome = (ctx) => {
  if (!ctx.state.isManager) return ctx.reply("⛔️ Faqat bo'lim boshlig'i va direktor uchun.");
  if (!ctx.state.isAdmin && !ctx.state.employee.department_id) return ctx.reply("Sizga bo'lim biriktirilmagan — direktorga ayting.");
  return render(ctx, `⭐ <b>BAHOLASH</b>\n\nHar hodimga oy uchun 1–10 baho qo'yasiz — bu KPI ning «boshliq bahosi» qismi.\nQaysi oy?`, inline([[monthButtons('hs')[1]], [monthButtons('hs')[2]], [monthButtons('hs')[0]]]));
};

const hsList = async (ctx, month) => {
  const deptId = hsScope(ctx);
  const me = ctx.state.employee ? Number(ctx.state.employee.id) : -1;
  const list = (deptId ? await employees.listByDepartment(deptId) : await employees.listActive()).filter((e) => Number(e.id) !== me);
  const lines = [];
  const rows = [];
  for (const e of list) {
    const k = await kpi.compute(e, month);
    lines.push(`${k.head_score === null ? '▫️' : '⭐'} <b>${esc(e.full_name)}</b> — ${k.head_score === null ? '<i>baholanmagan</i>' : `${k.head_score}/10`}${k.head_note ? ` («${esc(k.head_note)}»)` : ''}\n   📋 ${k.tasks_pct}% · 🕘 ${k.att_pct}%`);
    rows.push([cb(`${k.head_score === null ? '▫️' : `⭐ ${k.head_score}`} ${e.full_name}`.slice(0, 60), `hs:e:${e.id}:${month}`)]);
  }
  rows.push([cb('⬅️ Oylar', 'hs:home')]);
  return render(ctx, `⭐ <b>BAHOLASH — ${time.monthName(month)}</b>\n<i>📋 topshiriq % · 🕘 davomat % (ma'lumot uchun)</i>\n\n${lines.join('\n') || "<i>hodim yo'q</i>"}`, inline(rows));
};

const hsPick = async (ctx, empId, month) => {
  const e = await employees.byId(empId);
  if (!e || !employees.canManage(ctx.state.employee, ctx.state.isAdmin, e)) return ctx.answerCbQuery('⛔️');
  await ctx.answerCbQuery();
  const k = await kpi.compute(e, month);
  return render(ctx, `⭐ <b>${esc(e.full_name)}</b> — ${time.monthName(month)}\n📋 topshiriq ${k.tasks_pct}% · 🕘 davomat ${k.att_pct}%\nHozirgi baho: ${k.head_score === null ? '—' : `${k.head_score}/10`}\n\nBahoni tanlang (1 — juda yomon, 10 — a'lo):`, ui.scoreKeyboard(`hs:s:${e.id}:${month}`));
};

const hsSet = async (ctx, empId, month, score, from = 'hs') => {
  const e = await employees.byId(empId);
  if (!e || !employees.canManage(ctx.state.employee, ctx.state.isAdmin, e)) return ctx.answerCbQuery('⛔️');
  await kpi.setHeadScore(e.id, month, score);
  await ctx.answerCbQuery(`⭐ ${score}/10`);
  session.set(ctx.from.id, { step: 'head_note', empId: e.id, month, from });
  return ctx.reply(`⭐ ${esc(e.full_name)}: <b>${score}/10</b>. Qisqa izoh (ixtiyoriy) yoki «${ui.BTN.skip}»:`, { parse_mode: 'HTML', ...ui.skipKeyboard() });
};

const register = (bot) => {
  bot.hears(ui.BTN.kpi, async (ctx) => { if (await guard(ctx)) await kpiHome(ctx); });
  bot.command('kpi', async (ctx) => { if (await guard(ctx)) await kpiHome(ctx); });
  bot.action('kpi:home', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await kpiHome(ctx); } });
  bot.action(/^kpi:m:(\d{4}-\d{2})$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await kpiMonth(ctx, ctx.match[1]); } });
  bot.action(/^kpi:recalc:(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await kpi.computeAll(ctx.match[1], { force: false });
    await ctx.answerCbQuery('Qayta hisoblandi (kutilayotganlar)');
    await kpiMonth(ctx, ctx.match[1]);
  });
  bot.action(/^kpi:e:(\d+):(\d{4}-\d{2})$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await kpiCard(ctx, ctx.match[1], ctx.match[2]); } });
  bot.action(/^kpi:score:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const e = await employees.byId(ctx.match[1]);
    return render(ctx, `⭐ <b>${esc(e.full_name)}</b> — boshliq bahosi (1–10):`, ui.scoreKeyboard(`kpi:sc:${e.id}:${ctx.match[2]}`));
  });
  bot.action(/^kpi:sc:(\d+):(\d{4}-\d{2}):(\d+|back)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    if (ctx.match[3] === 'back') { await ctx.answerCbQuery(); return kpiCard(ctx, ctx.match[1], ctx.match[2]); }
    return hsSet(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]), 'kpi');
  });
  bot.action(/^kpi:custom:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const e = await employees.byId(ctx.match[1]);
    const dept = e.department_id ? await departments.byId(e.department_id) : null;
    session.set(ctx.from.id, { step: 'kpi_custom', empId: e.id, month: ctx.match[2] });
    return ctx.reply(`🎯 <b>${esc((dept && dept.custom_name) || "Qo'shimcha mezon")}</b> — ${esc(e.full_name)} uchun bajarilish foizi (0–100):`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  });
  bot.action(/^kpi:fund:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'kpi_fund', empId: Number(ctx.match[1]), month: ctx.match[2] });
    return ctx.reply("💰 Shu oy uchun bonus fondi (so'mda). 0 — fondsiz:", ui.cancelKeyboard());
  });
  bot.action(/^kpi:note:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'kpi_note', empId: Number(ctx.match[1]), month: ctx.match[2] });
    return ctx.reply(`💬 Izoh (hodim tasdiqlashda ko'radi) yoki «${ui.BTN.skip}» — izohni o'chirish:`, ui.skipKeyboard());
  });
  bot.action(/^kpi:ok:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const k = await kpi.decide(ctx.match[1], ctx.match[2], 'confirmed', ctx.from.id);
    await ctx.answerCbQuery('Tasdiqlandi ✅');
    await notifyDecision(ctx, k);
    return kpiCard(ctx, ctx.match[1], ctx.match[2]);
  });
  bot.action(/^kpi:ex:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'kpi_exclude_note', empId: Number(ctx.match[1]), month: ctx.match[2] });
    return ctx.reply(`⛔ Bonusdan chiqarish sababi (hodim ko'radi) yoki «${ui.BTN.skip}»:`, ui.skipKeyboard());
  });
  bot.action(/^kpi:reopen:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await kpi.decide(ctx.match[1], ctx.match[2], 'draft', ctx.from.id);
    await ctx.answerCbQuery('Qayta ochildi');
    return kpiCard(ctx, ctx.match[1], ctx.match[2]);
  });
  bot.action(/^kpi:okall:(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    return render(ctx, `✅ ${time.monthName(ctx.match[1])} — kutilayotgan barcha hodimlar tasdiqlansinmi? Har biriga natija yuboriladi.`, ui.confirmKeyboard(`kpi:okallok:${ctx.match[1]}`, `kpi:m:${ctx.match[1]}`, '✅ Ha, hammasi'));
  });
  bot.action(/^kpi:okallok:(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    let n = 0;
    for (const k of await kpi.listMonth(ctx.match[1])) {
      if (k.status !== 'draft') continue;
      const d = await kpi.decide(k.employee_id, ctx.match[1], 'confirmed', ctx.from.id);
      await notifyDecision(ctx, d);
      n += 1;
    }
    await ctx.reply(`✅ ${n} ta hodim tasdiqlandi.`);
    return kpiMonth(ctx, ctx.match[1]);
  });
  bot.action(/^kpi:xl:(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery('Tayyorlanmoqda…');
    const { buffer, filename } = await excel.buildMonthly(ctx.match[1]);
    await notify.docToUser(botOf(ctx), ctx.from.id, buffer, filename, `📥 <b>${time.monthName(ctx.match[1])}</b> — KPI, topshiriqlar, davomat`);
  });

  // boshliq baholashi
  bot.hears(ui.BTN.score, hsHome);
  bot.command('baholash', hsHome);
  bot.action('hs:home', async (ctx) => { await ctx.answerCbQuery(); await hsHome(ctx); });
  bot.action(/^hs:m:(\d{4}-\d{2})$/, async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await hsList(ctx, ctx.match[1]); });
  bot.action(/^hs:e:(\d+):(\d{4}-\d{2})$/, (ctx) => hsPick(ctx, ctx.match[1], ctx.match[2]));
  bot.action(/^hs:s:(\d+):(\d{4}-\d{2}):(\d+|back)$/, async (ctx) => {
    if (ctx.match[3] === 'back') { await ctx.answerCbQuery(); return hsList(ctx, ctx.match[2]); }
    return hsSet(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]));
  });
};

module.exports = { register, handleKpiText, kpiMonth, hsList };
