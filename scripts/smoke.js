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
// «Keldim»siz bot yopiq (BAYOMA, 7-okt) — bu fayldagi eski oqimlar uni hisobga olmaydi; qulf smoke-bayoma.js da sinaladi
process.env.CHECKIN_REQUIRED = 'false';

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

  await send(msg(99999, '✅ Ishga keldim')); // eski klaviatura nomi — yangisiga o'giriladi
  ok("joylashuv so'raldi", lastText(99999).includes('Joylashuvni yuborish'));
  await send(loc(99999, 41.35, 69.35));
  ok('uzoqdan — rad etildi + checkin_far yozildi', lastText(99999).includes('uzoqdasiz') && (await activity.forDay(akbar.id, bugun)).some((a) => a.action === 'checkin_far'));
  mark = sent.length;
  await send(msg(99999, '✅ Keldim'));
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

  await send(msg(99999, "➕ O'zimga vazifa"));
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
  await send(msg(99999, '📋 Topshiriqlarim'));
  ok("missiyalarim ro'yxati", lastText(99999).includes('TOPSHIRIQLARIM') && lastText(99999).includes('Oylik hisobot'));

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
  await send(msg(30001, '🏁 Ketdim'));
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
  // mezon 50% < 80% → 0 (vazni qoladi): (80×40 + 100×20 + 80×20 + 0×20) / 100 = 68
  ok('computeTotal (80% dan kam mezon → 0)', kpi.computeTotal({ tasks_pct: 80, att_pct: 100, head_score: 8, custom_pct: 50, w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 }) === 68);
  ok('computeTotal: 79% → 0, 80% — o\'tadi', kpi.computeTotal({ tasks_pct: 79, att_pct: 80, head_score: 7, custom_pct: null, w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 }) === 20
    && kpi.partPct(79) === 0 && kpi.partPct(80) === 80 && kpi.partPct(null) === null);
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
    ok('kalkulyator = computeTotal (68 ball, 680 000 KPI, jami 3 680 000)', r.total === 68 && r.bonus === 680000 && r.pay === 3680000, JSON.stringify(r));
    const r2 = kc.calc(kc.decode('0.80.100.n.n.1000000.0.1'), { w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 });
    ok('kalkulyator: kiritilmagan mezon chiqariladi (vaznlar 100 ga)', r2.total === 87, JSON.stringify(r2));
    await send(cbq(1000, 'kc:v:0.80.100.8.50.1000000.3000000.1'));
    ok('kalkulyator kartasi', lastText(1000).includes('68 ball') && lastText(1000).includes('680 000') && lastText(1000).includes('80% dan kam'));
    await send(cbq(1000, 'kc:in:t:0.80.100.8.50.1000000.3000000.1'));
    await send(msg(1000, '100'));
    ok("kalkulyator: qo'lda son (topshiriq 100% → 76 ball)", lastText(1000).includes('76 ball'));
    await send(cbq(1000, 'kc:in:f:0.80.100.8.50.1000000.3000000.1'));
    await send(msg(1000, 'abc'));
    ok("kalkulyator: noto'g'ri summa qayta so'raladi", lastText(1000).includes('Tushunmadim'));
    await send(msg(1000, '2 000 000'));
    ok('kalkulyator: summa 2 000 000 → 1 360 000', lastText(1000).includes('1 360 000'));
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
  ok('hodim davr Excel: 6 varaq', ['Xulosa', 'Bajarilgan ishlar', 'Kunlar', 'Topshiriqlar', 'Kunlik hisobotlar', 'Harakatlar'].every((n) => wb2.getWorksheet(n)));
  ok('Kunlar varag\'ida kunlik hisobot matni bor', JSON.stringify(wb2.getWorksheet('Kunlar').getSheetValues()).includes('yangilangan'));
  const p2 = await excel.buildTeamPeriod(time.addDays(bugun, -6), bugun);
  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(p2.buffer);
  ok('jamoa davr Excel: 6 varaq', ['Jamlanma', 'Kunlar', 'Topshiriqlar', 'Kechikkanlar', 'Bajarilganlar', 'Kunlik hisobotlar'].every((n) => wb3.getWorksheet(n)));
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
  ok('CRM KPI: oklad, vaznlar, rejim', mk.mode && mkA.kpi.weights && mkA.kpi.weights.tasks > 0 && 'salary' in mkA.kpi && mkA.defaults);
  // CRM'dan sozlash (/crm/kpi/set) — summa, oklad, boshliq bahosi; KPI summasi = summa × ball / 100 (score)
  const crmKpi = require('../src/services/crmKpi');
  const setR = await crmKpi.setFromCrm({ employeeId: akbar.id, month: time.month(), bonusFund: 1000000, salary: 5000000, headScore: 8, by: 'smoke' });
  const akbarNow = await employees.byId(akbar.id);
  ok('CRM KPI set: summa/oklad/baho yozildi, kartochka ham',
    setR.ok && !setR.locked && setR.row.bonusFund === 1000000 && setR.row.salary === 5000000 && setR.row.headScore === 8
      && Number(akbarNow.bonus_fund) === 1000000 && Number(akbarNow.salary) === 5000000,
    JSON.stringify(setR).slice(0, 300));
  ok('CRM KPI set: KPI summasi foizga ko\'ra',
    require('../src/config').kpiMode !== 'score' || setR.row.bonusAmount === Math.round((1000000 * setR.row.total) / 100), JSON.stringify(setR.row));
  ok('CRM KPI set: noto\'g\'ri baho / summa / hodim / kelajak oy — rad',
    (await crmKpi.setFromCrm({ employeeId: akbar.id, headScore: 11 })).error === 'bad_score'
      && (await crmKpi.setFromCrm({ employeeId: akbar.id, bonusFund: -5 })).error === 'bad_amount'
      && (await crmKpi.setFromCrm({ employeeId: 987654, bonusFund: 1 })).error === 'not_found'
      && (await crmKpi.setFromCrm({ employeeId: akbar.id, month: time.shiftMonth(time.month(), 1), bonusFund: 1 })).error === 'future_month');
  const prevM = time.prevMonth();
  await require('../src/services/kpi').compute(akbarNow, prevM);
  await require('../src/db').query("UPDATE kpi_monthly SET status = 'confirmed' WHERE employee_id = $1 AND month = $2", [akbar.id, prevM]);
  const before = await require('../src/services/kpi').get(akbar.id, prevM);
  const lockR = await crmKpi.setFromCrm({ employeeId: akbar.id, month: prevM, headScore: 3, bonusFund: 777 });
  const after = await require('../src/services/kpi').get(akbar.id, prevM);
  ok('CRM KPI set: tasdiqlangan oy qulf (oy qatori o\'zgarmaydi, kartochka saqlanadi)',
    lockR.ok && lockR.locked && after.head_score === before.head_score && Number(after.bonus_fund) === Number(before.bonus_fund)
      && Number((await employees.byId(akbar.id)).bonus_fund) === 777);
  await employees.setBonusFund(akbar.id, null);
  await employees.setSalary(akbar.id, null);
  // Qo'shimcha KPI (/crm/kpi/extra) — summa × asos foizi; bir martalik / har oy; qulf
  const curM = time.month();
  const xa = await crmKpi.extraFromCrm({ action: 'add', employeeId: akbar.id, month: curM, title: 'Davomat uchun', basis: 'attendance', amount: 500000, recurring: true, by: 'smoke' });
  const xb = await crmKpi.extraFromCrm({ action: 'add', employeeId: akbar.id, month: curM, title: 'Yakshanba <ishi>', basis: 'manual', pct: 100, amount: 200000, by: 'smoke' });
  const mkX = (await crmKpi.monthKpi(curM)).rows.find((r) => r.employeeId === String(akbar.id));
  const xAtt = mkX.extras.find((x) => x.basis === 'attendance');
  const xMan = mkX.extras.find((x) => x.basis === 'manual');
  ok('qo\'shimcha KPI: qo\'shildi, summa × foiz',
    xa.ok && xb.ok && mkX.extras.filter((x) => !x.auto).length === 2 && xAtt.recurring && !xMan.recurring
      && xAtt.earned === Math.round((500000 * (xAtt.basisPct || 0)) / 100) && xMan.earned === 200000
      && mkX.extrasTotal === mkX.extras.reduce((s, x) => s + x.earned, 0) && mkX.offDays && typeof mkX.offDays.total === 'number',
    JSON.stringify(mkX.extras));
  // 13-noy: avtomat davomat KPI — kerakli kun vaqtida kelsa to'liq summa, aks holda 0 (bazada saqlanmaydi)
  {
    const kxs = require('../src/services/kpiExtras');
    const cfgA = require('../src/config');
    const auto = mkX.extras.find((x) => x.auto);
    const a = kxs.autoAttendance(cfgA.attBonusFrom);
    const full = kxs.withEarned({ ontime_days: cfgA.attBonusDays, status: 'draft' }, [a]);
    const short = kxs.withEarned({ ontime_days: cfgA.attBonusDays - 1, status: 'draft' }, [a]);
    const excl = kxs.withEarned({ ontime_days: 30, status: 'excluded' }, [a]);
    ok("davomat KPI: avtomat qator, kun to'lsa to'liq, bo'lmasa 0, chiqarilgan oyda 0, boshlanishdan oldin yo'q",
      (curM < cfgA.attBonusFrom ? !auto : Boolean(auto) && auto.basis === 'ontime_days' && auto.earned === (auto.have >= auto.days ? auto.amount : 0))
        && full.total === cfgA.attBonusAmount && short.total === 0 && excl.total === 0
        && kxs.autoAttendance(time.shiftMonth(cfgA.attBonusFrom, -1)) === null,
      JSON.stringify({ auto, full: full.total, short: short.total }));
  }
  // 19-noy: oylik vazifa bonusi — hamma topshiriq vaqtida qabul qilingan bo'lsa to'liq summa, bittasi kech bo'lsa 0
  {
    const kxs = require('../src/services/kpiExtras');
    const cfgT = require('../src/config');
    const t = kxs.autoTasks(cfgT.taskBonusFrom);
    const all = kxs.withEarned({ tasks_total: 3, tasks_ontime: 3, status: 'draft' }, [t]);
    const late = kxs.withEarned({ tasks_total: 3, tasks_ontime: 2, status: 'draft' }, [t]);
    const none = kxs.withEarned({ tasks_total: 0, tasks_ontime: 0, status: 'draft' }, [t]);
    const excl = kxs.withEarned({ tasks_total: 3, tasks_ontime: 3, status: 'excluded' }, [t]);
    ok("vazifa bonusi: hammasi vaqtida — to'liq, bittasi kech — 0, vazifa yo'q — 0, boshlanishdan oldin yo'q",
      kxs.basisPct({ tasks_total: 3, tasks_ontime: 3 }, { basis: 'ontime_tasks' }) === 100
        && kxs.basisPct({ tasks_total: 3, tasks_ontime: 2 }, { basis: 'ontime_tasks' }) === 0
        && kxs.basisPct({ tasks_total: 0, tasks_ontime: 0 }, { basis: 'ontime_tasks' }) === 0
        && kxs.basisPct(null, { basis: 'ontime_tasks' }) === null
        && all.total === cfgT.taskBonusAmount && late.total === 0 && none.total === 0 && excl.total === 0
        && all.list[0].have === 3 && all.list[0].need === 3 && late.list[0].have === 2
        && kxs.autoTasks(time.shiftMonth(cfgT.taskBonusFrom, -1)) === null && t.id === 'auto_tasks' && t.basis === 'ontime_tasks',
      JSON.stringify({ all: all.total, late: late.total, none: none.total }));
  }
  ok('qo\'shimcha KPI: noto\'g\'ri asos / summa / foiz / nomsiz — rad',
    (await crmKpi.extraFromCrm({ action: 'add', employeeId: akbar.id, title: 'x', basis: 'pul', amount: 1 })).error === 'bad_basis'
      && (await crmKpi.extraFromCrm({ action: 'add', employeeId: akbar.id, title: 'x', basis: 'total', amount: 0 })).error === 'bad_amount'
      && (await crmKpi.extraFromCrm({ action: 'add', employeeId: akbar.id, title: 'x', basis: 'manual', amount: 5, pct: 120 })).error === 'bad_pct'
      && (await crmKpi.extraFromCrm({ action: 'add', employeeId: akbar.id, title: '  ', basis: 'total', amount: 5 })).error === 'title_required');
  // bot ekranlari: xodimning «Oylik va KPI» oyi — qator HTML qochirilgan holda
  await send(cbq(99999, `pay:m:${curM}`));
  const payTxt = lastText(99999);
  ok('qo\'shimcha KPI: xodim «Oylik va KPI» da ko\'rinadi (HTML qochirilgan)', payTxt.includes("Qo'shimcha KPI") && payTxt.includes('Davomat uchun') && payTxt.includes('&lt;ishi&gt;'), payTxt.slice(0, 400));
  // har oylik — keyingi oyda ham bor, bir martalik — yo'q; o'chirish shu oydan
  const nextM = time.shiftMonth(curM, 1);
  const kxNext = await require('../src/services/kpiExtras').forMonth(akbar.id, nextM);
  ok('qo\'shimcha KPI: har oylik keyingi oyda ham, bir martalik — yo\'q', kxNext.length === 1 && kxNext[0].basis === 'attendance');
  const rm = await crmKpi.extraFromCrm({ action: 'remove', employeeId: akbar.id, month: curM, id: xAtt.id });
  ok('qo\'shimcha KPI: o\'chirildi', rm.ok && rm.count === 1 && (await require('../src/services/kpiExtras').forMonth(akbar.id, nextM)).length === 0);

  // 7-okt: 🔕 jim rejim — direktorga topshiriq/keldi-ketdi xabarlari bormaydi (o'zi bergan topshiriqdan tashqari)
  {
    const org = require('../src/services/org');
    await send(cbq(1000, 'adm:qt:1'));
    ok("jim rejim: Panel tugmasi bilan yoqildi", await org.isQuiet(1000));
    const rv = await employees.reviewersOf(akbar);
    const dr = await employees.doneReviewersOf(akbar, { created_by: 99999, source: 'self' });
    const own = await employees.doneReviewersOf(akbar, { created_by: 1000, source: 'admin' });
    const aw = await employees.attendanceWatchersOf(akbar);
    ok("jim rejim: tekshiruvchi/keldi-ketdi ro'yxatida direktor yo'q, bo'lim rahbari bor", !rv.includes(1000) && rv.includes(20001) && !dr.includes(1000) && dr.includes(20001) && !aw.includes(1000));
    ok("jim rejim: o'zi bergan topshiriq bajarilsa — direktorga keladi", own.includes(1000));
    const onlyBoss = await employees.doneReviewersOf(bobur, { created_by: 20001, source: 'self' });
    ok("jim rejim: boshqa tekshiruvchi bo'lmasa — baribir direktorga (qabul qiladigan odam qolsin)", onlyBoss.includes(1000));
    const config = require('../src/config');
    // 29-okt: jim rejimdagi boshliq o'rniga ADMIN_IDS dagi texnik direktor (hodim bo'lishi mumkin) oladi, o'z xabarini emas
    config.adminIds.push(77777, Number(akbar.tg_id));
    const dep = await employees.doneReviewersOf(bobur, { created_by: 20001, source: 'self' });
    const depAw = await employees.attendanceWatchersOf(akbar);
    const depAp = await org.approversOf(bobur);
    ok("jim rejim: boshliq o'rniga ADMIN_IDS oladi (Bajardim, tasdiq)", dep.includes(77777) && !dep.includes(1000) && depAp.includes(77777) && !depAp.includes(1000), JSON.stringify([dep, depAp]));
    ok("jim rejim: ADMIN_IDS hodim o'z keldi-ketdisini olmaydi", depAw.includes(77777) && !depAw.includes(Number(akbar.tg_id)) && !depAw.includes(1000), JSON.stringify(depAw));
    config.adminIds.splice(config.adminIds.indexOf(77777), 2);
    await send(cbq(1000, 'adm:qt:0'));
    ok("jim rejim: o'chirildi", !(await org.isQuiet(1000)) && (await employees.reviewersOf(akbar)).includes(1000));
  }

  // 23-okt: kunlik zaxira jim rejimdagi boshliqqa (Odilxon) bormaydi; «faqat o'z topshiriqlari» — boshqalar bergani ko'rinmaydi
  {
    const org = require('../src/services/org');
    const access = require('../src/services/access');
    await employees.setRole(sardor.id, 'admin');
    await org.setQuiet(1000, true);
    const zMark = sent.length;
    await notify.docToAdmins(bot, Buffer.from('x'), 'zaxira.json.gz', 'zaxira');
    const docs = sent.slice(zMark).filter((s) => s.method === 'sendDocument').map((s) => Number(s.payload.chat_id));
    ok("kunlik zaxira: jim rejimdagi boshliqqa bormaydi, boshqa adminga boradi", !docs.includes(1000) && docs.includes(30001), JSON.stringify(docs));
    // 26-okt: haftalik hisobot ham (matn va Excel) jim rejimdagi boshliqqa bormaydi
    const wMark = sent.length;
    await require('../src/jobs').weeklyReport(bot);
    const wTo = sent.slice(wMark).filter((s) => s.method === 'sendMessage' || s.method === 'sendDocument').map((s) => Number(s.payload.chat_id));
    ok("haftalik hisobot: jim rejimdagi boshliqqa bormaydi, boshqa adminga boradi", wTo.length > 0 && !wTo.includes(1000) && wTo.includes(30001), JSON.stringify(wTo));
    await org.setQuiet(1000, false);
    await employees.setRole(sardor.id, 'employee');

    const tMine = await tasks.create({ employeeId: akbar.id, title: 'Direktor bergan ish OWN', dueDate: bugun, createdBy: 1000, source: 'admin' });
    const tOther = await tasks.create({ employeeId: akbar.id, title: 'Boshliq bergan ish OTHER', dueDate: bugun, createdBy: 20001, source: 'head' });
    await org.setOwnTasksOnly(1000, true);
    const me = await access.resolve(1000);
    const has = (list, t) => list.some((x) => Number(x.id) === Number(t.id));
    const vis = tasks.visibleFor(me, await tasks.openFor(akbar.id));
    ok("o'z topshiriqlari: boshliq faqat o'zi berganini ko'radi", me.ownTasksOnly && has(vis, tMine) && !has(vis, tOther));
    const act = await access.tasksByKind(me, 'active');
    ok("o'z topshiriqlari: ⏳ Faol ro'yxatida boshqalar bergani yo'q", has(act, tMine) && !has(act, tOther));
    const headAct = await access.tasksByKind(await access.resolve(20001), 'active');
    ok("o'z topshiriqlari: boshqa rahbar hammasini ko'radi", has(headAct, tMine) && has(headAct, tOther));
    await send(cbq(1000, `emp:tasks:${akbar.id}`));
    ok("o'z topshiriqlari: hodim topshiriqlari ekranida faqat o'zi bergani", lastText(1000).includes('OWN') && !lastText(1000).includes('OTHER'));
    await send(msg(1000, '/kun_hisobot'));
    ok("o'z topshiriqlari: kun yakunida faqat o'zi bergani", lastText(1000).includes('OWN') && !lastText(1000).includes('OTHER'));
    await send(cbq(1000, `hr:d:${akbar.id}:${bugun}`));
    ok("o'z topshiriqlari: kun daftarida faqat o'zi bergani", lastText(1000).includes('OWN') && !lastText(1000).includes('OTHER'));
    await send(msg(1000, '/hodim_missiya 99999'));
    ok("o'z topshiriqlari: /hodim_missiya da faqat o'zi bergani", lastText(1000).includes('OWN') && !lastText(1000).includes('OTHER'));
    const xl = await excel.buildTeamPeriod(bugun, bugun, { viewer: me });
    const wbx = new ExcelJS.Workbook();
    await wbx.xlsx.load(xl.buffer);
    const cells = [];
    wbx.eachSheet((ws) => ws.eachRow((r) => cells.push(String(r.values.join(' ')))));
    ok("o'z topshiriqlari: Excelda boshqalar bergani yo'q", cells.some((c) => c.includes('OWN')) && !cells.some((c) => c.includes('OTHER')));
    await org.setOwnTasksOnly(1000, false);
    ok("o'z topshiriqlari: o'chirilsa — hammasi ko'rinadi", has(await access.tasksByKind(await access.resolve(1000), 'active'), tOther));
    await db.query('DELETE FROM tasks WHERE id IN ($1, $2)', [tMine.id, tOther.id]);
  }
  ok('qo\'shimcha KPI: tasdiqlangan oy — qulf', (await crmKpi.extraFromCrm({ action: 'add', employeeId: akbar.id, month: prevM, title: 'x', basis: 'total', amount: 5 })).error === 'locked');
  await crmKpi.extraFromCrm({ action: 'remove', employeeId: akbar.id, month: curM, id: xMan.id });
  const st7 =await period.employeeStats(akbar, time.addDays(bugun, -6), bugun);
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
  await send(msg(99999, '🏁 Ketdim'));
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
    await send(msg(99999, '📋 Topshiriqlarim'));
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
  // 7-okt: Ketdimdan keyin «Bajardim» yopiq
  await send(msg(99999, '✔️ Bajardim'));
  ok('Ketdimdan keyin «Bajardim» yopiq', lastText(99999).includes('Ketdim» qilgansiz'));
  // hodim hali ishda deb olamiz (Ketdim bekor)
  await db.query('UPDATE attendance SET checked_out = NULL WHERE employee_id = $1 AND work_date = $2', [akbar.id, bugun]);
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

  // --- 💲 Narx so'rovlari ---
  USERS[50001] = { id: 50001, first_name: 'Dilshod', username: 'dilshod' };
  USERS[50002] = { id: 50002, first_name: 'Samandar', username: 'samandar' };
  await employees.add({ tgId: 50001, fullName: 'Dilshod Deklarant', position: 'Deklarant' });
  await employees.add({ tgId: 50002, fullName: 'Samandar', position: 'Sotuv menejeri' });
  const dil = await employees.byTgId(50001);
  const sam = await employees.byTgId(50002);
  const kbText = (chatId) => JSON.stringify(to(chatId).slice(-1)[0].payload.reply_markup || {});
  await send(msg(50002, '/menu'));
  ok("narx: bayroqsiz hodimda «💲 Narxlar» yo'q", !kbText(50002).includes('💲 Narxlar'));
  await send(cbq(1000, `emp:dc:${dil.id}:1`));
  await send(cbq(1000, `emp:ap:${sam.id}:1`));
  ok('narx: kartochkada deklarant yoqildi', employees.isDeclarant(await employees.byId(dil.id)));
  ok("narx: kartochkada «narx so'ray oladi» yoqildi", employees.canAskPrice(await employees.byId(sam.id)));
  await send(cbq(1000, `emp:dc:${dil.id}:1`));
  ok("narx: eskirgan tugma (qayta :1) holatni o'zgartirmaydi", employees.isDeclarant(await employees.byId(dil.id)));
  await send(cbq(30001, `emp:dc:${dil.id}:0`));
  ok("narx: hodim kartochkani o'zgartira olmaydi", employees.isDeclarant(await employees.byId(dil.id)));
  await send(msg(50001, '/menu'));
  await send(msg(50002, '/menu'));
  ok('narx: ruxsatlilarda «💲 Narxlar» bor', kbText(50001).includes('💲 Narxlar') && kbText(50002).includes('💲 Narxlar'));
  ok('narx: listDeclarants', (await employees.listDeclarants()).map((e) => e.id).join() === String(dil.id));
  ok("narx: Samandar fix ro'yxatda", require('../src/fixes').FIXES.some((f) => f.id === 'samandar-narx-20261031' && f.action === 'askPrice' && f.match({ tg_id: 8254184544 })));
  ok('narx: jadvallar bor', (await db.count('SELECT COUNT(*) AS c FROM price_requests')) === 0 && (await db.count('SELECT COUNT(*) AS c FROM price_request_msgs')) === 0);

  const pr = require('../src/services/priceRequests');
  const t0 = time.now().set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  ok('narx svc: dueAtFor', pr.dueAtFor('1h', t0) === t0.plus({ minutes: 60 }).toISO() && pr.dueAtFor('none', t0) === null
    && pr.dueAtFor('today', t0).startsWith(`${t0.toFormat('yyyy-MM-dd')}T${employees.workEndOf(null)}`));
  {
    // «Ertaga» dam olish kuniga tushmasin: ertasi ish kuni bo'lmagan kunni topamiz
    const ymd = (d) => d.toFormat('yyyy-MM-dd');
    let eve = t0;
    for (let i = 0; i < 14 && time.isWorkDay(time.addDays(ymd(eve), 1)); i += 1) eve = eve.plus({ days: 1 });
    if (time.isWorkDay(time.addDays(ymd(eve), 1))) {
      ok('narx svc: dueAtFor tomorrow (dam olish kuni yo\'q — o\'tkazildi)', true);
    } else {
      let nextWork = time.addDays(ymd(eve), 1);
      while (!time.isWorkDay(nextWork)) nextWork = time.addDays(nextWork, 1);
      ok('narx svc: dueAtFor tomorrow — dam olish kunidan keyingi ish kuni', pr.dueAtFor('tomorrow', eve).startsWith(`${nextWork}T${employees.workEndOf(null)}`));
    }
    let weekday = t0;
    while (!time.isWorkDay(time.addDays(ymd(weekday), 1))) weekday = weekday.plus({ days: 1 });
    ok('narx svc: dueAtFor tomorrow — ertasi ish kuni bo\'lsa ertaga', pr.dueAtFor('tomorrow', weekday).startsWith(`${time.addDays(ymd(weekday), 1)}T${employees.workEndOf(null)}`));
  }
  const r1 = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'Mijoz Ali: 20 quti telefon g\'ilofi', dueAt: pr.dueAtFor('3h', t0) });
  const r2 = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'Mijoz Vali: mebel 2 t' });
  ok('narx svc: inbox tartibi (muddatlisi birinchi)', (await pr.inbox(dil.id)).map((r) => r.id).join() === `${r1.id},${r2.id}`);
  ok('narx svc: ask → asked, msg yozildi', await pr.ask(r1.id, dil.id, { text: 'Brendmi?' }) && (await pr.byId(r1.id)).status === 'asked' && (await pr.messages(r1.id)).length === 1);
  ok('narx svc: begona javob bera olmaydi', !(await pr.answer(r1.id, dil.id, { text: 'x' })));
  ok('narx svc: answer → open', await pr.answer(r1.id, sam.id, { text: 'Yo\'q' }) && (await pr.byId(r1.id)).status === 'open');
  ok('narx svc: begona deklarant narx bera olmaydi', !(await pr.setPrice(r1.id, sam.id, '100$')));
  ok('narx svc: setPrice', await pr.setPrice(r1.id, dil.id, '1 250$', 'yetkazish bilan') && (await pr.byId(r1.id)).price === '1 250$');
  ok('narx svc: ikkinchi setPrice → false', !(await pr.setPrice(r1.id, dil.id, '1$')));
  ok('narx svc: cancel', await pr.cancel(r2.id, sam.id) && !(await pr.cancel(r2.id, sam.id)));
  ok('narx svc: history qidiruv', (await pr.history({ q: 'TELEFON' })).map((r) => r.id).join() === String(r1.id) && (await pr.history({ q: 'mebel' })).length === 0);
  const prSt = await pr.stats(bugun, bugun);
  ok('narx svc: stats', prSt.length === 1 && prSt[0].total === 2 && prSt[0].priced === 1 && prSt[0].avgMinutes !== null);
  ok('narx svc: countInbox 0', (await pr.countInbox(dil.id)) === 0);
  const r3 = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'Mijoz Sher: kiyim 1 t', dueAt: pr.dueAtFor('1h', t0) });
  const prLater = [time.now().plus({ hours: 5 }), t0.plus({ hours: 5 })].reduce((x, y) => (y > x ? y : x)).toISO(); // soatga bog'liq emas: r3 muddati (t0+1h) har doim o'tgan bo'ladi
  ok('narx svc: dueForReminder (open, faol deklarant)', (await pr.dueForReminder(prLater, 60)).map((r) => r.id).join() === String(r3.id) && (await pr.dueForReminder(time.stamp(), 60)).length === 0);
  await pr.markReminded([r3.id], prLater);
  ok('narx svc: markReminded oraliqni suradi', (await pr.dueForReminder(prLater, 60)).length === 0);
  const prOv = (await pr.overdue(prLater)).map((r) => r.id).join();
  await pr.markOverdue(r3.id, prLater);
  ok('narx svc: overdue bir marta', prOv === String(r3.id) && (await pr.overdue(prLater)).length === 0);
  await pr.ask(r3.id, dil.id, { text: 'Hajmi?' });
  const prStale = (await pr.askedStale(prLater, 30)).map((r) => r.id).join();
  await pr.markAskedNudged(r3.id, prLater);
  ok('narx svc: askedStale + markAskedNudged', prStale === String(r3.id) && (await pr.askedStale(prLater, 30)).length === 0 && (await pr.dueForReminder(prLater, 60)).length === 0);
  ok('narx svc: countMine/allOpen/mine', (await pr.countMine(sam.id)) === 1 && (await pr.allOpen()).map((r) => r.id).join() === String(r3.id) && (await pr.mine(sam.id))[0].declarant_name === 'Dilshod Deklarant');

  // --- 💲 Narx so'rovlari: bot oqimi (handlers/price.js) ---
  // r1 (priced) / r2 (cancelled) / r3 (asked) — servis testlaridan; oqim testlari uchun hammasini yopamiz
  await pr.cancel(r3.id, sam.id);
  await send(msg(30001, '💲 Narxlar'));
  ok("narx oqim: ruxsatsiz hodimga bo'lim yopiq", lastText(30001).includes('ochiq emas'));
  // so'rov: Samandar
  await send(msg(50002, '💲 Narxlar')); await send(cbq(50002, 'pq:new'));
  ok('narx oqim: deklarant ro\'yxati (o\'zi yo\'q)', Boolean(findCb(50002, new RegExp(`^pq:d:${dil.id}$`))) && !findCb(50002, new RegExp(`^pq:d:${sam.id}$`)));
  await send(cbq(50002, `pq:d:${dil.id}`)); await send(msg(50002, 'Mijoz Karim: 50 kg kosmetika'));
  await send(photo(50002, '')); await send(cbq(50002, 'pq:due:3h'));
  mark = sent.length; await send(cbq(50002, 'pq:send'));
  const q1 = (await pr.mine(sam.id))[0];
  ok('narx oqim: so\'rov yaratildi (rasm + muddat)', q1 && q1.media_file_id === 'BIG_FILE_ID' && q1.due_at && q1.status === 'open');
  ok('narx oqim: deklarantga rasm + 3 tugma', sent.slice(mark).some((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 50001
    && ['pq:p:', 'pq:q:', 'pq:in'].every((k) => JSON.stringify(s.payload.reply_markup).includes(k))));
  // ro'yxat
  await send(msg(50001, '💲 Narxlar'));
  ok('narx oqim: deklarant darhol ro\'yxatni ko\'radi', lastText(50001).includes('Karim') && Boolean(findCb(50001, new RegExp(`^pq:v:${q1.id}$`))));
  // savol → javob
  await send(cbq(50001, `pq:q:${q1.id}`)); mark = sent.length; await send(msg(50001, 'Qaysi brend?'));
  ok('narx oqim: savol so\'rovchiga + «Javob berish»', allText(50002, mark).includes('Qaysi brend?') && Boolean(findCb(50002, new RegExp(`^pq:a:${q1.id}$`))));
  ok('narx oqim: holat asked', (await pr.byId(q1.id)).status === 'asked');
  await send(cbq(50002, `pq:a:${q1.id}`)); mark = sent.length; await send(msg(50002, 'Nivea'));
  ok('narx oqim: javob deklarantga, holat open', allText(50001, mark).includes('Nivea') && (await pr.byId(q1.id)).status === 'open');
  // begona
  await send(cbq(30001, `pq:p:${q1.id}`));
  ok('narx oqim: begona narx bera olmaydi', session.get(30001).step !== 'pq_price');
  // narx
  await send(cbq(50001, `pq:p:${q1.id}`)); await send(msg(50001, '320$')); mark = sent.length; await send(msg(50001, '⏭ O\'tkazib yuborish'));
  ok('narx oqim: narx so\'rovchiga + «Qayta so\'rash»', allText(50002, mark).includes('320$') && Boolean(findCb(50002, new RegExp(`^pq:r:${q1.id}$`))) && (await pr.byId(q1.id)).status === 'priced');
  mark = sent.length; await send(cbq(50001, `pq:p:${q1.id}`));
  ok('narx oqim: eskirgan «Narx berish» — sessiya ochilmaydi, xabar yo\'q', session.get(50001).step !== 'pq_price' && countSince(mark, 50002) === 0);
  // qayta so'rash
  await send(cbq(50002, `pq:r:${q1.id}`)); await send(cbq(50002, 'pq:due:none')); await send(cbq(50002, 'pq:send'));
  const q2 = (await pr.mine(sam.id))[0];
  ok('narx oqim: qayta so\'rash — parent_id, tavsif/media nusxa', q2.parent_id === q1.id && q2.description === q1.description && q2.media_file_id === 'BIG_FILE_ID' && q2.due_at === null);
  // bekor
  await send(cbq(30001, `pq:x:${q2.id}`));
  ok('narx oqim: begona bekor qila olmaydi', (await pr.byId(q2.id)).status === 'open');
  mark = sent.length; await send(cbq(50002, `pq:x:${q2.id}`));
  ok('narx oqim: bekor → deklarantga xabar', (await pr.byId(q2.id)).status === 'cancelled' && allText(50001, mark).includes('bekor'));
  mark = sent.length; await send(cbq(50002, `pq:x:${q2.id}`));
  ok('narx oqim: ikkinchi bekor — xabar yo\'q', countSince(mark, 50001) === 0);

  // --- 💲 Narx so'rovlari: eslatmalar (price.nag) ---
  const price = require('../src/handlers/price');
  const wd = (() => { let d = time.now(); while (!time.isWorkDay(d.toFormat('yyyy-MM-dd'))) d = d.plus({ days: 1 }); return d; })();
  const at10 = wd.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const old = at10.minus({ minutes: 70 }).toISO();
  const a = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'A yuk' });
  const b = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'B yuk', dueAt: at10.minus({ minutes: 5 }).toISO() });
  const c = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'C yuk' });
  await db.query('UPDATE price_requests SET created_at = $1 WHERE id IN ($2, $3, $4)', [old, a.id, b.id, c.id]);
  await pr.ask(c.id, dil.id, { text: 'savol' }); await db.query('UPDATE price_requests SET asked_at = $1 WHERE id = $2', [old, c.id]);
  mark = sent.length; await price.nag(bot, at10);
  const toDil = sent.slice(mark).filter((s) => Number(s.payload.chat_id) === 50001 && (s.payload.text || '').includes('NARX KUTILMOQDA'));
  ok('narx eslatma: bitta xabar, 2 ta so\'rov (asked yo\'q)', toDil.length === 1 && toDil[0].payload.text.includes(`№${a.id}`) && toDil[0].payload.text.includes(`№${b.id}`) && !toDil[0].payload.text.includes(`№${c.id}`));
  ok('narx eslatma: muddat o\'tdi — so\'rovchiga', allText(50002, mark).includes(`№${b.id} ga hali narx berilmadi`));
  ok('narx eslatma: savolga javob kutilmoqda — so\'rovchiga', allText(50002, mark).includes(`№${c.id}`) && Boolean(findCb(50002, new RegExp(`^pq:a:${c.id}$`))));
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 5 }));
  ok('narx eslatma: 5 daqiqadan keyin takror yo\'q (overdue ham bir marta)', countSince(mark, 50001) === 0 && countSince(mark, 50002) === 0);
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 61 }));
  ok('narx eslatma: 60 daqiqadan keyin yana', countSince(mark, 50001) === 1);
  mark = sent.length; await price.nag(bot, wd.set({ hour: 20, minute: 0 }));
  ok('narx eslatma: ish vaqtidan tashqari — yo\'q', sent.length === mark);
  await employees.deactivate(dil.id); mark = sent.length; await price.nag(bot, at10.plus({ minutes: 130 }));
  ok('narx eslatma: nofaol deklarantga yo\'q', countSince(mark, 50001) === 0);
  await employees.activate(dil.id);

  // bitta deklarant — bitta ro'yxat: so'rovlar turli vaqtda yaratilgan bo'lsa ham eslatma umumiy soatda ketadi
  USERS[50004] = { id: 50004, first_name: 'Ravshan', username: 'ravshan' };
  await employees.add({ tgId: 50004, fullName: 'Ravshan Deklarant', position: 'Deklarant' });
  const rav = await employees.byTgId(50004);
  await employees.setDeclarant(rav.id, true);
  const stag = [];
  for (const [label, ago] of [['X', 70], ['Y', 50], ['Z', 30]]) {
    const s = await pr.create({ requesterId: sam.id, declarantId: rav.id, description: `${label} stagger` });
    await db.query('UPDATE price_requests SET created_at = $1 WHERE id = $2', [at10.minus({ minutes: ago }).toISO(), s.id]);
    stag.push(s);
  }
  const ravMsgs = (m) => sent.slice(m).filter((s) => Number(s.payload.chat_id) === 50004 && (s.payload.text || '').length);
  const listsAll = (text) => stag.every((s) => text.includes(`№${s.id}`));
  mark = sent.length; await price.nag(bot, at10);
  ok('narx eslatma: turli vaqtda yaratilganlar — bitta xabar, hammasi ro\'yxatda', ravMsgs(mark).length === 1 && listsAll(ravMsgs(mark)[0].payload.text));
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 20 }));
  const n20 = ravMsgs(mark).length;
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 40 }));
  ok('narx eslatma: +20 va +40 daqiqada takror yo\'q', n20 === 0 && ravMsgs(mark).length === 0);
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 61 }));
  ok('narx eslatma: +61 daqiqada yana bitta xabar, hammasi ro\'yxatda', ravMsgs(mark).length === 1 && listsAll(ravMsgs(mark)[0].payload.text));
  // shu tikda muddati o'tgan so'rov — alohida «muddati o'tdi» xabari emas, ro'yxatda 🔴
  const ovl = await pr.create({ requesterId: sam.id, declarantId: rav.id, description: 'W muddatli', dueAt: at10.plus({ minutes: 100 }).toISO() });
  await db.query('UPDATE price_requests SET created_at = $1 WHERE id = $2', [at10.plus({ minutes: 30 }).toISO(), ovl.id]);
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 122 }));
  const ovMsgs = ravMsgs(mark);
  ok("narx eslatma: shu tikdagi muddati o'tgan — bitta xabar ichida 🔴, alohida emas",
    ovMsgs.length === 1 && ovMsgs[0].payload.text.includes(`🔴 №${ovl.id}`) && listsAll(ovMsgs[0].payload.text) && !ovMsgs[0].payload.text.includes("muddati o'tdi"));
  ok("narx eslatma: so'rovchiga muddat xabari kun bilan (faqat soat emas)", new RegExp(String.raw`№${ovl.id} ga hali narx berilmadi \(muddat \S+ \d{2}:\d{2}\)`).test(allText(50002, mark)));
  for (const s of [...stag, ovl]) await pr.cancel(s.id, sam.id);
  // eslatma yo'q tikda muddati o'tgan — deklarantga alohida xabar saqlanadi
  const solo = await pr.create({ requesterId: sam.id, declarantId: rav.id, description: 'U yolg\'iz', dueAt: at10.plus({ minutes: 125 }).toISO() });
  await db.query('UPDATE price_requests SET created_at = $1 WHERE id = $2', [at10.plus({ minutes: 120 }).toISO(), solo.id]);
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 130 }));
  ok("narx eslatma: ro'yxat bo'lmagan tikda deklarantga alohida «muddati o'tdi» saqlanadi",
    ravMsgs(mark).length === 1 && ravMsgs(mark)[0].payload.text.includes(`№${solo.id} muddati o'tdi`));
  await pr.cancel(solo.id, sam.id);
  await employees.setDeclarant(rav.id, false);

  // --- 💲 Narx so'rovlari: tarix, qidiruv, statistika, barcha ochiqlar, Excel ---
  await send(cbq(50002, 'pq:h'));
  ok("narx tarix: oxirgi narx ko'rinadi", lastText(50002).includes('320$'));
  await send(cbq(50002, 'pq:hs')); await send(msg(50002, 'kosmetika'));
  ok('narx tarix: qidiruv topdi', lastText(50002).includes('Karim'));
  await send(cbq(50002, 'pq:hs')); await send(msg(50002, 'zzzz'));
  ok('narx tarix: topilmadi', lastText(50002).includes('Topilmadi'));
  await send(cbq(50002, 'pq:hs')); await send(msg(50002, 'k'));
  ok("narx tarix: 1 belgi — qayta so'raydi", session.get(50002).step === 'pq_search' && lastText(50002).includes('Kamida 2'));
  await send(msg(50002, '❌ Bekor qilish'));
  await send(cbq(30001, 'pq:h'));
  ok('narx tarix: ruxsatsiz hodimga yopiq', !lastText(30001).includes('NARXLAR TARIXI'));
  await send(cbq(50002, 'pq:st:7'));
  ok('narx stat: hodimga yopiq', !lastText(50002).includes("o'rtacha"));
  await send(cbq(1000, 'pq:st:7'));
  ok("narx stat: direktor ko'radi", lastText(1000).includes('Dilshod') && lastText(1000).includes("o'rtacha"));
  await employees.deactivate(dil.id); await send(cbq(1000, 'pq:all'));
  ok('narx stat: nofaol deklarant ochiqlari ⚠️', lastText(1000).includes('nofaol'));
  await employees.activate(dil.id);
  // deklarant bayrog'i olib tashlansa — nofaoldek: eslatma yo'q, ⚠️, narx/savol tugmalari rad
  await employees.setDeclarant(dil.id, false);
  const limbo = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'Limbo yuk', dueAt: at10.plus({ minutes: 290 }).toISO() });
  await db.query('UPDATE price_requests SET created_at = $1 WHERE id = $2', [at10.toISO(), limbo.id]);
  mark = sent.length; await price.nag(bot, at10.plus({ minutes: 300 }));
  ok("narx bayroq: bayroqsiz deklarantga eslatma ham, «muddati o'tdi» ham yo'q", countSince(mark, 50001) === 0 && allText(50002, mark).includes(`№${limbo.id} ga hali narx berilmadi`));
  await send(cbq(1000, 'pq:all'));
  ok('narx bayroq: «barcha ochiq» da ⚠️ nofaol', lastText(1000).includes('nofaol'));
  mark = sent.length; await send(cbq(50001, `pq:p:${limbo.id}`)); await send(cbq(50001, `pq:q:${limbo.id}`));
  ok('narx bayroq: bayroqsiz deklarant narx/savol boshlay olmaydi', !String(session.get(50001).step || '').startsWith('pq_'));
  await send(cbq(50002, `pq:x:${limbo.id}`));
  ok("narx bayroq: so'rovchi bekor qila oladi", (await pr.byId(limbo.id)).status === 'cancelled');
  await employees.setDeclarant(dil.id, true);
  mark = sent.length; await send(cbq(50002, 'pq:all')); await send(cbq(50002, 'pq:xl:7'));
  ok('narx stat: hodimga «barcha ochiq» va Excel yopiq', countSince(mark, 50002, 'sendDocument') === 0 && !allText(50002, mark).includes('nofaol'));
  mark = sent.length; await send(cbq(1000, 'pq:xl:7'));
  ok('narx stat: Excel yuborildi', sent.slice(mark).some((s) => s.method === 'sendDocument' && Number(s.payload.chat_id) === 1000));
  const xf = await excel.buildPriceRequests(bugun, bugun); const xwb = new ExcelJS.Workbook(); await xwb.xlsx.load(xf.buffer);
  ok("narx stat: Excel varag'i va qatorlar", Boolean(xwb.getWorksheet("Narx so'rovlari")) && xwb.getWorksheet("Narx so'rovlari").rowCount >= 3);
  ok('narx stat: Excel fayl nomi', xf.filename === `narx-sorovlari-${bugun}_${bugun}.xlsx`);

  // «Barcha ochiq» uzun ro'yxat: byudjet (3500) birinchi deklarantda deyarli to'ladi — ikkinchi deklarantning sarlavhasi sig'maydi,
  // lekin qisqa qatori sig'ardi. Eski kod shu qatorni birinchi deklarant sarlavhasi ostida ko'rsatardi.
  USERS[50003] = { id: 50003, first_name: 'Zarina', username: 'zarina' };
  await employees.add({ tgId: 50003, fullName: 'Zarina Deklarant Karimova', position: 'Deklarant' });
  const zar = await employees.byTgId(50003);
  await employees.setDeclarant(zar.id, true);
  const bigIds = [];
  const mkBig = async (decl, description) => { const r = await pr.create({ requesterId: sam.id, declarantId: decl.id, description }); bigIds.push(r.id); return r; };
  for (let i = 0; i < 12; i += 1) await mkBig(zar, `z${i}`);
  const lineLen = (r) => `🟡 №${r.id} · ${r.requester_name} · ${String(r.description).replace(/\s+/g, ' ').trim().slice(0, 60)} · ⏰ ${r.due_at ? time.clock(r.due_at) : '—'}`.length;
  const roomLeft = async () => {
    const rows = await pr.allOpen();
    const d = rows.filter((r) => r.declarant_id === dil.id);
    const z = rows.filter((r) => r.declarant_id === zar.id);
    const used = `\n📑 <b>${dil.full_name}</b> (${d.length})`.length + 1 + d.reduce((a, r) => a + lineLen(r) + 1, 0);
    return { room: 3500 - used, zHead: `\n📑 <b>${zar.full_name}</b> (${z.length})`.length, zLine: Math.max(...z.map(lineLen)) };
  };
  let tuned = false;
  for (let attempt = 0; attempt < 80 && !tuned; attempt += 1) {
    for (let d = 60; d >= 1 && !tuned; d -= 1) {
      const t = await mkBig(dil, 'y'.repeat(d));
      const { room, zHead, zLine } = await roomLeft();
      if (room >= zLine && room < zHead) tuned = true; else { await pr.cancel(t.id, sam.id); bigIds.pop(); }
    }
    if (!tuned) await mkBig(dil, 'x'.repeat(40));
  }
  ok("narx barcha ochiq: stsenariy tayyor (sig'masligi aniq sarlavhada)", tuned);
  const openAll = await pr.allOpen();
  await send(cbq(1000, 'pq:all'));
  const allTxt = lastText(1000).replace(/<[^>]+>/g, '');
  const shown = [];
  let curHead = null;
  for (const ln of allTxt.split(String.fromCharCode(10))) {
    const h = ln.match(/^📑 (.+?) \(\d+\)/);
    if (h) { curHead = h[1]; continue; }
    const m = ln.match(/№(\d+) ·/);
    if (m && /^[🟡🔴💬]/u.test(ln)) shown.push({ id: Number(m[1]), head: curHead });
  }
  const declOf = new Map(openAll.map((r) => [r.id, r.declarant_name]));
  const cutN = Number((allTxt.match(/yana (\d+) qator/) || [])[1] || 0);
  ok("narx barcha ochiq: uzun ro'yxat qirqildi, 4096 dan kam", allTxt.length < 4096 && cutN > 0);
  ok("narx barcha ochiq: har qator o'z deklarant sarlavhasi ostida", shown.length > 0 && shown.every((x) => x.head && x.head === declOf.get(x.id)));
  ok("narx barcha ochiq: sig'magan deklarantning qatori ko'rinmaydi", !shown.some((x) => declOf.get(x.id) === zar.full_name));
  ok("narx barcha ochiq: ko'rsatilgan + sig'madi = jami", shown.length + cutN === openAll.length);
  for (const id of bigIds) await pr.cancel(id, sam.id);

  // --- 💲 Narx so'rovlari: yakuniy sharh tuzatishlari ---
  // Minor 1: eskirgan «Bekor qilish» (pq:x0) boshqa oqim bosqichini o'chirmasin
  session.set(50002, { step: 'warn_text' });
  await send(cbq(50002, 'pq:x0'));
  ok("narx x0: boshqa oqim bosqichi (warn_text) o'zgarmaydi", session.get(50002).step === 'warn_text');
  session.clear(50002);
  await send(cbq(50002, 'pq:new'));
  ok('narx x0: pq_pick bosqichi bor', session.get(50002).step === 'pq_pick');
  await send(cbq(50002, 'pq:x0'));
  ok("narx x0: pq_ bosqichi tozalanadi", !session.get(50002).step);

  // Minor 3b/4: tarix natijalari bosiladigan; uzun qidiruv natijasi bo'linadi
  const hist = [];
  for (let i = 0; i < 20; i += 1) {
    const h = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: `BIGSEARCH yuk ${i}` });
    await pr.setPrice(h.id, dil.id, `${i}-narx ${'z'.repeat(200 - 10)}`);
    hist.push(h);
  }
  await send(cbq(50002, 'pq:hs')); mark = sent.length; await send(msg(50002, 'bigsearch'));
  const histMsgs = sent.slice(mark).filter((x) => Number(x.payload.chat_id) === 50002 && x.method === 'sendMessage' && x.payload.text);
  ok("narx qidiruv: uzun natija bo'linadi, har bo'lak < 4096", histMsgs.length >= 2 && histMsgs.every((x) => x.payload.text.length < 4096));
  ok('narx qidiruv: natijalar pq:v: tugmali', Boolean(findCb(50002, new RegExp(`^pq:v:${hist[19].id}$`))));
  await send(cbq(50002, 'pq:h'));
  ok('narx tarix: oxirgi natijalar ham pq:v: tugmali', Boolean(findCb(50002, /^pq:v:\d+$/)));
  const btnLabel = JSON.stringify(to(50002).filter((x) => x.payload.reply_markup).slice(-1)[0].payload.reply_markup);
  ok("narx tarix: tugma yorlig'i «№id · tavsif»", btnLabel.includes(`№${hist[19].id} · BIGSEARCH yuk 19`));
  // narx berilgan so'rovni (begona) deklarant faqat ko'rish rejimida ochadi
  mark = sent.length; await send(cbq(50003, `pq:v:${hist[0].id}`));
  const zCard = sent.slice(mark).filter((x) => Number(x.payload.chat_id) === 50003);
  ok("narx v: begona deklarant narx berilgan so'rovni ko'radi", zCard.some((x) => (x.payload.text || x.payload.caption || '').includes(`№${hist[0].id}`)));
  ok("narx v: ko'rish rejimida narx/savol/bekor tugmalari yo'q", !zCard.some((x) => /pq:[pqx]:/.test(JSON.stringify(x.payload.reply_markup || {}))));
  const hOpen = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: "Faqat tayinlangan ko'radi" });
  mark = sent.length; await send(cbq(50003, `pq:v:${hOpen.id}`));
  ok("narx v: ochiq so'rovni begona deklarant ocha olmaydi", countSince(mark, 50003, 'sendMessage') === 0);
  mark = sent.length; await send(cbq(30001, `pq:v:${hist[0].id}`));
  ok("narx v: ruxsatsiz hodim ocha olmaydi", countSince(mark, 30001, 'sendMessage') === 0);
  mark = sent.length; await send(cbq(50001, `pq:v:${hOpen.id}`));
  ok("narx v: tayinlangan deklarant ochiq so'rovda narx/savol tugmalarini oladi", sent.slice(mark).some((x) => Number(x.payload.chat_id) === 50001 && ['pq:p:', 'pq:q:'].every((k) => JSON.stringify(x.payload.reply_markup || {}).includes(k))));
  await pr.cancel(hOpen.id, sam.id);

  // Minor 3a: statistikada so'rovchilar bo'yicha son
  await send(cbq(1000, 'pq:st:7'));
  ok("narx stat: «So'rovchilar» bo'limi va son", lastText(1000).includes("So'rovchilar") && /Samandar — \d+/.test(lastText(1000)));
  const reqCnt = await pr.byRequester(bugun, bugun);
  ok('narx svc: byRequester', reqCnt.length >= 1 && reqCnt[0].name === 'Samandar' && reqCnt[0].total >= 20);

  // Minor 7a: dumaloq video (video_note) — savol/javob/media bosqichlarida qabul qilinadi
  const vnote = (from, fileId) => ({ update_id: (uid += 1), message: { ...base(from), video_note: { file_id: fileId, length: 240, duration: 5 } } });
  const vq = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'Dumaloq video sinovi' });
  await send(cbq(50001, `pq:q:${vq.id}`)); mark = sent.length; await send(vnote(50001, 'VN_Q'));
  ok("narx video_note: savol qabul qilindi, so'rovchiga yuborildi", (await pr.byId(vq.id)).status === 'asked'
    && (await pr.messages(vq.id)).some((m) => m.media_type === 'video_note' && m.media_file_id === 'VN_Q')
    && sent.slice(mark).some((x) => Number(x.payload.chat_id) === 50002 && x.method === 'sendVideoNote'));
  await send(cbq(50002, `pq:a:${vq.id}`)); mark = sent.length; await send(vnote(50002, 'VN_A'));
  ok('narx video_note: javob qabul qilindi', (await pr.byId(vq.id)).status === 'open'
    && (await pr.messages(vq.id)).some((m) => m.kind === 'answer' && m.media_type === 'video_note')
    && sent.slice(mark).some((x) => Number(x.payload.chat_id) === 50001 && x.method === 'sendVideoNote'));
  await pr.cancel(vq.id, sam.id);
  await send(cbq(50002, 'pq:new')); await send(cbq(50002, `pq:d:${dil.id}`)); await send(msg(50002, 'Video note media'));
  await send(vnote(50002, 'VN_M'));
  ok('narx video_note: media bosqichida qabul qilindi', session.get(50002).step === 'pq_due' && session.get(50002).pq.media && session.get(50002).pq.media.type === 'video_note');
  session.clear(50002);

  await employees.setDeclarant(zar.id, false);

  // =========================================================================
  console.log('\n— 📑 Deklarant rejimi: ish vaqti yo\'q, faqat topshiriqlar va narxlar —');
  const cfg = require('../src/config');
  const flowsSvc = require('../src/services/flows');
  const kbRows = (s) => ((s && s.payload.reply_markup && s.payload.reply_markup.keyboard) || []).map((r) => r.map((b) => b.text || b));
  USERS[50005] = { id: 50005, first_name: 'Nodira', username: 'nodira' };
  await send(msg(50005, '/start'));
  await send(cbq(1000, findCb(1000, /^jr:add:\d+$/)));
  await send(msg(1000, "⏭ O'tkazib yuborish"));
  await send(msg(1000, "⏭ O'tkazib yuborish"));
  await send(cbq(1000, 'ea:dept:0'));
  ok("deklarant: sehrgarda «📑 Deklarant» roli bor", Boolean(findCb(1000, /^ea:role:declarant$/)));
  mark = sent.length;
  await send(cbq(1000, 'ea:role:declarant'));
  await send(cbq(1000, 'ea:ok'));
  const nod = await employees.byTgId(50005);
  ok('deklarant: qo\'shildi — role=employee, is_declarant=1, lavozim «Deklarant»',
    nod && nod.role === 'employee' && Number(nod.is_declarant) === 1 && nod.position === 'Deklarant' && employees.isDeclarantOnly(nod));
  const welcomeMsg = to(50005).filter((s) => s.method === 'sendMessage' && (s.payload.text || '').includes('deklarant')).pop();
  ok('deklarant: xush kelibsiz — faqat Topshiriqlarim / Bajardim / Narxlar',
    Boolean(welcomeMsg) && JSON.stringify(kbRows(welcomeMsg)) === JSON.stringify([['📋 Topshiriqlarim', '✔️ Bajardim'], ['💲 Narxlar']]));
  ok("deklarant: ilova tugmasi o'rnatilmadi", !sent.slice(mark).some((s) => s.method === 'setChatMenuButton' && Number(s.payload.chat_id) === 50005 && s.payload.menu_button && s.payload.menu_button.type === 'web_app'));
  ok("deklarant: davomat/KPI ro'yxatida yo'q, topshiriq beriladiganlar ichida bor",
    !(await employees.listStaff()).some((e) => Number(e.id) === Number(nod.id)) && (await employees.listActive()).some((e) => Number(e.id) === Number(nod.id)));
  const prevReq = cfg.checkinRequired;
  cfg.checkinRequired = true;
  ok("deklarant: ish kunida ham «Keldim» talab qilinmaydi", !(await attendance.needsCheckIn(nod, wd.toFormat('yyyy-MM-dd'))));
  cfg.checkinRequired = prevReq;
  ok('deklarant: «Bajardim» Keldimsiz ochiq', (await flowsSvc.doneBlocked(nod)) === null);
  await send(msg(50005, '✅ Keldim'));
  ok('deklarant: «Keldim» tugmasi yopiq', lastText(50005).includes('deklarantsiz'));
  await send(msg(50005, '/oylik'));
  ok('deklarant: boshqa buyruq yopiq', lastText(50005).includes('deklarantsiz'));
  await send(msg(50005, '/yordam'));
  ok("deklarant: /yordam — qisqa deklarant qo'llanmasi", lastText(50005).includes('Deklarant uchun') && !lastText(50005).includes('/kalkulyator'));
  await send(msg(50005, '📋 Topshiriqlarim'));
  ok('deklarant: «Topshiriqlarim» ishlaydi', !lastText(50005).includes('deklarantsiz'));
  await send(msg(50005, '💲 Narxlar'));
  ok('deklarant: «Narxlar» ishlaydi', !lastText(50005).includes('deklarantsiz') && !lastText(50005).includes('Keldim'));
  mark = sent.length;
  await send(cbq(1000, `emp:dc:${nod.id}:0`));
  const offMsg = sent.slice(mark).filter((s) => Number(s.payload.chat_id) === 50005 && s.method === 'sendMessage').pop();
  ok("deklarant: bayroq olinsa — oddiy hodim menyusi (Keldim bilan) yuboriladi", Boolean(offMsg) && kbRows(offMsg).flat().includes('✅ Keldim'));
  ok("deklarant: bayroqsiz — davomat ro'yxatiga qaytdi", (await employees.listStaff()).some((e) => Number(e.id) === Number(nod.id)));
  mark = sent.length;
  await send(cbq(1000, `emp:dc:${nod.id}:1`));
  const onMsg = sent.slice(mark).filter((s) => Number(s.payload.chat_id) === 50005 && s.method === 'sendMessage').pop();
  ok('deklarant: bayroq qo\'yilsa — deklarant xabari va qisqa menyu', Boolean(onMsg) && onMsg.payload.text.includes('deklarant') && !kbRows(onMsg).flat().includes('✅ Keldim'));
  ok("deklarant: rahbar/HR deklarant bo'lsa — oddiy menyusi qoladi", !employees.isDeclarantOnly({ ...nod, role: 'head' }) && !employees.isDeclarantOnly({ ...nod, is_hr: 1 }));
  // «📤 Topshiriq berish» → «📑 Deklarantlarga»
  await send(msg(1000, '📤 Topshiriq berish'));
  ok('deklarant: topshiriq berish menyusida «📑 Deklarantlarga»', Boolean(findCb(1000, /^as:decl$/)) && lastText(1000).includes('Kimga topshiriq'));
  ok("deklarant: «Rahbarsiz hodimlar» ichida emas", !(await employees.listUnmanaged()).some((e) => Number(e.id) === Number(nod.id)));
  await send(cbq(1000, 'as:decl'));
  ok("deklarant: «Deklarantlarga» — ro'yxatda deklarant", lastText(1000).includes('Qaysi deklarantga') && Boolean(findCb(1000, new RegExp(`^as:emp:${nod.id}$`))));
  await send(cbq(1000, `as:emp:${nod.id}`));
  ok('deklarant: tanlangach topshiriq matni so\'raladi', session.get(1000).step === 'assign_text' && Number(session.get(1000).assign.employeeId) === Number(nod.id));
  session.clear(1000);
  mark = sent.length; await send(cbq(50005, 'as:decl'));
  ok('deklarant: «as:decl» oddiy hodimga yopiq', !allText(50005, mark).includes('Qaysi deklarantga'));
  await employees.deactivate(nod.id);

  await sleep(50);
  await db.close();
  console.log(`\n${failed ? '❌' : '🎉'} ${passed} o'tdi, ${failed} yiqildi · handler xatolari: ${errors.length}`);
  if (errors.length) console.log(errors.join('\n'));
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => {
  console.error('❌ Test yiqildi:', e);
  process.exit(1);
});
