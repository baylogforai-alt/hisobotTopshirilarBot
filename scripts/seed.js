'use strict';
/**
 * BayLog Cargo hodimlarini bazaga kiritadi.
 * Ishlatish:  npm run seed
 * Qayta ishga tushirilsa — mavjudlari yangilanadi, dublikat yaratmaydi.
 */
const db = require('../src/db');
const employees = require('../src/services/employees');
const config = require('../src/config');

const HODIMLAR = [
  { tgId: 8254184544, fullName: 'Samandar', position: 'Sotuv menejeri' },
  { tgId: 5934117099, fullName: 'Akbarali', position: 'Marketolog' },
  { tgId: 7963610051, fullName: 'Durdona', position: 'Operator' },
  { tgId: 7802923308, fullName: 'Islombek', position: 'Dasturchi' },
];

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
