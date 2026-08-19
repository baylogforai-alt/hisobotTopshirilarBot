'use strict';
/**
 * Supabase (PostgreSQL) ulanishini tekshiradi va jadvallarni yaratadi.
 * Hech narsa o'chirmaydi, hech narsa yozmaydi — faqat o'qiydi.
 * Ishlatish:  npm run db:check
 */
const db = require('../src/db');
const config = require('../src/config');
const employees = require('../src/services/employees');
const missions = require('../src/services/missions');
const attendance = require('../src/services/attendance');

const NONE = -1; // mavjud bo'lmagan hodim — so'rovlar bo'sh natija qaytaradi

(async () => {
  console.log(`\n🔍 Baza tekshiruvi — ${config.databaseUrl ? 'PostgreSQL' : 'SQLite'}\n`);

  if (!config.databaseUrl) {
    console.log('⚠️  Supabase paroli berilmagan — mahalliy SQLite tekshiriladi.');
    console.log('   .env → SUPABASE_DB_PASSWORD ga Supabase baza parolini yozing.');
    console.log('   Parol: Supabase → Project Settings → Database → Database password\n');
  } else {
    console.log(`   manba: ${config.databaseSource}\n`);
  }

  await db.init();

  // Barcha so'rovlar shu dialektda ishlashini tekshiramiz (yozmasdan)
  const checks = [
    ['employees.listActive', () => employees.listActive()],
    ['employees.listAll', () => employees.listAll()],
    ['employees.byTgId', () => employees.byTgId(NONE)],
    ['employees.isAdmin', () => employees.isAdmin(NONE)],
    ['missions.openFor', () => missions.openFor(NONE)],
    ['missions.pendingFor', () => missions.pendingFor(NONE)],
    ['missions.doneOn', () => missions.doneOn(NONE)],
    ['missions.dayStats', () => missions.dayStats(NONE)],
    ['missions.allOverdue', () => missions.allOverdue()],
    ['missions.rangeStats', () => missions.rangeStats(NONE, '2000-01-01', '2100-01-01')],
    ['attendance.get', () => attendance.get(NONE)],
    ['attendance.workingNow', () => attendance.workingNow()],
    ['attendance.absent', () => attendance.absent()],
    ['settings.get', () => db.getSetting('group_chat_id')],
  ];

  let failed = 0;
  for (const [name, run] of checks) {
    try {
      await run();
      console.log(`✅ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`❌ ${name} → ${err.message}`);
    }
  }

  const counts = {};
  for (const t of ['employees', 'missions', 'attendance', 'settings', 'reminder_log']) {
    const row = await db.one(`SELECT COUNT(*) AS c FROM ${t}`);
    counts[t] = Number(row.c);
  }

  console.log('\n📦 Jadvallardagi yozuvlar:');
  for (const [t, c] of Object.entries(counts)) console.log(`   ${t.padEnd(14)} ${c}`);

  await db.close();

  if (failed) {
    console.log(`\n❌ ${failed} ta so'rov ishlamadi.`);
    process.exit(1);
  }
  console.log('\n🎉 Baza tayyor, barcha so\'rovlar ishlaydi.\n');
})().catch((e) => {
  console.error('\n❌ Ulanib bo\'lmadi:', e.message);
  console.error('\nTekshiring:');
  console.error('  • .env dagi DATABASE_URL to\'g\'rimi (parol [YOUR-PASSWORD] o\'rniga qo\'yilganmi)');
  console.error('  • Supabase → Project Settings → Database → Connection string');
  console.error('  • Agar "ENETUNREACH" yoki "timeout" bo\'lsa — Direct connection o\'rniga');
  console.error('    "Session pooler" (port 5432) connection string ni oling.\n');
  process.exit(1);
});
