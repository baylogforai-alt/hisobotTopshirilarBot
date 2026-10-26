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
const db = require('../db');
const { notRegistered } = require('./common');

const { esc } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * HUDUD AGENTLARI.
 *   Uy joylashuvi — «Keldim» uchun uydan FIELD_MIN_DISTANCE_M (1,5 km) uzoqda bo'lish kerak. Hodim bir marta o'zi belgilaydi,
 *                   keyin faqat direktor tozalay oladi (kartochkada «🏠 Uy joyini tozalash»).
 *                   Direktor va bo'lim rahbari agentning uy joyini o'zi belgilaydi / o'zgartiradi («🏠 Uy joyini belgilash», fh:<id>).
 *   Tashrif        — «📍 Hududga keldim» → lokatsiya → video / dumaloq video / audio / ovozli xabar → izoh (ixtiyoriy).
 *                   Tekshiruvchilarga va arxiv guruhiga nusxa ketadi.
 *                   Tugma bosilganda avval «beyjik» eslatmasi: matn + boshliq yozib qo'ygan ovozli xabar (bo'lsa).
 *   Beyjik ovozi   — boshliq/direktor: Panel «🪪 Beyjik eslatmasi» yoki /beyjik (bj:*) → ovoz → «✅ Shu» / «🔁 Boshidan» / «❌ Bekor».
 */

const mapLink = (lat, lon) => `<a href="${geo.mapUrl(lat, lon)}">🗺 xaritada</a>`;

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
  // 7-okt: tugma shart emas (📎 → Joylashuv ham, xaritadan tanlangani ham) — faqat boshqa odamdan forward qilingani rad; boshliq xaritada ko'radi va tozalay oladi
  if (isForwarded(ctx.message)) {
    session.set(ctx.from.id, { step: 'awaiting_home_location' });
    return ctx.reply(`❌ Bu joylashuv boshqa chatdan forward qilingan. Uyda turib o'z joylashuvingizni yuboring (📎 → Joylashuv yoki «${ui.BTN.sendLocation}»).`, ui.locationKeyboard());
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
// RAHBAR / DIREKTOR AGENTNING UY JOYINI BELGILAYDI (fh:<id> → set_emp_home)
//   Joylashuv (📎 → Joylashuv — xaritadan tanlangani ham bo'ladi), Yandex / Google Maps havolasi yoki «40.99, 71.64».
// ---------------------------------------------------------------------------

const backToCard = (ctx, e) =>
  ctx.state.isAdmin ? require('./admin').employeeCard(ctx, e.id) : require('./team').memberView(ctx, e.id);

const askEmpHome = async (ctx, empId) => {
  const e = await employees.byId(empId);
  if (!require('../services/access').canSetHome(ctx.state.actor, e)) return ctx.answerCbQuery('⛔️ Faqat direktor va o\'z bo\'limi rahbari (hudud agenti uchun)', { show_alert: true });
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step: 'set_emp_home', empId: e.id });
  const cur = employees.homeOf(e);
  return ctx.reply(
    `🏠 <b>${esc(e.full_name)}</b> — uy joylashuvi${cur ? ` (hozir: ${mapLink(cur.lat, cur.lon)})` : ''}\n\n` +
      `Quyidagilardan birini yuboring:\n` +
      `• 📎 → <b>Joylashuv</b> → xaritada uyini tanlab yuboring;\n` +
      `• koordinata: <code>40.990204, 71.646206</code> (Yandex Maps'da nuqtani bosing — koordinatasi chiqadi, nusxalang);\n` +
      `• Yandex yoki Google Maps havolasi (to'liq havola; qisqa <code>…/maps/-/…</code> havoladan koordinata olinmaydi);\n` +
      `• uyida turgan bo'lsangiz — «${ui.BTN.sendLocation}».`,
    { parse_mode: 'HTML', disable_web_page_preview: true, ...ui.locationKeyboard() },
  );
};

const saveEmpHome = async (ctx, lat, lon) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  const e = s.empId ? await employees.byId(s.empId) : null;
  if (!require('../services/access').canSetHome(ctx.state.actor, e)) return ctx.reply('⛔️ Ruxsat yo\'q.', ui.kbFor(ctx));
  await require('../services/flows').setHomeBy(botOf(ctx), ctx.state.actor, e, lat, lon);
  await ctx.reply(`✅ <b>${esc(e.full_name)}</b> uy joylashuvi saqlandi · ${mapLink(lat, lon)}\nHodimga xabar yuborildi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  return backToCard(ctx, await employees.byId(e.id));
};

/** set_emp_home bosqichida joylashuv (venue ham — rahbar xaritadan tanlaydi) */
const onEmpHomeLocation = (ctx) => saveEmpHome(ctx, ctx.message.location.latitude, ctx.message.location.longitude);

/** set_emp_home bosqichida matn — havola yoki koordinata */
const handleEmpHomeText = (ctx) => {
  const c = require('../services/flows').parseCoords(ctx.message.text);
  if (!c) return ctx.reply("❓ Koordinata topilmadi. «40.990204, 71.646206» ko'rinishida (Yandex Maps'da nuqtani bosib nusxalang), Yandex / Google Maps havolasini yoki 📎 → Joylashuv yuboring.", ui.locationKeyboard());
  return saveEmpHome(ctx, c.lat, c.lon);
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
  await ctx.reply(BADGE_TEXT, { parse_mode: 'HTML' });
  const audio = await badgeAudio();
  if (audio) await notify.sendProof(botOf(ctx), ctx.chat.id, audio, '🪪 Beyjik — eslatma');
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

// ---------------------------------------------------------------------------
// BEYJIK ESLATMASI — tashrifdan oldin matn + ovozli xabar (ovozni boshliq yozadi; settings.badge_audio)
// ---------------------------------------------------------------------------

const BADGE_TEXT = '🪪 <b>Beyjigingiz taqilganligiga ishonch hosil qiling!</b>\n\nMijoz oldiga beyjiksiz kirmang.';
const BADGE_KEY = 'badge_audio';

/** Saqlangan ovoz {type, fileId} yoki null */
const badgeAudio = async () => {
  try {
    const raw = await db.getSetting(BADGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && v.fileId ? v : null;
  } catch { return null; }
};

const badgeMenu = async (head = '') => {
  const has = Boolean(await badgeAudio());
  const text =
    (head ? `${head}\n\n` : '') +
    `🪪 <b>BEYJIK ESLATMASI</b> (agentlar)\n\nAgent «${ui.BTN.visit}» bosganda — joylashuv va videodan oldin — shu matn boradi:\n\n${BADGE_TEXT}\n\n` +
    `🎙 Ovozli xabar: ${has ? '✅ yozilgan (matndan keyin boradi)' : "❌ yo'q — faqat matn boradi"}`;
  const rows = has
    ? [[ui.cb('▶️ Eshitish', 'bj:see'), ui.cb("🔁 Ovozni o'zgartirish", 'bj:set')], [ui.cb("🗑 Ovozni o'chirish", 'bj:del')]]
    : [[ui.cb('🎙 Ovozli xabar yozish', 'bj:set')]];
  rows.push([ui.cb('⬅️ Panel', 'adm:home')]);
  return [text, { parse_mode: 'HTML', ...ui.inline(rows) }];
};

const askBadgeAudio = (ctx) => {
  session.set(ctx.from.id, { step: 'badge_audio' });
  return ctx.reply(
    "🎙 Agentlar uchun <b>ovozli xabar</b> yozib yuboring (masalan: «Beyjigingiz taqilganligiga ishonch hosil qiling»).\n\nYuborganingizdan keyin — saqlash yoki boshidan yozishni tanlaysiz.",
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

/** badge_audio / badge_confirm bosqichida media: faqat ovozli xabar yoki audio; yangi ovoz oldingisining o'rniga */
const onBadgeMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const st = session.get(ctx.from.id);
  if (st.step !== 'badge_audio' && st.step !== 'badge_confirm') return next();
  if (!ctx.state.isAdmin) { session.clear(ctx.from.id); return next(); }
  const proof = mediaProof(ctx.message, ['voice', 'audio']);
  if (!proof) return ctx.reply('🎙 Faqat ovozli xabar (yoki audio fayl) yuboring.', ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'badge_confirm', badge: proof });
  return ctx.reply("🎧 Ovozni eshitib ko'ring. <b>Shu ovoz saqlansinmi?</b>", {
    parse_mode: 'HTML',
    ...ui.inline([[ui.cb('✅ Shu, saqlash', 'bj:ok'), ui.cb('🔁 Boshidan yozish', 'bj:again')], [ui.cb('❌ Bekor qilish', 'bj:x')]]),
  });
};

const onBadgeAction = async (ctx) => {
  if (!ctx.state.isAdmin) return ctx.answerCbQuery('⛔️ Faqat boshliq/direktor', { show_alert: true });
  const act = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  if (act === 'menu') {
    const menu = await badgeMenu();
    return ctx.editMessageText(...menu).catch(() => ctx.reply(...menu));
  }
  if (act === 'see') {
    const a = await badgeAudio();
    if (!a) return ctx.reply('Ovozli xabar hali yozilmagan.');
    return notify.sendProof(botOf(ctx), ctx.chat.id, a, '🪪 Beyjik — agentlarga boradigan ovoz');
  }
  if (act === 'del') {
    await db.setSetting(BADGE_KEY, '');
    return ctx.editMessageText(...(await badgeMenu("🗑 Ovozli xabar o'chirildi — agentlarga faqat matn boradi."))).catch(() => {});
  }
  if (act === 'set' || act === 'again') return askBadgeAudio(ctx);
  const st = session.get(ctx.from.id);
  if (act === 'x') {
    if (st.step === 'badge_audio' || st.step === 'badge_confirm') session.clear(ctx.from.id);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply("❌ Bekor qilindi — avvalgi ovoz o'zgarmadi.", ui.kbFor(ctx));
    return ctx.reply(...(await badgeMenu()));
  }
  // ok — sessiya birinchi await dan oldin tozalanadi (ikki marta bosish)
  if (st.step !== 'badge_confirm' || !st.badge) return ctx.reply('Sessiya eskirgan — qaytadan /beyjik.', ui.kbFor(ctx));
  session.clear(ctx.from.id);
  await db.setSetting(BADGE_KEY, JSON.stringify(st.badge));
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(`✅ Ovoz saqlandi. Agentlar «${ui.BTN.visit}» bosganda matn va shu ovoz boradi.`, ui.kbFor(ctx));
  return ctx.reply(...(await badgeMenu()));
};

const register = (bot) => {
  bot.hears(ui.BTN.visit, startVisit);
  bot.command('tashrif', startVisit);
  bot.action(/^fh:(\d+)$/, (ctx) => askEmpHome(ctx, ctx.match[1]));
  bot.command('beyjik', async (ctx) => {
    if (!ctx.state.isAdmin) return ctx.reply('⛔️ Faqat boshliq/direktor uchun.');
    return ctx.reply(...(await badgeMenu()));
  });
  bot.action(/^bj:(menu|see|set|del|ok|again|x)$/, onBadgeAction);
  bot.on(['voice', 'audio', 'video', 'video_note', 'photo', 'document'], onBadgeMedia);
};

module.exports = { register, badgeAudio, BADGE_TEXT, askHome, isVenue, onHomeLocation, onEmpHomeLocation, handleEmpHomeText,startVisit, onVisitLocation, onVisitProof, handleVisitNote, mediaProof, mapLink, isForwarded };
