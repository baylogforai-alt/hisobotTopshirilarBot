'use strict';

const cron = require('node-cron');
const config = require('./config');
const time = require('./time');
const ui = require('./ui');
const db = require('./db');
const employees = require('./services/employees');
const missions = require('./services/missions');
const attendance = require('./services/attendance');
const notify = require('./services/notify');
const reports = require('./services/reports');

const logRun = (kind, detail = '') =>
  db
    .query('INSERT INTO reminder_log (kind, ran_at, detail) VALUES ($1, $2, $3)', [
      kind,
      time.stamp(),
      String(detail).slice(0, 500),
    ])
    .catch((e) => console.error('[jobs] log yozilmadi:', e.message));

const schedule = (name, expr, fn) => {
  if (!cron.validate(expr)) {
    console.error(`[jobs] "${name}" uchun noto'g'ri cron: ${expr}`);
    return null;
  }
  console.log(`[jobs] ${name.padEnd(18)} → ${expr}  (${config.timezone})`);
  return cron.schedule(
    expr,
    async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`[jobs] ${name} xatosi:`, err);
      }
    },
    { timezone: config.timezone },
  );
};

const start = (bot) => {
  const { workStartHour: startH, workEndHour: end, reminderIntervalHours: step, workDays: dow } = config;

  // 1) Har kuni yarim tunda: muddati kelgan missiyalarni faollashtirish
  schedule('rollover', '5 0 * * *', async () => {
    await missions.activateDue();
    await logRun('rollover', 'kunlik faollashtirish');
  });

  // 2) Ish boshlanishidan 5 daqiqa oldin: "Ishga kelyapsizmi?" (ha/yo'q tugmasi bilan)
  schedule('pre-start-intent', `55 ${startH - 1} * * ${dow}`, async () => {
    const list = await employees.listActive();
    let asked = 0;
    for (const emp of list) {
      if (await attendance.isCheckedIn(emp.id)) continue;
      asked += 1;
      await notify.toUser(
        bot,
        emp.tg_id,
        `🕘 <b>${startH}:00 ga 5 daqiqa qoldi.</b>\n\nBugun ishga kelyapsizmi?`,
        { parse_mode: 'HTML', ...ui.intentKeyboard() },
      );
    }
    await logRun('pre-start-intent', `${asked} ta hodimdan so'raldi`);
  });

  // 3) Ish boshlanishida: "Ishga keldim" ni eslatish
  schedule('morning-call', `0 ${startH} * * ${dow}`, async () => {
    const res = await reports.sendMorningCall(bot);
    await logRun('morning-call', JSON.stringify(res));
  });

  // 4) Kun davomida har N soatda: "shu missiyani bajardingmi?"
  const firstReminder = startH + step;
  const lastReminder = end - 1;
  if (firstReminder <= lastReminder) {
    schedule('reminder', `0 ${firstReminder}-${lastReminder}/${step} * * ${dow}`, async () => {
      const res = await reports.sendReminder(bot);
      await logRun('reminder', JSON.stringify(res));
    });
  } else {
    console.warn("[jobs] Ish vaqti juda qisqa — oraliq eslatmalar o'chirildi.");
  }

  // 5) Ish oxirida: kunlik hisobot + ertangi rejani so'rash
  schedule('daily-report', `0 ${end} * * ${dow}`, async () => {
    const res = await reports.sendDailyReport(bot);
    await logRun('daily-report', JSON.stringify(res));
  });

  // 6) Ish oxiridan 45 daqiqa keyin: ertangi kun uchun missiya yozilmagan bo'lsa eslatish
  schedule('plan-nudge', `45 ${end} * * ${dow}`, async () => {
    const tomorrow = time.addDays(time.today(), 1);
    const list = await employees.listActive();
    let nudged = 0;
    for (const emp of list) {
      if (await missions.hasCoverageFor(emp.id, tomorrow)) continue;
      nudged += 1;
      await notify.toUser(
        bot,
        emp.tg_id,
        `⏰ <b>Eslatma:</b> ertangi (${time.prettyDate(tomorrow)}) missiyalaringizni hali yozmadingiz.\n\n` +
          `«➕ Missiya qo'shish» tugmasi orqali ertangi rejani yozib qo'ying.`,
      );
    }
    if (nudged) {
      await notify.toGroup(
        bot,
        `⏰ <b>Diqqat!</b> ${nudged} ta hodim ertangi missiyalarini hali yozmadi.\n` +
          `Iltimos, botga yozib qo'ying.`,
      );
    }
    await logRun('plan-nudge', `${nudged} ta hodim`);
  });

  console.log('[jobs] Rejalashtiruvchi ishga tushdi.');
};

module.exports = { start };
