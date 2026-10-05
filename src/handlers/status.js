'use strict';

/**
 * «⏳ Faol» · «🔁 Ko'rib chiqish» · «🕓 Kutilmoqda» · «✅ Bajarilgan» — topshiriqlar holati bo'yicha alohida tugmalar (asosiy menyuda).
 * Ko'rib chiqish — kamchilik bilan qaytarilgan, tuzatilayotgan vazifalar (5-okt).
 * Hodim — o'zinikini; rahbar — o'zi + bo'limi; boshliq/direktor — hammaniki; HR — hammaniki (boshliq/direktor berganlarisiz).
 * Har qatorda: kim, nima, kim bergan, qachon yozilgan, muddat, boshlanish soati.
 *   sk:<a|f|r|d>:<t|m|e<id>>:<sahifa>   a — faol, f — ko'rib chiqish (qaytarilgan), r — tekshiruvda, d — bajarilgan (shu oy);
 *     t — hodimlar ro'yxati (ism + soni), e<id> — shu hodimning vazifalari, m — faqat meniki
 *   sk:c:<k>:<empId>:<taskId>   vazifa kartochkasi (orqaga — o'sha hodimga)
 */

const ui = require('../ui');
const time = require('../time');
const access = require('../services/access');
const { render } = require('../render');
const { notRegistered } = require('./common');

const { esc, cb, inline } = ui;
const PAGE = 15;
const KINDS = { a: 'active', f: 'fix', r: 'review', d: 'accepted' };
const TITLES = {
  a: '⏳ FAOL TOPSHIRIQLAR (jarayonda)',
  f: "🔁 KO'RIB CHIQISH (qaytarilgan — tuzatilmoqda)",
  r: '🕓 KUTILMOQDA (bajardi — tekshiruvda)',
  d: `✅ BAJARILGAN (shu oy)`,
};
const GIVER = { admin: '👑', hr: '🧑‍💼', head: '👔', self: '✍️' };

/** Yuqoridagi hisob qatori va holat tugmalari (ikki qator) */
const summary = (lists) => {
  const overdue = [...lists.a, ...lists.f].filter((t) => t.due_date < time.today()).length;
  return `⏳ Faol: <b>${lists.a.length}</b>${overdue ? ` (🔴 ${overdue} kechikkan)` : ''} · 🔁 Ko'rib chiqish: <b>${lists.f.length}</b> · 🕓 Kutilmoqda: <b>${lists.r.length}</b> · ✅ Bajarilgan: <b>${lists.d.length}</b>`;
};
const kindRows = (k, lists, scope) => {
  const b = (kk, label) => cb(`${k === kk ? '• ' : ''}${label} (${lists[kk].length})`, `sk:${kk}:${scope}:0`);
  return [[b('a', '⏳ Faol'), b('f', "🔁 Ko'rib chiqish")], [b('r', '🕓 Kutilmoqda'), b('d', '✅ Bajarilgan')]];
};

const stamp = (iso) => (iso ? `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)} ${time.clock(iso)}` : '—');

const line = (t, i, withName) => {
  const overdue = t.status === 'active' && t.due_date < time.today();
  const icon = overdue ? '🔴' : t.status === 'active' && Number(t.returned_count) ? '🔁' : t.status === 'done' ? '🕓' : t.status === 'accepted' ? '✅' : t.priority === 'high' ? '🔥' : '🔹';
  const giver = t.giver_kind === 'self' ? "✍️ o'zi yozgan" : `${GIVER[t.giver_kind] || ''} ${esc(t.giver_name || (t.giver_kind === 'admin' ? 'Direktor' : '—'))}`;
  const bits = [`🗓 yozilgan ${stamp(t.created_at)}`, giver, `⏱ ${time.prettyDate(t.due_date)}${overdue ? ' — kechikdi' : ''}`];
  if (t.status === 'active' && t.start_time) bits.push(`⏰ ${t.start_time}`);
  if (t.status !== 'active' && t.done_at) bits.push(`✔️ ${stamp(t.done_at)}`);
  if (Number(t.returned_count)) bits.push(`↩️ ${t.returned_count}`);
  if (t.giver_kind !== 'self' && t.status === 'active') bits.push(t.ack_at ? '👂 tushundi' : "👂 —");
  return `${i}. ${icon} ${withName ? `<b>${esc(t.full_name)}</b>: ` : ''}${t.task_media_type ? `${ui.MEDIA_ICON[t.task_media_type] || '📎'} ` : ''}${esc(t.title)}\n   <i>${bits.join(' · ')}</i>`;
};

const show = async (ctx, k = 'a', scope = 't', page = 0) => {
  const actor = ctx.state.actor;
  if (!actor || !actor.registered) return notRegistered(ctx);
  if (!actor.employee && !actor.isAdmin) return notRegistered(ctx);
  const canTeam = actor.isManager;
  const mine = !canTeam || scope === 'm';
  const empId = !mine && /^e\d+$/.test(scope) ? Number(scope.slice(1)) : null;
  const lists = {};
  for (const key of Object.keys(KINDS)) {
    const all = await access.tasksByKind(actor, KINDS[key], { mine });
    lists[key] = empId ? all.filter((t) => Number(t.employee_id) === empId) : all;
  }
  if (!mine && !empId) return teamView(ctx, actor, k, lists, page);
  const list = lists[k];
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(p * PAGE, p * PAGE + PAGE);
  const withName = false;
  const empName = empId ? ((await require('../services/employees').byId(empId)) || {}).full_name || 'Hodim' : null;
  const who = mine ? '👤 Meniki' : `👤 ${esc(empName)}`;
  const text =
    `<b>${TITLES[k]}</b> — ${list.length} ta\n<i>${who}</i>\n` +
    `${summary(lists)}\n${ui.LINE}\n` +
    (slice.map((t, i) => line(t, p * PAGE + i + 1, withName)).join('\n') || "<i>— bo'sh —</i>");

  const key = (kk, ss, pp) => `sk:${kk}:${ss}:${pp}`;
  const rows = kindRows(k, lists, scope);
  if (empId) {
    // har vazifa — alohida tugma: boshliq/HR — kartochka; rahbar — tekshiruvdagisi tekshiruvga
    for (const [i, t] of slice.entries()) {
      const data = actor.seeAll ? `sk:c:${k}:${empId}:${t.id}` : t.status === 'done' ? `rv:view:${t.id}` : null;
      if (data) rows.push([cb(`${p * PAGE + i + 1}. ${t.title}`.slice(0, 60), data)]);
    }
  }
  const nav = [];
  if (p > 0) nav.push(cb('◀️', key(k, scope, p - 1)));
  if (pages > 1) nav.push(cb(`${p + 1}/${pages}`, key(k, scope, p)));
  if (p < pages - 1) nav.push(cb('▶️', key(k, scope, p + 1)));
  if (nav.length) rows.push(nav);
  if (empId) rows.push([cb('⬅️ Hodimlar', key(k, 't', 0)), cb('🔄 Yangilash', key(k, scope, p))]);
  else if (canTeam && actor.employee) rows.push([cb(actor.seeAll ? '👥 Hodimlar' : "👥 Bo'limim", key(k, 't', 0)), cb('🔄 Yangilash', key(k, scope, p))]);
  else rows.push([cb('🔄 Yangilash', key(k, scope, p))]);
  if ((k === 'a' || k === 'f') && mine && lists[k].length) rows.push([cb('✔️ Bajardim', 'done:list')]);
  if (k === 'r' && !mine && actor.isManager && lists.r.length) rows.push([cb('🔎 Tekshiruvga o\'tish', 'rv:list')]);
  return render(ctx, text, inline(rows));
};

/** Hodimlar ro'yxati: ism + shu holatdagi vazifalar soni; ismni bossa — uning vazifalari */
const teamView = async (ctx, actor, k, lists, page) => {
  const byEmp = new Map();
  for (const key of Object.keys(KINDS)) {
    for (const t of lists[key]) {
      const id = Number(t.employee_id);
      if (!byEmp.has(id)) byEmp.set(id, { id, name: t.full_name, a: 0, f: 0, r: 0, d: 0, late: 0 });
      const x = byEmp.get(id);
      x[key] += 1;
      if ((key === 'a' || key === 'f') && t.due_date < time.today()) x.late += 1;
    }
  }
  const people = [...byEmp.values()].filter((x) => x[k] > 0).sort((a, b) => b[k] - a[k] || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(people.length / 20));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = people.slice(p * 20, p * 20 + 20);
  const who = actor.seeAll ? '👥 Hamma hodimlar' : "👥 Men va bo'limim";
  const text =
    `<b>${TITLES[k]}</b> — ${lists[k].length} ta\n<i>${who} · hodimni bosing — vazifalari ochiladi</i>\n` +
    `${summary(lists)}\n${ui.LINE}\n` +
    (slice.map((x, i) => `${p * 20 + i + 1}. 👤 <b>${esc(x.name)}</b> — ${x[k]} ta${(k === 'a' || k === 'f') && x.late ? ` (🔴 ${x.late} kechikkan)` : ''}`).join('\n') || "<i>— bo'sh —</i>");
  const key = (kk, ss, pp) => `sk:${kk}:${ss}:${pp}`;
  const rows = kindRows(k, lists, 't');
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((x) => cb(`👤 ${x.name} (${x[k]}${(k === 'a' || k === 'f') && x.late ? ` · 🔴${x.late}` : ''})`.slice(0, 40), key(k, `e${x.id}`, 0))));
  }
  const nav = [];
  if (p > 0) nav.push(cb('◀️', key(k, 't', p - 1)));
  if (pages > 1) nav.push(cb(`${p + 1}/${pages}`, key(k, 't', p)));
  if (p < pages - 1) nav.push(cb('▶️', key(k, 't', p + 1)));
  if (nav.length) rows.push(nav);
  rows.push([...(actor.employee ? [cb('👤 Faqat meniki', key(k, 'm', 0))] : []), cb('🔄 Yangilash', key(k, 't', p))]);
  if (k === 'r' && lists.r.length) rows.push([cb('🔎 Tekshiruvga o\'tish', 'rv:list')]);
  return render(ctx, text, inline(rows));
};

const register = (bot) => {
  bot.hears(ui.BTN.stActive, (ctx) => show(ctx, 'a'));
  bot.hears(ui.BTN.stFix, (ctx) => show(ctx, 'f'));
  bot.hears(ui.BTN.stReview, (ctx) => show(ctx, 'r'));
  bot.hears(ui.BTN.stDone, (ctx) => show(ctx, 'd'));
  bot.command('faol', (ctx) => show(ctx, 'a'));
  bot.command('korib_chiqish', (ctx) => show(ctx, 'f'));
  bot.command('kutilmoqda', (ctx) => show(ctx, 'r'));
  bot.command('bajarilgan', (ctx) => show(ctx, 'd'));
  bot.action(/^sk:(a|f|r|d):(t|m|e\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    return show(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]));
  });
  bot.action(/^sk:c:(a|f|r|d):(\d+):(\d+)$/, async (ctx) => {
    if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    return require('./journal').showCard(ctx, ctx.match[3], `sk:${ctx.match[1]}:e${ctx.match[2]}:0`);
  });
};

module.exports = { register, show, line };
