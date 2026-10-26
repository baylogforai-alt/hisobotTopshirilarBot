'use strict';

const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const { render } = require('../render');
const employees = require('../services/employees');
const attendance = require('../services/attendance');
const access = require('../services/access');
const visits = require('../services/visits');
const live = require('../services/live');
const webapp = require('../services/webapp');
const session = require('../session');
const org = require('../services/org');
const notify = require('../services/notify');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * AGENT JONLI JOYLASHUVI (6-okt, sinov).
 *   Agent: Telegram «Jonli joylashuvni ulashish» → onLiveStart (attendance.onLocation dan), keyin har harakat — edited_message (onEdited).
 *   Ko'ruvchi: «📡 Agentlar qayerda» /agentlar (lv:l) → agent (lv:e:<id>) → hozirgi joyi (lv:p:<id>), ilovada xarita (#/live/<id>).
 */

/** Yo'l nuqtasi yoziladimi — faqat Keldim ↔ Ketdim oralig'ida */
const recording = async (emp) => {
  const att = await attendance.get(emp.id);
  return Boolean(att && att.checked_in && !att.checked_out);
};

const tracks = (emp) => Boolean(emp && employees.isField(emp) && !employees.isBoss(emp));

/** Yangi «Live Location» xabari. quiet — boshqa bosqich (Keldim) ichida: agentga alohida javob yo'q */
const onLiveStart = async (ctx, { quiet = false } = {}) => {
  const emp = ctx.state.employee;
  if (!tracks(emp)) return null;
  const rec = await recording(emp);
  const res = await live.track(emp, ctx.message, { record: rec });
  if (!res.share || res.ignored) return res;
  if (rec && (await live.hadTroubleToday(emp, res.share.id))) await live.onRestarted(botOf(ctx), emp, res.share);
  if (!quiet) await ctx.reply(live.startedText(emp, res.share, rec), { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  return res;
};

/** Telegram jonli joylashuvni tahrirlaydi — har harakat */
const onEdited = async (ctx) => {
  const m = ctx.editedMessage;
  if (!m || !m.location || !ctx.chat || ctx.chat.type !== 'private') return;
  const emp = ctx.state.employee;
  if (!tracks(emp)) return;
  const rec = await recording(emp);
  const res = await live.track(emp, m, { record: rec });
  if (!rec || res.ignored || !res.share) return;
  if (res.stopped) await live.onStopped(botOf(ctx), emp, res.share);
  else if (res.resumed) await live.onResumed(botOf(ctx), emp, res.share);
};

/**
 * 7-okt: jonli joylashuvi o'chiq agent (Keldim ↔ Ketdim, ish tugaguncha) — boshqa hech narsa ishlamaydi.
 * O'tadi: joylashuv (jonli yoqish, Ketdim joylashuvi), Telegram tahrirlari, «Ketdim» va uning izohi, «Bekor qilish», /id.
 */
const PASS_TEXT = new Set([ui.BTN.checkOut, ui.BTN.leave, '/javob', ui.BTN.cancel, '/id']);
const PASS_STEPS = new Set(['awaiting_checkout_location', 'checkout_note', 'leave_reason', 'meeting_reason']);
const guard = async (ctx, next) => {
  const emp = ctx.state.employee;
  if (!tracks(emp) || !ctx.chat || ctx.chat.type !== 'private') return next();
  if (ctx.updateType === 'edited_message') return next();
  const m = ctx.message;
  if (m && (m.location || m.venue)) return next();
  if (m && m.text) {
    const text = m.text.trim();
    if (PASS_TEXT.has(text) || PASS_STEPS.has(session.get(ctx.from.id).step)) return next();
  }
  if (ctx.updateType !== 'message' && ctx.updateType !== 'callback_query') return next();
  if (!(await live.offFor(emp))) return next();
  // «Javob so'rash» — joylashuv o'chiq bo'lsa ham (masalan, uyga ketishga ruxsat so'raydi)
  if (ctx.updateType === 'callback_query' && /^(jv:k:|mr:|rq:|ci:novideo)/.test(String((ctx.callbackQuery && ctx.callbackQuery.data) || ''))) return next();
  // «Keldim» davomi: video (20-okt — kelish allaqachon yozilgan) va kechikish sababi qulfdan o'tadi
  if (ctx.updateType === 'message' && ['leave_reason', 'live_noloc', 'meeting_reason', 'awaiting_checkin_video', 'late_reason'].includes(session.get(ctx.from.id).step)) return next();
  // 8-okt: «📵 Jonli joylashuv ishlamayapti»
  if (ctx.updateType === 'callback_query' && (ctx.callbackQuery && ctx.callbackQuery.data) === 'lv:nl') return next();
  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery("⛔️ Jonli joylashuvingiz o'chiq — avval uni yoqing (📎 → Joylashuv → Jonli joylashuv).", { show_alert: true }).catch(() => {});
    return undefined;
  }
  // 8-okt: «Keldim» qayta bosildi — u allaqachon qilingan, faqat jonli joylashuv kerakligini aniq aytamiz
  const again = m && m.text && (m.text.trim() === ui.BTN.checkIn || /^\/keldim(@\S+)?$/.test(m.text.trim()));
  const att = again ? await attendance.get(emp.id) : null;
  const head = att && att.checked_in
    ? `✅ Siz bugun allaqachon kelgansiz (${time.clock(att.checked_in)}) — «${ui.BTN.checkIn}» ni qayta bosish shart emas. Endi faqat <b>jonli joylashuv</b> kerak.\n\n`
    : '';
  return ctx.reply(`${head}${live.blockedText(await live.latest(emp.id))}${live.LIVE_PROMPT}`, { parse_mode: 'HTML', ...live.noLiveKb() });
};

/**
 * 8-okt: «📵 Jonli joylashuv ishlamayapti» (lv:nl) — Keldim qilgan, jonli joylashuvi o'chiq agent sabab yozadi (matn yoki media)
 * → rahbar va HR ga, o'sha kuni jonli joylashuv talab qilinmaydi (attendance.live_excused_at), bot ochiladi.
 */
const startNoLive = async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const emp = ctx.state.employee;
  if (!tracks(emp)) return undefined;
  if (!(await live.offFor(emp))) return ctx.reply('ℹ️ Hozir jonli joylashuv sizdan talab qilinmayapti.', ui.kbFor(ctx));
  session.set(ctx.from.id, { step: 'live_noloc' });
  return ctx.reply(
    `📵 <b>Jonli joylashuv nega ishlamayapti?</b>\n\n<b>Sababini yozing</b> (masalan: Telegram'da «Jonli joylashuv» yo'q, telefon eski, GPS buzilgan) yoki 🎥 video / 🎙 audio / 🖼 rasm yuboring.\n` +
      `Sabab rahbaringiz va HR ga boradi, bugun bot sizga ochiladi.`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

/** live_noloc bosqichi — matn (STEP_HANDLERS) yoki media (attendance.onMedia) */
const handleNoLive = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return undefined;
  const { reasonProof, reasonOf } = require('./attendance');
  const proof = ctx.message.text ? null : reasonProof(ctx.message);
  const reason = reasonOf(ctx, proof);
  if (!reason) return ctx.reply('✍️ Sababini yozing yoki video/audio yuboring:', ui.cancelKeyboard());
  session.clear(ctx.from.id);
  const att = await attendance.get(emp.id);
  if (!att || !att.checked_in || att.checked_out) return ctx.reply(`ℹ️ Bugun «${ui.BTN.checkIn}» qilinmagan yoki ketgansiz.`, ui.kbFor(ctx));
  if (!(await attendance.markLiveExcused(att.id, reason))) return ctx.reply('ℹ️ Sabab avval yuborilgan — bugun jonli joylashuv talab qilinmaydi.', ui.kbFor(ctx));
  await ctx.reply(
    `✅ Sabab ${esc(await org.recipientsLabel(emp))}ga yuborildi. Bugun bot sizga ochiq.\n\n<i>Jonli joylashuv ishlab qolsa — baribir yoqing (📎 → Joylashuv → Jonli joylashuvni ulashish).</i>`,
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );
  const text = `📵 <b>${esc(emp.full_name)}</b> — <b>jonli joylashuv ishlamayapti</b> (keldi ${time.clock(att.checked_in)})\nSabab: «${esc(reason)}»\n<i>Bugun uning yo'li kuzatilmaydi.</i>`;
  await notify.toAttendanceWatchers(botOf(ctx), emp, text, {}, proof);
  await notify.toArchive(botOf(ctx), text, proof);
  return undefined;
};

// ---------------------------------------------------------------------------
// KO'RUVCHI: boshliq/direktor, HR, bo'lim rahbari
// ---------------------------------------------------------------------------

const ORDER = { live: 0, stale: 1, stopped: 2, nolive: 3, excused: 3, out: 4, absent: 5 };

const listView = async (ctx) => {
  const actor = ctx.state.actor;
  if (!access.canUseLive(actor)) return ctx.reply('⛔️ Faqat boshliq, HR va bo\'lim rahbari uchun.', ui.kbFor(ctx));
  const agents = await access.liveAgentsFor(actor);
  if (!agents.length) {
    return render(ctx, `📡 <b>AGENTLAR QAYERDA</b>\n\nHudud (agent) rejimidagi hodim yo'q${actor.isHead && !actor.seeAll ? " (bo'limingizda)" : ''}.\n<i>Hodim kartochkasida ish turi «hudud» qilinsa — shu yerda chiqadi.</i>`);
  }
  const rows = [];
  for (const e of agents) rows.push({ e, s: await live.statusOf(e) });
  rows.sort((a, b) => ORDER[a.s.kind] - ORDER[b.s.kind] || a.e.full_name.localeCompare(b.e.full_name));
  const lines = rows.map(({ e, s }, i) =>
    `${i + 1}. <b>${esc(e.full_name)}</b> — ${live.kindText(s)}` +
      (s.lat != null && s.kind !== 'absent' ? `\n    ${live.mapLink(s.lat, s.lon)}${live.homeDist(e, s.lat, s.lon)}` : ''));
  const kb = rows.map(({ e, s }) => [cb(`${live.KIND[s.kind][0]} ${e.full_name}`.slice(0, 60), `lv:e:${e.id}`)]);
  kb.push([cb('🔄 Yangilash', 'lv:l')]);
  return render(ctx, `📡 <b>AGENTLAR QAYERDA</b> · ${time.clock(time.stamp())}\n\n${lines.join('\n')}\n\n<i>Agentni bossangiz — bugungi yo'li va to'xtashlari.</i>`, inline(kb));
};

const loadAgent = async (ctx, id) => {
  const emp = await employees.byId(id);
  if (!emp || !access.canSeeLive(ctx.state.actor, emp)) {
    await ctx.answerCbQuery('⛔️ Ruxsat yo\'q', { show_alert: true }).catch(() => {});
    return null;
  }
  return emp;
};

const agentView = async (ctx) => {
  const emp = await loadAgent(ctx, ctx.match[1]);
  if (!emp) return undefined;
  await ctx.answerCbQuery().catch(() => {});
  const today = time.today();
  const s = await live.statusOf(emp, today);
  const pts = await live.points(emp.id, today);
  const endAt = s.kind === 'live' || s.kind === 'stale' ? time.stamp() : null;
  const st = live.stops(pts, { endAt });
  const vs = await visits.forEmployee(emp.id, today, today);
  const route = live.routeUrl(pts);
  const lines = [`📡 <b>${esc(emp.full_name)}</b> — ${time.prettyDate(today)}`, `Holat: ${live.kindText(s)}`];
  if (s.att && s.att.checked_in) lines.push(`Keldi: ${time.clock(s.att.checked_in)}${s.att.checkin_dist ? ` · uydan ${geo.prettyDistance(Number(s.att.checkin_dist))}` : ''}`);
  if (s.lat != null && s.kind !== 'absent') lines.push(`📍 ${s.kind === 'live' || s.kind === 'stale' ? 'Hozir' : 'Oxirgi joy'}: ${live.mapLink(s.lat, s.lon)}${live.homeDist(emp, s.lat, s.lon)}`);
  if (pts.length) lines.push(`🛣 Bugun yurgan yo'li: ~${geo.prettyDistance(live.pathLength(pts))} · ${pts.length} nuqta`);
  if (st.length) {
    lines.push('', `⏸ <b>To'xtashlar</b> (15 daq+):`);
    st.slice(-10).forEach((x, i) => lines.push(`${i + 1}. ${time.clock(x.from)}–${x.ongoing && endAt ? 'hozir' : time.clock(x.to)} (${time.prettyDuration(x.min)}) · ${live.mapLink(x.lat, x.lon, '🗺')}`));
  }
  if (vs.length) lines.push('', `🚶 Tashriflar: ${vs.length} (${vs.map((v) => time.clock(v.created_at)).join(', ')})`);
  if (route) lines.push('', `<a href="${route}">🧭 Marshrut (Yandex Maps, taxminiy)</a>`);
  if (!pts.length && s.kind !== 'absent') lines.push('', "<i>Bugun yo'l nuqtalari hali yo'q.</i>");
  const kb = [];
  if (s.lat != null && s.kind !== 'absent') kb.push([cb('📍 Joyini yuborish', `lv:p:${emp.id}`), cb('🔄 Yangilash', `lv:e:${emp.id}`)]);
  else kb.push([cb('🔄 Yangilash', `lv:e:${emp.id}`)]);
  if (webapp.enabled()) kb.push([webapp.inlineButton("🗺 Xaritada yo'li (ilova)", `#/live/${emp.id}`)]);
  kb.push([cb('⬅️ Agentlar', 'lv:l')]);
  return render(ctx, lines.join('\n'), inline(kb));
};

const sendPoint = async (ctx) => {
  const emp = await loadAgent(ctx, ctx.match[1]);
  if (!emp) return undefined;
  const s = await live.statusOf(emp);
  if (s.lat == null || s.kind === 'absent') return ctx.answerCbQuery("Bugun joylashuv yo'q", { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.replyWithLocation(s.lat, s.lon);
  return ctx.reply(`📍 <b>${esc(emp.full_name)}</b> — ${live.kindText(s)}`, { parse_mode: 'HTML' });
};

const register = (bot) => {
  bot.on('edited_message', onEdited);
  bot.action('lv:nl', startNoLive);
  bot.hears(ui.BTN.agents, listView);
  bot.command('agentlar', listView);
  bot.action('lv:l', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); return listView(ctx); });
  bot.action(/^lv:e:(\d+)$/, agentView);
  bot.action(/^lv:p:(\d+)$/, sendPoint);
};

module.exports = { register, guard, onLiveStart, onEdited, listView, handleNoLive };
