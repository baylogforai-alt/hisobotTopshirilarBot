'use strict';

const config = require('./config');
const db = require('./db');
const time = require('./time');
const session = require('./session');
const health = require('./health');
const jobs = require('./jobs');
const employees = require('./services/employees');
const { HODIMLAR } = require('./hodimlar');
const { createBot } = require('./app');

const bot = createBot();

const COMMANDS = [
  { command: 'menu', description: 'Asosiy menyu' },
  { command: 'keldim', description: 'Ishga keldim (GPS)' },
  { command: 'ketdim', description: 'Ishdan ketdim' },
  { command: 'missiyalarim', description: 'Missiyalarim' },
  { command: 'bajardim', description: 'Bajarilganini belgilash' },
  { command: 'vazifa', description: 'Ozimga missiya yozish' },
  { command: 'bugun', description: 'Bugungi qoshimcha topshiriq' },
  { command: 'kunlik', description: 'Kunlik hisobot topshirish' },
  { command: 'kelmayman', description: 'Bugun kelmayman (sabab)' },
  { command: 'hisobot', description: 'Mening oylik hisobotim' },
  { command: 'excel', description: 'Hisobotimni Excel qilib olish' },
  { command: 'topshiriq', description: 'Topshiriq berish (boshliq)' },
  { command: 'tekshiruv', description: 'Bajarilgan ishlarni tekshirish (boshliq)' },
  { command: 'bolim', description: 'Bolim holati (boshliq)' },
  { command: 'baholash', description: 'Hodimlarni baholash (boshliq)' },
  { command: 'panel', description: 'Panel (direktor)' },
  { command: 'kpi', description: 'KPI (direktor)' },
  { command: 'hisobotlar', description: 'Hisobotlar (direktor)' },
  { command: 'arxiv', description: 'Hodimlar arxivi (direktor)' },
  { command: 'davr', description: 'Davr hisoboti — sana tanlab (direktor)' },
  { command: 'id', description: 'Telegram ID' },
  { command: 'yordam', description: 'Qollanma' },
];

(async () => {
  health.start();
  try {
    await db.init();
  } catch (err) {
    console.error("\n❌ Bazaga ulanib bo'lmadi:", err.message);
    console.error('   DATABASE_URL / SUPABASE_DB_PASSWORD ni tekshiring (.env).');
    process.exit(1);
  }

  // hodimlar.js ro'yxatidagi yangi hodimlar bazaga tushsin (mavjudlariga tegilmaydi)
  try {
    const added = await employees.ensureMany(HODIMLAR);
    if (added.length) console.log(`👥 Yangi hodimlar qo'shildi: ${added.map((e) => e.full_name).join(', ')}`);
  } catch (err) {
    console.error("[hodimlar] avtomatik qo'shishda xato:", err.message);
  }

  try {
    await require('./fixes').run();
  } catch (err) {
    console.error('[fix] xato:', err.message);
  }

  try {
    const restored = await session.load();
    if (restored) console.log(`🧭 ${restored} ta sessiya tiklandi`);
  } catch (err) {
    console.warn('[session] tiklanmadi:', err.message);
  }

  await bot.telegram.setMyCommands(COMMANDS).catch(() => {});

  await bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message', 'callback_query'] }, () => {
    const me = bot.botInfo;
    console.log(`\n🤖 @${me.username} ishga tushdi — ${config.companyName}`);
    console.log(`🕒 ${time.now().toFormat('yyyy-MM-dd HH:mm')} (${config.timezone})`);
    console.log(`⏰ Ish vaqti ${config.workStartHour}:00–${config.workEndHour}:00 · kunlar ${config.workDays} · eslatma har ${config.reminderIntervalHours} soat · kechikish ruxsati ${config.lateGraceMinutes} daq`);
    console.log(`👑 ADMIN_IDS: ${config.adminIds.join(', ') || '— (bazadagi role=admin)'}`);
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
