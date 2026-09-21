'use strict';
/**
 * Baza ulanishini tekshiradi va jadvallarni yaratadi. Hech narsa o'chirmaydi.
 * Ishlatish:  npm run db:check
 */
const db = require('../src/db');
const config = require('../src/config');
const time = require('../src/time');
const employees = require('../src/services/employees');
const departments = require('../src/services/departments');
const tasks = require('../src/services/tasks');
const attendance = require('../src/services/attendance');
const requests = require('../src/services/requests');
const kpi = require('../src/services/kpi');
const dailyReports = require('../src/services/dailyReports');
const activity = require('../src/services/activity');

const NONE = -1;

(async () => {
  console.log(`\n🔍 Baza tekshiruvi — ${config.databaseUrl ? 'PostgreSQL' : 'SQLite'} (${config.databaseSource})\n`);
  await db.init();

  const checks = [
    ['employees.listActive', () => employees.listActive()],
    ['employees.byTgId', () => employees.byTgId(NONE)],
    ['employees.listHeads', () => employees.listHeads()],
    ['departments.listActive', () => departments.listActive()],
    ['tasks.openFor', () => tasks.openFor(NONE)],
    ['tasks.overdue', () => tasks.overdue()],
    ['tasks.pendingReview', () => tasks.pendingReview()],
    ['tasks.stats', () => tasks.stats(NONE, '2000-01-01', '2100-01-01')],
    ['attendance.get', () => attendance.get(NONE)],
    ['attendance.presentToday', () => attendance.presentToday()],
    ['attendance.pendingExcuses', () => attendance.pendingExcuses()],
    ['requests.listPending', () => requests.listPending()],
    ['kpi.listMonth', () => kpi.listMonth(time.month())],
    ['dailyReports.forDate', () => dailyReports.forDate()],
    ['activity.lastSeen', () => activity.lastSeen(NONE)],
    ['settings.get', () => db.getSetting('group_chat_id')],
  ];

  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`✅ ${name}`); } catch (err) { failed += 1; console.log(`❌ ${name} → ${err.message}`); }
  }

  console.log('\n📦 Jadvallardagi yozuvlar:');
  for (const t of ['departments', 'employees', 'tasks', 'attendance', 'daily_reports', 'activity_log', 'kpi_monthly', 'join_requests', 'sessions', 'settings', 'reminder_log']) {
    console.log(`   ${t.padEnd(14)} ${await db.count(`SELECT COUNT(*) AS c FROM ${t}`)}`);
  }

  await db.close();
  if (failed) { console.log(`\n❌ ${failed} ta so'rov ishlamadi.`); process.exit(1); }
  console.log("\n🎉 Baza tayyor.\n");
})().catch((e) => {
  console.error("\n❌ Ulanib bo'lmadi:", e.message);
  console.error('  • .env dagi DATABASE_URL / SUPABASE_DB_PASSWORD to\'g\'rimi');
  console.error('  • "ENETUNREACH" / "timeout" bo\'lsa — SUPABASE_POOLER_HOST ni yozing (Session pooler).\n');
  process.exit(1);
});
