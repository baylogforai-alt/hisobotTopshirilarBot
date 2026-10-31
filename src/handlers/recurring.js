'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const recurring = require('../services/recurring');
const tasks = require('../services/tasks');
const notify = require('../services/notify');
const flows = require('../services/flows');
const picker = require('./picker');

const { DateTime } = require('luxon');

const { esc, cb, inline } = ui;

/**
 * «📆 Davriy eslatma» — boshliq/direktor va HR: har kun (ish kunlari + soat), har oy (kun + soat) yoki har hafta (kun(lar) + soat) hodim(lar)ga
 * eslatma (e'lon, «👀 Tanishdim») yoki topshiriq (har safar yangi, muddat bilan). Yuborish — flows.runRecurring (cron recurring-run).
 *   dv:start · dv:k:<remind|task> · dq:* (tanlash, picker) · dv:f:<day|month|week> · dv:md:<0-31> · dv:wd:<1-7>, dv:wok
 *   dv:t:<HHMM|type> · dv:o:<0|1|3|7> (topshiriq muddati) · dv:save · dv:x
 *   dv:l (ro'yxat) · dv:v:<id> (kartochka) · dv:m:<id> (media) · dv:p/r:<id> (to'xtatish / davom) · dv:del/delok:<id> (bekor)
 *   bosqichlar rec_pick (inline), rec_time, rec_text, rec_title, rec_confirm
 *   rq:<will|no>:<taskId> — davriy topshiriq hali bajarilmagan: «⏳ Bajaraman» / «❌ Yo'q» (flows.askRecurringTasks savoliga javob)
 */

const canRec = (ctx) => Boolean(ctx.state.isAdmin || ctx.state.isHr);

const deny = (ctx) => (ctx.updateType === 'callback_query'
  ? ctx.answerCbQuery('⛔️ Davriy eslatma — faqat boshliq va HR uchun')
  : ctx.reply('⛔️ Davriy eslatma — faqat boshliq va HR uchun.', ui.kbFor(ctx)));

const KIND_HEAD = { remind: '📨 <b>DAVRIY ESLATMA</b>', task: '📌 <b>DAVRIY TOPSHIRIQ</b>' };
const KIND_ICON = { remind: '📨', task: '📌' };
const DUE_LABEL = { 0: "o'sha kuni", 1: '1 kun ichida', 3: '3 kun ichida', 7: '7 kun ichida' };
const SLOTS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

const stale = (ctx) => { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan. «📆 Davriy eslatma» ni qaytadan bosing.', ui.kbFor(ctx)); };
const rec = (ctx) => session.get(ctx.from.id).rec || null;
const setRec = (ctx, patch, step = 'rec_pick') => session.set(ctx.from.id, { step, rec: { ...(rec(ctx) || {}), ...patch } });
const nextText = (d) => (d ? `${time.prettyDate(d.toFormat('yyyy-MM-dd'))}, <b>${d.toFormat('HH:mm')}</b>` : '—');

const start = async (ctx) => {
  if (!canRec(ctx)) return deny(ctx);
  session.clear(ctx.from.id);
  const mine = await recurring.listBy(ctx.from.id);
  return render(
    ctx,
    '📆 <b>DAVRIY ESLATMA</b>\n\nHar kuni (ish kunlari, masalan 09:00 da), har hafta (masalan har juma 16:00 da) yoki har oy (masalan 5-kuni 10:00 da) hodimga avtomatik boradi.\n\n' +
      "📨 <b>Eslatma</b> — xabar, hodim «👁 O'qidim» bosadi.\n📌 <b>Topshiriq</b> — har safar yangi topshiriq (Bajardim + isbot, KPI ga kiradi).\n\nNima yuboramiz?",
    inline([
      [cb('📨 Eslatma', 'dv:k:remind'), cb('📌 Topshiriq', 'dv:k:task')],
      [cb(`📜 Davriy eslatmalarim (${mine.length})`, 'dv:l'), cb(ui.BTN.cancel, 'dv:x')],
    ]),
  );
};

const peoplePick = picker.create({
  prefix: 'dq',
  allowed: canRec,
  candidates: picker.managedCandidates,
  backData: 'dv:start',
  title: (ctx, n) => `📆 <b>Kimga boradi?</b>${n ? ` — belgilandi: <b>${n}</b>` : ''}`,
  onDone: async (ctx, ids) => {
    if (!rec(ctx) || !rec(ctx).kind) return stale(ctx);
    const all = await picker.managedCandidates(ctx);
    const list = all.filter((e) => ids.includes(Number(e.id)));
    const target = list.length === all.length && list.length > 1 ? 'Hammaga' : list.map((e) => e.full_name).join(', ').slice(0, 300);
    setRec(ctx, { ids, target });
    return askFreq(ctx);
  },
});

const askFreq = (ctx) => {
  const r = rec(ctx);
  return render(ctx, `${KIND_HEAD[r.kind]}\n👥 Kimga: <b>${esc(r.target)}</b> — ${r.ids.length} kishi\n\n🔁 <b>Qanchalik tez-tez?</b>`, inline([
    [cb('🔂 Har kun', 'dv:f:day'), cb('🗓 Har hafta', 'dv:f:week'), cb('📅 Har oy', 'dv:f:month')],
    [cb(ui.BTN.cancel, 'dv:x')],
  ]));
};

const askMonthDay = (ctx) => {
  const rows = [];
  for (let d = 1; d <= 31; d += 7) rows.push(Array.from({ length: Math.min(7, 32 - d) }, (_, i) => cb(String(d + i), `dv:md:${d + i}`)));
  rows.push([cb('📆 Oyning oxirgi kuni', 'dv:md:0')]);
  rows.push([cb(ui.BTN.cancel, 'dv:x')]);
  return render(ctx, "📅 <b>Har oyning nechanchi kuni?</b>\n<i>29, 30, 31 — qisqa oyda oyning oxirgi kuniga o'tadi.</i>", inline(rows));
};

const askWeek = (ctx) => {
  const sel = new Set((rec(ctx).week || []).map(Number));
  return render(ctx, '🗓 <b>Haftaning qaysi kuni?</b> Bir nechtasini belgilash mumkin (masalan Du va Ju).', inline([
    time.UZ_SHORT.map((d, i) => cb(`${sel.has(i + 1) ? '✅' : ''}${d}`, `dv:wd:${i + 1}`)),
    [cb(sel.size ? `➡️ Davom etish (${sel.size})` : '➡️ Davom etish', 'dv:wok'), cb(ui.BTN.cancel, 'dv:x')],
  ]));
};

const askTime = (ctx) => {
  const rows = [];
  for (let i = 0; i < SLOTS.length; i += 4) rows.push(SLOTS.slice(i, i + 4).map((t) => cb(`🕘 ${t}`, `dv:t:${t.replace(':', '')}`)));
  rows.push([cb('✍️ Soatni yozish (masalan 16:30)', 'dv:t:type')]);
  rows.push([cb(ui.BTN.cancel, 'dv:x')]);
  const r = rec(ctx);
  return render(ctx, `🔁 ${esc(recurring.daysText({ freq: r.freq, days: r.days.join(',') }))}\n\n⏰ <b>Soat nechida yuborilsin?</b>`, inline(rows));
};

const askText = async (ctx, hhmm) => {
  setRec(ctx, { at: hhmm }, 'rec_text');
  const r = rec(ctx);
  await render(ctx, `🔁 ${esc(recurring.scheduleText({ ...draftOf(r), at_time: hhmm }))}`);
  return ctx.reply(
    r.kind === 'task'
      ? "✍️ Topshiriqni yozing (bir nechta bo'lsa — har qatorda bittadan) — yoki 🎤 ovoz, 🎥 video, 📄 fayl, 🖼 rasm yuboring (izohi — topshiriq nomi):"
      : '✍️ Eslatma matnini yozing — yoki 🎤 ovoz, 🎥 video, 📄 fayl, 🖼 rasm yuboring (izohi — matn):',
    ui.cancelKeyboard(),
  );
};

const askDue = (ctx) => {
  session.set(ctx.from.id, { step: 'rec_pick' });
  return ctx.reply('⏱ <b>Har safar muddat qancha?</b> (topshiriq yuborilgan kundan)', {
    parse_mode: 'HTML',
    ...inline([
      [cb("📅 O'sha kuni", 'dv:o:0'), cb('+1 kun', 'dv:o:1')],
      [cb('+3 kun', 'dv:o:3'), cb('+7 kun', 'dv:o:7')],
      [cb(ui.BTN.cancel, 'dv:x')],
    ]),
  });
};

const draftOf = (r) => ({ freq: r.freq, days: (r.days || []).join(','), at_time: r.at });

const preview = async (ctx) => {
  const r = rec(ctx);
  if (!r || !r.at || !r.ids) return stale(ctx);
  session.set(ctx.from.id, { step: 'rec_confirm' });
  const media = r.media;
  const mediaLine = media ? `\n${ui.MEDIA_ICON[media.type] || '📎'} ${media.type === 'document' && media.fileName ? esc(media.fileName) : 'media biriktirilgan'}` : '';
  const due = r.kind === 'task' ? `\n⏱ Muddat: <b>${DUE_LABEL[r.due] || `${r.due} kun ichida`}</b>` : '';
  await ctx.reply('👇 Tekshiring:', { reply_markup: { remove_keyboard: true } });
  return ctx.reply(
    `${KIND_HEAD[r.kind]}\n👥 Kimga: <b>${esc(r.target)}</b> — ${r.ids.length} kishi\n🔁 Qachon: <b>${esc(recurring.scheduleText(draftOf(r)))}</b>${due}\n\n` +
      `${r.body ? `«${esc(r.body)}»` : ''}${mediaLine}\n${ui.LINE}\n▶️ Birinchi yuborish: ${nextText(recurring.nextRun(draftOf(r)))}`,
    { parse_mode: 'HTML', ...inline([[cb('💾 Saqlash', 'dv:save'), cb(ui.BTN.cancel, 'dv:x')]]) },
  );
};

const handleTimeText = (ctx) => {
  const r = rec(ctx);
  if (!r || !r.days) return stale(ctx);
  const t = tasks.normTime(ctx.message.text);
  if (!t) return ctx.reply('Soat tushunilmadi. Masalan: 09:30 yoki 16:00', ui.cancelKeyboard());
  return askText(ctx, t);
};

const afterBody = (ctx) => (rec(ctx).kind === 'task' ? askDue(ctx) : preview(ctx));

const handleText = (ctx) => {
  const r = rec(ctx);
  if (!r || !r.at) return stale(ctx);
  const body = String(ctx.message.text || '').trim().slice(0, 2000);
  if (!body) return ctx.reply("Matn bo'sh. Qaytadan yozing:", ui.cancelKeyboard());
  if (r.kind === 'task' && !flows.splitTitles(body).length) return ctx.reply('Topshiriq matnini yozing:', ui.cancelKeyboard());
  setRec(ctx, { body, media: null }, 'rec_text');
  return afterBody(ctx);
};

/** Izohsiz media topshiriq — qisqa mazmun majburiy (Bajardim ro'yxatida shu matn chiqadi) */
const handleTitle = (ctx) => {
  const r = rec(ctx);
  if (!r || !r.media) return stale(ctx);
  const body = String(ctx.message.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!body) return ctx.reply('Qisqa mazmunini yozing:', ui.cancelKeyboard());
  setRec(ctx, { body }, 'rec_title');
  return afterBody(ctx);
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

const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private' || session.get(ctx.from.id).step !== 'rec_text' || !canRec(ctx)) return next();
  const r = rec(ctx);
  if (!r || !r.at) return stale(ctx);
  const media = mediaOf(ctx.message);
  if (!media) return ctx.reply('Matn, ovozli xabar, video, rasm yoki fayl yuboring.', ui.cancelKeyboard());
  const caption = String(ctx.message.caption || '').replace(/\s+/g, ' ').trim();
  setRec(ctx, { media, body: caption ? caption.slice(0, r.kind === 'task' ? 500 : 900) : null }, 'rec_text');
  if (r.kind === 'task' && !caption) {
    session.set(ctx.from.id, { step: 'rec_title' });
    return ctx.reply("✍️ Topshiriqning qisqa mazmunini yozing (hodimning «Bajardim» ro'yxatida shu matn chiqadi):", ui.cancelKeyboard());
  }
  return afterBody(ctx);
};

const doSave = async (ctx) => {
  const s = session.get(ctx.from.id);
  const r = s.rec;
  if (s.step !== 'rec_confirm' || !r || !r.at) return ctx.answerCbQuery('Eskirgan tugma');
  session.clear(ctx.from.id); // birinchi await dan oldin — ikki marta saqlanmasin
  await ctx.answerCbQuery('Saqlanmoqda…');
  const allowed = new Set((await picker.managedCandidates(ctx)).map((e) => Number(e.id)));
  const ids = r.ids.map(Number).filter((id) => allowed.has(id));
  if (!ids.length) return render(ctx, 'Qabul qiluvchi topilmadi.');
  const row = await recurring.create({
    kind: r.kind, freq: r.freq, days: r.days, atTime: r.at, body: r.body || null, media: r.media || null, dueOffset: r.kind === 'task' ? r.due || 0 : 0,
    target: r.target, createdBy: ctx.from.id, creatorName: ctx.state.actor.name, memberIds: ids,
  });
  await render(
    ctx,
    `✅ <b>Saqlandi</b> — ${KIND_ICON[row.kind]} ${esc(recurring.scheduleText(row))}, ${ids.length} kishiga.\n▶️ Keyingi yuborish: ${nextText(row.next_run_at ? DateTime.fromISO(row.next_run_at, { zone: time.TZ }) : null)}\n` +
      "<i>Har safar yuborilganda sizga qisqa hisobot keladi. To'xtatish yoki bekor qilish — «📜 Davriy eslatmalarim».</i>",
    inline([[cb('📜 Davriy eslatmalarim', 'dv:l')]]),
  );
  return ctx.reply('👌', ui.kbFor(ctx));
};

// --- ro'yxat va boshqaruv (har kim faqat o'zi yozganini ko'radi) ---
const own = async (ctx, id) => {
  const r = await recurring.byId(id);
  return r && !r.cancelled_at && Number(r.created_by) === Number(ctx.from.id) ? r : null;
};

const list = async (ctx) => {
  if (!canRec(ctx)) return deny(ctx);
  const rows0 = await recurring.listBy(ctx.from.id);
  if (!rows0.length) return render(ctx, '📜 Hali davriy eslatma yozilmagan.', inline([[cb('➕ Yangi davriy eslatma', 'dv:start')]]));
  const rows = rows0.slice(0, 30).map((r) => [cb(
    `${Number(r.active) ? '' : '⏸ '}${KIND_ICON[r.kind]} ${recurring.scheduleText(r)} · ${r.target || ''}`.slice(0, 60),
    `dv:v:${r.id}`,
  )]);
  rows.push([cb('➕ Yangi davriy eslatma', 'dv:start')]);
  return render(ctx, `📜 <b>Davriy eslatmalarim</b> — ${rows0.length} ta:\n<i>⏸ — to'xtatilgan</i>`, inline(rows));
};

const card = async (ctx, id) => {
  const r = await own(ctx, id);
  if (!r) return render(ctx, 'Topilmadi (bekor qilingan yoki sizniki emas).', inline([[cb('📜 Davriy eslatmalarim', 'dv:l')]]));
  const people = await recurring.members(r.id);
  const gone = people.filter((e) => !Number(e.active)).length;
  // 19-okt: topshiriqda — kim bajaryapti, kim ketma-ket bajarmayapti (hali baholanmaganlar ko'rsatilmaydi)
  let results = '';
  if (r.kind === 'task') {
    const marks = [];
    for (const e of people.filter((x) => Number(x.active))) {
      if (!(await recurring.hasResults(r.id, e.id))) continue;
      const n = await recurring.streak(r.id, e.id);
      marks.push(n ? `🔴 ${esc(e.full_name)} — ketma-ket ${n}` : `✅ ${esc(e.full_name)}`);
    }
    if (marks.length) results = `\n📊 Oxirgi natija: ${marks.join(' · ')}`;
  }
  const next = Number(r.active) && r.next_run_at ? DateTime.fromISO(r.next_run_at, { zone: time.TZ }) : null;
  const rows = [];
  if (r.file_id) rows.push([cb(`${ui.MEDIA_ICON[r.media_type] || '📎'} Ko'rish / eshitish`, `dv:m:${r.id}`)]);
  if (r.kind === 'remind') {
    const a = await recurring.lastAnnouncement(r.id);
    if (a) rows.push([cb("👁 Oxirgi eslatma — kim o'qidi", `an:v:${a.id}`)]);
  }
  rows.push([Number(r.active) ? cb("⏸ To'xtatish", `dv:p:${r.id}`) : cb('▶️ Davom ettirish', `dv:r:${r.id}`), cb('🗑 Bekor qilish', `dv:del:${r.id}`)]);
  rows.push([cb('📜 Davriy eslatmalarim', 'dv:l')]);
  return render(
    ctx,
    `${KIND_HEAD[r.kind]}${Number(r.active) ? '' : " · ⏸ <b>to'xtatilgan</b>"}\n🔁 <b>${esc(recurring.scheduleText(r))}</b>` +
      `${r.kind === 'task' ? `\n⏱ Muddat: ${DUE_LABEL[r.due_offset] || `${r.due_offset} kun ichida`}` : ''}\n` +
      `👥 ${esc(r.target || '')} — ${people.length} kishi: ${picker.namesText(people)}${gone ? `\n<i>(${gone} kishi ishdan bo'shagan — unga yuborilmaydi)</i>` : ''}\n\n` +
      `${r.body ? `«${esc(r.body)}»` : ui.MEDIA_LABEL[r.media_type] || 'media'}\n${ui.LINE}\n` +
      `▶️ Keyingi yuborish: ${next ? nextText(next) : '—'}\n📤 Yuborildi: ${r.run_count} marta${r.last_run_at ? ` · oxirgisi ${time.prettyDate(String(r.last_run_at).slice(0, 10))} ${time.clock(r.last_run_at)}` : ''}${results}`,
    inline(rows),
  );
};

const register = (bot) => {
  bot.hears(ui.BTN.recurring, start);
  bot.command('davriy', start);
  bot.action('dv:start', async (ctx) => { await ctx.answerCbQuery(); return start(ctx); });
  bot.action(/^dv:k:(remind|task)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'rec_pick', rec: { kind: ctx.match[1] } });
    return peoplePick.show(ctx, { reset: true });
  });
  peoplePick.register(bot);
  bot.action(/^dv:f:(day|month|week)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    if (!rec(ctx) || !rec(ctx).ids) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery();
    // har kun — kun tanlanmaydi, darhol soat (ish kunlari — WORK_DAYS bo'yicha)
    if (ctx.match[1] === 'day') { setRec(ctx, { freq: 'day', days: [], week: [] }); return askTime(ctx); }
    setRec(ctx, { freq: ctx.match[1], days: null, week: [] });
    return ctx.match[1] === 'month' ? askMonthDay(ctx) : askWeek(ctx);
  });
  bot.action(/^dv:md:(\d{1,2})$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const d = Number(ctx.match[1]);
    if (!rec(ctx) || rec(ctx).freq !== 'month' || d > 31) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery();
    setRec(ctx, { days: [d] });
    return askTime(ctx);
  });
  bot.action(/^dv:wd:([1-7])$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    if (!rec(ctx) || rec(ctx).freq !== 'week') return ctx.answerCbQuery('Eskirgan tugma');
    const d = Number(ctx.match[1]);
    const cur = (rec(ctx).week || []).map(Number);
    setRec(ctx, { week: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d] });
    await ctx.answerCbQuery();
    return askWeek(ctx);
  });
  bot.action('dv:wok', async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const r = rec(ctx);
    if (!r || r.freq !== 'week') return ctx.answerCbQuery('Eskirgan tugma');
    if (!(r.week || []).length) return ctx.answerCbQuery('Kamida bitta kunni belgilang', { show_alert: true });
    await ctx.answerCbQuery();
    setRec(ctx, { days: [...r.week].map(Number).sort((a, b) => a - b) });
    return askTime(ctx);
  });
  bot.action(/^dv:t:(\d{4}|type)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const r = rec(ctx);
    if (!r || !r.days) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') {
      session.set(ctx.from.id, { step: 'rec_time' });
      await render(ctx, '⏰ Yuborish soati:');
      return ctx.reply('Soatni yozing. Masalan: 09:30 yoki 16:00', ui.cancelKeyboard());
    }
    const t = tasks.normTime(`${ctx.match[1].slice(0, 2)}:${ctx.match[1].slice(2)}`);
    if (!t) return ctx.answerCbQuery('Eskirgan tugma');
    return askText(ctx, t);
  });
  bot.action(/^dv:o:(0|1|3|7)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const r = rec(ctx);
    if (!r || r.kind !== 'task' || !r.at || (!r.body && !r.media)) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery();
    setRec(ctx, { due: Number(ctx.match[1]) });
    return preview(ctx);
  });
  bot.action('dv:save', (ctx) => (canRec(ctx) ? doSave(ctx) : deny(ctx)));
  bot.action('dv:x', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); await render(ctx, '❌ Bekor qilindi.'); return ctx.reply('👌', ui.kbFor(ctx)); });
  bot.action('dv:l', async (ctx) => { await ctx.answerCbQuery(); return list(ctx); });
  bot.action(/^dv:v:(\d+)$/, async (ctx) => { if (!canRec(ctx)) return deny(ctx); await ctx.answerCbQuery(); return card(ctx, ctx.match[1]); });
  bot.action(/^dv:m:(\d+)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const r = await own(ctx, ctx.match[1]);
    if (!r || !r.file_id) return ctx.answerCbQuery('Topilmadi');
    await ctx.answerCbQuery();
    return notify.sendProof({ telegram: ctx.telegram }, ctx.from.id, { type: r.media_type, fileId: r.file_id }, `📆 ${esc(r.body || recurring.scheduleText(r))}`);
  });
  bot.action(/^dv:(p|r):(\d+)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const r = await own(ctx, ctx.match[2]);
    if (!r) return ctx.answerCbQuery('Topilmadi');
    const ok = await recurring.setActive(r.id, ctx.match[1] === 'r');
    await ctx.answerCbQuery(ok ? (ctx.match[1] === 'r' ? '▶️ Davom etadi' : "⏸ To'xtatildi") : "O'zgarmadi");
    return card(ctx, r.id);
  });
  bot.action(/^dv:del:(\d+)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const r = await own(ctx, ctx.match[1]);
    if (!r) return ctx.answerCbQuery('Allaqachon bekor qilingan');
    await ctx.answerCbQuery();
    return render(ctx, `🗑 <b>Davriy eslatma bekor qilinsinmi?</b>\n${KIND_ICON[r.kind]} ${esc(recurring.scheduleText(r))} · ${esc(r.target || '')}\n\n<i>Boshqa yuborilmaydi. Yozuv bazada qoladi.</i>`,
      ui.confirmKeyboard(`dv:delok:${r.id}`, `dv:v:${r.id}`, '🗑 Ha, bekor qilish'));
  });
  bot.action(/^dv:delok:(\d+)$/, async (ctx) => {
    if (!canRec(ctx)) return deny(ctx);
    const r = await own(ctx, ctx.match[1]);
    const ok = r ? await recurring.cancel(r.id, ctx.from.id) : false;
    await ctx.answerCbQuery(ok ? '🚫 Bekor qilindi' : 'Allaqachon bekor qilingan');
    return list(ctx);
  });
  // 19-okt: «Bajardingizmi yoki bajarasizmi?» — hodim javobi (yozgan odamga xabar)
  bot.action(/^rq:(will|no):(\d+)$/, async (ctx) => {
    const emp = ctx.state.employee;
    if (!emp) return ctx.answerCbQuery('⛔️');
    const t = await flows.answerRecurringTask(ctx, emp, ctx.match[2], ctx.match[1]);
    if (!t) return ctx.answerCbQuery('Javobingiz allaqachon yuborilgan yoki topshiriq yopilgan', { show_alert: true });
    await ctx.answerCbQuery('Yuborildi');
    const label = recurring.ANSWER_LABEL[ctx.match[1]];
    await ctx.editMessageReplyMarkup(inline([
      [cb('✔️ Bajardim', `done:${t.id}`)],
      recurring.ANSWERS.map((a) => cb(`${a === ctx.match[1] ? '• ' : ''}${recurring.ANSWER_LABEL[a]}`, `rq:${a}:${t.id}`)),
    ]).reply_markup).catch(() => {});
    return ctx.reply(`${label} — javobingiz topshiriq bergan odamga yuborildi.${ctx.match[1] === 'will' ? ` Bajargach «${ui.BTN.done}» bosing.` : ''}`);
  });
  bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], onMedia);
};

module.exports = { register, start, handleTimeText, handleText, handleTitle };
