'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render, args } = require('../render');
const tasks = require('../services/tasks');
const employees = require('../services/employees');
const departments = require('../services/departments');
const notify = require('../services/notify');
const activity = require('../services/activity');
const reports = require('../services/reports');
const { notRegistered } = require('./common');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/** '!Muhim ish' → { title:'Muhim ish', priority:'high' } */
const parseTitle = (raw) => {
  const s = String(raw || '').trim();
  const high = /^[!❗🔥]/.test(s);
  return { title: s.replace(/^[!❗🔥]+\s*/, '').slice(0, 500), priority: high ? 'high' : 'normal' };
};

const dueFromDays = (n) => time.addDays(time.today(), Number(n));

const mustEmployee = (ctx) => {
  if (ctx.state.employee) return true;
  if (ctx.state.isAdmin) ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz — bu bo'lim hodimlar uchun. Panel → «➕ Hodim qo'shish» orqali o'zingizni qo'shing.");
  else notRegistered(ctx);
  return false;
};

// ---------------------------------------------------------------------------
// TOPSHIRIQLARIM
// ---------------------------------------------------------------------------

const showMyTasks = async (ctx) => {
  if (!mustEmployee(ctx)) return;
  const emp = ctx.state.employee;
  const open = await tasks.openFor(emp.id);
  const awaiting = await tasks.awaitingReviewFor(emp.id);
  activity.mark(ctx, 'my_tasks');
  const text =
    `📋 <b>MISSIYALARIM</b> · ${time.prettyDate(time.today())}\n${ui.LINE}\n` +
    `⏳ <b>Ochiq (${open.length}):</b>\n${ui.taskList(open)}` +
    (awaiting.length ? `\n\n🕓 <b>Tekshiruvda (${awaiting.length}):</b>\n${ui.taskList(awaiting)}` : '') +
    (open.length ? `\n\n⚙️ tugmasi — tahrirlash / muddat / o'chirish (faqat o'zingiz yozganlar).` : '');
  return render(ctx, text, ui.manageKeyboard(open));
};

const canEdit = (ctx, t) => {
  if (ctx.state.isAdmin) return true;
  const me = ctx.state.employee;
  if (!me) return false;
  if (Number(t.employee_id) === Number(me.id)) return t.source === 'self';
  return ctx.state.isHead && Number(t.department_id) === Number(me.department_id);
};

const showTaskMenu = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t || t.status !== 'active') return render(ctx, "Topshiriq topilmadi yoki yopilgan.", ui.backKeyboard('tk:list', "⬅️ Ro'yxatga"));
  const mine = ctx.state.employee && Number(t.employee_id) === Number(ctx.state.employee.id);
  if (!canEdit(ctx, t)) {
    return render(ctx, `${ui.taskLine(t, 1, { withName: !mine })}\n\n🔒 Bu topshiriqni <b>${ui.SOURCE_LABEL[t.source]}</b> bergan — faqat u o'zgartira oladi.`, ui.backKeyboard('tk:list', "⬅️ Ro'yxatga"));
  }
  return render(ctx, `⚙️ ${ui.taskLine(t, 1, { withName: !mine })}${t.review_note ? `\n\n💬 Tekshiruvchi: «${esc(t.review_note)}»` : ''}`, ui.taskMenuKeyboard(t));
};

// ---------------------------------------------------------------------------
// O'ZIMGA VAZIFA
// ---------------------------------------------------------------------------

const startSelfTask = async (ctx) => {
  if (!mustEmployee(ctx)) return;
  session.set(ctx.from.id, { step: 'self_task_text' });
  return ctx.reply(
    `➕ <b>Missiya matnini yozing.</b> Bir nechta bo'lsa — har birini yangi qatorda.\n\n<i>Misol:</i>\n<code>Xitoydan kelgan yuklarni ro'yxatga olish\n!Mijoz Akbar bilan shartnoma imzolash</code>\n\n<i>Boshiga ! qo'ysangiz — muhim. Muddatni keyingi qadamda tanlaysiz.</i>`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const handleSelfTaskText = async (ctx) => {
  const lines = ctx.message.text.split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return ctx.reply('Matn bo\'sh. Qaytadan yozing:', ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'self_task_due', titles: lines.slice(0, 20) });
  activity.mark(ctx, 'note', { title: lines.join(' | '), detail: 'missiya matni sifatida yozdi' });
  await ctx.reply(`📝 ${lines.length} ta missiya. Muddatini tanlang:`, { reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('st'));
};

const createSelfTasks = async (ctx, dueDate) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.titles || !emp) return render(ctx, 'Sessiya eskirgan. Qaytadan boshlang.');
  const created = [];
  for (const raw of s.titles) {
    const { title, priority } = parseTitle(raw);
    if (title) created.push(await tasks.create({ employeeId: emp.id, title, dueDate, createdBy: ctx.from.id, source: 'self', priority }));
  }
  session.clear(ctx.from.id);
  created.forEach((t) => activity.mark(ctx, 'task_add', { title: t.title, detail: `muddat ${time.prettyDate(dueDate)}` }));
  await render(ctx, `✅ <b>${created.length} ta missiya qo'shildi</b> — muddat: ${time.prettyDate(dueDate)}\n\n${ui.taskList(created)}`);
  await ctx.reply('👌', ui.kbFor(ctx));
  await notify.toReviewers(botOf(ctx), emp, `📝 <b>${esc(emp.full_name)}</b> o'ziga ${created.length} ta missiya yozdi (muddat ${time.prettyDate(dueDate)}):\n${ui.taskList(created)}`);
};

// ---------------------------------------------------------------------------
// TOPSHIRIQ BERISH (boshliq → o'z bo'limi, direktor → hamma)
// ---------------------------------------------------------------------------

const employeeButtons = (list, prefix, back) => {
  const rows = list.map((e) => [cb(`${ui.roleIcon(e.role)} ${e.full_name}${e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `${prefix}:${e.id}`)]);
  rows.push([cb(ui.BTN.cancel, back)]);
  return inline(rows);
};

const startAssign = async (ctx) => {
  if (!ctx.state.isManager) return ctx.reply("⛔️ Topshiriq berish faqat bo'lim boshlig'i va direktor uchun.");
  session.set(ctx.from.id, { step: 'assign_pick', assign: {} });
  if (ctx.state.isAdmin) {
    const depts = await departments.listActive();
    const rows = depts.map((d) => [cb(`🏢 ${d.name}`, `as:dept:${d.id}`)]);
    rows.push([cb('👥 Hamma hodimlar', 'as:dept:0')], [cb(ui.BTN.cancel, 'as:cancel')]);
    return render(ctx, `📤 <b>Kimga topshiriq berasiz?</b>\nAvval bo'limni tanlang:`, inline(rows));
  }
  const me = ctx.state.employee;
  const list = (await employees.listByDepartment(me.department_id)).filter((e) => Number(e.id) !== Number(me.id));
  if (!list.length) return render(ctx, "Bo'limingizda boshqa hodim yo'q.");
  return render(ctx, `📤 <b>Kimga topshiriq berasiz?</b> (${esc(me.department_name)})`, employeeButtons(list, 'as:emp', 'as:cancel'));
};

const pickDept = async (ctx, deptId) => {
  const list = deptId ? await employees.listByDepartment(deptId) : await employees.listActive();
  const mine = ctx.state.employee ? Number(ctx.state.employee.id) : -1;
  const filtered = list.filter((e) => Number(e.id) !== mine);
  if (!filtered.length) return render(ctx, "Bu bo'limda hodim yo'q.", ui.backKeyboard('as:start'));
  return render(ctx, `📤 <b>Kimga?</b>`, employeeButtons(filtered, 'as:emp', 'as:cancel'));
};

const pickEmployee = async (ctx, empId) => {
  const target = await employees.byId(empId);
  if (!target || !target.active) return ctx.answerCbQuery('Hodim topilmadi');
  if (!employees.canManage(ctx.state.employee, ctx.state.isAdmin, target)) return ctx.answerCbQuery("⛔️ Bu sizning bo'limingiz emas");
  session.set(ctx.from.id, { step: 'assign_text', assign: { employeeId: target.id } });
  await render(ctx, `📤 <b>${esc(target.full_name)}</b>${target.position ? ` (${esc(target.position)})` : ''} ga topshiriq.`);
  return ctx.reply(`✍️ Topshiriq matnini yozing (bir nechta — har biri yangi qatorda; boshiga <b>!</b> — muhim):`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
};

const handleAssignText = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.assign || !s.assign.employeeId) return ctx.reply('Sessiya eskirgan. Qaytadan boshlang.', ui.kbFor(ctx));
  const lines = ctx.message.text.split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return ctx.reply("Matn bo'sh. Qaytadan yozing:", ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'assign_due', assign: { ...s.assign, titles: lines.slice(0, 20) } });
  await ctx.reply(`📝 ${lines.length} ta topshiriq. Muddatini tanlang:`, { reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('as'));
};

const createAssigned = async (ctx, dueDate) => {
  const s = session.get(ctx.from.id);
  if (!s.assign || !s.assign.titles) return render(ctx, 'Sessiya eskirgan.');
  const target = await employees.byId(s.assign.employeeId);
  if (!target) return render(ctx, 'Hodim topilmadi.');
  const source = ctx.state.isAdmin ? 'admin' : 'head';
  const created = [];
  for (const raw of s.assign.titles) {
    const { title, priority } = parseTitle(raw);
    if (title) created.push(await tasks.create({ employeeId: target.id, title, dueDate, createdBy: ctx.from.id, source, priority }));
  }
  session.clear(ctx.from.id);
  const giver = ctx.state.employee ? ctx.state.employee.full_name : 'Direktor';
  created.forEach((t) => activity.mark(ctx, 'assign', { title: t.title, detail: `→ ${target.full_name}` }));
  created.forEach((t) => activity.track(target, 'assigned', { title: t.title, detail: `${giver} berdi · muddat ${time.prettyDate(dueDate)}` }));
  await render(ctx, `✅ <b>${esc(target.full_name)}</b> ga ${created.length} ta topshiriq berildi (muddat: ${time.prettyDate(dueDate)}):\n\n${ui.taskList(created)}`);
  await ctx.reply('👌', ui.kbFor(ctx));
  await notify.toUser(
    botOf(ctx), target.tg_id,
    `📥 <b>Yangi topshiriq!</b> — <i>${esc(giver)}</i>\n⏱ Muddat: <b>${time.prettyDate(dueDate)}</b>\n\n${ui.taskList(created)}\n\nBajargach «${ui.BTN.done}» bilan belgilang.`,
    ui.mainKeyboard({ isAdmin: target.role === 'admin', isHead: target.role === 'head' }),
  );
  if (source === 'head') {
    await notify.toAdmins(botOf(ctx), `📤 <b>${esc(giver)}</b> → <b>${esc(target.full_name)}</b>: ${created.length} ta topshiriq (${time.prettyDate(dueDate)})\n${ui.taskList(created)}`, {}, ctx.from.id);
  }
};

/** Yozilgan sana (st / as / tk muddat uchun) */
const handleTypedDate = async (ctx) => {
  const s = session.get(ctx.from.id);
  const d = time.parseDate(ctx.message.text);
  if (!d) return ctx.reply('Sana tushunilmadi. Masalan: 25.09 yoki 25.09.2026 yoki 25-sentabr', ui.cancelKeyboard());
  if (d < time.today()) return ctx.reply("Muddat o'tgan sana bo'lishi mumkin emas. Qaytadan:", ui.cancelKeyboard());
  if (s.dateFor === 'st') return createSelfTasks(ctx, d);
  if (s.dateFor === 'as') return createAssigned(ctx, d);
  if (s.dateFor === 'tk' && s.taskId) {
    await tasks.setDue(s.taskId, d);
    session.clear(ctx.from.id);
    await ctx.reply(`📆 Muddat: ${time.prettyDate(d)}`, ui.kbFor(ctx));
    return showTaskMenu(ctx, s.taskId);
  }
  session.clear(ctx.from.id);
  return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
};

const askTypedDate = (ctx, dateFor, extra = {}) => {
  session.set(ctx.from.id, { step: 'typed_date', dateFor, ...extra });
  return ctx.reply('📆 Sanani yozing (masalan 25.09 yoki 25-sentabr):', ui.cancelKeyboard());
};

// ---------------------------------------------------------------------------
// BAJARDIM (+ isbot)
// ---------------------------------------------------------------------------

const showDone = async (ctx) => {
  if (!mustEmployee(ctx)) return;
  const emp = ctx.state.employee;
  const open = await tasks.openFor(emp.id);
  const doneToday = await tasks.doneOn(emp.id);
  return render(ctx, ui.doneChecklist(open, doneToday), ui.doneKeyboard(open));
};

const pickDone = async (ctx, id) => {
  const emp = ctx.state.employee;
  const t = await tasks.byId(id);
  if (!t || Number(t.employee_id) !== Number(emp.id) || t.status !== 'active') return ctx.answerCbQuery('Topshiriq ochiq emas');
  session.set(ctx.from.id, { step: 'done_proof', doneTaskId: t.id });
  await ctx.answerCbQuery();
  return render(
    ctx,
    `📎 <b>${esc(t.title)}</b>\n\nIsbot sifatida <b>rasm yoki video</b> yuboring (ixtiyoriy, izoh yozsangiz ham bo'ladi) — yoki isbotsiz yuboring.`,
    ui.proofKeyboard(),
  );
};

const finishDone = async (ctx, proof) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.doneTaskId || !emp) return;
  const res = await tasks.markDone(s.doneTaskId, emp.id, proof);
  session.clear(ctx.from.id);
  if (!res.ok) return ctx.reply('Topshiriq ochiq emas.', ui.kbFor(ctx));
  const t = res.task;
  const overdue = String(t.done_at).slice(0, 10) > t.due_date;
  const left = (await tasks.openFor(emp.id)).length;
  activity.mark(ctx, 'task_done', { title: t.title, detail: `${left ? `yana ${left} ta qoldi` : 'barcha ishlar tugadi'}${proof ? ' · isbot bilan' : ''}` });
  const text = `✅ <b>${esc(t.title)}</b> — tekshiruvga yuborildi${proof ? ' (isbot bilan)' : ''}.${overdue ? '\n⚠️ Muddatdan kech bajarildi.' : ''}\n<i>${left ? `Qolgan: ${left} ta` : '🎉 Ochiq missiya qolmadi!'}</i>`;
  if (ctx.updateType === 'callback_query') await render(ctx, text); else await ctx.reply(text, { parse_mode: 'HTML' });
  await ctx.reply('👌', ui.kbFor(ctx));
  if (config.announceDone) {
    await notify.toGroup(botOf(ctx), `✅ ${reports.mentionHtml(emp)} — «<b>${esc(t.title)}</b>» bajarildi · ${time.clock(t.done_at)}\n<i>${left ? `Qolgan missiyalar: ${left} ta` : '🎉 Barcha missiyalar bajarildi!'}</i>`);
  }
  await notify.toReviewers(
    botOf(ctx), emp,
    `🕓 <b>${esc(emp.full_name)}</b> bajardi: <b>${esc(t.title)}</b>\n` +
      `⏱ muddat ${time.prettyDate(t.due_date)} · bajarildi ${time.clock(t.done_at)}${overdue ? ' 🔴 <i>kech</i>' : ' ✅'}` +
      (proof && proof.note ? `\n💬 «${esc(proof.note)}»` : '') + (t.source !== 'self' ? '' : '\n<i>(o\'zi yozgan vazifa)</i>') +
      `\n\nQabul qilasizmi?`,
    ui.reviewKeyboard(t.id),
    proof && proof.fileId ? proof : null,
  );
};

/** Rasm / video / hujjat keldi — done_proof bosqichida bo'lsa isbot */
const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const s = session.get(ctx.from.id);
  if (s.step !== 'done_proof') return next();
  const m = ctx.message;
  let proof = null;
  if (m.photo && m.photo.length) proof = { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  else if (m.video) proof = { type: 'video', fileId: m.video.file_id };
  else if (m.document) proof = { type: 'document', fileId: m.document.file_id };
  if (!proof) return next();
  proof.note = (m.caption || '').trim().slice(0, 300) || null;
  return finishDone(ctx, proof);
};

// ---------------------------------------------------------------------------
// TEKSHIRUV (qabul / qaytarish)
// ---------------------------------------------------------------------------

const reviewScope = (ctx) => (ctx.state.isAdmin ? null : ctx.state.employee.department_id);

const showReview = async (ctx) => {
  if (!ctx.state.isManager) return ctx.reply('⛔️ Faqat boshliq va direktor uchun.');
  const list = await tasks.pendingReview(reviewScope(ctx));
  if (!list.length) return render(ctx, '🔎 Tekshiruvni kutayotgan ish yo\'q. ✅');
  const rows = list.map((t) => [cb(`🕓 ${t.full_name.split(' ')[0]}: ${t.title.slice(0, 35)}`, `rv:view:${t.id}`)]);
  rows.push([cb('🔄 Yangilash', 'rv:list')]);
  return render(ctx, `🔎 <b>TEKSHIRUV (${list.length})</b>\n\n${ui.taskList(list, { withName: true })}\n\n👇 Birini tanlang.`, inline(rows));
};

const viewReview = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t || t.status !== 'done') return ctx.answerCbQuery('Bu ish tekshiruvda emas');
  const emp = await employees.byId(t.employee_id);
  if (!employees.canManage(ctx.state.employee, ctx.state.isAdmin, emp)) return ctx.answerCbQuery("⛔️ Bu sizning bo'limingiz emas");
  await ctx.answerCbQuery();
  const overdue = String(t.done_at).slice(0, 10) > t.due_date;
  const caption = `🕓 <b>${esc(t.full_name)}</b>: <b>${esc(t.title)}</b>\n⏱ muddat ${time.prettyDate(t.due_date)} · bajarildi ${String(t.done_at).slice(0, 10) === time.today() ? time.clock(t.done_at) : time.prettyDate(String(t.done_at).slice(0, 10))}${overdue ? ' 🔴 kech' : ' ✅'}${t.proof_note ? `\n💬 «${esc(t.proof_note)}»` : ''}`;
  if (t.proof_file_id) return notify.sendProof(botOf(ctx), ctx.chat.id, { type: t.proof_type, fileId: t.proof_file_id }, caption, ui.reviewKeyboard(t.id));
  return ctx.reply(`${caption}\n<i>(isbot biriktirilmagan)</i>`, { parse_mode: 'HTML', ...ui.reviewKeyboard(t.id) });
};

const reviewGuard = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t) { await ctx.answerCbQuery('Topilmadi'); return null; }
  if (t.status !== 'done') { await ctx.answerCbQuery('Bu ish allaqachon ko\'rib chiqilgan'); return null; }
  const emp = await employees.byId(t.employee_id);
  if (!ctx.state.isManager || !employees.canManage(ctx.state.employee, ctx.state.isAdmin, emp) || Number(emp.tg_id) === Number(ctx.from.id)) {
    await ctx.answerCbQuery('⛔️ Ruxsat yo\'q'); return null;
  }
  return { t, emp };
};

/** Xabar rasm bo'lsa caption, matn bo'lsa text tahrirlanadi */
const editAny = async (ctx, text) => {
  try {
    if (ctx.callbackQuery.message && (ctx.callbackQuery.message.photo || ctx.callbackQuery.message.video || ctx.callbackQuery.message.document)) {
      return await ctx.editMessageCaption(text, { parse_mode: 'HTML' });
    }
    return await render(ctx, text);
  } catch { return ctx.reply(text, { parse_mode: 'HTML' }); }
};

const doAccept = async (ctx, id) => {
  const g = await reviewGuard(ctx, id);
  if (!g) return;
  const res = await tasks.accept(id, ctx.from.id);
  activity.mark(ctx, 'review_ok', { title: g.t.title, detail: g.emp.full_name });
  await ctx.answerCbQuery('Qabul qilindi ✅');
  const onTime = tasks.isOnTime(res.task);
  await editAny(ctx, `✅ <b>Qabul qilindi</b> — ${esc(g.emp.full_name)}: ${esc(g.t.title)}${onTime ? '' : ' <i>(muddatdan kech)</i>'}`);
  await notify.toUser(botOf(ctx), g.emp.tg_id, `✅ <b>Qabul qilindi:</b> ${esc(g.t.title)}${onTime ? ' 👏' : '\n<i>Muddatdan kech bajarilgani KPI da hisobga olinadi.</i>'}`);
};

const startReturn = async (ctx, id) => {
  const g = await reviewGuard(ctx, id);
  if (!g) return;
  session.set(ctx.from.id, { step: 'return_note', returnTaskId: id });
  await ctx.answerCbQuery();
  return ctx.reply(`↩️ <b>${esc(g.t.title)}</b> — nima uchun qaytaryapsiz? Izoh yozing (hodim ko'radi) yoki «${ui.BTN.skip}».`, { parse_mode: 'HTML', ...ui.skipKeyboard() });
};

const handleReturnNote = async (ctx, { skip = false } = {}) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  if (!s.returnTaskId) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const note = skip ? null : ctx.message.text.trim().slice(0, 300);
  const res = await tasks.returnBack(s.returnTaskId, ctx.from.id, note);
  if (!res.ok) return ctx.reply("Bu ish allaqachon ko'rib chiqilgan.", ui.kbFor(ctx));
  const t = res.task;
  activity.mark(ctx, 'review_back', { title: t.title, detail: note });
  await ctx.reply(`↩️ Qaytarildi: <b>${esc(t.title)}</b>${note ? `\n«${esc(note)}»` : ''}`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  await notify.toUser(botOf(ctx), t.tg_id, `↩️ <b>Qaytarildi:</b> ${esc(t.title)}${note ? `\n💬 «${esc(note)}»` : ''}\n\nQayta bajarib «${ui.BTN.done}» bosing. Muddat: ${time.prettyDate(t.due_date)}.`);
};

// ---------------------------------------------------------------------------
// TAHRIRLASH / MUDDAT / O'CHIRISH (tk:)
// ---------------------------------------------------------------------------

const editGuard = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t || t.status !== 'active') { await ctx.answerCbQuery('Topshiriq ochiq emas'); return null; }
  if (!canEdit(ctx, t)) { await ctx.answerCbQuery("⛔️ O'zgartira olmaysiz"); return null; }
  return t;
};

const handleEditTitle = async (ctx) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  if (!s.taskId) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const { title, priority } = parseTitle(ctx.message.text);
  if (!title) return ctx.reply("Matn bo'sh.", ui.kbFor(ctx));
  await tasks.rename(s.taskId, title);
  if (priority === 'high') await tasks.setPriority(s.taskId, 'high');
  activity.mark(ctx, 'task_edit', { title });
  await ctx.reply('✏️ Saqlandi.', ui.kbFor(ctx));
  return showTaskMenu(ctx, s.taskId);
};

/** Kun ichida paydo bo'lgan ishni bugunga tez qo'shish: /bugun <matn> */
const addTodayTask = async (ctx) => {
  if (!mustEmployee(ctx)) return;
  const emp = ctx.state.employee;
  const arg = args(ctx);
  if (!arg) {
    return ctx.reply(
      "📌 Bugungi topshiriqni yozing:\n<code>/bugun Yangi mijoz bilan uchrashuv</code>\n\nBir nechta bo'lsa har birini yangi qatorga yozing. Bu ish <b>bugundan</b> faol bo'ladi va kun yakuni hisobotiga tushadi.",
      { parse_mode: 'HTML' },
    );
  }
  const lines = arg.split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
  const today = time.today();
  const created = [];
  for (const raw of lines.slice(0, 20)) {
    const { title, priority } = parseTitle(raw);
    if (title) created.push(await tasks.create({ employeeId: emp.id, title, dueDate: today, createdBy: ctx.from.id, source: 'self', priority }));
  }
  if (!created.length) return ctx.reply('❌ Matn juda qisqa.');
  created.forEach((t) => activity.mark(ctx, 'task_today', { title: t.title }));
  await ctx.reply(`✅ <b>${created.length} ta bugungi topshiriq qo'shildi:</b>\n\n${ui.taskList(created)}\n\nBajargach «${ui.BTN.done}» bilan belgilang.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  await notify.toReviewers(botOf(ctx), emp, `📌 <b>${esc(emp.full_name)}</b> bugunga ${created.length} ta qo'shimcha topshiriq qo'shdi:\n${ui.taskList(created)}`);
};

const register = (bot) => {
  bot.hears(ui.BTN.myTasks, showMyTasks);
  bot.command('missiyalarim', showMyTasks);
  bot.command('bugun', addTodayTask);
  bot.command('topshiriqlarim', showMyTasks);
  bot.action('tk:list', async (ctx) => { await ctx.answerCbQuery(); await showMyTasks(ctx); });
  bot.action(/^tk:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await showTaskMenu(ctx, ctx.match[1]); });
  bot.action(/^tk:edit:(\d+)$/, async (ctx) => {
    const t = await editGuard(ctx, ctx.match[1]);
    if (!t) return;
    session.set(ctx.from.id, { step: 'edit_title', taskId: t.id });
    await ctx.answerCbQuery();
    return ctx.reply(`✏️ Yangi matn:\n<i>${esc(t.title)}</i>`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  });
  bot.action(/^tk:prio:(\d+)$/, async (ctx) => {
    const t = await editGuard(ctx, ctx.match[1]);
    if (!t) return;
    await tasks.setPriority(t.id, t.priority === 'high' ? 'normal' : 'high');
    await ctx.answerCbQuery();
    return showTaskMenu(ctx, t.id);
  });
  bot.action(/^tk:due:(\d+)$/, async (ctx) => {
    const t = await editGuard(ctx, ctx.match[1]);
    if (!t) return;
    await ctx.answerCbQuery();
    return render(ctx, `📆 <b>${esc(t.title)}</b> — yangi muddat:`, inline([
      [cb('📅 Bugun', `tk:dued:${t.id}:0`), cb('☀️ Ertaga', `tk:dued:${t.id}:1`), cb('+3 kun', `tk:dued:${t.id}:3`)],
      [cb('+7 kun', `tk:dued:${t.id}:7`), cb('📆 Sana yozish', `tk:dued:${t.id}:type`)],
      [cb('⬅️ Orqaga', `tk:${t.id}`)],
    ]));
  });
  bot.action(/^tk:dued:(\d+):(\d+|type)$/, async (ctx) => {
    const t = await editGuard(ctx, ctx.match[1]);
    if (!t) return;
    await ctx.answerCbQuery();
    if (ctx.match[2] === 'type') return askTypedDate(ctx, 'tk', { taskId: t.id });
    await tasks.setDue(t.id, dueFromDays(ctx.match[2]));
    return showTaskMenu(ctx, t.id);
  });
  bot.action(/^tk:del:(\d+)$/, async (ctx) => {
    const t = await editGuard(ctx, ctx.match[1]);
    if (!t) return;
    await ctx.answerCbQuery();
    return render(ctx, `🗑 <b>${esc(t.title)}</b> — o'chirilsinmi?`, ui.confirmKeyboard(`tk:delok:${t.id}`, `tk:${t.id}`, "🗑 Ha, o'chirilsin"));
  });
  bot.action(/^tk:delok:(\d+)$/, async (ctx) => {
    const t = await editGuard(ctx, ctx.match[1]);
    if (!t) return;
    await tasks.cancel(t.id);
    activity.mark(ctx, 'task_cancel', { title: t.title });
    await ctx.answerCbQuery("O'chirildi");
    if (ctx.state.employee && Number(t.employee_id) !== Number(ctx.state.employee.id)) {
      await notify.toUser(botOf(ctx), t.tg_id, `🗑 Topshiriq bekor qilindi: <s>${esc(t.title)}</s>`);
    }
    return showMyTasks(ctx);
  });

  // o'zimga vazifa
  bot.hears(ui.BTN.selfTask, startSelfTask);
  bot.command('vazifa', startSelfTask);
  bot.action(/^st:due:(\d+|type)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') return askTypedDate(ctx, 'st', { titles: session.get(ctx.from.id).titles });
    return createSelfTasks(ctx, dueFromDays(ctx.match[1]));
  });
  bot.action('st:cancel', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); await render(ctx, '❌ Bekor qilindi.'); });

  // topshiriq berish
  bot.hears(ui.BTN.assign, startAssign);
  bot.command('topshiriq', startAssign);
  bot.action('as:start', async (ctx) => { await ctx.answerCbQuery(); await startAssign(ctx); });
  bot.action(/^as:dept:(\d+)$/, async (ctx) => { if (!ctx.state.isAdmin) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await pickDept(ctx, Number(ctx.match[1])); });
  bot.action(/^as:emp:(\d+)$/, async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await pickEmployee(ctx, ctx.match[1]); });
  bot.action(/^as:due:(\d+|type)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') return askTypedDate(ctx, 'as', { assign: session.get(ctx.from.id).assign });
    return createAssigned(ctx, dueFromDays(ctx.match[1]));
  });
  bot.action('as:cancel', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); await render(ctx, '❌ Bekor qilindi.'); });

  // bajardim
  bot.hears(ui.BTN.done, showDone);
  bot.command('bajardim', showDone);
  bot.action('done:list', async (ctx) => { await ctx.answerCbQuery(); await showDone(ctx); });
  bot.action(/^done:(\d+)$/, (ctx) => pickDone(ctx, ctx.match[1]));
  bot.action('done:noproof', async (ctx) => { await ctx.answerCbQuery(); await finishDone(ctx, null); });
  bot.action('done:cancel', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); await showDone(ctx); });
  bot.on(['photo', 'video', 'document'], onMedia);

  // tekshiruv
  bot.hears(ui.BTN.review, showReview);
  bot.command('tekshiruv', showReview);
  bot.action('rv:list', async (ctx) => { await ctx.answerCbQuery(); await showReview(ctx); });
  bot.action(/^rv:view:(\d+)$/, (ctx) => viewReview(ctx, ctx.match[1]));
  bot.action(/^rv:ok:(\d+)$/, (ctx) => doAccept(ctx, ctx.match[1]));
  bot.action(/^rv:back:(\d+)$/, (ctx) => startReturn(ctx, ctx.match[1]));
};

module.exports = {
  register, parseTitle, handleSelfTaskText, handleAssignText, handleTypedDate, handleReturnNote, handleEditTitle, showMyTasks, showReview, addTodayTask,
};
