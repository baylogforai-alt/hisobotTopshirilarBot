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
const reportsHandler = require('./handlers/reports');
const hrHandler = require('./handlers/hr');
const periodHandler = require('./handlers/period');
const excelMenuHandler = require('./handlers/excelMenu');

/**
 * SESSIYA BOSQICHIDAGI MATN — kim nima kutayotganiga qarab yo'naltiriladi.
 *   emp     — faqat hodim;  mgr — boshliq yoki direktor;  admin — faqat direktor
 * «⏭ O'tkazib yuborish» = skip:true. «❌ Bekor qilish» bot.hears orqali (attendance.cancelStep).
 */
const STEP_HANDLERS = {
  // hodim
  late_reason: { emp: true, run: (ctx, skip) => attendanceHandler.handleLateReason(ctx, { skip }) },
  absence_reason: { emp: true, run: (ctx) => attendanceHandler.handleAbsenceReason(ctx) },
  self_task_text: { emp: true, run: (ctx) => tasksHandler.handleSelfTaskText(ctx) },
  daily_report_text: { emp: true, run: (ctx, skip) => dailyReportHandler.handleReportText(ctx, { skip }) },
  edit_title: { run: (ctx) => tasksHandler.handleEditTitle(ctx) },
  typed_date: { run: (ctx) => tasksHandler.handleTypedDate(ctx) },
  // boshliq / direktor
  assign_text: { mgr: true, run: (ctx) => tasksHandler.handleAssignText(ctx) },
  return_note: { mgr: true, run: (ctx, skip) => tasksHandler.handleReturnNote(ctx, { skip }) },
  head_note: { mgr: true, run: (ctx, skip) => kpiHandler.handleKpiText(ctx, 'head_note', { skip }) },
  daily_review_note: { mgr: true, run: (ctx) => dailyReportHandler.handleReviewNote(ctx) },
  // direktor
  period_dates: { admin: true, run: (ctx) => periodHandler.handleTypedDates(ctx) },
  add_tgid: { admin: true, run: (ctx) => joinHandler.handleTgId(ctx) },
  add_name: { admin: true, run: (ctx, skip) => joinHandler.handleName(ctx, { skip }) },
  add_position: { admin: true, run: (ctx, skip) => joinHandler.handlePosition(ctx, { skip }) },
  add_dept_name: { admin: true, run: (ctx) => joinHandler.handleDeptName(ctx) },
  edit_name: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'name') },
  edit_position: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'position') },
  edit_fund: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'fund') },
  edit_work_start: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'work_start') },
  excuse_date: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'excuse_date') },
  excuse_reason_admin: { admin: true, run: (ctx) => adminHandler.handleEmpText(ctx, 'excuse_reason') },
  dept_new: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'new') },
  dept_name: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'name') },
  dept_custom: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'custom') },
  dept_weights: { admin: true, run: (ctx) => adminHandler.handleDeptText(ctx, 'weights') },
  kpi_custom: { admin: true, run: (ctx) => kpiHandler.handleKpiText(ctx, 'custom') },
  kpi_fund: { admin: true, run: (ctx) => kpiHandler.handleKpiText(ctx, 'fund') },
  kpi_note: { admin: true, run: (ctx, skip) => kpiHandler.handleKpiText(ctx, 'note', { skip }) },
  kpi_exclude_note: { admin: true, run: (ctx, skip) => kpiHandler.handleKpiText(ctx, 'exclude_note', { skip }) },
};

const allowed = (ctx, step) => {
  if (step.admin) return ctx.state.isAdmin;
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
  tasksHandler.register(bot); // rasm/video: done_proof bosqichida isbot, aks holda next()
  dailyReportHandler.register(bot); // rasm: daily_report_text bosqichida hisobot
  adminHandler.register(bot);
  kpiHandler.register(bot);
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
    if (s.step === 'awaiting_checkin_location' || s.step === 'awaiting_office_location') {
      return ctx.reply(`📍 Pastdagi «${ui.BTN.sendLocation}» tugmasini bosing (yoki «${ui.BTN.cancel}»).`, ui.locationKeyboard());
    }
    if (s.step === 'done_proof') return ctx.reply('📎 Rasm yoki video yuboring, yoki yuqoridagi «⏭ Isbotsiz yuborish» tugmasini bosing.');
    if (['self_task_due', 'assign_due', 'add_dept', 'add_role', 'add_confirm', 'assign_pick'].includes(s.step)) {
      return ctx.reply('⬆️ Yuqoridagi tugmalardan tanlang (yoki /menu).');
    }
    if (skip) return ctx.reply('Hozir hech narsa kutilmayapti.', ui.kbFor(ctx));

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
