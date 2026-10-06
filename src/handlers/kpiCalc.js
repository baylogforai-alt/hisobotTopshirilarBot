'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const kpi = require('../services/kpi');

const { esc, cb, inline } = ui;

/**
 * 🧮 KPI KALKULYATOR — «agar … bo'lsa, qancha bo'ladi?». Bazaga hech narsa yozmaydi.
 *   Holat butunlay callback ichida: kc:v:<d>.<t>.<a>.<h>.<c>.<f>.<s>.<g>
 *     d — bo'lim (vaznlar; 0 = standart), t — topshiriq %, a — davomat %, h — boshliq bahosi 1–10 (n — kiritilmagan),
 *     c — mezon % (n — kiritilmagan), f — KPI summasi, s — oklad (so'm), g — KPI sharti bajarildimi (gate rejimi)
 *   Shu sabab menyu tugmasi sessiyani tozalasa ham karta ishlayveradi; sessiya faqat qo'lda son yozishda (kc_input).
 *   kc:in:<maydon>:<holat> — son yozish · kc:dp:<holat> — vaznlarni bo'limdan olish
 * Kirish: /kalkulyator (o'z joriy oyi bilan), «💵 Oylik va KPI», KPI bo'limi va hodim KPI kartochkasi («🧮 Kalkulyatorda»).
 */

const MAX_MONEY = 9999999999;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));
const nullable = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const DEFAULT_STATE = { d: 0, t: 100, a: 100, h: null, c: null, f: 0, s: 0, g: 1 };

const encode = (st) =>
  [st.d, st.t, st.a, st.h === null ? 'n' : st.h, st.c === null ? 'n' : st.c, st.f, st.s, st.g ? 1 : 0].join('.');

const decode = (str) => {
  const p = String(str || '').split('.');
  if (p.length !== 8) return null;
  const n = (v) => (v === 'n' ? null : Number(v));
  return normalize({ d: n(p[0]), t: n(p[1]), a: n(p[2]), h: n(p[3]), c: n(p[4]), f: n(p[5]), s: n(p[6]), g: n(p[7]) });
};

const normalize = (st) => ({
  d: Number.isInteger(Number(st.d)) && Number(st.d) > 0 ? Number(st.d) : 0,
  t: clamp(st.t, 0, 100),
  a: clamp(st.a, 0, 100),
  h: nullable(st.h) === null ? null : clamp(st.h, 1, 10),
  c: nullable(st.c) === null ? null : clamp(st.c, 0, 100),
  f: clamp(st.f, 0, MAX_MONEY),
  s: clamp(st.s, 0, MAX_MONEY),
  g: Number(st.g) === 0 ? 0 : 1,
});

/** KPI qatoridan (kpi_monthly) kalkulyator holati */
const stateFromKpi = (k, deptId) => normalize({
  d: deptId || 0,
  t: k.tasks_pct, a: k.att_pct, h: nullable(k.head_score), c: nullable(k.custom_pct),
  f: nullable(k.bonus_fund) || 0, s: nullable(k.salary) || 0,
  g: config.kpiMode === 'gate' ? Number(k.kpi_eligible) : 1,
});

/** Hisob: { total, bonus, pay, parts[] } — kpi.computeTotal bilan aynan bir xil formula */
const calc = (st, w) => {
  const row = { tasks_pct: st.t, att_pct: st.a, head_score: st.h, custom_pct: st.c, ...w };
  const total = kpi.computeTotal(row);
  const bonus = config.kpiMode === 'gate' ? (st.g ? st.f : 0) : kpi.bonusOf(st.f, total) || 0;
  const parts = [
    { key: 't', pct: st.t, w: Number(w.w_tasks) },
    { key: 'a', pct: st.a, w: Number(w.w_attendance) },
    { key: 'h', pct: st.h === null ? null : st.h * 10, w: Number(w.w_head) },
    { key: 'c', pct: st.c, w: Number(w.w_custom) },
  ];
  const wsum = parts.filter((p) => p.w > 0 && p.pct !== null).reduce((s, p) => s + p.w, 0);
  for (const p of parts) p.eff = p.w > 0 && p.pct !== null && wsum ? (p.w * 100) / wsum : 0; // qayta 100 ga keltirilgan vazn
  return { total, bonus, pay: st.s + bonus, parts };
};

const money = (n) => kpi.fmtMoney(n);
const ballOf = (p) => Math.round((p.pct * p.eff) / 100);
const fmtW = (eff) => `${Math.round(eff * 10) / 10}`.replace('.', ',');

const cardText = (st, w, dept) => {
  const r = calc(st, w);
  const customName = (dept && dept.custom_name) || "Qo'shimcha mezon";
  const P = Object.fromEntries(r.parts.map((p) => [p.key, p]));
  const line = (icon, label, value, p) => {
    if (!(p.w > 0)) return `${icon} ${label}: <i>bu bo'limda hisobga olinmaydi</i>`;
    if (p.pct === null) return `${icon} ${label}: <i>kiritilmagan — hisobdan chiqariladi</i>`;
    return `${icon} ${label}: <b>${value}</b> × ${fmtW(p.eff)}% = <b>${ballOf(p)}</b> ball`;
  };
  const lines = [
    `🧮 <b>KPI KALKULYATOR</b>`,
    `<i>Vaznlar: ${dept ? esc(dept.name) : 'standart'} — ${esc(departments.weightsText(dept))}</i>`,
    ui.LINE,
    line('📋', 'Topshiriq', `${st.t}%`, P.t),
    line('🕘', 'Davomat', `${st.a}%`, P.a),
    line('⭐', 'Boshliq bahosi', st.h === null ? '—' : `${st.h}/10`, P.h),
    line('🎯', esc(customName), st.c === null ? '—' : `${st.c}%`, P.c),
    ui.LINE,
    `🏆 <b>KPI: ${r.total} ball</b>  ${ui.pctBar(r.total)}`,
  ];
  if (config.kpiMode === 'gate') {
    lines.push(`🚦 KPI sharti: ${st.g ? '🟢 bajarildi → summa <b>to\'liq</b>' : '🔴 bajarilmadi → KPI <b>0</b>'}`);
  }
  lines.push(
    `💵 KPI summasi: ${money(st.f)} → Beriladi: <b>${money(r.bonus)}</b>`,
    `💼 Oklad: ${money(st.s)} · 💰 Jami: <b>${money(r.pay)}</b>`,
  );
  // har 1 foiz / 1 baho qancha so'm — score rejimida, summa bo'lsa
  if (config.kpiMode !== 'gate' && st.f > 0) {
    const per = (p, k = 1) => Math.round((st.f * p.eff * k) / 10000);
    const hints = [];
    if (P.t.eff) hints.push(`+1% topshiriq ≈ ${money(per(P.t))}`);
    if (P.a.eff) hints.push(`+1% davomat ≈ ${money(per(P.a))}`);
    if (P.h.eff) hints.push(`+1 baho ≈ ${money(per(P.h, 10))}`);
    if (P.c.eff) hints.push(`+1% mezon ≈ ${money(per(P.c))}`);
    if (hints.length) lines.push('', `💡 ${hints.join(' · ')}`);
    if (r.total < 100) lines.push(`🎯 100 ball bo'lsa: KPI ${money(st.f)} → jami ${money(st.s + st.f)}`);
  }
  lines.push('', `<i>Formula: ball = har mezon % × vazni; kiritilmagan mezon chiqarilib, qolgan vaznlar 100 ga keltiriladi.${config.kpiMode === 'gate' ? ' KPI sharti bajarilsa summa to\'liq, aks holda 0.' : ' Beriladi = KPI summasi × ball / 100.'} Bazaga hech narsa yozilmaydi.</i>`);
  return lines.join('\n');
};

const v = (st, patch) => `kc:v:${encode(normalize({ ...st, ...patch }))}`;

const stepRow = (icon, st, key, steps, label, lo, hi, startFromNull) => {
  const cur = st[key];
  const btn = (d) => {
    const base = cur === null ? startFromNull(d) : cur + d;
    return cb(`${d > 0 ? '+' : '−'}${Math.abs(d)}`, v(st, { [key]: Math.max(lo, Math.min(hi, base)) }));
  };
  return [...steps.filter((d) => d < 0).map(btn), cb(`${icon} ${label}`, `kc:in:${key}:${encode(st)}`), ...steps.filter((d) => d > 0).map(btn)];
};

const cardKeyboard = (st, w) => {
  const rows = [];
  if (Number(w.w_tasks) > 0) rows.push(stepRow('📋', st, 't', [-10, -1, 1, 10], `${st.t}%`, 0, 100));
  if (Number(w.w_attendance) > 0) rows.push(stepRow('🕘', st, 'a', [-10, -1, 1, 10], `${st.a}%`, 0, 100));
  if (Number(w.w_head) > 0) rows.push(stepRow('⭐', st, 'h', [-1, 1], st.h === null ? '—' : `${st.h}/10`, 1, 10, (d) => (d > 0 ? 10 : 9)));
  if (Number(w.w_custom) > 0) rows.push(stepRow('🎯', st, 'c', [-10, -1, 1, 10], st.c === null ? '—' : `${st.c}%`, 0, 100, (d) => (d > 0 ? 100 : 90)));
  rows.push([cb('💵 KPI summasi', `kc:in:f:${encode(st)}`), cb('💼 Oklad', `kc:in:s:${encode(st)}`)]);
  if (config.kpiMode === 'gate') rows.push([cb(st.g ? '🚦 Shart: 🟢 bajarildi' : '🚦 Shart: 🔴 bajarilmadi', v(st, { g: st.g ? 0 : 1 }))]);
  rows.push([cb("🏢 Vaznlar (bo'lim)", `kc:dp:${encode(st)}`), cb("💯 Hammasi a'lo", v(st, { t: 100, a: 100, h: st.h === null ? null : 10, c: st.c === null ? null : 100 }))]);
  return inline(rows);
};

const show = async (ctx, st) => {
  const dept = st.d ? await departments.byId(st.d) : null;
  const w = departments.weightsOf(dept);
  return render(ctx, cardText(st, w, dept), cardKeyboard(dept ? st : { ...st, d: 0 }, w));
};

/** /kalkulyator — hodim o'z joriy oyi bilan; rahbar/direktor (hodim emas) — standart qiymatlar bilan */
const open = async (ctx) => {
  if (!ctx.state.employee && !ctx.state.isAdmin) return null;
  const emp = ctx.state.employee;
  if (emp && !employees.isBoss(emp)) {
    const k = await kpi.compute(emp, time.month());
    return show(ctx, stateFromKpi(k, emp.department_id));
  }
  return show(ctx, normalize(DEFAULT_STATE));
};

const FIELDS = {
  t: { q: '📋 Topshiriq foizi (0–100):', parse: (x) => pct(x) },
  a: { q: '🕘 Davomat foizi (0–100):', parse: (x) => pct(x) },
  h: { q: "⭐ Boshliq bahosi (1–10). 0 yoki «-» — kiritilmagan:", parse: (x) => (isNone(x) ? { val: null } : int(x, 1, 10)) },
  c: { q: "🎯 Mezon foizi (0–100). «-» — kiritilmagan:", parse: (x) => (x.trim() === '-' ? { val: null } : pct(x)) },
  f: { q: "💵 KPI summasi (so'mda), masalan 2 000 000:", parse: (x) => moneyIn(x) },
  s: { q: "💼 Oklad (so'mda), masalan 5 000 000:", parse: (x) => moneyIn(x) },
};
const isNone = (x) => ['-', '0', '—'].includes(x.trim());
const int = (x, lo, hi) => {
  const n = Number(String(x).replace('%', '').replace(',', '.').trim());
  return Number.isFinite(n) && n >= lo && n <= hi ? { val: Math.round(n) } : null;
};
const pct = (x) => int(x, 0, 100);
const moneyIn = (x) => {
  if (!/^\s*\d[\d\s.,]*$/.test(x)) return null;
  const n = Number(x.replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n <= MAX_MONEY ? { val: n } : null;
};

const handleInput = async (ctx) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  const st = decode(s.kcState);
  const f = FIELDS[s.kcField];
  if (!st || !f) return ctx.reply('Sessiya eskirgan — /kalkulyator', ui.kbFor(ctx));
  const r = f.parse(ctx.message.text);
  if (!r) {
    session.set(ctx.from.id, { step: 'kc_input', kcField: s.kcField, kcState: s.kcState });
    return ctx.reply(`⚠️ Tushunmadim. ${f.q}`, ui.cancelKeyboard());
  }
  await ctx.reply('✅', ui.kbFor(ctx));
  return show(ctx, normalize({ ...st, [s.kcField]: r.val }));
};

const registered = (ctx) => Boolean(ctx.state.employee || ctx.state.isAdmin);

const register = (bot) => {
  bot.command('kalkulyator', open);
  bot.action('kc:open', async (ctx) => { if (!registered(ctx)) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); return open(ctx); });
  bot.action(/^kc:v:([\dn.]+)$/, async (ctx) => {
    if (!registered(ctx)) return ctx.answerCbQuery('⛔️');
    const st = decode(ctx.match[1]);
    await ctx.answerCbQuery();
    return show(ctx, st || normalize(DEFAULT_STATE));
  });
  bot.action(/^kc:in:([tahcfs]):([\dn.]+)$/, async (ctx) => {
    if (!registered(ctx)) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'kc_input', kcField: ctx.match[1], kcState: ctx.match[2] });
    return ctx.reply(FIELDS[ctx.match[1]].q, ui.cancelKeyboard());
  });
  bot.action(/^kc:dp:([\dn.]+)$/, async (ctx) => {
    if (!registered(ctx)) return ctx.answerCbQuery('⛔️');
    const st = decode(ctx.match[1]) || normalize(DEFAULT_STATE);
    await ctx.answerCbQuery();
    const rows = [[cb(`${st.d ? '' : '✅ '}Standart — ${departments.weightsText(null)}`.slice(0, 64), v(st, { d: 0 }))]];
    for (const d of await departments.listActive()) {
      rows.push([cb(`${Number(d.id) === st.d ? '✅ ' : ''}${d.name} — ${d.w_tasks}/${d.w_attendance}/${d.w_head}/${d.w_custom}`.slice(0, 64), v(st, { d: d.id }))]);
    }
    rows.push([cb('⬅️ Orqaga', `kc:v:${encode(st)}`)]);
    return render(ctx, "🏢 <b>Qaysi bo'lim vaznlari bilan hisoblaymiz?</b>\n<i>Topshiriq / davomat / boshliq bahosi / mezon, %</i>", inline(rows));
  });
};

module.exports = { register, handleInput, open, stateFromKpi, encode, decode, calc };
