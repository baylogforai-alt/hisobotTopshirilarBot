'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const db = require('../db');
const session = require('../session');
const { render, guard, args } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const tasks = require('../services/tasks');
const attendance = require('../services/attendance');
const office = require('../services/office');
const notify = require('../services/notify');
const reports = require('../services/reports');
const backup = require('../services/backup');
const kpi = require('../services/kpi');
const activity = require('../services/activity');
const dailyReports = require('../services/dailyReports');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

const showPanel = (ctx) =>
  render(ctx, `⚙️ <b>PANEL</b> · ${esc(config.companyName)}\n<i>${time.prettyDate(time.today())}</i>`, ui.panelKeyboard());

// ---------------------------------------------------------------------------
// HODIMLAR
// ---------------------------------------------------------------------------

const listEmployees = async (ctx, deptId = null) => {
  const list = deptId === 0 ? await employees.listWithoutDepartment() : deptId ? await employees.listByDepartment(deptId) : await employees.listAll();
  const rows = list.map((e) => [cb(`${e.active ? ui.roleIcon(e.role) : '⛔'} ${e.full_name}${e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `emp:${e.id}`)]);
  rows.push([cb("➕ Hodim qo'shish", 'ea:start'), cb('⬅️ Panel', 'adm:home')]);
  const title = deptId === 0 ? "Bo'limsiz" : deptId ? (await departments.byId(deptId)).name : 'Hammasi';
  const active = list.filter((e) => e.active).length;
  return render(ctx, `👥 <b>HODIMLAR — ${esc(title)}</b> · faol ${active} / ${list.length}\n<i>👑 direktor · 🎖 boshliq · 👤 hodim · ⛔ ishdan ketgan</i>`, inline(rows));
};

const employeeCard = async (ctx, id) => {
  const e = await employees.byId(id);
  if (!e) return render(ctx, 'Hodim topilmadi.', ui.backKeyboard('emp:list'));
  const open = await tasks.openFor(e.id);
  const { from, to } = time.monthRange(time.month());
  const ts = await tasks.stats(e.id, from, to);
  const at = await attendance.stats(e, from, to);
  const row = await attendance.get(e.id);
  const st = attendance.dayStatus(row, time.today(), time.today(), e);
  const todayLabel = { ontime: `🟢 keldi ${time.clock(row && row.checked_in)}`, late: `🟡 kech ${time.clock(row && row.checked_in)}`, absent: '🔴 kelmagan', excused: '📄 sababli', pending: '🙋 sabab kutilmoqda', future: '⚪ hali yo\'q', off: '⚪ dam olish' }[st];
  const text =
    `${ui.roleIcon(e.role)} <b>${esc(e.full_name)}</b>${e.active ? '' : ' ⛔ <i>ishdan ketgan</i>'}\n` +
    `💼 ${esc(e.position || '—')} · 🏢 ${esc(e.department_name || "bo'limsiz")} · ${employees.roleLabel(e.role)}\n` +
    `🆔 <code>${e.tg_id}</code>${e.username ? ` · @${esc(e.username)}` : ''}${employees.isFlexible(e) ? ' · 🕊 erkin jadval' : ''}\n` +
    `💰 Bonus fondi: <b>${kpi.fmtMoney(e.bonus_fund)}</b> · 🕘 Ish boshlanishi: <b>${e.work_start || `${config.workStartHour}:00 (umumiy)`}</b>\n${ui.LINE}\n` +
    `Bugun: ${todayLabel}${(await dailyReports.get(e.id)) ? ' · 📝 hisobot topshirgan' : ''}\n` +
    `📋 Shu oy: ${ts.ontime}/${ts.total} muddatida (${ts.pct}%)${ts.overdue ? ` · 🔴 ${ts.overdue}` : ''} · ⏳ ochiq ${open.length}\n` +
    `🕘 Davomat: ${at.ontime}/${at.workDays} vaqtida (${at.pct}%)${at.late ? ` · 🟡 ${at.late}` : ''}${at.absent ? ` · 🔴 ${at.absent}` : ''}${at.excused ? ` · 📄 ${at.excused}` : ''}`;
  const rows = [
    [cb('📤 Topshiriq berish', `as:emp:${e.id}`), cb(`📋 Topshiriqlari (${open.length})`, `emp:tasks:${e.id}`)],
    [cb('✏️ Ism', `emp:name:${e.id}`), cb('💼 Lavozim', `emp:pos:${e.id}`), cb("🏢 Bo'lim", `emp:dept:${e.id}`)],
    [cb('🎖 Rol', `emp:role:${e.id}`), cb('💰 Bonus fondi', `emp:fund:${e.id}`), cb(employees.isFlexible(e) ? '🕊 Erkin: ha' : "🕊 Erkin: yo'q", `emp:flex:${e.id}`)],
    [cb('🕘 Ish boshlanishi', `emp:start:${e.id}`)],
    [cb('📄 Sababli kun belgilash', `emp:excuse:${e.id}`), cb('📊 Oylik hisobot', `rp:emp:${e.id}:${time.month()}`)],
    [cb('🗂 Kun daftari (arxiv)', `hr:emp:${e.id}`), cb('📥 Excel (davr)', `xl:emp:${e.id}`)],
    [cb(e.active ? '⛔ Ishdan ketdi' : '✅ Qayta faollashtirish', `emp:act:${e.id}`), cb("⬅️ Ro'yxat", 'emp:list')],
  ];
  return render(ctx, text, inline(rows));
};

const askText = (ctx, step, empId, prompt) => {
  session.set(ctx.from.id, { step, empId });
  return ctx.reply(prompt, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
};

const handleEmpText = async (ctx, field) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  if (!s.empId) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const text = ctx.message.text.trim();
  if (field === 'name') await employees.rename(s.empId, text.slice(0, 100));
  if (field === 'position') await employees.setPosition(s.empId, text.slice(0, 60));
  if (field === 'fund') {
    const n = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n)) return ctx.reply("Faqat raqam yozing (masalan 1000000). 0 — fondni o'chirish.", ui.cancelKeyboard());
    await employees.setBonusFund(s.empId, n > 0 ? n : null);
  }
  if (field === 'work_start') {
    if (/^(standart|umumiy|0|-)$/i.test(text) || text === ui.BTN.skip) await employees.setWorkStart(s.empId, null);
    else {
      const hhmm = employees.parseWorkStart(text);
      if (!hhmm) { session.set(ctx.from.id, { step: 'edit_work_start', empId: s.empId }); return ctx.reply('Vaqtni HH:mm ko\'rinishida yozing (masalan 10:00). Umumiy vaqtga qaytarish — «standart».', ui.cancelKeyboard()); }
      await employees.setWorkStart(s.empId, hhmm);
    }
  }
  if (field === 'excuse_date') {
    const d = time.parseDate(text);
    if (!d) return ctx.reply('Sana tushunilmadi (masalan 15.09):', ui.cancelKeyboard());
    session.set(ctx.from.id, { step: 'excuse_reason_admin', empId: s.empId, date: d });
    return ctx.reply(`📄 ${time.prettyDate(d)} — sababi (masalan: ta'til, kasal, komandirovka):`, ui.skipKeyboard());
  }
  if (field === 'excuse_reason') {
    const e = await employees.byId(s.empId);
    await attendance.decideExcuse(e.id, s.date, 'approved', ctx.from.id, text === ui.BTN.skip ? 'sababli' : text);
    await ctx.reply(`✅ ${esc(e.full_name)} — ${time.prettyDate(s.date)} sababli deb belgilandi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
    await notify.toUser(botOf(ctx), e.tg_id, `📄 ${time.prettyDate(s.date)} kuni direktor tomonidan <b>sababli</b> deb belgilandi.`);
    return employeeCard(ctx, e.id);
  }
  await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
  return employeeCard(ctx, s.empId);
};

const employeeTasks = async (ctx, id) => {
  const e = await employees.byId(id);
  const open = await tasks.openFor(e.id);
  const awaiting = await tasks.awaitingReviewFor(e.id);
  const rows = open.map((t) => [cb(`🗑 ${t.title.slice(0, 45)}`, `emp:tdel:${t.id}`)]);
  rows.push([cb('📤 Yangi topshiriq', `as:emp:${e.id}`), cb('⬅️ Kartochka', `emp:${e.id}`)]);
  return render(ctx, `📋 <b>${esc(e.full_name)}</b> — ochiq (${open.length}):\n${ui.taskList(open)}${awaiting.length ? `\n\n🕓 Tekshiruvda:\n${ui.taskList(awaiting)}` : ''}\n\n🗑 — bekor qilish`, inline(rows));
};

// ---------------------------------------------------------------------------
// BO'LIMLAR
// ---------------------------------------------------------------------------

const listDepartments = async (ctx) => {
  const list = await departments.listActive();
  const lines = [];
  for (const d of list) {
    const heads = await departments.headsOf(d.id);
    lines.push(`🏢 <b>${esc(d.name)}</b> — ${await departments.memberCount(d.id)} hodim${heads.length ? ` · boshliq: ${heads.map((h) => esc(h.full_name)).join(', ')}` : ' · <i>boshliq yo\'q</i>'}\n   <i>${esc(departments.weightsText(d))}</i>`);
  }
  const rows = list.map((d) => [cb(`🏢 ${d.name}`, `dp:${d.id}`)]);
  rows.push([cb("➕ Yangi bo'lim", 'dp:new'), cb('⬅️ Panel', 'adm:home')]);
  return render(ctx, `🏢 <b>BO'LIMLAR</b>\n<i>KPI vaznlari: topshiriq · davomat · boshliq bahosi · qo'shimcha mezon</i>\n\n${lines.join('\n') || "<i>Hali bo'lim yo'q — «➕ Yangi bo'lim» yoki hodim qo'shishda yaratiladi.</i>"}`, inline(rows));
};

const departmentCard = async (ctx, id) => {
  const d = await departments.byId(id);
  if (!d) return listDepartments(ctx);
  const members = await employees.listByDepartment(d.id);
  const text =
    `🏢 <b>${esc(d.name)}</b>\n${ui.LINE}\n` +
    `⚖️ <b>KPI vaznlari:</b>\n   📋 Topshiriq: ${d.w_tasks}%\n   🕘 Davomat: ${d.w_attendance}%\n   ⭐ Boshliq bahosi: ${d.w_head}%\n   🎯 ${esc(d.custom_name || "Qo'shimcha mezon")}: ${d.w_custom}%\n\n` +
    `👥 <b>Hodimlar (${members.length}):</b>\n${members.map((e) => `   ${ui.roleIcon(e.role)} ${esc(e.full_name)}${e.position ? ` · ${esc(e.position)}` : ''}`).join('\n') || '   <i>yo\'q</i>'}`;
  return render(ctx, text, inline([
    [cb("⚖️ Vaznlarni o'zgartirish", `dp:w:${d.id}`), cb('🎯 Mezon nomi', `dp:custom:${d.id}`)],
    [cb('✏️ Nomi', `dp:name:${d.id}`), cb('👥 Hodimlari', `emp:list:${d.id}`)],
    [cb('🗑 Yopish', `dp:del:${d.id}`), cb("⬅️ Bo'limlar", 'dp:list')],
  ]));
};

const handleDeptText = async (ctx, field) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  const text = ctx.message.text.trim();
  if (field === 'new') {
    const { department, created } = await departments.create(text);
    await ctx.reply(`🏢 «${esc(department.name)}» ${created ? 'yaratildi' : 'allaqachon bor'}.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
    return departmentCard(ctx, department.id);
  }
  if (!s.deptId) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  if (field === 'name') await departments.rename(s.deptId, text);
  if (field === 'custom') await departments.setCustomName(s.deptId, text === ui.BTN.skip ? null : text);
  if (field === 'weights') {
    const w = departments.parseWeights(text);
    if (!w) {
      session.set(ctx.from.id, { step: 'dept_weights', deptId: s.deptId });
      return ctx.reply("4 ta son, yig'indisi 100 bo'lsin. Masalan: <code>40 20 20 20</code>", { parse_mode: 'HTML', ...ui.cancelKeyboard() });
    }
    await departments.setWeights(s.deptId, w);
  }
  await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
  return departmentCard(ctx, s.deptId);
};

// ---------------------------------------------------------------------------
// BOSHQA
// ---------------------------------------------------------------------------

const showStatus = async (ctx) => {
  const groupId = await notify.getGroupId();
  const off = await office.get();
  const emps = await employees.listActive();
  const pendingReq = (await require('../services/requests').listPending()).length;
  const lastJobs = await db.query('SELECT kind, ran_at FROM reminder_log ORDER BY id DESC LIMIT 5');
  const text =
    `🩺 <b>TIZIM HOLATI</b>\n${ui.LINE}\n` +
    `🗄 Baza: ${db.driver === 'postgres' ? 'PostgreSQL (Supabase)' : 'SQLite (mahalliy)'}\n` +
    `👥 Faol hodimlar: ${emps.length} (👑 ${emps.filter((e) => e.role === 'admin').length} · 🎖 ${emps.filter((e) => e.role === 'head').length})\n` +
    `🏢 Bo'limlar: ${(await departments.listActive()).length}\n` +
    `💬 Guruh: ${groupId ? `<code>${groupId}</code>` : '❌ ulanmagan (/guruh_ulash guruh ichida)'}\n` +
    `📍 Ofis: ${off ? `${off.lat.toFixed(5)}, ${off.lon.toFixed(5)} · radius ${geo.prettyDistance(off.radius)}` : '❌ belgilanmagan'}\n` +
    `⏰ Ish vaqti: ${config.workStartHour}:00–${config.workEndHour}:00 · kechikish ruxsati ${config.lateGraceMinutes} daq · kunlar ${config.workDays}\n` +
    `📝 Kutilayotgan so'rovlar: ${pendingReq}\n` +
    `📣 Guruhga real vaqt e'lonlari: ${config.announceDone ? 'yoqilgan' : "o'chirilgan"} · 📝 kunlik hisobot: ${config.dailyReportRequired ? 'majburiy' : 'ixtiyoriy'}\n` +
    `🔗 CRM feed: ${config.crmApiSecret ? '/crm/snapshot ochiq (kalit bilan)' : "o'chirilgan"}\n` +
    `🕒 Server vaqti: ${time.now().toFormat('dd.MM.yyyy HH:mm')}\n` +
    (lastJobs.length ? `\n<b>Oxirgi cron ishlari:</b>\n${lastJobs.map((j) => `   ${j.kind} — ${time.shortDate(String(j.ran_at).slice(0, 10))} ${time.clock(j.ran_at)}`).join('\n')}` : '');
  return render(ctx, text, inline([[cb('💾 Zaxira nusxa', 'adm:backup'), cb('⬅️ Panel', 'adm:home')]]));
};

const showExcuses = async (ctx) => {
  const list = await attendance.pendingExcuses();
  if (!list.length) return render(ctx, "🙋 Kutilayotgan sababli kun so'rovlari yo'q.", ui.backKeyboard('adm:home'));
  for (const r of list) {
    await ctx.reply(`🙋 <b>${esc(r.full_name)}</b> — ${time.prettyDate(r.work_date)}\n«${esc(r.excuse_reason || '')}»`, { parse_mode: 'HTML', ...ui.excuseKeyboard(r.id) });
  }
};

const showOverdue = async (ctx) => {
  const list = await tasks.overdue(ctx.state.isAdmin ? null : ctx.state.employee.department_id);
  return render(ctx, list.length ? `⚠️ <b>MUDDATI O'TGAN (${list.length})</b>\n\n${ui.taskList(list, { withName: true })}` : "✅ Muddati o'tgan topshiriq yo'q.", ui.backKeyboard('adm:home'));
};

const register = (bot) => {
  bot.hears(ui.BTN.panel, async (ctx) => { if (await guard(ctx)) await showPanel(ctx); });
  bot.command('panel', async (ctx) => { if (await guard(ctx)) await showPanel(ctx); });
  bot.action('adm:home', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showPanel(ctx); } });

  bot.action('adm:today', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const { text } = await reports.buildToday();
    return render(ctx, text, inline([[cb('📥 Excel (bugun)', 'rp:xlday'), cb('⬅️ Panel', 'adm:home')]]));
  });
  bot.command(['holat', 'umumiy_hisobot'], async (ctx) => { if (await guard(ctx)) await render(ctx, (await reports.buildToday()).text, inline([[cb('📥 Excel (bugun)', 'rp:xlday')]])); });
  bot.command('kun_hisobot', async (ctx) => { if (await guard(ctx)) await render(ctx, await reports.buildDailyGroupText()); });
  bot.command('kechikkanlar', async (ctx) => { if (await guard(ctx)) await showOverdue(ctx); });
  bot.command('eslat', async (ctx) => {
    if (!(await guard(ctx))) return;
    const r = await reports.sendReminder(botOf(ctx));
    await ctx.reply(`🔔 Eslatma ${r.sent} ta hodimga, ${r.reviewers} ta tekshiruvchiga yuborildi${r.group ? ' (guruhga ham)' : ''}.`);
  });
  bot.command('tizim', async (ctx) => { if (await guard(ctx)) await showStatus(ctx); });
  bot.command('ofis_korish', async (ctx) => {
    if (!(await guard(ctx))) return;
    const off = await office.get();
    return ctx.reply(off ? `📍 Ofis: ${off.lat.toFixed(5)}, ${off.lon.toFixed(5)} · radius ${geo.prettyDistance(off.radius)}` : "📍 Ofis joylashuvi belgilanmagan — /ofis");
  });
  bot.command('ofis_ochir', async (ctx) => {
    if (!(await guard(ctx))) return;
    await office.clear();
    return ctx.reply("✅ Ofis geofence o'chirildi — joylashuv saqlanadi, lekin masofa tekshirilmaydi.");
  });
  /** Eski qisqa buyruqlar: /hodim_ochir <id> · /hodim_tikla <id> · /admin_qil <id> · /erkin <id> */
  const byArgTg = async (ctx) => {
    const m = args(ctx).match(/\d{5,15}/);
    const e = m ? await employees.byTgId(Number(m[0])) : null;
    if (!e) await ctx.reply('❌ Hodim topilmadi. Telegram ID yozing, masalan: /erkin 123456789');
    return e;
  };
  bot.command('hodim_ochir', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) { await employees.deactivate(e.id); await employeeCard(ctx, e.id); } });
  bot.command('hodim_tikla', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) { await employees.activate(e.id); await employeeCard(ctx, e.id); } });
  bot.command('admin_qil', async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await byArgTg(ctx);
    if (!e) return;
    await employees.setRole(e.id, e.role === 'admin' ? 'employee' : 'admin');
    await employeeCard(ctx, e.id);
  });
  bot.command('erkin', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) { await employees.setFlexible(e.id, !employees.isFlexible(e)); await employeeCard(ctx, e.id); } });
  bot.command('hodim_missiya', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) await render(ctx, await reports.buildEmployeeTasks(e), ui.backKeyboard(`emp:${e.id}`, '👤 Kartochka')); });
  bot.action('adm:overdue', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showOverdue(ctx); } });
  bot.action('adm:excuses', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showExcuses(ctx); } });
  bot.action('adm:status', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showStatus(ctx); } });
  bot.action('adm:backup', async (ctx) => {
    if (!(await guard(ctx))) return;
    const res = await backup.run();
    await ctx.answerCbQuery(res.skipped ? 'Postgres — bulut o\'zi zaxiralaydi' : 'Zaxira olindi');
    if (!res.skipped) await ctx.reply(`💾 Zaxira: <code>${esc(res.file)}</code> (saqlanganlar: ${res.kept})`, { parse_mode: 'HTML' });
  });
  bot.action('adm:remind', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery('Yuborilmoqda…');
    const r = await reports.sendReminder(botOf(ctx));
    await ctx.reply(`🔔 Eslatma ${r.sent} ta hodimga, ${r.reviewers} ta tekshiruvchiga yuborildi.`);
  });
  bot.action('adm:office', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const off = await office.get();
    session.set(ctx.from.id, { step: 'awaiting_office_location', radius: off ? off.radius : office.DEFAULT_RADIUS });
    return ctx.reply(
      `📍 <b>Ofis joylashuvi</b>${off ? `\nHozir: ${off.lat.toFixed(5)}, ${off.lon.toFixed(5)} · radius ${geo.prettyDistance(off.radius)}` : '\nHali belgilanmagan.'}\n\n` +
        `Ofisda turib «${ui.BTN.sendLocation}» tugmasini bosing — shu nuqta ofis bo'ladi.\nRadius: <code>/ofis_radius 300</code>`,
      { parse_mode: 'HTML', ...ui.locationKeyboard() },
    );
  });
  bot.command('ofis', async (ctx) => {
    if (!(await guard(ctx))) return;
    const off = await office.get();
    session.set(ctx.from.id, { step: 'awaiting_office_location', radius: off ? off.radius : office.DEFAULT_RADIUS });
    return ctx.reply(`📍 Ofisda turib «${ui.BTN.sendLocation}» tugmasini bosing.`, ui.locationKeyboard());
  });
  bot.command('ofis_radius', async (ctx) => {
    if (!(await guard(ctx))) return;
    const r = Number(args(ctx));
    if (!Number.isFinite(r) || r < 30 || r > 5000) return ctx.reply('Radius 30–5000 metr oralig\'ida: /ofis_radius 300');
    const off = await office.get();
    if (!off) return ctx.reply('Avval ofis joylashuvini belgilang: /ofis');
    await office.set(off.lat, off.lon, r);
    return ctx.reply(`✅ Radius: ${geo.prettyDistance(r)}`);
  });

  // hodimlar
  bot.action('emp:list', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await listEmployees(ctx); } });
  bot.action(/^emp:list:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await listEmployees(ctx, Number(ctx.match[1])); } });
  bot.command('hodimlar', async (ctx) => { if (await guard(ctx)) await listEmployees(ctx); });
  bot.action(/^emp:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await employeeCard(ctx, ctx.match[1]); } });
  bot.action(/^emp:tasks:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await employeeTasks(ctx, ctx.match[1]); } });
  bot.action(/^emp:tdel:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const t = await tasks.cancel(ctx.match[1]);
    await ctx.answerCbQuery('Bekor qilindi');
    if (t) await notify.toUser(botOf(ctx), t.tg_id, `🗑 Topshiriq bekor qilindi: <s>${esc(t.title)}</s>`);
    return employeeTasks(ctx, t.employee_id);
  });
  bot.action(/^emp:name:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_name', ctx.match[1], '✏️ Yangi ism-familiya:'); } });
  bot.action(/^emp:pos:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_position', ctx.match[1], '💼 Yangi lavozim:'); } });
  bot.action(/^emp:fund:(\d+)$/, async (ctx) => {
    if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_fund', ctx.match[1], "💰 Oylik bonus fondi (so'mda, masalan 1000000). KPI ball × fond / 100 = bonus.\n0 — fondsiz (faqat ball)."); }
  });
  bot.action(/^emp:start:(\d+)$/, async (ctx) => {
    if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_work_start', ctx.match[1], `🕘 Bu hodim uchun ish boshlanish vaqti (masalan <b>10:00</b>). Kechikish shu vaqt + ${config.lateGraceMinutes} daq dan hisoblanadi.\nUmumiy vaqtga (${config.workStartHour}:00) qaytarish — <b>standart</b> deb yozing.`); }
  });
  bot.action(/^emp:excuse:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'excuse_date', ctx.match[1], '📄 Qaysi kun sababli? Sanani yozing (masalan 15.09):'); } });
  bot.action(/^emp:flex:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    await employees.setFlexible(e.id, !employees.isFlexible(e));
    await ctx.answerCbQuery();
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:act:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    if (e.active) await employees.deactivate(e.id); else await employees.activate(e.id);
    await ctx.answerCbQuery(e.active ? 'Ishdan ketdi' : 'Faollashtirildi');
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:role:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    return render(ctx, '🎖 Rolni tanlang:', inline([
      [cb('👤 Hodim', `emp:setrole:${id}:employee`), cb("🎖 Bo'lim boshlig'i", `emp:setrole:${id}:head`)],
      [cb('👑 Direktor / HR', `emp:setrole:${id}:admin`)], [cb('⬅️ Orqaga', `emp:${id}`)],
    ]));
  });
  bot.action(/^emp:setrole:(\d+):(employee|head|admin)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await employees.setRole(ctx.match[1], ctx.match[2]);
    await ctx.answerCbQuery('Saqlandi');
    const e = await employees.byId(ctx.match[1]);
    await notify.toUser(botOf(ctx), e.tg_id, `🎖 Sizning rolingiz: <b>${employees.roleLabel(e.role)}</b>. Menyu yangilandi — /menu`, ui.mainKeyboard({ isAdmin: e.role === 'admin', isHead: e.role === 'head' }));
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:dept:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const rows = (await departments.listActive()).map((d) => [cb(`🏢 ${d.name}`, `emp:setdept:${id}:${d.id}`)]);
    rows.push([cb("— Bo'limsiz", `emp:setdept:${id}:0`)], [cb('⬅️ Orqaga', `emp:${id}`)]);
    return render(ctx, "🏢 Bo'limni tanlang:", inline(rows));
  });
  bot.action(/^emp:setdept:(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await employees.setDepartment(ctx.match[1], Number(ctx.match[2]) || null);
    await ctx.answerCbQuery('Saqlandi');
    return employeeCard(ctx, ctx.match[1]);
  });

  // bo'limlar
  bot.action('dp:list', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await listDepartments(ctx); } });
  bot.command('bolimlar', async (ctx) => { if (await guard(ctx)) await listDepartments(ctx); });
  bot.action('dp:new', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'dept_new' });
    return ctx.reply("🏢 Yangi bo'lim nomi:", ui.cancelKeyboard());
  });
  bot.action(/^dp:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await departmentCard(ctx, ctx.match[1]); } });
  bot.action(/^dp:name:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'dept_name', deptId: Number(ctx.match[1]) });
    return ctx.reply("✏️ Bo'limning yangi nomi:", ui.cancelKeyboard());
  });
  bot.action(/^dp:custom:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'dept_custom', deptId: Number(ctx.match[1]) });
    return ctx.reply(`🎯 Bo'limga xos mezon nomi (masalan: «Sotuv rejasi», «Hisobotlar o'z vaqtida»). Oy oxirida siz shu mezon bo'yicha % kiritasiz.\n«${ui.BTN.skip}» — nomsiz.`, ui.skipKeyboard());
  });
  bot.action(/^dp:w:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const d = await departments.byId(ctx.match[1]);
    session.set(ctx.from.id, { step: 'dept_weights', deptId: d.id });
    return ctx.reply(
      `⚖️ <b>${esc(d.name)}</b> — vaznlarni yozing (4 ta son, yig'indi 100):\n<code>topshiriq davomat boshliq_bahosi qo'shimcha</code>\n\nHozir: <code>${d.w_tasks} ${d.w_attendance} ${d.w_head} ${d.w_custom}</code>\nMasalan: <code>50 20 30 0</code> — qo'shimcha mezon yo'q.`,
      { parse_mode: 'HTML', ...ui.cancelKeyboard() },
    );
  });
  bot.action(/^dp:del:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const d = await departments.byId(ctx.match[1]);
    return render(ctx, `🗑 «${esc(d.name)}» yopilsinmi? Hodimlar bo'limsiz qoladi.`, ui.confirmKeyboard(`dp:delok:${d.id}`, `dp:${d.id}`, '🗑 Ha, yopilsin'));
  });
  bot.action(/^dp:delok:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await departments.deactivate(ctx.match[1]);
    await ctx.answerCbQuery('Yopildi');
    return listDepartments(ctx);
  });
};

module.exports = { register, showPanel, employeeCard, handleEmpText, handleDeptText, showOverdue };
