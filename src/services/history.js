'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const geo = require('../geo');
const employees = require('./employees');
const missions = require('./missions');
const attendance = require('./attendance');
const activity = require('./activity');

/**
 * Bitta hodimning FAOLIYAT ARXIVI.
 * Direktor uchun: qaysi kuni ishga qachon kelgan, qachon ketgan,
 * nima qilgan, nima yozib qo'ygan — hammasi bir joyda.
 */

const COMPANY = config.companyName.toUpperCase();

const dash = '━━━━━━━━━━━━━━━━━━';

/** Kelish vaqti kechmi? (ish boshlanish soatiga nisbatan) */
const isLate = (iso) => {
  if (!iso) return false;
  const hhmm = time.clock(iso);
  if (hhmm === '—') return false;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m > config.workStartHour * 60;
};

/** '09:12' → daqiqa */
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

const fromMinutes = (mins) => {
  if (mins === null || mins === undefined) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** Hodim ro'yxatidagi bitta qator — hozirgi holati bilan */
const statusLine = async (emp, date = time.today()) => {
  const att = await attendance.get(emp.id, date);
  const st = await missions.dayStats(emp.id, date);
  let status;
  if (att && att.checked_in && att.checked_out) status = `🏁 ketdi ${time.clock(att.checked_out)}`;
  else if (att && att.checked_in) status = `🟢 ishda (${time.clock(att.checked_in)} dan)`;
  else if (employees.isFlexible(emp)) status = '🕊 erkin jadval';
  else if (att && att.intent === 'no') status = '🙅 kelmayman dedi';
  else status = '🚫 kelmadi';
  return { status, st, att };
};

/**
 * BIR KUNLIK TO'LIQ KARTOCHKA — direktor ko'radigan asosiy ko'rinish.
 */
const dayCard = async (emp, date) => {
  const att = await attendance.get(emp.id, date);
  const done = await missions.doneOn(emp.id, date);
  const created = await missions.createdOn(emp.id, date);
  const cancelled = await missions.cancelledOn(emp.id, date);
  const onDuty = await missions.dueOn(emp.id, date);
  const acts = await activity.forDay(emp.id, date);

  const doneIds = new Set(done.map((m) => Number(m.id)));
  // O'sha kunning oxirida hali yopilmagan ishlar: shu kuni bajarilganlari ham,
  // undan OLDIN bajarib qo'yilganlari ham bu ro'yxatga tushmaydi.
  const notDone = onDuty.filter((m) => {
    if (doneIds.has(Number(m.id))) return false;
    if (m.status === 'done' && String(m.done_at).slice(0, 10) <= date) return false;
    return true;
  });

  const notes = acts.filter((a) => a.action === 'note');
  const isToday = date === time.today();

  const out = [];
  out.push('🗂 <b>KUN DAFTARI</b>');
  out.push(`👤 <b>${ui.esc(emp.full_name)}</b>${emp.position ? ` · <i>${ui.esc(emp.position)}</i>` : ''}`);
  out.push(`📅 <i>${time.prettyDate(date)}</i>${isToday ? ' · <b>bugun</b>' : ''}`);
  out.push('');

  // --- Ish vaqti ---
  out.push('⏰ <b>ISH VAQTI</b>');
  if (att && att.checked_in) {
    const late = isLate(att.checked_in);
    const dist =
      att.checkin_dist !== null && att.checkin_dist !== undefined && att.checkin_dist !== ''
        ? ` · 📍 ofisdan ${geo.prettyDistance(Number(att.checkin_dist))}`
        : '';
    out.push(`   🟢 Keldi:  <b>${time.clock(att.checked_in)}</b>${late ? ' ⚠️ <i>kech</i>' : ''}${dist}`);
    out.push(
      att.checked_out
        ? `   🏁 Ketdi:  <b>${time.clock(att.checked_out)}</b>`
        : '   🏁 Ketdi:  <i>hali belgilamagan</i>',
    );
    const mins = attendance.workedMinutes(att);
    if (mins !== null) out.push(`   ⏱ Ishlagan: <b>${attendance.prettyDuration(mins)}</b>`);
  } else if (employees.isFlexible(emp)) {
    out.push('   🕊 <i>Erkin jadval — kelish qayd etilmaydi</i>');
  } else if (att && att.intent === 'no') {
    out.push(`   🙅 <i>Kelmasligini oldindan bildirgan</i> (${time.clock(att.intent_at)})`);
  } else {
    out.push('   🚫 <i>Ishga kelmagan</i>');
  }
  out.push('');

  // --- Bajargan ishlari ---
  out.push(`✅ <b>BAJARGAN ISHLARI (${done.length})</b>`);
  if (done.length) {
    done.forEach((m, i) => {
      out.push(`   ${i + 1}. ${ui.esc(m.title)} — <i>${time.clock(m.done_at)}</i>`);
    });
  } else {
    out.push('   <i>— bu kuni hech nima bajarilmagan —</i>');
  }
  out.push('');

  // --- Bajarilmaganlari ---
  out.push(`⏳ <b>BAJARILMAGANI (${notDone.length})</b>`);
  if (notDone.length) {
    notDone.forEach((m, i) => {
      const overdue = m.due_date < date;
      out.push(
        `   ${i + 1}. ${ui.esc(m.title)}` +
          (overdue
            ? ` ⚠️ <i>muddati ${time.prettyDate(m.due_date)} edi</i>`
            : ` <i>(${time.prettyDate(m.due_date)} gacha)</i>`),
      );
    });
  } else {
    out.push('   <i>— hammasi yopilgan —</i>');
  }
  out.push('');

  // --- Shu kuni yozib qo'yganlari ---
  out.push(`📝 <b>SHU KUNI YOZIB QO'YGANLARI (${created.length})</b>`);
  if (created.length) {
    created.forEach((m, i) => {
      const span =
        m.start_date === m.due_date
          ? time.prettyDate(m.start_date)
          : `${time.prettyDate(m.start_date)} → ${time.prettyDate(m.due_date)}`;
      out.push(`   ${i + 1}. ${ui.esc(m.title)}\n        <i>${span}</i>`);
    });
  } else {
    out.push('   <i>— yangi reja yozmagan —</i>');
  }

  // --- O'chirganlari ---
  if (cancelled.length) {
    out.push('');
    out.push(`🗑 <b>O'CHIRGANLARI (${cancelled.length})</b>`);
    cancelled.forEach((m) =>
      out.push(`   • <s>${ui.esc(m.title)}</s> <i>${time.clock(m.cancelled_at)}</i>`),
    );
  }

  // --- Yozgan matnlari ---
  if (notes.length) {
    out.push('');
    out.push(`💬 <b>BOTGA YOZGAN MATNLARI (${notes.length})</b>`);
    notes.slice(0, 10).forEach((a) =>
      out.push(`   • «${ui.esc(a.title || a.detail || '')}» <i>${time.clock(a.created_at)}</i>`),
    );
    if (notes.length > 10) out.push(`   <i>…yana ${notes.length - 10} ta</i>`);
  }

  // --- Faollik ---
  out.push('');
  out.push(dash);
  const last = acts.length ? acts[acts.length - 1] : null;
  out.push(
    `📈 <b>Bot faolligi:</b> ${acts.length} ta harakat` +
      (last ? ` · oxirgisi ${time.clock(last.created_at)}` : ''),
  );

  return out.join('\n');
};

/** Kun ichidagi TO'LIQ harakatlar lentasi — nima qilgani vaqti bilan */
const timeline = async (emp, date, { all = true } = {}) => {
  const acts = await activity.forDay(emp.id, date);
  const rows = all ? acts : acts.filter((a) => activity.meta(a.action).major);

  const head =
    '📜 <b>HARAKATLAR TARIXI</b>\n' +
    `👤 <b>${ui.esc(emp.full_name)}</b>\n` +
    `📅 <i>${time.prettyDate(date)}</i>\n\n`;

  if (!rows.length) {
    return `${head}<i>Bu kuni hodim botga umuman kirmagan.</i>`;
  }

  const MAX = 60;
  const shown = rows.slice(-MAX);
  const lines = shown.map((a) => {
    const m = activity.meta(a.action);
    const what = a.title ? `: ${ui.esc(a.title)}` : '';
    const extra = a.detail ? ` <i>${ui.esc(a.detail)}</i>` : '';
    return `<code>${time.clock(a.created_at)}</code> ${m.icon} ${ui.esc(m.label)}${what}${extra}`;
  });

  return (
    head +
    (rows.length > MAX ? `<i>(oxirgi ${MAX} tasi, jami ${rows.length})</i>\n\n` : '') +
    lines.join('\n')
  );
};

/**
 * DAVR HISOBOTI — 7 / 30 kunlik. Kun-kun jadval + xulosa.
 */
const rangeReport = async (emp, days = 7) => {
  const to = time.today();
  const from = time.addDays(to, -(days - 1));

  const attRows = await attendance.range(emp.id, from, to);
  const attByDate = new Map(attRows.map((r) => [r.work_date, r]));
  const doneRows = await missions.doneBetween(emp.id, from, to);
  const actCounts = await activity.countsByDay(emp.id, from, to);

  const doneByDate = new Map();
  doneRows.forEach((m) => {
    const d = String(m.done_at).slice(0, 10);
    doneByDate.set(d, (doneByDate.get(d) || 0) + 1);
  });

  const UZ_SHORT = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
  const table = [];
  let workedDays = 0;
  let totalMinutes = 0;
  let lateDays = 0;
  const arrivals = [];

  for (let i = 0; i < days; i += 1) {
    const d = time.addDays(from, i);
    const att = attByDate.get(d);
    const dt = new Date(`${d}T00:00:00`);
    const wd = UZ_SHORT[(dt.getDay() + 6) % 7];
    const label = `${wd} ${d.slice(8, 10)}.${d.slice(5, 7)}`;

    const inT = att && att.checked_in ? time.clock(att.checked_in) : '—';
    const outT = att && att.checked_out ? time.clock(att.checked_out) : '—';
    const mins = attendance.workedMinutes(att);
    const dur = mins === null ? '—' : `${Math.floor(mins / 60)}s${String(mins % 60).padStart(2, '0')}`;
    const dn = doneByDate.get(d) || 0;

    if (att && att.checked_in) {
      workedDays += 1;
      arrivals.push(toMinutes(time.clock(att.checked_in)));
      if (isLate(att.checked_in)) lateDays += 1;
    }
    if (mins !== null) totalMinutes += mins;

    table.push(
      `${label.padEnd(9)}${inT.padStart(5)}  ${outT.padStart(5)}  ${dur.padStart(6)}  ${String(dn).padStart(2)}`,
    );
  }

  const avgArrival = arrivals.length
    ? fromMinutes(arrivals.reduce((a, b) => a + b, 0) / arrivals.length)
    : '—';

  const open = await missions.openFor(emp.id);
  const overdue = open.filter((m) => m.due_date < to).length;
  const inRange = await missions.forRange(emp.id, from, to);
  const createdInRange = inRange.filter((m) => {
    const c = String(m.created_at).slice(0, 10);
    return c >= from && c <= to;
  }).length;

  let totalActs = 0;
  actCounts.forEach((v) => {
    totalActs += v;
  });
  const activeDays = [...actCounts.values()].filter((v) => v > 0).length;

  const doneTotal = doneRows.length;
  const rate = createdInRange ? Math.round((doneTotal / createdInRange) * 100) : null;

  return (
    `📊 <b>${days} KUNLIK HISOBOT</b>\n` +
    `👤 <b>${ui.esc(emp.full_name)}</b>${emp.position ? ` · <i>${ui.esc(emp.position)}</i>` : ''}\n` +
    `📅 <i>${time.prettyDate(from)} — ${time.prettyDate(to)}</i>\n\n` +
    '<pre>Kun      Keldi  Ketdi    Soat   ✅\n' +
    `${'-'.repeat(33)}\n` +
    `${table.join('\n')}</pre>\n` +
    '📌 <b>XULOSA</b>\n' +
    `   🟢 Ishga kelgan kunlar: <b>${workedDays} / ${days}</b>\n` +
    `   ⏱ Jami ishlagan: <b>${attendance.prettyDuration(totalMinutes)}</b>\n` +
    `   🕘 O'rtacha kelish vaqti: <b>${avgArrival}</b>\n` +
    `   ⚠️ Kech kelgan kunlar: <b>${lateDays}</b>\n` +
    `   ✅ Bajargan missiyalari: <b>${doneTotal}</b>\n` +
    `   📝 Yozib qo'ygan missiyalari: <b>${createdInRange}</b>` +
    (rate !== null ? ` <i>(bajarish: ${rate}%)</i>` : '') +
    '\n' +
    `   ⏳ Hozir ochiq: <b>${open.length}</b>${overdue ? ` <i>(${overdue} tasi kechikkan)</i>` : ''}\n` +
    `   👆 Botdan foydalangan kunlar: <b>${activeDays}</b> · jami <b>${totalActs}</b> harakat`
  );
};

/** Direktor uchun umumiy ko'rinish — kim qanchalik faol */
const teamOverview = async (days = 7) => {
  const to = time.today();
  const from = time.addDays(to, -(days - 1));
  const list = await employees.listActive();
  const lines = [];

  for (const emp of list) {
    const attRows = await attendance.range(emp.id, from, to);
    const worked = attRows.filter((r) => r.checked_in).length;
    let minutes = 0;
    attRows.forEach((r) => {
      const m = attendance.workedMinutes(r);
      if (m !== null) minutes += m;
    });
    const done = (await missions.doneBetween(emp.id, from, to)).length;
    const last = await activity.lastSeen(emp.id);
    const seen = last
      ? `${time.prettyDate(last.work_date)} ${time.clock(last.created_at)}`
      : "yozuv yo'q";
    lines.push(
      `👤 <b>${ui.esc(emp.full_name)}</b>${employees.isFlexible(emp) ? ' 🕊' : ''}\n` +
        `   🟢 ${worked}/${days} kun · ⏱ ${attendance.prettyDuration(minutes)} · ✅ ${done} ta\n` +
        `   👆 oxirgi faollik: <i>${ui.esc(seen)}</i>`,
    );
  }

  return (
    `🏢 <b>${COMPANY} — JAMOA FAOLLIGI</b>\n` +
    `<i>${time.prettyDate(from)} — ${time.prettyDate(to)} (${days} kun)</i>\n\n` +
    (lines.length ? lines.join('\n\n') : "<i>Hodimlar yo'q</i>")
  );
};

module.exports = { dayCard, timeline, rangeReport, teamOverview, statusLine, isLate };
