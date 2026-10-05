'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render, guard, guardSee } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const kpi = require('../services/kpi');
const excel = require('../services/excel');
const notify = require('../services/notify');
const flows = require('../services/flows');

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
    const gate = config.kpiMode === 'gate' ? (Number(k.kpi_eligible) === 1 ? ' 🟢' : ' 🔴') : '';
    const warn = (Number(k.w_head) > 0 && k.head_score === null) || (Number(k.w_custom) > 0 && k.custom_pct === null) ? ' ⚠️' : '';
    lines.push(`${icon}${gate} <b>${esc(k.full_name)}</b> — <b>${k.total}</b> ball${k.bonus_amount !== null ? ` · ${kpi.fmtMoney(k.bonus_amount)}` : ''}${warn}`);
  }
  const text =
    `💰 <b>KPI — ${time.monthName(month)}</b>\n${ui.LINE}\n` +
    `Hodimlar: ${rows.length} · ✅ tasdiqlangan ${confirmed} · ⛔ chiqarilgan ${excluded} · ⏳ kutmoqda ${rows.length - confirmed - excluded}\n` +
    `Tasdiqlangan KPI jami: <b>${kpi.fmtMoney(totalBonus)}</b>\n<i>${config.kpiMode === 'gate' ? '🟢 KPI sharti bajarilgan · 🔴 bajarilmagan (KPI 0) · ' : ''}⚠️ — boshliq bahosi yoki mezon kiritilmagan</i>\n` +
    lines.join('\n');
  const btns = rows.map((k) => [cb(`${k.status === 'confirmed' ? '✅' : k.status === 'excluded' ? '⛔' : '⏳'} ${k.full_name} · ${k.total}`.slice(0, 60), `kpi:e:${k.employee_id}:${month}`)]);
  if (ctx.state.isAdmin) {
    btns.push([cb('📥 Excel', `kpi:xl:${month}`), cb('✅ Hammasini tasdiqlash', `kpi:okall:${month}`)]);
    btns.push([cb('🔄 Qayta hisoblash', `kpi:recalc:${month}`), cb('⬅️ Oylar', 'kpi:home')]);
  } else btns.push([cb('📥 Excel', `kpi:xl:${month}`), cb('⬅️ Oylar', 'kpi:home')]);
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
    (config.kpiMode === 'gate'
      ? `🚦 KPI sharti: ${Number(k.kpi_eligible) === 1 ? '🟢 <b>bajarildi</b>' : `🔴 <b>bajarilmadi</b> — ${esc(k.kpi_fail || '')}`}\n` +
        `   🗓 vaqtida kelgan: ${Number(k.ontime_days) + (Number(k.extra_days) || 0)}${k.required_days !== null && k.required_days !== undefined ? `/${k.required_days}` : ''} kun` +
        `${Number(k.extra_days) ? ` (shundan dam olish kuni ${k.extra_days})` : ''} · 📋 topshiriq ${k.tasks_gate_pct === null || k.tasks_gate_pct === undefined ? k.tasks_pct : k.tasks_gate_pct}%\n`
      : '') +
    `💵 KPI summasi: ${kpi.fmtMoney(k.bonus_fund)} → Beriladi: <b>${kpi.fmtMoney(k.bonus_amount)}</b>\n` +
    `💼 Oklad: ${kpi.fmtMoney(k.salary)} · 💰 Jami: <b>${kpi.fmtMoney((Number(k.salary) || 0) + (k.status === 'excluded' ? 0 : Number(k.bonus_amount) || 0))}</b>\n` +
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
  if (!ctx.state.isAdmin) {
    return render(ctx, `${kpiCardText(k, dept)}\n\n<i>👁 Faqat ko'rish — tahrirlash va tasdiqlash direktorda.</i>`, inline([
      [cb('📊 Batafsil hisobot', `rp:emp:${emp.id}:${month}`), cb("⬅️ Ro'yxat", `kpi:m:${month}`)],
    ]));
  }
  // tasdiqlangan/chiqarilgan oy muzlatilgan — tahrir tugmalari faqat «kutmoqda» da
  const rows = k.status === 'draft' ? [
    [cb('⭐ Boshliq bahosi', `kpi:score:${p}`), cb('🎯 Mezon %', `kpi:custom:${p}`)],
    [cb('🏆 KPI summasi', `kpi:fund:${p}`), cb('💬 Izoh', `kpi:note:${p}`)],
    [cb('✅ Tasdiqlash', `kpi:ok:${p}`), cb('⛔ Bonusdan chiqarish', `kpi:ex:${p}`)],
  ] : [[cb('↩️ Qaytadan ochish', `kpi:reopen:${p}`)]];
  rows.push([cb('📊 Batafsil hisobot', `rp:emp:${emp.id}:${month}`), cb("⬅️ Ro'yxat", `kpi:m:${month}`)]);
  return render(ctx, kpiCardText(k, dept), inline(rows));
};

const notifyDecision = (ctx, k) => flows.kpiDecisionNotice(botOf(ctx), k);

const LOCKED = "🔒 Bu oyning KPI si allaqachon tasdiqlangan (yoki chiqarilgan) — o'zgartirib bo'lmaydi. Direktor avval «↩️ Qaytadan ochish» ni bosadi.";

const lockedReply = (ctx) => ctx.reply(LOCKED, ui.kbFor(ctx));

const handleKpiText = async (ctx, field, { skip = false } = {}) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  if (!s.empId || !s.month) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  if (field !== 'note' && (await kpi.isLocked(s.empId, s.month))) return ctx.reply(LOCKED, ui.kbFor(ctx));
  const text = ctx.message.text.trim();
  if (field === 'custom') {
    const n = Number(text.replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) { session.set(ctx.from.id, { step: 'kpi_custom', empId: s.empId, month: s.month }); return ctx.reply('0–100 oralig\'ida son yozing:', ui.cancelKeyboard()); }
    if (!(await kpi.setCustomPct(s.empId, s.month, n))) return lockedReply(ctx, s.empId, s.month);
  }
  if (field === 'fund') {
    const n = /^\s*\d[\d\s.,]*$/.test(text) ? Number(text.replace(/[^\d]/g, '')) : NaN;
    if (!Number.isFinite(n)) { session.set(ctx.from.id, { step: 'kpi_fund', empId: s.empId, month: s.month }); return ctx.reply('Faqat raqam (so\'mda):', ui.cancelKeyboard()); }
    if (!(await kpi.setBonusFund(s.empId, s.month, n > 0 ? n : null))) return lockedReply(ctx, s.empId, s.month);
  }
  if (field === 'note') await kpi.setNote(s.empId, s.month, skip ? null : text);
  if (field === 'exclude_note') {
    const k = await kpi.decide(s.empId, s.month, 'excluded', ctx.from.id);
    if (k.blocked) return ctx.reply(`⚠️ ${esc(k.blocked)}`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
    await kpi.setNote(s.empId, s.month, skip ? null : text);
    await notifyDecision(ctx, await kpi.get(s.empId, s.month));
  }
  if (field === 'head_note') {
    const k = await kpi.get(s.empId, s.month);
    if (!(await kpi.setHeadScore(s.empId, s.month, k.head_score, skip ? null : text))) return lockedReply(ctx, s.empId, s.month);
    await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
    return s.from === 'hs' ? hsList(ctx, s.month) : kpiCard(ctx, s.empId, s.month);
  }
  await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
  return kpiCard(ctx, s.empId, s.month);
};

// ---------------------------------------------------------------------------
// BOSHLIQ BAHOLASHI (hs:)
// ---------------------------------------------------------------------------


/** Direktor va HR — hamma; bo'lim rahbari — faqat o'z bo'limi; bo'limsiz rahbar — hech kim (null = «hammasi» emas) */
const hsScope = (ctx) => require('../services/access').deptScope(ctx.state.actor);
/** Baholash huquqi: rahbar/HR/direktor, o'zini emas, rahbar — faqat o'z bo'limini */
const canScore = (ctx, e) => {
  if (!e || !ctx.state.isManager) return false;
  const me = ctx.state.employee;
  if (me && Number(me.id) === Number(e.id)) return false;
  if (ctx.state.isAdmin || ctx.state.isHr) return true;
  return Boolean(me && me.department_id && Number(me.department_id) === Number(e.department_id));
};

const hsHome = (ctx) => {
  if (!ctx.state.isManager) return ctx.reply("⛔️ Faqat bo'lim boshlig'i va direktor uchun.");
  if (!ctx.state.isAdmin && !ctx.state.employee.department_id) return ctx.reply("Sizga bo'lim biriktirilmagan — direktorga ayting.");
  return render(ctx, `⭐ <b>BAHOLASH</b>\n\nHar hodimga oy uchun 1–10 baho qo'yasiz — bu KPI ning «boshliq bahosi» qismi.\nQaysi oy?`, inline([[monthButtons('hs')[1]], [monthButtons('hs')[2]], [monthButtons('hs')[0]]]));
};

const hsList = async (ctx, month) => {
  const deptId = hsScope(ctx);
  const me = ctx.state.employee ? Number(ctx.state.employee.id) : -1;
  const list = (await employees.listStaff(deptId)).filter((e) => Number(e.id) !== me);
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
  if (!canScore(ctx, e)) return ctx.answerCbQuery('⛔️');
  if (await kpi.isLocked(e.id, month)) return ctx.answerCbQuery(LOCKED.slice(0, 190), { show_alert: true });
  await ctx.answerCbQuery();
  const k = await kpi.compute(e, month);
  return render(ctx, `⭐ <b>${esc(e.full_name)}</b> — ${time.monthName(month)}\n📋 topshiriq ${k.tasks_pct}% · 🕘 davomat ${k.att_pct}%\nHozirgi baho: ${k.head_score === null ? '—' : `${k.head_score}/10`}\n\nBahoni tanlang (1 — juda yomon, 10 — a'lo):`, ui.scoreKeyboard(`hs:s:${e.id}:${month}`));
};

const hsSet = async (ctx, empId, month, score, from = 'hs') => {
  const e = await employees.byId(empId);
  if (!canScore(ctx, e) || !(score >= 1 && score <= 10)) return ctx.answerCbQuery('⛔️');
  if (!(await kpi.setHeadScore(e.id, month, score))) return ctx.answerCbQuery(LOCKED.slice(0, 190), { show_alert: true });
  await ctx.answerCbQuery(`⭐ ${score}/10`);
  session.set(ctx.from.id, { step: 'head_note', empId: e.id, month, from });
  return ctx.reply(`⭐ ${esc(e.full_name)}: <b>${score}/10</b>. Qisqa izoh (ixtiyoriy) yoki «${ui.BTN.skip}»:`, { parse_mode: 'HTML', ...ui.skipKeyboard() });
};

const register = (bot) => {
  bot.hears(ui.BTN.kpi, async (ctx) => { if (await guardSee(ctx)) await kpiHome(ctx); });
  bot.command('kpi', async (ctx) => { if (await guardSee(ctx)) await kpiHome(ctx); });
  bot.action('kpi:home', async (ctx) => { if (await guardSee(ctx)) { await ctx.answerCbQuery(); await kpiHome(ctx); } });
  bot.action(/^kpi:m:(\d{4}-\d{2})$/, async (ctx) => { if (await guardSee(ctx)) { await ctx.answerCbQuery(); await kpiMonth(ctx, ctx.match[1]); } });
  bot.action(/^kpi:recalc:(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await kpi.computeAll(ctx.match[1], { force: false });
    await ctx.answerCbQuery('Qayta hisoblandi (kutilayotganlar)');
    await kpiMonth(ctx, ctx.match[1]);
  });
  bot.action(/^kpi:e:(\d+):(\d{4}-\d{2})$/, async (ctx) => { if (await guardSee(ctx)) { await ctx.answerCbQuery(); await kpiCard(ctx, ctx.match[1], ctx.match[2]); } });
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
    if (k.blocked) { await ctx.answerCbQuery(k.blocked, { show_alert: true }); return kpiCard(ctx, ctx.match[1], ctx.match[2]); }
    await ctx.answerCbQuery('Tasdiqlandi ✅');
    await notifyDecision(ctx, k);
    return kpiCard(ctx, ctx.match[1], ctx.match[2]);
  });
  bot.action(/^kpi:ex:(\d+):(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const why = await kpi.decideBlock(ctx.match[1], ctx.match[2]);
    if (why) return ctx.answerCbQuery(why, { show_alert: true });
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
    const month = ctx.match[1];
    if (month >= time.month()) return ctx.answerCbQuery(`${time.monthName(month)} hali tugamagan — oy yakunida tasdiqlanadi`, { show_alert: true });
    await ctx.answerCbQuery();
    await kpi.computeAll(month);
    let n = 0;
    const skipped = [];
    for (const k of await kpi.listMonth(month)) {
      if (k.status !== 'draft') continue;
      const d = await kpi.decide(k.employee_id, month, 'confirmed', ctx.from.id);
      if (d.blocked) { skipped.push(`${esc(k.full_name)} — ${esc(d.blocked)}`); continue; }
      await notifyDecision(ctx, d);
      n += 1;
    }
    await ctx.reply(`✅ ${n} ta hodim tasdiqlandi.${skipped.length ? `\n\n⏸ Tasdiqlanmadi:\n${skipped.join('\n')}` : ''}`, { parse_mode: 'HTML' });
    return kpiMonth(ctx, ctx.match[1]);
  });
  bot.action(/^kpi:xl:(\d{4}-\d{2})$/, async (ctx) => {
    if (!(await guardSee(ctx))) return;
    await ctx.answerCbQuery('Tayyorlanmoqda…');
    const { buffer, filename } = await excel.buildMonthly(ctx.match[1], { viewer: ctx.state.actor });
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
