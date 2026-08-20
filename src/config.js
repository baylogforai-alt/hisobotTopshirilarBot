'use strict';

const path = require('path');
require('dotenv').config();

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'ha', 'yes'].includes(String(value).toLowerCase());
};

const ids = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);

const str = (value) => String(value || '').trim();

/**
 * Baza manzilini aniqlaydi. Uchta yo'l bor (yuqoridagisi ustun):
 *  1. DATABASE_URL — to'liq ulanish satri
 *  2. SUPABASE_DB_PASSWORD (+ SUPABASE_PROJECT_REF) — faqat parol yetarli
 *  3. hech biri yo'q — mahalliy SQLite fayli
 */
const resolveDatabaseUrl = () => {
  const direct = str(process.env.DATABASE_URL);
  if (direct && !/\[?YOUR-PASSWORD\]?/i.test(direct)) return { url: direct, source: 'DATABASE_URL' };

  const password = str(process.env.SUPABASE_DB_PASSWORD);
  const ref = str(process.env.SUPABASE_PROJECT_REF);
  const poolerHost = str(process.env.SUPABASE_POOLER_HOST);

  if (!password) {
    if (direct) {
      console.warn(
        '\n⚠️  DATABASE_URL ichida hali [YOUR-PASSWORD] turibdi.\n' +
          "   Parolni SUPABASE_DB_PASSWORD ga yozing — bot mahalliy SQLite'da ishlab turadi.\n",
      );
    }
    return { url: '', source: 'sqlite' };
  }
  if (!ref) {
    console.warn('\n⚠️  SUPABASE_PROJECT_REF ko\'rsatilmagan — SQLite ishlatiladi.\n');
    return { url: '', source: 'sqlite' };
  }

  // Parolda @ # : / kabi belgilar bo'lsa ulanish buzilmasligi uchun kodlaymiz
  const pw = encodeURIComponent(password);

  // Pooler (IPv4 da ham ishlaydi) berilgan bo'lsa — o'shani afzal ko'ramiz
  if (poolerHost) {
    return {
      url: `postgresql://postgres.${ref}:${pw}@${poolerHost}:5432/postgres`,
      source: 'SUPABASE_POOLER_HOST',
    };
  }
  return {
    url: `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres`,
    source: 'SUPABASE_DB_PASSWORD',
  };
};

const database = resolveDatabaseUrl();

const config = {
  botToken: process.env.BOT_TOKEN || '',
  databaseUrl: database.url,
  databaseSource: database.source,
  supabaseRef: str(process.env.SUPABASE_PROJECT_REF),
  groupChatId: process.env.GROUP_CHAT_ID ? Number(process.env.GROUP_CHAT_ID) : null,
  adminIds: ids(process.env.ADMIN_IDS),
  companyName: process.env.COMPANY_NAME || 'BayLog Cargo',
  timezone: process.env.TIMEZONE || 'Asia/Tashkent',
  workStartHour: num(process.env.WORK_START_HOUR, 9),
  workEndHour: num(process.env.WORK_END_HOUR, 18),
  reminderIntervalHours: num(process.env.REMINDER_INTERVAL_HOURS, 2),
  workDays: process.env.WORK_DAYS || '1-6',
  announceDone: bool(process.env.ANNOUNCE_DONE, true),
  officeLat: Number.isFinite(Number(process.env.OFFICE_LAT)) && process.env.OFFICE_LAT ? Number(process.env.OFFICE_LAT) : null,
  officeLon: Number.isFinite(Number(process.env.OFFICE_LON)) && process.env.OFFICE_LON ? Number(process.env.OFFICE_LON) : null,
  officeRadiusM: num(process.env.OFFICE_RADIUS_M, 250),
  dbPath: path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db')),
};

if (!config.botToken) {
  console.error("BOT_TOKEN topilmadi. .env faylini to'ldiring (.env.example dan nusxa oling).");
  process.exit(1);
}

module.exports = config;
