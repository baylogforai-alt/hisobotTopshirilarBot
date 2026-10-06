'use strict';

const db = require('./db');
const employees = require('./services/employees');

/**
 * BIR MARTALIK MA'LUMOT TUZATISHLARI — bot ishga tushganda bajariladi.
 * Har biri `settings` da `fix:<id>` bilan belgilanadi va qayta bajarilmaydi
 * (keyin botdan qo'lda o'zgartirilgan holat buzilmaydi).
 * Moslik aniq 1 ta hodim bo'lmasa — hech narsa qilinmaydi, logga yoziladi va keyingi ishga tushishda yana urinadi.
 */
const FIXES = [
  // 23-sen-2026: Rahmatulloh botdan chiqarildi (ishdan ketgan — ma'lumotlari arxivda qoladi)
  { id: 'chiqar-rahmatulloh-20260923', action: 'deactivate', match: (e) => /rahmatull/i.test(e.full_name) },
  // 23-sen-2026: direktorga hodim qo'shish/o'chirish huquqi (role=admin)
  { id: 'direktor-admin-20260923', action: 'admin', match: (e) => /direktor|director/i.test(`${e.full_name} ${e.position || ''}`) },
  // 2-okt-2026: Odilxon (asoschi) — eng katta boshliq; bazada oldin hodim bo'lib qo'shilgan bo'lsa ham admin bo'lsin, xabarlardagi boshliq ismi
  { id: 'odilxon-boss-20261002', action: 'boss', match: (e) => Number(e.tg_id) === 8726834955 },
  // 5-okt-2026: Odilxon — BayLog boshlig'i (lavozim «Boshliq», xabarlardagi boshliq ismi qayta o'rnatiladi); Jaxongir aka — CEO
  { id: 'odilxon-boshliq-20261005', action: 'boss', position: 'Boshliq', match: (e) => Number(e.tg_id) === 8726834955 },
  // 6-okt-2026: Jaxongir aka — bazada «Boshqaruvchi» (219861348, admin) bo'lib turgan; ismi «Jaxongir», lavozimi «CEO»
  { id: 'jaxongir-ceo-20261006', action: 'position', name: 'Jaxongir', position: 'CEO', match: (e) => Number(e.tg_id) === 219861348 },
];

const run = async () => {
  const all = await employees.listAll();
  for (const f of FIXES) {
    if (await db.getSetting(`fix:${f.id}`)) continue;
    const hits = all.filter((e) => Number(e.active) === 1 && f.match(e));
    if (hits.length !== 1) {
      console.warn(`[fix] ${f.id}: ${hits.length} ta mos hodim (${hits.map((e) => e.full_name).join(', ') || '—'}) — o'tkazib yuborildi`);
      continue;
    }
    const e = hits[0];
    if (f.action === 'deactivate') await employees.deactivate(e.id);
    if (f.action === 'admin') await employees.setRole(e.id, 'admin');
    if (f.action === 'boss') {
      await employees.setRole(e.id, 'admin');
      await require('./services/org').setBossName(e.full_name);
      if (f.position) await employees.setPosition(e.id, f.position);
    }
    if (f.action === 'position') await employees.setPosition(e.id, f.position);
    if (f.name) await employees.rename(e.id, f.name);
    await db.setSetting(`fix:${f.id}`, `${e.id} ${e.full_name}`);
    console.log(`[fix] ${f.id}: ${e.full_name} (${e.tg_id}) → ${f.action}`);
  }
  const roster = await employees.listAll();
  console.log('👥 Hodimlar:\n' + roster.map((e) => `   ${Number(e.active) ? '✓' : '⛔'} ${e.role.padEnd(8)} ${e.tg_id}  ${e.full_name}${e.position ? ` — ${e.position}` : ''}`).join('\n'));
};

module.exports = { run, FIXES };
