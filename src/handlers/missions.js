'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const missions = require('../services/missions');
const attendance = require('../services/attendance');
const notify = require('../services/notify');
const reports = require('../services/reports');
const excel = require('../services/excel');
const employees = require('../services/employees');
const activity = require('../services/activity');
const { notRegistered } = require('./common');

const MAX_TITLE = 300;

/** "Matn | 3" ko'rinishidagi qatorni {title, days} ga ajratadi */
const parseLine = (line) => {
  const m = line.match(/^(.*?)\s*\|\s*(\d{1,3})\s*(kun)?$/i);
  if (m && m[1].trim()) return { title: m[1].trim().slice(0, MAX_TITLE), days: Number(m[2]) };
  return { title: line.trim().slice(0, MAX_TITLE), days: null };
};

const parseTitles = (text) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, '').trim())
    .filter((l) => l.length > 1)
    .map(parseLine);

/** Tanlangan davomiylikdan sanalarni hisoblaydi */
const datesFor = (choice, days) => {
  if (choice === 'today') {
    const t = time.today();
    return { start: t, due: t };
  }
  const n = Math.max(1, Number(days || choice) || 1);
  const start = time.addDays(time.today(), 1);
  return { start, due: time.addDays(start, n - 1) };
};

const askDuration = (ctx, items) =>
  ctx.reply(
    `📝 <b>${items.length} ta missiya</b> qabul qilindi:\n\n` +
      items
        .map((it, i) => `${i + 1}. ${ui.esc(it.title)}${it.days ? ` <i>(${it.days} kun)</i>` : ''}`)
        .join('\n') +
      `\n\n⏱ Bu missiyalar <b>necha kunlik</b>?`,
    { parse_mode: 'HTML', ...ui.durationKeyboard() },
  );

const startWizard = (ctx) => {
  session.set(ctx.from.id, { step: 'titles' });
  return ctx.reply(
    `📝 <b>Yangi missiya</b>\n\n` +
      `Bajarmoqchi bo'lgan ishlaringizni yozing. Bir nechta bo'lsa — <b>har birini yangi qatorga</b>.\n\n` +
      `<i>Misol:</i>\n` +
      `<code>Xitoydan kelgan yuklarni ro'yxatga olish\n` +
      `Mijoz Akbar bilan shartnoma imzolash | 3\n` +
      `Oylik hisobotni tayyorlash | 30</code>\n\n` +
      `💡 Qator oxiriga <code>| kun_soni</code> yozsangiz — o'sha missiyaga alohida muddat beriladi.\n\n` +
      `Bekor qilish uchun /menu`,
    { parse_mode: 'HTML' },
  );
};

/** Sessiyadagi matn bosqichi — index.js dagi umumiy text handler chaqiradi */
const handleTitlesInput = async (ctx) => {
  const items = parseTitles(ctx.message.text);
  if (!items.length) {
    return ctx.reply('❌ Missiya matni juda qisqa. Qaytadan yozing yoki /menu bosing.');
  }
  session.set(ctx.from.id, { step: 'duration', items });
  activity.mark(ctx, 'note', {
    title: items.map((i) => i.title).join(' | '),
    detail: 'missiya matni sifatida yozdi',
  });
  return askDuration(ctx, items);
};

const onDuration = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("Ro'yxatdan o'tmagansiz");

  const choice = ctx.match[1];
  const s = session.get(ctx.from.id);
  if (!s.items || !s.items.length) {
    await ctx.answerCbQuery("Muddati o'tgan so'rov");
    return ctx.editMessageText("⏳ So'rov eskirdi. «➕ Missiya qo'shish» dan qayta boshlang.");
  }

  if (choice === 'cancel') {
    session.clear(ctx.from.id);
    activity.mark(ctx, 'use', { title: 'Missiya yozishni bekor qildi' });
    await ctx.answerCbQuery('Bekor qilindi');
    return ctx.editMessageText('❌ Bekor qilindi.');
  }

  const created = [];
  for (const it of s.items) {
    const { start, due } = datesFor(it.days ? String(it.days) : choice, it.days);
    created.push(
      await missions.create({ employeeId: emp.id, title: it.title, startDate: start, dueDate: due }),
    );
  }
  session.clear(ctx.from.id);
  created.forEach((m) =>
    activity.mark(ctx, 'mission_add', {
      title: m.title,
      detail:
        m.start_date === m.due_date
          ? time.prettyDate(m.due_date)
          : `${time.prettyDate(m.start_date)} → ${time.prettyDate(m.due_date)}`,
    }),
  );
  await ctx.answerCbQuery('Saqlandi ✅');

  const startsToday = created.filter((m) => m.start_date <= time.today()).length;
  await ctx.editMessageText(
    `✅ <b>${created.length} ta missiya saqlandi</b>\n\n` +
      created
        .map(
          (m, i) =>
            `${i + 1}. ${ui.esc(m.title)}\n   <i>${time.prettyDate(m.start_date)}` +
            (m.due_date !== m.start_date ? ` → ${time.prettyDate(m.due_date)}` : '') +
            `</i>`,
        )
        .join('\n') +
      (startsToday
        ? `\n\n🎯 ${startsToday} tasi <b>bugundan</b> faol.`
        : `\n\n☀️ Ular <b>ertaga «Ishga keldim»</b> deganingizda ishga tushadi.`),
    { parse_mode: 'HTML' },
  );

  await notify.toGroup(
    { telegram: ctx.telegram },
    `📝 ${reports.mentionHtml(emp)} <b>${created.length} ta yangi missiya</b> yozib qo'ydi:\n` +
      created
        .map((m, i) => `${i + 1}. ${ui.esc(m.title)} <i>(${time.prettyDate(m.due_date)} gacha)</i>`)
        .join('\n'),
  );
};

const showMyMissions = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  await missions.activateDue(emp.id);

  const open = await missions.openFor(emp.id);
  const pending = await missions.pendingFor(emp.id);
  const doneToday = await missions.doneOn(emp.id);
  activity.mark(ctx, 'my_missions', { detail: `${open.length} ta ochiq, ${doneToday.length} ta bajarilgan` });

  const text =
    `📋 <b>MISSIYALARIM</b> · ${time.prettyDate(time.today())}\n\n` +
    `🎯 <b>Bajarilishi kerak (${open.length})</b>\n${ui.missionList(open)}\n\n` +
    `📅 <b>Keyingi kunlarga (${pending.length})</b>\n` +
    (pending.length
      ? pending
          .map((m, i) => `${i + 1}. ${ui.esc(m.title)}\n   <i>${time.prettyDate(m.start_date)} dan</i>`)
          .join('\n')
      : "<i>— bo'sh —</i>") +
    `\n\n✅ <b>Bugun bajarilgan (${doneToday.length})</b>\n` +
    (doneToday.length
      ? doneToday
          .map((m, i) => `${i + 1}. <s>${ui.esc(m.title)}</s> <i>${time.clock(m.done_at)}</i>`)
          .join('\n')
      : "<i>— hali yo'q —</i>");

  return ctx.reply(text, { parse_mode: 'HTML' });
};

const showDonePicker = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  await missions.activateDue(emp.id);
  const open = await missions.openFor(emp.id);
  if (!open.length) {
    return ctx.reply(
      "🎉 Bajarilmagan missiya yo'q. Hammasi tugatilgan!",
      ui.mainKeyboard(ctx.state.isAdmin),
    );
  }
  const doneToday = await missions.doneOn(emp.id);
  return ctx.reply(ui.doneChecklist(open, doneToday), {
    parse_mode: 'HTML',
    ...ui.doneKeyboard(open),
  });
};

const onDone = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery("Ro'yxatdan o'tmagansiz");

  const raw = ctx.match[1];
  if (raw !== 'refresh') {
    const res = await missions.markDone(Number(raw), emp.id);
    if (!res.ok) {
      await ctx.answerCbQuery(res.reason === 'already' ? 'Allaqachon bajarilgan' : 'Topilmadi');
    } else {
      await ctx.answerCbQuery('✅ Bajarildi!');
      const left = (await missions.openFor(emp.id)).length;
      activity.mark(ctx, 'mission_done', {
        title: res.mission.title,
        detail: left ? `yana ${left} ta qoldi` : 'barcha ishlar tugadi',
      });
      if (config.announceDone) {
        await notify.toGroup(
          { telegram: ctx.telegram },
          `✅ ${reports.mentionHtml(emp)} — «<b>${ui.esc(res.mission.title)}</b>» bajarildi · ${time.clock(res.mission.done_at)}\n` +
            (left ? `<i>Qolgan missiyalar: ${left} ta</i>` : `🎉 <i>Barcha missiyalar bajarildi!</i>`),
        );
      }
      // Boshqaruvchi(lar)ga — har bir bajarilgan missiya haqida
      const admins = await employees.listAdmins();
      for (const adm of admins) {
        if (Number(adm.tg_id) === Number(emp.tg_id)) continue;
        await notify.toUser(
          { telegram: ctx.telegram },
          adm.tg_id,
          `✅ <b>${ui.esc(emp.full_name)}</b> bajardi: «<b>${ui.esc(res.mission.title)}</b>» · ${time.clock(res.mission.done_at)}` +
            (left ? `\n<i>Unda yana ${left} ta ish qoldi.</i>` : `\n🎉 <i>Barcha ishlarini tugatdi.</i>`),
        );
      }
    }
  } else {
    await ctx.answerCbQuery('Yangilandi');
  }

  const open = await missions.openFor(emp.id);
  const doneToday = await missions.doneOn(emp.id);
  const body = ui.doneChecklist(open, doneToday);

  try {
    await ctx.editMessageText(body, {
      parse_mode: 'HTML',
      ...(open.length ? ui.doneKeyboard(open) : {}),
    });
  } catch {
    /* matn o'zgarmagan bo'lsa Telegram xato beradi — e'tiborsiz qoldiramiz */
  }
};

const showCancelPicker = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  const list = [...(await missions.openFor(emp.id)), ...(await missions.pendingFor(emp.id))];
  if (!list.length) return ctx.reply("O'chiradigan missiya yo'q.");
  return ctx.reply("🗑 <b>Qaysi missiyani o'chirasiz?</b>", {
    parse_mode: 'HTML',
    ...ui.cancelKeyboard(list),
  });
};

const onCancel = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery();
  const res = await missions.cancel(Number(ctx.match[1]), emp.id);
  await ctx.answerCbQuery(res.ok ? "O'chirildi" : 'Topilmadi');
  if (res.ok) activity.mark(ctx, 'mission_cancel', { title: res.mission.title });
  const list = [...(await missions.openFor(emp.id)), ...(await missions.pendingFor(emp.id))];
  try {
    if (list.length) {
      await ctx.editMessageText("🗑 <b>Qaysi missiyani o'chirasiz?</b>", {
        parse_mode: 'HTML',
        ...ui.cancelKeyboard(list),
      });
    } else {
      await ctx.editMessageText("✅ Ro'yxat bo'sh.");
    }
  } catch {
    /* noop */
  }
};

const showMyReport = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  const t = time.today();
  const st = await missions.dayStats(emp.id, t);
  const att = await attendance.get(emp.id, t);
  const week = await missions.rangeStats(emp.id, time.addDays(t, -6), t);
  const month = await missions.rangeStats(emp.id, time.addDays(t, -29), t);
  activity.mark(ctx, 'my_report');

  return ctx.reply(
    `📊 <b>HISOBOTIM</b> · ${time.prettyDate(t)}\n\n` +
      `🕘 Ishga keldi: <b>${att && att.checked_in ? time.clock(att.checked_in) : '—'}</b>\n` +
      `🏁 Ishdan ketdi: <b>${att && att.checked_out ? time.clock(att.checked_out) : '—'}</b>\n\n` +
      `<b>Bugun</b>\n✅ Bajarildi: ${st.done}\n⏳ Qoldi: ${st.open}\n` +
      (st.overdue ? `⚠️ Kechikkan: ${st.overdue}\n` : '') +
      `\n<b>So'nggi 7 kun</b>\n✅ Bajarildi: ${week.done}\n` +
      `\n<b>So'nggi 30 kun</b>\n✅ Bajarildi: ${month.done}`,
    { parse_mode: 'HTML', ...ui.myReportKeyboard() },
  );
};

/** Kun ichida paydo bo'lgan topshiriqni bugunga tez qo'shish: /bugun <matn> */
const addTodayTask = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  const arg = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
  if (!arg) {
    return ctx.reply(
      "📌 Bugungi topshiriqni yozing:\n<code>/bugun Yangi mijoz bilan uchrashuv</code>\n\n" +
        "Bir nechta bo'lsa har birini yangi qatorga yozing. Bu ish <b>bugundan</b> faol bo'ladi va kun oxiridagi hisobotga tushadi.",
      { parse_mode: 'HTML' },
    );
  }
  const items = parseTitles(arg);
  if (!items.length) return ctx.reply('❌ Matn juda qisqa.');

  const t = time.today();
  const created = [];
  for (const it of items) {
    created.push(await missions.create({ employeeId: emp.id, title: it.title, startDate: t, dueDate: t }));
  }

  created.forEach((m) => activity.mark(ctx, 'mission_today', { title: m.title }));

  await ctx.reply(
    `✅ <b>${created.length} ta bugungi topshiriq qo'shildi</b> (bugundan faol):\n\n` +
      created.map((m, i) => `${i + 1}. ${ui.esc(m.title)}`).join('\n') +
      `\n\nBajargach «✔️ Bajardim» bilan belgilang — kun oxirgi hisobotda ko'rinadi.`,
    { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
  );

  await notify.toGroup(
    { telegram: ctx.telegram },
    `📌 ${reports.mentionHtml(emp)} bugunga <b>${created.length} ta qo'shimcha topshiriq</b> qo'shdi:\n` +
      created.map((m, i) => `${i + 1}. ${ui.esc(m.title)}`).join('\n'),
  );
};

/** Shaxsiy yoki (admin bo'lsa) jamoa Excel hisobotini yuborish */
const sendMyExcel = async (ctx, { viaCallback = false } = {}) => {
  const emp = ctx.state.employee;
  if (!emp) return viaCallback ? ctx.answerCbQuery("Ro'yxatdan o'tmagansiz") : notRegistered(ctx);
  if (viaCallback) await ctx.answerCbQuery('Tayyorlanmoqda…');

  const t = time.today();
  activity.mark(ctx, 'excel', { detail: 'shaxsiy kunlik hisobot' });
  const { buffer, filename } = await excel.buildDayReport(t, {
    employeeId: emp.id,
    scopeName: emp.full_name,
  });
  await notify.docToUser(
    { telegram: ctx.telegram },
    ctx.from.id,
    buffer,
    filename,
    `📥 <b>${ui.esc(emp.full_name)}</b> — ${time.prettyDate(t)} ishlari (Excel)`,
  );
};

const register = (bot) => {
  bot.hears(ui.BTN.addMission, (ctx) =>
    ctx.state.employee ? startWizard(ctx) : notRegistered(ctx),
  );
  bot.command('vazifa', async (ctx) => {
    if (!ctx.state.employee) return notRegistered(ctx);
    const arg = ctx.message.text.replace(/^\/\S+\s*/, '');
    if (!arg.trim()) return startWizard(ctx);
    const items = parseTitles(arg);
    if (!items.length) return startWizard(ctx);
    session.set(ctx.from.id, { step: 'duration', items });
    return askDuration(ctx, items);
  });

  bot.action(/^dur:(.+)$/, onDuration);

  bot.hears(ui.BTN.myMissions, showMyMissions);
  bot.command('missiyalarim', showMyMissions);

  bot.hears(ui.BTN.done, showDonePicker);
  bot.command('bajardim', showDonePicker);
  bot.action(/^done:(.+)$/, onDone);

  bot.command('bekor', showCancelPicker);
  bot.action(/^cancel:(\d+)$/, onCancel);

  bot.hears(ui.BTN.report, showMyReport);
  bot.command('hisobot', showMyReport);

  bot.command('bugun', addTodayTask);
  bot.command('excel', (ctx) => sendMyExcel(ctx));
  bot.action('excel:me', (ctx) => sendMyExcel(ctx, { viaCallback: true }));
};

module.exports = { register, handleTitlesInput, parseTitles, datesFor };
