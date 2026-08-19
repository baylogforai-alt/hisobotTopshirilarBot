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

  // 2) Ish boshlanishida: "Ishga keldim" ni eslatish
  schedule('morning-call', `0 ${startH} * * ${dow}`, async () => {
    const res = await reports.sendMorningCall(bot);
    await logRun('morning-call', JSON.stringify(res));
  });

  // 3) Kun davomida har N soatda: "shu missiyani bajardingmi?"
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

  // 4) Ish oxirida: kunlik hisobot + ertangi rejani so'rash
  schedule('daily-report', `0 ${end} * * ${dow}`, async () => {
    const res = await reports.sendDailyReport(bot);
    await logRun('daily-report', JSON.stringify(res));
  });

  // 5) Ish oxiridan 1 soat keyin: ertangi missiyani yozmaganlarga turtki
  schedule('plan-nudge', `0 ${end + 1} * * ${dow}`, async () => {
    const list = await employees.listActive();
    let nudged = 0;
    for (const emp of list) {
      if (!(await attendance.isCheckedIn(emp.id))) continue;
      const pending = await missions.pendingFor(emp.id);
      if (pending.length) continue;
      const open = await missions.openFor(emp.id);
      nudged += 1;
      await notify.toUser(
        bot,
        emp.tg_id,
        `⏰ <b>Eslatma:</b> ertangi missiyalaringizni hali yozmadingiz.\n\n` +
          (open.length
            ? `Bajarilmagan ${open.length} ta ish ertaga o'tadi:\n${ui.missionList(open)}\n\n`
            : '') +
          `«➕ Missiya qo'shish» tugmasi orqali ertangi rejani yozib qo'ying.`,
      );
    }
    if (nudged) {
      await notify.toGroup(
        bot,
        `⏰ <b>Diqqat!</b> ${nudged} ta hodim ertangi missiyalarini hali yozmadi.\n` +
          `Ishdan ketishdan oldin botga yozib qo'ying.`,
      );
    }
    await logRun('plan-nudge', `${nudged} ta hodim`);
  });

  console.log('[jobs] Rejalashtiruvchi ishga tushdi.');
};

module.exports = { start };
