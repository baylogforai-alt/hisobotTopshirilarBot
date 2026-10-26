'use strict';

const { Telegraf } = require('telegraf');
const config = require('./config');
const session = require('./session');
const ui = require('./ui');
const activity = require('./services/activity');

const commonHandler = require('./handlers/common');
const joinHandler = require('./handlers/join');
const attendanceHandler = require('./handlers/attendance');
const tasksHandler = require('./handlers/tasks');
const dailyReportHandler = require('./handlers/dailyReport');
const adminHandler = require('./handlers/admin');
const kpiHandler = require('./handlers/kpi');
const kpiCalcHandler = require('./handlers/kpiCalc');
const reportsHandler = require('./handlers/reports');
const hrHandler = require('./handlers/hr');
const periodHandler = require('./handlers/period');
const excelMenuHandler = require('./handlers/excelMenu');
const announceHandler = require('./handlers/announce');
const fieldHandler = require('./handlers/field');
const monthHandler = require('./handlers/month');
const teamHandler = require('./handlers/team');
const remindersHandler = require('./handlers/reminders');
const directionsHandler = require('./handlers/directions');
const journalHandler = require('./handlers/journal');
const meetingHandler = require('./handlers/meeting');
const recurringHandler = require('./handlers/recurring');
const chatHandler = require('./handlers/chat');
const warnHandler = require('./handlers/warn');
const statusHandler = require('./handlers/status');
const extraHandler = require('./handlers/extra');
const liveHandler = require('./handlers/live');
const leaveHandler = require('./handlers/leave');

/**
 * SESSIYA BOSQICHIDAGI MATN — kim nima kutayotganiga qarab yo'naltiriladi.
 *   emp     — faqat hodim;  mgr — boshliq yoki direktor;  admin — faqat direktor
 * «⏭ O'tkazib yuborish» = skip:true. «❌ Bekor qilish» bot.hears orqali (attendance.cancelStep).
 */
const STEP_HANDLERS = {
  // hodim
  late_reason: { emp: true, run: (ctx, skip) => attendanceHandler.handleLateReason(ctx, { skip }) },
  absence_reason: { emp: true, run: (ctx) => attendanceHandler.handleAbsenceReason(ctx) },
  checkin_noloc: { emp: true, run: (ctx) => attendanceHandler.handleNoLocation(ctx) },
  late_notice: { emp: true, run: (ctx) => attendanceHandler.handleLateNotice(ctx) },
  checkout_note: { emp: true, run: (ctx) => attendanceHandler.handleCheckoutNote(ctx) },
  leave_reason: { emp: true, run: (ctx) => leaveHandler.handleReason(ctx) },
  live_noloc: { emp: true, run: (ctx) => liveHandler.handleNoLive(ctx) },
  meeting_reason: { emp: true, run: (ctx) => meetingHandler.handleReason(ctx) },
  self_task_text: { emp: true, run: (ctx) => tasksHandler.handleSelfTaskText(ctx) },
  daily_report_text: { emp: true, run: (ctx, skip) => dailyReportHandler.handleReportText(ctx, { skip }) },
  self_media_title: { emp: true, run: (ctx) => tasksHandler.handleSelfMediaTitle(ctx) },
  edit_title: { run: (ctx) => tasksHandler.handleEditTitle(ctx) },
  typed_date: { run: (ctx) => tasksHandler.handleTypedDate(ctx) },
  typed_time: { run: (ctx) => tasksHandler.handleTypedTime(ctx) },
  remind_times: { emp: true, run: (ctx) => remindersHandler.handleCustomText(ctx) },
  remind_dept_times: { admin: true, run: (ctx) => remindersHandler.handleAdminTimesText(ctx) },
  remind_emp_times: { admin: true, run: (ctx) => remindersHandler.handleAdminTimesText(ctx) },
  visit_note: { emp: true, run: (ctx, skip) => fieldHandler.handleVisitNote(ctx, { skip }) },
  // savol-javob chati va qaytarilgan topshiriqqa javob — hamma ro'yxatdagi (texnik direktor ham)
  chat_text: { run: (ctx) => chatHandler.handleText(ctx) },
  chat_reply: { run: (ctx) => chatHandler.handleText(ctx) },
  task_reply: { run: (ctx) => chatHandler.handleText(ctx) },
  // KPI kalkulyatori — hamma ro'yxatdagi (bazaga yozmaydi)
  kc_input: { run: (ctx) => kpiCalcHandler.handleInput(ctx) },
  // boshliq / direktor / HR
  assign_text: { mgr: true, run: (ctx) => tasksHandler.handleAssignText(ctx) },
  assign_media_title: { mgr: true, run: (ctx) => tasksHandler.handleAssignMediaTitle(ctx) },
  announce_text: { mgr: true, run: (ctx) => announceHandler.handleText(ctx) },
  meeting_date: { mgr: true, run: (ctx) => meetingHandler.handleDateText(ctx) },
  meeting_time: { mgr: true, run: (ctx) => meetingHandler.handleTimeText(ctx) },
  meeting_text: { mgr: true, run: (ctx) => meetingHandler.handleText(ctx) },
  rec_time: { mgr: true, run: (ctx) => recurringHandler.handleTimeText(ctx) },
  rec_text: { mgr: true, run: (ctx) => recurringHandler.handleText(ctx) },
  rec_title: { mgr: true, run: (ctx) => recurringHandler.handleTitle(ctx) },
  return_note: { mgr: true, run: (ctx, skip) => tasksHandler.handleReturnNote(ctx, { skip }) },
  head_note: { mgr: true, run: (ctx, skip) => kpiHandler.handleKpiText(ctx, 'head_note', { skip }) },
  daily_review_note: { mgr: true, run: (ctx) => dailyReportHandler.handleReviewNote(ctx) },
  set_emp_home: { mgr: true, run: (ctx) => fieldHandler.handleEmpHomeText(ctx) },
  // direktor
  period_dates: { admin: true, run: (ctx) => periodHandler.handleTypedDates(ctx) },
  add_tgid: { admin: true, run: (ctx) => joinHandler.handleTgId(ctx) },
  add_name: { admin: true, run: (ctx, skip) => joinHandler.handleName(ctx, { skip }) },
  add_position: { admin: true, run: (ctx, skip) => joinHandler.handlePosition(ctx, { skip }) },
  add_dept_name: { admin: true, run: (ctx) => joinHandler.handleDeptName(ctx) },
  edit_name: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'name') },
  edit_position: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'position') },
  edit_fund: { pay: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'fund') },
  edit_work_start: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'work_start') },
  edit_work_end: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'work_end') },
  xc_date: { admin: true, run: (ctx) => extraHandler.handleDate(ctx) },
  xc_amount: { admin: true, run: (ctx) => extraHandler.handleAmount(ctx) },
  edit_salary: { pay: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'salary') },
  dir_new: { admin: true, run: (ctx) => directionsHandler.handleDirText(ctx, 'new') },
  dir_name: { admin: true, run: (ctx) => directionsHandler.handleDirText(ctx, 'name') },
  boss_name: { admin: true, run: (ctx) => adminHandler.handleBossName(ctx) },
  worktime_global: { admin: true, run: (ctx) => adminHandler.handleWorktimeText(ctx) },
  branch_new: { admin: true, run: (ctx) => adminHandler.handleBranchText(ctx, 'new') },
  branch_name: { admin: true, run: (ctx) => adminHandler.handleBranchText(ctx, 'name') },
  branch_radius: { admin: true, run: (ctx) => adminHandler.handleBranchText(ctx, 'radius') },
  excuse_date: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'excuse_date') },
  // 20-okt: «✅ Keldi deb belgilash» — bo'lim rahbari ham (huquq handlerda: access.canMarkPresent)
  // 20-okt: «⚠️ Ogohlantirish» (intizom) — rahbar, HR, direktor
  warn_text: { warn: true, run: (ctx) => warnHandler.handleText(ctx) },
  present_date: { present: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'present_date') },
  present_time: { present: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'present_time') },
  present_note: { present: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'present_note') },
  excuse_reason_admin: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'excuse_reason') },
  dept_new: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'new') },
  dept_name: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'name') },
  dept_custom: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'custom') },
  dept_weights: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'weights') },
  kpi_custom: { pay: true, run: (ctx) => kpiHandler.handleKpiText(ctx, 'custom') },
  kpi_fund: { pay: true, run: (ctx) => kpiHandler.handleKpiText(ctx, 'fund') },
  kpi_note: { pay: true, run: (ctx, skip) => kpiHandler.handleKpiText(ctx, 'note', { skip }) },
  kpi_exclude_note: { pay: true, run: (ctx, skip) => kpiHandler.handleKpiText(ctx, 'exclude_note', { skip }) },
  kpi_gate_days: { admin: true, run: (ctx) => adminHandler.handleGateText(ctx, 'days') },
  kpi_gate_pct: { admin: true, run: (ctx) => adminHandler.handleGateText(ctx, 'pct') },
};

const allowed = (ctx, step) => {
  if (step.admin) return ctx.state.isAdmin;
  if (step.pay) return ctx.state.isAdmin || ctx.state.isHr;
  if (step.present) return ctx.state.isAdmin || ctx.state.isHead;
  if (step.warn) return ctx.state.isAdmin || ctx.state.isHr || ctx.state.isHead;
  if (step.mgr) return ctx.state.isManager;
  if (step.emp) return Boolean(ctx.state.employee);
  return Boolean(ctx.state.employee) || ctx.state.isAdmin;
};

/** Botni yig'adi (launch qilmaydi) — testlarda ham shu ishlatiladi */
const createBot = () => {
  const bot = new Telegraf(config.botToken, { handlerTimeout: 90_000 });

  // --- handlerlar tartibi muhim: umumiy matn ushlagichi eng oxirida ---
  commonHandler.register(bot);
  joinHandler.register(bot);
  attendanceHandler.register(bot);
  leaveHandler.register(bot);
  fieldHandler.register(bot);
  liveHandler.register(bot);
  monthHandler.register(bot);
  teamHandler.register(bot);
  remindersHandler.register(bot);
  directionsHandler.register(bot);
  journalHandler.register(bot);
  announceHandler.register(bot); // media: announce_text bosqichida e'lon, aks holda next()
  meetingHandler.register(bot);
  recurringHandler.register(bot);
  chatHandler.register(bot);
  warnHandler.register(bot);
  tasksHandler.register(bot); // media: done_proof / assign_text / self_task_text bosqichida, aks holda next()
  dailyReportHandler.register(bot); // rasm: daily_report_text bosqichida hisobot
  statusHandler.register(bot);
  extraHandler.register(bot);
  adminHandler.register(bot);
  kpiHandler.register(bot);
  kpiCalcHandler.register(bot);
  reportsHandler.register(bot);
  hrHandler.register(bot);
  periodHandler.register(bot);
  excelMenuHandler.register(bot);

  bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    // Ro'yxatda yo'q — faqat ID va so'rov, boshqa hech narsa
    if (!ctx.state.employee && !ctx.state.isAdmin) return commonHandler.notRegistered(ctx);

    const s = session.get(ctx.from.id);
    const text = ctx.message.text.trim();
    const skip = text === ui.BTN.skip;
    const step = STEP_HANDLERS[s.step];

    if (step) {
      if (allowed(ctx, step)) return step.run(ctx, skip);
      session.clear(ctx.from.id);
    }
    if (['awaiting_checkin_location', 'awaiting_office_location', 'awaiting_home_location', 'visit_location', 'awaiting_checkout_location'].includes(s.step)) {
      return ctx.reply(`📍 Pastdagi «${ui.BTN.sendLocation}» tugmasini bosing (yoki «${ui.BTN.cancel}»).`, ui.locationKeyboard());
    }
    if (s.step === 'done_proof') {
      return ctx.reply(config.proofRequired
        ? '📎 Isbot majburiy: rasm, video, audio yoki fayl yuboring (izohni ostiga yozing). Bekor qilish — yuqoridagi tugma.'
        : '📎 Rasm, video, audio yoki fayl yuboring, yoki yuqoridagi «⏭ Isbotsiz yuborish» tugmasini bosing.');
    }
    if (s.step === 'awaiting_checkin_video') return ctx.reply(`🎥 Video yuboring (oddiy yoki dumaloq) yoki «${ui.BTN.cancel}».`, ui.cancelKeyboard());
    if (s.step === 'badge_audio') return ctx.reply(`🎙 Ovozli xabar yozib yuboring yoki «${ui.BTN.cancel}».`, ui.cancelKeyboard());
  if (s.step === 'warn_confirm') return ctx.reply('⬆️ «✅ Yuborish» yoki «❌ Bekor qilish» ni bosing.');
    if (s.step === 'badge_confirm') return ctx.reply('⬆️ «✅ Shu, saqlash», «🔁 Boshidan yozish» yoki «❌ Bekor qilish» ni bosing.');
    if (s.step === 'visit_proof') return ctx.reply(`🎥 Video yoki 🎙 audio yuboring (izohni video ostiga yozing) yoki «${ui.BTN.cancel}».`, ui.cancelKeyboard());
    if (s.step === 'announce_confirm' || s.step === 'meeting_confirm' || s.step === 'rec_confirm') return ctx.reply("⬆️ «📤 Yuborish» yoki «❌ Bekor qilish» ni bosing.");
    if (s.step === 'worktime_confirm' || s.step === 'announce_pick' || s.step === 'done_pick') return ctx.reply('⬆️ Yuqoridagi tugmalardan tanlang.');
    if (s.step === 'self_task_due' || s.step === 'assign_due' || s.step === 'self_task_time' || s.step === 'assign_time' || s.step === 'add_dept' || s.step === 'add_role' || s.step === 'add_confirm' || s.step === 'assign_pick' || s.step === 'return_late' || s.step === 'return_due' || s.step === 'xc_confirm' || s.step === 'meeting_date_pick' || s.step === 'meeting_time_pick' || s.step === 'rec_pick') {
      return ctx.reply('⬆️ Yuqoridagi tugmalardan tanlang (yoki /menu).');
    }
    if (skip) return ctx.reply('Hozir hech narsa kutilmayapti.', ui.kbFor(ctx));
    if (await tasksHandler.ackByText(ctx)) return;

    // Tanilmagan matn ham yo'qolmasin — hodim nima yozganini direktor arxivda ko'ra oladi
    if (ctx.state.employee) activity.mark(ctx, 'note', { title: text, detail: 'erkin matn' });
    return ctx.reply('Tushunmadim 🤔 Pastdagi tugmalardan foydalaning yoki /yordam.', ui.kbFor(ctx));
  });

  // Ro'yxatda yo'qlar tugma bossa ham hech narsa ochilmasin
  bot.on('callback_query', async (ctx) => {
    if (!ctx.state.employee && !ctx.state.isAdmin) return ctx.answerCbQuery("⛔️ Siz ro'yxatda yo'qsiz", { show_alert: true });
    return ctx.answerCbQuery('Eskirgan tugma').catch(() => {});
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] ${ctx.updateType} xatosi:`, err);
  });

  return bot;
};

module.exports = { createBot, STEP_HANDLERS };
