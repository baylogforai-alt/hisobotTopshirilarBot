'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const warnings = require('../services/warnings');
const access = require('../services/access');
const flows = require('../services/flows');
const field = require('./field');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * «⚠️ Ogohlantirish» (intizom) — 20-okt, HR so'rovi.
 * Oqim: hodimni tanlash (wn:e) → matn yoki media (bosqich warn_text) → tasdiq (wn:send).
 * Huquq: access.canWarn — direktor/boshliq va HR hammaga, bo'lim rahbari o'z bo'limiga.
 */

const WARN_MEDIA = ['photo', 'video', 'video_note', 'voice', 'audio', 'document'];

/** Kimni ogohlantirish mumkin */
const targetsFor = async (actor) => (await employees.listStaff()).filter((e) => access.canWarn(actor, e));

const home = async (ctx) => {
  const actor = ctx.state.actor;
  const list = await targetsFor(actor);
  if (!list.length) return ctx.reply("⛔️ Siz hech kimga ogohlantirish yubora olmaysiz.", ui.kbFor(ctx));
  const rows = list.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}`.slice(0, 60), `wn:e:${e.id}`)]);
  rows.push([cb('📜 Yuborilganlar', 'wn:l')]);
  return render(
    ctx,
    `⚠️ <b>OGOHLANTIRISH</b> (intizom)\n${ui.LINE}\n` +
      "Hodimni tanlang — unga rasmiy ogohlantirish yuboriladi, u «👀 Tanishdim» bosadi va yozuv bazada qoladi.",
    inline(rows),
  );
};

const pick = async (ctx, empId) => {
  const e = await employees.byId(empId);
  if (!e || !access.canWarn(ctx.state.actor, e)) return ctx.answerCbQuery("⛔️ Ruxsat yo'q");
  await ctx.answerCbQuery();
  const n = await warnings.countFor(e.id);
  session.set(ctx.from.id, { step: 'warn_text', warn: { empId: e.id } });
  return ctx.reply(
    `⚠️ <b>${esc(e.full_name)}</b>${n ? ` — oldin <b>${n}</b> ta ogohlantirish olgan` : ''}\n\n` +
      'Ogohlantirish matnini yozing (yoki 🎙 ovoz / 🎥 video / 🖼 rasm / 📄 fayl yuboring).',
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

/** Matn yoki media → tasdiq */
const handleText = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.warn) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const media = field.mediaProof(ctx.message, WARN_MEDIA);
  const body = media ? (ctx.message.caption || '').trim().slice(0, 1500) : (ctx.message.text || '').trim().slice(0, 1500);
  if (!media && !body) return ctx.reply('Matn yozing yoki media yuboring.', ui.cancelKeyboard());
  const e = await employees.byId(s.warn.empId);
  if (!e || !access.canWarn(ctx.state.actor, e)) { session.clear(ctx.from.id); return ctx.reply("⛔️ Ruxsat yo'q.", ui.kbFor(ctx)); }
  session.set(ctx.from.id, { step: 'warn_confirm', warn: { ...s.warn, body: body || null, media: media || null } });
  return ctx.reply(
    `⚠️ <b>${esc(e.full_name)}</b> ga yuboriladi:\n${ui.LINE}\n` +
      (body ? esc(body) : `${ui.MEDIA_ICON[media.type] || '📎'} <i>media</i>`) +
      `\n${ui.LINE}\nYuborilsinmi?`,
    { parse_mode: 'HTML', ...inline([[cb('✅ Yuborish', 'wn:send'), cb('❌ Bekor qilish', 'wn:x')]]) },
  );
};

const doSend = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.warn || s.step !== 'warn_confirm') return ctx.answerCbQuery('Eskirgan tugma');
  session.clear(ctx.from.id);
  const e = await employees.byId(s.warn.empId);
  if (!e || !access.canWarn(ctx.state.actor, e)) return ctx.answerCbQuery("⛔️ Ruxsat yo'q");
  await ctx.answerCbQuery('Yuborilmoqda…');
  const res = await flows.sendWarning(botOf(ctx), e, {
    fromTg: ctx.from.id,
    fromName: ctx.state.actor.name,
    body: s.warn.body,
    media: s.warn.media,
  });
  return ctx.reply(
    `✅ Ogohlantirish <b>${esc(e.full_name)}</b> ga yuborildi (${res.count}-ogohlantirish).`,
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );
};

/** Hodim «👀 Tanishdim» */
const seen = async (ctx, warnId) => {
  const w = await warnings.byId(warnId);
  const emp = ctx.state.employee;
  if (!w || !emp || Number(w.employee_id) !== Number(emp.id)) return ctx.answerCbQuery('Eskirgan tugma');
  const first = await warnings.markSeen(w.id);
  await ctx.answerCbQuery(first ? 'Tanishdingiz ✅' : 'Allaqachon tanishgansiz');
  if (first) await flows.warningSeen(botOf(ctx), w, emp);
  return null;
};

const showList = async (ctx) => {
  const actor = ctx.state.actor;
  const own = !(actor.isAdmin || actor.isHr);
  const rows = await warnings.list({ fromTg: own ? actor.tgId : null });
  const lines = rows.map(
    (w) => `${w.seen_at ? '👀' : '⏳'} <b>${esc(w.full_name)}</b> — ${time.prettyDate(String(w.created_at).slice(0, 10))} ${time.clock(w.created_at)}\n` +
      `   ${w.body ? esc(String(w.body).slice(0, 120)) : `${ui.MEDIA_ICON[w.media_type] || '📎'} media`}\n` +
      `   <i>${esc(w.from_name || '')}${w.seen_at ? ' · tanishdi' : " · hali tanishmagan"}</i>`,
  );
  return render(
    ctx,
    `📜 <b>OGOHLANTIRISHLAR</b>${own ? ' — siz yuborganlar' : ''}\n${ui.LINE}\n${lines.join('\n') || "<i>hozircha yo'q</i>"}`,
    inline([[cb('⚠️ Yangi ogohlantirish', 'wn:home')]]),
  );
};

const canWarnAny = (ctx) => ctx.state.isAdmin || ctx.state.isHr || ctx.state.isHead;

/** warn_text bosqichida media (ovoz, video, rasm, fayl) */
const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (session.get(ctx.from.id).step !== 'warn_text') return next();
  if (!(ctx.state.isAdmin || ctx.state.isHr || ctx.state.isHead)) return next();
  return handleText(ctx);
};

const register = (bot) => {
  bot.hears(ui.BTN.warn, async (ctx) => {
    if (ctx.chat.type !== 'private') return null;
    if (!canWarnAny(ctx)) return ctx.reply("⛔️ Ogohlantirish faqat rahbar, HR va direktor uchun.", ui.kbFor(ctx));
    session.clear(ctx.from.id);
    return home(ctx);
  });
  bot.command('ogohlantirish', async (ctx) => {
    if (!canWarnAny(ctx)) return ctx.reply("⛔️ Ogohlantirish faqat rahbar, HR va direktor uchun.", ui.kbFor(ctx));
    session.clear(ctx.from.id);
    return home(ctx);
  });
  bot.action('wn:home', async (ctx) => { if (!canWarnAny(ctx)) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); session.clear(ctx.from.id); return home(ctx); });
  bot.action(/^wn:e:(\d+)$/, (ctx) => pick(ctx, ctx.match[1]));
  bot.action('wn:send', (ctx) => doSend(ctx));
  bot.action('wn:x', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery('Bekor qilindi'); return ctx.reply('❌ Bekor qilindi.', ui.kbFor(ctx)); });
  bot.action('wn:l', async (ctx) => { if (!canWarnAny(ctx)) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); return showList(ctx); });
  bot.action(/^wn:ok:(\d+)$/, (ctx) => seen(ctx, ctx.match[1]));
  bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], onMedia);
};

module.exports = { register, handleText, home };
