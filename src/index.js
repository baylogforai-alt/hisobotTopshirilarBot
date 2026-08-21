'use strict';

const { Telegraf } = require('telegraf');
const config = require('./config');
const db = require('./db');
const time = require('./time');
const session = require('./session');
const ui = require('./ui');
const health = require('./health');

const commonHandler = require('./handlers/common');
const attendanceHandler = require('./handlers/attendance');
const missionsHandler = require('./handlers/missions');
const adminHandler = require('./handlers/admin');
const jobs = require('./jobs');

const bot = new Telegraf(config.botToken, { handlerTimeout: 60_000 });

// --- handlerlar tartibi muhim: umumiy matn ushlagichi eng oxirida ---
commonHandler.register(bot);
attendanceHandler.register(bot);
missionsHandler.register(bot);
adminHandler.register(bot);

// Sessiya bosqichidagi erkin matn (faqat shaxsiy chatda)
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (!ctx.state.employee) return commonHandler.notRegistered(ctx);

  const s = session.get(ctx.from.id);
  if (s.step === 'titles') return missionsHandler.handleTitlesInput(ctx);
  if (s.step === 'duration') {
    return ctx.reply('⏱ Avval yuqoridagi tugmalardan muddatni tanlang (yoki /menu).');
  }
  if (s.step === 'awaiting_checkin_location' || s.step === 'awaiting_office_location') {
    return ctx.reply(
      '📍 Iltimos, pastdagi «📍 Joylashuvni yuborish» tugmasini bosing (yoki «❌ Bekor qilish»).',
    );
  }

  return ctx.reply(
    'Tushunmadim 🤔 Pastdagi tugmalardan foydalaning yoki /yordam ni bosing.',
    ui.mainKeyboard(ctx.state.isAdmin),
  );
});

bot.catch((err, ctx) => {
  console.error(`[bot] ${ctx.updateType} xatosi:`, err);
});

const COMMANDS = [
  { command: 'menu', description: 'Asosiy menyu' },
  { command: 'keldim', description: 'Ishga keldim' },
  { command: 'ketdim', description: 'Ishdan ketaman' },
  { command: 'vazifa', description: 'Yangi missiya qoshish' },
  { command: 'bugun', description: 'Bugungi qoshimcha topshiriq' },
  { command: 'missiyalarim', description: 'Missiyalarim royxati' },
  { command: 'bajardim', description: 'Bajarilganini belgilash' },
  { command: 'bekor', description: 'Missiyani ochirish' },
  { command: 'hisobot', description: 'Mening hisobotim' },
  { command: 'excel', description: 'Excel faylni yuklab olish' },
  { command: 'id', description: 'Telegram ID' },
  { command: 'yordam', description: 'Qollanma' },
];

(async () => {
  health.start();

  try {
    await db.init();
  } catch (err) {
    console.error('\n❌ Bazaga ulanib bo\'lmadi:', err.message);
    console.error('   DATABASE_URL ni tekshiring (.env). Supabase → Project Settings → Database → Connection string.');
    process.exit(1);
  }

  await bot.telegram.setMyCommands(COMMANDS).catch(() => {});

  await bot.launch({ dropPendingUpdates: true }, () => {
    const me = bot.botInfo;
    console.log(`\n🤖 @${me.username} ishga tushdi — ${config.companyName}`);
    console.log(`🕒 ${time.now().toFormat('yyyy-MM-dd HH:mm')} (${config.timezone})`);
    console.log(
      `⏰ Ish vaqti: ${config.workStartHour}:00 – ${config.workEndHour}:00, har ${config.reminderIntervalHours} soatda eslatma`,
    );
    jobs.start(bot);
  });
})();

const stop = async (signal) => {
  console.log(`\n${signal} — to'xtatilmoqda...`);
  bot.stop(signal);
  await db.close();
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
