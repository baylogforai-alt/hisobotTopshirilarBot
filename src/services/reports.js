'use strict';

const config = require('../config');
const time = require('../time');
const ui = require('../ui');
const tg = require('../telegram');
const employees = require('./employees');
const departments = require('./departments');
const tasks = require('./tasks');
const attendance = require('./attendance');
const dailyReports = require('./dailyReports');
const kpi = require('./kpi');
const notify = require('./notify');

const { esc, LINE } = ui;
const COMPANY = config.companyName.toUpperCase();

const lateTag = (row) => (row && Number(row.late_minutes) > 0 ? ` ⏰ <i>${time.prettyDuration(Number(row.late_minutes))} kech</i>` : '');
const mentionHtml = (e) => `<a href="tg://user?id=${e.tg_id}">${esc(e.full_name)}</a>`;
const deptTag = (e) => (e.department_name ? ` · ${esc(e.department_name)}` : '');

// ---------------------------------------------------------------------------
// BUGUNGI HOLAT
// ---------------------------------------------------------------------------

/** Kunlik holat: har hodim bo'yicha davomat + topshiriq + kunlik hisobot. deptId berilsa faqat shu bo'lim. */
const buildToday = async ({ deptId = null, date = time.today(), title = 'BUGUNGI HOLAT' } = {}) => {
  const list = deptId ? await employees.listByDepartment(deptId) : await employees.listActive();
  const lines = [];
  let present = 0, late = 0, absent = 0, excused = 0, doneAll = 0, openAll = 0, overdueAll = 0, awaitingAll = 0, reportsAll = 0;
  let lastDept = null;
  const hasDepts = list.some((e) => e.department_name);
  for (const e of list) {
    if (!deptId && hasDepts && e.department_name !== lastDept) {
      lastDept = e.department_name;
      lines.push(`\n🏢 <b>${esc(lastDept || "Bo'limsiz")}</b>`);
    }
    const row = await attendance.get(e.id, date);
    const st = attendance.dayStatus(row, date, time.today(), e);
    const ds = await tasks.dayStats(e.id, date);
    const awaiting = (await tasks.awaitingReviewFor(e.id)).length;
    const rep = await dailyReports.get(e.id, date);
    doneAll += ds.done; openAll += ds.open; overdueAll += ds.overdue; awaitingAll += awaiting;
    if (rep) reportsAll += 1;
    let att;
    if (st === 'ontime' || (st === 'late' && employees.isFlexible(e))) { present += 1; att = `🟢 ${time.clock(row.checked_in)}`; }
    else if (st === 'late') { present += 1; late += 1; att = `🟡 ${time.clock(row.checked_in)}${lateTag(row)}`; }
    else if (st === 'excused') { excused += 1; att = `📄 sababli${row && row.excuse_reason ? ` (${esc(row.excuse_reason)})` : ''}`; }
    else if (st === 'pending') { absent += 1; att = `🙋 sabab kutilmoqda${row && row.excuse_reason ? ` (${esc(row.excuse_reason)})` : ''}`; }
    else if (st === 'off' || st === 'future') att = row && row.intent === 'no' ? '🙅 kelmayman dedi' : '⚪ hali kelmagan';
    else { absent += 1; att = row && row.intent === 'no' ? '🔴 kelmagan (oldindan aytgan)' : '🔴 kelmagan'; }
    if (row && row.checked_out) att += ` → 🏁 ${time.clock(row.checked_out)}`;
    const tsk = `✔️ ${ds.done} · ⏳ ${ds.open}${ds.overdue ? ` · 🔴 ${ds.overdue}` : ''}${awaiting ? ` · 🕓 ${awaiting}` : ''}${rep ? ' · 📝 hisobot' : ''}`;
    lines.push(`${ui.roleIcon(e.role)} <b>${esc(e.full_name)}</b>${e.position ? ` <i>(${esc(e.position)})</i>` : ''}${employees.isFlexible(e) ? ' 🕊' : ''}\n   ${att}\n   ${tsk}`);
  }
  const header =
    `📊 <b>${title}</b> · ${time.prettyDate(date)}\n${LINE}\n` +
    `👥 ${list.length} hodim · 🟢 keldi ${present}${late ? ` (🟡 kech ${late})` : ''} · 🔴 yo'q ${absent}${excused ? ` · 📄 sababli ${excused}` : ''}\n` +
    `✔️ bajarildi ${doneAll} · ⏳ ochiq ${openAll}${overdueAll ? ` · 🔴 muddati o'tgan ${overdueAll}` : ''}${awaitingAll ? ` · 🕓 tekshiruvda ${awaitingAll}` : ''}\n` +
    `📝 kunlik hisobot: ${reportsAll}/${present}\n${LINE}`;
  return { text: header + lines.join('\n'), present, late, absent, excused, doneAll, openAll, overdueAll, awaitingAll, reportsAll, count: list.length };
};

/**
 * Guruhga kun oxiri hisoboti — itemli: har bir hodim aynan QAYSI ishlarni bajargani (✅)
 * va qaysilari qolgani (⏳). KPI / pul chiqmaydi.
 */
const buildDailyGroupText = async (date = time.today()) => {
  const list = await employees.listActive();
  const blocks = [];
  let totalDone = 0, totalOpen = 0;
  const MAX_ITEMS = 12;
  for (const e of list) {
    const row = await attendance.get(e.id, date);
    const st = attendance.dayStatus(row, date, time.today(), e);
    const done = await tasks.doneOn(e.id, date);
    const open = await tasks.openFor(e.id);
    totalDone += done.length; totalOpen += open.length;
    const att = st === 'ontime' ? `🟢 ${time.clock(row.checked_in)}`
      : st === 'late' ? (employees.isFlexible(e) ? `🟢 ${time.clock(row.checked_in)}` : `🟡 ${time.clock(row.checked_in)} (${time.prettyDuration(Number(row.late_minutes))} kech)`)
      : st === 'excused' ? '📄 sababli' : employees.isFlexible(e) ? '🕊 erkin jadval' : '🔴 kelmadi';
    const total = done.length + open.length;
    const pct = total ? Math.round((done.length / total) * 100) : null;
    const items = [
      ...done.map((t) => `   ✅ ${esc(t.title)}`),
      ...open.map((t) => `   ⏳ ${esc(t.title)}${t.due_date < date ? ' 🔴' : ''}`),
    ];
    const shown = items.slice(0, MAX_ITEMS);
    if (items.length > MAX_ITEMS) shown.push(`   <i>…yana ${items.length - MAX_ITEMS} ta</i>`);
    blocks.push(
      `${att} · <b>${esc(e.full_name)}</b>${total ? ` — ✅ ${done.length}/${total}${pct !== null ? ` (${pct}%)` : ''}` : ''}` +
        (open.length ? ` · ⏳ ${open.length} ertaga o'tadi` : '') + (shown.length ? `\n${shown.join('\n')}` : ''),
    );
  }
  return (
    `📋 <b>${COMPANY} — KUN YAKUNI</b> · ${time.prettyDate(date)}\n${LINE}\n${blocks.join('\n\n') || "<i>hodim yo'q</i>"}\n${LINE}\n` +
    `✅ Bajarildi: <b>${totalDone}</b>   ⏳ Qoldi: <b>${totalOpen}</b>`
  );
};

/** Ertalab direktor/boshliqlarga: kim keldi, kim kech, kim yo'q */
const buildMorningDigest = async ({ deptId = null } = {}) => {
  const list = deptId ? await employees.listByDepartment(deptId) : await employees.listActive();
  const onTime = [], late = [], missing = [], excused = [], saidNo = [];
  for (const e of list) {
    const row = await attendance.get(e.id);
    const st = attendance.dayStatus(row, time.today(), time.today(), e);
    if (st === 'ontime' || (st === 'late' && employees.isFlexible(e))) onTime.push(e);
    else if (st === 'late') late.push({ e, row });
    else if (st === 'excused' || st === 'pending') excused.push({ e, row });
    else if (row && row.intent === 'no') saidNo.push(e);
    else if (!employees.isFlexible(e)) missing.push(e);
  }
  const text =
    `🌅 <b>ERTALABKI HOLAT</b> · ${time.prettyDate(time.today())} · ${time.now().toFormat('HH:mm')}\n${LINE}\n` +
    `🟢 Vaqtida: <b>${onTime.length}</b>${onTime.length ? ` — ${onTime.map((e) => esc(e.full_name)).join(', ')}` : ''}\n` +
    `🟡 Kech: <b>${late.length}</b>${late.length ? '\n' + late.map(({ e, row }) => `   • ${esc(e.full_name)} — ${time.clock(row.checked_in)}${lateTag(row)}${row.late_reason ? ` («${esc(row.late_reason)}»)` : ''}`).join('\n') : ''}\n` +
    `🔴 Hali kelmagan: <b>${missing.length}</b>${missing.length ? '\n' + missing.map((e) => `   • ${esc(e.full_name)}${deptTag(e)}`).join('\n') : ''}` +
    (saidNo.length ? `\n🙅 Kelmasligini aytgan: ${saidNo.map((e) => esc(e.full_name)).join(', ')}` : '') +
    (excused.length ? `\n📄 Sababli / so'rov: ${excused.map(({ e, row }) => `${esc(e.full_name)}${row.excuse_status === 'pending' ? ' (kutilmoqda)' : ''}`).join(', ')}` : '');
  return { text, onTime, late, missing, excused, saidNo };
};

// ---------------------------------------------------------------------------
// ESLATMALAR
// ---------------------------------------------------------------------------

/** Ish boshlanishida guruhga «Xayrli tong» + kelmaganlar ro'yxati (guruh ulangan bo'lsa) */
const sendMorningGroupCall = async (bot) => {
  const list = await employees.listActive();
  const waiting = [];
  for (const e of list) {
    if (employees.isFlexible(e)) continue;
    const row = await attendance.get(e.id);
    if (row && (row.checked_in || row.excuse_status || row.intent === 'no')) continue;
    waiting.push(e);
  }
  if (!waiting.length) return { sent: false };
  const ok = await notify.toGroup(
    bot,
    `🌅 <b>Xayrli tong, ${esc(config.companyName)} jamoasi!</b> · ${time.prettyDate(time.today())}\n\n` +
      `Botga kirib <b>«${ui.BTN.checkIn}»</b> tugmasini bosing — bugungi missiyalaringiz ishga tushadi.\n\n` +
      `Kutilmoqda: ${waiting.map((e) => mentionHtml(e)).join(', ')}`,
  );
  return { sent: Boolean(ok), count: waiting.length };
};

/**
 * Ochiq topshiriqlari borlarga shaxsiy eslatma (tugmali ro'yxat bilan);
 * guruhga umumiy ro'yxat (ANNOUNCE_DONE bo'lsa); tekshiruvchilarga kutayotgan ishlar soni.
 */
const sendReminder = async (bot, { group = config.announceDone } = {}) => {
  const list = await employees.listActive();
  let sent = 0;
  const blocks = [];
  for (const e of list) {
    const open = await tasks.openFor(e.id);
    if (!open.length) continue;
    const overdue = open.filter((t) => t.due_date < time.today());
    const working = await attendance.isCheckedIn(e.id);
    if (working) blocks.push(`${mentionHtml(e)} — <b>${open.length} ta</b>${overdue.length ? ` (🔴 ${overdue.length} kechikkan)` : ''}:\n${ui.taskList(open.slice(0, 8))}${open.length > 8 ? `\n   <i>…yana ${open.length - 8} ta</i>` : ''}`);
    await notify.toUser(
      bot, e.tg_id,
      `🔔 <b>Eslatma</b> · ${time.now().toFormat('HH:mm')} — sizda <b>${open.length} ta</b> ochiq topshiriq bor${overdue.length ? `, shundan <b>${overdue.length} tasi muddati o'tgan</b> 🔴` : ''}:\n\n` +
        `${ui.taskList(open)}\n\nBajarganini pastdan bosing 👇`,
      ui.doneKeyboard(open),
    );
    sent += 1;
    await tg.throttle();
  }
  if (group && blocks.length) {
    await notify.toGroup(
      bot,
      `🔔 <b>${COMPANY} — MISSIYA ESLATMASI</b> · ${time.now().toFormat('HH:mm')}\n<i>${time.prettyDate(time.today())}</i>\n\n${blocks.join('\n\n')}\n\n` +
        `👉 Bajarganingizni botga kirib <b>«${ui.BTN.done}»</b> orqali belgilang.`,
    );
  }
  // tekshiruvchilar
  const pending = await tasks.pendingReview();
  const byReviewer = new Map();
  for (const t of pending) {
    const emp = await employees.byId(t.employee_id);
    for (const id of await employees.reviewersOf(emp)) byReviewer.set(id, (byReviewer.get(id) || 0) + 1);
  }
  for (const [id, n] of byReviewer) {
    await notify.toUser(bot, id, `🕓 Tekshiruvni kutayotgan <b>${n} ta</b> topshiriq bor — «${ui.BTN.review}» tugmasini bosing.`);
    await tg.throttle();
  }
  return { sent, reviewers: byReviewer.size, group: group && blocks.length > 0 };
};

// ---------------------------------------------------------------------------
// OYLIK / SHAXSIY
// ---------------------------------------------------------------------------

/** Hodimning o'z hisoboti (oy bo'yicha) */
const buildMyReport = async (emp, month = time.month()) => {
  const { from, to } = time.monthRange(month);
  const ts = await tasks.stats(emp.id, from, to);
  const at = await attendance.stats(emp, from, to);
  const open = await tasks.openFor(emp.id);
  const k = await kpi.compute(emp, month);
  const reports = await dailyReports.countBetween(emp.id, from, to);
  const dept = emp.department_id ? await departments.byId(emp.department_id) : null;
  const customName = dept && dept.custom_name ? dept.custom_name : "Qo'shimcha mezon";
  const lines = [
    `📊 <b>${esc(emp.full_name)}</b> — ${time.monthName(month)}`,
    `<i>${esc(emp.position || employees.roleLabel(emp.role))}${emp.department_name ? ` · ${esc(emp.department_name)}` : ''}</i>`,
    LINE,
    `📋 <b>Topshiriqlar</b> (muddati kelganlar): ${ts.total} ta`,
    `   ✅ muddatida: ${ts.ontime} · ⏱ kech qabul: ${ts.late} · 🕓 tekshiruvda: ${ts.awaiting}`,
    `   ⏳ ochiq: ${ts.open}${ts.overdue ? ` · 🔴 muddati o'tgan: ${ts.overdue}` : ''}${ts.returned ? ` · ↩️ qaytarilgan: ${ts.returned}` : ''}`,
    `   ${ui.pctBar(ts.pct)}${ts.penalty ? ` <i>(${ts.rawPct}% − ${ts.penalty}% qaytarish jarimasi)</i>` : ''}`,
    '',
    `🕘 <b>Davomat</b>: ${at.workDays} ish kuni`,
    `   🟢 vaqtida: ${at.ontime} · 🟡 kech: ${at.late}${at.lateMinutes ? ` (${time.prettyDuration(at.lateMinutes)})` : ''} · 🔴 kelmagan: ${at.absent} · 📄 sababli: ${at.excused}`,
    `   ${ui.pctBar(at.pct)}`,
    `📝 <b>Kunlik hisobotlar</b>: ${reports} ta`,
    '',
    `💰 <b>KPI</b> (${k.status === 'draft' ? 'hozircha' : kpi.statusLabel(k.status)}): <b>${k.total} ball</b>`,
    `   topshiriq ${k.tasks_pct}%×${k.w_tasks} · davomat ${k.att_pct}%×${k.w_attendance}` +
      ` · boshliq ${k.head_score === null ? '—' : `${k.head_score}/10`}×${k.w_head} · ${esc(customName)} ${k.custom_pct === null ? '—' : `${k.custom_pct}%`}×${k.w_custom}`,
  ];
  if (k.status === 'confirmed' && k.bonus_amount !== null) lines.push(`   💵 Bonus: <b>${kpi.fmtMoney(k.bonus_amount)}</b>`);
  if (k.status === 'excluded') lines.push(`   ⛔ Bu oy bonusdan chiqarilgan${k.note ? `: ${esc(k.note)}` : ''}`);
  if (open.length) lines.push('', `⏳ <b>Hozir ochiq (${open.length}):</b>`, ui.taskList(open));
  return lines.join('\n');
};

/** Bo'lim boshlig'i / direktor uchun oylik jadval (bo'lim yoki hamma) */
const buildMonthTable = async ({ month = time.month(), deptId = null } = {}) => {
  const list = deptId ? await employees.listByDepartment(deptId) : await employees.listActive();
  const { from, to } = time.monthRange(month);
  const rows = [];
  for (const e of list) {
    const ts = await tasks.stats(e.id, from, to);
    const at = await attendance.stats(e, from, to);
    const rep = await dailyReports.countBetween(e.id, from, to);
    rows.push({ e, ts, at, rep });
  }
  rows.sort((a, b) => b.ts.pct + b.at.pct - (a.ts.pct + a.at.pct));
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map(({ e, ts, at, rep }, i) =>
    `${medals[i] || `${i + 1}.`} <b>${esc(e.full_name)}</b>${deptId ? '' : deptTag(e)}\n` +
    `   📋 ${ts.ontime}/${ts.total} (${ts.pct}%)${ts.overdue ? ` 🔴${ts.overdue}` : ''} · 🕘 ${at.ontime}/${at.workDays} (${at.pct}%)${at.late ? ` 🟡${at.late}` : ''}${at.absent ? ` 🔴${at.absent}` : ''} · 📝 ${rep}`);
  const title = deptId ? `🏢 <b>${esc((await departments.byId(deptId)).name)}</b>` : `👥 <b>JAMOA</b>`;
  return `${title} — ${time.monthName(month)}\n<i>📋 topshiriq muddatida/jami · 🕘 vaqtida/ish kuni · 📝 kunlik hisobotlar</i>\n${LINE}\n${lines.join('\n') || "<i>hodim yo'q</i>"}`;
};

/** Bitta hodimning to'liq topshiriq holati (arxiv uchun) */
const buildEmployeeTasks = async (emp) => {
  const date = time.today();
  const open = await tasks.openFor(emp.id);
  const awaiting = await tasks.awaitingReviewFor(emp.id);
  const doneToday = await tasks.doneOn(emp.id, date);
  const row = await attendance.get(emp.id, date);
  const st = attendance.dayStatus(row, date, date, emp);
  const status = row && row.checked_out ? `🏁 ketdi (${time.clock(row.checked_out)})`
    : row && row.checked_in ? `🟢 ishda (${time.clock(row.checked_in)} dan)${lateTag(row)}`
    : employees.isFlexible(emp) ? '🕊 erkin jadval' : st === 'excused' ? '📄 sababli' : '🔴 kelmagan';
  const fmtOpen = (t) => `   ${t.due_date < date ? '🔴' : t.priority === 'high' ? '🔥' : '🔹'} ${esc(t.title)}${t.due_date !== date ? ` <i>(${time.prettyDate(t.due_date)} gacha)</i>` : ''}${t.source !== 'self' ? ` <i>· ${ui.SOURCE_LABEL[t.source]}</i>` : ''}`;
  return (
    `👤 <b>${esc(emp.full_name)}</b>${emp.position ? ` · ${esc(emp.position)}` : ''}\nHolat: ${status}\n\n` +
    `🎯 <b>Bajarilishi kerak (${open.length})</b>\n${open.length ? open.map(fmtOpen).join('\n') : "   <i>— yo'q —</i>"}\n\n` +
    `🕓 <b>Tekshiruvda (${awaiting.length})</b>\n${awaiting.length ? awaiting.map((t) => `   🕓 ${esc(t.title)} <i>${time.clock(t.done_at)}</i>`).join('\n') : "   <i>— yo'q —</i>"}\n\n` +
    `✅ <b>Bugun bajardi (${doneToday.length})</b>\n${doneToday.length ? doneToday.map((t) => `   ✅ ${esc(t.title)} <i>${time.clock(t.done_at)}</i>`).join('\n') : "   <i>— yo'q —</i>"}`
  );
};

module.exports = {
  lateTag, mentionHtml, buildToday, buildDailyGroupText, buildMorningDigest, sendMorningGroupCall, sendReminder,
  buildMyReport, buildMonthTable, buildEmployeeTasks,
};
