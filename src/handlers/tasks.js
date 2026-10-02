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
const flows = require('../services/flows');
const access = require('../services/access');
const { notRegistered } = require('./common');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

const { parseTitle } = flows;

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
    (open.length ? `\n\n⚙️ tugmasi — tahrirlash / muddat (faqat o'zingiz yozgan, muddati o'tmaganlar). O'chirib bo'lmaydi.` : '');
  const unacked = open.concat(awaiting).filter(tasks.needsAck);
  const kb = ui.manageKeyboard(open);
  if (!unacked.length) return render(ctx, text, kb);
  return render(ctx, `${text}\n\n👂 <b>${unacked.length} ta</b> topshiriqni hali «Tushundim» qilmagansiz.`,
    inline([...ui.ackRows(unacked), ...kb.reply_markup.inline_keyboard]));
};

/** Topshiriq kartochkasidagi qo'shimcha tugmalar: topshiriq media'si va «Tushundim» */
const taskExtraRows = (t, mine) => {
  const rows = [];
  if (t.task_file_id) rows.push([cb(`${ui.MEDIA_ICON[t.task_media_type] || '📎'} Topshiriqni ko'rish / eshitish`, `tk:media:${t.id}`)]);
  if (mine && tasks.needsAck(t)) rows.push([cb('✅ Eshitdim, tushundim', `ak:${t.id}`)]);
  return rows;
};

const canEdit = (ctx, t) => access.canEditTask(ctx.state.actor, t);
const canCancel = (ctx, t) => access.canCancelTask(ctx.state.actor, t);

const showTaskMenu = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t || t.status !== 'active') return render(ctx, "Topshiriq topilmadi yoki yopilgan.", ui.backKeyboard('tk:list', "⬅️ Ro'yxatga"));
  const mine = ctx.state.employee && Number(t.employee_id) === Number(ctx.state.employee.id);
  if (!canEdit(ctx, t)) {
    const why = mine && t.source === 'self'
      ? "🔒 Muddati o'tgan — endi o'zgartirib bo'lmaydi. Bajaring va «Bajardim» bosing."
      : `🔒 Bu topshiriqni <b>${ui.SOURCE_LABEL[t.source]}</b> bergan — faqat u o'zgartira oladi.`;
    return render(ctx, `${ui.taskLine(t, 1, { withName: !mine })}\n\n${why}`, inline([...taskExtraRows(t, mine), [cb("⬅️ Ro'yxatga", 'tk:list')]]));
  }
  return render(ctx, `⚙️ ${ui.taskLine(t, 1, { withName: !mine })}${t.review_note ? `\n\n💬 Tekshiruvchi: «${esc(t.review_note)}»` : ''}` +
    (mine ? "\n\n<i>Topshiriqni o'chirib bo'lmaydi — kerak bo'lmasa rahbaringiz bekor qiladi.</i>" : ''), ui.taskMenuKeyboard(t, { canDelete: canCancel(ctx, t), extra: taskExtraRows(t, mine) }));
};

// ---------------------------------------------------------------------------
// O'ZIMGA VAZIFA
// ---------------------------------------------------------------------------

const startSelfTask = async (ctx) => {
  if (!mustEmployee(ctx)) return;
  session.set(ctx.from.id, { step: 'self_task_text' });
  return ctx.reply(
    `➕ <b>Missiya matnini yozing</b> — yoki 🎤 ovozli xabar, 🎥 video, 📄 fayl, 🖼 rasm yuboring.
Bir nechta bo'lsa — har birini yangi qatorda.

<i>Misol:</i>
<code>Xitoydan kelgan yuklarni ro'yxatga olish
!Mijoz Akbar bilan shartnoma imzolash</code>

<i>Boshiga ! qo'ysangiz — muhim. Muddatni keyingi qadamda tanlaysiz.</i>`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const handleSelfTaskText = async (ctx) => {
  const lines = flows.splitTitles(ctx.message.text);
  if (!lines.length) return ctx.reply('Matn bo\'sh. Qaytadan yozing:', ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'self_task_due', titles: lines });
  activity.mark(ctx, 'note', { title: lines.join(' | '), detail: 'missiya matni sifatida yozdi' });
  await ctx.reply(`📝 ${lines.length} ta missiya. Muddatini tanlang:`, { reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('st'));
};

/** Topshiriq / vazifa media'si: ovoz, video, dumaloq video, audio, rasm, fayl */
const mediaOf = (m) => {
  if (m.voice) return { type: 'voice', fileId: m.voice.file_id };
  if (m.video) return { type: 'video', fileId: m.video.file_id };
  if (m.video_note) return { type: 'video_note', fileId: m.video_note.file_id };
  if (m.audio) return { type: 'audio', fileId: m.audio.file_id, fileName: m.audio.file_name || m.audio.title || null };
  if (m.photo && m.photo.length) return { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  if (m.document) return { type: 'document', fileId: m.document.file_id, fileName: m.document.file_name || null };
  return null;
};

const handleSelfTaskMedia = async (ctx, media) => {
  const titles = flows.mediaTitles(media, ctx.message.caption);
  session.set(ctx.from.id, { step: 'self_task_due', titles, media });
  await ctx.reply(`📝 ${ui.MEDIA_ICON[media.type] || '📎'} ${esc(titles[0])}\nMuddatini tanlang:`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('st'));
};

const createSelfTasks = async (ctx, dueDate) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.titles || !emp) return render(ctx, 'Sessiya eskirgan. Qaytadan boshlang.');
  session.clear(ctx.from.id);
  const created = await flows.addSelfTasks(botOf(ctx), emp, s.titles, dueDate, { media: s.media || null });
  ctx.state.logged = true;
  await render(ctx, `✅ <b>${created.length} ta missiya qo'shildi</b> — muddat: ${time.prettyDate(dueDate)}

${ui.taskList(created)}`);
  await ctx.reply('👌', ui.kbFor(ctx));
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
  if (ctx.state.isHr && !ctx.state.isAdmin) return require('./directions').dirsMenu(ctx);
  if (ctx.state.isAdmin) return managersMenu(ctx);
  const me = ctx.state.employee;
  const list = (await employees.listByDepartment(me.department_id)).filter((e) => Number(e.id) !== Number(me.id));
  if (!list.length) return render(ctx, "Bo'limingizda boshqa hodim yo'q.");
  return render(ctx, `📤 <b>Kimga topshiriq berasiz?</b> (${esc(me.department_name)})`, employeeButtons(list, 'as:emp', 'as:cancel'));
};

/** Direktor (va HR «Rahbarlar orqali»): avval rahbarlar (o'ziga yoki jamoasiga) */
const managersMenu = async (ctx) => {
  session.set(ctx.from.id, { step: 'assign_pick', assign: {} });
  {
    const rows = [];
    for (const m of await employees.listHeads()) {
      if (ctx.state.employee && Number(m.id) === Number(ctx.state.employee.id)) continue;
      const team = await employees.teamOf(m);
      rows.push([
        cb(`${employees.personIcon(m)} ${m.full_name.split(' ')[0]} · ${employees.titleOf(m)}`.slice(0, 40), `as:emp:${m.id}`),
        cb(`👥 Hodimlariga (${team.length})`, `as:team:${m.id}`),
      ]);
    }
    const loose = await employees.listUnmanaged();
    if (loose.length) rows.push([cb(`👤 Rahbarsiz hodimlar (${loose.length})`, 'as:none')]);
    rows.push([cb("🧭 Yo'nalish bo'yicha", 'as:dirs')]);
    rows.push([cb("🏢 Bo'lim bo'yicha", 'as:depts'), cb('👥 Hamma hodimlar', 'as:dept:0')], [cb(ui.BTN.cancel, 'as:cancel')]);
    return render(
      ctx,
      `📤 <b>Kimga topshiriq berasiz?</b>\n\nRahbarning o'ziga — ismini bosing.\nUning jamoasidagi hodimga — «👥 Hodimlariga».`,
      inline(rows),
    );
  }
};

const pickDeptList = async (ctx) => {
  const rows = (await departments.listActive()).map((d) => [cb(`🏢 ${d.name}`, `as:dept:${d.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'as:start')]);
  return render(ctx, "📤 Bo'limni tanlang:", inline(rows));
};

/** Direktor: rahbar jamoasidan hodim tanlash */
const pickTeam = async (ctx, mgrId) => {
  const m = await employees.byId(mgrId);
  const team = m ? await employees.teamOf(m) : [];
  if (!team.length) return render(ctx, `${m ? esc(m.full_name) : 'Rahbar'} jamoasida hodim yo'q.`, ui.backKeyboard('as:start'));
  const rows = team.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}${e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `as:emp:${e.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'as:start'), cb(ui.BTN.cancel, 'as:cancel')]);
  return render(ctx, `📤 <b>${esc(m.full_name)}</b> (${esc(employees.titleOf(m))}) jamoasi — kimga?`, inline(rows));
};

const pickUnmanaged = async (ctx) => {
  const list = await employees.listUnmanaged();
  if (!list.length) return render(ctx, "Rahbarsiz hodim yo'q.", ui.backKeyboard('as:start'));
  const rows = list.map((e) => [cb(`👤 ${e.full_name}${e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `as:emp:${e.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'as:start')]);
  return render(ctx, '📤 <b>Kimga?</b>', inline(rows));
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
  return ctx.reply(
    `✍️ Topshiriq matnini yozing (bir nechta — har biri yangi qatorda; boshiga <b>!</b> — muhim)\n` +
      `— yoki 🎤 <b>ovozli xabar</b>, 🎥 video, 📄 fayl (PDF, Excel, Word…), 🖼 rasm yuboring (izohi — topshiriq nomi):`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const handleAssignText = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.assign || !s.assign.employeeId) return ctx.reply('Sessiya eskirgan. Qaytadan boshlang.', ui.kbFor(ctx));
  const lines = flows.splitTitles(ctx.message.text);
  if (!lines.length) return ctx.reply("Matn bo'sh. Qaytadan yozing:", ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'assign_due', assign: { ...s.assign, titles: lines } });
  await ctx.reply(`📝 ${lines.length} ta topshiriq. Muddatini tanlang:`, { reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('as'));
};

const handleAssignMedia = async (ctx, media) => {
  const s = session.get(ctx.from.id);
  if (!s.assign || !s.assign.employeeId) return ctx.reply('Sessiya eskirgan. Qaytadan boshlang.', ui.kbFor(ctx));
  const titles = flows.mediaTitles(media, ctx.message.caption);
  session.set(ctx.from.id, { step: 'assign_due', assign: { ...s.assign, titles, media } });
  await ctx.reply(`📝 ${ui.MEDIA_ICON[media.type] || '📎'} ${esc(titles[0])}\nMuddatini tanlang:`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('as'));
};

const createAssigned = async (ctx, dueDate) => {
  const s = session.get(ctx.from.id);
  if (!s.assign || !s.assign.titles) return render(ctx, 'Sessiya eskirgan.');
  const target = await employees.byId(s.assign.employeeId);
  if (!target) return render(ctx, 'Hodim topilmadi.');
  if (!employees.canManage(ctx.state.employee, ctx.state.isAdmin, target)) return render(ctx, "⛔️ Bu sizning bo'limingiz emas.");
  session.clear(ctx.from.id);
  const { created } = await flows.assignTasks(botOf(ctx), ctx.state.actor, target, s.assign.titles, dueDate, { media: s.assign.media || null });
  ctx.state.logged = true;
  await render(ctx, `✅ <b>${esc(target.full_name)}</b> ga ${created.length} ta topshiriq berildi (muddat: ${time.prettyDate(dueDate)}):\n\n${ui.taskList(created)}`);
  await ctx.reply('👌', ui.kbFor(ctx));
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
    const t = await tasks.byId(s.taskId);
    session.clear(ctx.from.id);
    if (!t || t.status !== 'active' || !canEdit(ctx, t)) return ctx.reply("⛔️ O'zgartira olmaysiz.", ui.kbFor(ctx));
    if (isOwnOverdue(ctx, t)) return ctx.reply(OVERDUE_LOCK, ui.kbFor(ctx));
    await tasks.setDue(t.id, d);
    if (d !== t.due_date) await tellReviewers(ctx, t, `📆 <b>${esc(ctx.state.employee ? ctx.state.employee.full_name : '')}</b> muddatni o'zgartirdi: ${esc(t.title)}\n${time.prettyDate(t.due_date)} → ${time.prettyDate(d)}`);
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
  if (tasks.isBossOwn(emp, t)) {
    return render(
      ctx,
      `📎 <b>${esc(t.title)}</b>\n\nIsbot <b>ixtiyoriy</b>: xohlasangiz 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl yuboring — yoki «✅ Isbotsiz bajardim» ni bosing.`,
      ui.proofKeyboard({ noProof: true }),
    );
  }
  if (!config.proofRequired) {
    return render(
      ctx,
      `📎 <b>${esc(t.title)}</b>\n\nIsbot sifatida 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl (PDF, Excel, Word…) yuboring — izohni ostiga yozsangiz bo'ladi.\nIsbot bo'lmasa — «⏭ Isbotsiz yuborish».`,
      ui.proofKeyboard({ optional: true }),
    );
  }
  return render(
    ctx,
    `📎 <b>${esc(t.title)}</b>\n\n<b>Isbot majburiy:</b> 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl (PDF, Excel, Word…) yuboring — izohni ostiga yozsangiz bo'ladi.\nIsbotsiz bajarilgan deb qabul qilinmaydi.`,
    ui.proofKeyboard(),
  );
};

const finishDone = async (ctx, proof) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.doneTaskId || !emp) return;
  if (tasks.isBossOwn(emp, await tasks.byId(s.doneTaskId))) {
    const own = await tasks.completeOwn(s.doneTaskId, emp, proof);
    session.clear(ctx.from.id);
    if (!own.ok) return ctx.reply('Topshiriq ochiq emas.', ui.kbFor(ctx));
    const text = `✅ <b>${esc(own.task.title)}</b> — bajarildi${proof ? ' (isbot bilan)' : ''}.`;
    if (ctx.updateType === 'callback_query') await render(ctx, text); else await ctx.reply(text, { parse_mode: 'HTML' });
    await ctx.reply('👌', ui.kbFor(ctx));
    if (proof && proof.fileId) await notify.toArchive(botOf(ctx), `✔️ <b>${esc(emp.full_name)}</b> bajardi: ${esc(own.task.title)} · ${time.clock(own.task.done_at)}`, proof);
    return;
  }
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
  if (proof && proof.fileId) {
    await notify.toArchive(botOf(ctx), `✔️ <b>${esc(emp.full_name)}</b> bajardi: ${esc(t.title)} · ${time.clock(t.done_at)}${proof.note ? `\n💬 «${esc(proof.note)}»` : ''}`, proof);
  }
};

/** Rasm / video / hujjat keldi — done_proof bosqichida bo'lsa isbot */
const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const s = session.get(ctx.from.id);
  if (s.step === 'assign_text' && ctx.state.isManager) {
    const media = mediaOf(ctx.message);
    return media ? handleAssignMedia(ctx, media) : ctx.reply('Matn, ovozli xabar, video, fayl yoki rasm yuboring.', ui.cancelKeyboard());
  }
  if (s.step === 'self_task_text' && ctx.state.employee) {
    const media = mediaOf(ctx.message);
    return media ? handleSelfTaskMedia(ctx, media) : ctx.reply('Matn, ovozli xabar, video, fayl yoki rasm yuboring.', ui.cancelKeyboard());
  }
  if (s.step !== 'done_proof') return next();
  const m = ctx.message;
  let proof = null;
  if (m.photo && m.photo.length) proof = { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  else if (m.video) proof = { type: 'video', fileId: m.video.file_id };
  else if (m.video_note) proof = { type: 'video_note', fileId: m.video_note.file_id };
  else if (m.voice) proof = { type: 'voice', fileId: m.voice.file_id };
  else if (m.audio) proof = { type: 'audio', fileId: m.audio.file_id };
  else if (m.document) proof = { type: 'document', fileId: m.document.file_id, fileName: m.document.file_name || null };
  if (!proof) return ctx.reply('📎 Isbot: rasm, video, audio yoki fayl yuboring.');
  // izoh yozilmagan fayl — tekshiruvchi nima kelganini bilsin
  proof.note = (m.caption || '').trim().slice(0, 300) || (proof.fileName ? `📄 ${String(proof.fileName).slice(0, 200)}` : null);
  return finishDone(ctx, proof);
};

// ---------------------------------------------------------------------------
// TEKSHIRUV (qabul / qaytarish)
// ---------------------------------------------------------------------------

const reviewScope = (ctx) => (ctx.state.isAdmin || ctx.state.isHr ? null : ctx.state.employee.department_id);

const showReview = async (ctx) => {
  if (!ctx.state.isManager) return ctx.reply('⛔️ Faqat boshliq va direktor uchun.');
  if (!ctx.state.isAdmin && !reviewScope(ctx)) return ctx.reply("Sizga bo'lim biriktirilmagan — direktorga ayting.");
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
  if (!access.canReview(ctx.state.actor, emp)) {
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
  const res = await flows.acceptTask(botOf(ctx), id, ctx.from.id);
  if (!res.ok) return ctx.answerCbQuery("Bu ish allaqachon ko'rib chiqilgan.");
  activity.mark(ctx, 'review_ok', { title: g.t.title, detail: g.emp.full_name });
  await ctx.answerCbQuery('Qabul qilindi ✅');
  await editAny(ctx, `✅ <b>Qabul qilindi</b> — ${esc(g.emp.full_name)}: ${esc(g.t.title)}${res.onTime ? '' : ' <i>(muddatdan kech)</i>'}`);
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
  const pending = await tasks.byId(s.returnTaskId);
  if (!pending || pending.status !== 'done') return ctx.reply("Bu ish allaqachon ko'rib chiqilgan.", ui.kbFor(ctx));
  if (!access.canReview(ctx.state.actor, await employees.byId(pending.employee_id))) return ctx.reply("⛔️ Ruxsat yo'q", ui.kbFor(ctx));
  const res = await flows.returnTask(botOf(ctx), s.returnTaskId, ctx.from.id, note);
  if (!res.ok) return ctx.reply("Bu ish allaqachon ko'rib chiqilgan.", ui.kbFor(ctx));
  const t = res.task;
  activity.mark(ctx, 'review_back', { title: t.title, detail: note });
  await ctx.reply(`↩️ Qaytarildi: <b>${esc(t.title)}</b>${note ? `\n«${esc(note)}»` : ''}`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
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

/**
 * Muddati o'tgan ishni hodim o'zi ko'chira/o'chira olmaydi — aks holda u KPI hisobidan chiqib ketadi.
 * Buni faqat boshliq/direktor qiladi.
 */
const isOwnOverdue = (ctx, t) =>
  !ctx.state.isManager && ctx.state.employee && Number(t.employee_id) === Number(ctx.state.employee.id) && t.due_date < time.today();

const OVERDUE_LOCK = "⛔️ Muddati o'tgan ishni o'zingiz ko'chira yoki o'chira olmaysiz — bajaring yoki rahbaringizdan so'rang.";

const scheduleGuard = async (ctx, id) => {
  const t = await editGuard(ctx, id);
  if (!t) return null;
  if (isOwnOverdue(ctx, t)) { await ctx.answerCbQuery(OVERDUE_LOCK, { show_alert: true }); return null; }
  return t;
};

/** Hodim o'z ishining muddatini surgan / o'chirganda tekshiruvchi xabardor bo'ladi */
const tellReviewers = async (ctx, t, text) => {
  const me = ctx.state.employee;
  if (!me || ctx.state.isManager || Number(t.employee_id) !== Number(me.id)) return;
  await notify.toReviewers(botOf(ctx), me, text);
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
  bot.action(/^ak:(\d+|all)$/, async (ctx) => {
    const emp = ctx.state.employee;
    if (!emp) return ctx.answerCbQuery('⛔️');
    const done = await flows.ackTasks(botOf(ctx), emp, ctx.match[1] === 'all' ? null : [Number(ctx.match[1])]);
    await ctx.answerCbQuery(done.length ? `✅ ${done.length} ta topshiriq — tushundim` : 'Allaqachon belgilangan');
    if (done.length) await ctx.reply(`👂 Belgilandi: «Tushundim» — ${done.map((t) => `«${t.title}»`).join(', ')}.\nTopshiriq bergan odam xabardor qilindi.`, ui.kbFor(ctx));
  });
  bot.action(/^tk:media:(\d+)$/, async (ctx) => {
    const t = await tasks.byId(ctx.match[1]);
    const emp = ctx.state.employee;
    const target = t ? await employees.byId(t.employee_id) : null;
    const mine = emp && t && Number(t.employee_id) === Number(emp.id);
    if (!t || !t.task_file_id || !(mine || ctx.state.isAdmin || ctx.state.isHr || (ctx.state.isManager && employees.canManage(emp, ctx.state.isAdmin, target)))) return ctx.answerCbQuery("Topilmadi");
    await ctx.answerCbQuery();
    await flows.sendTaskMedia(botOf(ctx), ctx.from.id, t, mine && tasks.needsAck(t) ? inline(ui.ackRows([t])) : {});
  });
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
    const t = await scheduleGuard(ctx, ctx.match[1]);
    if (!t) return;
    await ctx.answerCbQuery();
    return render(ctx, `📆 <b>${esc(t.title)}</b> — yangi muddat:`, inline([
      [cb('📅 Bugun', `tk:dued:${t.id}:0`), cb('☀️ Ertaga', `tk:dued:${t.id}:1`), cb('+3 kun', `tk:dued:${t.id}:3`)],
      [cb('+7 kun', `tk:dued:${t.id}:7`), cb('📆 Sana yozish', `tk:dued:${t.id}:type`)],
      [cb('⬅️ Orqaga', `tk:${t.id}`)],
    ]));
  });
  bot.action(/^tk:dued:(\d+):(\d+|type)$/, async (ctx) => {
    const t = await scheduleGuard(ctx, ctx.match[1]);
    if (!t) return;
    await ctx.answerCbQuery();
    if (ctx.match[2] === 'type') return askTypedDate(ctx, 'tk', { taskId: t.id });
    const d = dueFromDays(ctx.match[2]);
    await tasks.setDue(t.id, d);
    if (d !== t.due_date) await tellReviewers(ctx, t, `📆 <b>${esc(ctx.state.employee ? ctx.state.employee.full_name : '')}</b> muddatni o'zgartirdi: ${esc(t.title)}\n${time.prettyDate(t.due_date)} → ${time.prettyDate(d)}`);
    return showTaskMenu(ctx, t.id);
  });
  const cancelGuard = async (ctx, id) => {
    const t = await tasks.byId(id);
    if (!t || t.status !== 'active') { await ctx.answerCbQuery('Topshiriq ochiq emas'); return null; }
    if (!canCancel(ctx, t)) { await ctx.answerCbQuery("⛔️ O'z topshirig'ingizni o'chirib bo'lmaydi — rahbaringiz bekor qiladi", { show_alert: true }); return null; }
    return t;
  };
  bot.action(/^tk:del:(\d+)$/, async (ctx) => {
    const t = await cancelGuard(ctx, ctx.match[1]);
    if (!t) return;
    await ctx.answerCbQuery();
    return render(ctx, `🗑 <b>${esc(t.title)}</b> — bekor qilinsinmi?\n<i>Yozuv o'chmaydi, «bekor qilingan» bo'lib qoladi.</i>`, ui.confirmKeyboard(`tk:delok:${t.id}`, `tk:${t.id}`, '🗑 Ha, bekor qilinsin'));
  });
  bot.action(/^tk:delok:(\d+)$/, async (ctx) => {
    const t = await cancelGuard(ctx, ctx.match[1]);
    if (!t) return;
    await flows.cancelTask(botOf(ctx), t, ctx.state.employee ? ctx.state.employee.id : null, ctx.from.id);
    activity.mark(ctx, 'task_cancel', { title: t.title, detail: t.full_name });
    await ctx.answerCbQuery('Bekor qilindi');
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
  bot.action(/^as:dept:(\d+)$/, async (ctx) => { if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await pickDept(ctx, Number(ctx.match[1])); });
  bot.action(/^as:team:(\d+)$/, async (ctx) => { if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await pickTeam(ctx, ctx.match[1]); });
  bot.action('as:none', async (ctx) => { if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await pickUnmanaged(ctx); });
  bot.action('as:depts', async (ctx) => { if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await pickDeptList(ctx); });
  bot.action('as:mgrs', async (ctx) => { if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await managersMenu(ctx); });
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
  bot.action('done:np', async (ctx) => {
    const s = session.get(ctx.from.id);
    const emp = ctx.state.employee;
    if (s.step !== 'done_proof' || !tasks.isBossOwn(emp, await tasks.byId(s.doneTaskId))) return ctx.answerCbQuery('📎 Isbot majburiy: rasm, video, audio yoki fayl yuboring', { show_alert: true });
    await ctx.answerCbQuery();
    await finishDone(ctx, null);
  });
  bot.action('done:noproof', async (ctx) => {
    const s = session.get(ctx.from.id);
    if (config.proofRequired) return ctx.answerCbQuery('📎 Isbot majburiy: rasm, video, audio yoki fayl yuboring', { show_alert: true });
    if (s.step !== 'done_proof' || !ctx.state.employee) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery();
    return finishDone(ctx, null);
  });
  bot.action('done:cancel', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); await showDone(ctx); });
  bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], onMedia);

  // tekshiruv
  bot.hears(ui.BTN.review, showReview);
  bot.command('tekshiruv', showReview);
  bot.action('rv:list', async (ctx) => { await ctx.answerCbQuery(); await showReview(ctx); });
  bot.action(/^rv:view:(\d+)$/, (ctx) => viewReview(ctx, ctx.match[1]));
  bot.action(/^rv:ok:(\d+)$/, (ctx) => doAccept(ctx, ctx.match[1]));
  bot.action(/^rv:back:(\d+)$/, (ctx) => startReturn(ctx, ctx.match[1]));
};

/** Matn «eshitdim / tushundim» — tasdiqlanmagan topshiriqlar bo'lsa. true — tasdiqlandi */
const ACK_RE = /^\s*(eshitdim|tushundim|tushunarli|eshitdim va tushundim)\b/i;
const ackByText = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp || !ACK_RE.test(ctx.message.text || '')) return false;
  const done = await flows.ackTasks(botOf(ctx), emp, null, ctx.message.text.trim());
  if (!done.length) return false;
  await ctx.reply(`👂 Belgilandi: «Tushundim» — ${done.map((t) => `«${t.title}»`).join(', ')}.\nTopshiriq bergan odam xabardor qilindi.`, ui.kbFor(ctx));
  return true;
};

module.exports = {
  ackByText,
  register, parseTitle, handleSelfTaskText, handleAssignText, handleTypedDate, handleReturnNote, handleEditTitle, showMyTasks, showReview, addTodayTask,
};
