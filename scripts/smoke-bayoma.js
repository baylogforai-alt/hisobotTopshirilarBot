'use strict';
/**
 * BAYOMA DAN KO'CHIRILGAN TEKSHIRUV (2-okt-2026) — BAYOMA'ning 504 ta tekshiruvi, BAYOMA sozlamalari bilan
 * (Keldim videosi, oy boshi, shartli KPI, majburiy isbot). BayLog standart sozlamalari — scripts/smoke.js da.
 * Tugma matnlari BayLog nomlariga avtomatik o'giriladi (pastda LABELS).
 * Ishlatish:  npm run test:bayoma   (npm test ikkalasini ham ishlatadi)
 *
 * OFLAYN TEKSHIRUV — Telegram'ga ham, Postgres'ga ham tegmaydi.
 * Vaqtinchalik SQLite faylida ishlaydi; Telegram API `Telegram.prototype.callApi` stub orqali soxtalashtiriladi,
 * shuning uchun butun oqim (so'rov → qo'shish → topshiriq → bajardi → tekshiruv → KPI) haqiqiy handlerlar orqali o'tadi.
 * Ishlatish:  npm test
 */
process.env.BOT_TOKEN = 'test:token';
process.env.DATABASE_URL = '';
process.env.SUPABASE_DB_PASSWORD = '';
process.env.DB_PATH = './data/smoke-bayoma.db';
// BAYOMA xatti-harakati (BayLog standartlari boshqacha — smoke.js)
process.env.OFFICE_CHECKIN_VIDEO = 'true';
process.env.MONTH_START_REQUIRED = 'true';
process.env.KPI_MODE = 'gate';
process.env.PROOF_REQUIRED = '1';
process.env.REMINDER_INTERVAL_HOURS = '3';
process.env.OFFICE_RADIUS_M = '300';
process.env.ANNOUNCE_DONE = '0';
process.env.DAILY_REPORT_REQUIRED = '0';
process.env.COMPANY_NAME = 'BAYOMA';
process.env.BOSS_NAME = 'Odilxon';
process.env.CRM_API_SECRET = '';
process.env.GROUP_CHAT_ID = '';
process.env.ADMIN_IDS = '1000';
process.env.WORK_START = '09:00';
process.env.WORK_END_HOUR = '18';
process.env.LATE_GRACE_MINUTES = '10';
process.env.WORK_DAYS = '1-6';

const fs = require('fs');
for (const f of ['./data/smoke-bayoma.db', './data/smoke-bayoma.db-wal', './data/smoke-bayoma.db-shm']) fs.rmSync(f, { force: true });

const { Telegram } = require('telegraf');
const ExcelJS = require('exceljs');

// ---------------------------------------------------------------------------
// Soxta Telegram API
// ---------------------------------------------------------------------------
const sent = [];
let mid = 100;
Telegram.prototype.callApi = async function callApi(method, payload = {}) {
  sent.push({ method, payload });
  if (method === 'getMe') return { id: 1, is_bot: true, username: 'bayoma_test_bot', first_name: 'Test' };
  if (method === 'sendMessage') return { message_id: (mid += 1), chat: { id: payload.chat_id, type: 'private' }, text: payload.text, date: 0 };
  if (method === 'editMessageText') return { message_id: payload.message_id, chat: { id: payload.chat_id, type: 'private' }, text: payload.text, date: 0 };
  if (method === 'editMessageCaption') return { message_id: payload.message_id, chat: { id: payload.chat_id, type: 'private' }, caption: payload.caption, date: 0 };
  if (['sendPhoto', 'sendVideo', 'sendDocument', 'sendVideoNote', 'sendVoice', 'sendAudio'].includes(method)) return { message_id: (mid += 1), chat: { id: payload.chat_id, type: 'private' }, date: 0 };
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
const branches = require('../src/services/branches');
const months = require('../src/services/months');
const visits = require('../src/services/visits');
const config = require('../src/config');
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
  99999: { id: 99999, first_name: 'Akbar', last_name: 'Karimov', username: 'akbar' },
  40001: { id: 40001, first_name: 'Jasur', username: 'jasur' },
  50001: { id: 50001, first_name: 'Abbos', username: 'abbos' },
};
let uid = 1;
const base = (from) => ({ message_id: (mid += 1), from: USERS[from], chat: { id: from, type: 'private' }, date: Math.floor(Date.now() / 1000) });
// BAYOMA tugma nomlari → BayLog nomlari
const LABELS = {
  '✅ Keldim': '✅ Ishga keldim',
  '🏁 Ketdim': '🏁 Ishdan ketdim',
  '📋 Topshiriqlarim': '📋 Missiyalarim',
  "➕ O'zimga vazifa": "➕ Missiya qo'shish",
};
const label = (t) => LABELS[t] || t;
const msg = (from, rawText) => {
  const text = label(rawText);
  return {
    update_id: (uid += 1),
    message: { ...base(from), text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) },
  };
};
const loc = (from, latitude, longitude) => ({ update_id: (uid += 1), message: { ...base(from), location: { latitude, longitude } } });
const photo = (from, caption) => ({ update_id: (uid += 1), message: { ...base(from), photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'BIG_FILE_ID', width: 800, height: 600 }], caption } });
const videoNote = (from) => ({ update_id: (uid += 1), message: { ...base(from), video_note: { file_id: 'VN_FILE_ID', length: 240, duration: 5 } } });
const video = (from, caption) => ({ update_id: (uid += 1), message: { ...base(from), video: { file_id: 'VIDEO_FILE_ID', width: 640, height: 480, duration: 7 }, ...(caption ? { caption } : {}) } });
const voice = (from) => ({ update_id: (uid += 1), message: { ...base(from), voice: { file_id: 'VOICE_FILE_ID', duration: 4 } } });
const groupMsg = (from, chatId, text) => ({
  update_id: (uid += 1),
  message: { message_id: (mid += 1), from: USERS[from], chat: { id: chatId, type: 'supergroup', title: 'Arxiv' }, date: Math.floor(Date.now() / 1000), text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] },
});
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
/** Oxirgi xabarlardan callback_data ni regex bo'yicha topadi */
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

(async () => {
  await db.init();
  await require('../src/services/worktime').load();
  const bot = createBot();
  const send = (u) => bot.handleUpdate(u);
  const bugun = time.today();
  const month = time.month();

  // =========================================================================
  console.log('\n— 1. Ro\'yxatda yo\'q odam —');
  await send(msg(99999, '/start'));
  ok('begonaga ID ko\'rsatildi', lastText(99999).includes('99999') && lastText(99999).includes("ro'yxatda yo'q"));
  ok('direktorga so\'rov keldi', lastText(1000).includes('Yangi odam') && findCb(1000, /^jr:add:\d+$/));
  ok('so\'rov bazada pending', Boolean(await requests.pendingOf(99999)));
  let mark = sent.length;
  await send(msg(99999, 'salom, meni qo\'shing'));
  ok('begona matn yozsa — yana faqat ID, direktorga ikkinchi xabar yo\'q', lastText(99999).includes('99999') && countSince(mark, 1000) === 0);
  mark = sent.length;
  await send(cbq(99999, 'done:list'));
  ok('begona tugma bossa — alert, hech narsa ochilmaydi', countSince(mark, 99999, 'sendMessage') === 0 && sent.slice(mark).some((s) => s.method === 'answerCallbackQuery' && s.payload.show_alert));
  await send(msg(99999, '/panel'));
  ok('begona /panel — ochilmaydi', !lastText(99999).includes('PANEL'));

  // =========================================================================
  console.log('\n— 2. Direktor so\'rovdan hodim qo\'shadi —');
  await send(msg(1000, '/start'));
  ok('direktor (.env) /start ishlaydi', lastText(1000).includes('Direktor'));
  const jrAdd = findCb(1000, /^jr:add:\d+$/);
  await send(cbq(1000, jrAdd));
  ok('ism so\'raldi (TG ismi taklif qilindi)', lastText(1000).includes('Akbar Karimov'));
  await send(msg(1000, "⏭ O'tkazib yuborish"));
  ok('lavozim so\'raldi', lastText(1000).includes('Lavozim'));
  await send(msg(1000, 'Buxgalter'));
  ok('bo\'lim so\'raldi', lastText(1000).includes("Qaysi bo'limga") && findCb(1000, /^ea:dept:new$/));
  await send(cbq(1000, 'ea:dept:new'));
  await send(msg(1000, 'Buxgalteriya'));
  ok('bo\'lim yaratildi', Boolean(await departments.byName('Buxgalteriya')) && lastText(1000).includes('Roli'));
  await send(cbq(1000, 'ea:role:employee'));
  ok('tasdiqlash ko\'rsatildi', lastText(1000).includes('Tekshiring') && lastText(1000).includes('Buxgalter'));
  await send(cbq(1000, 'ea:ok'));
  const akbar = await employees.byTgId(99999);
  ok('hodim qo\'shildi (bo\'lim + lavozim)', akbar && akbar.department_name === 'Buxgalteriya' && akbar.position === 'Buxgalter' && akbar.role === 'employee');
  ok('so\'rov yopildi', !(await requests.pendingOf(99999)));
  ok('hodimga xush kelibsiz keldi', lastText(99999).includes('Xush kelibsiz'));
  await send(msg(99999, '/start'));
  ok('endi hodim /start ishlaydi', lastText(99999).includes('Salom') && lastText(99999).includes('Akbar'));

  // =========================================================================
  console.log('\n— 3. Boshliq va ikkinchi hodim (/hodim_qosh) —');
  await send(msg(1000, '/hodim_qosh 20001'));
  await send(msg(1000, 'Bobur Rahimov'));
  await send(msg(1000, 'Bosh buxgalter'));
  const buxId = (await departments.byName('Buxgalteriya')).id;
  await send(cbq(1000, `ea:dept:${buxId}`));
  await send(cbq(1000, 'ea:role:head'));
  await send(cbq(1000, 'ea:ok'));
  const bobur = await employees.byTgId(20001);
  ok('boshliq qo\'shildi', bobur && bobur.role === 'head' && Number(bobur.department_id) === buxId);

  await send(msg(1000, '/hodim_qosh 30001'));
  await send(msg(1000, 'Sardor Aliyev'));
  await send(msg(1000, 'Kassir'));
  await send(cbq(1000, `ea:dept:${buxId}`));
  await send(cbq(1000, 'ea:role:employee'));
  await send(cbq(1000, 'ea:ok'));
  const sardor = await employees.byTgId(30001);
  ok('ikkinchi hodim qo\'shildi', sardor && sardor.role === 'employee');
  ok('reviewersOf(hodim) = boshliq + direktor', (await employees.reviewersOf(akbar)).includes(20001) && (await employees.reviewersOf(akbar)).includes(1000));
  ok('reviewersOf(boshliq) = faqat direktor', JSON.stringify(await employees.reviewersOf(bobur)) === '[1000]');

  // =========================================================================
  console.log('\n— 4. Ofis va GPS davomat —');
  await send(cbq(1000, 'adm:office'));
  await send(loc(1000, 41.3111, 69.2797));
  ok('ofis saqlandi', Boolean(await office.get()) && lastText(1000).includes('saqlandi'));

  await send(groupMsg(1000, -100777, '/arxiv_ulash'));
  ok('arxiv guruhi ulandi', Number(await require('../src/services/notify').getArchiveId()) === -100777);

  await send(msg(99999, '✅ Keldim'));
  ok('oy boshi tasdiqlanmagan — Keldim yopiq, tasdiqlash tugmasi', lastText(99999).includes('yangi ish oyi') && findCb(99999, /^ms:ok:\d{4}-\d{2}$/));
  await send(cbq(99999, `ms:ok:${month}`));
  ok('oy boshi tasdiqlandi — hisob boshlandi', (await months.isConfirmed(akbar.id)) && to(99999).some((s) => (s.payload.text || '').includes('Oy hisobi boshlandi')));

  await send(msg(99999, '✅ Keldim'));
  ok('joylashuv so\'raldi', lastText(99999).includes('Joylashuvni yuborish'));
  await send(loc(99999, 41.35, 69.35));
  ok('uzoqdan — rad etildi', lastText(99999).includes('uzoqdasiz') && !(await attendance.isCheckedIn(akbar.id)));
  await send(msg(99999, '✅ Keldim'));
  await send(loc(99999, 41.3112, 69.2798));
  ok('ofisdan — endi video so\'raldi (hali qayd etilmadi)', lastText(99999).includes('video') && !(await attendance.isCheckedIn(akbar.id)));
  await send(photo(99999, 'rasm'));
  ok('rasm qabul qilinmaydi — video kerak', lastText(99999).includes('Video kerak') && !(await attendance.isCheckedIn(akbar.id)));
  mark = sent.length;
  await send(videoNote(99999));
  ok('dumaloq video bilan — qabul qilindi', (await attendance.isCheckedIn(akbar.id)) && lastText(99999).match(/qayd etildi|kech keldingiz/));
  const attA = await attendance.get(akbar.id);
  ok('davomatda video va rejim saqlandi', attA.checkin_proof_type === 'video_note' && attA.checkin_proof_file_id === 'VN_FILE_ID' && attA.checkin_mode === 'office');
  ok('boshliqqa video + matn bordi', sent.slice(mark).some((s) => s.method === 'sendVideoNote' && Number(s.payload.chat_id) === 20001));
  ok('arxivga video nusxasi bordi', sent.slice(mark).some((s) => s.method === 'sendVideoNote' && Number(s.payload.chat_id) === -100777));
  const s9999 = session.get(99999);
  if (s9999.step === 'late_reason') { await send(msg(99999, "Yo'lda tirbandlik")); ok('kechikish sababi qabul qilindi', (await attendance.get(akbar.id)).late_reason === "Yo'lda tirbandlik"); }
  ok('boshliqqa "keldi" xabari', to(20001).some((s) => (s.payload.text || '').includes('keldi')));
  await send(msg(99999, '✅ Keldim'));
  ok('ikkinchi marta — allaqachon', lastText(99999).includes('allaqachon'));
  ok('9:05 kech emas, 9:25 → 25 daq', attendance.lateMinutesOf(`${bugun}T09:05:00+05:00`) === 0 && attendance.lateMinutesOf(`${bugun}T09:25:00+05:00`) === 25);

  // =========================================================================
  console.log('\n— 5. Boshliq topshiriq beradi —');
  await send(msg(20001, '📤 Topshiriq berish'));
  ok('boshliqqa o\'z bo\'limi hodimlari ko\'rsatildi', findCb(20001, new RegExp(`^as:emp:${akbar.id}$`)) && findCb(20001, new RegExp(`^as:emp:${sardor.id}$`)));
  ok('boshliq ro\'yxatida o\'zi yo\'q', !findCb(20001, new RegExp(`^as:emp:${bobur.id}$`)));
  await send(cbq(20001, `as:emp:${akbar.id}`));
  await send(msg(20001, '!Oylik hisobotni tayyorlash\nBank ko\'chirmasini solishtirish'));
  ok('muddat tugmalari', findCb(20001, /^as:due:0$/));
  await send(cbq(20001, 'as:due:0'));
  let open = await tasks.openFor(akbar.id);
  ok('2 ta topshiriq yaratildi, muhim birinchi', open.length === 2 && open[0].priority === 'high' && open[0].source === 'head');
  ok('hodimga xabar bordi', lastText(99999).includes('Yangi topshiriq'));
  ok('direktorga nusxa bordi', lastText(1000).includes('Bobur') && lastText(1000).includes('2 ta topshiriq'));

  // direktor boshqa bo'lim hodimiga ham bera oladi; boshliq boshqa bo'limga bera olmaydi
  await send(msg(1000, '📤 Topshiriq berish'));
  ok('direktor avval bo\'lim tanlaydi', findCb(1000, /^as:dept:0$/));
  await send(cbq(1000, 'as:dept:0'));
  await send(cbq(1000, `as:emp:${bobur.id}`));
  await send(msg(1000, 'Chorak hisobotini topshirish'));
  await send(cbq(1000, 'as:due:3'));
  ok('direktor boshliqqa topshiriq berdi', (await tasks.openFor(bobur.id)).length === 1 && (await tasks.openFor(bobur.id))[0].due_date === time.addDays(bugun, 3));

  // =========================================================================
  console.log('\n— 6. Hodim o\'ziga vazifa —');
  await send(msg(99999, "➕ O'zimga vazifa"));
  await send(msg(99999, '1. Kassani tekshirish\n2. Hisob-fakturalar'));
  await send(cbq(99999, 'st:due:1'));
  open = await tasks.openFor(akbar.id);
  ok('2 ta o\'z vazifasi qo\'shildi (ertaga)', open.length === 4 && open.filter((t) => t.source === 'self').length === 2);
  await send(msg(99999, '📋 Topshiriqlarim'));
  ok('topshiriqlarim ro\'yxati', lastText(99999).includes('MISSIYALARIM') && lastText(99999).includes('Oylik hisobot'));
  const selfTask = open.find((t) => t.source === 'self');
  const headTask = open.find((t) => t.source === 'head' && t.priority === 'high');
  await send(cbq(99999, `tk:${headTask.id}`));
  ok('boshliq bergan ishni hodim tahrirlay olmaydi', lastText(99999).includes('🔒'));
  await send(cbq(99999, `tk:${selfTask.id}`));
  ok('o\'z vazifasini tahrirlay oladi', findCb(99999, new RegExp(`^tk:edit:${selfTask.id}$`)));
  ok('hodim menyusida «Bekor qilish» yo\'q', !JSON.stringify(to(99999).slice(-1)[0].payload.reply_markup || {}).includes(`tk:del:${selfTask.id}`));
  await send(cbq(99999, `tk:del:${selfTask.id}`));
  await send(cbq(99999, `tk:delok:${selfTask.id}`));
  ok('hodim o\'z vazifasini o\'chira olmaydi', (await tasks.byId(selfTask.id)).status === 'active');
  await send(cbq(1000, `emp:tdel:${selfTask.id}`));
  ok('direktor bekor qildi — yozuv qoladi, kim bekor qilgani yozildi', (await tasks.byId(selfTask.id)).status === 'cancelled' && Number((await tasks.byId(selfTask.id)).cancelled_by) === 1000);

  // =========================================================================
  console.log('\n— 7. Bajardim (rasm bilan) → tekshiruv —');
  await send(msg(99999, '✔️ Bajardim'));
  ok('bajardim ro\'yxati', findCb(99999, new RegExp(`^done:${headTask.id}$`)));
  await send(cbq(99999, `done:${headTask.id}`));
  ok('isbot so\'raldi (majburiy)', lastText(99999).includes('Isbot majburiy') && !findCb(99999, /^done:noproof$/));
  mark = sent.length;
  await send(photo(99999, 'Mana hisobot'));
  let t = await tasks.byId(headTask.id);
  ok('done + isbot saqlandi', t.status === 'done' && t.proof_file_id === 'BIG_FILE_ID' && t.proof_note === 'Mana hisobot');
  ok('boshliqqa rasm + qabul/qaytarish tugmalari', sent.slice(mark).some((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 20001 && s.payload.photo === 'BIG_FILE_ID' && JSON.stringify(s.payload.reply_markup).includes(`rv:ok:${headTask.id}`)));
  ok('direktorga ham bordi', sent.slice(mark).some((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 1000));

  await send(msg(20001, '🔎 Tekshiruv'));
  ok('tekshiruv ro\'yxatida 1 ta', lastText(20001).includes('TEKSHIRUV (1)'));
  await send(cbq(30001, `rv:ok:${headTask.id}`));
  ok('boshqa hodim qabul qila olmaydi', (await tasks.byId(headTask.id)).status === 'done');
  await send(cbq(20001, `rv:ok:${headTask.id}`, { message_id: 5, chat: { id: 20001, type: 'private' }, photo: [{ file_id: 'x' }], caption: 'c', date: 0 }));
  t = await tasks.byId(headTask.id);
  ok('boshliq qabul qildi (rasm captioni tahrirlandi)', t.status === 'accepted' && sent.some((s) => s.method === 'editMessageCaption'));
  ok('hodimga "qabul qilindi"', lastText(99999).includes('Qabul qilindi'));
  ok('muddatida bajarilgan', tasks.isOnTime(t));

  // qaytarish
  const t2 = (await tasks.openFor(akbar.id)).find((x) => x.source === 'head');
  await send(msg(99999, '✔️ Bajardim'));
  await send(cbq(99999, `done:${t2.id}`));
  await send(cbq(99999, 'done:noproof'));
  ok('isbotsiz — qabul qilinmaydi', (await tasks.byId(t2.id)).status === 'active');
  await send(msg(99999, 'bajardim'));
  ok('matn ham isbot emas', (await tasks.byId(t2.id)).status === 'active' && lastText(99999).includes('Isbot majburiy'));
  await send(voice(99999));
  ok('ovozli xabar bilan done', (await tasks.byId(t2.id)).status === 'done' && (await tasks.byId(t2.id)).proof_type === 'voice');
  await send(cbq(20001, `rv:back:${t2.id}`));
  ok('qaytarish izohi so\'raldi', lastText(20001).includes('nima uchun'));
  await send(msg(20001, 'Raqamlar mos kelmayapti'));
  t = await tasks.byId(t2.id);
  ok('qaytarildi → active, returned_count=1, izoh', t.status === 'active' && Number(t.returned_count) === 1 && t.review_note === 'Raqamlar mos kelmayapti');
  ok('hodimga qaytarish xabari', lastText(99999).includes('Qaytarildi') && lastText(99999).includes('Raqamlar'));

  // =========================================================================
  console.log('\n— 8. Kelmayman (sababli kun) —');
  await send(msg(30001, '🙋 Kelmayman (sabab)'));
  await send(msg(30001, 'Kasal bo\'ldim'));
  let att = await attendance.get(sardor.id);
  ok('so\'rov pending', att && att.excuse_status === 'pending' && att.excuse_reason === "Kasal bo'ldim");
  const abOk = findCb(1000, /^ab:ok:\d+$/);
  ok('boshliqqa (rahbariyat) sababli/sababsiz tugmalari', Boolean(abOk));
  ok('bo\'lim rahbariga — faqat xabar, tugmasiz', to(20001).slice(-1)[0].payload.text.includes('kelmasligini') && !JSON.stringify(to(20001).slice(-1)[0].payload.reply_markup || {}).includes('ab:ok'));
  await send(cbq(99999, abOk));
  ok('oddiy hodim tasdiqlay olmaydi', (await attendance.get(sardor.id)).excuse_status === 'pending');
  await send(cbq(20001, abOk));
  ok('bo\'lim rahbari ham tasdiqlay olmaydi', (await attendance.get(sardor.id)).excuse_status === 'pending');
  await send(cbq(1000, abOk));
  att = await attendance.get(sardor.id);
  ok('boshliq tasdiqladi → approved', att.excuse_status === 'approved' && Number(att.excuse_by) === 1000);
  ok('hodimga tasdiq xabari', lastText(30001).includes('sababli'));
  ok('dayStatus = excused', attendance.dayStatus(att, bugun) === 'excused');

  // direktor to'g'ridan-to'g'ri sababli belgilaydi (kecha)
  let kecha = time.addDays(bugun, -1);
  while (!time.isWorkDay(kecha)) kecha = time.addDays(kecha, -1); // oxirgi ish kuni (yakshanba bo'lsa 'off' ustun)
  await send(cbq(1000, `emp:excuse:${akbar.id}`));
  await send(msg(1000, kecha));
  await send(msg(1000, "Ta'til"));
  ok('direktor sababli kun belgiladi', (await attendance.get(akbar.id, kecha)).excuse_status === 'approved');

  // =========================================================================
  console.log('\n— 9. Statistika va KPI hisob-kitobi —');
  const { from, to: toDate } = time.monthRange(month);
  const ts = await tasks.stats(akbar.id, from, toDate);
  ok('tasks.stats: total 2, ontime 1, 1 qaytarish → 50% − 5% = 45%', ts.total === 2 && ts.ontime === 1 && ts.open === 1 && ts.returns === 1 && ts.rawPct === 50 && ts.penalty === 5 && ts.pct === 45, JSON.stringify(ts));
  const at = await attendance.stats(akbar, kecha < from ? kecha : from, toDate); // oy boshida «kecha» o'tgan oyda bo'ladi
  ok('attendance.stats: excused ≥1, ish kuni ≥0', at.excused >= 1 && at.workDays >= 0 && Number.isFinite(at.pct), JSON.stringify(at));

  ok('parseWeights ok', JSON.stringify(departments.parseWeights('50 20 30 0')) === JSON.stringify({ w_tasks: 50, w_attendance: 20, w_head: 30, w_custom: 0 }));
  ok('parseWeights yig\'indi 100 emas → null', departments.parseWeights('50 20 30 10') === null);
  ok('computeTotal: hammasi bor', kpi.computeTotal({ tasks_pct: 80, att_pct: 100, head_score: 8, custom_pct: 50, w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 }) === 78);
  ok('computeTotal: boshliq bahosi yo\'q → qayta normallashtirish', kpi.computeTotal({ tasks_pct: 80, att_pct: 100, head_score: null, custom_pct: 50, w_tasks: 40, w_attendance: 20, w_head: 20, w_custom: 20 }) === Math.round((80 * 40 + 100 * 20 + 50 * 20) / 80));
  ok('computeTotal: custom vazni 0 → e\'tiborsiz', kpi.computeTotal({ tasks_pct: 100, att_pct: 100, head_score: 10, custom_pct: null, w_tasks: 50, w_attendance: 20, w_head: 30, w_custom: 0 }) === 100);
  ok('bonusOf', kpi.bonusOf(1000000, 78) === 780000 && kpi.bonusOf(null, 78) === null);
  ok('KPI sharti: hammasi joyida (sababli kun zarar qilmaydi)', kpi.checkGate({ missed: 0 }, { late: 0, absent: 0, excused: 2 }).eligible === true);
  ok('KPI sharti: 1 marta kech → berilmaydi', !kpi.checkGate({ missed: 0 }, { late: 1, absent: 0, excused: 0 }).eligible && kpi.checkGate({ missed: 0 }, { late: 1, absent: 0, excused: 0 }).reasons[0].includes('kech'));
  ok('KPI sharti: 1 topshiriq kech → berilmaydi', !kpi.checkGate({ missed: 1 }, { late: 0, absent: 0, excused: 0 }).eligible);
  ok('KPI sharti: oy boshi tasdiqlanmagan → berilmaydi', !kpi.checkGate({ missed: 0 }, { late: 0, absent: 0, excused: 0 }, { monthConfirmed: false }).eligible);
  ok('bonusFor gate: shart bor → to\'liq, yo\'q → 0', kpi.bonusFor({ bonus_fund: 1000000, kpi_eligible: 1, total: 40 }) === 1000000 && kpi.bonusFor({ bonus_fund: 1000000, kpi_eligible: 0, total: 99 }) === 0 && kpi.bonusFor({ bonus_fund: null, kpi_eligible: 1 }) === null);

  const k0 = await kpi.compute(akbar, month);
  ok('kpi.compute draft (jarima bilan 45%, qaytarish 1)', k0 && k0.status === 'draft' && k0.tasks_pct === 45 && Number(k0.tasks_returned) === 1 && k0.head_score === null);

  // alohida ish boshlanish vaqti
  ok('parseWorkStart', employees.parseWorkStart('10:00') === '10:00' && employees.parseWorkStart('9.30') === '09:30' && employees.parseWorkStart('8') === '08:00' && employees.parseWorkStart('25:00') === null);
  await send(cbq(1000, `emp:start:${akbar.id}`));
  await send(msg(1000, '10:00'));
  const akbar10 = await employees.byId(akbar.id);
  ok('hodimga 10:00 ish boshlanishi saqlandi', akbar10.work_start === '10:00' && lastText(1000).includes('10:00'));
  ok('10:05 — 10:00 li hodim uchun kech emas; 9:00 li uchun 65 daq', attendance.lateMinutesOf(`${bugun}T10:05:00+05:00`, akbar10) === 0 && attendance.lateMinutesOf(`${bugun}T10:05:00+05:00`, akbar) === 65);
  ok('10:25 → 10:00 li hodim 25 daq kech', attendance.lateMinutesOf(`${bugun}T10:25:00+05:00`, akbar10) === 25);
  await send(cbq(1000, `emp:start:${akbar.id}`));
  await send(msg(1000, 'standart'));
  ok('standartga qaytdi', (await employees.byId(akbar.id)).work_start === null);

  // =========================================================================
  console.log('\n— 10. Boshliq baholaydi, direktor tasdiqlaydi —');
  await send(msg(20001, '⭐ Baholash'));
  await send(cbq(20001, `hs:m:${month}`));
  ok('baholash ro\'yxati (o\'zi yo\'q)', findCb(20001, new RegExp(`^hs:e:${akbar.id}:`)) && !findCb(20001, new RegExp(`^hs:e:${bobur.id}:`)));
  await send(cbq(20001, `hs:e:${akbar.id}:${month}`));
  await send(cbq(20001, `hs:s:${akbar.id}:${month}:8`));
  await send(msg(20001, 'Tartibli, lekin sekin'));
  let k = await kpi.get(akbar.id, month);
  ok('boshliq bahosi 8 + izoh', Number(k.head_score) === 8 && k.head_note === 'Tartibli, lekin sekin');

  await send(cbq(20001, `kpi:m:${month}`));
  ok('boshliq KPI bo\'limiga kira olmaydi', !lastText(20001).includes('KPI —'));

  await send(cbq(1000, `emp:fund:${akbar.id}`));
  await send(msg(1000, '1 000 000'));
  ok('bonus fondi saqlandi', Number((await employees.byId(akbar.id)).bonus_fund) === 1000000);

  await send(msg(1000, '💰 KPI'));
  await send(cbq(1000, `kpi:m:${month}`));
  ok('KPI oy ro\'yxati', lastText(1000).includes('KPI —') && findCb(1000, new RegExp(`^kpi:e:${akbar.id}:`)));
  await send(cbq(1000, `kpi:e:${akbar.id}:${month}`));
  ok('KPI kartochkasi', lastText(1000).includes('Boshliq bahosi: 8/10') && lastText(1000).includes('KPI summasi: 1 000 000'));
  await send(cbq(1000, `kpi:custom:${akbar.id}:${month}`));
  await send(msg(1000, '90'));
  k = await kpi.get(akbar.id, month);
  ok('mezon 90% saqlandi, total qayta hisoblandi, KPI summasi shartga qarab', Number(k.custom_pct) === 90 && k.total === kpi.computeTotal(k) && k.bonus_amount === (Number(k.kpi_eligible) === 1 ? 1000000 : 0));
  await send(cbq(1000, `kpi:note:${akbar.id}:${month}`));
  await send(msg(1000, 'Yaxshi oy'));
  await send(cbq(1000, `kpi:ok:${akbar.id}:${month}`));
  k = await kpi.get(akbar.id, month);
  ok('tasdiqlandi', k.status === 'confirmed' && Number(k.decided_by) === 1000);
  ok('hodimga KPI natijasi + bonus keldi', lastText(99999).includes('KPI natijangiz') && lastText(99999).includes("so'm") && lastText(99999).includes('Yaxshi oy'));
  const kAfter = await kpi.compute(akbar, month);
  ok('tasdiqlangan qator qayta hisoblanmaydi', kAfter.total === k.total && kAfter.status === 'confirmed');

  await send(cbq(1000, `kpi:e:${sardor.id}:${month}`));
  await send(cbq(1000, `kpi:ex:${sardor.id}:${month}`));
  await send(msg(1000, 'Intizom buzilishi'));
  k = await kpi.get(sardor.id, month);
  ok('bonusdan chiqarildi (izoh bilan)', k.status === 'excluded' && k.note === 'Intizom buzilishi');
  ok('hodimga chiqarilgani haqida xabar', lastText(30001).includes('chiqarildingiz'));
  await send(cbq(1000, `kpi:reopen:${sardor.id}:${month}`));
  ok('qayta ochildi', (await kpi.get(sardor.id, month)).status === 'draft');
  mark = sent.length;
  await send(cbq(1000, `kpi:xl:${month}`));
  ok('KPI Excel yuborildi', sent.slice(mark).some((s) => s.method === 'sendDocument' && Number(s.payload.chat_id) === 1000));

  // =========================================================================
  console.log('\n— 11. Bo\'lim vaznlari —');
  await send(cbq(1000, `dp:${buxId}`));
  ok('bo\'lim kartochkasi', lastText(1000).includes('Buxgalteriya') && lastText(1000).includes('40%'));
  await send(cbq(1000, `dp:w:${buxId}`));
  await send(msg(1000, '50 20 30 10'));
  ok('noto\'g\'ri yig\'indi rad etildi', lastText(1000).includes('100'));
  await send(msg(1000, '50 20 30 0'));
  const d = await departments.byId(buxId);
  ok('vaznlar saqlandi', Number(d.w_tasks) === 50 && Number(d.w_custom) === 0);
  await send(cbq(1000, `dp:custom:${buxId}`));
  await send(msg(1000, 'Hisobotlar o\'z vaqtida'));
  ok('mezon nomi saqlandi', (await departments.byId(buxId)).custom_name === "Hisobotlar o'z vaqtida");
  const kS = await kpi.compute(sardor, month, { force: true });
  ok('draft qator yangi vaznlarni oldi', Number(kS.w_tasks) === 50);

  // =========================================================================
  console.log('\n— 12. Hisobotlar va Excel —');
  await send(msg(99999, '📊 Hisobotim'));
  ok('hodim hisoboti', lastText(99999).includes('Topshiriqlar') && lastText(99999).includes('KPI'));
  await send(msg(20001, "🏢 Bo'limim"));
  ok('bo\'lim hisoboti', lastText(20001).includes('BUXGALTERIYA') && lastText(20001).includes('Akbar'));
  await send(msg(1000, '📈 Hisobotlar'));
  await send(cbq(1000, `rp:team:${month}`));
  ok('jamoa oylik jadvali', lastText(1000).includes('JAMOA'));
  await send(cbq(1000, 'adm:today'));
  ok('bugungi holat', lastText(1000).includes('BUGUNGI HOLAT') && lastText(1000).includes('sababli'));
  await send(cbq(1000, 'adm:status'));
  ok('tizim holati', lastText(1000).includes('TIZIM HOLATI') && lastText(1000).includes('SQLite'));
  await send(cbq(1000, 'emp:list'));
  ok('hodimlar ro\'yxati', findCb(1000, new RegExp(`^emp:${akbar.id}$`)));
  await send(cbq(1000, `emp:${akbar.id}`));
  ok('hodim kartochkasi', lastText(1000).includes('Akbar Karimov') && lastText(1000).includes('Buxgalter'));

  const m1 = await excel.buildMonthly(month);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(m1.buffer);
  ok('oylik Excel: 5 varaq (Tashriflar bilan)', ['KPI', 'Topshiriqlar', 'Davomat', 'Tashriflar', "Bo'limlar"].every((n) => wb.getWorksheet(n)));
  ok('KPI varag\'ida 3 hodim', wb.getWorksheet('KPI').rowCount === 3 + 3);
  const m2 = await excel.buildEmployeeMonth(akbar, month);
  ok('hodim Excel', m2.buffer.length > 1000 && m2.filename.includes('akbar'));
  const m3 = await excel.buildDay();
  ok('kunlik Excel', m3.buffer.length > 1000);
  const digest = await reports.buildMorningDigest();
  ok('ertalabki digest', digest.text.includes('ERTALABKI') && (digest.onTime.length + digest.late.length) >= 1);
  const daily = await reports.buildDailyGroupText();
  ok('guruh kun yakuni — pul yo\'q', daily.includes('KUN YAKUNI') && !daily.includes("so'm"));
  mark = sent.length;
  const rem = await reports.sendReminder({ telegram: bot.telegram });
  ok('eslatma yuborildi', rem.sent >= 1 && countSince(mark, 99999) >= 1);

  // =========================================================================
  console.log('\n— 13. Rol o\'zgarishi, ishdan ketish, sessiya —');
  await send(cbq(1000, `emp:act:${sardor.id}`));
  ok('ishdan ketdi → active=0', Number((await employees.byId(sardor.id)).active) === 0);
  await send(msg(30001, '/start'));
  ok('ishdan ketgan /start — ro\'yxatda yo\'q', lastText(30001).includes("ro'yxatda yo'q"));
  await send(cbq(1000, `emp:act:${sardor.id}`));
  ok('qayta faollashdi', Number((await employees.byId(sardor.id)).active) === 1);

  session.set(99999, { step: 'self_task_text' });
  await send(msg(99999, '❌ Bekor qilish'));
  ok('bekor qilish sessiyani tozalaydi', !session.get(99999).step);
  await send(msg(99999, 'nimadir'));
  ok('tanilmagan matn — yordam', lastText(99999).includes('Tushunmadim'));
  await send(msg(99999, "⏭ O'tkazib yuborish"));
  ok('skip bo\'sh holatda', lastText(99999).includes('kutilmayapti'));

  // typed date
  await send(msg(99999, "➕ O'zimga vazifa"));
  await send(msg(99999, 'Sana bilan vazifa'));
  await send(cbq(99999, 'st:due:type'));
  await send(msg(99999, '01.01.2020'));
  ok('o\'tgan sana rad etildi', lastText(99999).includes("o'tgan"));
  const fut = time.addDays(bugun, 10);
  await send(msg(99999, `${fut.slice(8, 10)}.${fut.slice(5, 7)}.${fut.slice(0, 4)}`));
  ok('yozilgan sana bilan vazifa', (await tasks.openFor(akbar.id)).some((x) => x.title === 'Sana bilan vazifa' && x.due_date === fut));

  await send(msg(99999, '🏁 Ketdim'));
  ok('ketdim', (await attendance.isCheckedOut(akbar.id)) && lastText(99999).includes('yakunlandi'));

  // =========================================================================
  console.log('\n— 13b. Umumiy ish vaqti —');
  const worktime = require('../src/services/worktime');
  ok('standart ish vaqti config dan (testda 09:00)', worktime.get() === '09:00');
  await send(cbq(1000, `emp:start:${akbar.id}`));
  await send(msg(1000, '10:30'));
  await send(cbq(1000, 'adm:worktime'));
  ok('ish vaqti ekrani (alohida vaqtlilar ro\'yxati)', lastText(1000).includes('ISH VAQTI') && lastText(1000).includes('10:30'));
  await send(cbq(1000, 'wt:set'));
  await send(msg(1000, '8:50'));
  ok('alohida vaqti borlar uchun so\'raldi', Boolean(findCb(1000, /^wt:apply:all$/)));
  mark = sent.length;
  await send(cbq(1000, 'wt:apply:keep'));
  ok('umumiy 08:50, alohida vaqt saqlandi', worktime.get() === '08:50' && (await employees.byId(akbar.id)).work_start === '10:30' && (await db.getSetting('work_start')) === '08:50');
  ok('hodimlarga xabar (alohida vaqtlidan tashqari)', countSince(mark, 30001) >= 1 && countSince(mark, 99999, 'sendMessage') === 0);
  ok('8:50 dan: 9:00 kech emas, 9:05 → 15 daq', attendance.lateMinutesOf(`${bugun}T09:00:00+05:00`) === 0 && attendance.lateMinutesOf(`${bugun}T09:05:00+05:00`) === 15);
  await send(cbq(1000, 'wt:set'));
  await send(msg(1000, 'soat'));
  ok('noto\'g\'ri vaqt rad etildi', lastText(1000).includes('HH:mm'));
  await send(msg(1000, '9:00'));
  await send(cbq(1000, 'wt:apply:all'));
  ok('hamma uchun 09:00 — alohida vaqtlar bekor', worktime.get() === '09:00' && (await employees.byId(akbar.id)).work_start === null);
  const jobs = require('../src/jobs');
  ok('tick oynasi: 8:50 — 8:50 da ha, 8:55 da yo\'q', jobs.inSlot(530, 530) && !jobs.inSlot(530, 535) && jobs.inSlot(532, 535));
  mark = sent.length;
  await jobs.tick({ telegram: bot.telegram }, time.now().set({ hour: 9, minute: 15 }));
  ok('tick 9:15 (9:00+10+5) — ertalabki digest direktorga', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 1000 && (s.payload.text || '').includes('ERTALABKI')));

  // =========================================================================
  console.log('\n— 13c. HR, Hodimlarim, rahbar orqali topshiriq —');
  await send(msg(1000, '/hodim_qosh 50001'));
  await send(msg(1000, 'Abbos'));
  await send(msg(1000, "⏭ O'tkazib yuborish"));
  await send(cbq(1000, 'ea:dept:new'));
  await send(msg(1000, 'Kadrlar'));
  ok('wizardda HR roli bor', Boolean(findCb(1000, /^ea:role:hr$/)));
  await send(cbq(1000, 'ea:role:hr'));
  ok('tasdiqlashda HR', lastText(1000).includes('HR'));
  await send(cbq(1000, 'ea:ok'));
  let abbos = await employees.byTgId(50001);
  ok('Abbos — HR (rahbar + is_hr, lavozim HR)', abbos && abbos.role === 'head' && employees.isHr(abbos) && abbos.position === 'HR');
  ok('HR menyusida «Hodimlarim»', to(50001).some((s) => JSON.stringify(s.payload.reply_markup || {}).includes('Hodimlarim')));

  await send(msg(1000, '👥 Hodimlarim'));
  ok('direktor: rahbarlar ro\'yxati (Bobur, Abbos)', lastText(1000).includes('HODIMLARIM') && lastText(1000).includes('Bobur') && lastText(1000).includes('Abbos') && findCb(1000, new RegExp(`^tm:m:${bobur.id}$`)));
  await send(cbq(1000, `tm:m:${bobur.id}`));
  ok('rahbar ichida jamoasi (Akbar, Sardor) va tugmalar', lastText(1000).includes('Akbar') && lastText(1000).includes('Sardor') && findCb(1000, new RegExp(`^as:team:${bobur.id}$`)) && findCb(1000, new RegExp(`^as:emp:${bobur.id}$`)));
  await send(cbq(1000, `tm:e:${akbar.id}`));
  ok('direktor hodimni bossa — kartochka', lastText(1000).includes('Akbar Karimov') && findCb(1000, new RegExp(`^emp:hr:${akbar.id}$`)));

  await send(msg(1000, '📤 Topshiriq berish'));
  ok('topshiriq: avval rahbarlar (o\'ziga / hodimlariga)', findCb(1000, new RegExp(`^as:emp:${abbos.id}$`)) && findCb(1000, new RegExp(`^as:team:${bobur.id}$`)) && findCb(1000, /^as:dept:0$/));
  await send(cbq(1000, `as:team:${bobur.id}`));
  const lastKb = JSON.stringify(to(1000).filter((x) => x.payload.reply_markup).slice(-1)[0].payload.reply_markup);
  ok('rahbar jamoasidan hodim tanlash', lastKb.includes(`as:emp:${akbar.id}"`) && !lastKb.includes(`as:emp:${abbos.id}"`));
  await send(cbq(1000, `as:emp:${akbar.id}`));
  await send(msg(1000, 'Kadrlar hisobotini tekshirish'));
  await send(cbq(1000, 'as:due:1'));
  ok('direktor → Bobur jamoasi → Akbar ga topshiriq', (await tasks.openFor(akbar.id)).some((x) => x.title === 'Kadrlar hisobotini tekshirish' && x.source === 'admin'));
  await send(msg(1000, '📤 Topshiriq berish'));
  await send(cbq(1000, `as:emp:${abbos.id}`));
  await send(msg(1000, "Yangi hodimlar ro'yxati"));
  await send(cbq(1000, 'as:due:0'));
  ok('direktor → HR ning o\'ziga topshiriq', (await tasks.openFor(abbos.id)).length === 1 && lastText(50001).includes('Yangi topshiriq'));

  await send(msg(20001, '👥 Hodimlarim'));
  ok('rahbar: o\'z jamoasi', lastText(20001).includes('MENING JAMOAM') && lastText(20001).includes('Akbar') && !lastText(20001).includes('Abbos'));
  await send(cbq(20001, `tm:e:${akbar.id}`));
  ok('rahbar hodimni ochadi: hisobot + topshiriq', lastText(20001).includes('Topshiriqlar') && findCb(20001, new RegExp(`^as:emp:${akbar.id}$`)));
  await send(cbq(20001, `tm:m:${abbos.id}`));
  ok('rahbar boshqa jamoani ocha olmaydi', !lastText(20001).includes('Abbos'));
  await send(cbq(30001, 'tm:home'));
  ok('oddiy hodim Hodimlarim ga kira olmaydi', sent.slice(-1)[0].method === 'answerCallbackQuery');
  ok('rahbarsizlar ro\'yxati (hammaning rahbari bor)', (await employees.listUnmanaged()).length === 0);

  await send(cbq(1000, `emp:hr:${abbos.id}`));
  ok('kartochkadan HR olib tashlash', !employees.isHr(await employees.byTgId(50001)));
  await send(cbq(1000, `emp:hr:${abbos.id}`));
  abbos = await employees.byTgId(50001);
  ok('va qaytadan HR qilish', employees.isHr(abbos));

  // =========================================================================
  console.log('\n— 14. Filial (Samarqand) va hudud agenti —');
  await send(cbq(1000, 'br:new'));
  await send(msg(1000, 'Samarqand'));
  const sam = await branches.byName('Samarqand');
  ok('filial yaratildi', Boolean(sam) && lastText(1000).includes('Samarqand'));
  await send(cbq(1000, `br:loc:${sam.id}`));
  await send(loc(1000, 39.6542, 66.9597));
  const samOff = branches.officeOfBranch(await branches.byId(sam.id));
  ok('filial ofisi saqlandi', samOff && Math.abs(samOff.lat - 39.6542) < 1e-6 && lastText(1000).includes('filiali ofisi saqlandi'));
  ok('filial hodimi filial ofisi bilan solishtiriladi', (await branches.officeFor({ branch_id: sam.id })).name === 'Samarqand' && (await branches.officeFor({ branch_id: null })).name === 'Asosiy ofis');

  await send(msg(1000, '/hodim_qosh 40001'));
  await send(msg(1000, 'Jasur Agent'));
  await send(msg(1000, 'Savdo agenti'));
  await send(cbq(1000, `ea:dept:${buxId}`));
  await send(cbq(1000, 'ea:role:employee'));
  await send(cbq(1000, 'ea:ok'));
  let jasur = await employees.byTgId(40001);
  await send(cbq(1000, `emp:branch:${jasur.id}`));
  await send(cbq(1000, `emp:setbr:${jasur.id}:${sam.id}`));
  await send(cbq(1000, `emp:mode:${jasur.id}`));
  jasur = await employees.byTgId(40001);
  ok('agent: Samarqand filiali + hudud rejimi', Number(jasur.branch_id) === sam.id && jasur.branch_name === 'Samarqand' && employees.isField(jasur));
  ok('agentga yangi menyu (Hududga keldim tugmasi)', to(40001).some((s) => JSON.stringify(s.payload.reply_markup || {}).includes('Hududga keldim')));
  ok('hudud: video standart ixtiyoriy', !employees.needsCheckinVideo(jasur) && employees.needsCheckinVideo(akbar));
  await send(cbq(1000, `emp:video:${jasur.id}`));
  await send(cbq(1000, `emp:salary:${jasur.id}`));
  await send(msg(1000, '3 000 000'));
  await send(cbq(1000, `emp:fund:${jasur.id}`));
  await send(msg(1000, '1 000 000'));
  jasur = await employees.byTgId(40001);
  ok('video majburiy, oklad va KPI summasi saqlandi', employees.needsCheckinVideo(jasur) && Number(jasur.salary) === 3000000 && Number(jasur.bonus_fund) === 1000000);
  ok('kartochkada filial, rejim, oklad', lastText(1000).includes('Samarqand') && lastText(1000).includes('Hudud') && lastText(1000).includes('3 000 000'));

  await send(msg(40001, '✅ Keldim'));
  ok('agent ham avval oyni tasdiqlaydi', lastText(40001).includes('yangi ish oyi'));
  await send(cbq(40001, `ms:ok:${month}`));
  await send(msg(40001, '✅ Keldim'));
  ok('uy joylashuvi so\'raldi', lastText(40001).includes('uyingiz joylashuvini'));
  await send(loc(40001, 39.7, 66.9));
  jasur = await employees.byTgId(40001);
  ok('uy joylashuvi saqlandi', employees.homeOf(jasur) && Math.abs(employees.homeOf(jasur).lat - 39.7) < 1e-6);
  await send(msg(40001, '✅ Keldim'));
  await send(loc(40001, 39.7004, 66.9004));
  ok('uyga yaqin (≈55 m) — rad etildi', lastText(40001).includes('uyingizga yaqinsiz') && !(await attendance.isCheckedIn(jasur.id)));
  await send(msg(40001, '✅ Keldim'));
  await send(loc(40001, 39.66, 66.95));
  ok('uydan ≈6 km — video so\'raldi (majburiy)', lastText(40001).includes('video') && !findCb(40001, /^ci:novideo$/) && !(await attendance.isCheckedIn(jasur.id)));
  await send(cbq(40001, 'ci:novideo'));
  ok('majburiy bo\'lsa videosiz o\'tmaydi', !(await attendance.isCheckedIn(jasur.id)));
  await send(video(40001, 'Yo\'ldaman'));
  const attJ = await attendance.get(jasur.id);
  ok('agent ishga chiqdi (hudud, video, izoh)', attJ && attJ.checked_in && attJ.checkin_mode === 'field' && attJ.checkin_proof_type === 'video' && attJ.checkin_note === "Yo'ldaman" && Number(attJ.checkin_dist) > 1000);

  // video ixtiyoriy bo'lsa — «Videosiz qayd etish»
  await send(cbq(1000, `emp:video:${jasur.id}`));
  session.set(40001, {});
  await db.query('DELETE FROM attendance WHERE id = $1', [attJ.id]);
  await send(msg(40001, '✅ Keldim'));
  await send(loc(40001, 39.66, 66.95));
  ok('ixtiyoriy video — «Videosiz» tugmasi', Boolean(findCb(40001, /^ci:novideo$/)));
  await send(cbq(40001, 'ci:novideo'));
  ok('videosiz qayd etildi', (await attendance.isCheckedIn(jasur.id)) && !(await attendance.get(jasur.id)).checkin_proof_file_id);

  console.log('\n— 15. Tashriflar —');
  await send(msg(99999, '📍 Hududga keldim'));
  ok('ofis hodimida tashrif yo\'q', lastText(99999).includes('faqat hudud'));
  await send(msg(40001, '📍 Hududga keldim'));
  ok('tashrif: joylashuv so\'raldi', lastText(40001).includes('Hududga keldim') && session.get(40001).step === 'visit_location');
  await send(loc(40001, 39.65, 66.97));
  ok('tashrif: video/audio so\'raldi', lastText(40001).includes('audio'));
  await send(photo(40001, 'rasm'));
  ok('tashrif: rasm qabul qilinmaydi', lastText(40001).includes('rasm qabul qilinmaydi'));
  await send(voice(40001));
  ok('tashrif: izoh so\'raldi', lastText(40001).includes('Izoh'));
  mark = sent.length;
  await send(msg(40001, 'Mijoz: Oila market, 20 karobka buyurtma'));
  let vs = await visits.forEmployee(jasur.id, bugun, bugun);
  ok('tashrif saqlandi (ovoz + izoh + uydan masofa)', vs.length === 1 && vs[0].proof_type === 'voice' && vs[0].note.includes('Oila market') && Number(vs[0].home_dist) > 1000);
  ok('tashrif: tekshiruvchiga ovoz bordi', sent.slice(mark).some((s) => s.method === 'sendVoice' && Number(s.payload.chat_id) === 20001 && (s.payload.caption || '').includes('Oila market')));
  ok('tashrif: arxivga bordi', sent.slice(mark).some((s) => s.method === 'sendVoice' && Number(s.payload.chat_id) === -100777));
  await send(msg(40001, '📍 Hududga keldim'));
  await send(loc(40001, 39.64, 66.98));
  await send(video(40001, 'Ikkinchi do\'kon'));
  vs = await visits.forEmployee(jasur.id, bugun, bugun);
  ok('video ostidagi izoh bilan darhol saqlandi', vs.length === 2 && vs[1].note === "Ikkinchi do'kon" && lastText(40001).includes('2-chi'));
  await send(cbq(1000, 'adm:visits'));
  ok('direktor: bugungi tashriflar', lastText(1000).includes('TASHRIFLAR') && lastText(1000).includes('Jasur'));
  await send(cbq(1000, `adm:visit:${vs[0].id}`));
  ok('direktor tashrif isbotini ochdi', sent.some((s) => s.method === 'sendVoice' && Number(s.payload.chat_id) === 1000));

  await send(cbq(1000, `emp:home:${jasur.id}`));
  ok('direktor uy joyini tozaladi', !employees.homeOf(await employees.byTgId(40001)) && lastText(40001).includes('tozalandi'));

  console.log('\n— 16. Oylik va KPI, oy boshi —');
  await send(msg(40001, '💵 Oylik va KPI'));
  ok('oylik ro\'yxati (oklad + jami)', lastText(40001).includes('OYLIK VA KPI') && lastText(40001).includes('3 000 000') && findCb(40001, new RegExp(`^pay:m:${month}$`)));
  await send(cbq(40001, `pay:m:${month}`));
  ok('oy tafsiloti: sekundomer + KPI sharti', lastText(40001).includes('Oy hisobi') && lastText(40001).includes("o'tdi") && lastText(40001).includes('KPI sharti') && lastText(40001).includes('Jami'));
  const kJ = await kpi.compute(await employees.byTgId(40001), month);
  const atJ = await attendance.stats(await employees.byTgId(40001), from, toDate);
  ok("bugun qo'shilgan hodimga oldingi kunlar «kelmagan» hisoblanmaydi", atJ.absent === 0 && atJ.days.every((x) => x.date >= bugun), JSON.stringify({ absent: atJ.absent }));
  ok('kpi_monthly: oklad snapshot + shart', Number(kJ.salary) === 3000000 && kJ.kpi_eligible !== null && kJ.bonus_amount === (Number(kJ.kpi_eligible) === 1 ? 1000000 : 0));
  await send(cbq(1000, 'adm:months'));
  ok('direktor: oy boshi tasdiqlari', lastText(1000).includes('oy boshi tasdiqlari') && lastText(1000).includes('Jasur') && lastText(1000).includes('Tasdiqlamagan'));

  const next = time.shiftMonth(month, 1);
  mark = sent.length;
  const nMs = await require('../src/handlers/month').sendMonthStart({ telegram: bot.telegram }, next);
  ok('1-kun xabari hammaga (+ guruhga)', nMs === (await employees.listActive()).length && sent.slice(mark).some((s) => (s.payload.text || '').includes('omad')));
  ok('xabarda tasdiqlash tugmasi', findCb(99999, new RegExp(`^ms:ok:${next}$`)));
  await send(cbq(99999, `ms:ok:${next}`));
  ok('kelgusi oy tugmasi hozir eskirgan', !(await months.isConfirmed(akbar.id, next)));
  ok('config: KPI rejimi gate, agent masofasi 1 km', config.kpiMode === 'gate' && config.fieldMinDistanceM === 1000);


  // =========================================================================
  console.log('\n— 17. Kech qolaman / Kelmayman — video, audio, izoh → HR va boshliq —');
  const org = require('../src/services/org');
  const abbosE = await employees.byTgId(50001);
  await send(msg(20001, '⏰ Kech qolaman'));
  ok('kech qolaman: HR (Abbos) va boshliq (Odilxon) ga borishi aytildi', lastText(20001).includes('Abbos') && lastText(20001).includes('Odilxon') && session.get(20001).step === 'late_notice');
  mark = sent.length;
  await send(voice(20001));
  let attB = await attendance.get(bobur.id);
  ok('ovozli xabar bilan kech qolish qayd etildi', attB && attB.late_notice_at && attB.late_proof_type === 'voice' && attB.late_reason === '(ovozli xabar)' && !attB.checked_in);
  ok('HR (Abbos) ga ovoz bordi', sent.slice(mark).some((s) => s.method === 'sendVoice' && Number(s.payload.chat_id) === 50001));
  ok('boshliqqa (direktor) ovoz bordi', sent.slice(mark).some((s) => s.method === 'sendVoice' && Number(s.payload.chat_id) === 1000));
  ok('hodimga tasdiq: HR va boshliqqa yuborildi', lastText(20001).includes('HR (Abbos) va boshliq (Odilxon)'));
  const digestB = await reports.buildMorningDigest();
  ok('ertalabki holatda «kech qolishini bildirgan»', digestB.text.includes('kech qolishini bildirgan'));

  await send(msg(20001, '✅ Keldim'));
  await send(cbq(20001, `ms:ok:${month}`));
  await send(msg(20001, '✅ Keldim'));
  await send(loc(20001, 41.3112, 69.2798));
  mark = sent.length;
  await send(videoNote(20001));
  attB = await attendance.get(bobur.id);
  ok('keyin Keldim — kechikish sababi saqlanib qoldi', attB.checked_in && attB.late_reason === '(ovozli xabar)' && session.get(20001).step !== 'late_reason');
  ok('direktorga «oldindan ogohlantirgan» belgisi', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 1000 && (s.payload.text || '').includes('oldindan ogohlantirgan')));
  await send(msg(20001, '⏰ Kech qolaman'));
  ok('kelgandan keyin kech qolaman — allaqachon', lastText(20001).includes('allaqachon'));

  await send(msg(50001, '🙋 Kelmayman (sabab)'));
  mark = sent.length;
  await send(video(50001, 'Kasal bo\'ldim, shifokordaman'));
  const attAb = await attendance.get(abbosE.id);
  ok('HR (rahbariyat) kelmayman — so\'rovsiz darhol sababli, video + izoh saqlandi', attAb.excuse_status === 'approved' && attAb.excuse_proof_type === 'video' && attAb.excuse_reason === "Kasal bo'ldim, shifokordaman");
  ok('HR ga javob: sababli deb belgilandi', lastText(50001).includes('sababli'));
  ok('boshliqqa video — xabar, tasdiqlash tugmasisiz', sent.slice(mark).some((s) => s.method === 'sendVideo' && Number(s.payload.chat_id) === 1000 && !JSON.stringify(s.payload.reply_markup || {}).includes('ab:ok')));
  ok('HR o\'ziga o\'zi yubormaydi', !sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001 && s.method === 'sendVideo'));
  await send(cbq(1000, `ab:no:${attAb.id}`, { message_id: 7, chat: { id: 1000, type: 'private' }, video: { file_id: 'v' }, caption: 'c', date: 0 }));
  ok('direktor kerak bo\'lsa baribir o\'zgartira oladi (video captioni tahrirlandi)', (await attendance.get(abbosE.id)).excuse_status === 'rejected' && sent.slice(-3).some((s) => s.method === 'editMessageCaption'));

  let kecha2 = time.addDays(bugun, -2);
  const rq = await attendance.requestExcuse(akbar.id, 'Oilaviy sabab', kecha2);
  await send(cbq(50001, `ab:ok:${rq.id}`));
  ok('HR boshqa bo\'lim hodimining sababli kunini tasdiqlay oladi', (await attendance.get(akbar.id, kecha2)).excuse_status === 'approved' && Number((await attendance.get(akbar.id, kecha2)).excuse_by) === 50001);
  ok('HR va direktor — xabar oluvchilar (+ bo\'lim rahbari)', (await org.absenceRecipientsOf(akbar)).sort().join(',') === [1000, 20001, 50001].sort().join(','));

  await send(cbq(1000, 'adm:names'));
  ok('Nomlar: boshliq Odilxon, HR Abbos', lastText(1000).includes('Odilxon') && lastText(1000).includes('Abbos'));
  await send(cbq(1000, 'nm:boss'));
  await send(msg(1000, 'Odilxon aka'));
  ok('boshliq ismi o\'zgardi', (await org.bossName()) === 'Odilxon aka' && lastText(1000).includes('Odilxon aka'));
  await send(cbq(1000, `emp:name:${abbosE.id}`));
  await send(msg(1000, 'Abbos Aliyev'));
  ok('HR ismi o\'zgardi va xabarlarda yangi ism', (await org.recipientsLabel(akbar)) === 'HR (Abbos Aliyev) va boshliq (Odilxon aka)');

  // =========================================================================
  console.log('\n— 18. Eslatma jadvali (hodim so\'raydi → direktor/HR tasdiqlaydi) —');
  const reminders = require('../src/services/reminders');
  ok('parseTimes', JSON.stringify(reminders.parseTimes('13:00, 10 16.30')) === '["10:00","13:00","16:30"]' && reminders.parseTimes('25:00') === null && reminders.parseTimes('03:00') === null);
  ok('intervalTimes 9:00 dan har 3 soat', JSON.stringify(reminders.intervalTimes(540, 3)) === '["12:00","15:00"]');
  await send(msg(30001, '🔔 Eslatmalar'));
  ok('eslatmalar ekrani (umumiy jadval)', lastText(30001).includes('ESLATMALAR') && lastText(30001).includes('umumiy') && findCb(30001, /^rm:int:2$/));
  mark = sent.length;
  await send(cbq(30001, 'rm:int:2'));
  let sard = await employees.byTgId(30001);
  ok('har 2 soat so\'raldi (pending)', sard.remind_pending === '11:00,13:00,15:00,17:00' && !sard.remind_times);
  ok('so\'rov faqat boshliqqa bordi (tugmalar bilan), HR ga emas', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 1000 && JSON.stringify(s.payload.reply_markup || {}).includes(`rs:ok:${sard.id}`)) && !sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001));
  ok('bo\'lim rahbariga (Bobur) bormaydi', !sent.slice(mark).some((s) => Number(s.payload.chat_id) === 20001));
  await send(cbq(99999, `rs:ok:${sard.id}`));
  ok('oddiy hodim tasdiqlay olmaydi', Boolean((await employees.byTgId(30001)).remind_pending));
  await send(cbq(50001, `rs:ok:${sard.id}`));
  ok('HR tasdiqlay olmaydi', Boolean((await employees.byTgId(30001)).remind_pending));
  await send(cbq(1000, `rs:ok:${sard.id}`));
  sard = await employees.byTgId(30001);
  ok('boshliq tasdiqladi → jadval kuchga kirdi', sard.remind_times === '11:00,13:00,15:00,17:00' && !sard.remind_pending && lastText(30001).includes('tasdiqlandi'));
  await send(cbq(1000, `rs:ok:${sard.id}`));
  ok('ikkinchi marta — allaqachon ko\'rib chiqilgan', lastText(1000).includes('allaqachon'));

  await send(cbq(30001, 'rm:custom'));
  await send(msg(30001, 'ertalab'));
  ok('noto\'g\'ri vaqt rad etildi', lastText(30001).includes('vergul'));
  await send(msg(30001, '10:30, 16:45'));
  ok('o\'z vaqtlari so\'raldi', (await employees.byTgId(30001)).remind_pending === '10:30,16:45');
  await send(cbq(1000, `rs:no:${sard.id}`));
  sard = await employees.byTgId(30001);
  ok('direktor rad etdi → eski jadval qoldi', sard.remind_times === '11:00,13:00,15:00,17:00' && !sard.remind_pending && lastText(30001).includes('rad etildi'));

  const jobs2 = require('../src/jobs');
  await tasks.create({ employeeId: sard.id, title: 'Kassa hisoboti', dueDate: bugun, createdBy: 20001, source: 'head' });
  mark = sent.length;
  await jobs2.remindTick({ telegram: bot.telegram }, 13 * 60);
  ok('13:00 — Sardorga (o\'z jadvali) eslatma bordi', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 30001 && (s.payload.text || '').includes('Eslatma')));
  mark = sent.length;
  await jobs2.remindTick({ telegram: bot.telegram }, 12 * 60);
  ok('12:00 — Sardorga bormaydi (uning jadvalida yo\'q)', !sent.slice(mark).some((s) => Number(s.payload.chat_id) === 30001));
  await send(cbq(30001, 'rm:reset'));
  ok('umumiy jadvalga qaytdi', !(await employees.byTgId(30001)).remind_times);

  await send(cbq(1000, 'wt:rs:2'));
  ok('direktor umumiy eslatmani har 2 soat qildi', (await reminders.globalStep()) === 2 && lastText(1000).includes('har <b>2</b> soatda'));

  // =========================================================================
  console.log('\n— 19. 1 soat oldin ogohlantirsa kechikish hisoblanmaydi —');
  const wt9 = require('../src/services/worktime').minutes(); // 9:00 (testda)
  const d9 = bugun;
  const rowEarly = { work_date: d9, checked_in: `${d9}T09:40:00+05:00`, late_minutes: 40, late_notice_at: `${d9}T07:55:00+05:00` };
  const rowLateN = { ...rowEarly, late_notice_at: `${d9}T08:30:00+05:00` };
  const rowYday = { ...rowEarly, late_notice_at: `${time.addDays(d9, -1)}T20:00:00+05:00` };
  ok('07:55 da aytgan (9:00 dan 65 daq oldin) — vaqtida', wt9 === 540 && attendance.dayStatus(rowEarly, d9, d9, sardor) === 'ontime' && attendance.noticedInTime(rowEarly, sardor));
  ok('08:30 da aytgan (30 daq oldin) — kech', attendance.dayStatus(rowLateN, d9, d9, sardor) === 'late');
  ok('kecha kechqurun aytgani hisobga olinmaydi', attendance.dayStatus(rowYday, d9, d9, sardor) === 'late');
  ok('10:00 li hodim uchun 08:55 da aytish — o\'z vaqtida', attendance.noticedInTime({ ...rowEarly, late_notice_at: `${d9}T08:55:00+05:00` }, { work_start: '10:00' }));

  // =========================================================================
  console.log('\n— 20. HR hammani ko\'radi, yo\'nalishlar, davomat nazorati (Azizbek) —');
  const directions = require('../src/services/directions');
  const dirs = await directions.listActive();
  ok("standart yo'nalishlar: Moliya, Logistika, Ombor, Sotuv", ['Moliya', 'Logistika', 'Ombor', 'Sotuv'].every((n) => dirs.some((r) => r.name === n)));
  // Azizbek = Sardor (30001): 4 yo'nalish mas'uli + davomat nazorati
  const moliya = dirs.find((r) => r.name === 'Moliya');
  const hrTg = 50001;
  await send(msg(hrTg, '👥 Hodimlarim'));
  ok('HR — hamma rahbarlar (direktordek)', lastText(hrTg).includes('HODIMLARIM') && lastText(hrTg).includes('Bobur'));
  await send(cbq(hrTg, `tm:e:${sardor.id}`));
  ok('HR boshqa bo\'lim hodimini ochadi: hisobot + lichka + ruxsat tugmalari', lastText(hrTg).includes('Lichka') && lastText(hrTg).includes('tg://user?id=30001') && findCb(hrTg, new RegExp(`^vw:grant:${sardor.id}$`)) && findCb(hrTg, new RegExp(`^ed:${sardor.id}$`)));
  await send(cbq(hrTg, `ed:${sardor.id}`));
  for (const n of ['Moliya', 'Logistika', 'Ombor', 'Sotuv']) await send(cbq(hrTg, `ed:t:${sardor.id}:${dirs.find((r) => r.name === n).id}`));
  ok('HR Sardorni 4 yo\'nalishga mas\'ul qildi', (await directions.ofEmployee(sardor.id)).length === 4);
  await send(cbq(30001, `ed:t:${sardor.id}:${moliya.id}`));
  ok('oddiy hodim yo\'nalish o\'zgartira olmaydi', (await directions.ofEmployee(sardor.id)).length === 4);

  await send(msg(hrTg, '📤 Topshiriq berish'));
  ok('HR topshiriq: avval yo\'nalishlar + Shaxsiy', findCb(hrTg, new RegExp(`^as:dir:${moliya.id}$`)) && findCb(hrTg, /^as:dir:self$/));
  await send(cbq(hrTg, `as:dir:${moliya.id}`));
  ok('Moliya → mas\'ul Sardor', lastText(hrTg).includes('Moliya') && findCb(hrTg, new RegExp(`^as:who:${sardor.id}$`)));
  await send(cbq(hrTg, `as:who:${sardor.id}`));
  ok('tanlangach lichka ko\'rinadi', lastText(hrTg).includes('tg://user?id=30001') && lastText(hrTg).includes('@sardor') && findCb(hrTg, new RegExp(`^as:emp:${sardor.id}$`)));
  await send(cbq(hrTg, `as:emp:${sardor.id}`));
  await send(msg(hrTg, 'Oktabr uchun xarajatlar smetasini yuboring'));
  await send(cbq(hrTg, 'as:due:1'));
  ok('HR boshqa bo\'lim hodimiga topshiriq berdi', (await tasks.openFor(sardor.id)).some((x) => x.title.includes('smetasini')));
  await send(cbq(hrTg, 'as:dir:self'));
  ok('Shaxsiy → hamma hodimlar', findCb(hrTg, new RegExp(`^as:who:${akbar.id}$`)) && findCb(hrTg, new RegExp(`^as:who:${jasur.id}$`)));
  await send(cbq(20001, 'as:dirs'));
  ok('oddiy rahbar yo\'nalishlar menyusiga kira olmaydi', sent.slice(-1)[0].method === 'answerCallbackQuery');

  await send(msg(hrTg, '💰 KPI'));
  await send(cbq(hrTg, `kpi:e:${akbar.id}:${month}`));
  ok('HR KPI ni ko\'radi (summalar bilan), tahrir tugmalarisiz', lastText(hrTg).includes('KPI summasi') && lastText(hrTg).includes("Faqat ko'rish") && !findCb(hrTg, new RegExp(`^kpi:ok:${akbar.id}:`)));
  await send(cbq(hrTg, `kpi:ok:${akbar.id}:${month}`));
  ok('HR KPI tasdiqlay olmaydi', sent.slice(-1)[0].method === 'answerCallbackQuery');
  await send(msg(hrTg, '📈 Hisobotlar'));
  ok('HR hisobotlarni ko\'radi', lastText(hrTg).includes('HISOBOTLAR'));
  await send(cbq(hrTg, `tm:e:${sardor.id}`));
  await send(cbq(hrTg, `vw:grant:${sardor.id}`));
  ok('HR Sardorga davomat nazorati ruxsatini berdi', employees.isViewer(await employees.byTgId(30001)) && to(30001).some((s) => JSON.stringify(s.payload.reply_markup || {}).includes('Davomat nazorati')));

  await send(msg(30001, '👁 Davomat nazorati'));
  const vt = lastText(30001);
  ok('nazoratchi: hamma hodimning kelgan-ketgani', vt.includes('DAVOMAT') && vt.includes('Akbar') && vt.includes('Jasur') && vt.includes('keldi'));
  ok('nazoratchida topshiriqlar yo\'q', !vt.includes('smetasini') && !vt.includes('topshiriq'));
  await send(cbq(30001, `vw:m:${month}`));
  ok('oylik: davomat % va KPI %', lastText(30001).includes('davomat') && lastText(30001).includes('KPI') && lastText(30001).includes('%') && !lastText(30001).includes("so'm"));
  await send(cbq(30001, `rp:emp:${akbar.id}:${month}`));
  ok('nazoratchi hodim hisobotiga (topshiriqlar) kira olmaydi', sent.slice(-1)[0].method === 'answerCallbackQuery');
  await send(msg(30001, '👥 Hodimlarim'));
  ok('nazoratchi Hodimlarim ga kira olmaydi', lastText(30001).includes('Faqat rahbarlar'));
  await send(cbq(hrTg, `vw:grant:${sardor.id}`));
  ok('ruxsat olib qo\'yildi', !employees.isViewer(await employees.byTgId(30001)));
  await send(msg(99999, '👁 Davomat nazorati'));
  ok('ruxsatsiz hodim ko\'ra olmaydi', lastText(99999).includes('Ruxsat'));

  await send(cbq(1000, 'dn:list'));
  ok('direktor: yo\'nalishlar ro\'yxati (mas\'ul Sardor)', lastText(1000).includes("YO'NALISHLAR") && lastText(1000).includes('Sardor'));
  await send(cbq(1000, 'dn:new'));
  await send(msg(1000, 'Marketing'));
  ok('yangi yo\'nalish', (await directions.listActive()).some((r) => r.name === 'Marketing'));

  // =========================================================================
  console.log('\n— 21. Ikkinchi direktor (ADMIN_IDS, hodim emas) —');
  process.env.ADMIN_IDS = '1000,60001';
  config.adminIds.push(60001);
  USERS[60001] = { id: 60001, first_name: 'Islombek', last_name: 'Baylog', username: 'islombek' };
  await requests.create({ tgId: 60001, fullName: 'Islombek Baylog', username: 'islombek' });
  await send(msg(60001, '/start'));
  ok('Telegram ismi bilan salomlashadi (boshliq ismi emas)', lastText(60001).includes('Salom, <b>Islombek Baylog</b>') && !lastText(60001).includes('Odilxon'));
  ok('eski «qo\'shish» so\'rovi yopildi', !(await requests.pendingOf(60001)));
  await send(msg(60001, '📤 Topshiriq berish'));
  await send(cbq(60001, `as:emp:${akbar.id}`));
  await send(msg(60001, 'Ikkinchi direktordan topshiriq'));
  await send(cbq(60001, 'as:due:0'));
  ok('topshiriqda beruvchi — Islombek Baylog', lastText(99999).includes('Islombek Baylog'));

  // =========================================================================
  console.log('\n— 22. HR direktor ko\'rgan hamma narsani oladi (videolar, keldi-ketdi) —');
  const hrIds = await require('../src/services/notify').seeAllIds();
  ok('seeAllIds = direktorlar + HR', hrIds.includes(1000) && hrIds.includes(50001));
  ok('reviewersOf(hodim) ga HR qo\'shildi', (await employees.reviewersOf(akbar)).includes(50001) && !(await employees.reviewersOf(await employees.byTgId(50001))).includes(50001));
  // yangi hodimni Keldim qildiramiz (video bilan) — HR ga video borishi kerak
  await db.query('DELETE FROM attendance WHERE employee_id = $1 AND work_date = $2', [akbar.id, bugun]);
  await send(msg(99999, '✅ Keldim'));
  await send(loc(99999, 41.3112, 69.2798));
  mark = sent.length;
  await send(videoNote(99999));
  ok('HR ga Keldim videosi bordi', sent.slice(mark).some((s) => s.method === 'sendVideoNote' && Number(s.payload.chat_id) === 50001));
  ok('HR ga «keldi» matni bordi', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001 && (s.payload.text || '').includes('keldi')));
  if (session.get(99999).step === 'late_reason') await send(msg(99999, "⏭ O'tkazib yuborish"));
  mark = sent.length;
  await send(msg(99999, '🏁 Ketdim'));
  ok('HR ga «ketdi» xabari bordi', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001 && (s.payload.text || '').includes('ketdi')));
  await send(msg(50001, '📈 Hisobotlar'));
  ok('HR hisobotlarida videolar va tashriflar tugmasi', findCb(50001, /^vw:vids$/) && findCb(50001, /^adm:visits$/));
  await send(cbq(50001, 'vw:vids'));
  const attNow = await attendance.get(akbar.id);
  ok('HR bugungi Keldim videolari ro\'yxati', lastText(50001).includes('KELDIM VIDEOLARI') && lastText(50001).includes('Akbar') && findCb(50001, new RegExp(`^vw:vid:${attNow.id}$`)));
  mark = sent.length;
  await send(cbq(50001, `vw:vid:${attNow.id}`));
  ok('HR videoni qayta ochdi', sent.slice(mark).some((s) => s.method === 'sendVideoNote' && Number(s.payload.chat_id) === 50001));
  await send(cbq(50001, 'adm:visits'));
  ok('HR tashriflarni ko\'radi', lastText(50001).includes('TASHRIFLAR'));
  await send(cbq(30001, 'vw:vids'));
  ok('oddiy hodim videolarni ocha olmaydi', sent.slice(-1)[0].method === 'answerCallbackQuery');
  mark = sent.length;
  await require('../src/jobs').tick({ telegram: bot.telegram }, time.now().set({ hour: 9, minute: 15 }));
  ok('ertalabki holat HR ga ham (to\'liq)', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001 && (s.payload.text || '').includes('ERTALABKI')));

  // =========================================================================
  console.log('\n— 23. Web App (Mini App): xavfsizlik va API —');
  const webAuth = require('../src/web/auth');
  const webSrv = require('../src/web/server').createServer({ bot: { telegram: bot.telegram } });
  await new Promise((r) => webSrv.listen(0, '127.0.0.1', r));
  const WEB = `http://127.0.0.1:${webSrv.address().port}`;
  /** init: undefined — to'g'ri imzo; '' — sarlavhasiz; satr — o'sha initData */
  const call = async (who, method, path, body, init) => {
    const headers = {};
    const initData = init !== undefined ? init : webAuth.build(USERS[who] || { id: who, first_name: 'Test' });
    if (initData) headers.Authorization = `tma ${initData}`;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(WEB + path, { method, headers, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* bo'sh */ }
    return { status: res.status, data };
  };
  USERS[77777] = { id: 77777, first_name: 'Begona' };
  USERS[88888] = { id: 88888, first_name: 'Web', last_name: 'Hodim' };

  // statik va sarlavhalar
  let wr = await fetch(`${WEB}/app`);
  ok('ilova sahifasi + qat\'iy CSP', wr.status === 200 && (wr.headers.get('content-security-policy') || '').includes("script-src 'self' https://telegram.org") && (await wr.text()).includes('/app/app.js'));
  ok('nosniff va frame-ancestors (faqat Telegram)', wr.headers.get('x-content-type-options') === 'nosniff' && (wr.headers.get('content-security-policy') || '').includes('frame-ancestors https://web.telegram.org'));
  wr = await fetch(`${WEB}/app/app.js`);
  ok('app.js beriladi', wr.status === 200 && (wr.headers.get('content-type') || '').includes('javascript'));
  wr = await fetch(`${WEB}/app/../src/config.js`);
  const wr2 = await fetch(`${WEB}/app/%2e%2e/src/config.js`);
  ok('yo\'l orqali boshqa fayl o\'qilmaydi', wr.status === 404 && wr2.status === 404);
  wr = await fetch(`${WEB}/health`);
  ok('health check ishlaydi', wr.status === 200 && (await wr.text()).includes('OK'));

  // avtorizatsiya
  let w = await call(99999, 'GET', '/api/me', null, '');
  ok('initData siz — 401', w.status === 401);
  const goodInit = webAuth.build(USERS[99999]);
  w = await call(99999, 'GET', '/api/me', null, goodInit.replace(/hash=[0-9a-f]{64}/, `hash=${'0'.repeat(64)}`));
  ok('soxta imzo — 401', w.status === 401);
  ok('test: initData ichida user id bor', goodInit.includes('%22id%22%3A99999'));
  w = await call(99999, 'GET', '/api/me', null, goodInit.replace('%22id%22%3A99999', '%22id%22%3A1000'));
  ok('boshqa ID (direktor) ga almashtirilgan initData — 401', w.status === 401);
  w = await call(99999, 'GET', '/api/me', null, webAuth.build(USERS[99999], Math.floor(Date.now() / 1000) - 3 * 86400));
  ok('eskirgan initData — 401 (expired)', w.status === 401 && w.data.code === 'expired');
  w = await call(77777, 'GET', '/api/me');
  ok('begona (ro\'yxatda yo\'q) — 403, faqat o\'z ID si', w.status === 403 && w.data.code === 'not_registered' && w.data.tgId === 77777);
  w = await call(99999, 'GET', '/api/nimadir');
  ok('noma\'lum yo\'l — 404', w.status === 404);
  wr = await fetch(`${WEB}/api/tasks/self`, { method: 'POST', headers: { Authorization: `tma ${goodInit}`, 'Content-Type': 'text/plain' }, body: 'x' });
  ok('JSON bo\'lmagan body — 415', wr.status === 415);
  wr = await fetch(`${WEB}/api/tasks/self`, { method: 'POST', headers: { Authorization: `tma ${goodInit}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(40000) }) });
  ok('juda katta body — 413', wr.status === 413);

  // men
  w = await call(99999, 'GET', '/api/me');
  ok('hodim /api/me: ism, rol, bugungi holat', w.status === 200 && w.data.employee.name === 'Akbar Karimov' && !w.data.roles.isManager && Boolean(w.data.attendance));
  ok('hodim o\'z okladini ko\'radi', 'salary' in w.data.employee);
  w = await call(1000, 'GET', '/api/me');
  ok('direktor /api/me: hamma huquq', w.data.roles.isAdmin && w.data.roles.seeAll && w.data.counts.requests !== undefined);

  // o'zimga vazifa
  mark = sent.length;
  w = await call(99999, 'POST', '/api/tasks/self', { text: "Web vazifa bir\n!Web vazifa ikki", due: bugun });
  ok('o\'zimga 2 ta vazifa (ikkinchisi muhim)', w.status === 200 && w.data.created.length === 2 && w.data.created[1].priority === 'high');
  ok('rahbarga «o\'ziga vazifa yozdi» xabari', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 20001 && (s.payload.text || '').includes("o'ziga 2 ta vazifa")));
  const wSelfTaskId = w.data.created[0].id;
  w = await call(99999, 'POST', '/api/tasks/self', { text: 'Eski', due: '2020-01-01' });
  ok('o\'tgan muddat rad etiladi', w.status === 400);
  w = await call(99999, 'PATCH', `/api/tasks/${wSelfTaskId}`, { title: 'Web vazifa (tahrir)', due: time.addDays(bugun, 2) });
  ok('o\'z vazifasini tahrirlaydi', w.status === 200 && w.data.task.title === 'Web vazifa (tahrir)');
  w = await call(99999, 'GET', '/api/tasks/my');
  ok('topshiriqlarim ro\'yxati', w.status === 200 && w.data.open.some((t) => t.id === wSelfTaskId));

  // topshiriq berish
  w = await call(99999, 'GET', '/api/assign/targets');
  ok('oddiy hodim topshiriq bera olmaydi', w.status === 403);
  w = await call(20001, 'GET', '/api/assign/targets');
  const tIds = w.data.people.map((p) => p.id);
  ok('rahbar — faqat o\'z bo\'limi (Akbar, Jasur), boshqa bo\'lim (Abbos) yo\'q', tIds.includes(akbar.id) && tIds.includes(jasur.id) && !tIds.includes(abbosE.id) && !tIds.includes(bobur.id));
  mark = sent.length;
  w = await call(20001, 'POST', '/api/tasks/assign', { employeeIds: [akbar.id, jasur.id], text: 'Web: inventarizatsiya\nWeb: hisobot', due: time.addDays(bugun, 1) });
  ok('bir nechta hodimga birdan (2 × 2 topshiriq)', w.status === 200 && w.data.results.length === 2 && w.data.results.every((x) => x.count === 2));
  ok('hodimga «Yangi topshiriq» (beruvchi ismi bilan)', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 99999 && (s.payload.text || '').includes('Yangi topshiriq') && (s.payload.text || '').includes('Bobur')));
  ok('HR va direktorga nusxa', sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001 && (s.payload.text || '').includes('Web: inventarizatsiya')));
  w = await call(20001, 'POST', '/api/tasks/assign', { employeeIds: [abbosE.id], text: 'Begona bo\'limga', due: bugun });
  ok('boshqa bo\'lim hodimiga — 403', w.status === 403);
  w = await call(20001, 'POST', '/api/tasks/assign', { employeeIds: [bobur.id], text: "O'zimga", due: bugun });
  ok("o'ziga «topshiriq berish» — rad (O'zimga vazifa orqali)", w.status === 400);
  const wHeadTask = (await tasks.openFor(akbar.id)).find((t) => t.title === 'Web: inventarizatsiya');
  w = await call(99999, 'PATCH', `/api/tasks/${wHeadTask.id}`, { title: 'Buzildi' });
  ok('hodim rahbar bergan topshiriqni o\'zgartira olmaydi', w.status === 403);
  const wJTask = (await tasks.openFor(jasur.id)).find((t) => t.title === 'Web: hisobot');
  mark = sent.length;
  w = await call(20001, 'DELETE', `/api/tasks/${wJTask.id}`);
  ok('rahbar o\'z bo\'limidagi topshiriqni bekor qiladi → hodimga xabar', w.status === 200 && (await tasks.byId(wJTask.id)).status === 'cancelled' && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 40001 && (s.payload.text || '').includes('bekor qilindi')));

  // bajardim → isbot botda → tekshiruv
  mark = sent.length;
  w = await call(99999, 'POST', `/api/tasks/${wHeadTask.id}/done`);
  ok('«Bajardim» → bot isbot so\'raydi (sessiya ochildi)', w.status === 200 && session.get(99999).step === 'done_proof' && Number(session.get(99999).doneTaskId) === wHeadTask.id && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 99999 && (s.payload.text || '').includes('Isbot majburiy')));
  w = await call(30001, 'POST', `/api/tasks/${wHeadTask.id}/done`);
  ok('boshqaning topshirig\'ini «bajardim» qilib bo\'lmaydi', w.status === 403);
  await send(photo(99999, 'Web orqali bajarildi'));
  ok('botga rasm → tekshiruvga ketdi', (await tasks.byId(wHeadTask.id)).status === 'done');
  w = await call(20001, 'GET', '/api/review');
  ok('rahbar tekshiruv ro\'yxatida ko\'radi (isbot bilan)', w.data.tasks.some((t) => t.id === wHeadTask.id && t.hasProof && t.proofNote === 'Web orqali bajarildi'));
  w = await call(30001, 'GET', '/api/review');
  ok('oddiy hodim tekshiruvga kira olmaydi', w.status === 403);
  w = await call(30001, 'GET', `/api/tasks/${wHeadTask.id}/proof`);
  ok('begona hodim isbot faylini ocha olmaydi', w.status === 403);
  mark = sent.length;
  w = await call(20001, 'POST', `/api/tasks/${wHeadTask.id}/proof/send`);
  ok('isbot rahbar chatiga (qabul tugmalari bilan)', w.status === 200 && sent.slice(mark).some((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 20001 && JSON.stringify(s.payload.reply_markup || {}).includes(`rv:ok:${wHeadTask.id}`)));
  w = await call(99999, 'POST', `/api/tasks/${wHeadTask.id}/accept`);
  ok('hodim o\'z ishini qabul qila olmaydi', w.status === 403);
  mark = sent.length;
  w = await call(20001, 'POST', `/api/tasks/${wHeadTask.id}/accept`);
  ok('rahbar qabul qildi → hodimga xabar', w.status === 200 && (await tasks.byId(wHeadTask.id)).status === 'accepted' && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 99999 && (s.payload.text || '').includes('Qabul qilindi')));
  w = await call(20001, 'POST', `/api/tasks/${wHeadTask.id}/accept`);
  ok('ikkinchi marta qabul — 409', w.status === 409);
  const wT2 = (await tasks.openFor(akbar.id)).find((t) => t.title === 'Web: hisobot');
  await tasks.markDone(wT2.id, akbar.id, { type: 'photo', fileId: 'P2' });
  mark = sent.length;
  w = await call(20001, 'POST', `/api/tasks/${wT2.id}/return`, { note: 'Raqamlar chiqmayapti' });
  const wT2r = await tasks.byId(wT2.id);
  ok('qaytarish (izoh bilan) → hodimga', w.status === 200 && wT2r.status === 'active' && Number(wT2r.returned_count) === 1 && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 99999 && (s.payload.text || '').includes('Raqamlar chiqmayapti')));

  // davomat (hodimning o'zi)
  w = await call(99999, 'POST', '/api/att/late', { reason: 'Tirbandlik' });
  ok('kelgandan keyin «kech qolaman» — rad', w.status === 400);
  w = await call(99999, 'POST', '/api/att/checkout');
  ok('ikkinchi marta «ketdim» — rad', w.status === 400);
  await db.query('DELETE FROM attendance WHERE employee_id = $1 AND work_date = $2', [sardor.id, bugun]);
  mark = sent.length;
  w = await call(30001, 'POST', '/api/att/late', { reason: 'Shifokorga boraman' });
  ok('«Kech qolaman» → HR va boshliqqa', w.status === 200 && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001 && (s.payload.text || '').includes('Shifokorga boraman')));
  w = await call(30001, 'POST', '/api/att/absence', { reason: 'Kasal bo\'lib qoldim' });
  ok('«Kelmayman» so\'rovi', w.status === 200 && (await attendance.get(sardor.id)).excuse_status === 'pending');
  w = await call(99999, 'GET', '/api/excuses');
  ok('oddiy hodim sababli kun so\'rovlarini ko\'rmaydi', w.status === 403);
  w = await call(20001, 'GET', '/api/excuses');
  ok('bo\'lim rahbari so\'rovni hal qilmaydi (ro\'yxatda yo\'q)', w.status === 403 || !w.data.rows.some((x) => x.employeeId === sardor.id));
  w = await call(50001, 'GET', '/api/excuses');
  const wExc = w.data.rows.find((x) => x.employeeId === sardor.id);
  ok('HR so\'rovni ko\'radi', Boolean(wExc) && wExc.reason.includes('Kasal'));
  mark = sent.length;
  w = await call(50001, 'POST', `/api/excuses/${wExc.attId}`, { status: 'approved' });
  ok('sababli deb tasdiqladi → hodimga', w.status === 200 && (await attendance.get(sardor.id)).excuse_status === 'approved' && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 30001 && (s.payload.text || '').includes('sababli')));
  w = await call(50001, 'POST', `/api/excuses/${wExc.attId}`, { status: 'rejected' });
  ok('qayta qaror — 409', w.status === 409);

  // davomat nazoratchisi (Azizbek)
  w = await call(50001, 'PATCH', `/api/employees/${sardor.id}`, { salary: 1 });
  ok('HR oklad o\'zgartira olmaydi', w.status === 403);
  w = await call(50001, 'PATCH', `/api/employees/${sardor.id}`, { isViewer: true });
  ok('HR «davomat nazorati» ruxsatini beradi', w.status === 200 && employees.isViewer(await employees.byTgId(30001)));
  w = await call(30001, 'GET', '/api/att/today');
  ok('nazoratchi hamma hodim davomatini ko\'radi', w.status === 200 && w.data.rows.some((x) => x.name === 'Akbar Karimov') && w.data.rows.some((x) => x.name.startsWith('Abbos')));
  ok('nazoratchida video tugmasi yo\'q', w.data.rows.every((x) => !x.hasVideo && x.attId === undefined));
  w = await call(30001, 'GET', `/api/att/month/${month}`);
  ok('nazoratchi: davomat % va KPI %, pulsiz', w.status === 200 && w.data.rows.length > 2 && !JSON.stringify(w.data).match(/salary|bonus|so'm/));
  const vChecks = await Promise.all([
    call(30001, 'GET', `/api/employees/${akbar.id}`), call(30001, 'GET', `/api/kpi/${month}`), call(30001, 'GET', `/api/tasks/${wHeadTask.id}/proof`), call(30001, 'GET', '/api/employees'),
  ]);
  ok('nazoratchi topshiriq, KPI summasi va kartochkalarni ko\'ra olmaydi', vChecks.every((x) => x.status === 403));
  w = await call(99999, 'GET', '/api/att/today');
  ok('ruxsatsiz hodim davomat nazoratiga kira olmaydi', w.status === 403);
  await call(50001, 'PATCH', `/api/employees/${sardor.id}`, { isViewer: false });

  // hodimlar
  w = await call(20001, 'GET', '/api/employees');
  const bIds = w.data.employees.map((e) => e.id);
  ok('rahbar — faqat jamoasi, pulsiz', bIds.includes(akbar.id) && !bIds.includes(abbosE.id) && w.data.employees.every((e) => !('salary' in e)));
  w = await call(1000, 'GET', '/api/employees');
  ok('direktor — hamma, oklad bilan', w.data.employees.some((e) => e.id === abbosE.id) && w.data.employees.every((e) => 'salary' in e));
  w = await call(20001, 'GET', `/api/employees/${abbosE.id}`);
  ok('rahbar boshqa bo\'lim kartochkasini ochmaydi', w.status === 403);
  w = await call(1000, 'PATCH', `/api/employees/${akbar.id}`, { salary: 3000000, bonusFund: 1000000, workStart: '9:30' });
  const akbarW = await employees.byId(akbar.id);
  ok('direktor: oklad, KPI summasi, ish vaqti', w.status === 200 && Number(akbarW.salary) === 3000000 && Number(akbarW.bonus_fund) === 1000000 && akbarW.work_start === '09:30');
  mark = sent.length;
  w = await call(1000, 'PATCH', `/api/employees/${akbar.id}`, { role: 'head' });
  ok('rol o\'zgarishi → hodimga xabar', w.status === 200 && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 99999 && (s.payload.text || '').includes('rolingiz')));
  await call(1000, 'PATCH', `/api/employees/${akbar.id}`, { role: 'employee', workStart: null });
  w = await call(1000, 'PATCH', `/api/employees/${akbar.id}`, { tg_id: 1 });
  ok('noma\'lum maydon — 400', w.status === 400);
  w = await call(99999, 'PATCH', `/api/employees/${akbar.id}`, { salary: 99999999 });
  ok('hodim o\'z okladini o\'zgartira olmaydi', w.status === 403 && Number((await employees.byId(akbar.id)).salary) === 3000000);
  w = await call(50001, 'PATCH', `/api/employees/${abbosE.id}`, { isViewer: true, role: 'admin' });
  ok('HR o\'zini direktor qila olmaydi', w.status === 403 && (await employees.byId(abbosE.id)).role === 'head');
  mark = sent.length;
  await requests.create({ tgId: 88888, fullName: 'Web Hodim', username: 'webhodim' });
  w = await call(1000, 'GET', '/api/requests');
  ok('kutilayotgan so\'rovlar', w.data.requests.some((x) => x.tgId === 88888));
  w = await call(1000, 'POST', '/api/employees', { tgId: 88888, fullName: 'Web Hodim', position: 'Operator', departmentId: buxId, role: 'employee' });
  ok('yangi hodim qo\'shildi → «Xush kelibsiz», so\'rov yopildi', w.status === 200 && w.data.employee.department.id === buxId && !(await requests.pendingOf(88888)) && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 88888 && (s.payload.text || '').includes('Xush kelibsiz')));
  w = await call(1000, 'POST', '/api/employees', { tgId: 88888, fullName: 'Takror', role: 'employee' });
  ok('takror qo\'shish — 409', w.status === 409);
  w = await call(20001, 'POST', '/api/employees', { tgId: 66666, fullName: 'Rahbar qo\'shdi', role: 'admin' });
  ok('rahbar hodim qo\'sha olmaydi', w.status === 403 && !(await employees.byTgId(66666)));
  w = await call(1000, 'POST', `/api/employees/${sardor.id}/excuse`, { date: time.addDays(bugun, -1), reason: "Ta'til" });
  ok('direktor kunni sababli deb belgiladi', w.status === 200 && (await attendance.get(sardor.id, time.addDays(bugun, -1))).excuse_status === 'approved');
  const webEmp = await employees.byTgId(88888);
  w = await call(1000, 'PATCH', `/api/employees/${webEmp.id}`, { active: false });
  ok('ishdan ketdi (web) → ro\'yxatdan chiqdi', w.status === 200 && Number((await employees.byId(webEmp.id)).active) === 0 && (await call(88888, 'GET', '/api/me')).status === 403);

  // tashkilot
  w = await call(50001, 'GET', '/api/org');
  ok('HR tashkilotni ko\'radi (tahrirsiz)', w.status === 200 && w.data.canEdit === false && w.data.directions.length >= 5);
  w = await call(50001, 'POST', '/api/departments', { name: 'HR bo\'limi' });
  ok('HR bo\'lim yarata olmaydi', w.status === 403);
  w = await call(1000, 'POST', '/api/departments', { name: 'Web bo\'lim' });
  const wDep = w.data.id;
  ok('direktor bo\'lim yaratdi', w.status === 200 && w.data.created);
  w = await call(1000, 'PATCH', `/api/departments/${wDep}`, { weights: [50, 20, 20, 10], customName: 'Sotuv rejasi' });
  ok('vaznlar va mezon nomi', w.status === 200 && Number((await departments.byId(wDep)).w_tasks) === 50);
  w = await call(1000, 'PATCH', `/api/departments/${wDep}`, { weights: [50, 50, 50, 0] });
  ok('yig\'indisi 100 bo\'lmagan vazn — 400', w.status === 400);
  w = await call(1000, 'DELETE', `/api/departments/${wDep}`);
  ok('bo\'lim yopildi', w.status === 200 && Number((await departments.byId(wDep)).active) === 0);
  w = await call(1000, 'POST', `/api/employees/${sardor.id}/directions/${moliya.id}`);
  ok('yo\'nalish almashtirildi (web)', w.status === 200 && w.data.on === false);
  await call(1000, 'POST', `/api/employees/${sardor.id}/directions/${moliya.id}`);

  // KPI
  w = await call(50001, 'GET', `/api/kpi/${month}`);
  ok('HR KPI ro\'yxatini summalar bilan ko\'radi', w.status === 200 && w.data.canEdit === false && w.data.rows.some((k) => k.employeeId === akbar.id && 'bonus' in k));
  w = await call(50001, 'PATCH', `/api/kpi/${month}/${akbar.id}`, { customPct: 100 });
  ok('HR KPI ni o\'zgartira olmaydi', w.status === 403);
  await kpi.decide(akbar.id, month, 'draft', 1000);
  w = await call(1000, 'PATCH', `/api/kpi/${month}/${akbar.id}`, { customPct: 80, headScore: 9 });
  ok('direktor mezon va bahoni kiritdi', w.status === 200 && w.data.kpi.customPct === 80 && w.data.kpi.headScore === 9);
  mark = sent.length;
  w = await call(1000, 'POST', `/api/kpi/${month}/${akbar.id}/decide`, { status: 'confirmed' });
  ok('tasdiqlandi → hodimga natija', w.status === 200 && w.data.kpi.status === 'confirmed' && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 99999 && (s.payload.text || '').includes('tasdiqlandi')));
  w = await call(1000, 'PATCH', `/api/kpi/${month}/${akbar.id}`, { customPct: 10 });
  ok('tasdiqlangan KPI o\'zgarmaydi — 409', w.status === 409);
  w = await call(20001, 'POST', `/api/scores/${month}/${akbar.id}`, { score: 7 });
  ok('tasdiqlangan oyga rahbar bahosi — 409', w.status === 409);
  await call(1000, 'POST', `/api/kpi/${month}/${akbar.id}/decide`, { status: 'draft' });
  w = await call(20001, 'POST', `/api/scores/${month}/${akbar.id}`, { score: 7, note: 'Yaxshi' });
  ok('rahbar o\'z hodimini baholadi', w.status === 200 && Number((await kpi.get(akbar.id, month)).head_score) === 7);
  w = await call(20001, 'POST', `/api/scores/${month}/${abbosE.id}`, { score: 3 });
  ok('rahbar boshqa bo\'limni baholay olmaydi', w.status === 403);
  w = await call(20001, 'POST', `/api/scores/${month}/${akbar.id}`, { score: 11 });
  ok('baho 1–10 tekshiriladi', w.status === 400);
  mark = sent.length;
  w = await call(50001, 'POST', `/api/kpi/${month}/excel`);
  ok('HR Excel ni chatga oladi', w.status === 200 && sent.slice(mark).some((s) => s.method === 'sendDocument' && Number(s.payload.chat_id) === 50001));

  // oylik
  w = await call(99999, 'GET', '/api/pay');
  ok('hodim oylik: oklad + KPI', w.status === 200 && w.data.months[0].salary === 3000000);
  w = await call(99999, 'GET', `/api/pay/${month}`);
  ok('oylik tafsiloti (KPI sharti)', w.status === 200 && typeof w.data.kpi.eligible === 'boolean' && w.data.pay.bonusFund === 1000000);

  // eslatmalar
  mark = sent.length;
  w = await call(99999, 'POST', '/api/reminders', { times: '10:00, 15:30' });
  ok('eslatma so\'rovi → faqat boshliqqa', w.status === 200 && (await employees.byId(akbar.id)).remind_pending === '10:00,15:30' && sent.slice(mark).some((s) => Number(s.payload.chat_id) === 1000 && JSON.stringify(s.payload.reply_markup || {}).includes(`rs:ok:${akbar.id}`)) && !sent.slice(mark).some((s) => Number(s.payload.chat_id) === 50001));
  w = await call(20001, 'GET', '/api/reminders/pending');
  ok('oddiy rahbar eslatma so\'rovini tasdiqlamaydi', w.status === 403);
  w = await call(50001, 'POST', `/api/reminders/${akbar.id}`, { approve: true });
  ok('HR tasdiqlay olmaydi — 403', w.status === 403);
  w = await call(1000, 'POST', `/api/reminders/${akbar.id}`, { approve: true });
  ok('boshliq tasdiqladi', w.status === 200 && (await employees.byId(akbar.id)).remind_times === '10:00,15:30');
  w = await call(1000, 'POST', `/api/reminders/${akbar.id}`, { approve: true });
  ok('takror qaror — 409', w.status === 409);
  await call(99999, 'POST', '/api/reminders', { reset: true });

  // sozlamalar
  w = await call(50001, 'GET', '/api/settings');
  ok('HR sozlamalarga kira olmaydi', w.status === 403);
  w = await call(1000, 'GET', '/api/settings');
  const wsBefore = w.data.workStart;
  ok('direktor sozlamalari', w.status === 200 && /^\d{2}:\d{2}$/.test(wsBefore));
  w = await call(1000, 'POST', '/api/settings/worktime', { workStart: '25:00' });
  ok('noto\'g\'ri vaqt — 400', w.status === 400);
  w = await call(1000, 'POST', '/api/settings/worktime', { workStart: wsBefore });
  ok('ish vaqti saqlandi (xabar bilan)', w.status === 200 && w.data.workStart === wsBefore);
  w = await call(1000, 'POST', '/api/settings/remind-step', { step: 2 });
  ok('eslatma oralig\'i', w.status === 200 && (await require('../src/services/reminders').globalStep()) === 2);

  // bot: /ilova va menyu tugmasi
  await send(msg(99999, '/ilova'));
  ok('WEBAPP_URL yo\'q — /ilova ogohlantiradi', lastText(99999).includes('ulanmagan'));
  config.webAppUrl = 'https://bayoma.test/app';
  mark = sent.length;
  await send(msg(99999, '/ilova'));
  const ilova = sent.slice(mark).find((s) => s.method === 'sendMessage' && Number(s.payload.chat_id) === 99999);
  ok('/ilova — web_app tugmasi', ilova && JSON.stringify(ilova.payload.reply_markup).includes('"web_app":{"url":"https://bayoma.test/app"}'));
  ok('menyu tugmasi faqat shu chatga', sent.slice(mark).some((s) => s.method === 'setChatMenuButton' && Number(s.payload.chat_id) === 99999 && s.payload.menu_button.type === 'web_app'));
  mark = sent.length;
  await send(msg(77777, '/ilova'));
  ok('begonaga /ilova — tugma yo\'q', !sent.slice(mark).some((s) => JSON.stringify(s.payload.reply_markup || {}).includes('web_app')));
  config.webAppUrl = '';

  // =========================================================================
  console.log('\n— 24. Rahbariyat (boshliq + HR) tasdiqlaydi, texnik direktordan so\'ralmaydi, o\'chirib bo\'lmaydi —');
  // boshliq-hodim (Odilxon): bazada role='admin'. Shundan keyin ADMIN_IDS (1000, 60001) — texnik direktor
  USERS[70001] = { id: 70001, first_name: 'Odilxon', username: 'odilxon' };
  USERS[80001] = { id: 80001, first_name: 'Nasiba', username: 'nasiba' };
  const odil = (await employees.add({ tgId: 70001, fullName: 'Odilxon', position: 'Boshliq', role: 'admin' })).employee;
  const nasiba = (await employees.add({ tgId: 80001, fullName: 'Nasiba', position: 'Operator', role: 'employee' })).employee;
  await months.confirm(odil.id); await months.confirm(nasiba.id);
  ok('boshliq = bazadagi direktor-hodim (texnik direktorlar emas)', JSON.stringify(await employees.bossTgIds()) === '[70001]');
  ok('rahbariyat: Odilxon va HR', employees.isTop(odil) && employees.isTop(await employees.byTgId(50001)) && !employees.isTop(nasiba));

  mark = sent.length;
  await send(msg(80001, '🔔 Eslatmalar'));
  await send(cbq(80001, 'rm:int:3'));
  const rq80 = sent.slice(mark).filter((x) => JSON.stringify(x.payload.reply_markup || {}).includes(`rs:ok:${nasiba.id}`)).map((x) => Number(x.payload.chat_id)).sort();
  ok('eslatma so\'rovi faqat Odilxonga (HR ga emas)', JSON.stringify(rq80) === JSON.stringify([70001]));
  ok('texnik direktorlarga (1000, 60001) so\'rov bormaydi', !sent.slice(mark).some((x) => [1000, 60001].includes(Number(x.payload.chat_id))));
  await send(cbq(1000, `rs:ok:${nasiba.id}`));
  await send(cbq(70001, `rs:ok:${nasiba.id}`));
  ok('Odilxon tasdiqladi', Boolean((await employees.byTgId(80001)).remind_times));

  mark = sent.length;
  await send(msg(70001, '🔔 Eslatmalar'));
  await send(cbq(70001, 'rm:int:2'));
  ok('Odilxon o\'zi o\'zgartirsa — so\'rovsiz darhol', Boolean((await employees.byTgId(70001)).remind_times) && !(await employees.byTgId(70001)).remind_pending && lastText(70001).includes("o'zgardi"));
  ok('Odilxonning o\'zgarishi uchun hech kimga so\'rov ketmadi', !sent.slice(mark).some((x) => JSON.stringify(x.payload.reply_markup || {}).includes(`rs:ok:${odil.id}`)));
  await send(msg(50001, '🔔 Eslatmalar'));
  ok('HR da eslatma sozlamalari yo\'q', lastText(50001).includes('boshliq belgilaydi') && !findCb(50001, /^rm:int:4$/));
  await send(cbq(50001, 'rm:int:4'));
  ok('HR eslatma vaqtini o\'zgartira olmaydi', !(await employees.byTgId(50001)).remind_times && !(await employees.byTgId(50001)).remind_pending);

  mark = sent.length;
  await send(msg(80001, '🙋 Kelmayman (sabab)'));
  await send(msg(80001, 'Bolam kasal'));
  const abN = (await attendance.get(nasiba.id));
  const withBtn = sent.slice(mark).filter((x) => JSON.stringify(x.payload.reply_markup || {}).includes(`ab:ok:${abN.id}`)).map((x) => Number(x.payload.chat_id)).sort();
  ok('kelmayman tugmalari faqat Odilxon va HR ga', JSON.stringify(withBtn) === JSON.stringify([50001, 70001]));
  ok('texnik direktor ma\'lumot oladi, tugmasiz', sent.slice(mark).some((x) => Number(x.payload.chat_id) === 1000 && (x.payload.text || '').includes('Bolam kasal') && !JSON.stringify(x.payload.reply_markup || {}).includes('ab:ok')));
  await send(msg(70001, '🙋 Kelmayman (sabab)'));
  ok('Odilxon (kompaniya rahbari) — kelmayman yuritilmaydi', lastText(70001).includes('kompaniya rahbari') && !(await attendance.get(odil.id)));

  // muddati o'tgan o'z vazifasi — tahrirlab ham, o'chirib ham bo'lmaydi
  const old = await tasks.create({ employeeId: nasiba.id, title: 'Eski vazifa', dueDate: time.addDays(bugun, -1), createdBy: 80001, source: 'self' });
  await send(cbq(80001, `tk:${old.id}`));
  ok('muddati o\'tgan o\'z vazifasini tahrirlab bo\'lmaydi', lastText(80001).includes("Muddati o'tgan"));
  await send(cbq(80001, `tk:dued:${old.id}:7`));
  ok('muddatini uzaytirib bo\'lmaydi', (await tasks.byId(old.id)).due_date === time.addDays(bugun, -1));
  w = await call(80001, 'DELETE', `/api/tasks/${old.id}`);
  ok('ilovada ham o\'z vazifasini o\'chirib bo\'lmaydi', w.status === 403 && (await tasks.byId(old.id)).status === 'active');
  w = await call(80001, 'PATCH', `/api/tasks/${old.id}`, { due: time.addDays(bugun, 5) });
  ok('ilovada ham muddatini uzaytirib bo\'lmaydi', w.status === 403);
  w = await call(50001, 'DELETE', `/api/tasks/${old.id}`);
  ok('HR bekor qila oladi — yozuv qoladi', w.status === 200 && (await tasks.byId(old.id)).status === 'cancelled' && Number((await tasks.byId(old.id)).cancelled_by) === 50001);

  // =========================================================================
  console.log('\n— 25. Bajardim — fayl (PDF, Excel…) bilan ham —');
  const fTask = await tasks.create({ employeeId: akbar.id, title: 'Oylik hisobot fayli', dueDate: bugun, createdBy: 20001, source: 'head' });
  await send(msg(99999, '✔️ Bajardim'));
  await send(cbq(99999, `done:${fTask.id}`));
  ok('isbot so\'rovida fayl ham aytilgan', lastText(99999).includes('fayl'));
  mark = sent.length;
  await send({ update_id: (uid += 1), message: { ...base(99999), document: { file_id: 'DOC_FILE_ID', file_name: 'hisobot-oktabr.xlsx', mime_type: 'application/vnd.ms-excel' } } });
  const fT = await tasks.byId(fTask.id);
  ok('fayl bilan bajarildi (izoh — fayl nomi)', fT.status === 'done' && fT.proof_type === 'document' && fT.proof_file_id === 'DOC_FILE_ID' && fT.proof_note.includes('hisobot-oktabr.xlsx'));
  ok('tekshiruvchiga fayl + qabul/qaytarish tugmalari', sent.slice(mark).some((x) => x.method === 'sendDocument' && Number(x.payload.chat_id) === 20001 && JSON.stringify(x.payload.reply_markup || {}).includes(`rv:ok:${fTask.id}`)));

  // =========================================================================
  console.log('\n— 26. Topshiriq nusxalari: direktor va HR — nusxasiz, rahbar — sozlamaga qarab —');
  {
    const flows = require('../src/services/flows');
    const access = require('../src/services/access');
    const org = require('../src/services/org');
    const tgBot = { telegram: bot.telegram };
    mark = sent.length;
    await flows.assignTasks(tgBot, await access.resolve(hrTg), akbar, ['HR topshirig\'i — nusxasiz'], bugun);
    ok('HR bergan topshiriq: hodimga boradi, direktorga nusxa yo\'q', countSince(mark, 99999) === 1 && countSince(mark, 1000) === 0);
    mark = sent.length;
    await flows.assignTasks(tgBot, await access.resolve(1000), akbar, ['Direktor topshirig\'i — nusxasiz'], bugun);
    ok('direktor bergan topshiriq: HR ga nusxa yo\'q', countSince(mark, 99999) === 1 && countSince(mark, hrTg) === 0);
    mark = sent.length;
    await flows.assignTasks(tgBot, await access.resolve(20001), akbar, ['Rahbar topshirig\'i — nusxa bilan'], bugun);
    ok('rahbar bergan topshiriq: standart — direktor va HR ga nusxa', countSince(mark, 1000) === 1 && countSince(mark, hrTg) === 1);
    await send(msg(1000, '/panel'));
    ok('panelda nusxa tugmasi (yoqilgan)', findCb(1000, /^adm:htc$/) && JSON.stringify(to(1000).slice(-1)[0].payload.reply_markup).includes('yoqilgan'));
    await send(cbq(hrTg, 'adm:htc'));
    ok('HR nusxa sozlamasini o\'zgartira olmaydi', (await org.headTaskCopy()) === true);
    await send(cbq(1000, 'adm:htc'));
    ok('direktor o\'chirdi', (await org.headTaskCopy()) === false);
    mark = sent.length;
    await flows.assignTasks(tgBot, await access.resolve(20001), akbar, ['Rahbar topshirig\'i — nusxasiz'], bugun);
    ok('o\'chiq: rahbar bergan topshiriq hodimga boradi, nusxa yo\'q', countSince(mark, 99999) === 1 && countSince(mark, 1000) === 0 && countSince(mark, hrTg) === 0);
    w = await call(1000, 'POST', '/api/settings/head-task-copy', { on: true });
    ok('ilovada qayta yoqildi', w.status === 200 && (await org.headTaskCopy()) === true);
    w = await call(hrTg, 'POST', '/api/settings/head-task-copy', { on: false });
    ok('ilovada HR o\'zgartira olmaydi', w.status === 403 && (await org.headTaskCopy()) === true);
  }

  // =========================================================================
  console.log('\n— 27. Boshliq rejimi: davomat yo\'q, o\'z missiyasi isbotsiz —');
  {
    const flows = require('../src/services/flows');
    const reports = require('../src/services/reports');
    const lastKb = (chatId) => { const l = to(chatId).filter((x) => x.payload.reply_markup && x.payload.reply_markup.keyboard).slice(-1)[0]; return l ? JSON.stringify(l.payload.reply_markup.keyboard) : ''; };
    await send(msg(70001, '/menu'));
    const kb = lastKb(70001);
    ok('Odilxon klaviaturasida Keldim/Ketdim/Kech qolaman/Kelmayman/Oylik yo\'q', kb && !/keldim/i.test(kb) && !/ketdim/i.test(kb) && !kb.includes('Kech qolaman') && !kb.includes('Kelmayman') && !kb.includes('Oylik') && kb.includes('Panel'));
    await send(msg(80001, '/menu'));
    ok('oddiy hodimda Keldim bor', /keldim/i.test(lastKb(80001)) && lastKb(80001).includes('Kech qolaman'));
    for (const t of ['✅ Keldim', '🏁 Ketdim', '⏰ Kech qolaman', '/keldim', '/oylik']) {
      await send(msg(70001, t));
    }
    ok('Odilxon Keldim / Ketdim / Kech / oylik bossa — rad, davomat yozilmaydi', lastText(70001).includes('kompaniya rahbari') && !(await attendance.get(odil.id)) && session.get(70001).step !== 'late_notice');
    w = await call(70001, 'POST', '/api/att/late', { reason: 'test' });
    ok('ilovada ham kech qolaman — 403', w.status === 403);
    w = await call(70001, 'GET', '/api/pay');
    ok('ilovada oylik — 403', w.status === 403);
    w = await call(70001, 'GET', '/api/me');
    ok('ilova: isBoss, davomat bloki yo\'q, oy tasdig\'i so\'ralmaydi', w.status === 200 && w.data.roles.isBoss === true && !w.data.attendance && w.data.monthConfirmed === true);
    ok('KPI ro\'yxatida Odilxon yo\'q', !(await kpi.computeAll(month)).some((r) => Number(r.employee_id) === Number(odil.id)));
    ok('ertalabki holat va bugungi holatda Odilxon yo\'q', !(await reports.buildMorningDigest()).text.includes('Odilxon') && !(await reports.buildToday()).text.includes('Odilxon'));
    ok('oy boshi ro\'yxatida Odilxon yo\'q', !(await months.statusOf(month)).waiting.concat((await months.statusOf(month)).confirmed).some((r) => Number(r.id) === Number(odil.id)));

    mark = sent.length;
    const own = await flows.addSelfTasks({ telegram: bot.telegram }, odil, ['Investor bilan uchrashuv'], bugun);
    ok('Odilxon o\'ziga missiya yozdi — hech kimga xabar yo\'q', own.length === 1 && countSince(mark, 50001) === 0 && countSince(mark, 1000) === 0);
    await send(cbq(70001, `done:${own[0].id}`));
    ok('isbot ixtiyoriy — «Isbotsiz bajardim» tugmasi', lastText(70001).includes('ixtiyoriy') && findCb(70001, /^done:np$/));
    mark = sent.length;
    await send(cbq(70001, 'done:np'));
    const ownT = await tasks.byId(own[0].id);
    ok('isbotsiz — «Jarayonda» ga o\'tmasdan darhol bajarildi (accepted)', ownT.status === 'accepted' && !ownT.proof_type && Number(ownT.reviewed_by) === 70001);
    ok('tekshiruvga hech kimga yuborilmadi', countSince(mark, 50001) === 0 && countSince(mark, 1000) === 0);

    const own2 = await tasks.create({ employeeId: odil.id, title: 'Shartnoma imzolash', dueDate: bugun, createdBy: 70001, source: 'self' });
    await send(cbq(70001, `done:${own2.id}`));
    await send({ update_id: (uid += 1), message: { ...base(70001), photo: [{ file_id: 'BOSS_PHOTO' }], caption: 'imzolandi' } });
    ok('isbot bilan ham — darhol bajarildi', (await tasks.byId(own2.id)).status === 'accepted' && (await tasks.byId(own2.id)).proof_type === 'photo');

    const own3 = await tasks.create({ employeeId: odil.id, title: 'Bank bilan uchrashuv', dueDate: bugun, createdBy: 70001, source: 'self' });
    w = await call(70001, 'POST', `/api/tasks/${own3.id}/done`);
    ok('ilovada ham — isbotsiz darhol bajarildi', w.status === 200 && w.data.accepted === true && (await tasks.byId(own3.id)).status === 'accepted');

    const nTask = await tasks.create({ employeeId: nasiba.id, title: 'Hodim vazifasi', dueDate: bugun, createdBy: 80001, source: 'self' });
    await send(cbq(80001, `done:${nTask.id}`));
    ok('hodimda «Isbotsiz» tugmasi yo\'q', !findCb(80001, /^done:np$/));
    await send(cbq(80001, 'done:np'));
    ok('hodim isbotsiz bajara olmaydi', (await tasks.byId(nTask.id)).status === 'active');
    session.clear(80001);
    const hrTask = await tasks.create({ employeeId: (await employees.byTgId(50001)).id, title: 'HR o\'z vazifasi', dueDate: bugun, createdBy: 50001, source: 'self' });
    await send(cbq(50001, `done:${hrTask.id}`));
    await send(cbq(50001, 'done:np'));
    ok('HR ham isbotsiz bajara olmaydi', (await tasks.byId(hrTask.id)).status === 'active');
    session.clear(50001);
  }

  // =========================================================================
  console.log('\n— 28. «📋 Barcha topshiriqlar» jurnali (boshliq/direktor va HR) —');
  {
    const lastKb = (chatId) => { const l = to(chatId).filter((x) => x.payload.reply_markup && x.payload.reply_markup.keyboard).slice(-1)[0]; return l ? JSON.stringify(l.payload.reply_markup.keyboard) : ''; };
    const hrName = (await employees.byTgId(50001)).full_name;
    await send(msg(70001, '/menu'));
    await send(msg(50001, '/menu'));
    await send(msg(20001, '/menu'));
    ok('jurnal tugmasi: Odilxon va HR da bor, rahbarda yo\'q', lastKb(70001).includes('Barcha topshiriqlar') && lastKb(50001).includes('Barcha topshiriqlar') && !lastKb(20001).includes('Barcha topshiriqlar'));

    await send(msg(70001, '📋 Barcha topshiriqlar'));
    let jt = lastText(70001);
    ok('Odilxon hamma topshiriqni ko\'radi (HR, direktor, rahbar bergan, o\'zi yozgan)', jt.includes('BARCHA TOPSHIRIQLAR') && jt.includes("HR topshirig'i") && jt.includes("Direktor topshirig'i") && jt.includes("Rahbar topshirig'i") && jt.includes('Investor'));
    ok('har qatorda kim bergan va qachon', jt.includes(hrName) && jt.includes('(HR)') && jt.includes("o'zi yozgan") && jt.includes('🗓'));
    await send(cbq(70001, 'tj:w:hr:a:0:0'));
    jt = lastText(70001);
    ok('filtr: faqat HR bergan', jt.includes("HR topshirig'i") && !jt.includes("Direktor topshirig'i") && !jt.includes('Investor'));
    await send(cbq(70001, 'tj:w:self:a:0:0'));
    ok('filtr: o\'zi yozgan missiyalar', lastText(70001).includes('Investor') && !lastText(70001).includes("HR topshirig'i"));
    await send(cbq(70001, 'tj:w:a:accepted:0:0'));
    ok('filtr: bajarilganlar', lastText(70001).includes('Investor') && !lastText(70001).includes("Rahbar topshirig'i"));
    await send(cbq(70001, `tj:w:a:a:${odil.id}:0`));
    ok('filtr: hodim bo\'yicha', lastText(70001).includes('Investor') && !lastText(70001).includes("HR topshirig'i"));
    await send(cbq(70001, 'tj:emps'));
    ok('hodim tanlash ro\'yxati', findCb(70001, new RegExp(`^tj:w:a:a:${akbar.id}:0$`)));

    const hrT = await db.one("SELECT id FROM tasks WHERE title LIKE 'HR topshirig%' ORDER BY id LIMIT 1");
    await send(cbq(70001, `tj:t:${hrT.id}`));
    jt = lastText(70001);
    ok('kartochka: kimga, kim bergan, qachon, muddat, holat', jt.includes('Kimga') && jt.includes('Akbar') && jt.includes(hrName) && jt.includes('Berilgan') && jt.includes('Muddat') && jt.includes('Holat'));
    const photoT = await db.one("SELECT id FROM tasks WHERE title = 'Shartnoma imzolash'");
    await send(cbq(70001, `tj:t:${photoT.id}`));
    ok('isbotli kartochkada «Isbotni ko\'rish»', findCb(70001, new RegExp(`^tj:p:${photoT.id}$`)));
    mark = sent.length;
    await send(cbq(70001, `tj:p:${photoT.id}`));
    ok('isbot yuborildi', sent.slice(mark).some((x) => x.method === 'sendPhoto' && Number(x.payload.chat_id) === 70001));

    await send(msg(50001, '📋 Barcha topshiriqlar'));
    ok('HR ham hammasini ko\'radi (direktor bergani, Odilxon missiyasi ham)', lastText(50001).includes("Direktor topshirig'i") && lastText(50001).includes('Investor'));
    await send(msg(1000, '/jurnal'));
    ok('texnik direktor ham ko\'radi', lastText(1000).includes('BARCHA TOPSHIRIQLAR'));
    for (const who of [20001, 30001, 80001]) await send(msg(who, '/jurnal'));
    ok('rahbar, nazoratchi, hodim — ko\'ra olmaydi', [20001, 30001, 80001].every((who) => !lastText(who).includes('BARCHA TOPSHIRIQLAR')));
    mark = sent.length;
    await send(cbq(20001, 'tj:w:a:a:0:0'));
    ok('rahbar jurnal tugmasini bossa — rad', countSince(mark, 20001, 'editMessageText') === 0 && countSince(mark, 20001, 'sendMessage') === 0);

    w = await call(70001, 'GET', '/api/tasks/all?period=w');
    ok('ilova: jurnal (Odilxon)', w.status === 200 && w.data.tasks.some((t) => t.title.includes('Investor') && t.giverKind === 'self') && w.data.tasks.some((t) => t.giverKind === 'hr' && t.giverName === hrName));
    w = await call(50001, 'GET', '/api/tasks/all?period=m&giver=admin');
    ok('ilova: HR, filtr direktor', w.status === 200 && w.data.tasks.length > 0 && w.data.tasks.every((t) => t.giverKind === 'admin'));
    w = await call(50001, 'GET', `/api/tasks/all?period=w&status=accepted&emp=${odil.id}`);
    ok('ilova: holat + hodim filtri', w.status === 200 && w.data.tasks.length >= 2 && w.data.tasks.every((t) => t.kind === 'accepted' && t.employee.id === Number(odil.id)));
    w = await call(20001, 'GET', '/api/tasks/all');
    ok('ilova: rahbar — 403', w.status === 403);
    w = await call(30001, 'GET', '/api/tasks/all');
    ok('ilova: nazoratchi — 403', w.status === 403);
    w = await call(70001, 'GET', '/api/tasks/all?giver=xyz');
    ok('ilova: noto\'g\'ri filtr — 400', w.status === 400);
  }

  // =========================================================================
  console.log('\n— 29. Topshiriq ovoz / video / fayl bilan; «Eshitdim, tushundim» —');
  {
    const flows = require('../src/services/flows');
    const reports = require('../src/services/reports');
    const access = require('../src/services/access');
    const tgBot = { telegram: bot.telegram };
    const hasCb = (x, re) => JSON.stringify(x.payload.reply_markup || {}).match(re);
    session.clear(99999); session.clear(20001);

    await send(msg(20001, '📤 Topshiriq berish'));
    await send(cbq(20001, `as:emp:${akbar.id}`));
    ok('topshiriq so\'rovida ovoz/video/fayl aytilgan', lastText(20001).includes('ovozli xabar') && lastText(20001).includes('fayl'));
    await send({ update_id: (uid += 1), message: { ...base(20001), voice: { file_id: 'VOICE_TASK', duration: 12 } } });
    ok('ovozli xabar qabul qilindi — muddat so\'raladi', findCb(20001, /^as:due:0$/) && session.get(20001).step === 'assign_due');
    mark = sent.length;
    await send(cbq(20001, 'as:due:0'));
    const vT = await db.one("SELECT * FROM tasks WHERE task_file_id = 'VOICE_TASK'");
    ok('ovozli topshiriq yaratildi', vT && vT.task_media_type === 'voice' && vT.title.includes('Ovozli topshiriq') && vT.source === 'head');
    const toAkbar = sent.slice(mark).filter((x) => Number(x.payload.chat_id) === 99999);
    ok('hodimga matn + ovozli xabar + «Tushundim» tugmasi', toAkbar.some((x) => (x.payload.text || '').includes('Yangi topshiriq')) && toAkbar.some((x) => x.method === 'sendVoice' && hasCb(x, new RegExp(`ak:${vT.id}`))));
    await send(msg(99999, '📋 Topshiriqlarim'));
    ok('Topshiriqlarim: 🎤 belgisi va «tushundim» eslatmasi', lastText(99999).includes('🎤') && lastText(99999).includes('Tushundim') && findCb(99999, new RegExp(`^ak:${vT.id}$`)));
    mark = sent.length;
    await send(cbq(99999, `tk:media:${vT.id}`));
    ok('hodim topshiriqni qayta eshitadi', sent.slice(mark).some((x) => x.method === 'sendVoice' && Number(x.payload.chat_id) === 99999));
    mark = sent.length;
    await send(cbq(80001, `tk:media:${vT.id}`));
    ok('begona hodim boshqaning topshirig\'ini ocholmaydi', countSince(mark, 80001, 'sendVoice') === 0);
    mark = sent.length;
    await send(cbq(99999, `ak:${vT.id}`));
    ok('«Eshitdim, tushundim» — belgilandi', Boolean((await tasks.byId(vT.id)).ack_at));
    ok('topshiriq bergan rahbarga xabar: tushundi', sent.slice(mark).some((x) => Number(x.payload.chat_id) === 20001 && (x.payload.text || '').includes('tushundi')));
    await send(cbq(99999, `ak:${vT.id}`));
    ok('ikkinchi marta — allaqachon', sent.slice(-1)[0].method === 'answerCallbackQuery' && String(sent.slice(-1)[0].payload.text).includes('Allaqachon'));

    // direktor — fayl bilan; hodim «tushundim» deb yozadi
    const { created: dT } = await flows.assignTasks(tgBot, await access.resolve(1000), akbar, flows.mediaTitles({ type: 'document', fileName: 'shartnoma.pdf' }, ''), bugun, { media: { type: 'document', fileId: 'DOC_TASK', fileName: 'shartnoma.pdf' } });
    ok('fayl topshiriq: izohsiz — nomi fayl nomi', dT[0].title.includes('shartnoma.pdf') && dT[0].task_media_type === 'document');
    const { created: tT } = await flows.assignTasks(tgBot, await access.resolve(50001), akbar, ['Hisobotni tekshirish'], bugun);
    ok('matnli topshiriqda ham «Tushundim» tugmasi', to(99999).some((x) => hasCb(x, new RegExp(`ak:${tT[0].id}`))));
    mark = sent.length;
    await send(msg(99999, 'Eshitdim va tushundim'));
    ok('«tushundim» deb yozdi — ikkala topshiriq belgilandi', Boolean((await tasks.byId(dT[0].id)).ack_at) && Boolean((await tasks.byId(tT[0].id)).ack_at) && (await tasks.byId(dT[0].id)).ack_note === 'Eshitdim va tushundim');
    ok('direktorga va HR ga — o\'z topshirig\'i bo\'yicha xabar', sent.slice(mark).some((x) => Number(x.payload.chat_id) === 1000 && (x.payload.text || '').includes('shartnoma')) && sent.slice(mark).some((x) => Number(x.payload.chat_id) === 50001 && (x.payload.text || '').includes('Hisobotni')));
    await send(msg(99999, 'tushundim'));
    ok('tasdiqlanmagan topshiriq yo\'q — oddiy javob', lastText(99999).includes('Tushunmadim'));

    // o'ziga vazifa — video bilan
    session.clear(80001);
    await send(msg(80001, "➕ O'zimga vazifa"));
    await send({ update_id: (uid += 1), message: { ...base(80001), video: { file_id: 'SELF_VIDEO', duration: 5 }, caption: 'Ombor qoldig\'ini sanash' } });
    await send(cbq(80001, 'st:due:0'));
    const sT = await db.one("SELECT * FROM tasks WHERE task_file_id = 'SELF_VIDEO'");
    ok('o\'ziga vazifa video bilan, izohi — nomi', sT && sT.title === "Ombor qoldig'ini sanash" && sT.task_media_type === 'video' && sT.source === 'self');
    ok('o\'z vazifasiga «tushundim» kerak emas', !tasks.needsAck(sT));

    // eslatmada tasdiqlanmaganlar
    const { created: rT } = await flows.assignTasks(tgBot, await access.resolve(20001), akbar, ['Kassani yopish'], bugun);
    mark = sent.length;
    await reports.sendReminderTo(tgBot, await employees.byId(akbar.id));
    const rem = sent.slice(mark).find((x) => Number(x.payload.chat_id) === 99999);
    ok('eslatmada «tushundim» qilinmaganlar + tugma', rem && rem.payload.text.includes('Tushundim') && hasCb(rem, new RegExp(`ak:${rT[0].id}`)));

    // jurnal
    await send(cbq(70001, `tj:t:${vT.id}`));
    ok('jurnal kartochkasi: ovozli topshiriq, tushundi vaqti', lastText(70001).includes('Ovozli topshiriq') && lastText(70001).includes('Tushundi:') && findCb(70001, new RegExp(`^tj:m:${vT.id}$`)));
    mark = sent.length;
    await send(cbq(70001, `tj:m:${vT.id}`));
    ok('jurnaldan topshiriqni eshitish', sent.slice(mark).some((x) => x.method === 'sendVoice' && Number(x.payload.chat_id) === 70001));
    await send(msg(70001, '📋 Barcha topshiriqlar'));
    ok('jurnal ro\'yxatida 👂 belgilari', lastText(70001).includes('👂 tushundi') && lastText(70001).includes("«tushundim» yo'q"));

    // ilova
    w = await call(99999, 'GET', '/api/tasks/my');
    const kT = w.data.open.find((t) => t.id === Number(rT[0].id));
    const vO = w.data.open.find((t) => t.id === Number(vT.id));
    ok('ilova: media va needsAck', kT && kT.needsAck === true && vO && vO.media && vO.media.type === 'voice' && vO.needsAck === false);
    w = await call(80001, 'POST', `/api/tasks/${rT[0].id}/ack`);
    ok('ilova: boshqaning topshirig\'ini tasdiqlab bo\'lmaydi', w.status === 403);
    w = await call(99999, 'POST', `/api/tasks/${rT[0].id}/ack`);
    ok('ilova: «Tushundim»', w.status === 200 && Boolean((await tasks.byId(rT[0].id)).ack_at));
    w = await call(99999, 'POST', `/api/tasks/${rT[0].id}/ack`);
    ok('ilova: qayta — 400', w.status === 400);
    w = await call(80001, 'POST', `/api/tasks/${vT.id}/media/send`);
    ok('ilova: begona media — 403', w.status === 403);
    mark = sent.length;
    w = await call(99999, 'POST', `/api/tasks/${vT.id}/media/send`);
    ok('ilova: media botga yuborildi', w.status === 200 && sent.slice(mark).some((x) => x.method === 'sendVoice' && Number(x.payload.chat_id) === 99999));
  }

  // =========================================================================
  console.log('\n— 30. Eslatmalar: faqat boshliq boshqaradi, bo\'lim va hodim bo\'yicha alohida —');
  {
    const reminders = require('../src/services/reminders');
    const jobs3 = require('../src/jobs');
    const lastKb = (chatId) => { const l = to(chatId).filter((x) => x.payload.reply_markup && x.payload.reply_markup.keyboard).slice(-1)[0]; return l ? JSON.stringify(l.payload.reply_markup.keyboard) : ''; };
    await send(msg(50001, '/menu'));
    await send(msg(80001, '/menu'));
    ok('HR menyusida «Eslatmalar» yo\'q, hodimda bor', !lastKb(50001).includes('Eslatmalar') && lastKb(80001).includes('Eslatmalar'));

    await send(msg(70001, '🔔 Eslatmalar'));
    ok('boshliq: boshqaruv ekrani', lastText(70001).includes('boshqaruv') && findCb(70001, /^rm:dl$/) && findCb(70001, /^rm:el$/) && findCb(70001, /^rm:g:2$/));
    await send(cbq(50001, 'rm:adm'));
    await send(cbq(50001, 'rm:g:1'));
    ok('HR boshqaruvga kira olmaydi', (await reminders.globalStep()) !== 1);
    await send(cbq(70001, 'rm:g:2'));
    ok('boshliq umumiy oraliqni o\'zgartirdi', (await reminders.globalStep()) === 2);

    // bo'lim vaqti
    const dept = await departments.byId(akbar.department_id);
    await send(cbq(70001, 'rm:dl'));
    ok('bo\'limlar ro\'yxati', findCb(70001, new RegExp(`^rm:d:${dept.id}$`)));
    await send(cbq(70001, `rm:d:${dept.id}`));
    await send(cbq(70001, `rm:dc:${dept.id}`));
    mark = sent.length;
    await send(msg(70001, '10:15, 14:45'));
    ok('bo\'limga vaqt qo\'yildi', (await departments.byId(dept.id)).remind_times === '10:15,14:45');
    await reminders.reset(akbar.id);
    const ak = await employees.byId(akbar.id);
    ok('o\'z vaqti yo\'q hodim — bo\'lim vaqti', reminders.sourceOf(ak) === 'dept' && JSON.stringify(reminders.timesFor(ak, 2, 540)) === '["10:15","14:45"]');
    ok('bo\'lim a\'zolariga xabar', sent.slice(mark).some((x) => Number(x.payload.chat_id) === 99999 && (x.payload.text || '').includes('10:15')));
    await tasks.create({ employeeId: akbar.id, title: 'Bo\'lim eslatma testi', dueDate: bugun, createdBy: 20001, source: 'head' });
    mark = sent.length;
    await jobs3.remindTick({ telegram: bot.telegram }, 10 * 60 + 15);
    ok('10:15 — bo\'lim vaqtida eslatma bordi', sent.slice(mark).some((x) => Number(x.payload.chat_id) === 99999 && (x.payload.text || '').includes('Eslatma')));
    mark = sent.length;
    await jobs3.remindTick({ telegram: bot.telegram }, 11 * 60);
    ok('11:00 — umumiy vaqtda bormaydi', !sent.slice(mark).some((x) => Number(x.payload.chat_id) === 99999 && (x.payload.text || '').includes('Eslatma')));

    // hodim vaqti — bo'limdan ustun
    await send(cbq(70001, `rm:e:${akbar.id}`));
    ok('hodim kartochkasi: bo\'lim jadvali', lastText(70001).includes("bo'lim jadvali"));
    await send(cbq(70001, `rm:ei:${akbar.id}:3`));
    let ak2 = await employees.byId(akbar.id);
    ok('hodimga alohida vaqt (har 3 soat) — bo\'limdan ustun', reminders.sourceOf(ak2) === 'own' && ak2.remind_times === reminders.intervalTimes(employees.startMinutesOf(ak2), 3).join(','));
    await send(cbq(70001, `rm:er:${akbar.id}`));
    ok('hodim vaqti tozalandi → bo\'lim vaqtiga qaytdi', reminders.sourceOf(await employees.byId(akbar.id)) === 'dept');
    await send(cbq(70001, `rm:dr:${dept.id}`));
    ok('bo\'lim vaqti tozalandi → umumiy', !(await departments.byId(dept.id)).remind_times && reminders.sourceOf(await employees.byId(akbar.id)) === 'global');

    // ilova
    w = await call(70001, 'GET', '/api/reminders/admin');
    ok('ilova: boshliq boshqaruvi', w.status === 200 && w.data.step === 2 && w.data.departments.some((d) => d.id === Number(dept.id)) && w.data.employees.some((e) => e.id === Number(akbar.id)));
    w = await call(50001, 'GET', '/api/reminders/admin');
    ok('ilova: HR — 403', w.status === 403);
    w = await call(50001, 'GET', '/api/reminders');
    ok('ilova: HR o\'z eslatmalarini ham o\'zgartirmaydi — 403', w.status === 403);
    w = await call(50001, 'GET', '/api/reminders/pending');
    ok('ilova: HR so\'rovlarni ko\'rmaydi — 403', w.status === 403);
    w = await call(70001, 'POST', `/api/reminders/admin/dept/${dept.id}`, { times: '09:30, 15:00' });
    ok('ilova: bo\'limga vaqt', w.status === 200 && (await departments.byId(dept.id)).remind_times === '09:30,15:00');
    w = await call(70001, 'POST', `/api/reminders/admin/emp/${akbar.id}`, { step: 2 });
    ok('ilova: hodimga vaqt', w.status === 200 && reminders.sourceOf(await employees.byId(akbar.id)) === 'own');
    w = await call(70001, 'POST', `/api/reminders/admin/emp/${akbar.id}`, { times: 'ertalab' });
    ok('ilova: noto\'g\'ri vaqt — 400', w.status === 400);
    w = await call(50001, 'POST', `/api/reminders/admin/dept/${dept.id}`, { reset: true });
    ok('ilova: HR bo\'lim vaqtini o\'zgartira olmaydi', w.status === 403 && Boolean((await departments.byId(dept.id)).remind_times));
    await call(70001, 'POST', `/api/reminders/admin/dept/${dept.id}`, { reset: true });
    await call(70001, 'POST', `/api/reminders/admin/emp/${akbar.id}`, { reset: true });
    ok('ilova: tozalandi', !(await departments.byId(dept.id)).remind_times && !(await employees.byId(akbar.id)).remind_times);
  }

  await new Promise((r) => webSrv.close(r));
  // =========================================================================
  await db.close();
  console.log(`\n${failed ? '❌' : '🎉'} ${passed} o'tdi, ${failed} yiqildi · handler xatolari: ${errors.length}`);
  if (errors.length) console.log(errors.join('\n'));
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => {
  console.error('❌ Test yiqildi:', e);
  process.exit(1);
});
