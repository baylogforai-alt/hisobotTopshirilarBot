'use strict';

const cron = require('node-cron');
const config = require('./config');
const time = require('./time');
const ui = require('./ui');
const db = require('./db');
const tg = require('./telegram');
const employees = require('./services/employees');
const tasks = require('./services/tasks');
const attendance = require('./services/attendance');
const notify = require('./services/notify');
const reports = require('./services/reports');
const period = require('./services/period');
const kpi = require('./services/kpi');
const excel = require('./services/excel');
const backup = require('./services/backup');
const dailyReport = require('./handlers/dailyReport');

/**
 * REJALASHTIRUVCHI (standart 9:00–18:00, dushanba–shanba, Asia/Tashkent):
 *   start−5 daq  pre-start-intent — «Ishga kelyapsizmi?» (Ha/Yo'q) hali kelmaganlarga
 *   start        morning-group   — guruhga «Xayrli tong» + kutilayotganlar (guruh ulangan bo'lsa)
 *   har 30 daq   morning-call    — ish boshlanishi kelgan (umumiy yoki o'ziniki) va hali kelmaganlarga "Keldim" eslatmasi
 *   start+grace+5 morning-digest — direktorga hamma, boshliqqa o'z bo'limi: kim keldi / kech / yo'q
 *   start:30     overdue-alert   — tekshiruvchilarga muddati o'tgan ishlar
 *   har N soat   reminder        — ochiq topshiriqli hodimlarga (tugmali), guruhga ro'yxat, tekshiruvchilarga
 *   end−30 daq   report-nudge    — kunlik hisobot topshirmaganlarga eslatma
 *   end          daily-report    — guruhga kun yakuni (itemli), direktorga batafsil + kunlik hisobotlar holati; hodimlarga ertangi reja so'rovi
 *   end:45       plan-nudge      — ertangi kunga rejasi yo'q hodimlarga eslatma
 *   dushanba     weekly-report   — o'tgan hafta jamoa hisoboti + Excel → direktorga
 *   25-kun 10:00 score-nudge     — boshliqlarga: joriy oyni baholang
 *   1-kun 09:20  monthly-kpi     — o'tgan oy KPI + oylik Excel → direktorga; boshliqlarga baholash eslatmasi
 *   23:50        backup          — SQLite zaxira
 */

const logRun = (kind, detail = '') =>
  db.query('INSERT INTO reminder_log (kind, ran_at, detail) VALUES ($1, $2, $3)', [kind, time.stamp(), String(detail).slice(0, 500)])
    .catch((e) => console.error('[jobs] log yozilmadi:', e.message));

const schedule = (name, expr, fn) => {
  if (!cron.validate(expr)) { console.error(`[jobs] "${name}" uchun noto'g'ri cron: ${expr}`); return null; }
  console.log(`[jobs] ${name.padEnd(17)} → ${expr}`);
  return cron.schedule(expr, async () => {
    try { await fn(); } catch (err) { console.error(`[jobs] ${name} xatosi:`, err); }
  }, { timezone: config.timezone });
};

/** Boshliqlarga o'z bo'limi, direktorlarga hamma */
const sendToManagers = async (bot, buildFor) => {
  let sent = 0;
  for (const id of await notify.adminIds()) {
    const msg = await buildFor(null);
    if (msg) { await notify.toUser(bot, id, msg.text, msg.extra || {}); sent += 1; await tg.throttle(); }
  }
  for (const h of await employees.listHeads()) {
    if (!h.department_id || config.adminIds.includes(Number(h.tg_id))) continue;
    const msg = await buildFor(h.department_id);
    if (msg) { await notify.toUser(bot, h.tg_id, msg.text, msg.extra || {}); sent += 1; await tg.throttle(); }
  }
  return sent;
};

/** 'HH:MM' → cron "MM HH" (soat manfiy bo'lsa 0 ga tortiladi) */
const minusMinutes = (hour, minutes) => {
  const total = Math.max(0, hour * 60 - minutes);
  return { h: Math.floor(total / 60), m: total % 60 };
};

const start = (bot) => {
  const { workStartHour: startH, workEndHour: endH, reminderIntervalHours: step, workDays: dow } = config;
  const graceMin = Math.min(59, config.lateGraceMinutes + 5);

  // Ish boshlanishidan 5 daqiqa oldin: "Ishga kelyapsizmi?" (umumiy vaqtdagilar)
  const pre = minusMinutes(startH, 5);
  schedule('pre-start-intent', `${pre.m} ${pre.h} * * ${dow}`, async () => {
    let asked = 0;
    for (const e of await employees.listActive()) {
      if (employees.isFlexible(e) || e.work_start) continue;
      const row = await attendance.get(e.id);
      if (row && (row.checked_in || row.excuse_status || row.intent)) continue;
      await notify.toUser(bot, e.tg_id, `🕘 <b>${startH}:00 ga 5 daqiqa qoldi.</b>\n\nBugun ishga kelyapsizmi?`, ui.intentKeyboard());
      asked += 1;
      await tg.throttle();
    }
    await logRun('pre-start-intent', `${asked} ta hodimdan so'raldi`);
  });

  // Ish boshlanishida guruhga chaqiriq
  schedule('morning-group', `0 ${startH} * * ${dow}`, async () => {
    const r = await reports.sendMorningGroupCall(bot);
    await logRun('morning-group', JSON.stringify(r));
  });

  // Har yarim soatda: kimning ish boshlanishi shu 30 daqiqaga to'g'ri kelsa — shaxsiy eslatma (alohida ish vaqti bo'lganlar ham)
  schedule('morning-call', `0,30 ${startH}-${endH - 1} * * ${dow}`, async () => {
    const now = time.now();
    const nowMin = now.hour * 60 + now.minute;
    let n = 0;
    for (const e of await employees.listActive()) {
      if (employees.isFlexible(e)) continue;
      const st = employees.startMinutesOf(e);
      if (st < nowMin - 15 || st > nowMin + 15) continue;
      const row = await attendance.get(e.id);
      if (row && (row.checked_in || row.excuse_status || row.intent === 'no')) continue;
      const open = await tasks.openFor(e.id);
      await notify.toUser(
        bot, e.tg_id,
        `🌅 <b>Xayrli tong, ${ui.esc(e.full_name)}!</b>\n` +
          (open.length ? `Bugun uchun <b>${open.length} ta</b> missiya kutmoqda.\n` : "Bugunga yozilgan missiya yo'q.\n") +
          `\nOfisga yetib kelgach «${ui.BTN.checkIn}» tugmasini bosing. Kela olmasangiz — «${ui.BTN.absence}».`,
      );
      n += 1;
      await tg.throttle();
    }
    await logRun('morning-call', `${n} ta hodimga`);
  });

  schedule('morning-digest', `${graceMin} ${startH} * * ${dow}`, async () => {
    const n = await sendToManagers(bot, async (deptId) => ({ text: (await reports.buildMorningDigest({ deptId })).text }));
    await logRun('morning-digest', `${n} ta rahbarga`);
  });

  schedule('overdue-alert', `30 ${startH} * * ${dow}`, async () => {
    const n = await sendToManagers(bot, async (deptId) => {
      const list = await tasks.overdue(deptId);
      if (!list.length) return null;
      return { text: `⚠️ <b>MUDDATI O'TGAN TOPSHIRIQLAR (${list.length})</b>\n\n${ui.taskList(list, { withName: true })}` };
    });
    await logRun('overdue-alert', `${n} ta rahbarga`);
  });

  const first = startH + step;
  const last = endH - 1;
  if (first <= last) {
    schedule('reminder', `0 ${first}-${last}/${step} * * ${dow}`, async () => {
      const r = await reports.sendReminder(bot);
      await logRun('reminder', JSON.stringify(r));
    });
  } else console.warn("[jobs] Ish vaqti juda qisqa — oraliq eslatmalar o'chirildi.");

  // Kunlik hisobot eslatmasi (ish tugashidan N daqiqa oldin)
  if (config.dailyReportRequired) {
    const rn = minusMinutes(endH, config.dailyReportRemindMin);
    schedule('report-nudge', `${rn.m} ${rn.h} * * ${dow}`, async () => {
      const n = await dailyReport.remindMissing(bot);
      await logRun('report-nudge', `${n} ta hodimga`);
    });
  }

  schedule('daily-report', `0 ${endH} * * ${dow}`, async () => {
    if (config.dailyGroupReport) await notify.toGroup(bot, await reports.buildDailyGroupText());
    const { text } = await reports.buildToday({ title: 'KUN YAKUNI' });
    await notify.toAdmins(bot, text, ui.inline([[ui.cb('📋 Kunlik hisobotlar', 'dr:today'), ui.cb('📥 Excel (bugun)', 'rp:xlday')]]));
    // hodimlarga: ertangi rejani yozish
    let asked = 0;
    for (const e of await employees.listActive()) {
      if (!(await attendance.isCheckedIn(e.id))) continue;
      const open = await tasks.openFor(e.id);
      const rep = await require('./services/dailyReports').get(e.id);
      await notify.toUser(
        bot, e.tg_id,
        `🌇 <b>Ish kuni tugadi.</b>\n\n` +
          (open.length ? `Bajarilmagan <b>${open.length} ta</b> missiya ertangi kunga o'tadi:\n${ui.taskList(open)}\n\n` : `Bugungi barcha missiyalar bajarildi ✅\n\n`) +
          (config.dailyReportRequired && !rep ? `📝 <b>Kunlik hisobotingizni</b> «${ui.BTN.dailyReport}» bilan topshiring.\n` : '') +
          `📝 Ertangi missiyalaringizni «${ui.BTN.selfTask}» bilan yozib qo'ying.\nKetishdan oldin «${ui.BTN.checkOut}» tugmasini bosing.`,
      );
      asked += 1;
      await tg.throttle();
    }
    await logRun('daily-report', `guruh + direktor · ${asked} hodimga`);
  });

  // Ertangi kun uchun reja yozilmagan bo'lsa eslatish
  schedule('plan-nudge', `45 ${endH} * * ${dow}`, async () => {
    const tomorrow = time.addDays(time.today(), 1);
    if (!time.isWorkDay(tomorrow)) return;
    let nudged = 0;
    for (const e of await employees.listActive()) {
      if (employees.isFlexible(e)) continue;
      if (await tasks.hasCoverageFor(e.id, tomorrow)) continue;
      await notify.toUser(bot, e.tg_id, `⏰ <b>Eslatma:</b> ertangi (${time.prettyDate(tomorrow)}) missiyalaringizni hali yozmadingiz.\n\n«${ui.BTN.selfTask}» tugmasi orqali ertangi rejani yozib qo'ying.`);
      nudged += 1;
      await tg.throttle();
    }
    if (nudged && config.announceDone) await notify.toGroup(bot, `⏰ <b>Diqqat!</b> ${nudged} ta hodim ertangi missiyalarini hali yozmadi. Iltimos, botga yozib qo'ying.`);
    await logRun('plan-nudge', `${nudged} ta hodim`);
  });

  // Har dushanba: o'tgan hafta hisoboti + Excel — direktorga
  schedule('weekly-report', `10 ${startH} * * 1`, async () => {
    const anchor = time.addDays(time.startOfWeek(time.today()), -1);
    const from = time.startOfWeek(anchor);
    const to = time.endOfWeek(anchor);
    const text = await period.teamReport(from, to);
    await notify.toAdmins(bot, `🔔 <b>HAFTALIK AVTOMATIK HISOBOT</b>\n\n${text}`);
    const { buffer, filename } = await excel.buildTeamPeriod(from, to);
    await notify.docToAdmins(bot, buffer, filename, `📥 <b>O'tgan hafta</b> — ${time.prettyRange(from, to)} (Excel)`);
    await logRun('weekly-report', `${from} → ${to}`);
  });

  schedule('score-nudge', '0 10 25 * *', async () => {
    const m = time.month();
    let n = 0;
    for (const h of await employees.listHeads()) {
      if (!h.department_id) continue;
      await notify.toUser(bot, h.tg_id, `⭐ <b>${time.monthName(m)}</b> yakunlanmoqda — bo'lim hodimlaringizni 1–10 baholab qo'ying (KPI ga kiradi).`, ui.inline([[ui.cb('⭐ Baholash', `hs:m:${m}`)]]));
      n += 1;
      await tg.throttle();
    }
    await logRun('score-nudge', `${n} ta boshliqqa`);
  });

  schedule('monthly-kpi', `20 ${startH} 1 * *`, async () => {
    const m = time.prevMonth();
    const rows = await kpi.computeAll(m);
    const { from, to } = time.monthRange(m);
    await notify.toAdmins(bot, `🔔 <b>OYLIK AVTOMATIK HISOBOT</b>\n\n${await period.teamReport(from, to)}`);
    const { buffer, filename } = await excel.buildMonthly(m);
    const missingScore = rows.filter((k) => Number(k.w_head) > 0 && k.head_score === null).length;
    for (const id of await notify.adminIds()) {
      await notify.docToUser(bot, id, buffer, filename, `📥 <b>${time.monthName(m)}</b> — oylik hisobot (KPI, topshiriqlar, davomat, kunlik hisobotlar)`);
      await notify.toUser(
        bot, id,
        `💰 <b>${time.monthName(m)} KPI hisoblandi</b> — ${rows.length} hodim.\n` +
          (missingScore ? `⚠️ ${missingScore} ta hodimga boshliq bahosi qo'yilmagan.\n` : '') +
          `Hodimlarni ko'rib, tahrirlab, tasdiqlang yoki chiqaring:`,
        ui.inline([[ui.cb("💰 KPI bo'limiga o'tish", `kpi:m:${m}`)]]),
      );
      await tg.throttle();
    }
    for (const h of await employees.listHeads()) {
      if (!h.department_id || config.adminIds.includes(Number(h.tg_id))) continue;
      await notify.toUser(bot, h.tg_id, `⭐ <b>${time.monthName(m)}</b> yakunlandi. Hali baholamagan hodimlaringiz bo'lsa — hozir baholang:`, ui.inline([[ui.cb('⭐ Baholash', `hs:m:${m}`)]]));
      await tg.throttle();
    }
    await logRun('monthly-kpi', `${m}: ${rows.length} hodim`);
  });

  if (db.driver === 'sqlite') {
    schedule('backup', '50 23 * * *', async () => {
      const res = await backup.run();
      await logRun('backup', res.skipped ? 'skipped' : res.file);
    });
  }

  console.log('[jobs] Rejalashtiruvchi ishga tushdi.');
};

module.exports = { start };
