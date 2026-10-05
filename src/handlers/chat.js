'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const tasks = require('../services/tasks');
const chats = require('../services/chats');
const access = require('../services/access');
const flows = require('../services/flows');
const picker = require('./picker');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * «💬 SAVOL-JAVOB» — bitta hodim bilan (yuzma-yuz), 2–3 tanlangan hodim, bo'lim(lar) yoki hammasi bilan chat.
 * Boshlaganda ishtirokchilarning lichkasi (tg://user havolasi) ko'rinadi — xohlasa to'g'ridan-to'g'ri lichkaga o'tadi.
 * Boshliq/direktor va HR — hamma bilan; bo'lim rahbari — o'z jamoasi + rahbariyat; hodim — o'z rahbari, HR va boshliq bilan.
 *   qa:start · qa:one, qa:o:<empId> · qa:all · qa:dl, qa:dt:<deptId>, qa:dok · qa:pick (qp:* picker) · qa:m:all|me (rejim)
 *   qa:r:<chatId>:<msgId|0> (javob yozish) · qa:v:<chatId> (chat) · qa:h (chatlarim) · qa:x
 *
 * QAYTARILGAN TOPSHIRIQQA JAVOB — tr:<taskId>: hodim → qaytargan (yoki bergan) odamga; tekshiruvchi → hodimga.
 */

const seeAll = (ctx) => Boolean(ctx.state.isAdmin || ctx.state.isHr);

/** Kim bilan gaplasha oladi — access.chatCandidates (ilova bilan bitta qoida) */
const candidates = (ctx) => access.chatCandidates(ctx.state);

const start = async (ctx) => {
  session.clear(ctx.from.id);
  const list = await candidates(ctx);
  const rows = [[cb('👤 Bitta odam bilan', 'qa:one')], [cb('☑️ Bir nechta odam (2, 3…)', 'qa:pick')]];
  if (seeAll(ctx)) rows.push([cb("🏢 Bo'lim(lar) bilan", 'qa:dl')], [cb(`👥 Hamma bilan (${list.length})`, 'qa:all')]);
  else if (ctx.state.isHead) rows.push([cb("👥 Bo'limim bilan (hammasi)", 'qa:all')]);
  rows.push([cb('📜 Chatlarim', 'qa:h'), cb(ui.BTN.cancel, 'qa:x')]);
  return render(
    ctx,
    `💬 <b>SAVOL-JAVOB</b>\n\nKim bilan gaplashamiz?\n<i>Savol yozasiz (matn, ovoz, video, rasm yoki fayl) — u botda keladi va «↩️ Javob yozish» bilan javob qaytaradi. ` +
      "Boshlaganda har bir odamning lichkasi ko'rinadi — xohlasangiz to'g'ridan-to'g'ri lichkaga o'tasiz.</i>",
    inline(rows),
  );
};

// --- kimlar bilan ---
const oneList = async (ctx) => {
  const list = await candidates(ctx);
  if (!list.length) return render(ctx, "Gaplashish uchun odam yo'q.", ui.backKeyboard('qa:start'));
  const rows = list.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}${employees.titleOf(e) ? ` · ${employees.titleOf(e)}` : ''}`.slice(0, 60), `qa:o:${e.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'qa:start')]);
  return render(ctx, '👤 <b>Kim bilan?</b>', inline(rows));
};

const deptList = async (ctx) => {
  const sel = new Set((session.get(ctx.from.id).qaDepts || []).map(Number));
  const all = await candidates(ctx);
  const rows = [];
  for (const d of await departments.listActive()) {
    const n = all.filter((e) => Number(e.department_id) === Number(d.id)).length;
    if (n) rows.push([cb(`${sel.has(Number(d.id)) ? '✅' : '▫️'} 🏢 ${d.name} (${n})`.slice(0, 50), `qa:dt:${d.id}`)]);
  }
  if (!rows.length) return render(ctx, "Hodimli bo'lim yo'q.", ui.backKeyboard('qa:start'));
  rows.push([cb(sel.size ? `➡️ Davom etish (${sel.size} bo'lim)` : '➡️ Davom etish', 'qa:dok'), cb('⬅️ Orqaga', 'qa:start')]);
  return render(ctx, "🏢 <b>Qaysi bo'limlar bilan?</b> Bir nechtasini belgilash mumkin.", inline(rows));
};

const peoplePick = picker.create({
  prefix: 'qp',
  allowed: (ctx) => Boolean(ctx.state.employee || ctx.state.isAdmin),
  candidates,
  backData: 'qa:start',
  title: (ctx, n) => `💬 <b>Kimlar bilan gaplashamiz?</b>${n ? ` — belgilandi: <b>${n}</b>` : ''}`,
  onDone: async (ctx, ids) => {
    const list = [];
    for (const id of ids) list.push(await employees.byId(id));
    return chosen(ctx, ids, ids.length === 1 ? `${list[0].full_name} bilan` : `Tanlanganlar: ${list.map((e) => e.full_name).join(', ')}`.slice(0, 300));
  },
});

/** Bir nechta odam bo'lsa — javoblar kimga ko'rinishini so'raymiz */
const chosen = async (ctx, ids, target) => {
  session.set(ctx.from.id, { qa: { ids, target }, pick: null, pickFor: null, qaDepts: null });
  if (ids.length === 1) return askText(ctx, 'all');
  return render(
    ctx,
    `💬 <b>${esc(target)}</b> — ${ids.length} kishi.\n\nJavoblar kimga ko'rinsin?`,
    inline([
      [cb("👥 Hammaga — guruh chat (hamma hammani ko'radi)", 'qa:m:all')],
      [cb('🔒 Faqat menga (har kim alohida javob beradi)', 'qa:m:me')],
      [cb('⬅️ Orqaga', 'qa:start')],
    ]),
  );
};

const askText = async (ctx, mode) => {
  const s = session.get(ctx.from.id);
  if (!s.qa || !Array.isArray(s.qa.ids)) { session.clear(ctx.from.id); return render(ctx, 'Sessiya eskirgan.'); }
  session.set(ctx.from.id, { step: 'chat_text', qa: { ...s.qa, mode } });
  const people = [];
  for (const id of s.qa.ids.slice(0, 30)) { const e = await employees.byId(id); if (e) people.push(e); }
  const lines = people.map((e) => `${employees.personIcon(e)} ${employees.contactHtml(e)}${employees.titleOf(e) ? ` · <i>${esc(employees.titleOf(e))}</i>` : ''}`);
  if (s.qa.ids.length > 30) lines.push(`… va yana ${s.qa.ids.length - 30} kishi`);
  const modeLine = s.qa.ids.length > 1 ? (mode === 'starter' ? '\n🔒 Javoblar faqat sizga keladi.' : "\n👥 Javoblar hamma ishtirokchiga ko'rinadi.") : '';
  await render(ctx, `💬 <b>${esc(s.qa.target)}</b> — ${s.qa.ids.length} kishi${modeLine}\n${ui.LINE}\n👤 <b>Lichkaga o'tish — ismni bosing:</b>\n${lines.join('\n')}`);
  return ctx.reply("✍️ Savol / xabaringizni yozing — yoki 🎤 ovoz, 🎥 video, 🖼 rasm, 📄 fayl yuboring:", ui.cancelKeyboard());
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

const sentLine = (r) => `${r.delivered}/${r.total} kishiga${r.delivered < r.total ? ` (⚠️ ${r.total - r.delivered} kishiga yetmadi — botni ochmagan yoki bloklagan)` : ''}`;

/** Birinchi xabar → chat yaratiladi va yuboriladi */
const createChat = async (ctx, body, media) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  if (!s.qa || !Array.isArray(s.qa.ids)) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const allowed = new Map((await candidates(ctx)).map((e) => [Number(e.id), e]));
  const targets = s.qa.ids.map(Number).filter((id) => allowed.has(id)).map((id) => allowed.get(id));
  if (!targets.length) return ctx.reply('Qabul qiluvchi topilmadi.', ui.kbFor(ctx));
  const r = await flows.startChat(botOf(ctx), ctx.state.actor, targets, { target: s.qa.target, mode: s.qa.mode === 'starter' ? 'starter' : 'all', body, media });
  await ctx.reply(
    `✅ <b>Yuborildi</b> — ${sentLine(r)}.\nJavoblar shu yerga keladi.`,
    { parse_mode: 'HTML', ...inline([[cb('📜 Chatni ochish', `qa:v:${r.chat.id}`)]]) },
  );
  return ctx.reply('👌', ui.kbFor(ctx));
};

// --- javob yozish ---
const replyLabel = async (chat, toTg, tgIds) => {
  if (toTg) {
    if (chats.isStarter(chat, toTg)) return esc(chat.starter_name || 'boshlovchi');
    const m = (await chats.members(chat.id)).find((x) => Number(x.tg_id) === Number(toTg));
    return esc(m ? m.name : String(toTg));
  }
  return tgIds.length === 1 ? 'suhbatdoshga' : `hamma ishtirokchiga (${tgIds.length})`;
};

const startReply = async (ctx, chatId, msgId) => {
  const chat = await chats.byId(chatId);
  if (!chat || !(await chats.isParticipant(chat, ctx.from.id))) return ctx.answerCbQuery('⛔️ Siz bu chatda emassiz');
  const replyMsg = Number(msgId) ? await chats.messageById(msgId) : null;
  if (replyMsg && Number(replyMsg.chat_id) !== Number(chat.id)) return ctx.answerCbQuery('Topilmadi');
  await ctx.answerCbQuery();
  const { toTg, tgIds } = await flows.chatRecipients(chat, ctx.from.id, replyMsg);
  if (!tgIds.length) return ctx.reply("Bu chatda boshqa ishtirokchi yo'q.");
  session.set(ctx.from.id, { step: 'chat_reply', qaReply: { chatId: chat.id, msgId: replyMsg ? replyMsg.id : 0 } });
  return ctx.reply(`✍️ Javobingizni yozing — kimga: <b>${await replyLabel(chat, toTg, tgIds)}</b>\n<i>Matn yoki 🎤 ovoz, 🎥 video, 🖼 rasm, 📄 fayl.</i>`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
};

const sendReply = async (ctx, body, media) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  const chat = s.qaReply ? await chats.byId(s.qaReply.chatId) : null;
  if (!chat || !(await chats.isParticipant(chat, ctx.from.id))) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const replyMsg = Number(s.qaReply.msgId) ? await chats.messageById(s.qaReply.msgId) : null;
  const r = await flows.sendChatMessage(botOf(ctx), ctx.state.actor, chat, { body, media, replyMsg });
  await ctx.reply(`✅ Yuborildi — ${sentLine(r)}.`, inline([[cb('📜 Chat', `qa:v:${chat.id}`)]]));
  return ctx.reply('👌', ui.kbFor(ctx));
};

// --- chat ko'rinishi, ro'yxat ---
const day = (iso) => (String(iso).slice(0, 10) === time.today() ? time.clock(iso) : `${time.prettyDate(String(iso).slice(0, 10))} ${time.clock(iso)}`);

const view = async (ctx, id) => {
  const chat = await chats.byId(id);
  if (!chat || !(await chats.isParticipant(chat, ctx.from.id))) return ctx.answerCbQuery('⛔️ Siz bu chatda emassiz');
  await ctx.answerCbQuery();
  const members = await chats.members(chat.id);
  const people = [
    `👑 ${flows.personLink(chat.starter_tg, chat.starter_name)} <i>(boshlagan)</i>`,
    ...members.slice(0, 25).map((m) => `${employees.personIcon(m)} ${employees.contactHtml({ tg_id: m.tg_id, full_name: m.name, username: m.username })}${Number(m.delivered) ? '' : ' 🚫'}`),
  ];
  if (members.length > 25) people.push(`… va yana ${members.length - 25} kishi`);
  const msgs = await chats.messagesFor(chat, ctx.from.id, 15);
  const me = Number(ctx.from.id);
  const lines = msgs.map((m) => {
    const who = Number(m.from_tg) === me ? '<b>Siz</b>' : `<b>${esc(m.from_name || '')}</b>`;
    const toWho = m.to_tg ? (Number(m.to_tg) === me ? ' → sizga' : ' → shaxsan') : '';
    const media = m.media_type ? `${ui.MEDIA_ICON[m.media_type] || '📎'} ` : '';
    const body = m.body ? esc(m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body) : '<i>media</i>';
    return `<i>${day(m.created_at)}</i> ${who}${toWho}: ${media}${body}`;
  });
  const modeLine = members.length > 1 ? (chat.mode === 'starter' ? ' · 🔒 javoblar boshlovchiga' : ' · 👥 guruh') : '';
  const writeLabel = chats.isStarter(chat, me) && members.length > 1 ? '✍️ Hammaga yozish' : '✍️ Yozish';
  return render(
    ctx,
    `💬 <b>${esc(chat.target || 'Chat')}</b>${modeLine}\n👤 <b>Lichkaga o'tish — ismni bosing:</b>\n${people.join('\n')}\n${ui.LINE}\n${lines.join('\n') || "<i>xabar yo'q</i>"}`,
    inline([[cb(writeLabel, `qa:r:${chat.id}:0`)], [cb('🔄 Yangilash', `qa:v:${chat.id}`), cb('📜 Chatlarim', 'qa:h')]]),
  );
};

const history = async (ctx) => {
  const list = await chats.listFor(ctx.from.id, 15);
  if (!list.length) return render(ctx, '📜 Hali chat yo\'q.', inline([[cb('💬 Yangi chat', 'qa:start')]]));
  const rows = list.map((c) => [cb(`${String(c.created_at).slice(5, 10).split('-').reverse().join('.')} · ${chats.isStarter(c, ctx.from.id) ? '' : `${(c.starter_name || '').split(' ')[0]}: `}${(c.target || '').replace(/ bilan$/, '')} · ${c.title || ''}`.replace(/\s+/g, ' ').slice(0, 60), `qa:v:${c.id}`)]);
  rows.push([cb('💬 Yangi chat', 'qa:start')]);
  return render(ctx, `📜 <b>Chatlarim</b> — oxirgi ${list.length} ta:`, inline(rows));
};

// ---------------------------------------------------------------------------
// QAYTARILGAN TOPSHIRIQQA JAVOB (tr:)
// ---------------------------------------------------------------------------

/** Kim yoza oladi: topshiriq egasi, uni qaytargan / bergan odam, tekshirish huquqi borlar */
const taskReplyGuard = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t) return null;
  const actor = ctx.state.actor;
  if (!access.canReplyTask(actor, t, await employees.byId(t.employee_id))) return null;
  const toTg = flows.taskReplyTarget(actor, t);
  return toTg ? { t, toTg } : null;
};

const startTaskReply = async (ctx, id) => {
  const g = await taskReplyGuard(ctx, id);
  if (!g) return ctx.answerCbQuery("⛔️ Bu topshiriq bo'yicha yoza olmaysiz");
  await ctx.answerCbQuery();
  const to = await employees.byTgId(g.toTg);
  session.set(ctx.from.id, { step: 'task_reply', trTask: g.t.id });
  return ctx.reply(
    `💬 <b>${esc(g.t.title)}</b> bo'yicha javob — kimga: <b>${esc(to ? to.full_name : 'rahbariyat')}</b>${to ? `\n👤 Lichka: ${employees.contactHtml(to)}` : ''}\n\n✍️ Yozing — yoki 🎤 ovoz, 🎥 video, 🖼 rasm, 📄 fayl yuboring:`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const sendTaskReply = async (ctx, body, media) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  const g = s.trTask ? await taskReplyGuard(ctx, s.trTask) : null;
  if (!g) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const r = await flows.sendTaskReply(botOf(ctx), ctx.state.actor, g.t, g.toTg, { body, media });
  return ctx.reply(r.delivered ? '✅ Javobingiz yuborildi.' : '⚠️ Yetkazib bo\'lmadi (qabul qiluvchi botni ochmagan yoki bloklagan). Javob bazada saqlandi.', ui.kbFor(ctx));
};

/** «👌 Xo'p, tushundim» — topshiriq egasi bir bosishda javob qaytaradi (yozishmaga ham yoziladi) */
const taskReplyOk = async (ctx, id) => {
  const g = await taskReplyGuard(ctx, id);
  const me = ctx.state.employee;
  if (!g || !me || Number(g.t.employee_id) !== Number(me.id)) return ctx.answerCbQuery("⛔️ Bu topshiriq bo'yicha yoza olmaysiz");
  const since = String(g.t.reviewed_at || '');
  if ((await tasks.replies(g.t.id)).some((r) => Number(r.from_tg) === Number(ctx.from.id) && r.body === flows.TASK_REPLY_OK && String(r.created_at || '') >= since)) {
    return ctx.answerCbQuery("✅ «Xo'p, tushundim» allaqachon yuborilgan");
  }
  const r = await flows.sendTaskReply(botOf(ctx), ctx.state.actor, g.t, g.toTg, { body: flows.TASK_REPLY_OK });
  await ctx.answerCbQuery(r.delivered ? "✅ «Xo'p, tushundim» yuborildi" : "Bazada saqlandi (yetkazib bo'lmadi)");
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[ui.cb("✅ Xo'p dedingiz", 'tr:sent'), ui.cb("💬 O'z javobim", `tr:${g.t.id}`)]] }); } catch { /* eski xabar */ }
};

// ---------------------------------------------------------------------------

/** Matn — app.js STEP_HANDLERS dan (chat_text, chat_reply, task_reply) */
const handleText = (ctx) => {
  const step = session.get(ctx.from.id).step;
  const body = String(ctx.message.text || '').trim().slice(0, 3500);
  if (!body) return ctx.reply("Matn bo'sh. Qaytadan yozing:", ui.cancelKeyboard());
  if (step === 'chat_text') return createChat(ctx, body, null);
  if (step === 'chat_reply') return sendReply(ctx, body, null);
  return sendTaskReply(ctx, body.slice(0, 2000), null);
};

const STEPS = ['chat_text', 'chat_reply', 'task_reply'];

const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const step = session.get(ctx.from.id).step;
  if (!STEPS.includes(step) || !(ctx.state.employee || ctx.state.isAdmin)) return next();
  const media = mediaOf(ctx.message);
  if (!media) return ctx.reply('Matn, ovozli xabar, video, rasm yoki fayl yuboring.', ui.cancelKeyboard());
  const caption = String(ctx.message.caption || '').trim().slice(0, 900) || null;
  if (step === 'chat_text') return createChat(ctx, caption, media);
  if (step === 'chat_reply') return sendReply(ctx, caption, media);
  return sendTaskReply(ctx, caption, media);
};

const register = (bot) => {
  const registered = (ctx) => Boolean(ctx.state.employee || ctx.state.isAdmin);
  const guarded = (fn) => async (ctx) => (registered(ctx) ? fn(ctx) : ctx.answerCbQuery('⛔️'));
  bot.hears(ui.BTN.chat, (ctx) => (registered(ctx) ? start(ctx) : undefined));
  bot.command('chat', (ctx) => (registered(ctx) ? start(ctx) : undefined));
  bot.action('qa:start', guarded(async (ctx) => { await ctx.answerCbQuery(); return start(ctx); }));
  bot.action('qa:one', guarded(async (ctx) => { await ctx.answerCbQuery(); return oneList(ctx); }));
  bot.action(/^qa:o:(\d+)$/, guarded(async (ctx) => {
    const e = (await candidates(ctx)).find((x) => Number(x.id) === Number(ctx.match[1]));
    if (!e) return ctx.answerCbQuery('Topilmadi');
    await ctx.answerCbQuery();
    return chosen(ctx, [Number(e.id)], `${e.full_name} bilan`);
  }));
  bot.action('qa:all', guarded(async (ctx) => {
    if (!seeAll(ctx) && !ctx.state.isHead) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    const list = seeAll(ctx) ? await candidates(ctx) : await employees.teamOf(ctx.state.employee);
    if (!list.length) return render(ctx, "Hodim yo'q.", ui.backKeyboard('qa:start'));
    return chosen(ctx, list.map((e) => Number(e.id)), seeAll(ctx) ? 'Hamma bilan' : `Bo'limim: ${ctx.state.employee.department_name || ''}`);
  }));
  bot.action('qa:dl', guarded(async (ctx) => {
    if (!seeAll(ctx)) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { qaDepts: [] });
    return deptList(ctx);
  }));
  bot.action(/^qa:dt:(\d+)$/, guarded(async (ctx) => {
    if (!seeAll(ctx)) return ctx.answerCbQuery('⛔️');
    const id = Number(ctx.match[1]);
    const cur = (session.get(ctx.from.id).qaDepts || []).map(Number);
    session.set(ctx.from.id, { qaDepts: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    await ctx.answerCbQuery();
    return deptList(ctx);
  }));
  bot.action('qa:dok', guarded(async (ctx) => {
    if (!seeAll(ctx)) return ctx.answerCbQuery('⛔️');
    const sel = (session.get(ctx.from.id).qaDepts || []).map(Number);
    if (!sel.length) return ctx.answerCbQuery("Kamida bitta bo'limni belgilang", { show_alert: true });
    await ctx.answerCbQuery();
    const ids = (await candidates(ctx)).filter((e) => sel.includes(Number(e.department_id))).map((e) => Number(e.id));
    const names = (await departments.listActive()).filter((d) => sel.includes(Number(d.id))).map((d) => d.name);
    if (!ids.length) return render(ctx, "Bu bo'limlarda hodim yo'q.", ui.backKeyboard('qa:start'));
    return chosen(ctx, ids, `Bo'lim${names.length > 1 ? 'lar' : ''}: ${names.join(', ')}`);
  }));
  bot.action('qa:pick', guarded(async (ctx) => { await ctx.answerCbQuery(); return peoplePick.show(ctx, { reset: true }); }));
  peoplePick.register(bot);
  bot.action(/^qa:m:(all|me)$/, guarded(async (ctx) => { await ctx.answerCbQuery(); return askText(ctx, ctx.match[1] === 'me' ? 'starter' : 'all'); }));
  bot.action(/^qa:r:(\d+):(\d+)$/, guarded((ctx) => startReply(ctx, ctx.match[1], ctx.match[2])));
  bot.action(/^qa:v:(\d+)$/, guarded((ctx) => view(ctx, ctx.match[1])));
  bot.action('qa:h', guarded(async (ctx) => { await ctx.answerCbQuery(); return history(ctx); }));
  bot.action('qa:x', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); return render(ctx, '❌ Bekor qilindi.'); });
  bot.action(/^tr:(\d+)$/, guarded((ctx) => startTaskReply(ctx, ctx.match[1])));
  bot.action(/^tr:ok:(\d+)$/, guarded((ctx) => taskReplyOk(ctx, ctx.match[1])));
  bot.action('tr:sent', (ctx) => ctx.answerCbQuery("✅ Javobingiz yuborilgan"));
  bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], onMedia);
};

module.exports = { register, handleText, start, candidates };
