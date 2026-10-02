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

const makeTasks = async ({ employeeId, titles, dueDate, createdBy, source, priority = null, media = null }) => {
  const created = [];
  for (const raw of titles) {
    const p = parseTitle(raw);
    if (p.title) created.push(await tasks.create({ employeeId, title: p.title, dueDate, createdBy, source, priority: priority || p.priority, media }));
  }
  return created;
};

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
const assignTasks = async (bot, giver, target, titles, dueDate, { priority = null, media = null } = {}) => {
  const source = giver.isAdmin ? 'admin' : 'head';
  const created = await makeTasks({ employeeId: target.id, titles, dueDate, createdBy: giver.tgId, source, priority, media });
  if (!created.length) return { created, source };
  const ackKb = ui.inline(ui.ackRows(created));
  await notify.toUser(
    bot, target.tg_id,
    `📥 <b>Yangi topshiriq!</b> — <i>${esc(giver.name)}</i>\n⏱ Muddat: <b>${time.prettyDate(dueDate)}</b>\n\n${ui.taskList(created)}\n\n` +
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
    await notify.toSeeAll(bot, `📤 <b>${esc(giver.name)}</b> → <b>${esc(target.full_name)}</b>: ${created.length} ta topshiriq (${time.prettyDate(dueDate)})\n${ui.taskList(created)}`, {}, giver.tgId);
  }
  return { created, source };
};

/** Hodim o'ziga vazifa yozadi — tekshiruvchilarga xabar */
const addSelfTasks = async (bot, emp, titles, dueDate, { priority = null, media = null } = {}) => {
  const created = await makeTasks({ employeeId: emp.id, titles, dueDate, createdBy: emp.tg_id, source: 'self', priority, media });
  created.forEach((t) => activity.track(emp, 'task_add', { title: t.title, detail: `muddat ${time.prettyDate(dueDate)}` }));
  if (created.length && !employees.isBoss(emp)) {
    await notify.toReviewers(bot, emp, `📝 <b>${esc(emp.full_name)}</b> o'ziga ${created.length} ta vazifa yozdi (muddat ${time.prettyDate(dueDate)}):\n${ui.taskList(created)}`);
  }
  return created;
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

/** Qabul qilish → hodimga xabar. { ok, task } */
const acceptTask = async (bot, taskId, byTgId) => {
  const res = await tasks.accept(taskId, byTgId);
  if (!res.ok) return res;
  const onTime = tasks.isOnTime(res.task);
  await notify.toUser(bot, res.task.tg_id, `✅ <b>Qabul qilindi:</b> ${esc(res.task.title)}${onTime ? ' 👏' : '\n<i>Muddatdan kech bajarilgani KPI da hisobga olinadi.</i>'}`);
  return { ...res, onTime };
};

/** Qaytarish (izoh bilan) → hodimga xabar */
const returnTask = async (bot, taskId, byTgId, note = null) => {
  const res = await tasks.returnBack(taskId, byTgId, note);
  if (!res.ok) return res;
  const t = res.task;
  await notify.toUser(bot, t.tg_id, `↩️ <b>Qaytarildi:</b> ${esc(t.title)}${note ? `\n💬 «${esc(note)}»` : ''}\n\nQayta bajarib «${ui.BTN.done}» bosing. Muddat: ${time.prettyDate(t.due_date)}.`);
  return res;
};

/** Bekor qilish. Hodimning o'zi bekor qilmagan bo'lsa unga xabar */
const cancelTask = async (bot, task, byEmployeeId = null, byTgId = null) => {
  const t = await tasks.cancel(task.id, byTgId);
  if (t && Number(t.employee_id) !== Number(byEmployeeId)) await notify.toUser(bot, t.tg_id, `🗑 Topshiriq bekor qilindi: <s>${esc(t.title)}</s>`);
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
 * «Kelmayman» — sababli kun so'rovi. Tasdiqlash tugmalari faqat rahbariyatga (boshliq + HR), bo'lim rahbariga — xabar.
 * Rahbariyatning o'zi (boshliq yoki HR) aytsa — hech kimdan so'ralmaydi: darhol sababli, boshqalarga xabar. { row, auto }
 */
const requestAbsence = async (bot, emp, reason, proof = null) => {
  const who = `<b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''}`;
  if (employees.isTop(emp)) {
    await attendance.requestExcuse(emp.id, reason, time.today(), proof);
    const row = await attendance.decideExcuse(emp.id, time.today(), 'approved', emp.tg_id);
    const text = `🙋 ${who} bugun kelmaydi (rahbariyat — sababli):\n«${esc(reason)}»`;
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

/** «Ketdim». { row, worked, done, open } — avval kelgan va hali ketmagan bo'lishi kerak (chaqiruvchi tekshiradi) */
const checkOut = async (bot, emp) => {
  const row = await attendance.checkOut(emp.id);
  const worked = attendance.workedMinutes(row);
  const done = await tasks.doneOn(emp.id);
  const open = await tasks.openFor(emp.id);
  await notify.toReviewers(bot, emp, `🏁 <b>${esc(emp.full_name)}</b> ketdi · ${time.clock(row.checked_out)}${worked !== null ? ` · ⏱ ${time.prettyDuration(worked)}` : ''} · ✅ ${done.length} · ⏳ ${open.length}`);
  return { row, worked, done, open };
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
  notify.toUser(bot, e.tg_id, `🏠 Uy joylashuvingiz direktor tomonidan tozalandi. Keyingi «${ui.BTN.checkIn}» da uyda turib qaytadan belgilaysiz.`);

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
  remindCurrentText, requestReminders, decideReminders, setReminderTimes,
  parseTitle, splitTitles, mediaTitles, sendTaskMedia, ackTasks, assignTasks, addSelfTasks, acceptTask, returnTask, cancelTask,
  lateNotice, lateNoticeRule, requestAbsence, checkOut, decideExcuse, markExcused,
  kpiDecisionNotice, decideKpi, welcome, roleNotice, hrNotice, modeNotice, homeClearedNotice, setActive, announceWorktime,
  recipientsLabel: org.recipientsLabel,
};
