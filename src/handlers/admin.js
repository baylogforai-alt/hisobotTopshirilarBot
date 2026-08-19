'use strict';

const config = require('../config');
const db = require('../db');
const ui = require('../ui');
const time = require('../time');
const employees = require('../services/employees');
const missions = require('../services/missions');
const attendance = require('../services/attendance');
const reports = require('../services/reports');
const notify = require('../services/notify');

const guard = async (ctx) => {
  if (!ctx.state.isAdmin) {
    await ctx.reply('⛔️ Bu buyruq faqat administrator uchun.');
    return false;
  }
  return true;
};

const args = (ctx) => ctx.message.text.replace(/^\/\S+\s*/, '').trim();

/** /hodim_qosh 123456789 Akbar Karimov | Menejer */
const addEmployee = async (ctx) => {
  if (!(await guard(ctx))) return;
  const raw = args(ctx);
  const m = raw.match(/^(\d{5,15})\s+([\s\S]+)$/);
  if (!m) {
    return ctx.reply(
      '📌 Ishlatish:\n<code>/hodim_qosh 123456789 Akbar Karimov</code>\n' +
        'Lavozim bilan:\n<code>/hodim_qosh 123456789 Akbar Karimov | Menejer</code>\n\n' +
        "Hodim o'z ID sini botga /id yozib bilib oladi.",
      { parse_mode: 'HTML' },
    );
  }
  const tgId = Number(m[1]);
  const [namePart, positionPart] = m[2].split('|').map((s) => s.trim());
  if (!namePart) return ctx.reply('❌ Ism kiritilmadi.');

  const { employee, created } = await employees.add({
    tgId,
    fullName: namePart,
    position: positionPart || null,
  });

  await ctx.reply(
    `${created ? "✅ Yangi hodim qo'shildi" : "♻️ Hodim ma'lumoti yangilandi"}\n\n` +
      `👤 <b>${ui.esc(employee.full_name)}</b>\n` +
      (employee.position ? `💼 ${ui.esc(employee.position)}\n` : '') +
      `🆔 <code>${employee.tg_id}</code>`,
    { parse_mode: 'HTML' },
  );

  await notify.toUser(
    { telegram: ctx.telegram },
    tgId,
    `🎉 <b>Siz ${ui.esc(config.companyName)} tizimiga hodim sifatida qo'shildingiz!</b>\n\n` +
      `👤 ${ui.esc(employee.full_name)}\n\n` +
      `Botni ishga tushirish uchun /start bosing.\nQo'llanma: /yordam`,
  );
};

const listEmployees = async (ctx) => {
  if (!(await guard(ctx))) return;
  const list = await employees.listAll();
  if (!list.length) return ctx.reply("Hodimlar yo'q. /hodim_qosh bilan qo'shing.");

  const parts = [];
  for (const e of list) {
    const badge = !e.active ? '⚫️' : e.role === 'admin' ? '👑' : '👤';
    const inOffice = (await attendance.isCheckedIn(e.id)) ? ' 🟢' : '';
    parts.push(
      `${badge} <b>${ui.esc(e.full_name)}</b>${inOffice}\n` +
        `   🆔 <code>${e.tg_id}</code>${e.position ? ` · ${ui.esc(e.position)}` : ''}` +
        (e.username ? ` · @${ui.esc(e.username)}` : '') +
        (!e.active ? " · <i>o'chirilgan</i>" : ''),
    );
  }
  return ctx.reply(`👥 <b>HODIMLAR (${list.length})</b>\n\n${parts.join('\n')}`, {
    parse_mode: 'HTML',
  });
};

const removeEmployee = async (ctx) => {
  if (!(await guard(ctx))) return;
  const id = Number(args(ctx));
  if (!id) return ctx.reply('📌 <code>/hodim_ochir 123456789</code>', { parse_mode: 'HTML' });
  const e = await employees.byTgId(id);
  if (!e) return ctx.reply('❌ Bunday hodim topilmadi.');
  await employees.deactivate(id);
  return ctx.reply(`⚫️ <b>${ui.esc(e.full_name)}</b> ro'yxatdan chiqarildi.`, { parse_mode: 'HTML' });
};

const restoreEmployee = async (ctx) => {
  if (!(await guard(ctx))) return;
  const id = Number(args(ctx));
  if (!id) return ctx.reply('📌 <code>/hodim_tikla 123456789</code>', { parse_mode: 'HTML' });
  const e = await employees.byTgId(id);
  if (!e) return ctx.reply('❌ Bunday hodim topilmadi.');
  await employees.activate(id);
  return ctx.reply(`✅ <b>${ui.esc(e.full_name)}</b> qayta faollashtirildi.`, { parse_mode: 'HTML' });
};

const makeAdmin = async (ctx) => {
  if (!(await guard(ctx))) return;
  const id = Number(args(ctx));
  if (!id) return ctx.reply('📌 <code>/admin_qil 123456789</code>', { parse_mode: 'HTML' });
  const e = await employees.byTgId(id);
  if (!e) return ctx.reply("❌ Avval /hodim_qosh bilan qo'shing.");
  await employees.setRole(id, e.role === 'admin' ? 'employee' : 'admin');
  const updated = await employees.byTgId(id);
  return ctx.reply(
    `${updated.role === 'admin' ? '👑' : '👤'} <b>${ui.esc(updated.full_name)}</b> → ` +
      `<b>${updated.role === 'admin' ? 'administrator' : 'oddiy hodim'}</b>`,
    { parse_mode: 'HTML' },
  );
};

/** /topshiriq 123456789 Yuklarni tekshirish | 3 */
const assignMission = async (ctx) => {
  if (!(await guard(ctx))) return;
  const raw = args(ctx);
  const m = raw.match(/^(\d{5,15})\s+([\s\S]+)$/);
  if (!m) {
    return ctx.reply(
      '📌 <code>/topshiriq 123456789 Yuklarni tekshirish</code>\n' +
        'Muddat bilan: <code>/topshiriq 123456789 Oylik hisobot | 30</code>',
      { parse_mode: 'HTML' },
    );
  }
  const emp = await employees.byTgId(Number(m[1]));
  if (!emp || !emp.active) return ctx.reply('❌ Faol hodim topilmadi.');

  const parts = m[2].split('|');
  const title = parts[0].trim();
  const days = Number(parts[1]) > 0 ? Number(parts[1]) : 1;
  const start = time.addDays(time.today(), 1);
  const mission = await missions.create({
    employeeId: emp.id,
    title,
    startDate: start,
    dueDate: time.addDays(start, days - 1),
    createdBy: ctx.from.id,
  });

  await ctx.reply(
    `✅ <b>${ui.esc(emp.full_name)}</b> ga topshiriq berildi:\n` +
      `«${ui.esc(mission.title)}»\n<i>Muddat: ${time.prettyDate(mission.due_date)}</i>`,
    { parse_mode: 'HTML' },
  );

  await notify.toUser(
    { telegram: ctx.telegram },
    emp.tg_id,
    `📌 <b>Sizga yangi topshiriq berildi</b>\n\n` +
      `«${ui.esc(mission.title)}»\n<i>Muddat: ${time.prettyDate(mission.due_date)}</i>\n\n` +
      `Bajargach «✔️ Bajardim» tugmasi orqali belgilang.`,
  );

  await notify.toGroup(
    { telegram: ctx.telegram },
    `📌 ${reports.mentionHtml(emp)} ga yangi topshiriq: «<b>${ui.esc(mission.title)}</b>»\n` +
      `<i>Muddat: ${time.prettyDate(mission.due_date)}</i>`,
  );
};

const overallReport = async (ctx) => {
  if (!(await guard(ctx))) return;
  return ctx.reply(await reports.buildLiveReport(), { parse_mode: 'HTML' });
};

const overdueReport = async (ctx) => {
  if (!(await guard(ctx))) return;
  return ctx.reply(await reports.buildOverdueReport(), { parse_mode: 'HTML' });
};

const manualReminder = async (ctx) => {
  if (!(await guard(ctx))) return;
  const res = await reports.sendReminder({ telegram: ctx.telegram }, { force: true });
  return ctx.reply(
    res.sent ? `🔔 Eslatma yuborildi (${res.employees || 0} hodimga).` : "ℹ️ Eslatadigan hech narsa yo'q.",
  );
};

/** Tizim holati — baza, guruh, hodimlar */
const systemStatus = async (ctx) => {
  if (!(await guard(ctx))) return;
  const groupId = await notify.getGroupId();
  const list = await employees.listActive();
  const working = await attendance.workingNow();
  return ctx.reply(
    `🩺 <b>TIZIM HOLATI</b>\n\n` +
      `🗄 Baza: <b>${db.driver === 'postgres' ? 'PostgreSQL (Supabase)' : 'SQLite (mahalliy fayl)'}</b>\n` +
      `💬 Guruh: ${groupId ? `<code>${groupId}</code>` : "<b>ulanmagan</b> — guruhda /guruh_ulash yozing"}\n` +
      `👥 Faol hodimlar: <b>${list.length}</b>\n` +
      `🟢 Hozir ishda: <b>${working.length}</b>\n` +
      `🕒 Server vaqti: <b>${time.now().toFormat('yyyy-MM-dd HH:mm')}</b> (${config.timezone})\n` +
      `⏰ Ish vaqti: ${config.workStartHour}:00–${config.workEndHour}:00, har ${config.reminderIntervalHours} soatda eslatma`,
    { parse_mode: 'HTML' },
  );
};

const panel = async (ctx) => {
  if (!(await guard(ctx))) return;
  return ctx.reply('⚙️ <b>Admin panel</b>', { parse_mode: 'HTML', ...ui.adminKeyboard() });
};

const register = (bot) => {
  bot.command('hodim_qosh', addEmployee);
  bot.command('hodimlar', listEmployees);
  bot.command('hodim_ochir', removeEmployee);
  bot.command('hodim_tikla', restoreEmployee);
  bot.command('admin_qil', makeAdmin);
  bot.command('topshiriq', assignMission);
  bot.command('umumiy_hisobot', overallReport);
  bot.command('kechikkanlar', overdueReport);
  bot.command('eslat', manualReminder);
  bot.command('holat', systemStatus);

  bot.hears(ui.BTN.admin, panel);

  bot.action('adm:list', async (ctx) => {
    await ctx.answerCbQuery();
    return listEmployees(ctx);
  });
  bot.action('adm:report', async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.state.isAdmin) return;
    return ctx.reply(await reports.buildLiveReport(), { parse_mode: 'HTML' });
  });
  bot.action('adm:overdue', async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.state.isAdmin) return;
    return ctx.reply(await reports.buildOverdueReport(), { parse_mode: 'HTML' });
  });
  bot.action('adm:remind', async (ctx) => {
    await ctx.answerCbQuery('Yuborilmoqda...');
    if (!ctx.state.isAdmin) return;
    const res = await reports.sendReminder({ telegram: ctx.telegram }, { force: true });
    return ctx.reply(res.sent ? '🔔 Eslatma yuborildi.' : "ℹ️ Eslatadigan hech narsa yo'q.");
  });
};

module.exports = { register };
