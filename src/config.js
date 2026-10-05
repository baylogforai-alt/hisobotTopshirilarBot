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

/** '8:50' / '08.50' / '9' → '08:50'; tushunilmasa null */
const hhmm = (value) => {
  const m = str(value).match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || (m[2] && Number(m[2]) > 59)) return null;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2] || '00'}`;
};

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
  /** Direktorlar (bir nechta bo'lishi mumkin) — bazadagi role='admin' bilan birga. HR — employees.is_hr */
  adminIds: ids(process.env.ADMIN_IDS),
  companyName: str(process.env.COMPANY_NAME) || 'BayLog Cargo',
  // Boshliq (direktor) ismi — xabarlarda ko'rinadi; botda Panel → «🏷 Nomlar» dan o'zgartiriladi
  bossName: str(process.env.BOSS_NAME) || 'Direktor',
  // 1 — bazadagi role='admin' hodim ham oddiy hodim kabi davomat/KPI ga kiradi (standart: boshliq hodim emas)
  bossIsStaff: bool(process.env.BOSS_IS_STAFF, false),
  timezone: str(process.env.TIMEZONE) || 'Asia/Tashkent',
  // Umumiy ish boshlanishi (standart 08:50). Direktor botda o'zgartirsa bazadagi qiymat ustun (services/worktime.js).
  // WORK_START bo'lmasa eski WORK_START_HOUR (masalan 9 → 09:00) olinadi.
  workStart: hhmm(process.env.WORK_START) || hhmm(process.env.WORK_START_HOUR) || '09:00',
  workEndHour: num(process.env.WORK_END_HOUR, 18),
  reminderIntervalHours: num(process.env.REMINDER_INTERVAL_HOURS, 2),
  /** cron ko'rinishida: '1-6' = dushanba–shanba, '1-5' = dushanba–juma */
  workDays: str(process.env.WORK_DAYS) || '1-6',

  // Kechikish
  lateGraceMinutes: num(process.env.LATE_GRACE_MINUTES, 10),
  askLateReason: bool(process.env.ASK_LATE_REASON, true),
  // «Kech qolaman» ish boshlanishidan kamida shuncha daqiqa OLDIN yuborilsa — o'sha kungi kechikish hisoblanmaydi (0 — o'chirilgan)
  lateNoticeMinBefore: num(process.env.LATE_NOTICE_MIN_BEFORE, 60),

  // «Bajardim» isboti (rasm/video/audio/fayl) majburiymi. 0 — «⏭ Isbotsiz yuborish» tugmasi bor (BayLog standarti)
  proofRequired: bool(process.env.PROOF_REQUIRED, false),

  // KPI: har bir qaytarilgan ish topshiriq foizidan necha % ayiradi (0 — jarima yo'q)
  returnPenaltyPct: num(process.env.RETURN_PENALTY_PCT, 5),

  // Guruhga xabarlar
  dailyGroupReport: bool(process.env.DAILY_GROUP_REPORT, true),
  /**
   * Boshliq (bazadagi role='admin') keldi-ketdi, kech qolaman/kelmayman va ertalabki/kun yakuni hisobotlarini oladimi —
   * Panel «👁 Boshliq keldi-ketdini» dan o'zgartirilmaguncha shu standart (BayLog: ha; BAYOMA: yo'q)
   */
  bossSeesAttendance: bool(process.env.BOSS_SEES_ATTENDANCE, true),
  /** Bajarilgan ish / kelish-ketish guruhga e'lon qilinsinmi (real vaqtda) */
  announceDone: bool(process.env.ANNOUNCE_DONE, true),

  // Kunlik hisobot topshirish (hodim kun oxirida nima qilganini yozadi)
  dailyReportRequired: bool(process.env.DAILY_REPORT_REQUIRED, true),
  /** Ish tugashidan necha daqiqa oldin "hisobot topshiring" eslatmasi */
  dailyReportRemindMin: num(process.env.DAILY_REPORT_REMIND_MIN, 30),
  // «Kun yakuni» hisoboti soati (standart — ish tugashi soati, WORK_END_HOUR)
  dailyReportHour: num(process.env.DAILY_REPORT_HOUR, num(process.env.WORK_END_HOUR, 18)),

  // Ofis geofence (boshlang'ich qiymat; asosiysi bazadagi sozlama)
  officeLat: process.env.OFFICE_LAT && Number.isFinite(Number(process.env.OFFICE_LAT)) ? Number(process.env.OFFICE_LAT) : null,
  officeLon: process.env.OFFICE_LON && Number.isFinite(Number(process.env.OFFICE_LON)) ? Number(process.env.OFFICE_LON) : null,
  officeRadiusM: num(process.env.OFFICE_RADIUS_M, 250),
  /** 1 — aniqligi (horizontal_accuracy) yo'q joylashuv rad etiladi; 0 — qabul qilinib, tekshiruvchiga ⚠️ bilan boradi */
  strictGps: ['1', 'true', 'yes'].includes(String(process.env.STRICT_GPS || '').toLowerCase()),

  // CRM uchun faqat o'qiladigan HTTP manzil (kalit bo'lmasa ochilmaydi)
  crmApiSecret: str(process.env.CRM_API_SECRET),

  // Hudud (agent) rejimi: "Keldim" uchun uydan kamida shuncha metr uzoqda bo'lishi kerak
  fieldMinDistanceM: num(process.env.FIELD_MIN_DISTANCE_M, 1000),
  // Ofis rejimida "Keldim" uchun video (yoki dumaloq video) majburiy (BayLog'da standart: yo'q)
  officeCheckinVideo: bool(process.env.OFFICE_CHECKIN_VIDEO, false),
  // Oy boshini tasdiqlamaguncha "Keldim" yopiq (BayLog'da standart: yo'q — xabar baribir boradi)
  monthStartRequired: bool(process.env.MONTH_START_REQUIRED, false),

  // KPI sharti. score — summa × ball / 100 (BayLog standarti); gate — shart bajarilsa KPI summasi TO'LIQ, bajarilmasa 0
  kpiMode: str(process.env.KPI_MODE).toLowerCase() === 'gate' ? 'gate' : 'score',
  kpiMaxLate: num(process.env.KPI_MAX_LATE, 0),          // oyda ruxsat etilgan kechikishlar soni
  kpiMaxAbsent: num(process.env.KPI_MAX_ABSENT, 0),      // sababsiz kelmagan kunlar
  kpiMaxMissedTasks: num(process.env.KPI_MAX_MISSED_TASKS, 0), // muddatida bajarilmagan topshiriqlar
  kpiExcusedOk: bool(process.env.KPI_EXCUSED_OK, true),  // tasdiqlangan sababli kun KPI ga zarar qilmaydi

  dbPath: path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db')),
  backupKeep: num(process.env.BACKUP_KEEP, 14),
  port: num(process.env.PORT, 8000),

  // Web App (Telegram Mini App). Bo'sh bo'lsa ilova tugmalari ko'rinmaydi (server baribir ishlaydi).
  // Masalan: https://missiya-bot-production.up.railway.app/app — faqat https.
  webAppUrl: /^https:\/\/[^\s]+$/.test(str(process.env.WEBAPP_URL)) ? str(process.env.WEBAPP_URL).replace(/\/+$/, '') : '',
  // initData necha soniya amal qiladi (Telegram har ochilishda yangisini beradi)
  webAuthTtlSec: num(process.env.WEBAPP_AUTH_TTL, 86400),
};

if (str(process.env.WEBAPP_URL) && !config.webAppUrl) {
  console.warn('⚠️  WEBAPP_URL https:// bilan boshlanishi kerak — Web App tugmalari o\'chirildi.');
}

if (!config.botToken) {
  console.error("BOT_TOKEN topilmadi. .env faylini to'ldiring (.env.example dan nusxa oling).");
  process.exit(1);
}

config.workStartHour = Number(config.workStart.slice(0, 2));
if (config.workEndHour <= config.workStartHour) {
  console.warn("⚠️  WORK_END_HOUR ish boshlanishidan katta bo'lishi kerak — 18 ishlatiladi.");
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
