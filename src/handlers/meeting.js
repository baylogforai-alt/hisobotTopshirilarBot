'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const meetings = require('../services/meetings');
const tasks = require('../services/tasks');
const notify = require('../services/notify');
const flows = require('../services/flows');
const picker = require('./picker');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * «🗓 Majlis» — boshliq/direktor va HR: kimga (hammaga / bo'lim(lar)ga / tanlab) → sana → soat → mavzu (matn yoki media) → yuborish.
 * Hodimda: «✅ Boraman · ⏰ Kech qolaman · 🙋 Kelmayman»; kech qolaman / kelmayman — sabab majburiy (matn yoki ovoz/video/rasm)
 * → yozgan odam, boshliq va HR ga. 30 daqiqa oldin eslatma (flows.remindMeetings, cron meeting-remind).
 *   mt:start · mt:all · mt:dl, mt:dt:<deptId>, mt:dok · mp:* (tanlash, picker) · mt:d:<0|1|2|type> · mt:t:<HHMM|type> · mt:send · mt:x
 *   mt:st:<id> (kim keladi) · mt:re:<id> (javob bermaganlarga) · mt:pf:<id>:<empId> (sabab media) · mt:del/delok:<id> (bekor) · mt:h (majlislar)
 *   mr:<id>:<yes|late|no> (hodim javobi) · bosqichlar meeting_date, meeting_time, meeting_text, meeting_confirm, meeting_reason
 */

const canMeet = (ctx) => Boolean(ctx.state.isAdmin || ctx.state.isHr);

const deny = (ctx) => (ctx.updateType === 'callback_query'
  ? ctx.answerCbQuery('⛔️ Majlis — faqat boshliq va HR uchun')
  : ctx.reply('⛔️ Majlis yozish — faqat boshliq va HR uchun.'));

const ICON = { yes: '✅', late: '⏰', no: '🙋' };

/** Hodim: kelayotgan majlislarim (tugmalar bilan) */
const myMeetings = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return deny(ctx);
  const list = await meetings.upcomingFor(emp.id);
  if (!list.length) return ctx.reply("🗓 Sizni chaqirilgan kelayotgan majlis yo'q.", ui.kbFor(ctx));
  for (const m of list.slice(0, 5)) {
    const mine = m.answer ? `\n${ui.LINE}\nSizning javobingiz: <b>${meetings.ANSWER_LABEL[m.answer]}</b>${m.reason ? ` — «${esc(m.reason)}»` : ''}` : '';
    await ctx.reply(`${flows.meetingText(m)}${mine}`, { parse_mode: 'HTML', ...flows.meetingKb(m, m.answer || null) });
  }
  return undefined;
};

const start = async (ctx) => {
  if (!canMeet(ctx)) return myMeetings(ctx);
  session.clear(ctx.from.id);
  const all = await picker.managedCandidates(ctx);
  return render(
    ctx,
    "🗓 <b>MAJLIS</b>\n\nKimlarni chaqiramiz?\n<i>Keyin sana, soat va mavzu so'raladi. Har bir hodim «✅ Boraman / ⏰ Kech qolaman / 🙋 Kelmayman» tugmasini bosadi " +
      "(kech qolsa yoki kelmasa — sababini yozadi). Majlisdan 30 daqiqa oldin bot eslatadi.</i>",
    inline([
      [cb(`👥 Hammaga (${all.length})`, 'mt:all')], [cb("🏢 Bo'lim(lar)ga", 'mt:dl')], [cb('☑️ Hodimlarni tanlash (1, 2, 3…)', 'mt:pick')],
      [cb('📜 Majlislar', 'mt:h'), cb(ui.BTN.cancel, 'mt:x')],
    ]),
  );
};

// --- bo'limlar ---
const deptList = async (ctx) => {
  const sel = new Set((session.get(ctx.from.id).meetDepts || []).map(Number));
  const all = await picker.managedCandidates(ctx);
  const rows = [];
  for (const d of await departments.listActive()) {
    const n = all.filter((e) => Number(e.department_id) === Number(d.id)).length;
    if (n) rows.push([cb(`${sel.has(Number(d.id)) ? '✅' : '▫️'} 🏢 ${d.name} (${n})`.slice(0, 50), `mt:dt:${d.id}`)]);
  }
  const loose = all.filter((e) => !e.department_id).length;
  if (loose) rows.push([cb(`${sel.has(0) ? '✅' : '▫️'} 👤 Bo'limsizlar (${loose})`.slice(0, 50), 'mt:dt:0')]);
  if (!rows.length) return render(ctx, "Hodimli bo'lim yo'q.", ui.backKeyboard('mt:start'));
  rows.push([cb(sel.size ? `➡️ Davom etish (${sel.size} ta)` : '➡️ Davom etish', 'mt:dok'), cb('⬅️ Orqaga', 'mt:start')]);
  return render(ctx, "🏢 <b>Qaysi bo'limlarni chaqiramiz?</b> Bir nechtasini belgilash mumkin.", inline(rows));
};

const peoplePick = picker.create({
  prefix: 'mp',
  allowed: canMeet,
  candidates: picker.managedCandidates,
  backData: 'mt:start',
  title: (ctx, n) => `🗓 <b>Kimlarni majlisga chaqiramiz?</b>${n ? ` — belgilandi: <b>${n}</b>` : ''}`,
  onDone: async (ctx, ids) => {
    const list = [];
    for (const empId of ids) list.push(await employees.byId(empId));
    return askDate(ctx, ids, ids.length === 1 ? list[0].full_name : `Tanlanganlar: ${list.map((e) => e.full_name).join(', ')}`.slice(0, 300));
  },
});

// --- sana → soat → mavzu ---
const askDate = (ctx, ids, target) => {
  session.set(ctx.from.id, { step: 'meeting_date_pick', meet: { ids, target }, pick: null, pickFor: null, meetDepts: null });
  return render(ctx, `🗓 Kimga: <b>${esc(target)}</b> — ${ids.length} kishi.\n\n📅 <b>Majlis qaysi kuni?</b>`, inline([
    [cb('📅 Bugun', 'mt:d:0'), cb('☀️ Ertaga', 'mt:d:1'), cb('Indinga', 'mt:d:2')],
    [cb('📆 Sana yozish', 'mt:d:type')],
    [cb(ui.BTN.cancel, 'mt:x')],
  ]));
};

const SLOTS = ['08:00', '09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
const askTime = (ctx, date) => {
  const s = session.get(ctx.from.id);
  session.set(ctx.from.id, { step: 'meeting_time_pick', meet: { ...s.meet, date } });
  const slots = SLOTS.filter((t) => !tasks.startPassed(date, t));
  const rows = [];
  for (let i = 0; i < slots.length; i += 3) rows.push(slots.slice(i, i + 3).map((t) => cb(`🕘 ${t}`, `mt:t:${t.replace(':', '')}`)));
  rows.push([cb('✍️ Soatni yozish (masalan 14:30)', 'mt:t:type')]);
  rows.push([cb(ui.BTN.cancel, 'mt:x')]);
  return render(ctx, `📅 ${time.prettyDate(date)}\n\n⏰ <b>Majlis soat nechida?</b>`, inline(rows));
};

const askText = async (ctx, hhmm) => {
  const s = session.get(ctx.from.id);
  session.set(ctx.from.id, { step: 'meeting_text', meet: { ...s.meet, hhmm } });
  await render(ctx, `🗓 ${time.prettyDate(s.meet.date)}, <b>${hhmm}</b> · ${esc(s.meet.target)} — ${s.meet.ids.length} kishi`);
  return ctx.reply('✍️ Majlis mavzusini yozing — yoki 🎤 ovozli xabar, 🎥 video, 📄 fayl yuboring (izohi — mavzu):', ui.cancelKeyboard());
};

const stale = (ctx) => { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan. «🗓 Majlis» ni qaytadan bosing.', ui.kbFor(ctx)); };

const handleDateText = (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.meet || !Array.isArray(s.meet.ids)) return stale(ctx);
  const d = time.parseDate(ctx.message.text);
  if (!d) return ctx.reply('Sana tushunilmadi. Masalan: 14.10 yoki 14-oktabr', ui.cancelKeyboard());
  if (d < time.today()) return ctx.reply("O'tgan sana bo'lmaydi. Qaytadan yozing:", ui.cancelKeyboard());
  return askTime(ctx, d);
};

const handleTimeText = (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.meet || !s.meet.date) return stale(ctx);
  const t = tasks.normTime(ctx.message.text);
  if (!t) return ctx.reply('Soat tushunilmadi. Masalan: 09:30 yoki 14:00', ui.cancelKeyboard());
  if (tasks.startPassed(s.meet.date, t)) return ctx.reply("Bu soat o'tib ketgan. Boshqa soat yozing:", ui.cancelKeyboard());
  return askText(ctx, t);
};

const preview = async (ctx, body, media) => {
  const s = session.get(ctx.from.id);
  if (!s.meet || !s.meet.hhmm) return stale(ctx);
  session.set(ctx.from.id, { step: 'meeting_confirm', meet: { ...s.meet, body, media } });
  const draft = { meet_date: s.meet.date, meet_time: s.meet.hhmm, sender_name: ctx.state.actor.name, body };
  const left = meetings.minutesLeft(draft);
  const mediaLine = media ? `\n${ui.MEDIA_ICON[media.type] || '📎'} ${media.type === 'document' && media.fileName ? esc(media.fileName) : 'media biriktirilgan'}` : '';
  await ctx.reply('👇 Tekshiring:', { reply_markup: { remove_keyboard: true } });
  return ctx.reply(
    `${flows.meetingText(draft)}${mediaLine}\n${ui.LINE}\n👥 Kimga: <b>${esc(s.meet.target)}</b> — ${s.meet.ids.length} kishi\n` +
      (left > meetings.REMIND_BEFORE_MIN ? `⏰ ${meetings.REMIND_BEFORE_MIN} daqiqa oldin eslatma boradi.` : '<i>Majlisgacha 30 daqiqadan kam — eslatma bormaydi.</i>'),
    { parse_mode: 'HTML', ...inline([[cb(`📤 Yuborish (${s.meet.ids.length})`, 'mt:send'), cb(ui.BTN.cancel, 'mt:x')]]) },
  );
};

const handleText = (ctx) => {
  const body = String(ctx.message.text || '').trim().slice(0, 2000);
  if (!body) return ctx.reply("Matn bo'sh. Qaytadan yozing:", ui.cancelKeyboard());
  return preview(ctx, body, null);
};

const mediaOf = (m) => {
  if (m.voice) return { type: 'voice', fileId: m.voice.file_id };
  if (m.video) return { type: 'video', fileId: m.video.file_id };
  if (m.video_note) return { type: 'video_note', fileId: m.video_note.file_id };
  if (m.audio) return { type: 'audio', fileId: m.audio.file_id, fileName: m.audio.file_name || null };
  if (m.photo && m.photo.length) return { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  if (m.document) return { type: 'document', fileId: m.document.file_id, fileName: m.document.file_name || null };
  return null;
};

const doSend = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (s.step !== 'meeting_confirm' || !s.meet) return ctx.answerCbQuery('Eskirgan tugma');
  session.clear(ctx.from.id); // birinchi await dan oldin — majlis ikki marta yuborilmasin
  await ctx.answerCbQuery('Yuborilmoqda…');
  if (tasks.startPassed(s.meet.date, s.meet.hhmm)) return render(ctx, "⚠️ Majlis vaqti o'tib ketdi — qaytadan yozing.");
  const allowed = new Map((await picker.managedCandidates(ctx)).map((e) => [Number(e.id), e]));
  const targets = s.meet.ids.map(Number).filter((id) => allowed.has(id)).map((id) => allowed.get(id));
  if (!targets.length) return render(ctx, 'Qabul qiluvchi topilmadi.');
  await render(ctx, `⏳ ${targets.length} kishiga yuborilmoqda…`);
  const r = await flows.sendMeeting(botOf(ctx), ctx.state.actor, targets, {
    body: s.meet.body || null, media: s.meet.media || null, date: s.meet.date, hhmm: s.meet.hhmm, target: s.meet.target,
  });
  await render(
    ctx,
    `✅ <b>Majlis yuborildi</b> — ${r.delivered}/${r.total} kishiga${r.delivered < r.total ? `\n⚠️ ${r.total - r.delivered} kishiga yetmadi (botni bloklagan yoki hech ochmagan)` : ''}.\n` +
      "Kech qolaman / kelmayman sabablari sizga, boshliq va HR ga keladi. Kim kelishini kuzatib boring:",
    inline([[cb('👥 Kim keladi', `mt:st:${r.meeting.id}`)]]),
  );
  return ctx.reply('👌', ui.kbFor(ctx));
};

// --- holat, tarix ---
const day = (iso) => (String(iso).slice(0, 10) === time.today() ? time.clock(iso) : `${time.prettyDate(String(iso).slice(0, 10))} ${time.clock(iso)}`);

const status = async (ctx, id, { answered = false } = {}) => {
  const m = await meetings.byId(id);
  if (!m || !canMeet(ctx)) return answered ? null : ctx.answerCbQuery('Topilmadi');
  if (!answered) await ctx.answerCbQuery();
  const list = await meetings.members(m.id);
  const c = await meetings.counts(m.id);
  const line = (r) => `${ICON[r.answer]} ${esc(r.full_name)}${r.reason ? ` — «${esc(r.reason)}»` : ''}${r.proof_file_id ? ` ${ui.MEDIA_ICON[r.proof_type] || '📎'}` : ''} · ${day(r.answered_at)}`;
  const groups = [
    ...list.filter((r) => r.answer === 'late').map(line),
    ...list.filter((r) => r.answer === 'no').map(line),
    ...list.filter((r) => r.answer === 'yes').map(line),
    ...list.filter((r) => !r.answer).map((r) => `${Number(r.delivered) ? '❔' : '🚫'} ${esc(r.full_name)}${Number(r.delivered) ? '' : ' — yetmadi'}`),
  ];
  const live = !m.cancelled_at && !meetings.isOver(m);
  const rows = list.filter((r) => r.proof_file_id).slice(0, 8).map((r) => [cb(`${ui.MEDIA_ICON[r.proof_type] || '📎'} ${r.full_name} — sababi`.slice(0, 50), `mt:pf:${m.id}:${r.employee_id}`)]);
  if (live && c.none) rows.push([cb(`🔔 Javob bermaganlarga qayta yuborish (${c.none})`, `mt:re:${m.id}`)]);
  if (live) rows.push([cb('🗑 Majlisni bekor qilish', `mt:del:${m.id}`)]);
  rows.push([cb('🔄 Yangilash', `mt:st:${m.id}`), cb('📜 Majlislar', 'mt:h')]);
  return render(
    ctx,
    `${flows.meetingText(m, m.cancelled_at ? '🚫 <b>MAJLIS (bekor qilingan)</b>' : '🗓 <b>MAJLIS</b>')}\n👥 ${esc(m.target || '')}\n${ui.LINE}\n` +
      `${flows.meetingSummary(c)}\n\n${groups.join('\n') || "<i>qatnashchi yo'q</i>"}`,
    inline(rows),
  );
};

const history = async (ctx) => {
  if (!canMeet(ctx)) return deny(ctx);
  // 17-okt: boshliq/direktor — faqat o'zi yozgani; HR — hammasi
  const list = await meetings.list({ limit: 15, senderTg: ctx.state.isAdmin && config.bossOwnLists ? ctx.from.id : null });
  if (!list.length) return render(ctx, "📜 Hali majlis yozilmagan.", inline([[cb('🗓 Yangi majlis', 'mt:start')]]));
  const rows = list.map((m) => [cb(
    `${m.cancelled_at ? '🚫 ' : ''}${m.meet_date.slice(8, 10)}.${m.meet_date.slice(5, 7)} ${m.meet_time} · ✅${m.yes} ⏰${m.late} 🙋${m.no} ❔${m.none} · ${(m.body || ui.MEDIA_LABEL[m.media_type] || 'media').replace(/\s+/g, ' ')}`.slice(0, 60),
    `mt:st:${m.id}`,
  )]);
  rows.push([cb('🗓 Yangi majlis', 'mt:start')]);
  return render(ctx, `📜 <b>Majlislar</b> — oxirgi ${list.length} ta:`, inline(rows));
};

// --- hodim javobi ---
const onAnswer = async (ctx, id, ans) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery('⛔️');
  const m = await meetings.byId(id);
  if (!m || !(await meetings.member(m.id, emp.id))) return ctx.answerCbQuery('Topilmadi');
  if (m.cancelled_at) return ctx.answerCbQuery('🚫 Majlis bekor qilingan', { show_alert: true });
  if (meetings.isOver(m)) return ctx.answerCbQuery("Majlis kuni o'tib ketgan", { show_alert: true });
  if (ans === 'yes') {
    const r = await flows.answerMeeting(botOf(ctx), emp, m, 'yes');
    if (!r.ok) return ctx.answerCbQuery(r.error, { show_alert: true });
    await ctx.answerCbQuery('✅ Belgilandi — kutib qolamiz');
    try { await ctx.editMessageReplyMarkup(flows.meetingKb(m, 'yes').reply_markup); } catch { /* o'zgarmagan */ }
    return undefined;
  }
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step: 'meeting_reason', meetAnswer: { id: Number(m.id), ans } });
  return ctx.reply(
    `${ans === 'late' ? '⏰ <b>Majlisga kech qolasizmi?</b>' : '🙋 <b>Majlisga kela olmaysizmi?</b>'} (${flows.meetingWhen(m)})\n\n` +
      "Sababini yozing yoki 🎤 ovozli xabar / 🎥 video yuboring — <b>majburiy</b>. Majlisni yozgan odam, boshliq va HR ko'radi.",
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const REASON_MEDIA = (m) => {
  if (m.voice) return { type: 'voice', fileId: m.voice.file_id };
  if (m.video) return { type: 'video', fileId: m.video.file_id };
  if (m.video_note) return { type: 'video_note', fileId: m.video_note.file_id };
  if (m.audio) return { type: 'audio', fileId: m.audio.file_id };
  if (m.photo && m.photo.length) return { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  return null;
};

/** meeting_reason bosqichi — matn (STEP_HANDLERS) yoki media (onMedia) */
const handleReason = async (ctx) => {
  const emp = ctx.state.employee;
  const s = session.get(ctx.from.id);
  if (!emp || !s.meetAnswer) return stale(ctx);
  const msg = ctx.message;
  const proof = msg.text ? null : REASON_MEDIA(msg);
  const typed = String(msg.text || msg.caption || '').trim().slice(0, 300);
  const reason = typed || (proof ? `(${require('../services/visits').proofLabel(proof.type).replace(/^\S+\s/, '')})` : '');
  if (!reason) return ctx.reply('✍️ Sababini yozing yoki ovozli xabar / video yuboring:', ui.cancelKeyboard());
  session.clear(ctx.from.id);
  const m = await meetings.byId(s.meetAnswer.id);
  const r = await flows.answerMeeting(botOf(ctx), emp, m, s.meetAnswer.ans, { reason, proof });
  if (!r.ok) return ctx.reply(`⚠️ ${r.error}`, ui.kbFor(ctx));
  return ctx.reply(
    `✅ Yuborildi: <b>${meetings.ANSWER_LABEL[s.meetAnswer.ans]}</b> — «${esc(reason)}»\n<i>Fikringiz o'zgarsa — majlis xabaridagi tugmani qayta bosing.</i>`,
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );
};

const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const step = session.get(ctx.from.id).step;
  if (step === 'meeting_reason' && ctx.state.employee) {
    if (!REASON_MEDIA(ctx.message)) return ctx.reply('Matn, ovozli xabar, video yoki rasm yuboring.', ui.cancelKeyboard());
    return handleReason(ctx);
  }
  if (step === 'meeting_text' && canMeet(ctx)) {
    const media = mediaOf(ctx.message);
    if (!media) return ctx.reply('Matn, ovozli xabar, video, rasm yoki fayl yuboring.', ui.cancelKeyboard());
    return preview(ctx, String(ctx.message.caption || '').trim().slice(0, 900) || null, media);
  }
  return next();
};

const register = (bot) => {
  bot.hears(ui.BTN.meeting, start);
  bot.command('majlis', start);
  bot.action('mt:start', async (ctx) => { await ctx.answerCbQuery(); return canMeet(ctx) ? start(ctx) : deny(ctx); });
  bot.action('mt:all', async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    const list = await picker.managedCandidates(ctx);
    if (!list.length) return render(ctx, "Hodim yo'q.", ui.backKeyboard('mt:start'));
    return askDate(ctx, list.map((e) => Number(e.id)), 'Hammaga');
  });
  bot.action('mt:dl', async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { meetDepts: [] });
    return deptList(ctx);
  });
  bot.action(/^mt:dt:(\d+)$/, async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const id = Number(ctx.match[1]);
    const cur = (session.get(ctx.from.id).meetDepts || []).map(Number);
    session.set(ctx.from.id, { meetDepts: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    await ctx.answerCbQuery();
    return deptList(ctx);
  });
  bot.action('mt:dok', async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const sel = (session.get(ctx.from.id).meetDepts || []).map(Number);
    if (!sel.length) return ctx.answerCbQuery("Kamida bitta bo'limni belgilang", { show_alert: true });
    await ctx.answerCbQuery();
    const all = await picker.managedCandidates(ctx);
    const ids = all.filter((e) => sel.includes(Number(e.department_id || 0))).map((e) => Number(e.id));
    const names = (await departments.listActive()).filter((d) => sel.includes(Number(d.id))).map((d) => d.name);
    if (sel.includes(0)) names.push("bo'limsizlar");
    if (!ids.length) return render(ctx, "Tanlangan bo'limlarda hodim yo'q.", ui.backKeyboard('mt:dl'));
    return askDate(ctx, ids, `Bo'lim${names.length > 1 ? 'lar' : ''}: ${names.join(', ')}`);
  });
  bot.action('mt:pick', async (ctx) => { if (!canMeet(ctx)) return deny(ctx); await ctx.answerCbQuery(); return peoplePick.show(ctx, { reset: true }); });
  peoplePick.register(bot);
  bot.action(/^mt:d:(0|1|2|type)$/, async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    if (s.step !== 'meeting_date_pick' || !s.meet) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') {
      session.set(ctx.from.id, { step: 'meeting_date' });
      await render(ctx, '📆 Majlis sanasi:');
      return ctx.reply('Sanani yozing. Masalan: 14.10 yoki 14-oktabr', ui.cancelKeyboard());
    }
    return askTime(ctx, time.addDays(time.today(), Number(ctx.match[1])));
  });
  bot.action(/^mt:t:(\d{4}|type)$/, async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    if (s.step !== 'meeting_time_pick' || !s.meet || !s.meet.date) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') {
      session.set(ctx.from.id, { step: 'meeting_time' });
      await render(ctx, `📅 ${time.prettyDate(s.meet.date)} — ⏰ soat:`);
      return ctx.reply('Soatni yozing. Masalan: 09:30 yoki 14:00', ui.cancelKeyboard());
    }
    const t = `${ctx.match[1].slice(0, 2)}:${ctx.match[1].slice(2)}`;
    if (tasks.startPassed(s.meet.date, t)) return askTime(ctx, s.meet.date);
    return askText(ctx, t);
  });
  bot.action('mt:send', (ctx) => (canMeet(ctx) ? doSend(ctx) : deny(ctx)));
  bot.action('mt:x', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); await render(ctx, '❌ Bekor qilindi.'); return ctx.reply('👌', ui.kbFor(ctx)); });
  bot.action('mt:h', async (ctx) => { await ctx.answerCbQuery(); return history(ctx); });
  bot.action(/^mt:st:(\d+)$/, (ctx) => status(ctx, ctx.match[1]));
  bot.action(/^mt:re:(\d+)$/, async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const m = await meetings.byId(ctx.match[1]);
    if (!m || m.cancelled_at || meetings.isOver(m)) return ctx.answerCbQuery('Majlis tugagan yoki bekor qilingan');
    await ctx.answerCbQuery('Yuborilmoqda…');
    const n = await flows.resendMeeting(botOf(ctx), m);
    await ctx.reply(`🔔 Qayta yuborildi: ${n} kishiga.`);
    return status(ctx, m.id, { answered: true });
  });
  bot.action(/^mt:pf:(\d+):(\d+)$/, async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const r = await meetings.member(ctx.match[1], ctx.match[2]);
    if (!r || !r.proof_file_id) return ctx.answerCbQuery('Topilmadi');
    await ctx.answerCbQuery();
    const e = await employees.byId(r.employee_id);
    return notify.sendProof(botOf(ctx), ctx.from.id, { type: r.proof_type, fileId: r.proof_file_id },
      `${ICON[r.answer] || ''} <b>${esc(e ? e.full_name : '')}</b> — «${esc(r.reason || '')}»`);
  });
  bot.action(/^mt:del:(\d+)$/, async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const m = await meetings.byId(ctx.match[1]);
    if (!m || m.cancelled_at) return ctx.answerCbQuery('Allaqachon bekor qilingan');
    await ctx.answerCbQuery();
    return render(ctx, `🗑 <b>Majlis bekor qilinsinmi?</b>\n${flows.meetingWhen(m)}${m.body ? ` · ${esc(m.body.slice(0, 100))}` : ''}\n\n<i>Hamma qatnashchiga «majlis bekor qilindi» xabari boradi. Yozuv bazada qoladi.</i>`,
      ui.confirmKeyboard(`mt:delok:${m.id}`, `mt:st:${m.id}`, '🗑 Ha, bekor qilish'));
  });
  bot.action(/^mt:delok:(\d+)$/, async (ctx) => {
    if (!canMeet(ctx)) return deny(ctx);
    const m = await meetings.byId(ctx.match[1]);
    if (!m) return ctx.answerCbQuery('Topilmadi');
    const ok = await flows.cancelMeeting(botOf(ctx), m, ctx.state.actor);
    await ctx.answerCbQuery(ok ? '🚫 Bekor qilindi' : 'Allaqachon bekor qilingan');
    return status(ctx, m.id, { answered: true });
  });
  bot.action(/^mr:(\d+):(yes|late|no)$/, (ctx) => onAnswer(ctx, ctx.match[1], ctx.match[2]));
  bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], onMedia);
};

module.exports = { register, start, handleDateText, handleTimeText, handleText, handleReason };
