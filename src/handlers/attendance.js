'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const session = require('../session');
const { render } = require('../render');
const tasks = require('../services/tasks');
const attendance = require('../services/attendance');
const employees = require('../services/employees');
const office = require('../services/office');
const branches = require('../services/branches');
const months = require('../services/months');
const field = require('./field');
const org = require('../services/org');
const notify = require('../services/notify');
const reports = require('../services/reports');
const activity = require('../services/activity');
const dailyReports = require('../services/dailyReports');
const flows = require('../services/flows');
const access = require('../services/access');
const { notRegistered } = require('./common');

const { esc } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

// ---------------------------------------------------------------------------
// KELDIM
//   0. Oy boshi tasdiqlanmagan bo'lsa — avval tasdiqlash (MONTH_START_REQUIRED)
//   1. Lokatsiya:  ofis rejimi — filial/umumiy ofis radiusida;  hudud rejimi — uydan FIELD_MIN_DISTANCE_M dan uzoqda
//   2. Video:      ofis — OFFICE_CHECKIN_VIDEO (majburiy);  hudud — kartochkadagi belgi (majburiy yoki ixtiyoriy)
//   3. Qayd: kelish vaqti = lokatsiya yuborilgan payt. Video tekshiruvchilarga va arxiv guruhiga ketadi.
// ---------------------------------------------------------------------------

/** Lokatsiyadan keyin video shu muddat ichida kelishi kerak */
const VIDEO_WAIT_MIN = 15;

/** Boshliq (kompaniya rahbari) — davomat belgilamaydi */
const BOSS_NO_ATT = "ℹ️ Siz kompaniya rahbarisiz — davomat (Keldim, Ketdim, Kech qolaman, Kelmayman) siz uchun yuritilmaydi.";

const doCheckIn = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz — davomat faqat hodimlar uchun.") : notRegistered(ctx);
  if (employees.isBoss(emp)) return ctx.reply(BOSS_NO_ATT, ui.kbFor(ctx));

  const row = await attendance.get(emp.id);
  if (row && row.checked_in) {
    const open = await tasks.openFor(emp.id);
    activity.mark(ctx, 'checkin_repeat', { detail: `allaqachon kelgan (${time.clock(row.checked_in)})` });
    return ctx.reply(
      `ℹ️ Siz bugun allaqachon kelgansiz (${time.clock(row.checked_in)}).\n\n<b>Ochiq missiyalar (${open.length}):</b>\n${ui.taskList(open)}`,
      { parse_mode: 'HTML', ...ui.kbFor(ctx) },
    );
  }
  if (!(await months.canWork(emp.id))) return require('./month').promptMonthStart(ctx, emp);
  if (employees.isField(emp) && !employees.homeOf(emp)) return field.askHome(ctx);

  session.set(ctx.from.id, { step: 'awaiting_checkin_location' });
  const videoNote = employees.needsCheckinVideo(emp) ? '\nKeyin <b>video</b> yuborasiz (ishga kelganingiz isboti).' : '';
  const where = employees.isField(emp)
    ? `Siz <b>hudud</b> rejimidasiz: uyingizdan kamida <b>${geo.prettyDistance(config.fieldMinDistanceM)}</b> uzoqda bo'lsangiz ishda hisoblanasiz.`
    : 'Bot hozirgi joylashuvingizni ofis bilan solishtiradi.';
  return ctx.reply(
    `📍 <b>Ishga kelganingizni tasdiqlang</b>\n\nPastdagi <b>«${ui.BTN.sendLocation}»</b> tugmasini bosing. ${where}${videoNote}\n\n` +
      `<i>⚠️ Faqat shu tugma orqali yuborilgan joriy joylashuv qabul qilinadi. Forward qilingan joylashuv rad etiladi, xaritadan tanlangani rahbarga belgilab yuboriladi.</i>`,
    { parse_mode: 'HTML', ...ui.locationKeyboard() },
  );
};

const askLateReason = (ctx, lateMinutes) => {
  session.set(ctx.from.id, { step: 'late_reason' });
  return ctx.reply(
    `⏰ Siz bugun <b>${time.prettyDuration(lateMinutes)}</b> kech keldingiz.\n\nSababini yozing yoki 🎥 video / 🎙 audio yuboring (HR va boshliq ko'radi) — yoki «${ui.BTN.skip}».`,
    { parse_mode: 'HTML', ...ui.skipKeyboard() },
  );
};

/** Sabab xabaridagi media (video, dumaloq video, audio, ovozli, rasm) → {type, fileId} */
const REASON_MEDIA = ['video', 'video_note', 'voice', 'audio'];
const reasonProof = (m) => {
  const p = field.mediaProof(m, REASON_MEDIA);
  if (p) return p;
  if (m.photo && m.photo.length) return { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  return null;
};
/** Matn yoki media captionidan sabab matni */
const reasonOf = (ctx, proof) => {
  const m = ctx.message;
  const text = (m.text || m.caption || '').trim().slice(0, 300);
  return text || (proof ? `(${require('../services/visits').proofLabel(proof.type).replace(/^\S+\s/, '')})` : '');
};

/** late_reason bosqichi — matn (STEP_HANDLERS) yoki media (onMedia) */
const handleLateReason = async (ctx, { skip = false } = {}) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  if (skip) return ctx.reply('Tushunarli. Yaxshi ish kuni tilayman! 💪', ui.kbFor(ctx));
  const proof = ctx.message.text ? null : reasonProof(ctx.message);
  const reason = reasonOf(ctx, proof);
  const row = await attendance.setLateReason(emp.id, reason, time.today(), proof);
  activity.mark(ctx, 'late_reason', { title: reason });
  await ctx.reply(`✅ Sabab qayd etildi va ${esc(await org.recipientsLabel(emp))}ga yuborildi. Yaxshi ish kuni! 💪`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  const text = `💬 <b>${esc(emp.full_name)}</b> kechikish sababi (${time.prettyDuration(Number(row.late_minutes))}):\n«${esc(reason)}»`;
  await notify.toHrAndBoss(botOf(ctx), emp, text, {}, proof);
  if (proof) await notify.toArchive(botOf(ctx), text, proof);
};

// --- «⏰ Kech qolaman» — kelishdan oldin ---
const startLateNotice = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  if (employees.isBoss(emp)) return ctx.reply(BOSS_NO_ATT, ui.kbFor(ctx));
  if (await attendance.isCheckedIn(emp.id)) return ctx.reply('ℹ️ Siz bugun allaqachon kelgansiz.', ui.kbFor(ctx));
  session.set(ctx.from.id, { step: 'late_notice' });
  return ctx.reply(
    `⏰ <b>Kech qolyapsizmi?</b>\n\nSababini <b>yozing</b> yoki 🎥 <b>video</b> / 🎙 <b>audio</b> yuboring (izohni video ostiga yozsangiz ham bo'ladi).\nXabar ${esc(await org.recipientsLabel(emp))}ga boradi.\n\n<i>Kelganingizda «${ui.BTN.checkIn}» ni unutmang.</i>`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const handleLateNotice = async (ctx) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  const proof = ctx.message.text ? null : reasonProof(ctx.message);
  const reason = reasonOf(ctx, proof);
  if (!reason) return ctx.reply('Sabab yozing yoki video/audio yuboring.', ui.kbFor(ctx));
  const { inTime } = await flows.lateNotice(botOf(ctx), emp, reason, proof);
  activity.mark(ctx, 'late_notice', { title: reason, detail: inTime ? 'oldindan — kechikish hisoblanmaydi' : null });
  await ctx.reply(`📨 Xabaringiz ${esc(await org.recipientsLabel(emp))}ga yuborildi.${flows.lateNoticeRule(inTime)}\nKelganingizda «${ui.BTN.checkIn}» bosing.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  if (config.announceDone) await notify.toGroup(botOf(ctx), `⏰ ${reports.mentionHtml(emp)} bugun <b>kech qolishini</b> bildirdi.`);
};

const onLocation = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const s = session.get(ctx.from.id);

  if (s.step === 'awaiting_office_location') {
    if (!ctx.state.isAdmin) { session.clear(ctx.from.id); return; }
    if (!ctx.message.location) return;
    const radius = s.radius || office.DEFAULT_RADIUS;
    const { latitude, longitude } = ctx.message.location;
    session.clear(ctx.from.id);
    activity.mark(ctx, 'admin', { title: s.branchId ? 'Filial ofisi belgilandi' : 'Ofis joylashuvi belgilandi', detail: `radius ${radius} m` });
    if (s.branchId) {
      await branches.setOffice(s.branchId, latitude, longitude, radius);
      const b = await branches.byId(s.branchId);
      return ctx.reply(
        `✅ <b>«${esc(b.name)}» filiali ofisi saqlandi.</b> Radius: <b>${geo.prettyDistance(radius)}</b>.\nShu filialdagi ofis hodimlari endi faqat shu joydan «Keldim» qila oladi.`,
        { parse_mode: 'HTML', ...ui.kbFor(ctx) },
      );
    }
    await office.set(latitude, longitude, radius);
    return ctx.reply(
      `✅ <b>Ofis joylashuvi saqlandi.</b> Radius: <b>${geo.prettyDistance(radius)}</b>.\nEndi hodimlar faqat shu joydan «${ui.BTN.checkIn}» qila oladi.\n\nRadiusni o'zgartirish: <code>/ofis_radius 300</code>`,
      { parse_mode: 'HTML', ...ui.kbFor(ctx) },
    );
  }

  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  if (!ctx.message.location) return;
  if (s.step === 'awaiting_home_location') return field.onHomeLocation(ctx);
  if (s.step === 'visit_location') return field.onVisitLocation(ctx);
  if (s.step !== 'awaiting_checkin_location') return ctx.reply(`Avval «${ui.BTN.checkIn}» tugmasini bosing.`, ui.kbFor(ctx));

  if (field.isForwarded(ctx.message)) {
    activity.mark(ctx, 'checkin_far', { detail: 'forward qilingan joylashuv' });
    return ctx.reply(`❌ Bu joylashuv boshqa joydan yuborilgan. «${ui.BTN.sendLocation}» tugmasini bosing.`, ui.locationKeyboard());
  }
  const loc = ctx.message.location;
  // Qurilmaning joriy GPS'i odatda horizontal_accuracy bilan keladi; xaritadan tanlangan nuqtada u bo'lmaydi.
  // STRICT_GPS=1 — rad etiladi; aks holda qabul qilinadi, lekin tekshiruvchiga ⚠️ bilan boradi.
  const unverified = loc.horizontal_accuracy === undefined && loc.live_period === undefined;
  if (unverified && config.strictGps) {
    activity.mark(ctx, 'checkin_far', { detail: "aniqligi yo'q joylashuv (xaritadan tanlangan bo'lishi mumkin)" });
    return ctx.reply(`❌ Bu joylashuv qurilmaning joriy GPS'i emas (xaritadan tanlangan bo'lishi mumkin). Faqat «${ui.BTN.sendLocation}» tugmasini bosing.`, ui.locationKeyboard());
  }
  const flexible = employees.isFlexible(emp);
  let dist = null;
  let mode = 'office';

  if (employees.isField(emp)) {
    mode = 'field';
    const home = employees.homeOf(emp);
    if (!home) return field.askHome(ctx);
    dist = geo.distanceMeters(home.lat, home.lon, loc.latitude, loc.longitude);
    if (!flexible && dist < config.fieldMinDistanceM) {
      session.clear(ctx.from.id);
      activity.mark(ctx, 'checkin_far', { detail: `uydan ${geo.prettyDistance(dist)} (hudud rejimi)` });
      return ctx.reply(
        `❌ <b>Siz hali uyingizga yaqinsiz</b> (${geo.prettyDistance(dist)}). Ishga chiqqan hisoblanish uchun kamida <b>${geo.prettyDistance(config.fieldMinDistanceM)}</b> uzoqlashing va qaytadan «${ui.BTN.checkIn}» bosing.`,
        { parse_mode: 'HTML', ...ui.kbFor(ctx) },
      );
    }
  } else {
    const officeConf = await branches.officeFor(emp);
    if (officeConf) {
      dist = geo.distanceMeters(officeConf.lat, officeConf.lon, loc.latitude, loc.longitude);
      if (!flexible && dist > officeConf.radius) {
        session.clear(ctx.from.id);
        activity.mark(ctx, 'checkin_far', { detail: `ofisdan ${geo.prettyDistance(dist)}` });
        return ctx.reply(
          `❌ <b>Siz ofisdan uzoqdasiz</b> (${geo.prettyDistance(dist)}). Ruxsat: ${geo.prettyDistance(officeConf.radius)} · ${esc(officeConf.name)}.\nOfisga yetib borgach qaytadan «${ui.BTN.checkIn}» bosing.`,
          { parse_mode: 'HTML', ...ui.kbFor(ctx) },
        );
      }
    }
  }

  const pending = { lat: loc.latitude, lon: loc.longitude, dist, mode, at: time.stamp(), unverified };
  const required = employees.needsCheckinVideo(emp);
  if (!required && mode === 'office') return finishCheckIn(ctx, pending, null);

  session.set(ctx.from.id, { step: 'awaiting_checkin_video', pending, videoOptional: !required });
  return ctx.reply(
    `✅ Joylashuv qabul qilindi${dist != null ? ` (${mode === 'field' ? 'uydan' : 'ofisdan'} ${geo.prettyDistance(dist)})` : ''}.\n\n` +
      `🎥 Endi ${mode === 'field' ? 'ishga chiqqaningiz' : 'ishga kelganingiz'} haqida <b>qisqa video</b> yuboring (oddiy yoki dumaloq video).` +
      `${required ? '' : '\n<i>Video siz uchun ixtiyoriy.</i>'}\n⏳ ${VIDEO_WAIT_MIN} daqiqa ichida.`,
    { parse_mode: 'HTML', ...(required ? ui.cancelKeyboard() : ui.inline([[ui.cb('⏭ Videosiz qayd etish', 'ci:novideo')]])) },
  );
};

/** Keldim videosi */
const onCheckinVideo = async (ctx) => {
  const s = session.get(ctx.from.id);
  const proof = field.mediaProof(ctx.message, ['video', 'video_note']);
  if (!proof) return ctx.reply('🎥 Video kerak (oddiy yoki dumaloq). Rasm/audio qabul qilinmaydi.', ui.cancelKeyboard());
  proof.note = (ctx.message.caption || '').trim().slice(0, 300) || null;
  return finishCheckIn(ctx, s.pending, proof);
};

const finishCheckIn = async (ctx, pending, proof) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!pending) return ctx.reply(`Sessiya eskirgan — qaytadan «${ui.BTN.checkIn}» bosing.`, ui.kbFor(ctx));
  if (Date.now() - Date.parse(pending.at) > VIDEO_WAIT_MIN * 60000) {
    return ctx.reply(`⌛ Joylashuv eskirdi (${VIDEO_WAIT_MIN} daqiqadan oshdi). Qaytadan «${ui.BTN.checkIn}» bosing.`, ui.kbFor(ctx));
  }
  const res = await attendance.checkIn(emp, { ...pending, proof, note: proof && proof.note });
  if (res.already) return ctx.reply('ℹ️ Siz allaqachon kelgansiz.', ui.kbFor(ctx));

  const { dist, mode } = pending;
  const distText = dist != null ? ` · 📍 ${mode === 'field' ? 'uydan' : 'ofisdan'} ${geo.prettyDistance(dist)}` : '';
  const excusedLate = res.late > 0 && attendance.noticedInTime(res.row, emp);
  const isLate = res.late > 0 && !employees.isFlexible(emp) && !excusedLate;
  const open = await tasks.openFor(emp.id);
  activity.mark(ctx, 'checkin', { title: `Ishga keldi: ${time.clock(res.row.checked_in)}`, detail: `${dist != null ? `ofisdan ${geo.prettyDistance(dist)}` : ''}${isLate ? ` · ${time.prettyDuration(res.late)} kech` : ''}`.trim() || null });
  await ctx.reply(
    `✅ <b>Kelganingiz qayd etildi</b> — ${time.clock(res.row.checked_in)}${isLate ? ` ⏰ <i>${time.prettyDuration(res.late)} kech</i>` : ''}` +
      `${excusedLate ? ` ⏰ <i>${time.prettyDuration(res.late)} kech — oldindan ogohlantirgansiz, hisoblanmaydi ✅</i>` : ''}\n` +
      `<i>${time.prettyDate(time.today())}</i>${distText}${proof ? ' · 🎥 video' : ''}\n\n` +
      (open.length ? `📋 <b>Bugungi missiyalar (${open.length}):</b>\n${ui.taskList(open)}\n\nBajargach «${ui.BTN.done}» bilan belgilang.` : `📭 Hozircha ochiq missiya yo'q. «${ui.BTN.selfTask}» bilan reja yozing.`),
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );

  const line = `🟢 <b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''} ${mode === 'field' ? 'ishga chiqdi 🚶' : 'ishga keldi'} · ${time.clock(res.row.checked_in)}${reports.lateTag(res.row)}`;
  if (pending.unverified) activity.mark(ctx, 'checkin_far', { detail: "aniqligi yo'q joylashuv bilan keldi" });
  const warn = pending.unverified ? "\n⚠️ <i>Joylashuv aniqligi yo'q — xaritadan tanlangan bo'lishi mumkin, tekshirib ko'ring.</i>" : '';
  const text =
    line +
    (res.row.late_notice_at ? ` <i>(oldindan ogohlantirgan${excusedLate ? ` ${config.lateNoticeMinBefore} daq+ oldin — kechikish hisoblanmaydi` : ''}: «${esc(res.row.late_reason || '')}»)</i>` : '') +
    `${distText} · ${field.mapLink(pending.lat, pending.lon)}` + warn +
    (proof && proof.note ? `\n💬 «${esc(proof.note)}»` : '') +
    (open.length ? `\n📋 ochiq: ${open.length}${open.some((t) => t.due_date < time.today()) ? ' (🔴 kechikkan bor)' : ''}` : '');
  await notify.toReviewers(botOf(ctx), emp, text, {}, proof);
  await notify.toArchive(botOf(ctx), text, proof);
  if (config.announceDone) await notify.toGroup(botOf(ctx), `${line}${distText}${open.length ? `\n🎯 Bugungi missiyalari: ${open.length} ta` : ''}`);

  if (isLate && config.askLateReason && !res.row.late_reason) return askLateReason(ctx, res.late);
};

/** Keldim / tashrif / sabab bosqichidagi media. Boshqa bosqichda — keyingi handler (Bajardim isboti, kunlik hisobot) */
const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private' || !ctx.state.employee) return next();
  const s = session.get(ctx.from.id);
  if (s.step === 'awaiting_checkin_video') return onCheckinVideo(ctx);
  if (s.step === 'visit_proof') return field.onVisitProof(ctx);
  if (['absence_reason', 'late_notice', 'late_reason'].includes(s.step)) {
    if (!reasonProof(ctx.message)) return ctx.reply('Matn, video, dumaloq video, audio yoki rasm yuboring.', ui.cancelKeyboard());
    if (s.step === 'absence_reason') return handleAbsenceReason(ctx);
    if (s.step === 'late_notice') return handleLateNotice(ctx);
    return handleLateReason(ctx);
  }
  return next();
};

const onNoVideo = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (s.step !== 'awaiting_checkin_video' || !s.videoOptional || !ctx.state.employee) return ctx.answerCbQuery('Eskirgan tugma');
  await ctx.answerCbQuery();
  return finishCheckIn(ctx, s.pending, null);
};

// ---------------------------------------------------------------------------
// KETDIM
// ---------------------------------------------------------------------------

const doCheckOut = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  if (employees.isBoss(emp)) return ctx.reply(BOSS_NO_ATT, ui.kbFor(ctx));
  if (!(await attendance.isCheckedIn(emp.id))) return ctx.reply(`ℹ️ Bugun «${ui.BTN.checkIn}» qilmagansiz.`, ui.kbFor(ctx));
  if (await attendance.isCheckedOut(emp.id)) {
    const r = await attendance.get(emp.id);
    return ctx.reply(`ℹ️ Ketganingiz allaqachon belgilangan (${time.clock(r.checked_out)}).`, ui.kbFor(ctx));
  }
  const { row, worked, done, open } = await flows.checkOut(botOf(ctx), emp);
  activity.mark(ctx, 'checkout', { title: `Ishdan ketdi: ${time.clock(row.checked_out)}`, detail: `${done.length} ta bajarildi, ${open.length} ta qoldi` });
  await ctx.reply(
    `🏁 <b>Ish kuni yakunlandi</b> — ${time.clock(row.checked_out)}${worked !== null ? ` · ⏱ ${time.prettyDuration(worked)}` : ''}\n\n` +
      `✅ Bugun bajardingiz: <b>${done.length}</b> ta\n` +
      (open.length ? `⏳ Ochiq qoldi (${open.length}) — ertangi ro'yxatda turadi:\n${ui.taskList(open)}` : `🎉 Ochiq missiya qolmadi. Barakalla!`),
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );
  if (config.announceDone) {
    await notify.toGroup(botOf(ctx), `🏁 <b>${esc(emp.full_name)}</b> ketdi · ${time.clock(row.checked_out)}${worked !== null ? ` · ⏱ ${time.prettyDuration(worked)}` : ''} · ✅ ${done.length} · ⏳ ${open.length}`);
  }

  // Kunlik hisobot hali topshirilmagan bo'lsa — hozir so'raymiz
  if (config.dailyReportRequired && !(await dailyReports.get(emp.id))) {
    return require('./dailyReport').askReport(ctx, { afterCheckout: true });
  }
};

// ---------------------------------------------------------------------------
// KELMAYMAN (sababli kun so'rovi)
// ---------------------------------------------------------------------------

const startAbsence = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  if (employees.isBoss(emp)) return ctx.reply(BOSS_NO_ATT, ui.kbFor(ctx));
  if (await attendance.isCheckedIn(emp.id)) return ctx.reply('ℹ️ Siz bugun allaqachon kelgansiz.', ui.kbFor(ctx));
  const row = await attendance.get(emp.id);
  if (row && row.excuse_status === 'approved') return ctx.reply('ℹ️ Bugungi kun allaqachon sababli deb belgilangan.', ui.kbFor(ctx));
  session.set(ctx.from.id, { step: 'absence_reason' });
  return ctx.reply(
    `🙋 <b>Bugun (${time.prettyDate(time.today())}) kelmaslik sababini yozing</b> yoki 🎥 video / 🎙 audio / 🖼 rasm (masalan, shifokor qog'ozi) yuboring.\nMasalan: kasal bo'ldim, ta'til, komandirovka, oilaviy sabab.\n\nXabar ${esc(await org.recipientsLabel(emp))}ga boradi. Tasdiqlansa — kun sababli hisoblanadi (KPI ga ta'sir qilmaydi).`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const handleAbsenceReason = async (ctx) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  const proof = ctx.message.text ? null : reasonProof(ctx.message);
  const reason = reasonOf(ctx, proof);
  activity.mark(ctx, 'absence', { title: reason });
  if (employees.isTop(emp)) {
    await flows.requestAbsence(botOf(ctx), emp, reason, proof);
    return ctx.reply(`✅ Bugun <b>sababli</b> deb belgilandi: «${esc(reason)}». Rahbariyatga xabar berildi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  }
  await ctx.reply(`📨 So'rov ${esc(await org.recipientsLabel(emp))}ga yuborildi: «${esc(reason)}». Ko'rib chiqiladi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  await flows.requestAbsence(botOf(ctx), emp, reason, proof);
};

const onExcuseDecision = async (ctx) => {
  const [, verdict, id] = ctx.match;
  const row = await attendance.byId(id);
  if (!row) return ctx.answerCbQuery('Topilmadi');
  const emp = await employees.byId(row.employee_id);
  if (!access.canDecideExcuse(ctx.state.actor, emp)) {
    return ctx.answerCbQuery('⛔️ Sababli kunni faqat direktor yoki HR tasdiqlaydi', { show_alert: true });
  }
  const status = verdict === 'ok' ? 'approved' : 'rejected';
  await flows.decideExcuse(botOf(ctx), emp, row.work_date, status, ctx.from.id);
  await ctx.answerCbQuery(status === 'approved' ? 'Sababli' : 'Sababsiz');
  const verdictText = `${status === 'approved' ? '✅ Sababli' : '❌ Sababsiz'} — <b>${esc(emp.full_name)}</b>, ${time.prettyDate(row.work_date)}${row.excuse_reason ? `\n«${esc(row.excuse_reason)}»` : ''}\n<i>qaror: ${esc(org.actorName(ctx))}</i>`;
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  if (msg && (msg.photo || msg.video || msg.voice || msg.audio || msg.document)) await ctx.editMessageCaption(verdictText, { parse_mode: 'HTML' }).catch(() => ctx.reply(verdictText, { parse_mode: 'HTML' }));
  else await render(ctx, verdictText);
};

// ---------------------------------------------------------------------------
// "ISHGA KELYAPSIZMI?" (ertalabki so'rov, cron)
// ---------------------------------------------------------------------------

const onIntent = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("Ro'yxatda yo'qsiz");
  const answer = ctx.match[1];
  if (await attendance.isCheckedIn(emp.id)) { await ctx.answerCbQuery('Siz allaqachon kelgansiz'); return render(ctx, '✅ Siz allaqachon ishga kelgansiz.'); }
  await attendance.setIntent(emp.id, answer);
  activity.mark(ctx, answer === 'yes' ? 'intent_yes' : 'intent_no');
  await ctx.answerCbQuery(answer === 'yes' ? 'Rahmat!' : 'Qabul qilindi');
  if (answer === 'yes') return render(ctx, `✅ <b>Yaxshi, kutamiz!</b>\n\nIshga kelganingizda «${ui.BTN.checkIn}» tugmasini bosib, joylashuvingizni yuboring.`);
  await render(ctx, `Tushunarli, ma'lumot uchun rahmat.\n\n<i>Sababli kun bo'lishi uchun «${ui.BTN.absence}» tugmasi orqali sababini yozing — boshliq tasdiqlaydi.</i>`);
  await notify.toReviewers(botOf(ctx), emp, `🙅 <b>${esc(emp.full_name)}</b> bugun ishga <b>kelmasligini</b> bildirdi.`);
  if (config.announceDone) await notify.toGroup(botOf(ctx), `🔴 ${reports.mentionHtml(emp)} <b>bugun ishga kelmasligini</b> bildirdi.`);
};

/** Bekor qilish — istalgan matn/joylashuv bosqichini to'xtatadi */
const cancelStep = async (ctx) => {
  session.clear(ctx.from.id);
  if (!ctx.state.employee && !ctx.state.isAdmin) return ctx.reply('Bekor qilindi.', { reply_markup: { remove_keyboard: true } });
  return ctx.reply('Bekor qilindi.', ui.kbFor(ctx));
};

const register = (bot) => {
  bot.hears(ui.BTN.checkIn, doCheckIn);
  bot.command(['keldim', 'ishga_keldim'], doCheckIn);
  bot.hears(ui.BTN.checkOut, doCheckOut);
  bot.command(['ketdim', 'ishdan_ketdim'], doCheckOut);
  bot.hears(ui.BTN.absence, startAbsence);
  bot.hears(ui.BTN.late, startLateNotice);
  bot.command('kech', startLateNotice);
  bot.command('kelmayman', startAbsence);
  bot.hears(ui.BTN.cancel, cancelStep);
  bot.on('location', onLocation);
  bot.on(['video', 'video_note', 'voice', 'audio', 'photo', 'document'], onMedia);
  bot.action('ci:novideo', onNoVideo);
  bot.action(/^ab:(ok|no):(\d+)$/, onExcuseDecision);
  bot.action(/^intent:(yes|no)$/, onIntent);
};

module.exports = { register, onLocation, handleLateReason, handleAbsenceReason, handleLateNotice, cancelStep };
