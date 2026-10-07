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
const picker = require('./picker');

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
    `📋 <b>TOPSHIRIQLARIM</b> · ${time.prettyDate(time.today())}\n${ui.LINE}\n` +
    `⏳ <b>Ochiq (${open.length}):</b>\n${ui.taskList(open)}` +
    (awaiting.length ? `\n\n🕓 <b>Tekshiruvda (${awaiting.length}):</b>\n${ui.taskList(awaiting)}` : '') +
    (open.length ? `\n\n⚙️ tugmasi — tahrirlash / muddat (faqat o'zingiz yozgan, muddati o'tmaganlar). O'chirib bo'lmaydi.` : '');
  const unacked = open.concat(awaiting).filter(tasks.needsAck);
  // rasm / ovoz / video / fayl bilan berilgan topshiriqlar — mazmuni shu tugmalar orqali ochiladi
  const media = [...ui.mediaRows(open, 1), ...ui.mediaRows(awaiting, open.length + 1)];
  const mediaHint = media.length ? `\n\n🎧 Rasm, ovoz yoki video bilan berilgan topshiriqni pastdagi <b>«ko'rish / eshitish»</b> tugmasi bilan oching.` : '';
  const kb = ui.manageKeyboard(open).reply_markup.inline_keyboard;
  if (!unacked.length) return render(ctx, text + mediaHint, inline([...media, ...kb]));
  return render(ctx, `${text}${mediaHint}\n\n👂 <b>${unacked.length} ta</b> topshiriqni hali «Tushundim» qilmagansiz.`,
    inline([...ui.ackRows(unacked), ...media, ...kb]));
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
  // begona topshiriq (id ni o'zgartirib) ko'rinmasin
  if (!mine && !(await access.canSeeTask(ctx.state.actor, t))) return render(ctx, "Topshiriq topilmadi yoki yopilgan.", ui.backKeyboard('tk:list', "⬅️ Ro'yxatga"));
  if (!canEdit(ctx, t)) {
    const why = mine && t.source === 'self'
      ? "🔒 Muddati o'tgan — endi o'zgartirib bo'lmaydi. Bajaring va «Bajardim» bosing."
      : `🔒 Bu topshiriqni <b>${ui.SOURCE_LABEL[t.source]}</b> bergan — faqat u o'zgartira oladi.`;
    return render(ctx, `${ui.taskLine(t, 1, { withName: !mine })}\n\n${why}`, inline([...taskExtraRows(t, mine), [cb("⬅️ Ro'yxatga", 'tk:list')]]));
  }
  return render(ctx, `⚙️ ${ui.taskLine(t, 1, { withName: !mine })}${t.review_note ? `\n\n💬 Tekshiruvchi: «${esc(t.review_note)}»` : ''}` +
    (mine && !canCancel(ctx, t) ? "\n\n<i>Topshiriqni o'chirib bo'lmaydi — kerak bo'lmasa rahbaringiz bekor qiladi.</i>" : ''), ui.taskMenuKeyboard(t, { canDelete: canCancel(ctx, t), extra: taskExtraRows(t, mine) }));
};

// ---------------------------------------------------------------------------
// O'ZIMGA VAZIFA
// ---------------------------------------------------------------------------

const startSelfTask = async (ctx) => {
  if (!mustEmployee(ctx)) return;
  session.set(ctx.from.id, { step: 'self_task_text' });
  return ctx.reply(
    `➕ <b>Topshiriq matnini yozing</b> — yoki 🎤 ovozli xabar, 🎥 video, 📄 fayl, 🖼 rasm yuboring.
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
  activity.mark(ctx, 'note', { title: lines.join(' | '), detail: 'topshiriq matni sifatida yozdi' });
  await ctx.reply(`📝 ${lines.length} ta topshiriq. Muddatini tanlang:`, { reply_markup: { remove_keyboard: true } });
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

/**
 * Izohsiz ovoz/video/rasm — nomi «🎤 Ovozli topshiriq» bo'lib qolmasin: qisqa mazmun majburiy so'raladi.
 * Shu matn «Bajardim» ro'yxatida, Topshiriqlarimda, jurnalda ko'rinadi — hodim qaysi birini bajarganini biladi.
 */
const needsMediaTitle = (media, caption) => !String(caption || '').trim() && !(media.type === 'document' && media.fileName);

const askMediaTitle = (ctx, media) =>
  ctx.reply(
    `${ui.MEDIA_ICON[media.type] || '📎'} Qabul qilindi.\n\n✍️ <b>Endi qisqacha yozing: bu topshiriq nima haqida?</b>\n` +
      `<i>Masalan: «Ombor qoldig'ini sanash» yoki «Mijozga shartnoma yuborish».</i>\n` +
      `Hodim «Bajardim» bosganda aynan shu matn chiqadi — qaysi birini bajarganini bilib belgilaydi.`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );

/** Qisqa mazmun matni → bitta qator (bir nechta qator yozilsa ham bitta topshiriq) */
const mediaTitleFromText = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);

const handleSelfMediaTitle = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.media) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan. Qaytadan boshlang.', ui.kbFor(ctx)); }
  const title = mediaTitleFromText(ctx.message.text);
  if (!title) return ctx.reply("Matn bo'sh. Qisqacha yozing — nima haqida:", ui.cancelKeyboard());
  return handleSelfTaskMedia(ctx, s.media, title);
};

const handleSelfTaskMedia = async (ctx, media, typedTitle = null) => {
  if (!typedTitle && needsMediaTitle(media, ctx.message.caption)) {
    session.set(ctx.from.id, { step: 'self_media_title', media });
    return askMediaTitle(ctx, media);
  }
  const titles = typedTitle ? [typedTitle] : flows.mediaTitles(media, ctx.message.caption);
  session.set(ctx.from.id, { step: 'self_task_due', titles, media });
  await ctx.reply(`📝 ${ui.MEDIA_ICON[media.type] || '📎'} ${esc(titles[0])}\nMuddatini tanlang:`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('st'));
};

/**
 * Muddatdan keyin — boshlanish soati (ixtiyoriy): «ertaga soat 9:00» → aynan 9:00 da hodimga «hozir bajaring» xabari.
 * prefix: 'st' (o'zimga) yoki 'as' (topshiriq berish)
 */
const askStartTime = (ctx, prefix, due) => {
  session.set(ctx.from.id, { step: prefix === 'st' ? 'self_task_time' : 'assign_time', due });
  const who = prefix === 'st' ? 'sizga' : 'hodimga';
  return render(
    ctx,
    `📅 Muddat: <b>${time.prettyDate(due)}</b>\n\n⏰ <b>Soat nechida boshlanadi?</b>\nAynan shu soatda ${who} «hozir shu missiyani bajaring» degan xabar boradi.`,
    ui.startTimeKeyboard(prefix, due),
  );
};

/** st:tm:<HHmm|-|type> / as:tm:… */
const pickStartTime = async (ctx, prefix, raw) => {
  const s = session.get(ctx.from.id);
  const step = prefix === 'st' ? 'self_task_time' : 'assign_time';
  if (s.step !== step || !s.due) return render(ctx, 'Sessiya eskirgan. Qaytadan boshlang.');
  if (raw === 'type') {
    session.set(ctx.from.id, { step: 'typed_time', timeFor: prefix });
    return ctx.reply('⏰ Soatni yozing (masalan 09:00 yoki 14:30):', ui.cancelKeyboard());
  }
  const startTime = raw === '-' ? null : `${raw.slice(0, 2)}:${raw.slice(2)}`;
  return prefix === 'st' ? createSelfTasks(ctx, s.due, startTime) : createAssigned(ctx, s.due, startTime);
};

const handleTypedTime = async (ctx) => {
  const s = session.get(ctx.from.id);
  const t = tasks.normTime(ctx.message.text);
  if (!t) return ctx.reply('Soat tushunilmadi. Masalan: 09:00 yoki 14:30', ui.cancelKeyboard());
  if (!s.due || !['st', 'as'].includes(s.timeFor)) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  if (tasks.startPassed(s.due, t)) return ctx.reply("Bu soat o'tib ketgan. Boshqa soat yozing:", ui.cancelKeyboard());
  return s.timeFor === 'st' ? createSelfTasks(ctx, s.due, t) : createAssigned(ctx, s.due, t);
};

const createSelfTasks = async (ctx, dueDate, startTime = null) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.titles || !emp) return render(ctx, 'Sessiya eskirgan. Qaytadan boshlang.');
  session.clear(ctx.from.id);
  const created = await flows.addSelfTasks(botOf(ctx), emp, s.titles, dueDate, { media: s.media || null, startTime });
  ctx.state.logged = true;
  await render(ctx, `✅ <b>${created.length} ta topshiriq qo'shildi</b> — muddat: ${flows.whenText(dueDate, startTime)}\n\n${ui.taskList(created)}`);
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
  const kb = employeeButtons(list, 'as:emp', 'as:cancel');
  if (list.length > 1) kb.reply_markup.inline_keyboard.splice(-1, 0, [cb('☑️ Bir nechta / hammasiga', 'as:multi')]);
  return render(ctx, `📤 <b>Kimga topshiriq berasiz?</b> (${esc(me.department_name)})`, kb);
};

/** Boshliq(lar)ga topshiriq tugmasi — direktor va HR uchun (isbotni boshliq ixtiyoriy yuboradi) */
const bossRows = async (ctx) => {
  const me = ctx.state.employee;
  return (await employees.listAdmins())
    .filter((b) => !me || Number(b.id) !== Number(me.id))
    .map((b) => [cb(`👑 ${b.full_name}ga (boshliq)`.slice(0, 50), `as:emp:${b.id}`)]);
};

/** Bir nechta hodimni belgilab — hammasiga bir xil topshiriq */
const multiPick = picker.create({
  prefix: 'am',
  allowed: (ctx) => ctx.state.isManager,
  candidates: picker.managedCandidates,
  title: (ctx, n) => `📤 <b>Kimlarga topshiriq berasiz?</b>${n ? ` — belgilandi: <b>${n}</b>` : ''}\nHar biriga alohida topshiriq bo'lib boradi.`,
  onDone: async (ctx, ids) => {
    const list = [];
    for (const empId of ids) list.push(await employees.byId(empId));
    session.set(ctx.from.id, { step: 'assign_text', assign: { employeeIds: ids }, pick: null, pickFor: null });
    await render(ctx, `📤 <b>${ids.length} ta hodimga</b> topshiriq: ${picker.namesText(list)}`);
    return askAssignText(ctx);
  },
});

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
    rows.push(...(await bossRows(ctx)));
    rows.push([cb("🧭 Yo'nalish bo'yicha", 'as:dirs'), cb('☑️ Bir nechta / hammaga', 'as:multi')]);
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
  await render(ctx, `📤 <b>${esc(target.full_name)}</b>${target.position ? ` (${esc(target.position)})` : ''} ga topshiriq.` +
    (employees.isBoss(target) ? '\n<i>Boshliq bajarganda isbot ixtiyoriy — bajarilgani haqida sizga xabar keladi.</i>' : ''));
  return askAssignText(ctx);
};

const askAssignText = (ctx) =>
  ctx.reply(
    `✍️ Topshiriq matnini yozing (bir nechta — har biri yangi qatorda; boshiga <b>!</b> — muhim)\n` +
      `— yoki 🎤 <b>ovozli xabar</b>, 🎥 video, 📄 fayl (PDF, Excel, Word…), 🖼 rasm yuboring (izohi — topshiriq nomi):`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );

const hasTargets = (a) => Boolean(a && (a.employeeId || (Array.isArray(a.employeeIds) && a.employeeIds.length)));

const handleAssignText = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!hasTargets(s.assign)) return ctx.reply('Sessiya eskirgan. Qaytadan boshlang.', ui.kbFor(ctx));
  const lines = flows.splitTitles(ctx.message.text);
  if (!lines.length) return ctx.reply("Matn bo'sh. Qaytadan yozing:", ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'assign_due', assign: { ...s.assign, titles: lines } });
  await ctx.reply(`📝 ${lines.length} ta topshiriq. Muddatini tanlang:`, { reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('as'));
};

const handleAssignMedia = async (ctx, media, typedTitle = null) => {
  const s = session.get(ctx.from.id);
  if (!hasTargets(s.assign)) return ctx.reply('Sessiya eskirgan. Qaytadan boshlang.', ui.kbFor(ctx));
  if (!typedTitle && needsMediaTitle(media, ctx.message.caption)) {
    session.set(ctx.from.id, { step: 'assign_media_title', assign: { ...s.assign, media } });
    return askMediaTitle(ctx, media);
  }
  const titles = typedTitle ? [typedTitle] : flows.mediaTitles(media, ctx.message.caption);
  session.set(ctx.from.id, { step: 'assign_due', assign: { ...s.assign, titles, media } });
  await ctx.reply(`📝 ${ui.MEDIA_ICON[media.type] || '📎'} ${esc(titles[0])}\nMuddatini tanlang:`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
  return ctx.reply('⏱ Muddat:', ui.dueKeyboard('as'));
};

const handleAssignMediaTitle = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!hasTargets(s.assign) || !s.assign.media) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan. Qaytadan boshlang.', ui.kbFor(ctx)); }
  const title = mediaTitleFromText(ctx.message.text);
  if (!title) return ctx.reply("Matn bo'sh. Qisqacha yozing — nima haqida:", ui.cancelKeyboard());
  return handleAssignMedia(ctx, s.assign.media, title);
};

const createAssigned = async (ctx, dueDate, startTime = null) => {
  const s = session.get(ctx.from.id);
  if (!s.assign || !s.assign.titles) return render(ctx, 'Sessiya eskirgan.');
  // birinchi await dan oldin — ikkinchi bosish «Sessiya eskirgan» bo'ladi, topshiriq ikki marta yaratilmaydi
  session.clear(ctx.from.id);
  const ids = s.assign.employeeIds && s.assign.employeeIds.length ? s.assign.employeeIds : [s.assign.employeeId];
  const targets = [];
  for (const empId of ids) {
    const target = await employees.byId(empId);
    if (!target || !target.active) continue;
    if (!employees.canManage(ctx.state.employee, ctx.state.isAdmin, target)) return render(ctx, `⛔️ ${esc(target.full_name)} — sizning bo'limingiz emas.`);
    targets.push(target);
  }
  if (!targets.length) return render(ctx, 'Hodim topilmadi.');
  let created = [];
  for (const target of targets) {
    created = (await flows.assignTasks(botOf(ctx), ctx.state.actor, target, s.assign.titles, dueDate, { media: s.assign.media || null, startTime })).created;
  }
  ctx.state.logged = true;
  const who = targets.length === 1 ? `<b>${esc(targets[0].full_name)}</b> ga` : `<b>${targets.length} ta hodimga</b> (${picker.namesText(targets)})`;
  await render(ctx, `✅ ${who} ${created.length} ta topshiriq berildi (muddat: ${flows.whenText(dueDate, startTime)}):\n\n${ui.taskList(created)}`);
  await ctx.reply('👌', ui.kbFor(ctx));
};

/** Yozilgan sana (st / as / tk muddat uchun) */
const handleTypedDate = async (ctx) => {
  const s = session.get(ctx.from.id);
  const d = time.parseDate(ctx.message.text);
  if (!d) return ctx.reply('Sana tushunilmadi. Masalan: 25.09 yoki 25.09.2026 yoki 25-sentabr', ui.cancelKeyboard());
  if (d < time.today()) return ctx.reply("Muddat o'tgan sana bo'lishi mumkin emas. Qaytadan:", ui.cancelKeyboard());
  if (s.dateFor === 'st') return askStartTime(ctx, 'st', d);
  if (s.dateFor === 'as') return askStartTime(ctx, 'as', d);
  if (s.dateFor === 'rv' && s.returnTaskId) {
    session.clear(ctx.from.id);
    const cur = await tasks.byId(s.returnTaskId);
    if (!cur || cur.status !== 'done') return ctx.reply("Bu ish allaqachon ko'rib chiqilgan.", ui.kbFor(ctx));
    if (!access.canReview(ctx.state.actor, await employees.byId(cur.employee_id))) return ctx.reply("⛔️ Ruxsat yo'q", ui.kbFor(ctx));
    return finishReturn(ctx, cur.id, s.returnNote, { fixDue: d });
  }
  if (s.dateFor === 'tk' && s.taskId) {
    session.clear(ctx.from.id);
    // sana yozilguncha holat o'zgargan bo'lishi mumkin — huquq qayta tekshiriladi
    const cur = await tasks.byId(s.taskId);
    if (!cur || cur.status !== 'active' || !canEdit(ctx, cur)) return ctx.reply("🔒 Topshiriq endi o'zgartirib bo'lmaydi.", ui.kbFor(ctx));
    if (isOwnOverdue(ctx, cur)) return ctx.reply(OVERDUE_LOCK, ui.kbFor(ctx));
    if (!access.canSetDue(ctx.state.actor, cur, d)) return ctx.reply(access.DUE_LOCKED, ui.kbFor(ctx));
    await tasks.setDue(cur.id, d);
    if (d !== cur.due_date) await tellReviewers(ctx, cur, `📆 <b>${esc(ctx.state.employee ? ctx.state.employee.full_name : '')}</b> muddatni o'zgartirdi: ${esc(cur.title)}\n${time.prettyDate(cur.due_date)} → ${time.prettyDate(d)}`);
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
  // 5-okt: «Keldim» qilmagan hodim «Bajardim» qila olmaydi (boshliq ozod)
  const blocked = await flows.doneBlocked(emp);
  if (blocked && open.length) return render(ctx, `${blocked}

📋 Ochiq topshiriqlar: <b>${open.length}</b>`);
  return render(ctx, ui.doneChecklist(open, doneToday), ui.doneKeyboard(open));
};

const pickDone = async (ctx, id) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery('⛔️');
  const t = await tasks.byId(id);
  if (!t || Number(t.employee_id) !== Number(emp.id) || t.status !== 'active') return ctx.answerCbQuery('Topshiriq ochiq emas');
  const blocked = await flows.doneBlocked(emp);
  if (blocked) { await ctx.answerCbQuery(); return ctx.reply(blocked, { parse_mode: 'HTML', ...ui.kbFor(ctx) }); }
  session.set(ctx.from.id, { step: 'done_proof', doneTaskId: t.id });
  await ctx.answerCbQuery();
  // ovozli/video topshiriq — adashmaslik uchun qayta eshitib ko'rish mumkin
  const extra = t.task_file_id ? [[cb(`${ui.MEDIA_ICON[t.task_media_type] || '📎'} Topshiriqni qayta eshitish / ko'rish`, `tk:media:${t.id}`)]] : [];
  const head = `📎 <b>${esc(t.title)}</b>\n<i>⏱ muddat ${time.prettyDate(t.due_date)}${t.task_media_type ? ` · ${ui.MEDIA_LABEL[t.task_media_type] || 'media'}` : ''}</i>`;
  if (tasks.isBossOwn(emp, t)) {
    return render(
      ctx,
      `${head}\n\nIsbot <b>ixtiyoriy</b>: xohlasangiz 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl yuboring — yoki «✅ Isbotsiz bajardim» ni bosing.`,
      ui.proofKeyboard({ noProof: true, extra }),
    );
  }
  if (!config.proofRequired) {
    return render(
      ctx,
      `${head}\n\nIsbot sifatida 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl (PDF, Excel, Word…) yuboring — izohni ostiga yozsangiz bo'ladi.\nIsbot bo'lmasa — «⏭ Isbotsiz yuborish».`,
      ui.proofKeyboard({ optional: true, extra }),
    );
  }
  return render(
    ctx,
    `${head}\n\n<b>Isbot majburiy:</b> 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl (PDF, Excel, Word…) yuboring — izohni ostiga yozsangiz bo'ladi.\nIsbotsiz bajarilgan deb qabul qilinmaydi.`,
    ui.proofKeyboard({ extra }),
  );
};

const finishDone = async (ctx, proof) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (s.doneTaskIds && emp) return finishDoneMany(ctx, proof, s.doneTaskIds);
  if (!s.doneTaskId || !emp) return;
  // albom (bir nechta rasm) — birinchisi isbot bo'ladi, qolganlari jim o'tadi
  session.clear(ctx.from.id);
  const blocked = await flows.doneBlocked(emp);
  if (blocked) return ctx.reply(blocked, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  const album = Boolean(ctx.message && ctx.message.media_group_id);
  if (tasks.isBossOwn(emp, await tasks.byId(s.doneTaskId))) {
    const own = await flows.completeBossTask(botOf(ctx), emp, s.doneTaskId, proof);
    session.clear(ctx.from.id);
    if (!own.ok) return ctx.reply('Topshiriq ochiq emas.', ui.kbFor(ctx));
    const given = own.task.source !== 'self' && own.task.created_by && Number(own.task.created_by) !== Number(emp.tg_id);
    const text = `✅ <b>${esc(own.task.title)}</b> — bajarildi${proof ? ' (isbot bilan)' : ''}.${given ? '\nTopshiriq bergan odamga xabar bordi.' : ''}`;
    if (ctx.updateType === 'callback_query') await render(ctx, text); else await ctx.reply(text, { parse_mode: 'HTML' });
    await ctx.reply('👌', ui.kbFor(ctx));
    return;
  }
  const res = await tasks.markDone(s.doneTaskId, emp.id, proof);
  session.clear(ctx.from.id);
  if (!res.ok) return ctx.reply('Topshiriq ochiq emas.', ui.kbFor(ctx));
  const t = res.task;
  const overdue = String(t.done_at).slice(0, 10) > t.due_date;
  const left = (await tasks.openFor(emp.id)).length;
  activity.mark(ctx, 'task_done', { title: t.title, detail: `${left ? `yana ${left} ta qoldi` : 'barcha ishlar tugadi'}${proof ? ' · isbot bilan' : ''}` });
  const text = `✅ <b>${esc(t.title)}</b> — tekshiruvga yuborildi${proof ? ' (isbot bilan)' : ''}.${overdue ? '\n⚠️ Muddatdan kech bajarildi.' : ''}${album ? '\n<i>ℹ️ Albomdan bitta fayl isbot sifatida saqlandi.</i>' : ''}\n<i>${left ? `Qolgan: ${left} ta` : '🎉 Ochiq topshiriq qolmadi!'}</i>`;
  if (ctx.updateType === 'callback_query') await render(ctx, text); else await ctx.reply(text, { parse_mode: 'HTML' });
  await ctx.reply('👌', ui.kbFor(ctx));
  if (config.announceDone) {
    await notify.toGroup(botOf(ctx), `✅ ${reports.mentionHtml(emp)} — «<b>${esc(t.title)}</b>» bajarildi · ${time.clock(t.done_at)}\n<i>${left ? `Qolgan topshiriqlar: ${left} ta` : '🎉 Barcha topshiriqlar bajarildi!'}</i>`);
  }
  await notify.toDoneReviewers(
    botOf(ctx), emp, t,
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

// --- Bir nechtasini birdaniga (done:multi → done:t:<id> → done:go → bitta isbot hammasiga) ---

const showDoneMulti = async (ctx, picked = []) => {
  if (!mustEmployee(ctx)) return;
  const open = await tasks.openFor(ctx.state.employee.id);
  if (!open.length) return showDone(ctx);
  const ids = new Set(open.map((t) => Number(t.id)));
  const keep = picked.map(Number).filter((id) => ids.has(id));
  session.set(ctx.from.id, { step: 'done_pick', donePicked: keep });
  const chosen = open.filter((t) => keep.includes(Number(t.id)));
  return render(
    ctx,
    `☑️ <b>Bajarganlaringizni belgilang</b>\n<i>Bir nechtasini tanlab, «✅ Davom etish» ni bosing — bitta isbot (rasm, video, fayl…) hammasiga biriktiriladi.</i>\n\n` +
      `Tanlangan: <b>${chosen.length} ta</b>${chosen.length ? `\n${chosen.map((t) => `☑️ ${esc(t.title)}`).join('\n')}` : ''}`,
    ui.doneMultiKeyboard(open, keep),
  );
};

const toggleDonePick = async (ctx, id) => {
  const s = session.get(ctx.from.id);
  const picked = (s.step === 'done_pick' && s.donePicked) || [];
  const n = Number(id);
  await ctx.answerCbQuery();
  return showDoneMulti(ctx, picked.includes(n) ? picked.filter((x) => x !== n) : [...picked, n]);
};

const toggleDoneAll = async (ctx) => {
  const s = session.get(ctx.from.id);
  const picked = (s.step === 'done_pick' && s.donePicked) || [];
  const open = await tasks.openFor(ctx.state.employee.id);
  await ctx.answerCbQuery();
  return showDoneMulti(ctx, picked.length === open.length ? [] : open.map((t) => Number(t.id)));
};

const allBossOwn = async (emp, ids) => {
  for (const id of ids) if (!tasks.isBossOwn(emp, await tasks.byId(id))) return false;
  return true;
};

const goDoneMulti = async (ctx) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (s.step !== 'done_pick' || !emp) return ctx.answerCbQuery('Eskirgan tugma');
  const list = [];
  for (const id of s.donePicked || []) {
    const t = await tasks.byId(id);
    if (t && Number(t.employee_id) === Number(emp.id) && t.status === 'active') list.push(t);
  }
  if (!list.length) return ctx.answerCbQuery('Avval kamida bittasini belgilang ☑️', { show_alert: true });
  const blocked = await flows.doneBlocked(emp);
  if (blocked) { session.clear(ctx.from.id); await ctx.answerCbQuery(); return render(ctx, blocked); }
  if (list.length === 1) return pickDone(ctx, list[0].id);
  session.set(ctx.from.id, { step: 'done_proof', doneTaskIds: list.map((t) => Number(t.id)) });
  await ctx.answerCbQuery();
  const head = `📎 <b>${list.length} ta ish:</b>\n${list.map((t, i) => `${i + 1}. ${esc(t.title)}`).join('\n')}\n\n`;
  if (await allBossOwn(emp, list.map((t) => t.id))) {
    return render(ctx, `${head}Isbot <b>ixtiyoriy</b>: xohlasangiz 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl yuboring — yoki «✅ Isbotsiz bajardim» ni bosing.`, ui.proofKeyboard({ noProof: true }));
  }
  if (!config.proofRequired) {
    return render(ctx, `${head}Bitta isbot hammasiga biriktiriladi: 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl yuboring — izohni ostiga yozsangiz bo'ladi.\nIsbot bo'lmasa — «⏭ Isbotsiz yuborish».`, ui.proofKeyboard({ optional: true }));
  }
  return render(ctx, `${head}<b>Isbot majburiy:</b> 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl yuboring — bitta isbot hammasiga biriktiriladi.`, ui.proofKeyboard());
};

const finishDoneMany = async (ctx, proof, ids) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  const blocked = await flows.doneBlocked(emp);
  if (blocked) return ctx.reply(blocked, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  const own = [];
  const sent = [];
  for (const id of ids) {
    const cur = await tasks.byId(id);
    if (!cur) continue;
    if (tasks.isBossOwn(emp, cur)) {
      // boshliqning topshirig'i — darhol bajarildi, bergan odamga xabar (flows.completeBossTask)
      const r = await flows.completeBossTask(botOf(ctx), emp, id, proof);
      if (r.ok) own.push(r.task);
    } else {
      const r = await tasks.markDone(id, emp.id, proof);
      if (r.ok) sent.push(r.task);
    }
  }
  if (!own.length && !sent.length) return ctx.reply('Tanlangan topshiriqlar ochiq emas.', ui.kbFor(ctx));
  const left = (await tasks.openFor(emp.id)).length;
  const isLate = (t) => String(t.done_at).slice(0, 10) > t.due_date;
  for (const t of sent) activity.mark(ctx, 'task_done', { title: t.title, detail: `birga ${ids.length} ta · ${left ? `yana ${left} ta qoldi` : 'barcha ishlar tugadi'}${proof ? ' · isbot bilan' : ''}` });
  const lines = [
    ...own.map((t) => `✅ ${esc(t.title)}`),
    ...sent.map((t) => `🕓 ${esc(t.title)}${isLate(t) ? ' 🔴 <i>kech</i>' : ''}`),
  ];
  const text = `✅ <b>${own.length + sent.length} ta ish belgilandi</b>${proof ? ' (isbot bilan)' : ''}:\n${lines.join('\n')}` +
    (sent.length ? '\n\n<i>🕓 — tekshiruvga yuborildi.</i>' : '') +
    `\n<i>${left ? `Qolgan: ${left} ta` : '🎉 Ochiq topshiriq qolmadi!'}</i>`;
  if (ctx.updateType === 'callback_query') await render(ctx, text); else await ctx.reply(text, { parse_mode: 'HTML' });
  await ctx.reply('👌', ui.kbFor(ctx));
  const all = [...own, ...sent];
  if (config.announceDone && sent.length) {
    await notify.toGroup(botOf(ctx), `✅ ${reports.mentionHtml(emp)} — ${sent.length} ta ish bajarildi:\n${sent.map((t) => `• <b>${esc(t.title)}</b>`).join('\n')}\n<i>${left ? `Qolgan topshiriqlar: ${left} ta` : '🎉 Barcha topshiriqlar bajarildi!'}</i>`);
  }
  // tekshiruvchilar har ishda boshqacha bo'lishi mumkin (topshiriqni bergan odam) — bir xil oluvchilar to'plamiga bitta xabar
  const groups = new Map();
  for (const t of sent) {
    const ids = [...new Set((await employees.doneReviewersOf(emp, t)).map(Number))].sort((x, y) => x - y);
    const key = ids.join(',');
    if (!groups.has(key)) groups.set(key, { ids, list: [] });
    groups.get(key).list.push(t);
  }
  for (const { ids: to, list } of groups.values()) {
    await notify.sendWithInfoCopies(
      botOf(ctx), emp, to,
      `🕓 <b>${esc(emp.full_name)}</b> ${list.length} ta ishni bajardi:\n` +
        list.map((t, i) => `${i + 1}. <b>${esc(t.title)}</b> · ⏱ ${time.prettyDate(t.due_date)}${isLate(t) ? ' 🔴 <i>kech</i>' : ' ✅'}${t.source === 'self' ? " <i>(o'zi yozgan)</i>" : ''}`).join('\n') +
        `\n🕒 ${time.clock(list[0].done_at)}` +
        (proof && proof.note ? `\n💬 «${esc(proof.note)}»` : '') +
        `\n\nQabul qilasizmi?`,
      list.length === 1 ? ui.reviewKeyboard(list[0].id) : ui.reviewMultiKeyboard(list),
      proof && proof.fileId ? proof : null,
    );
  }
  if (proof && proof.fileId) {
    await notify.toArchive(botOf(ctx), `✔️ <b>${esc(emp.full_name)}</b> bajardi (${all.length} ta):\n${all.map((t) => `• ${esc(t.title)}`).join('\n')}\n🕒 ${time.clock(all[0].done_at)}${proof.note ? `\n💬 «${esc(proof.note)}»` : ''}`, proof);
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
  if ((s.step === 'assign_media_title' && ctx.state.isManager) || (s.step === 'self_media_title' && ctx.state.employee)) {
    return ctx.reply("✍️ Media allaqachon qabul qilindi. Endi <b>matn bilan</b> qisqacha yozing — topshiriq nima haqida:", { parse_mode: 'HTML', ...ui.cancelKeyboard() });
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

const reviewScope = (ctx) => access.deptScope(ctx.state.actor);

/** HR: «Bajardim» xabarlari o'ziga kelsinmi — o'zi tanlaydi (standart: kelmaydi, ro'yxatda baribir ko'rinadi) */
const hrNotifyRow = (ctx) => (ctx.state.isHr && ctx.state.employee
  ? [[cb(`🔔 «Bajardim» xabarlari menga: ${employees.wantsDoneNotify(ctx.state.employee) ? '✅ kelsin' : '🚫 kelmasin'}`, `rv:hrn:${employees.wantsDoneNotify(ctx.state.employee) ? 0 : 1}`)]]
  : []);
const HR_NOTIFY_HINT = "\n\n<i>«Bajardim» xabarlari bo'lim rahbari va boshliqqa boradi. Sizga ham kelsinmi — pastdagi tugma bilan o'zingiz tanlaysiz; o'zingiz bergan topshiriqlar baribir keladi.</i>";

const showReview = async (ctx) => {
  if (!ctx.state.isManager) return ctx.reply('⛔️ Faqat boshliq va direktor uchun.');
  const list = tasks.visibleFor(ctx.state.actor, await tasks.pendingReview(reviewScope(ctx)));
  const hint = ctx.state.isHr && ctx.state.employee ? HR_NOTIFY_HINT : '';
  if (!list.length) return render(ctx, `🔎 <b>TEKSHIRUV</b>\n\nHozircha «Bajardim» deb yuborilgan ish yo'q.${hint}`, hint ? inline(hrNotifyRow(ctx)) : undefined);
  const rows = list.map((t) => [cb(`🕓 ${t.full_name.split(' ')[0]}: ${t.title.slice(0, 35)}`, `rv:view:${t.id}`)]);
  rows.push([cb('🔄 Yangilash', 'rv:list')], ...hrNotifyRow(ctx));
  return render(ctx, `🔎 <b>TEKSHIRUV (${list.length})</b>\n\n${ui.taskList(list, { withName: true })}\n\n👇 Birini tanlang.${hint}`, inline(rows));
};

const toggleHrNotify = async (ctx) => {
  const me = ctx.state.employee;
  if (!ctx.state.isHr || !me) return ctx.answerCbQuery('⛔️ Faqat HR uchun');
  if (!ctx.match || !ctx.match[1]) { await ctx.answerCbQuery('Eskirgan tugma'); return showReview(ctx); }
  const on = ctx.match[1] === '1';
  await employees.setNotifyDone(me.id, on);
  ctx.state.employee = await employees.byId(me.id);
  await ctx.answerCbQuery(on ? '✅ «Bajardim» xabarlari sizga ham keladi' : '🚫 «Bajardim» xabarlari endi sizga kelmaydi');
  return showReview(ctx);
};

const viewReview = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t || t.status !== 'done') return ctx.answerCbQuery('Bu ish tekshiruvda emas');
  const emp = await employees.byId(t.employee_id);
  if (!employees.canManage(ctx.state.employee, ctx.state.isAdmin, emp) || !tasks.visibleTo(ctx.state.actor, t)) return ctx.answerCbQuery("⛔️ Bu sizning bo'limingiz emas");
  await ctx.answerCbQuery();
  const overdue = String(t.done_at).slice(0, 10) > t.due_date;
  const kb = canCancel(ctx, t)
    ? inline([...ui.reviewKeyboard(t.id).reply_markup.inline_keyboard, [cb("🗑 O'chirish (bekor qilish)", `tk:del:${t.id}`)]])
    : ui.reviewKeyboard(t.id);
  const caption = `🕓 <b>${esc(t.full_name)}</b>: <b>${esc(t.title)}</b>\n⏱ muddat ${time.prettyDate(t.due_date)} · bajarildi ${String(t.done_at).slice(0, 10) === time.today() ? time.clock(t.done_at) : time.prettyDate(String(t.done_at).slice(0, 10))}${overdue ? ' 🔴 kech' : ' ✅'}${t.proof_note ? `\n💬 «${esc(t.proof_note)}»` : ''}`;
  if (t.proof_file_id) return notify.sendProof(botOf(ctx), ctx.chat.id, { type: t.proof_type, fileId: t.proof_file_id }, caption, kb);
  return ctx.reply(`${caption}\n<i>(isbot biriktirilmagan)</i>`, { parse_mode: 'HTML', ...kb });
};

const reviewGuard = async (ctx, id) => {
  const t = await tasks.byId(id);
  if (!t) { await ctx.answerCbQuery('Topilmadi'); return null; }
  if (t.status !== 'done') { await ctx.answerCbQuery('Bu ish allaqachon ko\'rib chiqilgan'); return null; }
  const emp = await employees.byId(t.employee_id);
  if (!access.canReview(ctx.state.actor, emp) || !tasks.visibleTo(ctx.state.actor, t)) {
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

/** Bir nechta ishli xabar: qabul qilingan ish qatorini tugmalardan olib tashlaydi. true — xabarda boshqa ishlar hali bor */
const dropReviewRow = async (ctx, id, label) => {
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  const kb = msg && msg.reply_markup && msg.reply_markup.inline_keyboard;
  if (!kb) return false;
  const others = kb.flat().filter((b) => /^rv:ok:\d+$/.test(b.callback_data || '') && b.callback_data !== `rv:ok:${id}`);
  const rest = [];
  for (const b of others) {
    const t = await tasks.byId(b.callback_data.split(':')[2]);
    if (t && t.status === 'done') rest.push(t);
  }
  if (!rest.length) return false;
  try { await ctx.editMessageReplyMarkup((rest.length === 1 ? ui.reviewKeyboard(rest[0].id) : ui.reviewMultiKeyboard(rest)).reply_markup); } catch { /* eskirgan xabar */ }
  await ctx.reply(`✅ <b>Qabul qilindi</b> — ${esc(label)}`, { parse_mode: 'HTML' }).catch(() => {});
  return true;
};

/** «Hammasini qabul qilish» (rv:okm:1,2,3) */
const doAcceptMany = async (ctx, idsStr) => {
  const ids = idsStr.split(',').map(Number).filter(Boolean);
  const done = [];
  for (const id of ids) {
    const t = await tasks.byId(id);
    if (!t || t.status !== 'done') continue;
    const emp = await employees.byId(t.employee_id);
    if (!access.canReview(ctx.state.actor, emp)) return ctx.answerCbQuery("⛔️ Ruxsat yo'q");
    const res = await flows.acceptTask(botOf(ctx), id, ctx.from.id);
    if (!res.ok) continue;
    activity.mark(ctx, 'review_ok', { title: t.title, detail: emp.full_name });
    done.push({ t, emp, onTime: res.onTime });
  }
  if (!done.length) return ctx.answerCbQuery("Bu ishlar allaqachon ko'rib chiqilgan.");
  await ctx.answerCbQuery(`Qabul qilindi ✅ (${done.length} ta)`);
  await editAny(ctx, `✅ <b>Qabul qilindi (${done.length} ta)</b> — ${esc(done[0].emp.full_name)}:\n` +
    done.map((d) => `• ${esc(d.t.title)}${d.onTime ? '' : ' <i>(muddatdan kech)</i>'}`).join('\n'));
};

const doAccept = async (ctx, id) => {
  const g = await reviewGuard(ctx, id);
  if (!g) return;
  const res = await flows.acceptTask(botOf(ctx), id, ctx.from.id);
  if (!res.ok) return ctx.answerCbQuery("Bu ish allaqachon ko'rib chiqilgan");
  activity.mark(ctx, 'review_ok', { title: g.t.title, detail: g.emp.full_name });
  await ctx.answerCbQuery('Qabul qilindi ✅');
  if (await dropReviewRow(ctx, id, `${g.emp.full_name}: ${g.t.title}`)) return;
  await editAny(ctx, `✅ <b>Qabul qilindi</b> — ${esc(g.emp.full_name)}: ${esc(g.t.title)}${res.onTime ? '' : ' <i>(muddatdan kech)</i>'}`);
};

const startReturn = async (ctx, id) => {
  const g = await reviewGuard(ctx, id);
  if (!g) return;
  session.set(ctx.from.id, { step: 'return_note', returnTaskId: id });
  await ctx.answerCbQuery();
  return ctx.reply(
    `📝 <b>${esc(g.t.title)}</b> — qanday kamchiliklar bor? Nimani tuzatish kerak — yozing.\n<i>Hodimga boradi; u «👌 Xo'p, tushundim» yoki o'z javobini qaytaradi, siz yana javob bera olasiz.</i>`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const handleReturnNote = async (ctx, { skip = false } = {}) => {
  const s = session.get(ctx.from.id);
  if (skip || !String(ctx.message.text || '').trim()) return ctx.reply('📝 Kamchiliklarni yozing — hodim nimani tuzatishini bilsin:', ui.cancelKeyboard());
  session.clear(ctx.from.id);
  if (!s.returnTaskId) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const note = ctx.message.text.trim().slice(0, 300);
  const pending = await tasks.byId(s.returnTaskId);
  if (!pending || pending.status !== 'done') return ctx.reply("Bu ish allaqachon ko'rib chiqilgan.", ui.kbFor(ctx));
  if (!access.canReview(ctx.state.actor, await employees.byId(pending.employee_id))) return ctx.reply("⛔️ Ruxsat yo'q", ui.kbFor(ctx));
  // 5-okt: tuzatish muddati — shu sanagacha tuzatsa vaqtida; muddat berilmasa eski muddat qoladi (o'tgan bo'lsa — kechikkan)
  session.set(ctx.from.id, { step: 'return_due', returnTaskId: pending.id, returnNote: note });
  const old = pending.due_date;
  return ctx.reply(
    `🔁 <b>Tuzatish muddati</b> — hodim qachongacha tuzatsin?\n<i>Shu kungacha tuzatsa — vaqtida hisoblanadi. Muddat bermasangiz eski muddat (${time.prettyDate(old)}) qoladi${old < time.today() ? " — u o'tgan, tuzatilsa ham <b>kechikkan</b> hisoblanadi" : ''}.</i>`,
    { parse_mode: 'HTML', ...inline([
      [cb('Bugun', `rv:fd:${pending.id}:0`), cb('Ertaga', `rv:fd:${pending.id}:1`), cb('Indinga', `rv:fd:${pending.id}:2`)],
      [cb('✍️ Sana yozish', `rv:fd:${pending.id}:type`)],
      [cb(`⏭ Muddatsiz (eski: ${time.prettyDate(old)})`, `rv:fd:${pending.id}:none`)],
    ]) },
  );
};

const finishReturn = async (ctx, taskId, note, { countLate = false, fixDue = null } = {}) => {
  const res = await flows.returnTask(botOf(ctx), taskId, ctx.from.id, note, { countLate, fixDue });
  if (!res.ok) return ctx.reply("Bu ish allaqachon ko'rib chiqilgan.", ui.kbFor(ctx));
  const t = res.task;
  activity.mark(ctx, 'review_back', { title: t.title, detail: note });
  const dueText = fixDue ? `\n🔁 Tuzatish muddati: <b>${time.prettyDate(t.due_date)}</b>` : `\n⏱ Eski muddat qoldi: ${time.prettyDate(t.due_date)}${t.due_date < time.today() ? ' — <b>kechikkan</b> hisoblanadi' : ''}`;
  await ctx.reply(`↩️ Kamchiliklar bilan qaytarildi: <b>${esc(t.title)}</b>\n📝 «${esc(note)}»${dueText}${countLate ? '\n⏰ Kechikish KPI da qoladi.' : ''}\n<i>Hodim javobi sizga keladi. Tuzatilayotganlar — «${ui.BTN.stFix}» ro'yxatida.</i>`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
};

/** rv:fd:<id>:<0|1|2|type|none> — tuzatish muddati tanlovi */
const onReturnDue = async (ctx) => {
  const id = Number(ctx.match[1]);
  const pick = ctx.match[2];
  const s = session.get(ctx.from.id);
  if (s.step !== 'return_due' || Number(s.returnTaskId) !== id) return ctx.answerCbQuery('Eskirgan tugma — qaytadan «📝 Kamchilik bor» ni bosing', { show_alert: true });
  const pending = await tasks.byId(id);
  if (!pending || pending.status !== 'done') { session.clear(ctx.from.id); return ctx.answerCbQuery("Bu ish allaqachon ko'rib chiqilgan", { show_alert: true }); }
  if (!access.canReview(ctx.state.actor, await employees.byId(pending.employee_id))) return ctx.answerCbQuery("⛔️ Ruxsat yo'q");
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  if (pick === 'type') return askTypedDate(ctx, 'rv', { returnTaskId: id, returnNote: s.returnNote });
  session.clear(ctx.from.id);
  return finishReturn(ctx, id, s.returnNote, { fixDue: pick === 'none' ? null : dueFromDays(pick) });
};

/** rv:rl:<id>:<1|0> — qaytarishda kechikish tanlovi */
const onReturnLate = async (ctx) => {
  const id = Number(ctx.match[1]);
  const s = session.get(ctx.from.id);
  if (s.step !== 'return_late' || Number(s.returnTaskId) !== id) return ctx.answerCbQuery('Eskirgan tugma — qaytadan «📝 Kamchilik bor» ni bosing', { show_alert: true });
  session.clear(ctx.from.id);
  const pending = await tasks.byId(id);
  if (!pending || pending.status !== 'done') return ctx.answerCbQuery("Bu ish allaqachon ko'rib chiqilgan", { show_alert: true });
  if (!access.canReview(ctx.state.actor, await employees.byId(pending.employee_id))) return ctx.answerCbQuery("⛔️ Ruxsat yo'q");
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  return finishReturn(ctx, id, s.returnNote, { countLate: ctx.match[2] === '1' });
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
  const cur = await tasks.byId(s.taskId);
  if (!cur || cur.status !== 'active' || !canEdit(ctx, cur)) return ctx.reply("🔒 Topshiriq endi o'zgartirib bo'lmaydi.", ui.kbFor(ctx));
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
  bot.command(['topshiriqlarim', 'missiyalarim'], showMyTasks);
  bot.command('bugun', addTodayTask);
  bot.command('topshiriqlarim', showMyTasks);
  // ak:<id> · ak:l:<id,id,…> (xabardagi ro'yxat) · ak:all — eski xabarlar
  bot.action(/^ak:(\d+|all|l:[\d,]+)$/, async (ctx) => {
    const emp = ctx.state.employee;
    if (!emp) return ctx.answerCbQuery('⛔️');
    const m = ctx.match[1];
    const ids = m === 'all' ? null : m.startsWith('l:') ? m.slice(2).split(',').map(Number).filter(Boolean) : [Number(m)];
    const done = await flows.ackTasks(botOf(ctx), emp, ids);
    await ctx.answerCbQuery(done.length ? `✅ ${done.length} ta topshiriq — tushundim` : 'Allaqachon belgilangan');
    if (done.length) await ctx.reply(`👂 Belgilandi: «Tushundim» — ${done.map((t) => `«${t.title}»`).join(', ')}.\nTopshiriq bergan odam xabardor qilindi.`, ui.kbFor(ctx));
  });
  bot.action(/^tk:media:(\d+)$/, async (ctx) => {
    const t = await tasks.byId(ctx.match[1]);
    const emp = ctx.state.employee;
    const target = t ? await employees.byId(t.employee_id) : null;
    const mine = emp && t && Number(t.employee_id) === Number(emp.id);
    if (!t || !t.task_file_id || !tasks.visibleTo(ctx.state.actor, t) || !(mine || ctx.state.isAdmin || ctx.state.isHr || (ctx.state.isManager && employees.canManage(emp, ctx.state.isAdmin, target)))) return ctx.answerCbQuery("Topilmadi");
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
    if (!access.canSetDue(ctx.state.actor, t, d)) return ctx.reply(access.DUE_LOCKED, ui.kbFor(ctx));
    await tasks.setDue(t.id, d);
    if (d !== t.due_date) await tellReviewers(ctx, t, `📆 <b>${esc(ctx.state.employee ? ctx.state.employee.full_name : '')}</b> muddatni o'zgartirdi: ${esc(t.title)}\n${time.prettyDate(t.due_date)} → ${time.prettyDate(d)}`);
    return showTaskMenu(ctx, t.id);
  });
  const cancelGuard = async (ctx, id) => {
    const t = await tasks.byId(id);
    if (!t || !['active', 'done'].includes(t.status)) { await ctx.answerCbQuery('Topshiriq allaqachon yopilgan'); return null; }
    if (!canCancel(ctx, t)) { await ctx.answerCbQuery("⛔️ O'z topshirig'ingizni o'chirib bo'lmaydi — rahbaringiz bekor qiladi", { show_alert: true }); return null; }
    return t;
  };
  bot.action(/^tk:del:(\d+)$/, async (ctx) => {
    const t = await cancelGuard(ctx, ctx.match[1]);
    if (!t) return;
    await ctx.answerCbQuery();
    const back = t.status === 'active' ? `tk:${t.id}` : 'tk:keep';
    return render(ctx, `🗑 <b>${esc(t.full_name)}</b>: <b>${esc(t.title)}</b> — o'chirilsinmi (bekor qilinsinmi)?\n<i>Ro'yxatlardan, tekshiruvdan va KPI dan chiqadi; yozuv bazada «bekor qilingan» bo'lib qoladi.</i>`, ui.confirmKeyboard(`tk:delok:${t.id}`, back, "🗑 Ha, o'chirilsin"));
  });
  bot.action('tk:keep', async (ctx) => { await ctx.answerCbQuery(); return render(ctx, "👌 O'chirilmadi."); });
  bot.action(/^tk:delok:(\d+)$/, async (ctx) => {
    const t = await cancelGuard(ctx, ctx.match[1]);
    if (!t) return;
    await flows.cancelTask(botOf(ctx), t, ctx.state.employee ? ctx.state.employee.id : null, ctx.from.id);
    activity.mark(ctx, 'task_cancel', { title: t.title, detail: t.full_name });
    await ctx.answerCbQuery("O'chirildi");
    return render(ctx, `🗑 O'chirildi (bekor qilindi): <s>${esc(t.title)}</s> — ${esc(t.full_name)}`);
  });

  // o'zimga vazifa
  bot.hears(ui.BTN.selfTask, startSelfTask);
  bot.command('vazifa', startSelfTask);
  bot.action(/^st:due:(\d+|type)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') return askTypedDate(ctx, 'st', { titles: session.get(ctx.from.id).titles });
    return askStartTime(ctx, 'st', dueFromDays(ctx.match[1]));
  });
  bot.action(/^st:tm:(\d{4}|-|type)$/, async (ctx) => { await ctx.answerCbQuery(); return pickStartTime(ctx, 'st', ctx.match[1]); });
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
  bot.action('as:multi', async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await multiPick.show(ctx, { reset: true }); });
  multiPick.register(bot);
  bot.action(/^as:emp:(\d+)$/, async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await pickEmployee(ctx, ctx.match[1]); });
  bot.action(/^as:due:(\d+|type)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') return askTypedDate(ctx, 'as', { assign: session.get(ctx.from.id).assign });
    return askStartTime(ctx, 'as', dueFromDays(ctx.match[1]));
  });
  bot.action(/^as:tm:(\d{4}|-|type)$/, async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); return pickStartTime(ctx, 'as', ctx.match[1]); });
  bot.action('as:cancel', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); await render(ctx, '❌ Bekor qilindi.'); });

  // bajardim
  bot.hears(ui.BTN.done, showDone);
  bot.command('bajardim', showDone);
  bot.action('done:list', async (ctx) => { await ctx.answerCbQuery(); await showDone(ctx); });
  bot.action(/^done:(\d+)$/, (ctx) => pickDone(ctx, ctx.match[1]));
  bot.action('done:np', async (ctx) => {
    const s = session.get(ctx.from.id);
    const emp = ctx.state.employee;
    // bosqich avval tekshiriladi — eskirgan tugmada doneTaskId yo'q (Postgres byId(undefined) ga xato beradi)
    const own = s.step === 'done_proof' && emp && (s.doneTaskIds ? await allBossOwn(emp, s.doneTaskIds) : s.doneTaskId && tasks.isBossOwn(emp, await tasks.byId(s.doneTaskId)));
    if (!own) return ctx.answerCbQuery('📎 Isbot majburiy: rasm, video, audio yoki fayl yuboring', { show_alert: true });
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
  bot.action('done:multi', async (ctx) => { if (!ctx.state.employee) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await showDoneMulti(ctx); });
  bot.action(/^done:t:(\d+)$/, (ctx) => (ctx.state.employee ? toggleDonePick(ctx, ctx.match[1]) : ctx.answerCbQuery('⛔️')));
  bot.action('done:all', (ctx) => (ctx.state.employee ? toggleDoneAll(ctx) : ctx.answerCbQuery('⛔️')));
  bot.action('done:go', goDoneMulti);
  bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], onMedia);

  // tekshiruv
  bot.hears(ui.BTN.review, showReview);
  bot.command('tekshiruv', showReview);
  bot.action('rv:list', async (ctx) => { await ctx.answerCbQuery(); await showReview(ctx); });
  bot.action(/^rv:hrn(?::([01]))?$/, toggleHrNotify);
  bot.command('bajardim_xabar', showReview);
  bot.action(/^rv:view:(\d+)$/, (ctx) => viewReview(ctx, ctx.match[1]));
  bot.action(/^rv:ok:(\d+)$/, (ctx) => doAccept(ctx, ctx.match[1]));
  bot.action(/^rv:okm:([\d,]+)$/, (ctx) => doAcceptMany(ctx, ctx.match[1]));
  bot.action(/^rv:back:(\d+)$/, (ctx) => startReturn(ctx, ctx.match[1]));
  bot.action(/^rv:rl:(\d+):([01])$/, onReturnLate);
  bot.action(/^rv:fd:(\d+):(0|1|2|type|none)$/, onReturnDue);
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
  register, parseTitle, handleSelfTaskText, handleAssignText, handleSelfMediaTitle, handleAssignMediaTitle, handleTypedDate, handleTypedTime, handleReturnNote, handleEditTitle, showMyTasks, showReview, addTodayTask,
};
