'use strict';
/**
 * BayLog Cargo hodimlarini bazaga kiritadi.
 * Ishlatish:  npm run seed
 * Qayta ishga tushirilsa — mavjudlari yangilanadi, dublikat yaratmaydi.
 */
const db = require('../src/db');
const employees = require('../src/services/employees');
const config = require('../src/config');

const { HODIMLAR } = require('../src/hodimlar');

(async () => {
  await db.init();
  console.log(`\n🏢 ${config.companyName} — hodimlarni kiritish\n`);

  for (const h of HODIMLAR) {
    const { employee, created } = await employees.add(h);
    console.log(
      `${created ? "✅ qo'shildi " : '♻️ yangilandi'}  ${String(employee.tg_id).padEnd(12)} ` +
        `${employee.full_name.padEnd(10)} · ${employee.position}`,
    );
  }

  const active = await employees.listActive();
  console.log(`\n👥 Jami faol hodimlar: ${active.length}`);
  console.log('Endi har bir hodim botga /start yozsa ishlata boshlaydi.\n');
  await db.close();
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
