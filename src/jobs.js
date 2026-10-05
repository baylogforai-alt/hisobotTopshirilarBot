'use strict';

const cron = require('node-cron');
const config = require('./config');
const time = require('./time');
const ui = require('./ui');
const db = require('./db');
const tg = require('./telegram');
const employees = require('./services/employees');
const tasks = require('./services/tasks');
const worktime = require('./services/worktime');
const attendance = require('./services/attendance');
const reminders = require('./services/reminders');
const notify = require('./services/notify');
const reports = require('./services/reports');
const period = require('./services/period');
const kpi = require('./services/kpi');
const excel = require('./services/excel');
const backup = require('./services/backup');
const dailyReport = require('./handlers/dailyReport');

/**
 * REJALASHTIRUVCHI (Asia/Tashkent, WORK_DAYS). Ish boshlanishi bazada (Panel → «🕘 Ish vaqti»), shuning uchun
 * ertalabki ishlar 5 daqiqalik tick ichida dinamik:
 *   har 5 daq (06:00–21:55) tick:
 *       pre-start-intent — umumiy boshlanish − 5 daq: «Ishga kelyapsizmi?» (Ha/Yo'q) hali kelmaganlarga
 *       morning-group    — umumiy boshlanish: guruhga «Xayrli tong» + kutilayotganlar
 *       morning-call     — hodimning ish boshlanishi (umumiy yoki o'ziniki) kelganda, hali kelmaganlarga "Keldim" eslatmasi
 *       morning-digest   — umumiy boshlanish + kechikish ruxsati + 5 daq: direktor/HR ga hamma, rahbarga o'z bo'limi
 *       overdue-alert    — umumiy boshlanish + 40 daq: muddati o'tgan ishlar
 *       reminder         — har hodimga o'z vaqtlarida (hodim → bo'lim → umumiy «har N soat»); tekshiruvchilarga va
 *                          guruhga (ANNOUNCE_DONE) — umumiy vaqtlarda
 *   end−30 daq   report-nudge    — kunlik hisobot topshirmaganlarga eslatma
 *   end          daily-report    — guruhga kun yakuni (itemli), direktor/HR ga batafsil; hodimlarga ertangi reja so'rovi
 *   end:45       plan-nudge      — ertangi kunga rejasi yo'q hodimlarga eslatma
 *   dushanba     weekly-report   — o'tgan hafta jamoa hisoboti + Excel → direktorga
 *   25-kun 10:00 score-nudge     — boshliqlarga: joriy oyni baholang
 *   1-kun 09:00  month-start     — hammaga «yangi ish oyi boshlandi» + tasdiqlash tugmasi
 *   1-kun 09:20  monthly-kpi     — o'tgan oy KPI + oylik Excel → direktor/HR; boshliqlarga baholash eslatmasi
 *   23:50        backup          — SQLite zaxira / Postgres'da JSON eksport direktorga (backup-export)
 *   har daqiqa   task-start      — topshiriqning boshlanish soati kelganda hodimga «hozir bajaring» xabari
 *   06:00–21:30  home-location   — uy joylashuvi yo'q hudud agentlariga har 30 daqiqada eslatma
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

/** Rahbarlarga o'z bo'limi, direktorlar va HR ga hamma. noBoss — davomat hisobotlari boshliqqa bormaydi */
const sendToManagers = async (bot, buildFor, { noBoss = false } = {}) => {
  let sent = 0;
  const full = await notify.seeAllIds({ noBoss });
  for (const id of full) {
    const msg = await buildFor(null, id);
    if (msg) { await notify.toUser(bot, id, msg.text, msg.extra || {}); sent += 1; await tg.throttle(); }
  }
  for (const h of await employees.listHeads()) {
    if (!h.department_id || full.includes(Number(h.tg_id)) || (noBoss && h.role === 'admin')) continue;
    const msg = await buildFor(h.department_id);
    if (msg) { await notify.toUser(bot, h.tg_id, msg.text, msg.extra || {}); sent += 1; await tg.throttle(); }
  }
  return sent;
};

/** Soat → cron "MM HH" (manfiy bo'lsa 0 ga tortiladi) */
const minusMinutes = (hour, minutes) => {
  const total = Math.max(0, hour * 60 - minutes);
  return { h: Math.floor(total / 60), m: total % 60 };
};

/** [nowMin−4, nowMin] oynasiga tushadimi (5 daqiqalik tick) */
const inSlot = (targetMin, nowMin) => targetMin > nowMin - 5 && targetMin <= nowMin;

/** Umumiy ish boshlanishidan 5 daqiqa oldin: «Ishga kelyapsizmi?» (alohida vaqti yo'qlarga) */
const preStartIntent = async (bot) => {
  let asked = 0;
  for (const e of await employees.listStaff()) {
    if (employees.isFlexible(e) || e.work_start) continue;
    const row = await attendance.get(e.id);
    if (row && (row.checked_in || row.excuse_status || row.intent || row.late_notice_at)) continue;
    await notify.toUser(bot, e.tg_id, `🕘 <b>${worktime.get()} ga 5 daqiqa qoldi.</b>\n\nBugun ishga kelyapsizmi?`, ui.intentKeyboard());
    asked += 1;
    await tg.throttle();
  }
  await logRun('pre-start-intent', `${asked} ta hodimdan so'raldi`);
  return asked;
};

const morningCall = async (bot, nowMin) => {
  let n = 0;
  for (const e of await employees.listStaff()) {
    if (employees.isFlexible(e) || !inSlot(employees.startMinutesOf(e), nowMin)) continue;
    const row = await attendance.get(e.id);
    if (row && (row.checked_in || row.excuse_status || row.late_reason || row.intent === 'no')) continue;
    const open = await tasks.openFor(e.id);
    await notify.toUser(
      bot, e.tg_id,
      `🌅 <b>Xayrli tong, ${ui.esc(e.full_name)}!</b> Ish vaqti boshlandi.\n` +
        (open.length ? `Bugun uchun <b>${open.length} ta</b> missiya kutmoqda.\n` : "Bugunga yozilgan missiya yo'q.\n") +
        `\nIsh joyiga yetib kelgach «${ui.BTN.checkIn}» tugmasini bosing.\nKechiksangiz — «${ui.BTN.late}», kela olmasangiz — «${ui.BTN.absence}».`,
    );
    n += 1;
    await tg.throttle();
  }
  if (n) await logRun('morning-call', `${n} ta hodimga`);
  return n;
};

/** Topshiriq eslatmalari — har hodimning o'z vaqtida; tekshiruvchilar va guruh — umumiy vaqtlarda */
const remindTick = async (bot, nowMin) => {
  const step = await reminders.globalStep();
  let n = 0;
  for (const e of await employees.listActive()) {
    const times = reminders.timesFor(e, step, employees.startMinutesOf(e));
    if (!times.some((t) => inSlot(reminders.toMin(t), nowMin))) continue;
    if (await reports.sendReminderTo(bot, e)) { n += 1; await tg.throttle(); }
  }
  let rv = 0;
  let grp = false;
  if (reminders.intervalTimes(worktime.minutes(), step).some((t) => inSlot(reminders.toMin(t), nowMin))) {
    rv = await reports.sendReviewerDigest(bot);
    if (config.announceDone) grp = await reports.sendGroupReminder(bot);
  }
  if (n || rv || grp) await logRun('reminder', `${n} hodim, ${rv} tekshiruvchi${grp ? ', guruh' : ''}`);
  return n;
};

/** Har 5 daqiqada: dinamik vaqtli ishlar */
const tick = async (bot, now = time.now()) => {
  const nowMin = now.hour * 60 + now.minute;
  const g = worktime.minutes();
  await remindTick(bot, nowMin);
  if (now.hour >= config.workEndHour) return;
  if (inSlot(g - 5, nowMin)) await preStartIntent(bot);
  if (inSlot(g, nowMin)) {
    const r = await reports.sendMorningGroupCall(bot);
    await logRun('morning-group', JSON.stringify(r));
  }
  await morningCall(bot, nowMin);
  if (inSlot(g + config.lateGraceMinutes + 5, nowMin)) {
    const n = await sendToManagers(bot, async (deptId) => ({ text: (await reports.buildMorningDigest({ deptId })).text }), { noBoss: !(await require('./services/org').bossSeesAttendance()) });
    await logRun('morning-digest', `${n} ta rahbarga`);
  }
  if (inSlot(g + 40, nowMin)) {
    const n = await sendToManagers(bot, async (deptId, tgId) => {
      // HR boshliq/direktor bergan topshiriqlarni ko'rmaydi
      const list = tgId ? tasks.visibleFor(await require('./services/access').resolve(tgId), await tasks.overdue(deptId)) : await tasks.overdue(deptId);
      if (!list.length) return null;
      return { text: `⚠️ <b>MUDDATI O'TGAN TOPSHIRIQLAR (${list.length})</b>\n\n${ui.taskList(list, { withName: true })}` };
    });
    await logRun('overdue-alert', `${n} ta rahbarga`);
  }
};

const start = (bot) => {
  const { workEndHour: endH, workDays: dow } = config;

  schedule('tick', `*/5 6-21 * * ${dow}`, () => tick(bot));

  // Kunlik hisobot eslatmasi (ish tugashidan N daqiqa oldin)
  if (config.dailyReportRequired) {
    const rn = minusMinutes(endH, config.dailyReportRemindMin);
    schedule('report-nudge', `${rn.m} ${rn.h} * * ${dow}`, async () => {
      const n = await dailyReport.remindMissing(bot);
      await logRun('report-nudge', `${n} ta hodimga`);
    });
  }

  // topshiriq boshlanish soati (masalan ertaga 09:00) — aynan o'sha daqiqada hodimga xabar
  schedule('task-start', '* * * * *', async () => {
    const n = await require('./services/flows').notifyTaskStarts(bot);
    if (n) await logRun('task-start', `${n} ta topshiriq`);
  });

  // 5-okt: uy joylashuvi yo'q agentlarga — har kuni 06:00 dan har 30 daqiqada (saqlangach to'xtaydi)
  schedule('home-location', '0,30 6-21 * * *', async () => {
    const n = await require('./services/flows').remindHomeLocation(bot);
    if (n) await logRun('home-location', `${n} ta agentga`);
  });

  // topshiriq eslatmalari — tick ichida (remindTick): har hodim o'z jadvalida

  schedule('daily-report', `0 ${config.dailyReportHour} * * ${dow}`, async () => {
    if (config.dailyGroupReport) await notify.toGroup(bot, await reports.buildDailyGroupText());
    const { text } = await reports.buildToday({ title: 'KUN YAKUNI' });
    // boshliqqa — faqat Panelda «Boshliq keldi-ketdini: ko'radi» yoqilgan bo'lsa
    await notify.toSeeAll(bot, text, ui.inline([[ui.cb('📋 Kunlik hisobotlar', 'dr:today'), ui.cb('📥 Excel (bugun)', 'rp:xlday')]]), null,
      { noBoss: !(await require('./services/org').bossSeesAttendance()) });
    // hodimlarga: ertangi rejani yozish
    let asked = 0;
    for (const e of await employees.listStaff()) {
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
    await logRun('daily-report', `guruh + direktor/HR · ${asked} hodimga`);
  });

  // Ertangi kun uchun reja yozilmagan bo'lsa eslatish
  schedule('plan-nudge', `45 ${endH} * * ${dow}`, async () => {
    const tomorrow = time.addDays(time.today(), 1);
    if (!time.isWorkDay(tomorrow)) return;
    let nudged = 0;
    for (const e of await employees.listStaff()) {
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
  schedule('weekly-report', `10 ${config.workStartHour} * * 1`, async () => {
    const anchor = time.addDays(time.startOfWeek(time.today()), -1);
    const from = time.startOfWeek(anchor);
    const to = time.endOfWeek(anchor);
    const text = await period.teamReport(from, to);
    await notify.toSeeAll(bot, `🔔 <b>HAFTALIK AVTOMATIK HISOBOT</b>\n\n${text}`);
    const full = await excel.buildTeamPeriod(from, to);
    let hrFile = null; // HR ga — boshliq sozlamasiga qarab boshliq/direktor topshiriqlarisiz
    for (const id of await notify.seeAllIds()) {
      const viewer = await require('./services/access').resolve(id);
      const file = viewer.hrSeesBoss ? full : hrFile || (hrFile = await excel.buildTeamPeriod(from, to, { viewer }));
      await notify.docToUser(bot, id, file.buffer, file.filename, `📥 <b>O'tgan hafta</b> — ${time.prettyRange(from, to)} (Excel)`);
      await tg.throttle();
    }
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

  schedule('month-start', '0 9 1 * *', async () => {
    const n = await require('./handlers/month').sendMonthStart(bot);
    await logRun('month-start', `${n} ta hodimga`);
  });

  schedule('monthly-kpi', '20 9 1 * *', async () => {
    const m = time.prevMonth();
    const rows = await kpi.computeAll(m);
    const { from, to } = time.monthRange(m);
    await notify.toSeeAll(bot, `🔔 <b>OYLIK AVTOMATIK HISOBOT</b>\n\n${await period.teamReport(from, to)}`);
    const full = await excel.buildMonthly(m);
    let hrFile = null; // HR ga — boshliq sozlamasiga qarab boshliq/direktor topshiriqlarisiz
    const missingScore = rows.filter((k) => Number(k.w_head) > 0 && k.head_score === null).length;
    for (const id of await notify.seeAllIds()) {
      const viewer = await require('./services/access').resolve(id);
      let file = full;
      if (!viewer.hrSeesBoss) file = hrFile || (hrFile = await excel.buildMonthly(m, { viewer }));
      await notify.docToUser(bot, id, file.buffer, file.filename, `📥 <b>${time.monthName(m)}</b> — oylik hisobot (KPI, topshiriqlar, davomat, kunlik hisobotlar)`);
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
  } else {
    // Postgres: konteyner diski vaqtinchalik — zaxira direktorga Telegram fayli sifatida boradi
    schedule('backup-export', '50 23 * * *', async () => {
      const { buffer, filename, rows } = await backup.exportJson();
      const n = await notify.docToAdmins(bot, buffer, filename, `💾 <b>Kunlik zaxira</b> — ${time.prettyDate(time.today())} · ${rows} ta yozuv\n<i>Faylni saqlab qo'ying: baza yo'qolsa shundan tiklanadi.</i>`);
      await logRun('backup', `export ${rows} yozuv → ${n} admin`);
    });
  }

  console.log('[jobs] Rejalashtiruvchi ishga tushdi.');
};

module.exports = { start, tick, inSlot, remindTick, preStartIntent };
