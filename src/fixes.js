'use strict';

const db = require('./db');
const employees = require('./services/employees');

// Odilxon — 29-okt-2026 dan yangi Telegram akkaunt (eskisi 8726834955 — `transfer` fix bilan ko'chirildi)
const ODILXON_TG = 9123028176;

// tg_id saqlaydigan ustunlar (db/schema.js dagi BIGINT lar) — profil yangi Telegram akkauntga ko'chirilganda yangilanadi
const TG_COLUMNS = [
  ['tasks', 'created_by'], ['tasks', 'reviewed_by'], ['tasks', 'cancelled_by'],
  ['attendance', 'excuse_by'], ['attendance', 'late_excused_by'], ['attendance', 'marked_by'],
  ['daily_reports', 'reviewed_by'], ['activity_log', 'tg_id'], ['kpi_monthly', 'decided_by'],
  ['announcements', 'created_by'], ['join_requests', 'decided_by'], ['extra_days', 'created_by'], ['extra_days', 'cancelled_by'],
  ['leave_requests', 'decided_by'], ['meetings', 'sender_tg'], ['meetings', 'cancelled_by'],
  ['recurring', 'created_by'], ['recurring', 'cancelled_by'], ['warnings', 'from_tg'],
  ['task_replies', 'from_tg'], ['task_replies', 'to_tg'], ['chats', 'starter_tg'], ['chat_members', 'tg_id'],
  ['chat_messages', 'from_tg'], ['chat_messages', 'to_tg'],
];

/**
 * Hodim profilini (tarix, topshiriqlar, KPI — hammasi employee_id bo'yicha qoladi) yangi Telegram akkauntga ko'chiradi.
 * Yangi akkaunt alohida hodim bo'lib qo'shilgan bo'lsa — o'sha dublikat o'chiriladi (tg_id manfiy qilinib bo'shatiladi).
 */
const transferTg = async (e, to) => {
  const from = Number(e.tg_id);
  const org = require('./services/org');
  const dup = await employees.byTgId(to);
  if (dup) {
    await db.query('UPDATE employees SET tg_id = $1, active = 0 WHERE id = $2', [-to, dup.id]);
    console.log(`[fix] dublikat profil o'chirildi: ${dup.full_name} (id ${dup.id}, ${to})`);
  }
  await db.query('UPDATE employees SET tg_id = $1 WHERE id = $2', [to, e.id]);
  await db.query('DELETE FROM chat_members WHERE tg_id = $1 AND chat_id IN (SELECT chat_id FROM chat_members WHERE tg_id = $2)', [to, from]);
  for (const [table, column] of TG_COLUMNS) await db.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [to, from]);
  await require('./services/requests').closeFor(to, 'approved', to);
  if (await org.isQuiet(from)) { await org.setQuiet(from, false); await org.setQuiet(to, true); }
  if (await org.isOwnTasksOnly(from)) { await org.setOwnTasksOnly(from, false); await org.setOwnTasksOnly(to, true); }
};

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
  { id: 'odilxon-boss-20261002', action: 'boss', match: (e) => Number(e.tg_id) === ODILXON_TG },
  // 5-okt-2026: Odilxon — BayLog boshlig'i (lavozim «Boshliq», xabarlardagi boshliq ismi qayta o'rnatiladi); Jaxongir aka — CEO
  { id: 'odilxon-boshliq-20261005', action: 'boss', position: 'Boshliq', match: (e) => Number(e.tg_id) === ODILXON_TG },
  // 6-okt-2026: Jaxongir aka — bazada «Boshqaruvchi» (219861348, admin) bo'lib turgan; ismi «Jaxongir», lavozimi «CEO»
  // 7-okt-2026: Odilxon — jim rejim (topshiriq berildi/qo'shildi/bajarildi, keldi-ketdi xabarlari kelmasin; Panelda o'zi qaytaradi)
  { id: 'odilxon-jim-20261007', action: 'quiet', match: (e) => Number(e.tg_id) === ODILXON_TG },
  // 23-okt-2026: Odilxon botda faqat o'zi bergan topshiriqlarni ko'rsin (boshqalar bergani ko'rinmasin)
  { id: 'odilxon-oz-topshiriqlari-20261023', action: 'ownTasks', match: (e) => Number(e.tg_id) === ODILXON_TG },
  { id: 'jaxongir-ceo-20261006', action: 'position', name: 'Jaxongir', position: 'CEO', match: (e) => Number(e.tg_id) === 219861348 },
  // 29-okt-2026: Odilxon yangi akkauntda (9123028176) — direktor (role=admin); eski akkaunt (8726834955) botdan chiqadi, profil ko'chadi
  { id: 'odilxon-yangi-tg-20261029', action: 'transfer', to: ODILXON_TG, match: (e) => Number(e.tg_id) === 8726834955 },
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
    if (f.action === 'quiet') await require('./services/org').setQuiet(e.tg_id, true);
    if (f.action === 'ownTasks') await require('./services/org').setOwnTasksOnly(e.tg_id, true);
    if (f.action === 'position') await employees.setPosition(e.id, f.position);
    if (f.action === 'transfer') {
      await transferTg(e, f.to);
      await employees.setRole(e.id, 'admin');
    }
    if (f.name) await employees.rename(e.id, f.name);
    await db.setSetting(`fix:${f.id}`, `${e.id} ${e.full_name}`);
    console.log(`[fix] ${f.id}: ${e.full_name} (${e.tg_id}) → ${f.action}`);
  }
  const roster = await employees.listAll();
  console.log('👥 Hodimlar:\n' + roster.map((e) => `   ${Number(e.active) ? '✓' : '⛔'} ${e.role.padEnd(8)} ${e.tg_id}  ${e.full_name}${e.position ? ` — ${e.position}` : ''}`).join('\n'));
};

module.exports = { run, FIXES };
