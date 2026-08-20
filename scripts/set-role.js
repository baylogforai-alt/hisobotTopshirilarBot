'use strict';
/**
 * Hodim rolini o'rnatish (admin yoki employee).
 * Ishlatish:
 *   node scripts/set-role.js <tgId> admin "Ism Familiya" [Lavozim]
 *   node scripts/set-role.js <tgId> employee
 * Hodim bazada bo'lmasa va admin qilinsa — yangi yaratiladi.
 */
const db = require('../src/db');
const employees = require('../src/services/employees');

const [, , rawId, role, name, position] = process.argv;
const tgId = Number(rawId);

if (!Number.isFinite(tgId) || !['admin', 'employee'].includes(role)) {
  console.error('❌ Ishlatish: node scripts/set-role.js <tgId> <admin|employee> ["Ism"] ["Lavozim"]');
  process.exit(1);
}

(async () => {
  await db.init();

  let emp = await employees.byTgId(tgId);
  if (!emp) {
    if (role !== 'admin') {
      console.error('❌ Bunday hodim topilmadi.');
      await db.close();
      process.exit(1);
    }
    ({ employee: emp } = await employees.add({
      tgId,
      fullName: name || `Admin ${tgId}`,
      position: position || null,
      role: 'admin',
    }));
    console.log(`✅ Yangi admin yaratildi: ${emp.full_name} (${emp.tg_id})`);
  } else {
    await employees.setRole(tgId, role);
    await employees.activate(tgId);
    emp = await employees.byTgId(tgId);
    console.log(`✅ ${emp.full_name} (${emp.tg_id}) → ${role === 'admin' ? 'administrator 👑' : 'oddiy hodim 👤'}`);
  }

  console.log('\nHozirgi adminlar:');
  const admins = await employees.listAdmins();
  if (!admins.length) console.log('  (yo\'q)');
  for (const a of admins) console.log(`  👑 ${a.full_name} — ${a.tg_id}`);

  await db.close();
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
