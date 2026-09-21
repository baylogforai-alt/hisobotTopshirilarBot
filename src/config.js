'use strict';

const path = require('path');
require('dotenv').config();

const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
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
    console.warn("\n⚠️  SUPABASE_PROJECT_REF ko'rsatilmagan — SQLite ishlatiladi.\n");
    return { url: '', source: 'sqlite' };
  }

  const pw = encodeURIComponent(password);
  if (poolerHost) {
    return { url: `postgresql://postgres.${ref}:${pw}@${poolerHost}:5432/postgres`, source: 'SUPABASE_POOLER_HOST' };
  }
  return { url: `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres`, source: 'SUPABASE_DB_PASSWORD' };
};

const database = resolveDatabaseUrl();

const config = {
  botToken: process.env.BOT_TOKEN || '',
  databaseUrl: database.url,
  databaseSource: database.source,
  supabaseRef: str(process.env.SUPABASE_PROJECT_REF),
  groupChatId: process.env.GROUP_CHAT_ID ? Number(process.env.GROUP_CHAT_ID) : null,
  /** Direktor / HR — bazadagi role='admin' bilan birga */
  adminIds: ids(process.env.ADMIN_IDS),
  companyName: str(process.env.COMPANY_NAME) || 'BayLog Cargo',
  timezone: str(process.env.TIMEZONE) || 'Asia/Tashkent',
  workStartHour: num(process.env.WORK_START_HOUR, 9),
  workEndHour: num(process.env.WORK_END_HOUR, 18),
  reminderIntervalHours: num(process.env.REMINDER_INTERVAL_HOURS, 2),
  /** cron ko'rinishida: '1-6' = dushanba–shanba, '1-5' = dushanba–juma */
  workDays: str(process.env.WORK_DAYS) || '1-6',

  // Kechikish
  lateGraceMinutes: num(process.env.LATE_GRACE_MINUTES, 10),
  askLateReason: bool(process.env.ASK_LATE_REASON, true),

  // KPI: har bir qaytarilgan ish topshiriq foizidan necha % ayiradi (0 — jarima yo'q)
  returnPenaltyPct: num(process.env.RETURN_PENALTY_PCT, 5),

  // Guruhga xabarlar
  dailyGroupReport: bool(process.env.DAILY_GROUP_REPORT, true),
  /** Bajarilgan ish / kelish-ketish guruhga e'lon qilinsinmi (real vaqtda) */
  announceDone: bool(process.env.ANNOUNCE_DONE, true),

  // Kunlik hisobot topshirish (hodim kun oxirida nima qilganini yozadi)
  dailyReportRequired: bool(process.env.DAILY_REPORT_REQUIRED, true),
  /** Ish tugashidan necha daqiqa oldin "hisobot topshiring" eslatmasi */
  dailyReportRemindMin: num(process.env.DAILY_REPORT_REMIND_MIN, 30),

  // Ofis geofence (boshlang'ich qiymat; asosiysi bazadagi sozlama)
  officeLat: process.env.OFFICE_LAT && Number.isFinite(Number(process.env.OFFICE_LAT)) ? Number(process.env.OFFICE_LAT) : null,
  officeLon: process.env.OFFICE_LON && Number.isFinite(Number(process.env.OFFICE_LON)) ? Number(process.env.OFFICE_LON) : null,
  officeRadiusM: num(process.env.OFFICE_RADIUS_M, 250),

  // CRM uchun faqat o'qiladigan HTTP manzil (kalit bo'lmasa ochilmaydi)
  crmApiSecret: str(process.env.CRM_API_SECRET),

  dbPath: path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db')),
  backupKeep: num(process.env.BACKUP_KEEP, 14),
  port: num(process.env.PORT, 8000),
};

if (!config.botToken) {
  console.error("BOT_TOKEN topilmadi. .env faylini to'ldiring (.env.example dan nusxa oling).");
  process.exit(1);
}

if (config.workEndHour <= config.workStartHour) {
  console.warn("⚠️  WORK_END_HOUR WORK_START_HOUR dan katta bo'lishi kerak — standart 9–18 ishlatiladi.");
  config.workStartHour = 9;
  config.workEndHour = 18;
}

/** cron '1-6' → hafta kunlari to'plami (1=dushanba … 7=yakshanba, luxon bilan mos) */
const parseWorkDays = (spec) => {
  const set = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d)(?:-(\d))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let d = a; d <= b; d += 1) set.add(d === 0 ? 7 : d);
  }
  return set.size ? set : new Set([1, 2, 3, 4, 5, 6]);
};
config.workDaySet = parseWorkDays(config.workDays);

module.exports = config;
