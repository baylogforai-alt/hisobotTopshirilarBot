'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const tasks = require('./tasks');
const employees = require('./employees');
const attendance = require('./attendance');
const departments = require('./departments');
const notify = require('./notify');
const org = require('./org');
const kpi = require('./kpi');
const webapp = require('./webapp');
const activity = require('./activity');
const announcements = require('./announcements');
const chats = require('./chats');
const tg = require('../telegram');

/**
 * UMUMIY AMALLAR — bot handlerlari va Web App API bir xil yo'ldan o'tadi:
 * bazaga yozish + kimga qanday xabar borishi shu yerda. Huquq tekshiruvi chaqiruvchida (access.js).
 * bot — { telegram } (ctx.telegram yoki bot.telegram).
 */

const { esc } = ui;

/** '!Muhim ish' → { title:'Muhim ish', priority:'high' } */
const parseTitle = (raw) => {
  const s = String(raw || '').trim();
  const high = /^[!❗🔥]/.test(s);
  return { title: s.replace(/^[!❗🔥]+\s*/, '').slice(0, 500), priority: high ? 'high' : 'normal' };
};

/** Ko'p qatorli matn → topshiriqlar (raqam/belgi olib tashlanadi), ko'pi bilan 20 ta */
const splitTitles = (text) =>
  String(text || '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean).slice(0, 20);

const makeTasks = async ({ employeeId, titles, dueDate, createdBy, source, priority = null, media = null, startTime = null }) => {
  const created = [];
  for (const raw of titles) {
    const p = parseTitle(raw);
    if (p.title) created.push(await tasks.create({ employeeId, title: p.title, dueDate, createdBy, source, priority: priority || p.priority, media, startTime }));
  }
  return created;
};

/** «⏱ Muddat: 3-oktabr · ⏰ soat 09:00 da boshlanadi» */
const whenText = (dueDate, startTime) =>
  `${time.prettyDate(dueDate)}${tasks.normTime(startTime) ? ` · ⏰ soat <b>${tasks.normTime(startTime)}</b> da boshlanadi` : ''}`;

/** Media topshiriq: izoh (caption) — sarlavha; izohsiz — «🎤 Ovozli topshiriq» / fayl nomi. Bitta topshiriq */
const mediaTitles = (media, caption) => {
  const c = String(caption || '').replace(/\s+/g, ' ').trim();
  if (c) return [c.slice(0, 500)];
  if (media.type === 'document' && media.fileName) return [`📄 ${media.fileName}`];
  return [ui.MEDIA_LABEL[media.type] || '📎 Topshiriq'];
};

/** Hodimga topshiriqning o'zi (ovoz/video/fayl) — «Tushundim» tugmasi bilan */
const sendTaskMedia = (bot, chatId, t, extra = {}) =>
  notify.sendProof(bot, chatId, { type: t.task_media_type, fileId: t.task_file_id }, `📎 <b>${esc(t.title)}</b>`, extra);

// ---------------------------------------------------------------------------
// TOPSHIRIQLAR
// ---------------------------------------------------------------------------

/** Rahbar / HR / direktor topshiriq beradi. giver — access actor */
const assignTasks = async (bot, giver, target, titles, dueDate, { priority = null, media = null, startTime = null } = {}) => {
  const source = giver.isAdmin ? 'admin' : 'head';
  const created = await makeTasks({ employeeId: target.id, titles, dueDate, createdBy: giver.tgId, source, priority, media, startTime });
  if (!created.length) return { created, source };
  const ackKb = ui.inline(ui.ackRows(created));
  await notify.toUser(
    bot, target.tg_id,
    `📥 <b>Yangi topshiriq!</b> — <i>${esc(giver.name)}</i>\n⏱ Muddat: <b>${whenText(dueDate, startTime)}</b>\n\n${ui.taskList(created)}\n\n` +
      `${media ? '👇 Topshiriqni eshiting / ko\'ring va ' : ''}«✅ Tushundim» tugmasini bosing (yoki «tushundim» deb yozing). Bajargach «${ui.BTN.done}» bilan belgilang.`,
    media ? {} : ackKb,
  );
  if (media) await sendTaskMedia(bot, target.tg_id, created[0], ackKb);
  // arxiv (kun daftari): kim berdi — kim oldi
  for (const t of created) {
    activity.track(giver.employee || null, 'assign', { tgId: giver.tgId, title: t.title, detail: `→ ${target.full_name}` });
    activity.track(target, 'assigned', { title: t.title, detail: `${giver.name} berdi · muddat ${time.prettyDate(dueDate)}` });
  }
  // Direktor va HR bergan topshiriq — nusxasiz (jurnalda ko'rinadi); rahbar bergani — sozlamaga qarab
  if (source === 'head' && !giver.isHr && (await org.headTaskCopy())) {
    await notify.toSeeAll(bot, `📤 <b>${esc(giver.name)}</b> → <b>${esc(target.full_name)}</b>: ${created.length} ta topshiriq (${time.prettyDate(dueDate)})\n${ui.taskList(created)}`, {}, giver.tgId, { quiet: true });
  }
  return { created, source };
};

/** Hodim o'ziga vazifa yozadi — tekshiruvchilarga xabar */
const addSelfTasks = async (bot, emp, titles, dueDate, { priority = null, media = null, startTime = null } = {}) => {
  // 5-okt: hodim o'ziga yozgan vazifa haqida hech kimga xabar bormaydi (jurnal, arxiv va holat ro'yxatlarida baribir ko'rinadi)
  const created = await makeTasks({ employeeId: emp.id, titles, dueDate, createdBy: emp.tg_id, source: 'self', priority, media, startTime });
  created.forEach((t) => activity.track(emp, 'task_add', { title: t.title, detail: `muddat ${time.prettyDate(dueDate)}` }));
  return created;
};

/**
 * Boshlanish soati keldi — hodimga «hozir shu missiyani bajarishingiz kerak» (har daqiqa, jobs.js). Nechta xabar
 */
const notifyTaskStarts = async (bot, now = time.now()) => {
  let n = 0;
  for (const t of await tasks.dueStarts(now)) {
    await tasks.markStartNotified(t.id);
    await notify.toUser(
      bot, t.tg_id,
      `⏰ <b>Soat ${t.start_time} — vaqti keldi!</b>\n\nHozir shu missiyani bajarishingiz kerak:\n📌 <b>${esc(t.title)}</b>` +
        `${t.source !== 'self' ? `\n<i>bergan: ${esc(ui.SOURCE_LABEL[t.source] || '')}</i>` : ''}\n\nBajargach «${ui.BTN.done}» bosing.`,
      ui.inline([[ui.cb('✔️ Bajardim', `done:${t.id}`)]]),
    );
    n += 1;
    await tg.throttle();
  }
  return n;
};

/** «Eshitdim, tushundim» — hodim tasdiqlaydi, topshiriq bergan odamga qisqa xabar. ids — null = hammasi. Tasdiqlanganlar */
const ackTasks = async (bot, emp, ids = null, note = null) => {
  const list = ids ? ids : (await tasks.unackedFor(emp.id)).map((t) => t.id);
  const done = [];
  for (const id of list) {
    const t = await tasks.ack(id, emp.id, note);
    if (t) done.push(t);
  }
  done.forEach((t) => activity.track(emp, 'task_ack', { title: t.title, detail: note || null }));
  const byGiver = new Map();
  for (const t of done) {
    if (!t.created_by || Number(t.created_by) === Number(emp.tg_id)) continue;
    if (!byGiver.has(Number(t.created_by))) byGiver.set(Number(t.created_by), []);
    byGiver.get(Number(t.created_by)).push(t);
  }
  for (const [tgId, list2] of byGiver) {
    await notify.toUser(bot, tgId, `👂 <b>${esc(emp.full_name)}</b> topshiriqni tushundi (${time.clock(time.stamp())}):\n${list2.map((t) => `• ${esc(t.title)}`).join('\n')}${note ? `\n💬 «${esc(note)}»` : ''}`);
  }
  return done;
};

/**
 * Boshliq o'z topshirig'ini bajardi (isbot ixtiyoriy) → darhol accepted.
 * Topshiriqni boshqa odam (HR / direktor) bergan bo'lsa — unga xabar (isbot bo'lsa — isbot bilan).
 */
const completeBossTask = async (bot, emp, taskId, proof = null) => {
  const res = await tasks.completeOwn(taskId, emp, proof);
  if (!res.ok) return res;
  const t = res.task;
  const caption = `✅ <b>${esc(emp.full_name)}</b> bajardi: <b>${esc(t.title)}</b> · ${time.clock(t.done_at)}${proof && proof.note ? `\n💬 «${esc(proof.note)}»` : ''}`;
  if (t.source !== 'self' && t.created_by && Number(t.created_by) !== Number(emp.tg_id)) {
    if (proof && proof.fileId) await notify.sendProof(bot, t.created_by, proof, caption);
    else await notify.toUser(bot, t.created_by, caption);
  }
  if (proof && proof.fileId) await notify.toArchive(bot, caption, proof);
  return res;
};

// ---------------------------------------------------------------------------
// E'LONLAR
// ---------------------------------------------------------------------------

/**
 * E'lon (Web App uchun) — BayLog'ning o'z E'lon xizmati (services/announcements: «👁 O'qidim», tarix, guruhga ham) orqali.
 * sender — access actor; targets — hodimlar; target — «Hammaga», «Bo'limlar: …» kabi yorliq. Huquq — chaqiruvchida.
 */
const sendAnnouncement = async (bot, sender, targets, { body = null, media = null, target = 'all' } = {}) => {
  const res = await announcements.send(bot, sender, targets, { text: body, media }, { target });
  if (res.ann) await notify.toArchive(bot, `${announcements.bodyOf(res.ann)}\n\n<i>→ ${esc(target)} · ${targets.length} kishi</i>`, res.ann.file_id ? { type: res.ann.media_type, fileId: res.ann.file_id } : null);
  return { announcement: res.ann, total: targets.length, delivered: res.delivered };
};

/** Hali o'qimaganlarga qayta yuborish. Nechta kishiga */
const resendAnnouncement = (bot, a) => announcements.resendUnread(bot, a.id);

/** Qabul qilish → hodimga xabar. { ok, task } */
const acceptTask = async (bot, taskId, byTgId) => {
  const res = await tasks.accept(taskId, byTgId);
  if (!res.ok) return res;
  const onTime = tasks.isOnTime(res.task);
  await notify.toUser(bot, res.task.tg_id, `✅ <b>Qabul qilindi:</b> ${esc(res.task.title)}${onTime ? ' 👏' : '\n<i>Muddatdan kech bajarilgani KPI da hisobga olinadi.</i>'}`);
  return { ...res, onTime };
};

/** Qaytarish (izoh bilan) → hodimga xabar */
const returnTask = async (bot, taskId, byTgId, note = null, { countLate = false, fixDue = null } = {}) => {
  const res = await tasks.returnBack(taskId, byTgId, note, { countLate, fixDue });
  if (!res.ok) return res;
  const t = res.task;
  const dueText = fixDue
    ? `🔁 Tuzatish muddati: <b>${time.prettyDate(t.due_date)}</b> — shu kungacha tuzatsangiz, vaqtida hisoblanadi.`
    : `⏱ Yangi muddat berilmadi — eski muddat: <b>${time.prettyDate(t.due_date)}</b>${t.due_date < time.today() ? " (o'tgan — tuzatilsa ham <b>kechikkan</b> hisoblanadi)" : ''}.`;
  await notify.toUser(
    bot, t.tg_id,
    `↩️ <b>Qaytarildi — kamchiliklar bor:</b> ${esc(t.title)}${note ? `\n📝 «${esc(note)}»` : ''}\n\nTuzatib, qayta «${ui.BTN.done}» bosing.\n${dueText}\n` +
      (countLate ? `⏰ <i>Muddatidan kech topshirilgani KPI da kechikish bo'lib qoladi.</i>\n` : '') +
      `<i>Javob bering: «👌 Xo'p, tushundim» yoki «💬 O'z javobim» (matn, ovoz, video, fayl).</i>`,
    taskReplyKb(t.id, { ok: true }),
  );
  return res;
};

// ---------------------------------------------------------------------------
// QAYTARILGAN TOPSHIRIQQA JAVOB (hodim ↔ tekshiruvchi)
// ---------------------------------------------------------------------------

/** ok — topshiriq egasiga: «👌 Xo'p, tushundim» + «💬 O'z javobim»; tekshiruvchiga — «💬 Javob yozish» */
const taskReplyKb = (taskId, { ok = false } = {}) => ui.inline(ok
  ? [[ui.cb("👌 Xo'p, tushundim", `tr:ok:${taskId}`), ui.cb("💬 O'z javobim", `tr:${taskId}`)]]
  : [[ui.cb('💬 Javob yozish', `tr:${taskId}`)]]);
const TASK_REPLY_OK = "👌 Xo'p, tushundim — tuzataman.";
/** Telegram lichkasiga havola (hodim bo'lmagan direktor uchun ham) */
const personLink = (tgId, name) => `<a href="tg://user?id=${Number(tgId)}">${esc(name || 'Foydalanuvchi')}</a>`;

/**
 * Topshiriq bo'yicha javobni kimga yuborish: hodim yozsa — qaytargan (bo'lmasa bergan) odamga;
 * tekshiruvchi / beruvchi yozsa — hodimga. null — yozadigan odam yo'q.
 */
const taskReplyTarget = (actor, t) => {
  const me = actor.employee;
  if (me && Number(t.employee_id) === Number(me.id)) {
    if (t.reviewed_by && Number(t.reviewed_by) !== Number(me.tg_id)) return Number(t.reviewed_by);
    return t.created_by && Number(t.created_by) !== Number(me.tg_id) ? Number(t.created_by) : null;
  }
  return Number(t.tg_id);
};

/** Javob → bazaga + qabul qiluvchiga (matn yoki media, lichka havolasi va «Javob yozish» tugmasi bilan) */
const sendTaskReply = async (bot, actor, t, toTg, { body = null, media = null } = {}) => {
  const r = await tasks.addReply({ taskId: t.id, fromTg: actor.tgId, fromName: actor.name, toTg, body, media });
  const fromOwner = Boolean(actor.employee && Number(actor.employee.id) === Number(t.employee_id));
  const text = `💬 <b>${fromOwner ? "Qaytarilgan topshiriq bo'yicha javob" : "Topshiriq bo'yicha xabar"}</b>\n` +
    `📌 <b>${esc(t.title)}</b>${Number(t.returned_count) ? ` · ↩️ ${t.returned_count} marta qaytarilgan` : ''}\n` +
    `👤 ${personLink(actor.tgId, actor.name)} <i>(lichkaga yozish — ismni bosing)</i>${body ? `\n\n${esc(body)}` : ''}`;
  const kb = taskReplyKb(t.id, { ok: Number(toTg) === Number(t.tg_id) });
  const ok = media && media.fileId
    ? await notify.sendProof(bot, toTg, media, text, kb)
    : await notify.toUser(bot, toTg, text, kb);
  return { reply: r, delivered: Boolean(ok) };
};

// ---------------------------------------------------------------------------
// «💬 SAVOL-JAVOB» CHATLARI
// ---------------------------------------------------------------------------

/**
 * Xabar kimlarga boradi. replyMsg — qaysi xabarga javob (bo'lmasa — umumiy).
 * 'starter' rejimida: ishtirokchi → faqat boshlovchiga; boshlovchi → javob berilgan odamga yoki hammaga.
 * { toTg (bitta odam yoki null), tgIds }
 */
const chatRecipients = async (chat, authorTg, replyMsg = null) => {
  const memberIds = (await chats.members(chat.id)).map((m) => Number(m.tg_id));
  const everyone = [Number(chat.starter_tg), ...memberIds];
  let toTg = null;
  if (chat.mode === 'starter') {
    if (!chats.isStarter(chat, authorTg)) toTg = Number(chat.starter_tg);
    else if (replyMsg && !chats.isStarter(chat, replyMsg.from_tg)) toTg = Number(replyMsg.from_tg);
  }
  const tgIds = toTg ? [toTg] : [...new Set(everyone)].filter((id) => id !== Number(authorTg));
  return { toTg, tgIds };
};

const chatKb = (chat, m, recipientTg) => {
  const rows = [[ui.cb('↩️ Javob yozish', `qa:r:${chat.id}:${m.id}`), ui.cb('📜 Chat', `qa:v:${chat.id}`)]];
  if (chat.mode === 'starter' && chats.isStarter(chat, recipientTg) && !chats.isStarter(chat, m.from_tg)) {
    rows.push([ui.cb('📣 Hammaga yozish', `qa:r:${chat.id}:0`)]);
  }
  return ui.inline(rows);
};

const chatText = (chat, m, { first = false, membersLine = '' } = {}) =>
  `💬 <b>SAVOL-JAVOB</b> · <i>${esc(chat.target || chat.title || '')}</i>\n` +
  `👤 ${personLink(m.from_tg, m.from_name)}${m.to_tg ? ' → <i>sizga</i>' : ''}${m.body ? `:\n${esc(m.body)}` : ''}` +
  (first ? `\n${ui.LINE}\n${membersLine}<i>Javob — «↩️ Javob yozish»; lichkaga o'tish — ismni bosing.</i>` : '');

const deliverChat = (bot, chat, m, tgId, opts = {}) => {
  const text = chatText(chat, m, opts);
  const kb = chatKb(chat, m, tgId);
  return m.file_id
    ? notify.sendProof(bot, tgId, { type: m.media_type, fileId: m.file_id }, text, kb)
    : notify.toUser(bot, tgId, text, kb);
};

/**
 * Yangi chat: boshlovchi (actor) + hodimlar; birinchi xabar hammaga yuboriladi.
 * { chat, message, total, delivered }
 */
const startChat = async (bot, actor, targets, { target, mode = 'all', body = null, media = null } = {}) => {
  const title = (body || (media ? `${ui.MEDIA_ICON[media.type] || '📎'} media` : '')).replace(/\s+/g, ' ').slice(0, 60);
  const chat = await chats.create({ starterTg: actor.tgId, starterName: actor.name, title, target, mode: targets.length > 1 ? mode : 'all' });
  for (const e of targets) await chats.addMember(chat.id, e, false);
  const m = await chats.addMessage({ chatId: chat.id, fromTg: actor.tgId, fromName: actor.name, body, media });
  const names = targets.slice(0, 8).map((e) => esc(e.full_name)).join(', ') + (targets.length > 8 ? ` va yana ${targets.length - 8}` : '');
  const membersLine = targets.length > 1
    ? `👥 ${targets.length} kishi: ${names}\n${chat.mode === 'starter' ? '🔒 Javobingiz faqat boshlovchiga boradi.' : "👥 Javoblar hamma ishtirokchiga ko'rinadi."}\n`
    : '';
  let delivered = 0;
  for (const e of targets) {
    const ok = Boolean(await deliverChat(bot, chat, m, Number(e.tg_id), { first: true, membersLine }));
    await chats.addMember(chat.id, e, ok);
    if (ok) delivered += 1;
    await tg.throttle();
  }
  return { chat, message: m, total: targets.length, delivered };
};

/** Chatga xabar (javob). { message, total, delivered } */
const sendChatMessage = async (bot, actor, chat, { body = null, media = null, replyMsg = null } = {}) => {
  const { toTg, tgIds } = await chatRecipients(chat, actor.tgId, replyMsg);
  const m = await chats.addMessage({ chatId: chat.id, fromTg: actor.tgId, fromName: actor.name, toTg, body, media });
  let delivered = 0;
  for (const id of tgIds) {
    if (await deliverChat(bot, chat, m, id)) delivered += 1;
    if (tgIds.length > 1) await tg.throttle();
  }
  return { message: m, total: tgIds.length, delivered };
};

/** Bekor qilish. Hodimning o'zi bekor qilmagan bo'lsa unga xabar */
const cancelTask = async (bot, task, byEmployeeId = null, byTgId = null) => {
  const t = await tasks.cancel(task.id, byTgId);
  if (!t) return null; // allaqachon bekor/qabul qilingan — hodimga noto'g'ri xabar bormasin
  if (Number(t.employee_id) !== Number(byEmployeeId)) await notify.toUser(bot, t.tg_id, `🗑 Topshiriq bekor qilindi: <s>${esc(t.title)}</s>`);
  return t;
};

// ---------------------------------------------------------------------------
// DAVOMAT
// ---------------------------------------------------------------------------

/** «Kech qolaman». { row, inTime, text } */
const lateNotice = async (bot, emp, reason, proof = null) => {
  const row = await attendance.lateNotice(emp.id, reason, proof);
  const inTime = attendance.noticedInTime(row, emp);
  const text = `⏰ <b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''} bugun <b>kech qolishini</b> bildirdi · ${time.clock(time.stamp())}` +
    `${inTime ? ` <i>(${config.lateNoticeMinBefore} daq+ oldin — kechikish hisoblanmaydi)</i>` : ''}\n«${esc(reason)}»`;
  await notify.toHrAndBoss(bot, emp, text, {}, proof);
  await notify.toArchive(bot, text, proof);
  return { row, inTime };
};

/** Foydalanuvchiga «Kech qolaman» natijasi qoidasi */
const lateNoticeRule = (inTime) => (config.lateNoticeMinBefore
  ? inTime
    ? `\n✅ Ish boshlanishidan ${config.lateNoticeMinBefore} daqiqa oldin ogohlantirdingiz — bugungi kechikish <b>hisoblanmaydi</b>.`
    : `\n⚠️ Ish boshlanishiga ${config.lateNoticeMinBefore} daqiqadan kam qolganda aytildi — kechikish odatdagidek hisoblanadi.`
  : '');

/**
 * «Kelmayman» — sababli kun so'rovi. Tasdiqlash tugmalari bo'lim rahbari va boshliqqa (5-okt), HR ga — tugmasiz xabar.
 * Boshliqning o'zi aytsa — hech kimdan so'ralmaydi: darhol sababli, boshqalarga xabar. { row, auto }
 */
const requestAbsence = async (bot, emp, reason, proof = null) => {
  const who = `<b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''}`;
  if (employees.isBoss(emp)) {
    await attendance.requestExcuse(emp.id, reason, time.today(), proof);
    const row = await attendance.decideExcuse(emp.id, time.today(), 'approved', emp.tg_id);
    const text = `🙋 ${who} bugun kelmaydi (boshliq — sababli):\n«${esc(reason)}»`;
    await notify.toHrAndBoss(bot, emp, text, {}, proof);
    await notify.toArchive(bot, text, proof);
    return { row, auto: true };
  }
  const row = await attendance.requestExcuse(emp.id, reason, time.today(), proof);
  const text = `🙋 ${who} bugun kelmasligini bildirdi:\n«${esc(reason)}»`;
  await notify.toHrAndBoss(bot, emp, text, {}, proof, { decideExtra: ui.excuseKeyboard(row.id) });
  await notify.toArchive(bot, text, proof);
  return { row, auto: false };
};

/**
 * «Ketdim» — lokatsiya + izoh bilan (uydan turib «ketdim» deyolmasin). { row, worked, done, open }
 * place = { lat, lon, dist, where, warn } — where: 'ofisdan' / 'uydan', warn — «ofisdan tashqarida» / «uyidan turib». Avval kelgan va hali ketmagan (chaqiruvchi tekshiradi)
 */
const CHECKOUT_PROMPT = `🏁 <b>Ishdan ketyapsizmi?</b>\n\n1) Pastdagi «${ui.BTN.sendLocation}» tugmasi bilan hozirgi joyingizni yuboring.\n2) Keyin qisqa izoh yozasiz (bugun nima qildingiz / nega hozir ketyapsiz).\n<i>Lokatsiya va izoh bo'lim rahbari va HR ga boradi.</i>`;
/** Ish tugashidan oldin ketsa — necha daqiqa erta (0 — vaqtida yoki erkin jadval / dam olish kuni) */
const earlyLeaveMinutes = (emp, at = time.stamp()) => {
  if (!emp || employees.isFlexible(emp) || !time.isWorkDay(String(at).slice(0, 10))) return 0;
  const now = time.minutesOfDay(at);
  const end = employees.endMinutesOf(emp);
  return now !== null && now < end ? end - now : 0;
};

const checkOut = async (bot, emp, { place = null, note = null } = {}) => {
  const row = await attendance.checkOut(emp.id, time.today(), { place, note });
  const worked = attendance.workedMinutes(row);
  const early = earlyLeaveMinutes(emp, row.checked_out);
  const done = await tasks.doneOn(emp.id);
  const open = await tasks.openFor(emp.id);
  const placeText = place
    ? `\n📍 ${place.dist != null ? `${place.where} ${require('../geo').prettyDistance(place.dist)}${place.warn ? ` ⚠️ <b>${esc(place.warn)}</b>` : ''} · ` : ''}<a href="https://maps.google.com/?q=${Number(place.lat).toFixed(6)},${Number(place.lon).toFixed(6)}">🗺 xaritada</a>`
    : '';
  await notify.toAttendanceWatchers(
    bot, emp,
    `🏁 <b>${esc(emp.full_name)}</b> ketdi · ${time.clock(row.checked_out)}${early ? ` ⚠️ <b>erta ketdi</b> (${time.prettyDuration(early)} oldin, ish tugashi ${employees.workEndOf(emp)})` : ''}${worked !== null ? ` · ⏱ ${time.prettyDuration(worked)}` : ''} · ✅ ${done.length} · ⏳ ${open.length}` +
      `${placeText}${note ? `\n💬 «${esc(note)}»` : ''}`,
  );
  return { row, worked, done, open, early };
};

/** Sababli kun qarori (so'rov bo'yicha) → hodimga xabar */
const decideExcuse = async (bot, emp, date, status, byTgId) => {
  const row = await attendance.decideExcuse(emp.id, date, status, byTgId);
  await notify.toUser(
    bot, emp.tg_id,
    status === 'approved'
      ? `✅ ${time.prettyDate(date)} kuni <b>sababli</b> deb tasdiqlandi.`
      : `❌ ${time.prettyDate(date)} uchun so'rovingiz tasdiqlanmadi — kun <b>kelmagan</b> hisoblanadi.`,
  );
  return row;
};

/** Direktor kunni o'zi sababli deb belgilaydi (ta'til, komandirovka) */
const markExcused = async (bot, emp, date, byTgId, reason = null) => {
  const row = await attendance.decideExcuse(emp.id, date, 'approved', byTgId, reason || 'sababli');
  await notify.toUser(bot, emp.tg_id, `📄 ${time.prettyDate(date)} kuni direktor tomonidan <b>sababli</b> deb belgilandi.`);
  return row;
};

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

/** Direktor qarori (tasdiq / chiqarish) hodimga */
const kpiDecisionNotice = async (bot, k) => {
  const dept = k.department_id ? await departments.byId(k.department_id) : null;
  if (k.status === 'confirmed') {
    await notify.toUser(
      bot, k.tg_id,
      `🏆 <b>${time.monthName(k.month)} — KPI natijangiz tasdiqlandi</b>\n\n` +
        `📋 Topshiriq: ${k.tasks_pct}% · 🕘 Davomat: ${k.att_pct}% · ⭐ Boshliq: ${k.head_score === null ? '—' : `${k.head_score}/10`} · 🎯 ${esc((dept && dept.custom_name) || 'Mezon')}: ${k.custom_pct === null ? '—' : `${k.custom_pct}%`}\n\n` +
        `<b>KPI: ${k.total} ball</b>` +
        (config.kpiMode === 'gate' ? `\n🚦 KPI sharti: ${Number(k.kpi_eligible) === 1 ? '🟢 bajarildi' : `🔴 bajarilmadi — ${esc(k.kpi_fail || '')}`}` : '') +
        `${k.bonus_amount !== null ? `\n🏆 KPI: <b>${kpi.fmtMoney(k.bonus_amount)}</b>` : ''}` +
        `${k.salary !== null && k.salary !== undefined ? `\n💼 Oklad: ${kpi.fmtMoney(k.salary)}\n💰 Jami: <b>${kpi.fmtMoney(Number(k.salary) + (Number(k.bonus_amount) || 0))}</b>` : ''}` +
        `${k.note ? `\n💬 ${esc(k.note)}` : ''}\n\nBatafsil: «${ui.BTN.salary}»`,
    );
  } else if (k.status === 'excluded') {
    await notify.toUser(bot, k.tg_id, `⛔ <b>${time.monthName(k.month)}</b> — bu oy bonusdan chiqarildingiz.${k.note ? `\n💬 ${esc(k.note)}` : ''}\n\nSavollar bo'lsa rahbariyatga murojaat qiling.`);
  }
};

/** Qaror + xabar */
const decideKpi = async (bot, employeeId, month, status, byTgId) => {
  const k = await kpi.decide(employeeId, month, status, byTgId);
  await kpiDecisionNotice(bot, k);
  return k;
};

// ---------------------------------------------------------------------------
// HODIMLAR
// ---------------------------------------------------------------------------

/** Yangi qo'shilgan hodimga salom + menyu tugmasi */
/**
 * «Bajardim» uchun shart (5-okt qarori): bugun «Keldim» qilgan bo'lishi kerak — ishga kelmasdan vazifa bajarilmaydi.
 * Boshliq (hodim emas) — ozod. null — ruxsat; matn — rad sababi.
 */
const DONE_NEEDS_CHECKIN = `🔒 <b>Avval «${ui.BTN.checkIn}» bosing.</b>\nIshga kelganingiz qayd etilmaguncha vazifani «${ui.BTN.done}» qilib bo'lmaydi.`;
const DONE_AFTER_CHECKOUT = `🔒 <b>Siz bugun «${ui.BTN.checkOut}» qilgansiz.</b>
Ishdan ketgandan keyin vazifani «${ui.BTN.done}» qilib bo'lmaydi — ertaga «${ui.BTN.checkIn}» dan keyin belgilang.`;
/** «Bajardim» faqat ishda turganda: Keldim bor va Ketdim yo'q (boshliq ozod) */
const doneBlocked = async (emp) => {
  if (!emp || employees.isBoss(emp)) return null;
  const row = await attendance.get(emp.id);
  if (!row || !row.checked_in) return DONE_NEEDS_CHECKIN;
  return row.checked_out ? DONE_AFTER_CHECKOUT : null;
};

const welcome = async (bot, employee) => {
  await notify.toUser(
    bot, employee.tg_id,
    `🎉 <b>Xush kelibsiz, ${esc(employee.full_name)}!</b>\n\n` +
      `Siz tizimga <b>${employees.roleLabel(employee.role)}</b>${employee.department_name ? ` (${esc(employee.department_name)})` : ''} sifatida qo'shildingiz.\n\n` +
      `Ertaga ishga kelganingizda «${ui.BTN.checkIn}» tugmasini bosing. Qo'llanma: /yordam`,
    ui.kbForEmp(employee),
  );
  await webapp.setMenuFor(bot, employee.tg_id);
};

const roleNotice = (bot, e) =>
  notify.toUser(bot, e.tg_id, `🎖 Sizning rolingiz: <b>${employees.roleLabel(e.role)}</b>. Menyu yangilandi — /menu`, ui.kbForEmp(e));

const hrNotice = (bot, e) =>
  notify.toUser(bot, e.tg_id, `🧑‍💼 Siz <b>HR</b> etib belgilandingiz: hodimlarning kelmaslik va kechikish sabablari sizga keladi. Menyu — /menu`, ui.kbForEmp(e));

const modeNotice = (bot, u) => {
  const geo = require('../geo');
  return notify.toUser(
    bot, u.tg_id,
    employees.isField(u)
      ? `🚶 Siz endi <b>hudud (agent)</b> rejimidasiz.\n«${ui.BTN.checkIn}» — uyingizdan ${geo.prettyDistance(config.fieldMinDistanceM)} dan uzoqda bo'lsangiz qabul qilinadi (birinchi marta uy joylashuvini so'raydi).\nBorgan joylaringizda «${ui.BTN.visit}» → lokatsiya + video/audio.`
      : `🏢 Siz endi <b>ofis</b> rejimidasiz: «${ui.BTN.checkIn}» ofisda turib, video bilan.`,
    ui.kbForEmp(u),
  );
};

const homeClearedNotice = (bot, e) =>
  notify.toUser(bot, e.tg_id, `🏠 Uy joylashuvingiz direktor tomonidan tozalandi. <b>Uyda turib</b> «${ui.BTN.sendLocation}» tugmasi bilan qaytadan yuboring.`, ui.locationKeyboard());

/** Uy joylashuvi so'raladigan matn (eslatma va Keldim) */
const HOME_PROMPT = () =>
  `🏠 <b>Uy joylashuvingizni yuboring</b>\n\nSiz hudud (agent) rejimidasiz. <b>Hozir uyingizda</b> bo'lsangiz — pastdagi «${ui.BTN.sendLocation}» tugmasini bosing.\n` +
  `⚠️ Ko'chada yoki boshqa joyda turib yubormang: «Keldim» shu nuqtadan kamida ${require('../geo').prettyDistance(config.fieldMinDistanceM)} uzoqda qabul qilinadi. Keyin faqat boshliq o'zgartira oladi.`;

/**
 * 5-okt: uy joylashuvi yo'q hudud agentlariga eslatma (cron — har kuni 06:00 dan har 30 daqiqada).
 * Joylashuv saqlangach — bormaydi. Hodim boshqa bosqichda bo'lmasa, sessiya «awaiting_home_location» ga o'tadi.
 */
const remindHomeLocation = async (bot) => {
  const session = require('../session');
  let n = 0;
  for (const e of await employees.listStaff()) {
    if (!employees.isField(e) || employees.homeOf(e)) continue;
    const s = session.get(e.tg_id);
    if (!s.step) session.set(e.tg_id, { step: 'awaiting_home_location' });
    if (await notify.toUser(bot, e.tg_id, HOME_PROMPT(), ui.locationKeyboard())) n += 1;
    await require('../telegram').throttle();
  }
  return n;
};

/** Ishdan ketdi / qayta faol — menyu tugmasi ham */
const setActive = async (bot, e, active) => {
  if (active) await employees.activate(e.id); else await employees.deactivate(e.id);
  if (active) await webapp.setMenuFor(bot, e.tg_id);
  else if (!employees.isAdminId(e.tg_id)) await webapp.resetMenuFor(bot, e.tg_id);
};

// ---------------------------------------------------------------------------
// ISH VAQTI
// ---------------------------------------------------------------------------

/** Umumiy vaqt o'zgardi — tegishli hodimlarga xabar. Yuborilganlar soni */
const announceWorktime = async (bot, hhmm, all) => {
  let n = 0;
  for (const e of await employees.listStaff()) {
    if (!all && e.work_start) continue;
    if (await notify.toUser(bot, e.tg_id, `🕘 <b>Ish vaqti o'zgardi:</b> ish boshlanishi endi <b>${hhmm}</b>.\n${hhmm} + ${config.lateGraceMinutes} daqiqadan keyin kelish «kech» hisoblanadi.`)) n += 1;
    await tg.throttle();
  }
  return n;
};

// ---------------------------------------------------------------------------
// ESLATMA JADVALI (hodim so'raydi → direktor / HR tasdiqlaydi)
// ---------------------------------------------------------------------------

/** Amaldagi eslatma vaqtlari matni (HTML) */
const remindCurrentText = async (emp) => {
  const reminders = require('./reminders');
  const step = await reminders.globalStep();
  const times = reminders.timesFor(emp, step, employees.startMinutesOf(emp));
  const src = reminders.sourceOf(emp);
  const label = src === 'own' ? "<i>(shaxsiy jadval)</i>" : src === 'dept' ? "<i>(bo'lim jadvali)</i>" : `<i>(umumiy: har ${step} soatda)</i>`;
  return `${times.join(', ') || '—'} ${label}`;
};

/**
 * Boshliq eslatma vaqtini qo'yadi: { employee } yoki { department }; times null — tozalash (bo'lim/umumiyga qaytadi).
 * Tegishli hodimlarga qisqa xabar. Xabar olganlar soni
 */
const setReminderTimes = async (bot, { employee = null, department = null }, times, who) => {
  const reminders = require('./reminders');
  let targets = [];
  if (employee) {
    await reminders.setOwn(employee.id, times);
    targets = [employee];
  } else if (department) {
    await reminders.setDept(department.id, times);
    targets = (await employees.listByDepartment(department.id)).filter((e) => !e.remind_times);
  }
  let n = 0;
  for (const t of targets) {
    const fresh = await employees.byId(t.id);
    if (employees.isBoss(fresh)) continue;
    if (await notify.toUser(bot, fresh.tg_id, `🔔 Eslatma vaqtlaringiz o'zgardi (${esc(who)}): <b>${await remindCurrentText(fresh)}</b>`)) n += 1;
    await tg.throttle();
  }
  return n;
};

/**
 * So'rovni saqlaydi va rahbariyatga (boshliq + HR) yuboradi. Rahbariyatning o'zi (boshliq yoki HR) so'rasa —
 * tasdiqsiz darhol kuchga kiradi. { auto }
 */
const requestReminders = async (bot, emp, times, label) => {
  const reminders = require('./reminders');
  await reminders.request(emp.id, times);
  // eslatma jadvalini faqat boshliq tasdiqlaydi (HR emas); boshliqning o'zi — darhol
  if (employees.isBoss(emp)) {
    await reminders.approve(emp.id);
    return { auto: true };
  }
  const ids = (await employees.bossTgIds()).map(Number).filter((id) => id !== Number(emp.tg_id));
  const text =
    `🔔 <b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''} topshiriq eslatmalarini o'zgartirmoqchi:\n` +
    `➡️ <b>${esc(times.join(', '))}</b>${label ? ` (${esc(label)})` : ''}\nHozir: ${await remindCurrentText(emp)}\n\nTasdiqlaysizmi?`;
  for (const id of ids) {
    await notify.toUser(bot, id, text, ui.inline([[ui.cb('✅ Tasdiqlash', `rs:ok:${emp.id}`), ui.cb('❌ Rad etish', `rs:no:${emp.id}`)]]));
    await tg.throttle();
  }
  return { auto: false };
};

/** Qaror (ok — tasdiq). Kutilayotgan so'rov bo'lmasa null, aks holda vaqtlar matni */
const decideReminders = async (bot, emp, ok, who) => {
  const reminders = require('./reminders');
  if (!emp.remind_pending) return null;
  const times = reminders.listOf(emp.remind_pending).join(', ');
  if (ok) await reminders.approve(emp.id); else await reminders.reject(emp.id);
  await notify.toUser(
    bot, emp.tg_id,
    ok
      ? `✅ Eslatma jadvalingiz tasdiqlandi (${esc(who)}): endi topshiriq eslatmalari <b>${esc(times)}</b> da keladi.`
      : `❌ Eslatma vaqtini o'zgartirish so'rovingiz rad etildi (${esc(who)}). Eslatmalar avvalgidek keladi.`,
  );
  return times;
};

module.exports = {
  doneBlocked, DONE_NEEDS_CHECKIN, earlyLeaveMinutes, remindHomeLocation, HOME_PROMPT,
  remindCurrentText, requestReminders, decideReminders, setReminderTimes,
  parseTitle, splitTitles, mediaTitles, sendTaskMedia, ackTasks, assignTasks, addSelfTasks, completeBossTask, acceptTask,
  sendAnnouncement, resendAnnouncement, returnTask, cancelTask,
  taskReplyTarget, sendTaskReply, personLink, chatRecipients, startChat, sendChatMessage,
  lateNotice, lateNoticeRule, requestAbsence, checkOut, CHECKOUT_PROMPT, notifyTaskStarts, whenText, TASK_REPLY_OK, decideExcuse, markExcused,
  kpiDecisionNotice, decideKpi, welcome, roleNotice, hrNotice, modeNotice, homeClearedNotice, setActive, announceWorktime,
  recipientsLabel: org.recipientsLabel,
};
