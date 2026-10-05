'use strict';

/**
 * «📋 Barcha topshiriqlar» — topshiriqlar jurnali (boshliq/direktor va HR).
 * Nusxa xabari kelmasa ham (direktor, HR bergan, o'z missiyalari) — hammasi shu yerda ko'rinadi:
 * qachon, kimga, nima, kim bergan, muddat, holat, isbot.
 *
 * Callback: tj:<davr>:<beruvchi>:<holat>:<hodimId>:<sahifa>  ·  tj:t:<taskId> (kartochka)  ·  tj:p:<taskId> (isbot)  ·  tj:emps (hodim tanlash)
 *   davr: d bugun · w 7 kun · m shu oy · p o'tgan oy
 *   beruvchi: a hammasi · admin · hr · head · self      holat: a hammasi · open · review · accepted · overdue · cancelled
 */

const ui = require('../ui');
const time = require('../time');
const tasks = require('../services/tasks');
const employees = require('../services/employees');
const notify = require('../services/notify');
const { render, guardSee } = require('../render');

const { esc, cb, inline } = ui;
const PAGE = 10;

const PERIODS = { d: 'Bugun', w: '7 kun', m: 'Shu oy', p: "O'tgan oy" };
const GIVERS = { a: 'Hammasi', admin: 'Direktor', hr: 'HR', head: 'Rahbar', self: "O'zi yozgan" };
const STATUSES = { a: 'Hammasi', open: '⏳ Ochiq', review: '🕓 Tekshiruvda', accepted: '✅ Bajarildi', overdue: '🔴 Muddati o\'tgan', cancelled: '🚫 Bekor' };
const STATUS_ICON = { open: '⏳', review: '🕓', accepted: '✅', overdue: '🔴', cancelled: '🚫' };
const GIVER_ICON = { admin: '👑', hr: '🧑‍💼', head: '👔', self: '✍️' };

const periodRange = (p) => {
  const today = time.today();
  if (p === 'd') return { from: today, to: today };
  if (p === 'w') return { from: time.addDays(today, -6), to: today };
  if (p === 'p') return time.monthRange(time.prevMonth());
  return { from: time.monthRange(time.month()).from, to: today };
};

/** Oxirgi filtr (kartochkadan «Orqaga» uchun) — xotirada */
const lastFilter = new Map();
const DEFAULT = { p: 'w', g: 'a', s: 'a', e: 0, page: 0 };
const key = (f) => `tj:${f.p}:${f.g}:${f.s}:${f.e}:${f.page}`;

const giverLabel = (t) => {
  if (t.giver_kind === 'self') return "o'zi yozgan";
  const who = t.giver_name || (t.giver_kind === 'admin' ? 'Direktor' : '—');
  return `${who} (${GIVERS[t.giver_kind] || t.giver_kind})`;
};

/** 👂 tushundi / ⏳ hali tasdiqlamagan (boshqa odam bergan topshiriqlar) */
const ackMark = (t) => {
  if (t.giver_kind === 'self' || t.status === 'cancelled') return '';
  if (t.ack_at) return ' · 👂 tushundi';
  return t.status === 'accepted' ? '' : " · ⏳ «tushundim» yo'q";
};

const showJournal = async (ctx, f = DEFAULT) => {
  lastFilter.set(Number(ctx.from.id), f);
  const { from, to } = periodRange(f.p);
  const list = tasks.visibleFor(ctx.state.actor, await tasks.journal({ from, to, employeeId: f.e || null, giver: f.g === 'a' ? null : f.g, status: f.s === 'a' ? null : f.s }));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const page = Math.min(f.page, pages - 1);
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  const emp = f.e ? await employees.byId(f.e) : null;

  const cnt = { open: 0, review: 0, accepted: 0, overdue: 0, cancelled: 0 };
  for (const t of list) cnt[t.status_kind] += 1;
  const head =
    `📋 <b>BARCHA TOPSHIRIQLAR</b> · ${PERIODS[f.p]}${emp ? ` · 👤 ${esc(emp.full_name)}` : ''}\n` +
    `<i>${time.prettyDate(from)}${from !== to ? ` — ${time.prettyDate(to)}` : ''} · berilgan sana bo'yicha</i>\n` +
    `Jami <b>${list.length}</b>: ⏳ ${cnt.open} · 🕓 ${cnt.review} · ✅ ${cnt.accepted} · 🔴 ${cnt.overdue}${cnt.cancelled ? ` · 🚫 ${cnt.cancelled}` : ''}\n` +
    `Beruvchi: <b>${GIVERS[f.g]}</b> · Holat: <b>${STATUSES[f.s]}</b>\n${ui.LINE}`;
  const lines = slice.map((t, i) =>
    `${page * PAGE + i + 1}. ${STATUS_ICON[t.status_kind]} <b>${esc(t.full_name)}</b>: ${esc(t.title)}\n` +
    `   🗓 ${time.prettyDate(String(t.created_at).slice(0, 10))} ${time.clock(t.created_at)} · ${GIVER_ICON[t.giver_kind] || ''} ${esc(giverLabel(t))} · ⏱ ${time.prettyDate(t.due_date)}${t.proof_file_id ? ' · 📎' : ''}${ackMark(t)}`);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((t, j) => cb(`${page * PAGE + i + j + 1}. ${t.full_name}: ${t.title}`.slice(0, 40), `tj:t:${t.id}`)));
  }
  const nav = [];
  if (page > 0) nav.push(cb('◀️', key({ ...f, page: page - 1 })));
  if (pages > 1) nav.push(cb(`${page + 1}/${pages}`, key({ ...f, page })));
  if (page < pages - 1) nav.push(cb('▶️', key({ ...f, page: page + 1 })));
  if (nav.length) rows.push(nav);
  const pick = (obj, field, perRow) => {
    const btns = Object.keys(obj).map((k) => cb(`${f[field] === k ? '• ' : ''}${obj[k]}`, key({ ...f, [field]: k, page: 0 })));
    for (let i = 0; i < btns.length; i += perRow) rows.push(btns.slice(i, i + perRow));
  };
  pick(PERIODS, 'p', 4);
  pick(GIVERS, 'g', 5);
  pick(STATUSES, 's', 3);
  rows.push([cb(emp ? `👤 ${emp.full_name} ✖️` : '👤 Hodim bo\'yicha', emp ? key({ ...f, e: 0, page: 0 }) : 'tj:emps'), cb('🔄 Yangilash', key(f))]);
  return render(ctx, `${head}\n${lines.join('\n') || "<i>— bu filtr bo'yicha topshiriq yo'q —</i>"}`, inline(rows));
};

const showEmployees = async (ctx) => {
  const f = lastFilter.get(Number(ctx.from.id)) || DEFAULT;
  const list = await employees.listActive();
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((e) => cb(e.full_name.slice(0, 30), key({ ...f, e: Number(e.id), page: 0 }))));
  rows.push([cb('⬅️ Orqaga', key(f))]);
  return render(ctx, '👤 <b>Qaysi hodimning topshiriqlari?</b>', inline(rows));
};

const STATUS_TEXT = { open: '⏳ ochiq (jarayonda)', review: '🕓 bajardi — tekshiruvda', accepted: '✅ bajarildi (qabul qilingan)', overdue: "🔴 muddati o'tgan", cancelled: '🚫 bekor qilingan' };

/** back — «⬅️ Orqaga» qayerga (standart: jurnalning oxirgi filtri) */
const showCard = async (ctx, id, back = null) => {
  const f = lastFilter.get(Number(ctx.from.id)) || DEFAULT;
  const backData = back || key(f);
  const t = await tasks.journalItem(id);
  if (!t || !tasks.visibleTo(ctx.state.actor, t)) return render(ctx, "Topshiriq topilmadi.", inline([[cb('⬅️ Orqaga', backData)]]));
  const reviewer = t.reviewed_by ? await employees.byTgId(t.reviewed_by) : null;
  const canceller = t.cancelled_by ? await employees.byTgId(t.cancelled_by) : null;
  const lines = [
    `📋 <b>${esc(t.title)}</b>${t.priority === 'high' ? ' 🔥' : ''}`,
    ui.LINE,
    `👤 Kimga: <b>${esc(t.full_name)}</b>`,
    `${GIVER_ICON[t.giver_kind] || ''} Kim bergan: <b>${esc(giverLabel(t))}</b>`,
    `🗓 Berilgan: ${time.prettyDate(String(t.created_at).slice(0, 10))} ${time.clock(t.created_at)}`,
    `⏱ Muddat: ${time.prettyDate(t.due_date)}${t.start_time ? ` · ⏰ boshlanish ${t.start_time}${t.start_notified_at ? ' (xabar bordi)' : ''}` : ''}`,
    `📌 Holat: <b>${STATUS_TEXT[t.status_kind]}</b>`,
  ];
  if (t.task_media_type) lines.push(`${ui.MEDIA_ICON[t.task_media_type] || '📎'} Topshiriq: ${ui.MEDIA_LABEL[t.task_media_type] || t.task_media_type}${t.task_file_name ? ` · ${esc(t.task_file_name)}` : ''}`);
  if (t.giver_kind !== 'self') lines.push(t.ack_at ? `👂 Tushundi: ${time.prettyDate(String(t.ack_at).slice(0, 10))} ${time.clock(t.ack_at)}${t.ack_note ? ` · «${esc(t.ack_note)}»` : ''}` : "👂 Tushundi: <i>hali tasdiqlamagan</i>");
  if (t.done_at) lines.push(`✔️ Bajardi: ${time.prettyDate(String(t.done_at).slice(0, 10))} ${time.clock(t.done_at)}${String(t.done_at).slice(0, 10) > t.due_date ? ' <i>(kech)</i>' : ''}`);
  if (t.proof_type) lines.push(`📎 Isbot: ${t.proof_type}${t.proof_note ? ` · «${esc(t.proof_note)}»` : ''}`);
  else if (t.done_at) lines.push('📎 Isbot: yo\'q');
  if (t.reviewed_at && t.status === 'accepted') lines.push(`✅ Qabul qildi: ${esc(reviewer ? reviewer.full_name : String(t.reviewed_by))} · ${time.clock(t.reviewed_at)}`);
  if (Number(t.returned_count)) lines.push(`↩️ Qaytarilgan: ${t.returned_count} marta${t.review_note ? ` · «${esc(t.review_note)}»` : ''}`);
  const reps = await tasks.replies(t.id);
  if (reps.length) {
    const last = reps[reps.length - 1];
    lines.push(`💬 Yozishma: ${reps.length} ta · oxirgisi — ${esc(last.from_name || '')}: ${last.body ? `«${esc(last.body.slice(0, 120))}»` : ui.MEDIA_ICON[last.media_type] || 'media'}`);
  }
  if (t.status === 'cancelled') lines.push(`🚫 Bekor qildi: ${esc(canceller ? canceller.full_name : String(t.cancelled_by || '—'))}${t.cancelled_at ? ` · ${time.prettyDate(String(t.cancelled_at).slice(0, 10))}` : ''}`);
  const rows = [];
  if (t.task_file_id) rows.push([cb(`${ui.MEDIA_ICON[t.task_media_type] || '📎'} Topshiriqni ko'rish / eshitish`, `tj:m:${t.id}`)]);
  if (t.proof_file_id) rows.push([cb('📎 Isbotni ko\'rish', `tj:p:${t.id}`)]);
  if (require('../services/access').canCancelTask(ctx.state.actor, t)) rows.push([cb("🗑 O'chirish (bekor qilish)", `tk:del:${t.id}`)]);
  rows.push([cb('⬅️ Orqaga', backData)]);
  return render(ctx, lines.join('\n'), inline(rows));
};

const register = (bot) => {
  const open = async (ctx) => { if (await guardSee(ctx)) await showJournal(ctx, DEFAULT); };
  bot.hears(ui.BTN.journal, open);
  bot.command('jurnal', open);

  bot.action(/^tj:(d|w|m|p):(a|admin|hr|head|self):(a|open|review|accepted|overdue|cancelled):(\d+):(\d+)$/, async (ctx) => {
    if (!(await guardSee(ctx))) return;
    await ctx.answerCbQuery();
    const [, p, g, s, e, page] = ctx.match;
    await showJournal(ctx, { p, g, s, e: Number(e), page: Number(page) });
  });
  bot.action('tj:emps', async (ctx) => { if (await guardSee(ctx)) { await ctx.answerCbQuery(); await showEmployees(ctx); } });
  bot.action(/^tj:t:(\d+)$/, async (ctx) => { if (await guardSee(ctx)) { await ctx.answerCbQuery(); await showCard(ctx, ctx.match[1]); } });
  bot.action(/^tj:m:(\d+)$/, async (ctx) => {
    if (!(await guardSee(ctx))) return;
    const t = await tasks.byId(ctx.match[1]);
    if (!t || !t.task_file_id || !tasks.visibleTo(ctx.state.actor, t)) return ctx.answerCbQuery("Topshiriq media'si yo'q");
    await ctx.answerCbQuery();
    await notify.sendProof({ telegram: ctx.telegram }, ctx.from.id, { type: t.task_media_type, fileId: t.task_file_id }, `📋 <b>${esc(t.full_name)}</b> ga topshiriq: ${esc(t.title)}`);
  });
  bot.action(/^tj:p:(\d+)$/, async (ctx) => {
    if (!(await guardSee(ctx))) return;
    const t = await tasks.byId(ctx.match[1]);
    if (!t || !t.proof_file_id || !tasks.visibleTo(ctx.state.actor, t)) return ctx.answerCbQuery("Isbot yo'q");
    await ctx.answerCbQuery();
    await notify.sendProof({ telegram: ctx.telegram }, ctx.from.id, { type: t.proof_type, fileId: t.proof_file_id },
      `📎 <b>${esc(t.full_name)}</b>: ${esc(t.title)}${t.proof_note ? `\n💬 «${esc(t.proof_note)}»` : ''}`);
  });
};

module.exports = { register, showJournal, showCard };
