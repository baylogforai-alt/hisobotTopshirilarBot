'use strict';
/**
 * SQLite bazasining zaxira nusxasini qo'lda yaratish.
 * Ishlatish:  npm run backup
 * Postgres rejimida hech narsa qilmaydi.
 */
const db = require('../src/db');
const backup = require('../src/services/backup');

(async () => {
  await db.init();
  const res = await backup.run();
  if (res.skipped) {
    console.log("ℹ️  PostgreSQL rejimida fayl zaxirasi kerak emas — bulut bazasi o'zi saqlaydi.");
  } else {
    console.log(`💾 Zaxira yaratildi: ${res.file}`);
    console.log(`   Saqlanayotgan nusxalar: ${res.kept}${res.removed.length ? ` · o'chirildi: ${res.removed.join(', ')}` : ''}`);
  }
  await db.close();
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
