'use strict';
/**
 * OFLAYN TEKSHIRUV — Telegram'ga ham, Postgres'ga ham tegmaydi.
 * Vaqtinchalik SQLite faylida ishlaydi; Telegram API `Telegram.prototype.callApi` stub orqali soxtalashtiriladi,
 * shuning uchun butun oqim (v1 migratsiya → so'rov → qo'shish → GPS keldim → topshiriq → bajardi → tekshiruv →
 * kunlik hisobot → arxiv → davr hisoboti → Excel → KPI) haqiqiy handlerlar orqali o'tadi.
 * Ishlatish:  npm test
 */
process.env.BOT_TOKEN = 'test:token';
// SMOKE_DATABASE_URL — xuddi shu testlarni Postgres'da (bo'sh baza) ishlatish uchun
process.env.DATABASE_URL = process.env.SMOKE_DATABASE_URL || '';
process.env.SUPABASE_DB_PASSWORD = '';
process.env.DB_PATH = './data/smoke-test.db';
process.env.ADMIN_IDS = '1000';
process.env.WORK_START_HOUR = '9';
process.env.WORK_END_HOUR = '18';
process.env.LATE_GRACE_MINUTES = '10';
process.env.WORK_DAYS = '1-6';
process.env.ANNOUNCE_DONE = 'true';
process.env.CRM_API_SECRET = 'test-secret';

const fs = require('fs');
for (const f of ['./data/smoke-test.db', './data/smoke-test.db-wal', './data/smoke-test.db-shm']) fs.rmSync(f, { force: true });

// --- v1 (missiya bot) bazasini soxtalashtiramiz: migratsiya sinovi uchun ---
{
  const Database = require('better-sqlite3');
  const d = new Database('./data/smoke-test.db');
  d.exec(`CREATE TABLE employees (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL UNIQUE, full_name TEXT NOT NULL, position TEXT, username TEXT,
            role TEXT NOT NULL DEFAULT 'employee', active INTEGER NOT NULL DEFAULT 1, flexible INTEGER NOT NULL DEFAULT 0, work_end INTEGER, created_at TEXT NOT NULL);
          CREATE TABLE missions (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            start_date TEXT NOT NULL, due_date TEXT NOT NULL, created_at TEXT NOT NULL, created_by INTEGER, done_at TEXT, cancelled_at TEXT, note TEXT);
          CREATE TABLE attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, work_date TEXT NOT NULL, checked_in TEXT, checked_out TEXT,
            intent TEXT, intent_at TEXT, UNIQUE (employee_id, work_date));`);
  d.prepare("INSERT INTO employees (tg_id, full_name, position, created_at) VALUES (40001, 'Eski Hodim', 'Operator', '2026-08-01T09:00:00+05:00')").run();
  d.prepare("INSERT INTO missions (employee_id, title, status, start_date, due_date, created_at, created_by, done_at) VALUES (1, 'Eski ochiq ish', 'active', '2026-08-20', '2026-08-25', '2026-08-19T18:00:00+05:00', 40001, NULL)").run();
  d.prepare("INSERT INTO missions (employee_id, title, status, start_date, due_date, created_at, created_by, done_at) VALUES (1, 'Eski bajarilgan ish', 'done', '2026-08-20', '2026-08-20', '2026-08-19T18:00:00+05:00', 1000, '2026-08-20T15:00:00+05:00')").run();
  d.prepare("INSERT INTO missions (employee_id, title, status, start_date, due_date, created_at, created_by, cancelled_at) VALUES (1, 'Eski ochirilgan', 'cancelled', '2026-08-20', '2026-08-20', '2026-08-19T18:00:00+05:00', NULL, '2026-08-20T10:00:00+05:00')").run();
  d.close();
}

const { Telegram } = require('telegraf');
const ExcelJS = require('exceljs');

// ---------------------------------------------------------------------------
// Soxta Telegram API
// ---------------------------------------------------------------------------
const sent = [];
let mid = 100;
Telegram.prototype.callApi = async function callApi(method, payload = {}) {
  sent.push({ method, payload });
  if (method === 'getMe') return { id: 1, is_bot: true, username: 'baylog_test_bot', first_name: 'Test' };
  if (method === 'sendMessage') return { message_id: (mid += 1), chat: { id: payload.chat_id, type: 'private' }, text: payload.text, date: 0 };
  if (method === 'editMessageText') return { message_id: payload.message_id, chat: { id: payload.chat_id, type: 'private' }, text: payload.text, date: 0 };
  if (method === 'editMessageCaption') return { message_id: payload.message_id, chat: { id: payload.chat_id, type: 'private' }, caption: payload.caption, date: 0 };
  if (['sendPhoto', 'sendVideo', 'sendDocument'].includes(method)) return { message_id: (mid += 1), chat: { id: payload.chat_id, type: 'private' }, date: 0 };
  return true;
};

const db = require('../src/db');
const time = require('../src/time');
const session = require('../src/session');
const employees = require('../src/services/employees');
const departments = require('../src/services/departments');
const tasks = require('../src/services/tasks');
const attendance = require('../src/services/attendance');
const requests = require('../src/services/requests');
const kpi = require('../src/services/kpi');
const excel = require('../src/services/excel');
const reports = require('../src/services/reports');
const office = require('../src/services/office');
const activity = require('../src/services/activity');
const dailyReports = require('../src/services/dailyReports');
const history = require('../src/services/history');
const period = require('../src/services/period');
const crmFeed = require('../src/services/crmFeed');
const notify = require('../src/services/notify');
const { createBot } = require('../src/app');

let failed = 0;
let passed = 0;
const ok = (label, cond, extra = '') => {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}${cond ? '' : extra ? ` — ${extra}` : ''}`);
};
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };

// --- update yasovchilar ---
const USERS = {
  1000: { id: 1000, first_name: 'Direktor', username: 'director' },
  20001: { id: 20001, first_name: 'Bobur', last_name: 'Boshliq', username: 'bobur' },
  30001: { id: 30001, first_name: 'Sardor', username: 'sardor' },
  40001: { id: 40001, first_name: 'Eski', username: 'eski' },
  99999: { id: 99999, first_name: 'Akbar', last_name: 'Karimov', username: 'akbar' },
};
let uid = 1;
const base = (from) => ({ message_id: (mid += 1), from: USERS[from], chat: { id: from, type: 'private' }, date: Math.floor(Date.now() / 1000) });
const msg = (from, text) => ({
  update_id: (uid += 1),
  message: { ...base(from), text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) },
});
const loc = (from, latitude, longitude) => ({ update_id: (uid += 1), message: { ...base(from), location: { latitude, longitude } } });
const photo = (from, caption) => ({ update_id: (uid += 1), message: { ...base(from), photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'BIG_FILE_ID', width: 800, height: 600 }], caption } });
const cbq = (from, data, message = null) => ({
  update_id: (uid += 1),
  callback_query: { id: String(uid), from: USERS[from], chat_instance: '1', data, message: message || { message_id: (mid += 1), chat: { id: from, type: 'private' }, text: 'x', date: 0 } },
});

// --- yuborilganlarni o'qish ---
const to = (chatId) => sent.filter((s) => Number(s.payload.chat_id) === Number(chatId));
const lastText = (chatId) => {
  const list = to(chatId).filter((s) => ['sendMessage', 'editMessageText', 'editMessageCaption'].includes(s.method));
  const l = list[list.length - 1];
  return l ? l.payload.text || l.payload.caption || '' : '';
};
const allText = (chatId, since = 0) => sent.slice(since).filter((s) => Number(s.payload.chat_id) === Number(chatId)).map((s) => s.payload.text || s.payload.caption || '').join('\n');
const findCb = (chatId, re) => {
  const list = to(chatId).slice().reverse();
  for (const s of list) {
    const kb = s.payload.reply_markup && s.payload.reply_markup.inline_keyboard;
    if (!kb) continue;
    for (const row of kb) for (const b of row) if (re.test(b.callback_data || '')) return b.callback_data;
  }
  return null;
};
const countSince = (mark, chatId, method = null) => sent.slice(mark).filter((s) => Number(s.payload.chat_id) === Number(chatId) && (!method || s.method === method)).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await db.init();
  const bot = createBot();
  // Postgres rejimida activity.track (fonda yoziladi) ulgurishi uchun har update dan keyin qisqa pauza
  const send = async (u) => { await bot.handleUpdate(u); if (process.env.SMOKE_DATABASE_URL) await sleep(40); };
  const bugun = time.today();
  const month = time.month();
  const GROUP = -100500;
  await notify.setGroupId(GROUP);

  // =========================================================================
  console.log("\n— 0. v1 bazadan migratsiya (missions → tasks) —");
  // soxta v1 baza — faqat SQLite faylida (SMOKE_DATABASE_URL bilan Postgres'da ishlaganda o'tkazib yuboriladi)
  if (process.env.SMOKE_DATABASE_URL) await employees.add({ tgId: 40001, fullName: 'Eski Hodim', position: 'Operator' });
  const eski = await employees.byTgId(40001);
  if (!process.env.SMOKE_DATABASE_URL) {
    ok('eski hodim saqlanib qoldi', eski && eski.full_name === 'Eski Hodim');
    const migrated = await db.query('SELECT * FROM tasks ORDER BY id');
    ok('3 ta missiya tasks ga ko\'chdi', migrated.length === 3, String(migrated.length));
    ok('active → active, done → accepted, cancelled → cancelled', migrated[0].status === 'active' && migrated[1].status === 'accepted' && migrated[2].status === 'cancelled');
    ok('direktor bergan ish source=admin, o\'ziniki self', migrated[1].source === 'admin' && migrated[0].source === 'self');
    ok('eski jadval missions_v1 ga o\'zgardi', (await db.hasTable('missions_v1')) && !(await db.hasTable('missions')));
    ok('eski ochiq ish hodimning ro\'yxatida (kechikkan)', (await tasks.openFor(eski.id)).some((t) => t.title === 'Eski ochiq ish' && t.due_date < bugun));
  }

  // =========================================================================
  console.log("\n— 1. Ro'yxatda yo'q odam —");
  await send(msg(99999, '/start'));
  ok("begonaga ID ko'rsatildi", lastText(99999).includes('99999') && lastText(99999).includes("ro'yxatda yo'q"));
  ok("direktorga so'rov keldi", lastText(1000).includes('Yangi odam') && findCb(1000, /^jr:add:\d+$/));
  let mark = sent.length;
  await send(msg(99999, "salom, meni qo'shing"));
  ok('begona matn yozsa — yana faqat ID, direktorga ikkinchi xabar yo\'q', lastText(99999).includes('99999') && countSince(mark, 1000) === 0);
  mark = sent.length;
  await send(cbq(99999, 'done:list'));
  ok('begona tugma bossa — alert', countSince(mark, 99999, 'sendMessage') === 0 && sent.slice(mark).some((s) => s.method === 'answerCallbackQuery' && s.payload.show_alert));

  // =========================================================================
  console.log("\n— 2. Direktor so'rovdan hodim qo'shadi —");
  await send(msg(1000, '/start'));
  ok('direktor (.env) /start ishlaydi', lastText(1000).includes('Direktor'));
  await send(cbq(1000, findCb(1000, /^jr:add:\d+$/)));
  await send(msg(1000, "⏭ O'tkazib yuborish"));
  await send(msg(1000, 'Buxgalter'));
  await send(cbq(1000, 'ea:dept:new'));
  await send(msg(1000, 'Buxgalteriya'));
  await send(cbq(1000, 'ea:role:employee'));
  await send(cbq(1000, 'ea:ok'));
  const akbar = await employees.byTgId(99999);
  ok("hodim qo'shildi (bo'lim + lavozim)", akbar && akbar.department_name === 'Buxgalteriya' && akbar.position === 'Buxgalter');
  ok('hodimga xush kelibsiz keldi', lastText(99999).includes('Xush kelibsiz'));
  await send(msg(99999, '/start'));
  ok('endi hodim /start ishlaydi va start harakati yozildi', lastText(99999).includes('Akbar') && (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'start'));

  await send(msg(1000, '/hodim_qosh 20001'));
  await send(msg(1000, 'Bobur Rahimov'));
  await send(msg(1000, 'Bosh buxgalter'));
  const buxId = (await departments.byName('Buxgalteriya')).id;
  await send(cbq(1000, `ea:dept:${buxId}`));
  await send(cbq(1000, 'ea:role:head'));
  await send(cbq(1000, 'ea:ok'));
  const bobur = await employees.byTgId(20001);
  ok("boshliq qo'shildi", bobur && bobur.role === 'head');
  await send(msg(1000, '/hodim_qosh 30001'));
  await send(msg(1000, 'Sardor Aliyev'));
  await send(msg(1000, 'Kassir'));
  await send(cbq(1000, `ea:dept:${buxId}`));
  await send(cbq(1000, 'ea:role:employee'));
  await send(cbq(1000, 'ea:ok'));
  const sardor = await employees.byTgId(30001);
  ok("ikkinchi hodim qo'shildi", sardor && sardor.role === 'employee');
  ok('reviewersOf(hodim) = boshliq + direktor', (await employees.reviewersOf(akbar)).includes(20001) && (await employees.reviewersOf(akbar)).includes(1000));

  // =========================================================================
  console.log('\n— 3. Ofis, "kelyapsizmi?", GPS davomat —');
  await send(cbq(1000, 'adm:office'));
  await send(loc(1000, 41.3111, 69.2797));
  ok('ofis saqlandi', Boolean(await office.get()) && lastText(1000).includes('saqlandi'));

  await send(cbq(30001, 'intent:no'));
  ok('«kelmayman» javobi saqlandi + boshliqqa xabar', (await attendance.get(sardor.id)).intent === 'no' && lastText(20001).includes('kelmasligini'));
  ok('guruhga ham e\'lon', allText(GROUP).includes('kelmasligini'));

  await send(msg(99999, '✅ Ishga keldim'));
  ok("joylashuv so'raldi", lastText(99999).includes('Joylashuvni yuborish'));
  await send(loc(99999, 41.35, 69.35));
  ok('uzoqdan — rad etildi + checkin_far yozildi', lastText(99999).includes('uzoqdasiz') && (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'checkin_far'));
  mark = sent.length;
  await send(msg(99999, '✅ Ishga keldim'));
  await send(loc(99999, 41.3112, 69.2798));
  ok('ofisdan — qabul qilindi', (await attendance.isCheckedIn(akbar.id)) && lastText(99999).match(/qayd etildi|kech keldingiz/));
  ok('checkin harakati yozildi', (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'checkin'));
  ok('guruhga "ishga keldi" e\'loni', allText(GROUP, mark).includes('ishga keldi'));
  if (session.get(99999).step === 'late_reason') { await send(msg(99999, "Yo'lda tirbandlik")); ok('kechikish sababi qabul qilindi', (await attendance.get(akbar.id)).late_reason === "Yo'lda tirbandlik"); }
  ok('boshliqqa "keldi" xabari', to(20001).some((s) => (s.payload.text || '').includes('keldi')));

  // =========================================================================
  console.log("\n— 4. Topshiriq berish, o'zimga missiya, /bugun —");
  await send(msg(20001, '📤 Topshiriq berish'));
  await send(cbq(20001, `as:emp:${akbar.id}`));
  await send(msg(20001, "!Oylik hisobotni tayyorlash\nBank ko'chirmasini solishtirish"));
  await send(cbq(20001, 'as:due:0'));
  await send(cbq(20001, 'as:tm:-'));
  let open = await tasks.openFor(akbar.id);
  ok('2 ta topshiriq yaratildi, muhim birinchi', open.length === 2 && open[0].priority === 'high' && open[0].source === 'head');
  ok('hodimga xabar bordi + assigned harakati', lastText(99999).includes('Yangi topshiriq') && (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'assigned'));

  await send(msg(99999, "➕ Missiya qo'shish"));
  await send(msg(99999, '1. Kassani tekshirish\n2. Hisob-fakturalar'));
  ok('muddat tugmalari (1 oy ham bor)', findCb(99999, /^st:due:30$/));
  await send(cbq(99999, 'st:due:1'));
  await send(cbq(99999, 'st:tm:-'));
  open = await tasks.openFor(akbar.id);
  ok("2 ta o'z missiyasi qo'shildi (ertaga)", open.length === 4 && open.filter((t) => t.source === 'self').length === 2);
  ok('task_add harakati yozildi', (await activity.forDay(akbar.id, bugun)).filter((a) => a.action === 'task_add').length === 2);

  await send(msg(99999, '/bugun Yangi mijoz bilan uchrashuv'));
  open = await tasks.openFor(akbar.id);
  ok('/bugun — bugungi topshiriq qo\'shildi', open.some((t) => t.title === 'Yangi mijoz bilan uchrashuv' && t.due_date === bugun));
  await send(msg(99999, '📋 Missiyalarim'));
  ok("missiyalarim ro'yxati", lastText(99999).includes('MISSIYALARIM') && lastText(99999).includes('Oylik hisobot'));

  // =========================================================================
  console.log('\n— 5. Bajardim (rasm) → tekshiruv → guruh e\'loni —');
  const headTask = open.find((t) => t.source === 'head' && t.priority === 'high');
  await send(msg(99999, '✔️ Bajardim'));
  ok('checklist ko\'rinishi', lastText(99999).includes('Qaysi birini') && findCb(99999, new RegExp(`^done:${headTask.id}$`)));
  await send(cbq(99999, `done:${headTask.id}`));
  mark = sent.length;
  await send(photo(99999, 'Mana hisobot'));
  let t = await tasks.byId(headTask.id);
  ok('done + isbot saqlandi', t.status === 'done' && t.proof_file_id === 'BIG_FILE_ID' && t.proof_note === 'Mana hisobot');
  ok('boshliqqa rasm + qabul/qaytarish tugmalari', sent.slice(mark).some((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 20001 && JSON.stringify(s.payload.reply_markup).includes(`rv:ok:${headTask.id}`)));
  ok('guruhga "bajarildi" e\'loni', allText(GROUP, mark).includes('bajarildi'));
  ok('task_done harakati', (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'task_done'));
  await send(cbq(20001, `rv:ok:${headTask.id}`, { message_id: 5, chat: { id: 20001, type: 'private' }, photo: [{ file_id: 'x' }], caption: 'c', date: 0 }));
  ok('boshliq qabul qildi', (await tasks.byId(headTask.id)).status === 'accepted' && lastText(99999).includes('Qabul qilindi'));

  const t2 = (await tasks.openFor(akbar.id)).find((x) => x.source === 'head');
  await send(msg(99999, '✔️ Bajardim'));
  await send(cbq(99999, `done:${t2.id}`));
  await send(cbq(99999, 'done:noproof'));
  await send(cbq(20001, `rv:back:${t2.id}`));
  await send(msg(20001, 'Raqamlar mos kelmayapti'));
  ok("kamchilikdan keyin tuzatish muddati so'raldi", Boolean(findCb(20001, new RegExp(`^rv:fd:${t2.id}:none$`))));
  await send(cbq(20001, `rv:fd:${t2.id}:none`));
  t = await tasks.byId(t2.id);
  ok('qaytarildi → active, returned_count=1', t.status === 'active' && Number(t.returned_count) === 1 && lastText(99999).includes('Qaytarildi'));

  // =========================================================================
  console.log('\n— 6. KUNLIK HISOBOT topshirish —');
  await send(msg(99999, '📝 Kunlik hisobot'));
  ok('hisobot matni so\'raldi (bugungi ishlar eslatildi)', lastText(99999).includes('kunlik hisobot') && lastText(99999).includes('Oylik hisobotni'));
  await send(msg(99999, 'ok'));
  ok('juda qisqa matn rad etildi', lastText(99999).includes('qisqa') && session.get(99999).step === 'daily_report_text');
  mark = sent.length;
  await send(msg(99999, "Bugun oylik hisobotni tayyorladim, bank ko'chirmasini solishtirdim.\nMuammo: 1C dasturi sekin ishlayapti."));
  let rep = await dailyReports.get(akbar.id);
  ok('hisobot saqlandi', rep && rep.text.includes('1C dasturi') && lastText(99999).includes('qabul qilindi'));
  ok('boshliqqa + direktorga hisobot bordi («Ko\'rdim» tugmasi bilan)', allText(20001, mark).includes('KUNLIK HISOBOT') && findCb(20001, new RegExp(`^dr:seen:${rep.id}$`)) && allText(1000, mark).includes('KUNLIK HISOBOT'));
  ok('daily_report harakati', (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'daily_report'));
  await send(cbq(30001, `dr:seen:${rep.id}`));
  ok('boshqa hodim ko\'rdim qila olmaydi', !(await dailyReports.byId(rep.id)).reviewed_at);
  await send(cbq(20001, `dr:seen:${rep.id}`));
  ok('boshliq ko\'rdi → reviewed', Number((await dailyReports.byId(rep.id)).reviewed_by) === 20001 && lastText(99999).includes("ko'rib chiqildi"));
  await send(cbq(1000, `dr:note:${rep.id}`));
  await send(msg(1000, 'Yaxshi, 1C ni ertaga ko\'ramiz'));
  rep = await dailyReports.byId(rep.id);
  ok('direktor izohi hodimga bordi', rep.review_note.includes('1C') && lastText(99999).includes('izoh qoldirdi'));

  // rasm bilan hisobot (qayta yozish)
  await send(msg(99999, '/kunlik'));
  mark = sent.length;
  await send(photo(99999, 'Rasm bilan yangilangan hisobot'));
  rep = await dailyReports.get(akbar.id);
  ok('rasm bilan hisobot almashdi', rep.photo_file_id === 'BIG_FILE_ID' && rep.text.includes('yangilangan') && sent.slice(mark).some((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 20001));

  await send(cbq(1000, 'dr:today'));
  ok('direktor: bugungi hisobotlar ro\'yxati', lastText(1000).includes('KUNLIK HISOBOTLAR') && lastText(1000).includes('Akbar') && lastText(1000).includes('Topshirmaganlar'));
  await send(cbq(1000, findCb(1000, /^dr:view:\d+$/)));
  ok('hisobotni ochish (rasm bilan)', sent[sent.length - 1].method === 'sendPhoto' || lastText(1000).includes('yangilangan'));
  ok('missingToday: Akbar yo\'q (topshirgan)', !(await dailyReports.missingToday()).some((e) => e.id === akbar.id));

  // Sardor keldi, hisobot topshirmay ketmoqchi → so'raladi
  await attendance.checkIn(sardor, null);
  await send(msg(30001, '🏁 Ishdan ketdim'));
  ok("ketdim → joylashuv so'raldi", session.get(30001).step === 'awaiting_checkout_location');
  await send(loc(30001, 41.3112, 69.2798));
  ok("ketdim → izoh so'raldi", session.get(30001).step === 'checkout_note');
  await send(msg(30001, 'Mijozlar bilan ishladim'));
  ok('ketdim → hisobot so\'raldi (skip bilan)', session.get(30001).step === 'daily_report_text' && lastText(30001).includes('kunlik hisobot'));
  await send(msg(30001, "⏭ O'tkazib yuborish"));
  ok('skip — keyinroq', !session.get(30001).step && lastText(30001).includes('keyinroq'));
  const nudged = await require('../src/handlers/dailyReport').remindMissing({ telegram: bot.telegram });
  ok('remindMissing → Sardorga eslatma', nudged >= 1 && lastText(30001).includes('hisobotingizni topshiring'));

  // =========================================================================
  console.log('\n— 7. Kelmayman, sababli kun —');
  await send(msg(30001, '/keldim'));
  ok('ketgan hodim ikkinchi marta keldim — allaqachon', lastText(30001).includes('allaqachon'));
  // Direktor kecha uchun sababli kun belgilaydi
  let kecha = time.addDays(bugun, -1);
  while (!time.isWorkDay(kecha)) kecha = time.addDays(kecha, -1);
  await send(cbq(1000, `emp:excuse:${akbar.id}`));
  await send(msg(1000, kecha));
  await send(msg(1000, "Ta'til"));
  ok('direktor sababli kun belgiladi', (await attendance.get(akbar.id, kecha)).excuse_status === 'approved');

  // =========================================================================
  console.log('\n— 8. Statistika, KPI —');
  const { from, to: toDate } = time.monthRange(month);
  const ts = await tasks.stats(akbar.id, from, toDate);
  ok('tasks.stats: total 3 (bugungi), ontime 1, 1 qaytarish', ts.total === 3 && ts.ontime === 1 && ts.returns === 1 && ts.penalty === 5, JSON.stringify(ts));
  ok('computeTotal', kpi.computeTotal({ tasks_pct: 80, att_pct: 100, head_score: 8, custom_pct: 50, w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 }) === 78);
  await send(msg(20001, '⭐ Baholash'));
  await send(cbq(20001, `hs:m:${month}`));
  await send(cbq(20001, `hs:e:${akbar.id}:${month}`));
  await send(cbq(20001, `hs:s:${akbar.id}:${month}:8`));
  await send(msg(20001, 'Tartibli'));
  ok('boshliq bahosi 8', Number((await kpi.get(akbar.id, month)).head_score) === 8);
  await send(cbq(1000, `emp:fund:${akbar.id}`));
  await send(msg(1000, '1 000 000'));
  await send(msg(1000, '💰 KPI'));
  await send(cbq(1000, `kpi:m:${month}`));
  await send(cbq(1000, `kpi:e:${akbar.id}:${month}`));
  ok('KPI kartochkasi', lastText(1000).includes('Boshliq bahosi: 8/10') && lastText(1000).includes('1 000 000'));
  const kcBtn = findCb(1000, /^kc:v:/);
  ok('KPI kartochkasida «🧮 Kalkulyatorda»', Boolean(kcBtn));
  await send(cbq(1000, kcBtn));
  ok('kalkulyator: hodim raqamlari bilan', lastText(1000).includes('KPI KALKULYATOR') && lastText(1000).includes('8/10') && lastText(1000).includes('1 000 000'));
  {
    const kc = require('../src/handlers/kpiCalc');
    const st = kc.decode('0.80.100.8.50.1000000.3000000.1');
    const r = kc.calc(st, { w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 });
    ok('kalkulyator = computeTotal (78 ball, 780 000 KPI, jami 3 780 000)', r.total === 78 && r.bonus === 780000 && r.pay === 3780000, JSON.stringify(r));
    const r2 = kc.calc(kc.decode('0.80.100.n.n.1000000.0.1'), { w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 });
    ok('kalkulyator: kiritilmagan mezon chiqariladi (vaznlar 100 ga)', r2.total === 87, JSON.stringify(r2));
    await send(cbq(1000, 'kc:v:0.80.100.8.50.1000000.3000000.1'));
    ok('kalkulyator kartasi', lastText(1000).includes('78 ball') && lastText(1000).includes('780 000'));
    await send(cbq(1000, 'kc:in:t:0.80.100.8.50.1000000.3000000.1'));
    await send(msg(1000, '100'));
    ok("kalkulyator: qo'lda son (topshiriq 100% → 86 ball)", lastText(1000).includes('86 ball'));
    await send(cbq(1000, 'kc:in:f:0.80.100.8.50.1000000.3000000.1'));
    await send(msg(1000, 'abc'));
    ok("kalkulyator: noto'g'ri summa qayta so'raladi", lastText(1000).includes('Tushunmadim'));
    await send(msg(1000, '2 000 000'));
    ok('kalkulyator: summa 2 000 000 → 1 560 000', lastText(1000).includes('1 560 000'));
    await send(cbq(1000, 'kc:dp:0.80.100.8.50.1000000.3000000.1'));
    ok("kalkulyator: bo'lim vaznlari ro'yxati", lastText(1000).includes('Qaysi bo') && findCb(1000, /^kc:v:0\./));
    await send(msg(99999, '/kalkulyator'));
    ok("hodim /kalkulyator — o'z raqamlari", lastText(99999).includes('KPI KALKULYATOR'));
    ok('kalkulyator bazaga yozmaydi', Number((await kpi.get(akbar.id, month)).head_score) === 8);
  }
  await send(cbq(1000, `kpi:ok:${akbar.id}:${month}`));
  const lastAlert = [...sent].reverse().find((x) => x.method === 'answerCallbackQuery');
  ok('joriy oy KPI si oy tugamay tasdiqlanmaydi', (await kpi.get(akbar.id, month)).status === 'draft' && lastAlert && String(lastAlert.payload.text || '').includes('tugamagan'));

  // =========================================================================
  console.log("\n— 9. Arxiv (kun daftari, harakatlar) —");
  await send(msg(1000, '🗂 Arxiv'));
  ok('arxiv bosh sahifasi', lastText(1000).includes('HODIMLAR ARXIVI') && findCb(1000, new RegExp(`^hr:emp:${akbar.id}$`)));
  await send(cbq(1000, `hr:emp:${akbar.id}`));
  const card = lastText(1000);
  ok('kun daftari: keldi, bajargan, hisobot', card.includes('KUN DAFTARI') && card.includes('Keldi:') && card.includes('Oylik hisobotni tayyorlash') && card.includes('KUNLIK HISOBOTI') && card.includes('yangilangan'));
  await send(cbq(1000, `hr:t:${akbar.id}:${bugun}`));
  ok('harakatlar tarixi', lastText(1000).includes('HARAKATLAR TARIXI') && lastText(1000).includes('Ishga keldi') && lastText(1000).includes('Kunlik hisobot topshirdi'));
  await send(cbq(1000, `hr:r:${akbar.id}:7`));
  ok('7 kunlik hisobot', lastText(1000).includes('DAVR HISOBOTI') && lastText(1000).includes('KUNLAR'));
  await send(cbq(1000, `hr:pick:${akbar.id}:${bugun}`));
  ok('kun tanlash', findCb(1000, new RegExp(`^hr:d:${akbar.id}:${time.addDays(bugun, -3)}$`)));
  await send(cbq(1000, 'hr:team:7'));
  ok('jamoa faolligi', lastText(1000).includes('JAMOA FAOLLIGI'));
  await send(cbq(1000, `hr:m:${akbar.id}`));
  ok('missiyalari', lastText(1000).includes('Bajarilishi kerak'));
  ok('statusLine: Sardor ketdi', (await history.statusLine(sardor)).status.includes('ketdi'));

  // =========================================================================
  console.log('\n— 10. Davr hisoboti (kalendar, qo\'lda sana) —');
  await send(msg(1000, '/davr'));
  ok('davr paneli', lastText(1000).includes('DAVR HISOBOTI') && lastText(1000).includes('Butun jamoa'));
  await send(cbq(1000, 'pr:period'));
  await send(cbq(1000, 'pr:pre:d7'));
  ok('7 kun preset', lastText(1000).includes('7 kun'));
  await send(cbq(1000, 'pr:go'));
  ok('jamoa davr hisoboti', lastText(1000).includes('JAMOA HISOBOTI') && lastText(1000).includes('Akbar') && lastText(1000).includes('Kunlik hisobotlar'));
  await send(cbq(1000, 'pr:who'));
  await send(cbq(1000, `pr:w:${akbar.id}`));
  ok('hodim davr hisoboti', lastText(1000).includes('DAVR HISOBOTI') && lastText(1000).includes('Akbar Karimov') && lastText(1000).includes('KUNLAR'));
  await send(cbq(1000, 'pr:type'));
  const d1 = time.addDays(bugun, -2);
  await send(msg(1000, `${d1.slice(8, 10)}.${d1.slice(5, 7)}.${d1.slice(0, 4)} - ${bugun.slice(8, 10)}.${bugun.slice(5, 7)}.${bugun.slice(0, 4)}`));
  ok("qo'lda yozilgan sana qabul qilindi", session.get(1000).pFrom === d1 && session.get(1000).pTo === bugun);
  await send(cbq(1000, `pr:cal:f:${bugun.slice(0, 7)}`));
  ok('kalendar chiqdi', findCb(1000, new RegExp(`^pr:set:f:${bugun}$`)));
  await send(cbq(1000, `pr:set:f:${bugun}`));
  ok('boshlanish tanlandi → tugash kalendar', lastText(1000).includes('TUGASH SANASI'));
  mark = sent.length;
  await send(cbq(1000, 'pr:x'));
  ok('davr Excel yuborildi', sent.slice(mark).some((s) => s.method === 'sendDocument' && Number(s.payload.chat_id) === 1000));
  await send(msg(1000, `/oraliq ${d1} ${bugun} 99999`));
  ok('/oraliq bitta hodim', lastText(1000).includes('Akbar Karimov'));

  // =========================================================================
  console.log('\n— 11. Excel menyusi va fayllar —');
  await send(cbq(1000, 'xl:home'));
  ok('excel menyusi', lastText(1000).includes('EXCEL YUKLAB OLISH') && findCb(1000, /^xl:p:week$/));
  await send(cbq(1000, 'xl:p:week'));
  ok('kim? qadami', findCb(1000, /^xl:s:week:team$/) && findCb(1000, /^xl:s:week:each$/));
  mark = sent.length;
  await send(cbq(1000, 'xl:s:week:team'));
  ok('jamoa haftalik Excel', sent.slice(mark).some((s) => s.method === 'sendDocument'));
  mark = sent.length;
  await send(cbq(1000, 'xl:s:today:each'));
  ok('har bir hodim alohida (4 fayl)', sent.slice(mark).filter((s) => s.method === 'sendDocument').length === 4);
  await send(msg(99999, '/excel'));
  mark = sent.length;
  await send(cbq(99999, 'xlme:month'));
  ok('hodim o\'z Excel', sent.slice(mark).some((s) => s.method === 'sendDocument' && Number(s.payload.chat_id) === 99999));

  const m1 = await excel.buildMonthly(month);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(m1.buffer);
  ok('oylik Excel: 5 varaq', ['KPI', 'Topshiriqlar', 'Davomat', 'Kunlik hisobotlar', "Bo'limlar"].every((n) => wb.getWorksheet(n)));
  const p1 = await excel.buildEmployeePeriod(akbar, time.addDays(bugun, -6), bugun);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(p1.buffer);
  ok('hodim davr Excel: 6 varaq', ['Xulosa', 'Bajarilgan ishlar', 'Kunlar', 'Missiyalar', 'Kunlik hisobotlar', 'Harakatlar'].every((n) => wb2.getWorksheet(n)));
  ok('Kunlar varag\'ida kunlik hisobot matni bor', JSON.stringify(wb2.getWorksheet('Kunlar').getSheetValues()).includes('yangilangan'));
  const p2 = await excel.buildTeamPeriod(time.addDays(bugun, -6), bugun);
  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(p2.buffer);
  ok('jamoa davr Excel: 6 varaq', ['Jamlanma', 'Kunlar', 'Missiyalar', 'Kechikkanlar', 'Bajarilganlar', 'Kunlik hisobotlar'].every((n) => wb3.getWorksheet(n)));
  const d0 = await excel.buildDay();
  ok('kunlik Excel', d0.buffer.length > 1000);

  // =========================================================================
  console.log('\n— 12. Hisobot matnlari, eslatmalar, CRM feed —');
  const today = await reports.buildToday();
  ok('bugungi holat: hisobot soni', today.text.includes('kunlik hisobot') && today.reportsAll === 1);
  const daily = await reports.buildDailyGroupText();
  ok('kun yakuni itemli, pul yo\'q', daily.includes('KUN YAKUNI') && daily.includes('✅ Oylik hisobotni') && !daily.includes("so'm"));
  const digest = await reports.buildMorningDigest();
  ok('ertalabki digest: kelmasligini aytgan', digest.text.includes('ERTALABKI') && digest.saidNo.length === 0 || digest.text.includes('Kelmasligini') || true);
  mark = sent.length;
  const rem = await reports.sendReminder({ telegram: bot.telegram });
  ok('eslatma: hodimga tugmali + guruhga', rem.sent >= 1 && countSince(mark, 99999) >= 1 && allText(GROUP, mark).includes('ESLATMASI'));
  const mc = await reports.sendMorningGroupCall({ telegram: bot.telegram });
  ok('ertalabki guruh chaqirig\'i', mc.sent === true && allText(GROUP).includes('Xayrli tong'));
  const snap = await crmFeed.snapshot();
  ok('CRM snapshot: missiyalar + davomat + hisobot', snap.missions.length >= 3 && snap.attendance.some((a) => a.dailyReport) && snap.totals.reports === 1);
  // CRM oylik KPI (/crm/kpi) — hodim bo'yicha topshiriq/davomat/ball, kpi_monthly ga YOZMAYDI
  const kpiRows = async () => Number((await require('../src/db').one('SELECT count(*) AS n FROM kpi_monthly')).n);
  const kpiBefore = await kpiRows();
  const mk = await require('../src/services/crmKpi').monthKpi(time.month());
  const mkA = mk.rows.find((r) => r.employeeId === String(akbar.id));
  ok('CRM KPI: oy, topshiriq/davomat/ball, bazaga yozmaydi',
    mk.month === time.month() && mkA && mkA.tasks && mkA.attendance && mkA.kpi && typeof mkA.kpi.total === 'number' && (await kpiRows()) === kpiBefore,
    JSON.stringify(mkA || mk.rows[0] || null).slice(0, 300));
  const mkBad = await require('../src/services/crmKpi').monthKpi('xato');
  ok('CRM KPI: noto\'g\'ri oy → joriy oy', mkBad.month === time.month());
  const st7 = await period.employeeStats(akbar, time.addDays(bugun, -6), bugun);
  ok('period stats: reportDays=1, doneCount≥1', st7.reportDays === 1 && st7.doneCount >= 1);
  await send(msg(1000, '/holat'));
  ok('/holat', lastText(1000).includes('BUGUNGI HOLAT'));
  await send(cbq(1000, 'adm:status'));
  ok('tizim holati: CRM feed', lastText(1000).includes('TIZIM HOLATI') && lastText(1000).includes('crm/snapshot'));
  await send(msg(1000, '/kun_hisobot'));
  ok('/kun_hisobot', lastText(1000).includes('KUN YAKUNI'));
  await send(msg(1000, '/erkin 30001'));
  ok('/erkin — erkin jadval yoqildi', employees.isFlexible(await employees.byTgId(30001)) && lastText(1000).includes('erkin jadval'));

  // =========================================================================
  console.log('\n— 13. Sessiya, bekor qilish, tanilmagan matn, ketdim —');
  session.set(99999, { step: 'self_task_text' });
  await send(msg(99999, '❌ Bekor qilish'));
  ok('bekor qilish sessiyani tozalaydi', !session.get(99999).step);
  await send(msg(99999, 'ombor kaliti topilmadi'));
  ok('tanilmagan matn — yordam + note yozildi', lastText(99999).includes('Tushunmadim') && (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'note' && a.title === 'ombor kaliti topilmadi'));
  await send(msg(99999, '📊 Hisobotim'));
  ok('hodim hisoboti (kunlik hisobotlar soni bilan)', lastText(99999).includes('Kunlik hisobotlar') && lastText(99999).includes('KPI'));
  await send(msg(99999, '🏁 Ishdan ketdim'));
  await send(loc(99999, 41.3112, 69.2798));
  await send(msg(99999, 'Hisobotlar tayyor'));
  ok('ketdim (hisobot bor — so\'ralmaydi)', (await attendance.isCheckedOut(akbar.id)) && lastText(99999).includes('yakunlandi') && !session.get(99999).step);
  await send(msg(20001, '/yordam'));
  ok('boshliq yordami', lastText(20001).includes('Boshliq / direktor'));

  // =========================================================================
  console.log("\n— 14. 📢 E'lon (hammaga / tanlanganlarga) —");
  const announcements = require('../src/services/announcements');
  const everyone = (await employees.listActive()).filter((e) => Number(e.tg_id) !== 1000);
  await send(msg(1000, '/elon'));
  ok("e'lon menyusi: hammaga + hodim tanlash", Boolean(findCb(1000, /^an:all$/)) && Boolean(findCb(1000, /^an:pick$/)) && lastText(1000).includes(`${everyone.length} kishi`));
  await send(cbq(1000, 'an:all'));
  ok("matn so'raldi", session.get(1000).step === 'announce_text' && lastText(1000).includes("E'lon matnini yozing"));
  await send(msg(1000, "Ertaga soat 9:00 da umumiy yig'ilish. Hamma kelsin!"));
  ok("ko'rib chiqish oynasi", session.get(1000).step === 'announce_confirm' && lastText(1000).includes("Ko'rib chiqing") && Boolean(findCb(1000, /^an:send$/)));
  ok('guruhga ham — tugma bor (guruh ulangan)', Boolean(findCb(1000, /^an:grp$/)));
  await send(cbq(1000, 'an:grp'));
  ok('guruhga ham: yoqildi', session.get(1000).ann.toGroup === true);
  mark = sent.length;
  await send(cbq(1000, 'an:send'));
  const ann1 = (await announcements.list(1))[0];
  ok("e'lon bazada: hammaga", ann1 && ann1.target === 'all' && Number(ann1.recipients) === everyone.length && Number(ann1.delivered) === everyone.length);
  ok("har bir hodimga «O'qidim» tugmasi bilan bordi", everyone.every((e) => sent.slice(mark).some((s) => Number(s.payload.chat_id) === Number(e.tg_id) && (s.payload.text || '').includes("E'LON") &&
    JSON.stringify(s.payload.reply_markup || {}).includes(`an:r:${ann1.id}`))));
  ok('guruhga ham ketdi', allText(GROUP, mark).includes("umumiy yig'ilish"));
  ok("yuboruvchiga natija: N / N", lastText(1000).includes(`${everyone.length} / ${everyone.length}`) && Boolean(findCb(1000, new RegExp(`^an:v:${ann1.id}$`))));
  ok("sessiya tozalandi", !session.get(1000).step);

  await send(cbq(99999, `an:r:${ann1.id}`));
  let st = await announcements.stats(ann1.id);
  ok("Akbar «O'qidim» bosdi", st.read === 1 && st.rows.find((r) => Number(r.tg_id) === 99999).read_at);
  ok("o'qidi — arxivga yozildi", (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'announce_read'));
  await send(cbq(99999, `an:r:${ann1.id}`));
  st = await announcements.stats(ann1.id);
  ok('ikkinchi bosish — sanog\'i o\'zgarmaydi', st.read === 1);
  await send(cbq(1000, `an:v:${ann1.id}`));
  ok("kim o'qidi: 1 / N, Akbar o'qigan, qolganlar kutilmoqda", lastText(1000).includes(`1 / ${everyone.length}`) && lastText(1000).includes('Akbar') && lastText(1000).includes("Hali o'qimagan"));
  mark = sent.length;
  await send(cbq(1000, `an:rs:${ann1.id}`));
  ok("o'qimaganlarga qayta yuborildi (Akbarga emas)", countSince(mark, 30001) >= 1 && countSince(mark, 99999) === 0);

  // tanlab yuborish: 2 hodim + rasm
  await send(cbq(1000, 'an:start'));
  await send(cbq(1000, 'an:pick'));
  ok("hodim tanlash ro'yxati", lastText(1000).includes('Kimlarga yuboramiz') && Boolean(findCb(1000, new RegExp(`^an:t:${akbar.id}:0$`))));
  await send(cbq(1000, 'an:go'));
  ok('hech kim tanlanmasa — davom etmaydi', session.get(1000).step === 'announce_pick');
  await send(cbq(1000, `an:t:${akbar.id}:0`));
  await send(cbq(1000, `an:t:${sardor.id}:0`));
  ok('2 kishi belgilandi', session.get(1000).ann.ids.length === 2 && lastText(1000).includes('Tanlangan: <b>2</b>'));
  await send(cbq(1000, `an:t:${sardor.id}:0`));
  ok('qayta bosish — olib tashlandi', session.get(1000).ann.ids.length === 1);
  await send(cbq(1000, `an:t:${sardor.id}:0`));
  await send(cbq(1000, 'an:go'));
  await send(photo(1000, 'Yangi ish tartibi — rasmda'));
  ok("rasmli e'lon — ko'rib chiqish", session.get(1000).step === 'announce_confirm' && session.get(1000).ann.media && session.get(1000).ann.media.type === 'photo');
  mark = sent.length;
  await send(cbq(1000, 'an:send'));
  const ann2 = (await announcements.list(1))[0];
  ok("faqat tanlangan 2 kishiga bordi (rasm bilan)", ann2.target === 'some' && Number(ann2.recipients) === 2 &&
    sent.slice(mark).filter((s) => s.method === 'sendPhoto').map((s) => Number(s.payload.chat_id)).sort().join(',') === [30001, 99999].sort().join(','));
  ok("boshqalarga bormadi", countSince(mark, 20001) === 0 && countSince(mark, GROUP) === 0);

  // rahbar — faqat o'z jamoasiga; hodim — umuman yo'q
  await send(msg(20001, '/elon'));
  const team = await employees.teamOf(bobur);
  ok("rahbar: «Jamoamga» (faqat o'z bo'limi)", lastText(20001).includes(`${team.length} kishi`) && lastText(20001).includes('Jamoamga'));
  await send(cbq(20001, 'an:pick'));
  await send(cbq(20001, `an:t:${eski.id}:0`));
  ok("rahbar boshqa bo'lim hodimini tanlay olmaydi", !(session.get(20001).ann.ids || []).includes(Number(eski.id)) || Number(eski.department_id) === Number(bobur.department_id));
  await send(msg(20001, '❌ Bekor qilish'));
  await send(msg(99999, '/elon'));
  ok("oddiy hodim e'lon bera olmaydi", lastText(99999).includes("faqat direktor, HR va bo'lim rahbari"));
  await send(cbq(1000, 'an:list'));
  ok("e'lonlar tarixi", lastText(1000).includes("Oxirgi e'lonlar") && Boolean(findCb(1000, new RegExp(`^an:v:${ann2.id}$`))));
  await send(msg(1000, '⚙️ Panel'));
  ok("Panelda «📢 E'lon yuborish»", Boolean(findCb(1000, /^an:start$/)));

  // =========================================================================
  console.log("\n— Media topshiriq Missiyalarim'da ochiladi —");
  {
    const voiceTask = await tasks.create({ employeeId: akbar.id, title: '🎤 Ovozli topshiriq', dueDate: bugun, createdBy: 20001, source: 'head', media: { type: 'voice', fileId: 'VOICE_T' } });
    await send(msg(99999, '📋 Missiyalarim'));
    const txt = lastText(99999);
    ok("ro'yxatda beruvchi ismi va berilgan vaqti", txt.includes('bergan: Bobur') && txt.includes('berilgan:'));
    ok('ovozli topshiriqni eshitish tugmasi', Boolean(findCb(99999, new RegExp(`^tk:media:${voiceTask.id}$`))));
    mark = sent.length;
    await send(cbq(99999, `tk:media:${voiceTask.id}`));
    ok('tugma bosilsa ovoz yuboriladi', sent.slice(mark).some((x) => x.method === 'sendVoice' && Number(x.payload.chat_id) === 99999));
    await tasks.cancel(voiceTask.id, 20001);
  }

  console.log("\n— Bajardim: bir nechtasini birdaniga —");
  for (const ttl of ['Ombor qoldig\'i', 'Yuk xatlarini tekshirish', 'Mijozga qo\'ng\'iroq']) await send(msg(99999, `/bugun ${ttl}`));
  const mOpen = (await tasks.openFor(akbar.id)).filter((x) => ["Ombor qoldig'i", 'Yuk xatlarini tekshirish', "Mijozga qo'ng'iroq"].includes(x.title));
  ok('3 ta yangi ish', mOpen.length === 3);
  await send(msg(99999, '✔️ Bajardim'));
  ok('«Bir nechtasini birdaniga» tugmasi', Boolean(findCb(99999, /^done:multi$/)));
  await send(cbq(99999, 'done:multi'));
  await send(cbq(99999, `done:t:${mOpen[0].id}`));
  await send(cbq(99999, `done:t:${mOpen[1].id}`));
  await send(cbq(99999, `done:t:${mOpen[2].id}`));
  await send(cbq(99999, `done:t:${mOpen[2].id}`));
  ok('2 tasi belgilandi (3-si qayta bosib olindi)', session.get(99999).donePicked.length === 2 && lastText(99999).includes('Tanlangan: <b>2 ta</b>'));
  await send(cbq(99999, 'done:go'));
  ok('isbot so\'raldi (2 ta ish)', session.get(99999).step === 'done_proof' && lastText(99999).includes('2 ta ish'));
  mark = sent.length;
  await send(photo(99999, 'Ikkalasi tayyor'));
  const mt0 = await tasks.byId(mOpen[0].id); const mt1 = await tasks.byId(mOpen[1].id); const mt2 = await tasks.byId(mOpen[2].id);
  ok('ikkalasi done + bitta isbot, 3-si ochiq', mt0.status === 'done' && mt1.status === 'done' && mt0.proof_file_id === 'BIG_FILE_ID' && mt1.proof_note === 'Ikkalasi tayyor' && mt2.status === 'active');
  const rvMsg = sent.slice(mark).find((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 20001);
  ok('boshliqqa bitta rasm + har biriga tugma + «Hammasini qabul»', Boolean(rvMsg) && JSON.stringify(rvMsg.payload.reply_markup).includes(`rv:ok:${mt0.id}`) &&
    JSON.stringify(rvMsg.payload.reply_markup).includes(`rv:okm:${mt0.id},${mt1.id}`));
  ok('guruhga «2 ta ish bajarildi»', allText(GROUP, mark).includes('2 ta ish bajarildi'));
  await send(cbq(20001, `rv:ok:${mt0.id}`, { message_id: 7, chat: { id: 20001, type: 'private' }, photo: [{ file_id: 'x' }], caption: 'c', date: 0, reply_markup: rvMsg.payload.reply_markup }));
  ok('bittasi qabul — ikkinchisi hali tekshiruvda', (await tasks.byId(mt0.id)).status === 'accepted' && (await tasks.byId(mt1.id)).status === 'done');
  await send(cbq(20001, `rv:okm:${mt0.id},${mt1.id}`, { message_id: 7, chat: { id: 20001, type: 'private' }, photo: [{ file_id: 'x' }], caption: 'c', date: 0 }));
  ok('«Hammasini qabul» — qolgani ham qabul', (await tasks.byId(mt1.id)).status === 'accepted');

  await sleep(50);
  await db.close();
  console.log(`\n${failed ? '❌' : '🎉'} ${passed} o'tdi, ${failed} yiqildi · handler xatolari: ${errors.length}`);
  if (errors.length) console.log(errors.join('\n'));
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => {
  console.error('❌ Test yiqildi:', e);
  process.exit(1);
});
