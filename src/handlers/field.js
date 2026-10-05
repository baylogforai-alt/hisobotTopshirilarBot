'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const session = require('../session');
const employees = require('../services/employees');
const visits = require('../services/visits');
const months = require('../services/months');
const notify = require('../services/notify');
const { notRegistered } = require('./common');

const { esc } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * HUDUD AGENTLARI.
 *   Uy joylashuvi — «Keldim» uchun uydan FIELD_MIN_DISTANCE_M (1,5 km) uzoqda bo'lish kerak. Hodim bir marta o'zi belgilaydi,
 *                   keyin faqat direktor tozalay oladi (kartochkada «🏠 Uy joyini tozalash»).
 *   Tashrif        — «📍 Hududga keldim» → lokatsiya → video / dumaloq video / audio / ovozli xabar → izoh (ixtiyoriy).
 *                   Tekshiruvchilarga va arxiv guruhiga nusxa ketadi.
 */

const mapLink = (lat, lon) => `<a href="https://maps.google.com/?q=${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}">🗺 xaritada</a>`;

const isForwarded = (m) => Boolean(m.forward_date || m.forward_origin || m.forward_from);

// ---------------------------------------------------------------------------
// UY JOYLASHUVI
// ---------------------------------------------------------------------------

const askHome = (ctx) => {
  session.set(ctx.from.id, { step: 'awaiting_home_location' });
  return ctx.reply(require('../services/flows').HOME_PROMPT(), { parse_mode: 'HTML', ...ui.locationKeyboard() });
};

/** Xaritadan tanlangan joy (venue) — haqiqiy joylashuv emas */
const isVenue = (m) => Boolean(m && m.venue);

const onHomeLocation = async (ctx) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  if (isForwarded(ctx.message) || isVenue(ctx.message)) {
    session.set(ctx.from.id, { step: 'awaiting_home_location' });
    return ctx.reply(`❌ Bu joylashuv xaritadan tanlangan yoki boshqa joydan yuborilgan. Uyda turib «${ui.BTN.sendLocation}» tugmasini bosing.`, ui.locationKeyboard());
  }
  if (employees.homeOf(emp)) return ctx.reply('ℹ️ Uy joylashuvingiz allaqachon saqlangan. O\'zgartirish uchun boshliqqa murojaat qiling.', ui.kbFor(ctx));
  const { latitude: lat, longitude: lon } = ctx.message.location;
  await employees.setHome(emp.id, lat, lon);
  await ctx.reply(
    `✅ <b>Uy joylashuvingiz saqlandi.</b>\n\nEndi shu joylashuv bo'yicha ishlaysiz: ishga chiqqaningizda (uydan ${geo.prettyDistance(config.fieldMinDistanceM)} dan uzoqda) «${ui.BTN.checkIn}» bosing. Eslatmalar endi kelmaydi.`,
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );
  await notify.toAttendanceWatchers(botOf(ctx), emp, `🏠 <b>${esc(emp.full_name)}</b> uy joylashuvini belgiladi · ${mapLink(lat, lon)}`);
  await notify.toArchive(botOf(ctx), `🏠 ${esc(emp.full_name)} — uy joylashuvi · ${mapLink(lat, lon)}`);
};

// ---------------------------------------------------------------------------
// TASHRIF
// ---------------------------------------------------------------------------

const startVisit = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  if (!employees.isField(emp) || employees.isBoss(emp)) return ctx.reply('ℹ️ Bu tugma faqat hudud (agent) hodimlari uchun.', ui.kbFor(ctx));
  if (!(await months.canWork(emp.id))) return require('./month').promptMonthStart(ctx, emp);
  session.set(ctx.from.id, { step: 'visit_location' });
  return ctx.reply(
    `📍 <b>Hududga keldim</b>\n\nBorishingiz kerak bo'lgan joyda turib «${ui.BTN.sendLocation}» tugmasini bosing.\nKeyin <b>video yoki audio</b> yuborasiz, xohlasangiz izoh ham yozasiz.`,
    { parse_mode: 'HTML', ...ui.locationKeyboard() },
  );
};

const onVisitLocation = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  if (isForwarded(ctx.message)) return ctx.reply(`❌ Bu joylashuv boshqa joydan yuborilgan. «${ui.BTN.sendLocation}» tugmasini bosing.`, ui.locationKeyboard());
  const { latitude: lat, longitude: lon } = ctx.message.location;
  const home = employees.homeOf(emp);
  const homeDist = home ? geo.distanceMeters(home.lat, home.lon, lat, lon) : null;
  session.set(ctx.from.id, { step: 'visit_proof', visit: { lat, lon, homeDist } });
  return ctx.reply(
    `✅ Joylashuv qabul qilindi.\n\n🎥 Endi <b>video</b> (oddiy yoki dumaloq) yoki 🎙 <b>audio / ovozli xabar</b> yuboring.\nIzohni video ostiga yozsangiz ham bo'ladi.`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

/** Media → isbot. Qaytaradi: {type, fileId} yoki null */
const mediaProof = (m, allowed) => {
  if (allowed.includes('video') && m.video) return { type: 'video', fileId: m.video.file_id };
  if (allowed.includes('video_note') && m.video_note) return { type: 'video_note', fileId: m.video_note.file_id };
  if (allowed.includes('voice') && m.voice) return { type: 'voice', fileId: m.voice.file_id };
  if (allowed.includes('audio') && m.audio) return { type: 'audio', fileId: m.audio.file_id };
  if (allowed.includes('video') && m.document && /^video\//.test(m.document.mime_type || '')) return { type: 'document', fileId: m.document.file_id };
  return null;
};

const onVisitProof = async (ctx) => {
  const s = session.get(ctx.from.id);
  const m = ctx.message;
  const proof = mediaProof(m, ['video', 'video_note', 'voice', 'audio']);
  if (!proof) return ctx.reply('🎥 Video yoki 🎙 audio kerak (rasm qabul qilinmaydi).', ui.cancelKeyboard());
  const caption = (m.caption || '').trim();
  if (caption) return finishVisit(ctx, { ...s.visit, proof }, caption);
  session.set(ctx.from.id, { step: 'visit_note', visit: { ...s.visit, proof } });
  return ctx.reply(`💬 Izoh yozing (masalan: mijoz nomi, nima qilindi) yoki «${ui.BTN.skip}».`, ui.skipKeyboard());
};

const handleVisitNote = async (ctx, { skip = false } = {}) => {
  const s = session.get(ctx.from.id);
  if (!s.visit) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  return finishVisit(ctx, s.visit, skip ? null : ctx.message.text.trim());
};

const finishVisit = async (ctx, v, note) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  const row = await visits.create({ employeeId: emp.id, lat: v.lat, lon: v.lon, homeDist: v.homeDist, proof: v.proof, note });
  const n = await visits.countFor(emp.id, time.today(), time.today());
  await ctx.reply(`✅ <b>Tashrif qayd etildi</b> — ${time.clock(row.created_at)} · bugun ${n}-chi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  const text =
    `📍 <b>${esc(emp.full_name)}</b> hududga keldi · ${time.clock(row.created_at)} (bugun ${n}-chi)\n` +
    `${mapLink(v.lat, v.lon)}${v.homeDist != null ? ` · uydan ${geo.prettyDistance(v.homeDist)}` : ''} · ${visits.proofLabel(v.proof.type)}` +
    (note ? `\n💬 «${esc(note.slice(0, 500))}»` : '');
  await notify.toAttendanceWatchers(botOf(ctx), emp, text, {}, v.proof);
  await notify.toArchive(botOf(ctx), text, v.proof);
};

const register = (bot) => {
  bot.hears(ui.BTN.visit, startVisit);
  bot.command('tashrif', startVisit);
};

module.exports = { register, askHome, isVenue, onHomeLocation, startVisit, onVisitLocation, onVisitProof, handleVisitNote, mediaProof, mapLink, isForwarded };
