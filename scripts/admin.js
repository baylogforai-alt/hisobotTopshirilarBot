'use strict';
/**
 * Rahbarni (yoki boshqa birovni) administrator qilish.
 * Ishlatish:  npm run admin -- 123456789 "Ism Familiya"
 * Ism ixtiyoriy — hodim bazada bo'lsa faqat roli o'zgaradi.
 */
const db = require('../src/db');
const employees = require('../src/services/employees');

const [, , rawId, ...nameParts] = process.argv;
const tgId = Number(rawId);

if (!Number.isFinite(tgId) || String(tgId).length < 5) {
  console.error('❌ Telegram ID kiriting.\n   Misol: npm run admin -- 123456789 "Rahbar"');
  process.exit(1);
}

(async () => {
  await db.init();

  let emp = await employees.byTgId(tgId);
  if (!emp) {
    const name = nameParts.join(' ').trim() || `Rahbar ${tgId}`;
    ({ employee: emp } = await employees.add({ tgId, fullName: name, role: 'admin' }));
    console.log(`✅ Yangi admin qo'shildi: ${emp.full_name} (${emp.tg_id})`);
  } else {
    await employees.setRole(tgId, 'admin');
    await employees.activate(tgId);
    emp = await employees.byTgId(tgId);
    console.log(`👑 ${emp.full_name} (${emp.tg_id}) endi administrator.`);
  }

  console.log('\nAdminlar:');
  const all = await employees.listAll();
  for (const e of all.filter((x) => x.role === 'admin' && x.active)) {
    console.log(`  👑 ${e.full_name} — ${e.tg_id}`);
  }
  await db.close();
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
