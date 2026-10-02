'use strict';

const ui = require('../ui');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const reminders = require('../services/reminders');
const worktime = require('../services/worktime');
const org = require('../services/org');
const flows = require('../services/flows');
const { notRegistered } = require('./common');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * «🔔 ESLATMALAR».
 *   Hodim: rm:int:<N> (har N soat) / rm:custom (o'z vaqtlari) — so'rov FAQAT BOSHLIQQA (rs:ok|no:<empId>); rm:reset — umumiyga qaytish.
 *   HR: eslatma sozlamalari yo'q (menyuda ham ko'rinmaydi).
 *   Boshliq / direktor (rm:adm): umumiy oraliq (rm:g:<N>), bo'lim vaqtlari (rm:dl, rm:d:<id>, rm:di:<id>:<N>, rm:dc:<id>, rm:dr:<id>),
 *   hodim vaqtlari (rm:el, rm:e:<id>, rm:ei:<id>:<N>, rm:ec:<id>, rm:er:<id>), so'rovlar (rm:pend).
 *   Ustuvorlik: hodim vaqti → bo'lim vaqti → umumiy oraliq.
 */

const currentText = (emp) => flows.remindCurrentText(emp);
const isHrOnly = (ctx) => ctx.state.isHr && !ctx.state.isAdmin;
const HR_TEXT = '🔔 Eslatma vaqtlarini boshliq belgilaydi.';

const home = async (ctx) => {
  if (ctx.state.isAdmin) return adminHome(ctx);
  const emp = ctx.state.employee;
  if (!emp) return notRegistered(ctx);
  if (isHrOnly(ctx)) return ctx.reply(HR_TEXT, ui.kbFor(ctx));
  const rows = [
    [1, 2, 3, 4].map((n) => cb(`Har ${n} soat`, `rm:int:${n}`)),
    [cb("🕐 Vaqtlarni o'zim yozaman", 'rm:custom')],
  ];
  if (emp.remind_times) rows.push([cb('↩️ Umumiy jadvalga qaytish', 'rm:reset')]);
  return render(
    ctx,
    `🔔 <b>ESLATMALAR</b>\n${ui.LINE}\nOchiq topshiriqlaringiz haqida eslatma vaqtlari:\n<b>${await currentText(emp)}</b>` +
      (emp.remind_pending ? `\n\n⏳ Tasdiq kutilmoqda: <b>${esc(reminders.listOf(emp.remind_pending).join(', '))}</b>` : '') +
      `\n\nBoshqa vaqtni tanlang — so'rov boshliqqa (${esc(await org.bossName())}) boradi, tasdiqlansa shu vaqtlarda keladi.`,
    inline(rows),
  );
};

/** So'rovni saqlab boshliqqa yuboradi */
const sendRequest = async (ctx, times, label) => {
  const emp = ctx.state.employee;
  const { auto } = await flows.requestReminders(botOf(ctx), emp, times, label);
  const msg = auto
    ? `✅ Eslatma jadvalingiz o'zgardi: <b>${esc(times.join(', '))}</b>.`
    : `📨 So'rov yuborildi: <b>${esc(times.join(', '))}</b>.\nBoshliq (${esc(await org.bossName())}) tasdiqlagach shu vaqtlarda eslatma keladi.`;
  if (ctx.updateType === 'callback_query') return render(ctx, msg);
  return ctx.reply(msg, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
};

const BAD_TIMES = "Vaqtlarni vergul bilan yozing, 06:00–21:55 oralig'ida, ko'pi bilan 8 ta. Masalan: <code>10:00, 13:00, 16:30</code>";

const handleCustomText = async (ctx) => {
  session.clear(ctx.from.id);
  if (isHrOnly(ctx)) return ctx.reply(HR_TEXT, ui.kbFor(ctx));
  const times = reminders.parseTimes(ctx.message.text);
  if (!times) {
    session.set(ctx.from.id, { step: 'remind_times' });
    return ctx.reply(BAD_TIMES, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  }
  return sendRequest(ctx, times, "o'zi tanlagan vaqtlar");
};

const decide = async (ctx, verdict, empId) => {
  const emp = await employees.byId(empId);
  if (!emp) return ctx.answerCbQuery('Topilmadi');
  const me = ctx.state.employee;
  if (!ctx.state.isAdmin || (me && Number(me.id) === Number(emp.id))) return ctx.answerCbQuery('⛔️ Faqat boshliq');
  if (!emp.remind_pending) {
    await ctx.answerCbQuery("Allaqachon ko'rib chiqilgan");
    return render(ctx, `ℹ️ <b>${esc(emp.full_name)}</b> — eslatma so'rovi allaqachon ko'rib chiqilgan.`);
  }
  const who = org.actorName(ctx);
  const times = await flows.decideReminders(botOf(ctx), emp, verdict === 'ok', who);
  await ctx.answerCbQuery(verdict === 'ok' ? 'Tasdiqlandi' : 'Rad etildi');
  return render(ctx, `${verdict === 'ok' ? '✅ Tasdiqlandi' : '❌ Rad etildi'}: <b>${esc(emp.full_name)}</b> — eslatmalar ${esc(times)}\n<i>qaror: ${esc(who)}</i>`);
};

// ---------------------------------------------------------------------------
// BOSHLIQ — umumiy, bo'lim va hodim vaqtlari
// ---------------------------------------------------------------------------

const adminHome = async (ctx) => {
  const step = await reminders.globalStep();
  const depts = await departments.listActive();
  const active = await employees.listActive();
  const own = active.filter((e) => e.remind_times);
  const pending = active.filter((e) => e.remind_pending);
  const deptSet = depts.filter((d) => d.remind_times);
  const text =
    `🔔 <b>ESLATMALAR</b> — boshqaruv\n${ui.LINE}\n` +
    `🌐 Umumiy: har <b>${step}</b> soatda — ${reminders.intervalTimes(worktime.minutes(), step).join(', ') || '—'}\n` +
    `🏢 Bo'lim jadvali: <b>${deptSet.length}</b> ta${deptSet.length ? ` (${deptSet.map((d) => `${esc(d.name)}: ${esc(reminders.listOf(d.remind_times).join(', '))}`).join('; ')})` : ''}\n` +
    `👤 Hodim jadvali: <b>${own.length}</b> ta\n` +
    `⏳ So'rovlar: <b>${pending.length}</b>\n\n` +
    `<i>Tartib: hodimga qo'yilgan vaqt → bo'limga qo'yilgan vaqt → umumiy oraliq.</i>`;
  const rows = [
    [1, 2, 3, 4].map((n) => cb(`${n === step ? '✅ ' : ''}${n} soat`, `rm:g:${n}`)),
    [cb("🏢 Bo'limlar bo'yicha", 'rm:dl'), cb('👤 Hodimlar bo\'yicha', 'rm:el')],
  ];
  if (pending.length) rows.push([cb(`⏳ So'rovlar (${pending.length})`, 'rm:pend')]);
  return render(ctx, text, inline(rows));
};

const deptList = async (ctx) => {
  const step = await reminders.globalStep();
  const rows = (await departments.listActive()).map((d) => [cb(`🏢 ${d.name} — ${d.remind_times ? reminders.listOf(d.remind_times).join(', ') : `umumiy (${step} soat)`}`.slice(0, 60), `rm:d:${d.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'rm:adm')]);
  return render(ctx, "🏢 <b>Qaysi bo'lim?</b>\n<i>Bo'limga vaqt qo'yilsa — o'z vaqti yo'q hamma a'zolariga shu vaqtda eslatiladi.</i>", inline(rows));
};

const deptCard = async (ctx, id) => {
  const d = await departments.byId(id);
  if (!d) return render(ctx, "Bo'lim topilmadi.", inline([[cb('⬅️ Orqaga', 'rm:dl')]]));
  const step = await reminders.globalStep();
  const members = (await employees.listByDepartment(d.id));
  const rows = [
    [1, 2, 3, 4].map((n) => cb(`Har ${n} soat`, `rm:di:${d.id}:${n}`)),
    [cb("🕐 Vaqtlarni yozaman", `rm:dc:${d.id}`)],
  ];
  if (d.remind_times) rows.push([cb('↩️ Umumiy jadvalga qaytarish', `rm:dr:${d.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'rm:dl')]);
  return render(
    ctx,
    `🏢 <b>${esc(d.name)}</b> — eslatmalar\n${ui.LINE}\nHozir: <b>${d.remind_times ? esc(reminders.listOf(d.remind_times).join(', ')) : `umumiy, har ${step} soatda`}</b>\n` +
      `A'zolar: ${members.length} ta${members.filter((e) => e.remind_times).length ? ` (shundan ${members.filter((e) => e.remind_times).length} tasining o'z vaqti bor)` : ''}`,
    inline(rows),
  );
};

const empList = async (ctx) => {
  const step = await reminders.globalStep();
  const rows = (await employees.listActive()).map((e) => {
    const src = reminders.sourceOf(e);
    const mark = e.remind_pending ? '⏳' : src === 'own' ? '👤' : src === 'dept' ? '🏢' : '🌐';
    return [cb(`${mark} ${e.full_name} — ${reminders.timesFor(e, step, employees.startMinutesOf(e)).join(', ') || '—'}`.slice(0, 60), `rm:e:${e.id}`)];
  });
  rows.push([cb('⬅️ Orqaga', 'rm:adm')]);
  return render(ctx, "👤 <b>Qaysi hodim?</b>\n<i>👤 o'z vaqti · 🏢 bo'lim vaqti · 🌐 umumiy · ⏳ so'rov kutmoqda</i>", inline(rows));
};

const empCard = async (ctx, id) => {
  const e = await employees.byId(id);
  if (!e) return render(ctx, 'Hodim topilmadi.', inline([[cb('⬅️ Orqaga', 'rm:el')]]));
  const rows = [
    [1, 2, 3, 4].map((n) => cb(`Har ${n} soat`, `rm:ei:${e.id}:${n}`)),
    [cb("🕐 Vaqtlarni yozaman", `rm:ec:${e.id}`)],
  ];
  if (e.remind_times) rows.push([cb("↩️ Bo'lim / umumiy jadvalga qaytarish", `rm:er:${e.id}`)]);
  if (e.remind_pending) rows.unshift([cb(`✅ So'rovni tasdiqlash`, `rs:ok:${e.id}`), cb('❌ Rad etish', `rs:no:${e.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'rm:el')]);
  return render(
    ctx,
    `👤 <b>${esc(e.full_name)}</b>${e.department_name ? ` · ${esc(e.department_name)}` : ''} — eslatmalar\n${ui.LINE}\nHozir: <b>${await currentText(e)}</b>` +
      (e.remind_pending ? `\n⏳ So'ragan: <b>${esc(reminders.listOf(e.remind_pending).join(', '))}</b>` : ''),
    inline(rows),
  );
};

const pendingList = async (ctx) => {
  const list = (await employees.listActive()).filter((e) => e.remind_pending);
  const rows = list.map((e) => [cb(`⏳ ${e.full_name}: ${reminders.listOf(e.remind_pending).join(', ')}`.slice(0, 60), `rm:e:${e.id}`)]);
  rows.push([cb('⬅️ Orqaga', 'rm:adm')]);
  return render(ctx, list.length ? "⏳ <b>Eslatma so'rovlari</b>" : "⏳ So'rov yo'q.", inline(rows));
};

const setEmpTimes = async (ctx, e, times) => {
  await flows.setReminderTimes(botOf(ctx), { employee: e }, times, org.actorName(ctx));
  return empCard(ctx, e.id);
};
const setDeptTimes = async (ctx, d, times) => {
  await flows.setReminderTimes(botOf(ctx), { department: d }, times, org.actorName(ctx));
  return deptCard(ctx, d.id);
};

/** Boshliq yozgan vaqtlar (remind_dept_times / remind_emp_times bosqichlari) */
const handleAdminTimesText = async (ctx) => {
  const s = session.get(ctx.from.id);
  const times = reminders.parseTimes(ctx.message.text);
  if (!times) return ctx.reply(BAD_TIMES, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  session.clear(ctx.from.id);
  if (s.step === 'remind_dept_times') {
    const d = await departments.byId(s.deptId);
    if (!d) return ctx.reply("Bo'lim topilmadi.", ui.kbFor(ctx));
    await flows.setReminderTimes(botOf(ctx), { department: d }, times, org.actorName(ctx));
    await ctx.reply(`✅ ${d.name}: ${times.join(', ')}`, ui.kbFor(ctx));
    return deptCard(ctx, d.id);
  }
  const e = await employees.byId(s.empId);
  if (!e) return ctx.reply('Hodim topilmadi.', ui.kbFor(ctx));
  await flows.setReminderTimes(botOf(ctx), { employee: e }, times, org.actorName(ctx));
  await ctx.reply(`✅ ${e.full_name}: ${times.join(', ')}`, ui.kbFor(ctx));
  return empCard(ctx, e.id);
};

const adminOnly = (fn) => async (ctx) => {
  if (!ctx.state.isAdmin) return ctx.answerCbQuery('⛔️ Faqat boshliq');
  await ctx.answerCbQuery();
  return fn(ctx);
};

const register = (bot) => {
  bot.hears(ui.BTN.reminders, home);
  bot.command('eslatma', home);
  bot.action('rm:home', async (ctx) => { await ctx.answerCbQuery(); return home(ctx); });
  bot.action(/^rm:int:([1-4])$/, async (ctx) => {
    const emp = ctx.state.employee;
    if (!emp || isHrOnly(ctx)) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    const n = Number(ctx.match[1]);
    const times = reminders.intervalTimes(employees.startMinutesOf(emp), n);
    if (!times.length) return render(ctx, "Bu oraliq ish vaqtiga sig'maydi — boshqasini tanlang.", ui.backKeyboard('rm:home'));
    return sendRequest(ctx, times, `har ${n} soatda`);
  });
  bot.action('rm:custom', async (ctx) => {
    if (!ctx.state.employee || isHrOnly(ctx)) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'remind_times' });
    return ctx.reply("🕐 Eslatma vaqtlarini vergul bilan yozing (masalan <code>10:00, 13:00, 16:30</code>):", { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  });
  bot.action('rm:reset', async (ctx) => {
    const emp = ctx.state.employee;
    if (!emp || isHrOnly(ctx)) return ctx.answerCbQuery('⛔️');
    await reminders.reset(emp.id);
    await ctx.answerCbQuery('Umumiy jadvalga qaytdi');
    ctx.state.employee = await employees.byId(emp.id);
    return home(ctx);
  });
  bot.action(/^rs:(ok|no):(\d+)$/, (ctx) => decide(ctx, ctx.match[1], ctx.match[2]));

  // boshliq
  bot.action('rm:adm', adminOnly(adminHome));
  bot.action(/^rm:g:([1-4])$/, adminOnly(async (ctx) => {
    await reminders.setGlobalStep(Number(ctx.match[1]));
    return adminHome(ctx);
  }));
  bot.action('rm:dl', adminOnly(deptList));
  bot.action('rm:el', adminOnly(empList));
  bot.action('rm:pend', adminOnly(pendingList));
  bot.action(/^rm:d:(\d+)$/, adminOnly((ctx) => deptCard(ctx, ctx.match[1])));
  bot.action(/^rm:e:(\d+)$/, adminOnly((ctx) => empCard(ctx, ctx.match[1])));
  bot.action(/^rm:di:(\d+):([1-4])$/, adminOnly(async (ctx) => {
    const d = await departments.byId(ctx.match[1]);
    if (!d) return deptList(ctx);
    return setDeptTimes(ctx, d, reminders.intervalTimes(worktime.minutes(), Number(ctx.match[2])));
  }));
  bot.action(/^rm:ei:(\d+):([1-4])$/, adminOnly(async (ctx) => {
    const e = await employees.byId(ctx.match[1]);
    if (!e) return empList(ctx);
    return setEmpTimes(ctx, e, reminders.intervalTimes(employees.startMinutesOf(e), Number(ctx.match[2])));
  }));
  bot.action(/^rm:dr:(\d+)$/, adminOnly(async (ctx) => {
    const d = await departments.byId(ctx.match[1]);
    return d ? setDeptTimes(ctx, d, null) : deptList(ctx);
  }));
  bot.action(/^rm:er:(\d+)$/, adminOnly(async (ctx) => {
    const e = await employees.byId(ctx.match[1]);
    return e ? setEmpTimes(ctx, e, null) : empList(ctx);
  }));
  bot.action(/^rm:dc:(\d+)$/, adminOnly(async (ctx) => {
    session.set(ctx.from.id, { step: 'remind_dept_times', deptId: Number(ctx.match[1]) });
    return ctx.reply("🕐 Bo'lim uchun eslatma vaqtlarini yozing (masalan <code>10:00, 13:00, 16:30</code>):", { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  }));
  bot.action(/^rm:ec:(\d+)$/, adminOnly(async (ctx) => {
    session.set(ctx.from.id, { step: 'remind_emp_times', empId: Number(ctx.match[1]) });
    return ctx.reply("🕐 Hodim uchun eslatma vaqtlarini yozing (masalan <code>10:00, 13:00, 16:30</code>):", { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  }));
};

module.exports = { register, home, handleCustomText, handleAdminTimesText };
