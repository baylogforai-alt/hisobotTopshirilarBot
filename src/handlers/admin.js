'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const db = require('../db');
const session = require('../session');
const { render, guard, guardSee, args } = require('../render');
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
const branches = require('../services/branches');
const months = require('../services/months');
const visits = require('../services/visits');
const { mapLink } = require('./field');
const worktime = require('../services/worktime');
const org = require('../services/org');
const access = require('../services/access');
const reminders = require('../services/reminders');
const flows = require('../services/flows');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * Admin huquqini yo'qotadigan amal (rolni tushirish / ishdan chiqarish) oldidan: o'zingizga va
 * oxirgi faol adminga (ADMIN_IDS bo'lmasa) ruxsat yo'q — aks holda botni boshqaradigan odam qolmaydi.
 * Xato matnini qaytaradi yoki null.
 */
const adminLossBlock = async (ctx, e, { newRole = null, deactivate = false } = {}) => {
  if (!e || e.role !== 'admin' || !e.active) return null;
  if (!deactivate && newRole === 'admin') return null;
  if (Number(e.tg_id) === Number(ctx.from.id)) return "⛔️ O'zingizni admin huquqidan chiqara olmaysiz — buni boshqa admin qilsin.";
  if (!config.adminIds.length && (await employees.listAdmins()).length <= 1) return "⛔️ Bu oxirgi faol admin — avval boshqa odamni admin qiling.";
  return null;
};

/** Panel → «🚦 KPI sharti» */
const showGate = async (ctx) => {
  const g = await kpi.gateSettings();
  return render(ctx,
    `🚦 <b>KPI SHARTI</b>\n${ui.LINE}\n` +
      `KPI summasi to'liq beriladi, agar oy davomida:\n` +
      `🗓 <b>${g.minDays} kun</b> vaqtida kelsa (kech kelgan kun — faqat sababli qilinsa kiradi; sababli kunlar talabni kamaytiradi; dam olish kuni kelgani ham qo'shiladi);\n` +
      `📋 topshiriqlarning <b>${g.minTaskPct}%</b> i muddatida bajarilsa;\n` +
      `🗓 oy boshi tasdiqlangan bo'lsa.\n\n<i>Aks holda KPI summasi 0. Ish kunlari kam oyda (fevral) talab ish kunlaridan oshmaydi.</i>`,
    inline([
      [cb(`🗓 Kunlar: ${g.minDays}`, 'adm:kg:days'), cb(`📋 Foiz: ${g.minTaskPct}%`, 'adm:kg:pct')],
      [cb('⬅️ Panel', 'adm:home')],
    ]));
};

/** kpi_gate_days / kpi_gate_pct matni */
const handleGateText = async (ctx, kind) => {
  const n = Number(String(ctx.message.text).trim().replace('%', ''));
  const okRange = kind === 'days' ? Number.isInteger(n) && n >= 1 && n <= 31 : Number.isInteger(n) && n >= 0 && n <= 100;
  if (!okRange) return ctx.reply(kind === 'days' ? '1 dan 31 gacha butun son yozing:' : '0 dan 100 gacha butun son yozing:', ui.cancelKeyboard());
  session.clear(ctx.from.id);
  await kpi.setGateSettings(kind === 'days' ? { minDays: n } : { minTaskPct: n });
  await ctx.reply('✅ Saqlandi. Kutilayotgan (tasdiqlanmagan) oylar yangi shart bilan hisoblanadi.', ui.kbFor(ctx));
  return showGate(ctx);
};

const showPanel = async (ctx) =>
  render(ctx, `⚙️ <b>PANEL</b> · ${esc(config.companyName)}\n<i>${time.prettyDate(time.today())}</i>`, ui.panelKeyboard({ quiet: await org.isQuiet(ctx.from.id), headCopy: await org.headTaskCopy(), hrBoss: await org.hrSeesBossTasks(), bossAtt: await org.bossSeesAttendance(), headMoney: await org.headSeesMoney(), gate: await kpi.gateSettings() }));

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
  const todayLabel = { ontime: `🟢 keldi ${time.clock(row && row.checked_in)}`, late: `🟡 kech ${time.clock(row && row.checked_in)}`, absent: '🔴 kelmagan', excused: '📄 sababli', pending: '🙋 sabab kutilmoqda', future: '⚪ hali yo\'q', off: '⚪ dam olish', extra: `🟢 dam olish kuni keldi ${time.clock(row && row.checked_in)}` }[st];
  const text =
    `${employees.personIcon(e)} <b>${esc(e.full_name)}</b>${employees.isHr(e) ? ' · <b>HR</b>' : ''}${e.active ? '' : ' ⛔ <i>ishdan ketgan</i>'}\n` +
    `💼 ${esc(e.position || '—')} · 🏢 ${esc(e.department_name || "bo'limsiz")} · ${employees.roleLabel(e.role)}\n` +
    `🆔 <code>${e.tg_id}</code>${e.username ? ` · @${esc(e.username)}` : ''}${employees.isFlexible(e) ? ' · 🕊 erkin jadval' : ''}\n` +
    `🏙 ${esc(e.branch_name || 'Asosiy ofis')} · ${employees.modeLabel(e)} · 🎥 Keldim videosi: ${employees.needsCheckinVideo(e) ? 'majburiy' : "yo'q/ixtiyoriy"}` +
    (employees.isField(e) ? `\n🏠 Uy joylashuvi: ${employees.homeOf(e) ? mapLink(e.home_lat, e.home_lon) : '<i>belgilanmagan</i>'}` : '') + '\n' +
    `💵 Oklad: <b>${kpi.fmtMoney(e.salary)}</b> · 🏆 KPI summasi (bonus fondi): <b>${kpi.fmtMoney(e.bonus_fund)}</b>\n` +
    `🕘 Ish boshlanishi: <b>${e.work_start || `${worktime.get()} (umumiy)`}</b> · 🏁 tugashi: <b>${e.work_end || `${employees.workEndOf(null)} (umumiy)`}</b>\n${ui.LINE}\n` +
    `Bugun: ${todayLabel}${(await dailyReports.get(e.id)) ? ' · 📝 hisobot topshirgan' : ''}\n` +
    `📋 Shu oy: ${ts.ontime}/${ts.total} muddatida (${ts.pct}%)${ts.overdue ? ` · 🔴 ${ts.overdue}` : ''} · ⏳ ochiq ${open.length}\n` +
    `🕘 Davomat: ${at.ontime}/${at.workDays} vaqtida (${at.pct}%)${at.late ? ` · 🟡 ${at.late}` : ''}${at.absent ? ` · 🔴 ${at.absent}` : ''}${at.excused ? ` · 📄 ${at.excused}` : ''}`;
  const rows = [
    [cb('📤 Topshiriq berish', `as:emp:${e.id}`), cb(`📋 Topshiriqlari (${open.length})`, `emp:tasks:${e.id}`)],
    [cb('✏️ Ism', `emp:name:${e.id}`), cb('💼 Lavozim', `emp:pos:${e.id}`), cb("🏢 Bo'lim", `emp:dept:${e.id}`)],
    [cb(Number(e.is_hr) ? '🧑‍💼 HR: ha' : "🧑‍💼 HR: yo'q", `emp:hr:${e.id}:${Number(e.is_hr) ? 0 : 1}`), cb('👥 Jamoasi', `tm:m:${e.id}`)],
    [cb("🧭 Yo'nalishlari", `ed:${e.id}`), cb(employees.isViewer(e) ? '👁 Davomat nazorati: ha' : "👁 Davomat nazorati: yo'q", `vw:grant:${e.id}`)],
    [cb('🎖 Rol', `emp:role:${e.id}`), cb('🏙 Filial', `emp:branch:${e.id}`), cb(employees.isFlexible(e) ? '🕊 Erkin: ha' : "🕊 Erkin: yo'q", `emp:flex:${e.id}:${employees.isFlexible(e) ? 0 : 1}`)],
    [cb('💵 Oklad', `emp:salary:${e.id}`), cb('🏆 KPI summasi', `emp:fund:${e.id}`), cb('🕘 Ish boshlanishi', `emp:start:${e.id}`)],
    [cb('🏁 Ish tugashi', `emp:end:${e.id}`)],
    [cb(employees.isField(e) ? '🚶 Ish turi: Hudud' : '🏢 Ish turi: Ofis', `emp:mode:${e.id}:${employees.isField(e) ? 'office' : 'field'}`),
      ...(employees.isField(e) ? [cb(Number(e.video_required) ? '🎥 Video: majburiy' : '🎥 Video: ixtiyoriy', `emp:video:${e.id}:${Number(e.video_required) ? 0 : 1}`)] : [])],
    ...(employees.isField(e) && employees.homeOf(e) ? [[cb('🏠 Uy joyini tozalash', `emp:home:${e.id}`)]] : []),
    [cb('📄 Sababli kun belgilash', `emp:excuse:${e.id}`), cb('📊 Oylik hisobot', `rp:emp:${e.id}:${time.month()}`)],
    [cb('🗂 Kun daftari (arxiv)', `hr:emp:${e.id}`), cb('📥 Excel (davr)', `xl:emp:${e.id}`)],
    [cb(e.active ? '⛔ Ishdan ketdi' : '✅ Qayta faollashtirish', `emp:act:${e.id}:${e.active ? 0 : 1}`), cb("⬅️ Ro'yxat", 'emp:list')],
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
  if (field === 'fund' || field === 'salary') {
    // «bir million» kabi matn jimgina 0 → o'chirishga aylanmasin: faqat raqam
    if (!/^\s*\d[\d\s.,]*$/.test(text)) {
      session.set(ctx.from.id, { step: field === 'fund' ? 'edit_fund' : 'edit_salary', empId: s.empId });
      return ctx.reply("Faqat raqam yozing (masalan 3000000). 0 — o'chirish.", ui.cancelKeyboard());
    }
    const n = Number(text.replace(/[^\d]/g, ''));
    if (field === 'fund') await employees.setBonusFund(s.empId, n > 0 ? n : null);
    else await employees.setSalary(s.empId, n > 0 ? n : null);
  }
  if (field === 'work_start') {
    if (/^(standart|umumiy|0|-)$/i.test(text) || text === ui.BTN.skip) await employees.setWorkStart(s.empId, null);
    else {
      const hhmm = employees.parseWorkStart(text);
      if (!hhmm) { session.set(ctx.from.id, { step: 'edit_work_start', empId: s.empId }); return ctx.reply('Vaqtni HH:mm ko\'rinishida yozing (masalan 10:00). Umumiy vaqtga qaytarish — «standart».', ui.cancelKeyboard()); }
      await employees.setWorkStart(s.empId, hhmm);
    }
  }
  if (field === 'work_end') {
    if (/^(standart|umumiy|0|-)$/i.test(text) || text === ui.BTN.skip) await employees.setWorkEnd(s.empId, null);
    else {
      const hhmm = employees.parseWorkStart(text);
      if (!hhmm) { session.set(ctx.from.id, { step: 'edit_work_end', empId: s.empId }); return ctx.reply("Vaqtni HH:mm ko'rinishida yozing (masalan 19:00). Umumiy vaqtga qaytarish — «standart».", ui.cancelKeyboard()); }
      await employees.setWorkEnd(s.empId, hhmm);
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
    await flows.markExcused(botOf(ctx), e, s.date, ctx.from.id, text === ui.BTN.skip ? 'sababli' : text);
    await ctx.reply(`✅ ${esc(e.full_name)} — ${time.prettyDate(s.date)} sababli deb belgilandi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
    return employeeCard(ctx, e.id);
  }
  await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
  if (s.back === 'sal') return showSalaries(ctx);
  return employeeCard(ctx, s.empId);
};

// ---------------------------------------------------------------------------
// OYLIKLAR — hamma hodimning okladi va KPI summasi bir joyda (Panel → «💵 Oyliklar», /oyliklar)
// ---------------------------------------------------------------------------

const showSalaries = async (ctx) => {
  const list = await employees.listStaff();
  const sum = (k) => list.reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const missing = list.filter((e) => !Number(e.salary)).length;
  const lines = list.map((e, i) => `${i + 1}. <b>${esc(e.full_name)}</b> — 💵 ${kpi.fmtMoney(e.salary)} · 🏆 ${kpi.fmtMoney(e.bonus_fund)}`);
  const rows = list.map((e) => [
    cb(`💵 ${e.full_name}`.slice(0, 40), `sal:s:${e.id}`),
    cb('🏆 KPI', `sal:f:${e.id}`),
  ]);
  rows.push([cb('⬅️ Panel', 'adm:home')]);
  return render(
    ctx,
    `💵 <b>OYLIKLAR</b> — ${list.length} hodim\n${ui.LINE}\n${lines.join('\n') || "<i>hodim yo'q</i>"}\n${ui.LINE}\n` +
      `Jami oklad: <b>${kpi.fmtMoney(sum('salary'))}</b> · KPI summalari: <b>${kpi.fmtMoney(sum('bonus_fund'))}</b>` +
      (missing ? `\n⚠️ ${missing} ta hodimga oklad yozilmagan.` : '') +
      `\n\n👇 Ismni bosing — oylik (oklad) yozasiz; «🏆 KPI» — KPI summasi. Hodim «${ui.BTN.salary}» da oklad + KPI = jami ko'radi.`,
    inline(rows),
  );
};

const askSalary = async (ctx, empId, field) => {
  const e = await employees.byId(empId);
  if (!e) return ctx.answerCbQuery('Hodim topilmadi');
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step: field === 'fund' ? 'edit_fund' : 'edit_salary', empId: e.id, back: 'sal' });
  const cur = field === 'fund' ? e.bonus_fund : e.salary;
  return ctx.reply(
    `${field === 'fund' ? '🏆 KPI summasi' : '💵 Oylik (oklad)'} — <b>${esc(e.full_name)}</b>\nHozir: <b>${kpi.fmtMoney(cur)}</b>\n\nSo'mda yozing (masalan 3000000 yoki 3 000 000). 0 — o'chirish.`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

/** Boshliq: hodimning hamma topshiriqlari — faol, tekshiruvda, shu oy bajarilgan (kim bergan, qachon yozilgan, muddat, holat) */
const employeeTasks = async (ctx, id) => {
  const e = await employees.byId(id);
  const by = async (kind) => tasks.listByKind(kind, { employeeIds: [e.id] });
  const open = await by('active');
  const awaiting = await by('review');
  const accepted = await by('accepted');
  const { line } = require('./status');
  const block = (title, list) => `${title} (${list.length}):\n${list.map((t, i) => line(t, i + 1, false)).join('\n') || "<i>— yo'q —</i>"}`;
  const rows = open.map((t) => [cb(`🗑 ${t.title.slice(0, 45)}`, `emp:tdel:${t.id}`)]);
  rows.push([cb('📤 Yangi topshiriq', `as:emp:${e.id}`), cb('⬅️ Kartochka', `emp:${e.id}`)]);
  return render(
    ctx,
    `📋 <b>${esc(e.full_name)}</b> — topshiriqlari\n${ui.LINE}\n${block('⏳ <b>Faol</b>', open)}\n\n${block('🕓 <b>Kutilmoqda</b> (tekshiruvda)', awaiting)}\n\n${block('✅ <b>Bajarilgan</b> (shu oy)', accepted)}\n\n🗑 — faol topshiriqni bekor qilish`,
    inline(rows),
  );
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
// ISH VAQTI — umumiy (hamma uchun) va alohida (hodim kartochkasida)
// ---------------------------------------------------------------------------

const showWorktime = async (ctx) => {
  const own = (await employees.listActive()).filter((e) => e.work_start);
  const text =
    `🕘 <b>ISH VAQTI</b>\n${ui.LINE}\n` +
    `Umumiy ish boshlanishi: <b>${worktime.get()}</b>\n` +
    `Kechikish ruxsati: ${config.lateGraceMinutes} daq → <b>${worktime.get()}</b> + ${config.lateGraceMinutes} daq dan keyin kelgan «kech» hisoblanadi.\n\n` +
    (own.length
      ? `👤 <b>Alohida vaqti bor (${own.length}):</b>\n${own.map((e) => `   • ${esc(e.full_name)} — ${e.work_start}`).join('\n')}`
      : "<i>Hamma hodim umumiy vaqtda ishlaydi.</i>") +
    `\n\n<i>Bitta hodimning vaqtini o'zgartirish: 👥 Hodimlar → hodim → «🕘 Ish boshlanishi».</i>`;
  const step = await reminders.globalStep();
  const ownRemind = (await employees.listActive()).filter((e) => e.remind_times);
  const text2 = `\n\n🔔 <b>Topshiriq eslatmalari (umumiy):</b> har <b>${step}</b> soatda — ${reminders.intervalTimes(worktime.minutes(), step).join(', ') || '—'}` +
    (ownRemind.length ? `\n👤 O'z jadvali bor: ${ownRemind.map((e) => `${esc(e.full_name)} (${esc(reminders.listOf(e.remind_times).join(', '))})`).join('; ')}` : '') +
    `\n<i>Bo'lim va hodim bo'yicha vaqtlar — «${ui.BTN.reminders}» da. Hodim so'rovi faqat boshliqqa keladi.</i>`;
  const rows = [[cb("✏️ Hamma uchun o'zgartirish", 'wt:set')]];
  if (own.length) rows.push([cb('↩️ Alohida vaqtlarni bekor qilish', 'wt:reset')]);
  rows.push([1, 2, 3, 4].map((n) => cb(`${n === step ? '✅ ' : ''}🔔 ${n} soat`, `wt:rs:${n}`)));
  rows.push([cb('⬅️ Panel', 'adm:home')]);
  return render(ctx, text + text2, inline(rows));
};

const applyWorktime = async (ctx, hhmm, all) => {
  await worktime.set(hhmm, { resetIndividual: all });
  const n = await flows.announceWorktime(botOf(ctx), hhmm, all);
  await ctx.reply(`✅ Umumiy ish boshlanishi: <b>${hhmm}</b>${all ? ' — hamma hodim uchun (alohida vaqtlar bekor qilindi)' : ''}. ${n} ta hodimga xabar yuborildi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  return showWorktime(ctx);
};

const handleWorktimeText = async (ctx) => {
  session.clear(ctx.from.id);
  const hhmm = employees.parseWorkStart(ctx.message.text);
  if (!hhmm) {
    session.set(ctx.from.id, { step: 'worktime_global' });
    return ctx.reply('Vaqtni HH:mm ko\'rinishida yozing (masalan 8:50):', ui.cancelKeyboard());
  }
  const own = await worktime.individualCount();
  if (!own) return applyWorktime(ctx, hhmm, false);
  session.set(ctx.from.id, { step: 'worktime_confirm', hhmm });
  return ctx.reply(
    `🕘 Yangi umumiy vaqt: <b>${hhmm}</b>.\n\n${own} ta hodimga alohida vaqt qo'yilgan. Ular ham <b>${hhmm}</b> ga o'tsinmi?`,
    { parse_mode: 'HTML', ...inline([[cb(`👥 Ha, hamma ${hhmm} da`, 'wt:apply:all')], [cb("👤 Yo'q, alohida vaqtlari qolsin", 'wt:apply:keep')], [cb(ui.BTN.cancel, 'adm:worktime')]]) },
  );
};

// ---------------------------------------------------------------------------
// NOMLAR — boshliq (direktor) va HR ismlari
// ---------------------------------------------------------------------------

const showNames = async (ctx) => {
  const hr = await employees.listHr();
  const rows = [[cb(`✏️ Boshliq: ${await org.bossName()}`, 'nm:boss')]];
  for (const h of hr) rows.push([cb(`✏️ HR: ${h.full_name}`, `emp:name:${h.id}`)]);
  rows.push([cb('⬅️ Panel', 'adm:home')]);
  return render(
    ctx,
    `🏷 <b>NOMLAR</b>\n${ui.LINE}\n👑 Boshliq (direktor): <b>${esc(await org.bossName())}</b>\n` +
      `🧑‍💼 HR: ${hr.length ? hr.map((h) => `<b>${esc(h.full_name)}</b>`).join(', ') : "<i>belgilanmagan — hodim kartochkasida «🧑‍💼 HR» ni yoqing</i>"}\n\n` +
      `<i>Kelmaslik va kechikish sabablari HR va boshliqqa boradi; hodimga «HR (ism) va boshliq (ism)ga yuborildi» deb ko'rinadi.</i>`,
    inline(rows),
  );
};

const handleBossName = async (ctx) => {
  session.clear(ctx.from.id);
  const name = ctx.message.text.trim();
  if (!name) return ctx.reply('Ism bo\'sh bo\'lmasin.', ui.kbFor(ctx));
  await org.setBossName(name);
  await ctx.reply(`✅ Boshliq ismi: <b>${esc(name)}</b>`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  return showNames(ctx);
};

// ---------------------------------------------------------------------------
// FILIALLAR
// ---------------------------------------------------------------------------

const listBranches = async (ctx) => {
  const list = await branches.listActive();
  const main = await office.get();
  const lines = [`🏢 <b>Asosiy ofis</b> — ${main ? `📍 radius ${geo.prettyDistance(main.radius)}` : '❌ nuqta belgilanmagan (/ofis)'}\n   <i>filialsiz hodimlar shu yerga keladi</i>`];
  for (const b of list) {
    const off = branches.officeOfBranch(b);
    lines.push(`🏙 <b>${esc(b.name)}</b> — ${await branches.memberCount(b.id)} hodim · ${off ? `📍 radius ${geo.prettyDistance(off.radius)}` : '❌ ofis nuqtasi yo\'q'}`);
  }
  const rows = list.map((b) => [cb(`🏙 ${b.name}`, `br:${b.id}`)]);
  rows.push([cb('➕ Yangi filial', 'br:new'), cb('⬅️ Panel', 'adm:home')]);
  return render(ctx, `🏙 <b>FILIALLAR</b>\n<i>Har filialning o'z ofis nuqtasi va radiusi bor. Hodimni filialga kartochkadan biriktirasiz.</i>\n\n${lines.join('\n')}`, inline(rows));
};

const branchCard = async (ctx, id) => {
  const b = await branches.byId(id);
  if (!b || !Number(b.active)) return listBranches(ctx);
  const off = branches.officeOfBranch(b);
  const members = (await employees.listActive()).filter((e) => Number(e.branch_id) === Number(b.id));
  const text =
    `🏙 <b>${esc(b.name)}</b>\n${ui.LINE}\n` +
    `📍 Ofis: ${off ? `${mapLink(off.lat, off.lon)} · radius <b>${geo.prettyDistance(off.radius)}</b>` : '<i>belgilanmagan — hodimlar asosiy ofis bilan solishtiriladi</i>'}\n\n` +
    `👥 <b>Hodimlar (${members.length}):</b>\n${members.map((e) => `   ${ui.roleIcon(e.role)} ${esc(e.full_name)} · ${employees.modeLabel(e)}`).join('\n') || "   <i>yo'q</i>"}`;
  return render(ctx, text, inline([
    [cb('📍 Ofis nuqtasi', `br:loc:${b.id}`), cb('📏 Radius', `br:rad:${b.id}`)],
    [cb('✏️ Nomi', `br:name:${b.id}`), cb('🗑 Yopish', `br:del:${b.id}`)],
    [cb('⬅️ Filiallar', 'br:list')],
  ]));
};

const handleBranchText = async (ctx, fieldName) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  const text = ctx.message.text.trim();
  if (fieldName === 'new') {
    const { branch, created } = await branches.create(text);
    await ctx.reply(`🏙 «${esc(branch.name)}» ${created ? 'yaratildi' : 'allaqachon bor'}. Endi «📍 Ofis nuqtasi» ni belgilang.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
    return branchCard(ctx, branch.id);
  }
  if (!s.branchId) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  if (fieldName === 'name') await branches.rename(s.branchId, text);
  if (fieldName === 'radius') {
    const r = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isFinite(r) || r < 30 || r > 5000) {
      session.set(ctx.from.id, { step: 'branch_radius', branchId: s.branchId });
      return ctx.reply("Radius 30–5000 metr oralig'ida (masalan 300):", ui.cancelKeyboard());
    }
    await branches.setRadius(s.branchId, r);
  }
  await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
  return branchCard(ctx, s.branchId);
};

// ---------------------------------------------------------------------------
// OY BOSHI TASDIQLARI · TASHRIFLAR
// ---------------------------------------------------------------------------

const showMonthStarts = async (ctx) => {
  const m = time.month();
  const { confirmed, waiting } = await months.statusOf(m);
  const text =
    `🗓 <b>${time.monthName(m)} — oy boshi tasdiqlari</b>\n${ui.LINE}\n` +
    `✅ Tasdiqlagan: <b>${confirmed.length}</b> · ⏳ Tasdiqlamagan: <b>${waiting.length}</b>\n\n` +
    (confirmed.length ? `${confirmed.map((r) => `✅ ${esc(r.full_name)} — ${time.shortDate(String(r.confirmed_at).slice(0, 10))} ${time.clock(r.confirmed_at)}`).join('\n')}\n` : '') +
    (waiting.length ? `\n${waiting.map((r) => `⏳ ${esc(r.full_name)}`).join('\n')}` : '') +
    (config.monthStartRequired ? `\n\n<i>Tasdiqlamaganlar uchun «Keldim» yopiq.</i>` : '');
  const rows = [];
  if (waiting.length) rows.push([cb('🔔 Tasdiqlamaganlarga qayta yuborish', 'adm:msresend')]);
  rows.push([cb('⬅️ Panel', 'adm:home')]);
  return render(ctx, text, inline(rows));
};

const showVisits = async (ctx, date = time.today()) => {
  const list = await visits.range(date, date);
  const lines = list.map((v, i) =>
    `${i + 1}. <b>${esc(v.full_name)}</b> · ${time.clock(v.created_at)} · ${visits.proofLabel(v.proof_type)} · ${mapLink(v.lat, v.lon)}${v.note ? `\n   💬 «${esc(String(v.note).slice(0, 200))}»` : ''}`);
  const rows = list.slice(0, 20).map((v, i) => [cb(`▶️ ${i + 1}. ${v.full_name.split(' ')[0]} ${time.clock(v.created_at)}`, `adm:visit:${v.id}`)]);
  rows.push([ctx.state.isAdmin ? cb('⬅️ Panel', 'adm:home') : cb('⬅️ Hisobotlar', 'rp:home')]);
  return render(ctx, `🚶 <b>TASHRIFLAR — ${time.prettyDate(date)}</b> (${list.length})\n${ui.LINE}\n${lines.join('\n') || "<i>Bugun tashrif yo'q.</i>"}`, inline(rows));
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
    `🗄 Arxiv guruhi: ${(await notify.getArchiveId()) ? `<code>${await notify.getArchiveId()}</code>` : '❌ ulanmagan (/arxiv_ulash yopiq guruh ichida)'}\n` +
    `🏆 KPI rejimi: ${config.kpiMode === 'gate' ? await (async () => { const g = await kpi.gateSettings(); return `shartli (${g.minDays} kun vaqtida, topshiriqlar ≥${g.minTaskPct}%)`; })() : 'ball × summa'}\n` +
    `📍 Ofis: ${off ? `${off.lat.toFixed(5)}, ${off.lon.toFixed(5)} · radius ${geo.prettyDistance(off.radius)}` : '❌ belgilanmagan'}\n` +
    `⏰ Ish vaqti: ${worktime.get()}–${config.workEndHour}:00 (alohida vaqtli: ${await worktime.individualCount()}) · kechikish ruxsati ${config.lateGraceMinutes} daq · kunlar ${config.workDays}\n` +
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
    const text = `🙋 <b>${esc(r.full_name)}</b> — ${time.prettyDate(r.work_date)}\n«${esc(r.excuse_reason || '')}»`;
    if (r.excuse_proof_file_id) await notify.sendProof(botOf(ctx), ctx.chat.id, { type: r.excuse_proof_type, fileId: r.excuse_proof_file_id }, text, ui.excuseKeyboard(r.id));
    else await ctx.reply(text, { parse_mode: 'HTML', ...ui.excuseKeyboard(r.id) });
  }
};

const showOverdue = async (ctx) => {
  // HR — boshliq topshiriqlarisiz (sozlamaga qarab); bo'limsiz rahbar — bo'sh ro'yxat
  const list = tasks.visibleFor(ctx.state.actor, await tasks.overdue(access.deptScope(ctx.state.actor)));
  return render(ctx, list.length ? `⚠️ <b>MUDDATI O'TGAN (${list.length})</b>\n\n${ui.taskList(list, { withName: true })}` : "✅ Muddati o'tgan topshiriq yo'q.", ui.backKeyboard('adm:home'));
};

const register = (bot) => {
  bot.hears(ui.BTN.panel, async (ctx) => { if (await guard(ctx)) await showPanel(ctx); });
  bot.command('panel', async (ctx) => { if (await guard(ctx)) await showPanel(ctx); });
  bot.action('adm:home', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showPanel(ctx); } });

  bot.action('adm:today', async (ctx) => {
    if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️');
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
  bot.command('hodim_ochir', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) { const block = await adminLossBlock(ctx, e, { deactivate: true }); if (block) return ctx.reply(block); await employees.deactivate(e.id); await employeeCard(ctx, e.id); } });
  bot.command('hodim_tikla', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) { await employees.activate(e.id); await employeeCard(ctx, e.id); } });
  bot.command('admin_qil', async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await byArgTg(ctx);
    if (!e) return;
    const newRole = e.role === 'admin' ? 'employee' : 'admin';
    const block = await adminLossBlock(ctx, e, { newRole });
    if (block) return ctx.reply(block);
    await employees.setRole(e.id, newRole);
    await employeeCard(ctx, e.id);
  });
  bot.command('erkin', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) { await employees.setFlexible(e.id, !employees.isFlexible(e)); await employeeCard(ctx, e.id); } });
  bot.command('hodim_missiya', async (ctx) => { if (!(await guard(ctx))) return; const e = await byArgTg(ctx); if (e) await render(ctx, await reports.buildEmployeeTasks(e), ui.backKeyboard(`emp:${e.id}`, '👤 Kartochka')); });
  bot.action(/^adm:htc(?::([01]))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    if (!ctx.match[1]) { await ctx.answerCbQuery('Eskirgan tugma'); return showPanel(ctx); }
    const on = ctx.match[1] === '1';
    await org.setHeadTaskCopy(on);
    await ctx.answerCbQuery(on ? "✅ Rahbar bergan topshiriq nusxasi direktor va HR ga boradi" : "🚫 Rahbar bergan topshiriq nusxasi yuborilmaydi", { show_alert: true });
    await showPanel(ctx);
  });
  bot.action(/^adm:hbt(?::([01]))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    if (!ctx.match[1]) { await ctx.answerCbQuery('Eskirgan tugma'); return showPanel(ctx); }
    const on = ctx.match[1] === '1';
    await org.setHrSeesBossTasks(on);
    await ctx.answerCbQuery(on
      ? "✅ HR endi boshliq/direktor bergan topshiriqlarni va boshliq missiyalarini ham ko'radi (jurnal, ro'yxatlar, Excel)"
      : "🚫 HR boshliq/direktor bergan topshiriqlarni va boshliq missiyalarini ko'rmaydi", { show_alert: true });
    await showPanel(ctx);
  });
  // KPI sharti (boshliq o'zgartiradi): kunlar va topshiriq foizi
  bot.action('adm:kg', async (ctx) => { if (await guard(ctx)) { session.clear(ctx.from.id); await ctx.answerCbQuery(); await showGate(ctx); } });
  bot.action(/^adm:kg:(days|pct)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const days = ctx.match[1] === 'days';
    session.set(ctx.from.id, { step: days ? 'kpi_gate_days' : 'kpi_gate_pct' });
    return ctx.reply(days ? '🗓 Oyiga necha kun vaqtida kelishi kerak? (1–31, masalan 25)' : '📋 Topshiriqlarning necha foizi muddatida bo\'lishi kerak? (0–100, masalan 90)', ui.cancelKeyboard());
  });
  // holat callback ichida — ikki marta bosilsa qaytib ketmaydi
  bot.action(/^adm:hm:([01])$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const on = ctx.match[1] === '1';
    await org.setHeadSeesMoney(on);
    await ctx.answerCbQuery(on ? "✅ Bo'lim rahbarlari jamoasining KPI summasini ko'radi" : "🚫 Bo'lim rahbarlari KPI summasini ko'rmaydi (faqat ball va foizlar)", { show_alert: true });
    await showPanel(ctx);
  });
  bot.action(/^adm:qt:([01])$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const on = ctx.match[1] === '1';
    await org.setQuiet(ctx.from.id, on);
    await ctx.answerCbQuery(on
      ? "🔕 Jim rejim: sizga topshiriq berildi / qo'shildi / bajarildi va keldi-ketdi xabarlari kelmaydi (o'zingiz bergan topshiriq bajarilsa — keladi). Hammasi arxiv va hisobotlarda ko'rinadi."
      : '🔔 Xabarlar yana keladi', { show_alert: true });
    await showPanel(ctx);
  });
  bot.action(/^adm:bat(?::([01]))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    if (!ctx.match[1]) { await ctx.answerCbQuery('Eskirgan tugma'); return showPanel(ctx); }
    const on = ctx.match[1] === '1';
    await org.setBossSeesAttendance(on);
    await ctx.answerCbQuery(on
      ? "✅ Boshliq endi keldi / ketdi, kech qolaman, kelmayman xabarlarini va ertalabki / kun yakuni hisobotlarini oladi"
      : "🚫 Boshliqqa keldi-ketdi va davomat xabarlari bormaydi — faqat bo'lim rahbarlari va HR ga", { show_alert: true });
    await showPanel(ctx);
  });
  bot.action('adm:overdue', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showOverdue(ctx); } });
  bot.action('adm:excuses', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showExcuses(ctx); } });
  bot.action('sal:list', async (ctx) => { if (await guard(ctx)) { session.clear(ctx.from.id); await ctx.answerCbQuery(); await showSalaries(ctx); } });
  bot.command('oyliklar', async (ctx) => { if (await guard(ctx)) await showSalaries(ctx); });
  bot.action(/^sal:(s|f):(\d+)$/, async (ctx) => { if (await guard(ctx)) await askSalary(ctx, ctx.match[2], ctx.match[1] === 'f' ? 'fund' : 'salary'); });
  bot.action('adm:status', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showStatus(ctx); } });
  bot.action('adm:backup', async (ctx) => {
    if (!(await guard(ctx))) return;
    const res = await backup.run();
    await ctx.answerCbQuery(res.skipped ? 'Eksport tayyorlanmoqda…' : 'Zaxira olindi');
    if (!res.skipped) await ctx.reply(`💾 Zaxira: <code>${esc(res.file)}</code> (saqlanganlar: ${res.kept})`, { parse_mode: 'HTML' });
    else {
      const { buffer, filename, rows } = await backup.exportJson();
      await notify.docToUser({ telegram: ctx.telegram }, ctx.from.id, buffer, filename, `💾 <b>Baza zaxirasi</b> — ${rows} ta yozuv (JSON, gzip)`);
    }
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
        `Ofisda turib «${ui.BTN.sendLocation}» tugmasini bosing — shu nuqta ofis bo'ladi.\nRadius: <code>/ofis_radius 150</code>`,
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
    if (!Number.isFinite(r) || r < 30 || r > 5000) return ctx.reply('Radius 30–5000 metr oralig\'ida: /ofis_radius 150');
    const off = await office.get();
    if (!off) return ctx.reply('Avval ofis joylashuvini belgilang: /ofis');
    await office.set(off.lat, off.lon, r);
    return ctx.reply(`✅ Radius: ${geo.prettyDistance(r)}`);
  });

  // filiallar
  bot.action('br:list', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await listBranches(ctx); } });
  bot.command('filiallar', async (ctx) => { if (await guard(ctx)) await listBranches(ctx); });
  bot.action(/^br:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await branchCard(ctx, ctx.match[1]); } });
  bot.action('br:new', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'branch_new' });
    return ctx.reply('🏙 Yangi filial nomi (masalan: Andijon):', ui.cancelKeyboard());
  });
  bot.action(/^br:name:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'branch_name', branchId: Number(ctx.match[1]) });
    return ctx.reply('✏️ Filialning yangi nomi:', ui.cancelKeyboard());
  });
  bot.action(/^br:rad:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'branch_radius', branchId: Number(ctx.match[1]) });
    return ctx.reply('📏 Ofis radiusi (metr, 30–5000):', ui.cancelKeyboard());
  });
  bot.action(/^br:loc:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const b = await branches.byId(ctx.match[1]);
    const off = branches.officeOfBranch(b);
    session.set(ctx.from.id, { step: 'awaiting_office_location', branchId: b.id, radius: off ? off.radius : office.DEFAULT_RADIUS });
    return ctx.reply(`📍 <b>${esc(b.name)}</b> ofisida turib «${ui.BTN.sendLocation}» tugmasini bosing — shu nuqta filial ofisi bo'ladi.`, { parse_mode: 'HTML', ...ui.locationKeyboard() });
  });
  bot.action(/^br:del:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const b = await branches.byId(ctx.match[1]);
    return render(ctx, `🗑 «${esc(b.name)}» filiali yopilsinmi? Hodimlari asosiy ofisga o'tadi.`, ui.confirmKeyboard(`br:delok:${b.id}`, `br:${b.id}`, '🗑 Ha, yopilsin'));
  });
  bot.action(/^br:delok:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await branches.deactivate(ctx.match[1]);
    await ctx.answerCbQuery('Yopildi');
    return listBranches(ctx);
  });

  // nomlar
  bot.action('adm:names', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showNames(ctx); } });
  bot.command('nomlar', async (ctx) => { if (await guard(ctx)) await showNames(ctx); });
  bot.action('nm:boss', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'boss_name' });
    return ctx.reply(`👑 Boshliq (direktor) ismini yozing. Hozir: <b>${esc(await org.bossName())}</b>`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  });

  // ish vaqti
  bot.action('adm:worktime', async (ctx) => { if (await guard(ctx)) { session.clear(ctx.from.id); await ctx.answerCbQuery(); await showWorktime(ctx); } });
  bot.command('ish_vaqti', async (ctx) => { if (await guard(ctx)) await showWorktime(ctx); });
  bot.action('wt:set', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'worktime_global' });
    return ctx.reply(`🕘 Hamma uchun yangi ish boshlanish vaqtini yozing (masalan <b>8:50</b>). Hozir: <b>${worktime.get()}</b>`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
  });
  bot.action(/^wt:apply:(all|keep)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const s = session.get(ctx.from.id);
    session.clear(ctx.from.id);
    if (s.step !== 'worktime_confirm' || !s.hhmm) return ctx.answerCbQuery('Eskirgan tugma');
    await ctx.answerCbQuery('Saqlandi');
    return applyWorktime(ctx, s.hhmm, ctx.match[1] === 'all');
  });
  bot.action(/^wt:rs:([1-4])$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await reminders.setGlobalStep(Number(ctx.match[1]));
    await ctx.answerCbQuery(`Umumiy eslatma: har ${ctx.match[1]} soatda`);
    return showWorktime(ctx);
  });
  bot.action('wt:reset', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    return render(ctx, `↩️ Hamma hodimning alohida vaqti bekor qilinib, umumiy <b>${worktime.get()}</b> ga o'tkazilsinmi?`, ui.confirmKeyboard('wt:resetok', 'adm:worktime', '✅ Ha'));
  });
  bot.action('wt:resetok', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery('Bajarildi');
    return applyWorktime(ctx, worktime.get(), true);
  });

  // oy boshi, tashriflar
  bot.action('adm:months', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await showMonthStarts(ctx); } });
  bot.action('adm:msresend', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery('Yuborilmoqda…');
    const n = await require('./month').sendMonthStart(botOf(ctx));
    await ctx.reply(`🔔 Oy boshi xabari ${n} ta hodimga qayta yuborildi.`);
  });
  bot.action('adm:visits', async (ctx) => { if (await guardSee(ctx)) { await ctx.answerCbQuery(); await showVisits(ctx); } });
  bot.command('tashriflar', async (ctx) => { if (await guardSee(ctx)) await showVisits(ctx); });
  bot.action(/^adm:visit:(\d+)$/, async (ctx) => {
    if (!(await guardSee(ctx))) return;
    await ctx.answerCbQuery();
    const v = await visits.byId(ctx.match[1]);
    if (!v || !v.proof_file_id) return ctx.reply('Isbot topilmadi.');
    return notify.sendProof(botOf(ctx), ctx.chat.id, { type: v.proof_type, fileId: v.proof_file_id },
      `📍 <b>${esc(v.full_name)}</b> · ${time.prettyDate(v.visit_date)} ${time.clock(v.created_at)} · ${mapLink(v.lat, v.lon)}${v.note ? `\n💬 «${esc(v.note)}»` : ''}`);
  });

  // hodimlar
  bot.action('emp:list', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await listEmployees(ctx); } });
  bot.action(/^emp:list:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await listEmployees(ctx, Number(ctx.match[1])); } });
  bot.command('hodimlar', async (ctx) => { if (await guard(ctx)) await listEmployees(ctx); });
  bot.action(/^emp:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await employeeCard(ctx, ctx.match[1]); } });
  bot.action(/^emp:tasks:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await employeeTasks(ctx, ctx.match[1]); } });
  bot.action(/^emp:tdel:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const cur = await tasks.byId(ctx.match[1]);
    if (!cur) return ctx.answerCbQuery('Topilmadi');
    const t = await flows.cancelTask(botOf(ctx), cur, null, ctx.from.id);
    await ctx.answerCbQuery(t ? 'Bekor qilindi' : 'Topshiriq ochiq emas — o\'zgarmadi');
    return employeeTasks(ctx, cur.employee_id);
  });
  bot.action(/^emp:name:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_name', ctx.match[1], '✏️ Yangi ism-familiya:'); } });
  bot.action(/^emp:pos:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_position', ctx.match[1], '💼 Yangi lavozim:'); } });
  bot.action(/^emp:fund:(\d+)$/, async (ctx) => {
    if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_fund', ctx.match[1], config.kpiMode === 'gate'
      ? "🏆 KPI summasi (so'mda, masalan 1000000). Oy davomida vaqtida kelib, topshiriqlarni muddatida bajarsa — to'liq beriladi, bo'lmasa 0.\n0 — KPI summasi yo'q."
      : "🏆 KPI summasi (so'mda, masalan 1000000). KPI ball × summa / 100 = bonus.\n0 — summasiz (faqat ball)."); }
  });
  bot.action(/^emp:salary:(\d+)$/, async (ctx) => {
    if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_salary', ctx.match[1], "💵 Oylik oklad (so'mda, masalan 3000000). Hodim «💵 Oylik va KPI» da oklad + KPI = jami ko'radi.\n0 — o'chirish."); }
  });
  bot.action(/^emp:branch:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const rows = (await branches.listActive()).map((b) => [cb(`🏙 ${b.name}`, `emp:setbr:${id}:${b.id}`)]);
    rows.push([cb('🏢 Asosiy ofis', `emp:setbr:${id}:0`)], [cb("➕ Yangi filial", 'br:new'), cb('⬅️ Orqaga', `emp:${id}`)]);
    return render(ctx, '🏙 Filialni tanlang:', inline(rows));
  });
  bot.action(/^emp:setbr:(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await employees.setBranch(ctx.match[1], Number(ctx.match[2]) || null);
    await ctx.answerCbQuery('Saqlandi');
    return employeeCard(ctx, ctx.match[1]);
  });
  // almashtirish tugmalari: maqsad holat callback ichida; eski (holatsiz) tugma — faqat kartochkani yangilaydi
  const stale = async (ctx, id) => { await ctx.answerCbQuery('Eskirgan tugma — kartochka yangilandi'); return employeeCard(ctx, id); };
  bot.action(/^emp:mode:(\d+)(?::(office|field))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    if (!e) return ctx.answerCbQuery('Topilmadi');
    if (!ctx.match[2]) return stale(ctx, e.id);
    if ((employees.isField(e) ? 'field' : 'office') === ctx.match[2]) return stale(ctx, e.id);
    await employees.setWorkMode(e.id, ctx.match[2]);
    await ctx.answerCbQuery('Saqlandi');
    await flows.modeNotice(botOf(ctx), await employees.byId(e.id));
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:hr:(\d+)(?::([01]))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    if (!e) return ctx.answerCbQuery('Topilmadi');
    if (!ctx.match[2] || Number(Boolean(Number(e.is_hr))) === Number(ctx.match[2])) return stale(ctx, e.id);
    const on = ctx.match[2] === '1';
    await employees.setHr(e.id, on);
    await ctx.answerCbQuery(on ? 'HR qilindi' : 'HR olib tashlandi');
    if (on) await flows.hrNotice(botOf(ctx), await employees.byId(e.id));
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:video:(\d+)(?::([01]))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    if (!e) return ctx.answerCbQuery('Topilmadi');
    if (!ctx.match[2] || Number(Boolean(Number(e.video_required))) === Number(ctx.match[2])) return stale(ctx, e.id);
    await employees.setVideoRequired(e.id, ctx.match[2] === '1');
    await ctx.answerCbQuery('Saqlandi');
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:home:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    await employees.clearHome(e.id);
    await ctx.answerCbQuery('Tozalandi');
    await flows.homeClearedNotice(botOf(ctx), e);
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:start:(\d+)$/, async (ctx) => {
    if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_work_start', ctx.match[1], `🕘 Bu hodim uchun ish boshlanish vaqti (masalan <b>10:00</b>). Kechikish shu vaqt + ${config.lateGraceMinutes} daq dan hisoblanadi.\nUmumiy vaqtga (${worktime.get()}) qaytarish — <b>standart</b> deb yozing.`); }
  });
  bot.action(/^emp:end:(\d+)$/, async (ctx) => {
    if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'edit_work_end', ctx.match[1], `🏁 Bu hodim uchun ish tugash vaqti (masalan <b>19:00</b>). Undan oldin «Ketdim» bossa — «⚠️ erta ketdi» belgisi bilan rahbar va HR ga boradi.\nUmumiy vaqtga (${employees.workEndOf(null)}) qaytarish — <b>standart</b> deb yozing.`); }
  });
  bot.action(/^emp:excuse:(\d+)$/, async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await askText(ctx, 'excuse_date', ctx.match[1], '📄 Qaysi kun sababli? Sanani yozing (masalan 15.09):'); } });
  bot.action(/^emp:flex:(\d+)(?::([01]))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    if (!e) return ctx.answerCbQuery('Topilmadi');
    if (!ctx.match[2] || Number(employees.isFlexible(e)) === Number(ctx.match[2])) return stale(ctx, e.id);
    await employees.setFlexible(e.id, ctx.match[2] === '1');
    await ctx.answerCbQuery();
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:act:(\d+)(?::([01]))?$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const e = await employees.byId(ctx.match[1]);
    if (!e) return ctx.answerCbQuery('Topilmadi');
    // ikkinchi bosish ishdan ketgan hodimni qayta faollashtirmasin
    if (!ctx.match[2] || Number(Boolean(Number(e.active))) === Number(ctx.match[2])) return stale(ctx, e.id);
    const block = e.active ? await adminLossBlock(ctx, e, { deactivate: true }) : null;
    if (block) return ctx.answerCbQuery(block, { show_alert: true });
    await flows.setActive(botOf(ctx), e, ctx.match[2] === '1');
    await ctx.answerCbQuery(e.active ? 'Ishdan ketdi' : 'Faollashtirildi');
    return employeeCard(ctx, e.id);
  });
  bot.action(/^emp:role:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    return render(ctx, '🎖 Rolni tanlang:', inline([
      [cb('👤 Hodim', `emp:setrole:${id}:employee`), cb('🎖 Rahbar', `emp:setrole:${id}:head`)],
      [cb('👑 Direktor', `emp:setrole:${id}:admin`)], [cb('⬅️ Orqaga', `emp:${id}`)],
    ]));
  });
  bot.action(/^emp:setrole:(\d+):(employee|head|admin)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const block = await adminLossBlock(ctx, await employees.byId(ctx.match[1]), { newRole: ctx.match[2] });
    if (block) return ctx.answerCbQuery(block, { show_alert: true });
    await employees.setRole(ctx.match[1], ctx.match[2]);
    await ctx.answerCbQuery('Saqlandi');
    const e = await employees.byId(ctx.match[1]);
    await flows.roleNotice(botOf(ctx), e);
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

module.exports = { register, showPanel, employeeCard, handleEmpText, handleDeptText, handleBranchText, handleWorktimeText, handleBossName, showOverdue, handleGateText };
