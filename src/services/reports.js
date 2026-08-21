'use strict';

const config = require('../config');
const time = require('../time');
const ui = require('../ui');
const employees = require('./employees');
const missions = require('./missions');
const attendance = require('./attendance');
const notify = require('./notify');
const excel = require('./excel');

const COMPANY = config.companyName.toUpperCase();

const mentionHtml = (e) => `<a href="tg://user?id=${e.tg_id}">${ui.esc(e.full_name)}</a>`;

/**
 * Har N soatda: guruhga "shu missiyalarni bajardingizmi?" eslatmasi
 * + har bir hodimga shaxsiy tugmali ro'yxat.
 */
const sendReminder = async (bot, { force = false } = {}) => {
  await missions.activateDue();

  const working = await attendance.workingNow();
  const blocks = [];
  const dms = [];

  for (const emp of working) {
    const open = await missions.openFor(emp.id);
    if (!open.length) continue;
    blocks.push(`${mentionHtml(emp)} — <b>${open.length} ta</b> bajarilmagan:\n${ui.missionList(open)}`);
    dms.push({ emp, open });
  }

  if (!blocks.length && !force) return { sent: false, reason: 'no_open_missions' };

  const header =
    `🔔 <b>${COMPANY} — MISSIYA ESLATMASI</b> · ${time.now().toFormat('HH:mm')}\n` +
    `<i>${time.prettyDate(time.today())}</i>\n`;

  let body;
  if (blocks.length) {
    body =
      `${header}\n${blocks.join('\n\n')}\n\n` +
      `👉 Bajarganingizni botga kirib <b>«✔️ Bajardim»</b> tugmasi orqali belgilang.`;
  } else {
    body = `${header}\n✅ Hozircha barcha faol missiyalar bajarilgan. Barakalla!`;
  }

  const absent = await attendance.absent();
  if (absent.length) {
    body += `\n\n🚫 Hali «Ishga keldim» qilmaganlar: ${absent.map((e) => ui.esc(e.full_name)).join(', ')}`;
  }

  await notify.toGroup(bot, body);

  for (const { emp, open } of dms) {
    await notify.toUser(
      bot,
      emp.tg_id,
      `🔔 <b>Eslatma</b> · ${time.now().toFormat('HH:mm')}\n\nQuyidagi missiyalar hali bajarilmadi:\n\n` +
        `${ui.missionList(open)}\n\nBajarganini bosing 👇`,
      ui.doneKeyboard(open),
    );
  }

  return { sent: true, employees: dms.length };
};

/** Ertalabki chaqiriq: "Ishga keldim" tugmasini bosishni so'rash */
const sendMorningCall = async (bot) => {
  await missions.activateDue();
  const absent = await attendance.absent();
  if (!absent.length) return { sent: false };

  await notify.toGroup(
    bot,
    `🌅 <b>Xayrli tong, ${config.companyName} jamoasi!</b> · ${time.prettyDate(time.today())}\n\n` +
      `Botga kirib <b>«✅ Ishga keldim»</b> tugmasini bosing — bugungi missiyalaringiz ishga tushadi.\n\n` +
      `Kutilmoqda: ${absent.map((e) => mentionHtml(e)).join(', ')}`,
  );

  for (const emp of absent) {
    const open = await missions.openFor(emp.id);
    const pending = await missions.pendingFor(emp.id);
    const count = open.length + pending.length;
    await notify.toUser(
      bot,
      emp.tg_id,
      `🌅 <b>Xayrli tong, ${ui.esc(emp.full_name)}!</b>\n\n` +
        (count ? `Bugun uchun <b>${count} ta</b> missiya kutmoqda.\n` : `Bugunga yozilgan missiya yo'q.\n`) +
        `\n<b>«✅ Ishga keldim»</b> tugmasini bosing.`,
    );
  }
  return { sent: true, count: absent.length };
};

/**
 * Kun oxiri hisoboti matni — itemli: har bir hodim aynan QAYSI ishlarni
 * bajargani (✅) va qaysilari qolgani (⏳) ro'yxati bilan.
 */
const buildDailyReportText = async (date = time.today()) => {
  const list = await employees.listActive();
  const blocks = [];
  let totalDone = 0;
  let totalOpen = 0;

  const MAX_ITEMS = 15; // juda uzun bo'lib ketmasligi uchun

  for (const emp of list) {
    const att = await attendance.get(emp.id, date);
    if (!att || !att.checked_in) {
      blocks.push(`👤 <b>${ui.esc(emp.full_name)}</b> — 🚫 <i>ishga kelmadi</i>`);
      continue;
    }

    const done = await missions.doneOn(emp.id, date);
    const open = await missions.openFor(emp.id);
    totalDone += done.length;
    totalOpen += open.length;

    const total = done.length + open.length;
    const bar = total ? Math.round((done.length / total) * 100) : 0;

    const items = [];
    done.forEach((m) => items.push(`   ✅ ${ui.esc(m.title)}`));
    open.forEach((m) => {
      const overdue = m.due_date < date;
      items.push(`   ⏳ ${ui.esc(m.title)}${overdue ? ' ⚠️' : ''}`);
    });
    const shown = items.slice(0, MAX_ITEMS);
    if (items.length > MAX_ITEMS) shown.push(`   <i>…yana ${items.length - MAX_ITEMS} ta</i>`);

    blocks.push(
      `👤 <b>${ui.esc(emp.full_name)}</b> — ✅ ${done.length}/${total} (${bar}%)` +
        (open.length ? ` · ⏳ ${open.length} ta ertaga o'tadi` : '') +
        (items.length ? `\n${shown.join('\n')}` : ''),
    );
  }

  const text =
    `📊 <b>${COMPANY} — KUNLIK HISOBOT</b> · ${time.prettyDate(date)}\n\n` +
    (blocks.length ? blocks.join('\n\n') : "<i>Hodimlar yo'q</i>") +
    `\n\n━━━━━━━━━━━━━━\n✅ Bajarildi: <b>${totalDone}</b>   ⏳ Qoldi: <b>${totalOpen}</b>`;

  return { text, totalDone, totalOpen };
};

/** Kun oxiri: guruhga itemli hisobot + Excel fayl + hammadan ertangi rejani so'rash */
const sendDailyReport = async (bot, { askPlan = true } = {}) => {
  const date = time.today();
  const list = await employees.listActive();

  const { text, totalDone, totalOpen } = await buildDailyReportText(date);
  await notify.toGroup(bot, text);

  // Excel faylni ham guruhga qo'shamiz
  try {
    const { buffer, filename } = await excel.buildDayReport(date, { scopeName: 'Butun jamoa' });
    await notify.docToGroup(bot, buffer, filename, `📥 ${time.prettyDate(date)} — batafsil hisobot (Excel)`);
  } catch (e) {
    console.error('[reports] Excel yuborilmadi:', e.message);
  }

  if (askPlan) {
    for (const emp of list) {
      if (!(await attendance.isCheckedIn(emp.id, date))) continue;
      const open = await missions.openFor(emp.id);
      await notify.toUser(
        bot,
        emp.tg_id,
        `🌇 <b>Ish kuni tugadi.</b>\n\n` +
          (open.length
            ? `Bajarilmagan <b>${open.length} ta</b> missiya ertangi kunga o'tadi:\n${ui.missionList(open)}\n\n`
            : `Bugungi barcha missiyalar bajarildi ✅\n\n`) +
          `📝 Endi <b>ertangi (yoki keyingi kunlardagi) missiyalaringizni</b> yozib qo'ying — ` +
          `«➕ Missiya qo'shish» tugmasi orqali.\n\n` +
          `Ketishdan oldin <b>«🏁 Ishdan ketaman»</b> tugmasini bosing.`,
      );
    }
  }

  return { totalDone, totalOpen };
};

/** Admin uchun bir zumlik umumiy holat */
const buildLiveReport = async () => {
  const date = time.today();
  const list = await employees.listActive();
  if (!list.length) return "Hodimlar ro'yxati bo'sh. /hodim_qosh buyrug'i bilan qo'shing.";

  const lines = [];
  for (const emp of list) {
    const att = await attendance.get(emp.id, date);
    const st = await missions.dayStats(emp.id, date);
    let status = '🚫 kelmadi';
    if (att && att.checked_in && att.checked_out) status = `🏁 ketdi (${time.clock(att.checked_out)})`;
    else if (att && att.checked_in) status = `🟢 ishda (${time.clock(att.checked_in)})`;
    lines.push(
      `• <b>${ui.esc(emp.full_name)}</b> — ${status}\n` +
        `   ✅ ${st.done}  ⏳ ${st.open}${st.overdue ? `  ⚠️ ${st.overdue}` : ''}`,
    );
  }

  return `📊 <b>${COMPANY} — HOZIRGI HOLAT</b> · ${time.prettyDate(date)}\n\n${lines.join('\n')}`;
};

const buildOverdueReport = async () => {
  const rows = await missions.allOverdue();
  if (!rows.length) return "✅ Kechikkan missiya yo'q.";
  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.full_name)) byEmp.set(r.full_name, []);
    byEmp.get(r.full_name).push(r);
  }
  const blocks = [...byEmp.entries()].map(
    ([name, items]) =>
      `<b>${ui.esc(name)}</b>\n` +
      items
        .map((m) => `   🔴 ${ui.esc(m.title)} — <i>${time.diffDays(m.due_date, time.today())} kun kechikdi</i>`)
        .join('\n'),
  );
  return `⚠️ <b>${COMPANY} — KECHIKKAN MISSIYALAR</b>\n\n${blocks.join('\n\n')}`;
};

module.exports = {
  mentionHtml, sendReminder, sendMorningCall, sendDailyReport, buildDailyReportText,
  buildLiveReport, buildOverdueReport,
};
