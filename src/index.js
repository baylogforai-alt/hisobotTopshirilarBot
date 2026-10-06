'use strict';

const config = require('./config');
const db = require('./db');
const time = require('./time');
const session = require('./session');
const web = require('./web/server');
const webapp = require('./services/webapp');
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
  { command: 'kech', description: 'Kech qolaman (sabab, video/audio)' },
  { command: 'kelmayman', description: 'Bugun kelmayman (sabab)' },
  { command: 'tashrif', description: 'Hududga keldim (agentlar)' },
  { command: 'oylik', description: 'Oylik va KPI' },
  { command: 'kalkulyator', description: 'KPI kalkulyator (agar … bo'lsa, qancha?)' },
  { command: 'eslatma', description: 'Eslatma vaqtlari' },
  { command: 'hisobot', description: 'Mening oylik hisobotim' },
  { command: 'excel', description: 'Hisobotimni Excel qilib olish' },
  { command: 'topshiriq', description: 'Topshiriq berish (boshliq)' },
  { command: 'tekshiruv', description: 'Bajarilgan ishlarni tekshirish (boshliq)' },
  { command: 'hodimlarim', description: 'Hodimlarim (rahbar, HR, direktor)' },
  { command: 'bolim', description: 'Bolim holati (boshliq)' },
  { command: 'davomat', description: 'Davomat nazorati (ruxsat bilan)' },
  { command: 'baholash', description: 'Hodimlarni baholash (boshliq)' },
  { command: 'panel', description: 'Panel (direktor)' },
  { command: 'chaqirish', description: "Dam olish kuniga ishga chaqirish (qo'shimcha haq)" },
  { command: 'jurnal', description: 'Barcha topshiriqlar (direktor, HR)' },
  { command: 'elon', description: "E'lon (hammaga, bolimga, tanlanganlarga)" },
  { command: 'faol', description: 'Faol topshiriqlar (jarayonda)' },
  { command: 'korib_chiqish', description: "Qaytarilgan — tuzatilayotgan topshiriqlar" },
  { command: 'kutilmoqda', description: 'Tekshiruvni kutayotganlar' },
  { command: 'bajarilgan', description: 'Bajarilgan topshiriqlar (shu oy)' },
  { command: 'oyliklar', description: 'Hodimlar oyligi (direktor)' },
  { command: 'kpi', description: 'KPI (direktor)' },
  { command: 'hisobotlar', description: 'Hisobotlar (direktor)' },
  { command: 'arxiv', description: 'Hodimlar arxivi (direktor)' },
  { command: 'davr', description: 'Davr hisoboti — sana tanlab (direktor)' },
  { command: 'elon', description: 'Elon — hammaga yoki tanlanganlarga (direktor, HR, rahbar)' },
  { command: 'ilova', description: 'Web ilova (soddaroq oyna)' },
  { command: 'id', description: 'Telegram ID' },
  { command: 'yordam', description: 'Qollanma' },
];

(async () => {
  web.start({ bot });
  try {
    await db.init();
    await require('./services/worktime').load();
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

  // buyruqlar menyusi faqat shaxsiy chatda; standart doira (guruhlar) bo'shatiladi — maosh/KPI guruhga chiqmasin
  await bot.telegram.setMyCommands(COMMANDS, { scope: { type: 'all_private_chats' } }).catch(() => {});
  await bot.telegram.deleteMyCommands().catch(() => {});

  // deploy paytida yuborilgan tugma/Keldim/isbot yo'qolmasin (sessiya bazada; eskirgan kiritishni handlerlar o'zi rad etadi)
  await bot.launch({ dropPendingUpdates: false, allowedUpdates: ['message', 'callback_query'] }, () => {
    const me = bot.botInfo;
    console.log(`\n🤖 @${me.username} ishga tushdi — ${config.companyName}`);
    console.log(`🕒 ${time.now().toFormat('yyyy-MM-dd HH:mm')} (${config.timezone})`);
    console.log(`⏰ Ish vaqti ${require('./services/worktime').get()}–${config.workEndHour}:00 · kunlar ${config.workDays} · kechikish ruxsati ${config.lateGraceMinutes} daq`);
    console.log(`👑 ADMIN_IDS: ${config.adminIds.join(', ') || '— (bazadagi role=admin)'}`);
    jobs.start(bot);
    webapp.syncMenus(bot)
      .then((n) => { if (webapp.enabled()) console.log(`📱 Web App menyu tugmasi: ${n} ta chat`); })
      .catch((e) => console.warn('[webapp] menyu:', e.message));
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
