'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const employees = require('./employees');
const tasks = require('./tasks');
const attendance = require('./attendance');
const activity = require('./activity');
const dailyReports = require('./dailyReports');

/**
 * Bitta hodimning FAOLIYAT ARXIVI.
 * Direktor uchun: qaysi kuni ishga qachon kelgan, qachon ketgan,
 * nima qilgan, nima yozib qo'ygan, kunlik hisobotida nima degan — hammasi bir joyda.
 */

const COMPANY = config.companyName.toUpperCase();
const { esc, LINE } = ui;

/** Kelish kechmi (late_minutes bo'yicha; erkin jadval — hech qachon kech emas) */
const isLate = (row, emp = null) => Boolean(row && Number(row.late_minutes) > 0 && !(emp && employees.isFlexible(emp)));

/** Hodim ro'yxatidagi bitta qator — hozirgi holati bilan */
const statusLine = async (emp, date = time.today()) => {
  const att = await attendance.get(emp.id, date);
  const st = await tasks.dayStats(emp.id, date);
  const ds = attendance.dayStatus(att, date, time.today(), emp);
  let status;
  if (att && att.checked_in && att.checked_out) status = `🏁 ketdi ${time.clock(att.checked_out)}`;
  else if (att && att.checked_in) status = `🟢 ishda (${time.clock(att.checked_in)} dan)${isLate(att, emp) ? ' ⚠️' : ''}`;
  else if (ds === 'excused') status = '📄 sababli';
  else if (ds === 'pending') status = '🙋 sabab kutilmoqda';
  else if (employees.isFlexible(emp)) status = '🕊 erkin jadval';
  else if (att && att.intent === 'no') status = '🙅 kelmayman dedi';
  else if (ds === 'future' || ds === 'off') status = '⚪ hali kelmagan';
  else status = '🔴 kelmadi';
  return { status, st, att };
};

/**
 * BIR KUNLIK TO'LIQ KARTOCHKA — direktor ko'radigan asosiy ko'rinish.
 */
const dayCard = async (emp, date) => {
  const att = await attendance.get(emp.id, date);
  const done = await tasks.doneOn(emp.id, date);
  const created = await tasks.createdOn(emp.id, date);
  const cancelled = await tasks.cancelledOn(emp.id, date);
  const onDuty = await tasks.dueOn(emp.id, date);
  const acts = await activity.forDay(emp.id, date);
  const report = await dailyReports.get(emp.id, date);

  const doneIds = new Set(done.map((t) => Number(t.id)));
  // O'sha kunning oxirida hali yopilmagan ishlar
  const notDone = onDuty.filter((t) => {
    if (doneIds.has(Number(t.id))) return false;
    if ((t.status === 'done' || t.status === 'accepted') && String(t.done_at).slice(0, 10) <= date) return false;
    return true;
  });
  const notes = acts.filter((a) => a.action === 'note');
  const isToday = date === time.today();
  const st = attendance.dayStatus(att, date, time.today(), emp);

  const out = [];
  out.push('🗂 <b>KUN DAFTARI</b>');
  out.push(`👤 <b>${esc(emp.full_name)}</b>${emp.position ? ` · <i>${esc(emp.position)}</i>` : ''}${emp.department_name ? ` · ${esc(emp.department_name)}` : ''}`);
  out.push(`📅 <i>${time.prettyDate(date)}</i>${isToday ? ' · <b>bugun</b>' : ''}`);
  out.push('');

  out.push('⏰ <b>ISH VAQTI</b>');
  if (att && att.checked_in) {
    const dist = att.checkin_dist !== null && att.checkin_dist !== undefined && att.checkin_dist !== '' ? ` · 📍 ofisdan ${geo.prettyDistance(Number(att.checkin_dist))}` : '';
    out.push(`   🟢 Keldi:  <b>${time.clock(att.checked_in)}</b>${isLate(att, emp) ? ` ⚠️ <i>${time.prettyDuration(Number(att.late_minutes))} kech</i>` : ''}${dist}`);
    if (att.late_reason) out.push(`   💬 Sabab: <i>${esc(att.late_reason)}</i>`);
    out.push(att.checked_out ? `   🏁 Ketdi:  <b>${time.clock(att.checked_out)}</b>` : '   🏁 Ketdi:  <i>hali belgilamagan</i>');
    const mins = attendance.workedMinutes(att);
    if (mins !== null) out.push(`   ⏱ Ishlagan: <b>${time.prettyDuration(mins)}</b>`);
  } else if (st === 'excused') {
    out.push(`   📄 <i>Sababli kun</i>${att && att.excuse_reason ? ` — ${esc(att.excuse_reason)}` : ''}`);
  } else if (st === 'pending') {
    out.push(`   🙋 <i>Sababli kun so'ragan (tasdiqlanmagan)</i>${att && att.excuse_reason ? ` — ${esc(att.excuse_reason)}` : ''}`);
  } else if (employees.isFlexible(emp)) {
    out.push('   🕊 <i>Erkin jadval — kelish qayd etilmagan</i>');
  } else if (att && att.intent === 'no') {
    out.push(`   🙅 <i>Kelmasligini oldindan bildirgan</i> (${time.clock(att.intent_at)})`);
  } else if (st === 'off') {
    out.push('   ⚪ <i>Dam olish kuni</i>');
  } else if (st === 'future') {
    out.push('   ⚪ <i>Hali kelmagan</i>');
  } else {
    out.push('   🔴 <i>Ishga kelmagan</i>');
  }
  out.push('');

  out.push(`✅ <b>BAJARGAN ISHLARI (${done.length})</b>`);
  if (done.length) done.forEach((t, i) => out.push(`   ${i + 1}. ${esc(t.title)} — <i>${time.clock(t.done_at)}</i>${t.status === 'done' ? ' 🕓' : ''}${Number(t.returned_count) ? ` ↩️${t.returned_count}` : ''}`));
  else out.push('   <i>— bu kuni hech nima bajarilmagan —</i>');
  out.push('');

  out.push(`⏳ <b>BAJARILMAGANI (${notDone.length})</b>`);
  if (notDone.length) {
    notDone.forEach((t, i) => {
      const overdue = t.due_date < date;
      out.push(`   ${i + 1}. ${esc(t.title)}${overdue ? ` ⚠️ <i>muddati ${time.prettyDate(t.due_date)} edi</i>` : ` <i>(${time.prettyDate(t.due_date)} gacha)</i>`}`);
    });
  } else out.push('   <i>— hammasi yopilgan —</i>');
  out.push('');

  out.push(`📝 <b>SHU KUNI YOZIB QO'YGANLARI (${created.length})</b>`);
  if (created.length) {
    created.forEach((t, i) => {
      const span = t.start_date === t.due_date ? time.prettyDate(t.due_date) : `${time.prettyDate(t.start_date)} → ${time.prettyDate(t.due_date)}`;
      out.push(`   ${i + 1}. ${esc(t.title)}${t.source !== 'self' ? ` <i>(${ui.SOURCE_LABEL[t.source]} berdi)</i>` : ''}\n        <i>${span}</i>`);
    });
  } else out.push('   <i>— yangi reja yozmagan —</i>');

  if (cancelled.length) {
    out.push('', `🗑 <b>O'CHIRGANLARI (${cancelled.length})</b>`);
    cancelled.forEach((t) => out.push(`   • <s>${esc(t.title)}</s> <i>${time.clock(t.cancelled_at)}</i>`));
  }

  out.push('', `📋 <b>KUNLIK HISOBOTI</b>`);
  if (report) {
    out.push(`   <i>${time.clock(report.submitted_at)} da topshirgan${report.photo_file_id ? ' · 📎 rasm bilan' : ''}${report.reviewed_at ? " · 👁 ko'rilgan" : ''}</i>`);
    out.push(`   ${esc(report.text).slice(0, 1200).split('\n').join('\n   ')}`);
    if (report.review_note) out.push(`   💬 <i>Boshliq: «${esc(report.review_note)}»</i>`);
  } else out.push('   <i>— topshirmagan —</i>');

  if (notes.length) {
    out.push('', `💬 <b>BOTGA YOZGAN MATNLARI (${notes.length})</b>`);
    notes.slice(0, 10).forEach((a) => out.push(`   • «${esc(a.title || a.detail || '')}» <i>${time.clock(a.created_at)}</i>`));
    if (notes.length > 10) out.push(`   <i>…yana ${notes.length - 10} ta</i>`);
  }

  out.push('', LINE);
  const last = acts.length ? acts[acts.length - 1] : null;
  out.push(`📈 <b>Bot faolligi:</b> ${acts.length} ta harakat${last ? ` · oxirgisi ${time.clock(last.created_at)}` : ''}`);
  return out.join('\n');
};

/** Kun ichidagi TO'LIQ harakatlar lentasi — nima qilgani vaqti bilan */
const timeline = async (emp, date, { all = true } = {}) => {
  const acts = await activity.forDay(emp.id, date);
  const rows = all ? acts : acts.filter((a) => activity.meta(a.action).major);
  const head = `📜 <b>HARAKATLAR TARIXI</b>\n👤 <b>${esc(emp.full_name)}</b>\n📅 <i>${time.prettyDate(date)}</i>\n\n`;
  if (!rows.length) return `${head}<i>Bu kuni hodim botga umuman kirmagan.</i>`;
  const MAX = 60;
  const shown = rows.slice(-MAX);
  const lines = shown.map((a) => {
    const m = activity.meta(a.action);
    const what = a.title ? `: ${esc(a.title)}` : '';
    const extra = a.detail ? ` <i>${esc(a.detail)}</i>` : '';
    return `<code>${time.clock(a.created_at)}</code> ${m.icon} ${esc(m.label)}${what}${extra}`;
  });
  return head + (rows.length > MAX ? `<i>(oxirgi ${MAX} tasi, jami ${rows.length})</i>\n\n` : '') + lines.join('\n');
};

/** Direktor uchun umumiy ko'rinish — kim qanchalik faol (oxirgi N kun) */
const teamOverview = async (days = 7) => {
  const to = time.today();
  const from = time.addDays(to, -(days - 1));
  const list = await employees.listActive();
  const lines = [];
  for (const emp of list) {
    const at = await attendance.stats(emp, from, to);
    let minutes = 0;
    at.days.forEach((d) => { const m = attendance.workedMinutes(d.row); if (m !== null) minutes += m; });
    const done = (await tasks.doneBetween(emp.id, from, to)).length;
    const reps = await dailyReports.countBetween(emp.id, from, to);
    const last = await activity.lastSeen(emp.id);
    const seen = last ? `${time.prettyDate(last.work_date)} ${time.clock(last.created_at)}` : "yozuv yo'q";
    lines.push(
      `👤 <b>${esc(emp.full_name)}</b>${employees.isFlexible(emp) ? ' 🕊' : ''}${emp.department_name ? ` · <i>${esc(emp.department_name)}</i>` : ''}\n` +
        `   🟢 ${at.ontime + at.late}/${at.workDays} kun${at.late ? ` · 🟡 ${at.late}` : ''}${at.absent ? ` · 🔴 ${at.absent}` : ''} · ⏱ ${time.prettyDuration(minutes)} · ✅ ${done} ta · 📝 ${reps}\n` +
        `   👆 oxirgi faollik: <i>${esc(seen)}</i>`,
    );
  }
  return `🏢 <b>${COMPANY} — JAMOA FAOLLIGI</b>\n<i>${time.prettyDate(from)} — ${time.prettyDate(to)} (${days} kun)</i>\n\n${lines.join('\n\n') || "<i>Hodimlar yo'q</i>"}`;
};

module.exports = { dayCard, timeline, teamOverview, statusLine, isLate };
