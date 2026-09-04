'use strict';
/**
 * Oflayn tekshiruv: Telegram'ga ham, Supabase'ga ham tegmaydi.
 * Har doim vaqtinchalik mahalliy SQLite faylida ishlaydi.
 * Ishlatish:  npm test
 */
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test:token';
process.env.DATABASE_URL = ''; // ⚠️ haqiqiy bazaga tegmaslik uchun majburan SQLite
process.env.DB_PATH = './data/smoke-test.db';

const fs = require('fs');
for (const f of ['./data/smoke-test.db', './data/smoke-test.db-wal', './data/smoke-test.db-shm']) {
  fs.rmSync(f, { force: true });
}

const db = require('../src/db');
const time = require('../src/time');
const employees = require('../src/services/employees');
const missions = require('../src/services/missions');
const attendance = require('../src/services/attendance');
const reports = require('../src/services/reports');
const activity = require('../src/services/activity');
const history = require('../src/services/history');
const excel = require('../src/services/excel');
const { datesFor, parseTitles } = require('../src/handlers/missions');

const ok = (label, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  await db.init();

  // 1. Hodim qo'shish
  const { employee: emp } = await employees.add({
    tgId: 111222333,
    fullName: 'Akbar Karimov',
    position: 'Menejer',
  });
  ok("hodim qo'shildi", emp && emp.full_name === 'Akbar Karimov');
  ok("hodim faol ro'yxatda", (await employees.listActive()).length === 1);

  // 2. Bugunga 5 ta missiya
  const bugun = time.today();
  const kecha = time.addDays(bugun, -1);
  const titles = [
    "Yuklarni ro'yxatga olish",
    'Mijoz bilan shartnoma',
    'Omborni tekshirish',
    'Hisobot tayyorlash',
    "Haydovchilarga to'lov",
  ];
  for (const t of titles) {
    await missions.create({ employeeId: emp.id, title: t, startDate: bugun, dueDate: bugun });
  }
  ok('5 ta missiya yaratildi', (await missions.openFor(emp.id)).length === 5);

  // 3. Ishga keldi
  const ci = await attendance.checkIn(emp.id);
  ok('ishga keldi qayd etildi', !ci.already && (await attendance.isCheckedIn(emp.id)));
  ok('ikkinchi marta "already"', (await attendance.checkIn(emp.id)).already === true);
  ok("workingNow ro'yxatida", (await attendance.workingNow()).length === 1);

  // 4. 3 tasini bajardi
  const open = await missions.openFor(emp.id);
  for (const i of [0, 1, 2]) await missions.markDone(open[i].id, emp.id);
  const st = await missions.dayStats(emp.id);
  ok('3 bajarildi / 2 qoldi', st.done === 3 && st.open === 2);
  ok('boshqa hodim bajara olmaydi', (await missions.markDone(open[3].id, 99999)).ok === false);
  ok('takroran bajarish rad etiladi', (await missions.markDone(open[0].id, emp.id)).reason === 'already');

  // 5. Kechagi bajarilmagan missiya bugun ham ro'yxatda (carry-over)
  await missions.create({
    employeeId: emp.id,
    title: 'Kechagi qolgan ish',
    startDate: kecha,
    dueDate: kecha,
  });
  const bugungi = await missions.openFor(emp.id);
  ok("kechagi ish bugun ham ro'yxatda", bugungi.some((m) => m.title === 'Kechagi qolgan ish'));
  ok('kechikkan birinchi turadi', bugungi[0].due_date < bugun);
  ok('kechikkanlar hisoblandi', (await missions.dayStats(emp.id)).overdue === 1);

  // 6. Kelajakdagi missiya faqat muddati kelganda faollashadi
  const ertaga = time.addDays(bugun, 1);
  await missions.create({ employeeId: emp.id, title: 'Ertangi ish', startDate: ertaga, dueDate: ertaga });
  ok('ertangi ish pending', (await missions.pendingFor(emp.id)).length === 1);
  ok(
    "ertangi ish bugungi ro'yxatda yo'q",
    !(await missions.openFor(emp.id)).some((m) => m.title === 'Ertangi ish'),
  );

  // 6b. Ertangi kun uchun reja bormi (hasCoverageFor)
  ok("ertangi kun qoplangan (hasCoverageFor)", await missions.hasCoverageFor(emp.id, ertaga));
  const indinga = time.addDays(bugun, 2);
  ok("indinga hali reja yo'q", !(await missions.hasCoverageFor(emp.id, indinga)));

  // 6c. "Ishga kelyapsizmi?" javobi (intent)
  const withIntent = await attendance.setIntent(emp.id, 'no');
  ok('intent saqlandi', withIntent.intent === 'no' && Boolean(withIntent.intent_at));

  // 7. Sana hisoblash
  ok('dur:today → bugun', datesFor('today').start === bugun && datesFor('today').due === bugun);
  ok('dur:1 → ertaga', datesFor('1').start === ertaga && datesFor('1').due === ertaga);
  ok('dur:3 → 3 kunlik', datesFor('3').due === time.addDays(ertaga, 2));
  ok('dur:30 → 1 oylik', datesFor('30').due === time.addDays(ertaga, 29));

  // 8. Matn tahlili
  const parsed = parseTitles('1. Birinchi ish\n- Ikkinchi ish | 3\n\nUchinchi ish|30');
  ok('3 qator ajratildi', parsed.length === 3);
  ok('raqam prefiksi tozalandi', parsed[0].title === 'Birinchi ish');
  ok('"| 3" muddat sifatida o\'qildi', parsed[1].days === 3 && parsed[1].title === 'Ikkinchi ish');
  ok('"|30" muddat sifatida o\'qildi', parsed[2].days === 30);

  // 9. Davr statistikasi
  const week = await missions.rangeStats(emp.id, time.addDays(bugun, -6), bugun);
  ok('7 kunlik statistika', week.done === 3);

  // 10. Ishdan ketish
  await attendance.checkOut(emp.id);
  ok('ishdan ketdi qayd etildi', await attendance.isCheckedOut(emp.id));
  ok("workingNow bo'shadi", (await attendance.workingNow()).length === 0);

  // 11. Hisobot matnlari
  const live = await reports.buildLiveReport();
  ok('umumiy hisobot yasaldi', live.includes('Akbar Karimov') && live.includes('ketdi'));
  ok('kechikkanlar hisoboti yasaldi', (await reports.buildOverdueReport()).includes('Kechagi qolgan ish'));

  // 12. Sozlamalar (guruh ID saqlash)
  await db.setSetting('group_chat_id', '-1001234567890');
  ok('sozlama saqlandi', (await db.getSetting('group_chat_id')) === '-1001234567890');

  // 12b. Faoliyat jurnali — hodim botda nima qilgani yozilyaptimi
  await activity.log(emp, 'checkin', { title: '09:12', detail: 'ofisdan 40 m' });
  await activity.log(emp, 'note', { title: 'Ombor kalitini topolmadim' });
  await activity.log(emp, 'use', { title: '📋 Missiyalarim' });
  const acts = await activity.forDay(emp.id, bugun);
  ok('faoliyat jurnaliga yozildi', acts.length === 3);
  ok('jurnal vaqt boyicha tartiblangan', acts[0].action === 'checkin');
  const counts = await activity.countsByDay(emp.id, kecha, bugun);
  ok('kunlik faollik sanaldi', counts.get(bugun) === 3);
  ok('oxirgi faollik topildi', (await activity.lastSeen(emp.id)) !== null);

  // 12c. Hodim tarixi so'rovlari
  ok('shu kuni yozilganlar topildi', (await missions.createdOn(emp.id, bugun)).length >= 5);
  ok('kun zimmasidagi ishlar topildi', (await missions.dueOn(emp.id, bugun)).length >= 5);
  ok('davrda bajarilganlar topildi', (await missions.doneBetween(emp.id, kecha, bugun)).length === 3);
  const attRange = await attendance.range(emp.id, kecha, bugun);
  ok('davomat davri oqildi', attRange.length === 1 && attRange[0].work_date === bugun);
  ok('ish davomiyligi hisoblandi', attendance.workedMinutes(attRange[0]) !== null);

  // 12d. Direktor ko'radigan matnlar
  const card = await history.dayCard(emp, bugun);
  ok('kun daftari yasaldi', card.includes('KUN DAFTARI') && card.includes('Akbar Karimov'));
  ok('kun daftarida kelish vaqti bor', card.includes('Keldi'));
  ok('kun daftarida bajarilganlar bor', card.includes('BAJARGAN ISHLARI (3)'));
  ok('kun daftarida yozgan matni bor', card.includes('Ombor kalitini topolmadim'));

  // Kecha bajarilgan, lekin muddati bugungacha cho'zilgan ish bugun
  // "bajarilmagan" bo'lib ko'rinmasligi kerak
  const uzun = await missions.create({
    employeeId: emp.id,
    title: 'Kecha yopilgan uzoq ish',
    startDate: kecha,
    dueDate: bugun,
  });
  await db.query("UPDATE missions SET status = 'done', done_at = $1 WHERE id = $2", [
    `${kecha}T16:00:00`,
    uzun.id,
  ]);
  const card2 = await history.dayCard(emp, bugun);
  ok(
    'avval bajarilgan ish bugun "bajarilmagan"da yoq',
    !card2.split('SHU KUNI')[0].includes('Kecha yopilgan uzoq ish'),
  );

  const tl = await history.timeline(emp, bugun);
  ok('harakatlar tarixi yasaldi', tl.includes('HARAKATLAR TARIXI') && tl.includes('Ishga keldi'));

  const r7 = await history.rangeReport(emp, 7);
  ok('7 kunlik hisobot yasaldi', r7.includes('7 KUNLIK HISOBOT') && r7.includes('XULOSA'));
  ok('hisobotda ish kunlari bor', r7.includes('Ishga kelgan kunlar'));

  const team = await history.teamOverview(7);
  ok('jamoa faolligi yasaldi', team.includes('JAMOA FAOLLIGI') && team.includes('Akbar Karimov'));

  // 12e. Excel arxivi (3 varaq)
  const xls = await excel.buildEmployeeHistory(emp, 7);
  ok('hodim arxivi Excel yasaldi', xls.buffer.byteLength > 5000);
  ok('fayl nomi togri', /^faoliyat-.*\.xlsx$/.test(xls.filename));

  // 13. Admin huquqi
  await employees.setRole(111222333, 'admin');
  ok('admin qilindi', await employees.isAdmin(111222333));
  await employees.deactivate(111222333);
  ok("o'chirilgan hodim faol emas", (await employees.listActive()).length === 0);

  await db.close();
  console.log(process.exitCode ? "\n❌ Ba'zi testlar yiqildi" : "\n🎉 Barcha testlar o'tdi");
})().catch((e) => {
  console.error('❌ Test xatosi:', e);
  process.exit(1);
});
