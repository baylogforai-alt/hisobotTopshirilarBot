'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const employees = require('./employees');
const tasks = require('./tasks');
const attendance = require('./attendance');
const activity = require('./activity');
const dailyReports = require('./dailyReports');

/**
 * DAVR HISOBOTI — direktor o'zi boshlanish va tugash sanasini tanlaydi.
 *
 * Bu yerda faqat HISOB-KITOB va MATN bor. Excel shu yerdagi
 * employeeStats/teamStats natijasidan foydalanadi — ya'ni ekrandagi son bilan
 * fayldagi son doim bir xil bo'ladi.
 */

const COMPANY = config.companyName.toUpperCase();
const { esc, LINE } = ui;

/** Ikki sanani tartibga soladi */
const normalize = (from, to) => {
  let a = time.isValidDate(from) ? from : time.startOfMonth(time.today());
  let b = time.isValidDate(to) ? to : time.today();
  if (a > b) [a, b] = [b, a];
  return { from: a, to: b, days: time.daysIn(a, b) };
};

/** Tayyor davrlar — tugmalar uchun */
const PRESETS = {
  today: { label: '📅 Bugun', range: () => [time.today(), time.today()] },
  yesterday: { label: '🌙 Kecha', range: () => [time.addDays(time.today(), -1), time.addDays(time.today(), -1)] },
  week: { label: '📆 Shu hafta', range: () => [time.startOfWeek(time.today()), time.today()] },
  lastweek: {
    label: "📆 O'tgan hafta",
    range: () => { const d = time.addDays(time.startOfWeek(time.today()), -1); return [time.startOfWeek(d), time.endOfWeek(d)]; },
  },
  month: { label: '🗓 Shu oy', range: () => [time.startOfMonth(time.today()), time.today()] },
  lastmonth: {
    label: "🗓 O'tgan oy",
    range: () => { const d = time.addDays(time.startOfMonth(time.today()), -1); return [time.startOfMonth(d), time.endOfMonth(d)]; },
  },
  d7: { label: '7 kun', range: () => [time.addDays(time.today(), -6), time.today()] },
  d30: { label: '30 kun', range: () => [time.addDays(time.today(), -29), time.today()] },
  d90: { label: '90 kun', range: () => [time.addDays(time.today(), -89), time.today()] },
  year: { label: '📚 Shu yil', range: () => [`${time.today().slice(0, 4)}-01-01`, time.today()] },
};

const presetRange = (key) => (PRESETS[key] ? PRESETS[key].range() : null);

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

/** Sanalar ro'yxati: from dan to gacha */
const eachDay = (from, to) => {
  const out = [];
  const n = time.daysIn(from, to);
  for (let i = 0; i < n; i += 1) out.push(time.addDays(from, i));
  return out;
};

const DAY_NOTE = {
  ontime: '', late: 'Kech keldi', absent: 'Kelmagan', excused: 'Sababli', pending: "So'rov kutilmoqda", future: '', off: 'Dam olish kuni',
};

// ---------------------------------------------------------------------------
// HISOB-KITOB
// ---------------------------------------------------------------------------

/**
 * Bitta hodimning davr bo'yicha to'liq ko'rsatkichlari.
 * Davomat holatlari attendance.stats bilan bir xil (KPI bilan mos).
 */
const employeeStats = async (emp, fromRaw, toRaw) => {
  const { from, to, days } = normalize(fromRaw, toRaw);

  const at = await attendance.stats(emp, from, to);
  const ts = await tasks.stats(emp.id, from, to);
  const doneRows = await tasks.doneBetween(emp.id, from, to);
  const createdRows = await tasks.createdBetween(emp.id, from, to);
  const reportRows = await dailyReports.range(emp.id, from, to);
  const actCounts = await activity.countsByDay(emp.id, from, to);
  const open = await tasks.openFor(emp.id);

  const groupByDay = (rows, field) => {
    const map = new Map();
    rows.forEach((r) => {
      const d = String(r[field]).slice(0, 10);
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(r);
    });
    return map;
  };
  const doneByDate = groupByDay(doneRows, 'done_at');
  const createdByDate = groupByDay(createdRows, 'created_at');
  const reportByDate = new Map(reportRows.map((r) => [r.work_date, r]));

  const dayRows = [];
  let workedDays = 0, totalMinutes = 0, noCheckout = 0;
  const arrivals = [];

  for (const day of at.days) {
    const d = day.date;
    const att = day.row;
    const mins = attendance.workedMinutes(att);
    const came = Boolean(att && att.checked_in);
    const late = day.status === 'late';
    if (came) {
      workedDays += 1;
      const m = time.minutesOfDay(att.checked_in);
      if (m !== null) arrivals.push(m);
      if (!att.checked_out) noCheckout += 1;
    }
    if (mins !== null) totalMinutes += mins;

    let note = DAY_NOTE[day.status] || '';
    if (!came && employees.isFlexible(emp) && day.status !== 'off') note = 'Erkin jadval';
    else if (!came && att && att.intent === 'no' && day.status === 'absent') note = 'Kelmasligini bildirgan';
    else if (came && !att.checked_out) note = 'Ketishni belgilamagan';
    if (day.status === 'excused' && att && att.excuse_reason) note = `Sababli: ${att.excuse_reason}`;

    dayRows.push({
      date: d, status: day.status,
      in: came ? time.clock(att.checked_in) : null,
      out: att && att.checked_out ? time.clock(att.checked_out) : null,
      minutes: mins, late, lateMinutes: late ? Number(att.late_minutes) || 0 : 0,
      done: doneByDate.get(d) || [], created: createdByDate.get(d) || [],
      report: reportByDate.get(d) || null,
      acts: actCounts.get(d) || 0, note,
    });
  }

  let totalActs = 0;
  actCounts.forEach((v) => { totalActs += v; });

  return {
    emp, from, to, days, dayRows, doneRows, createdRows, reportRows, open,
    overdue: open.filter((t) => t.due_date < time.today()),
    workDays: at.workDays, workedDays, absentDays: at.absent, lateDays: at.late, excusedDays: at.excused, noCheckout,
    attPct: at.pct, lateMinutes: at.lateMinutes,
    totalMinutes,
    avgMinutes: workedDays ? Math.round(totalMinutes / workedDays) : null,
    avgArrival: arrivals.length ? time.hhmm(arrivals.reduce((a, b) => a + b, 0) / arrivals.length) : '—',
    doneCount: doneRows.length, createdCount: createdRows.length,
    ts, tasksPct: ts.pct,
    rate: pct(doneRows.length, createdRows.length),
    reportDays: reportRows.length,
    activeDays: [...actCounts.values()].filter((v) => v > 0).length, totalActs,
  };
};

/** Butun jamoa — har bir faol hodim uchun employeeStats */
const teamStats = async (fromRaw, toRaw) => {
  const { from, to, days } = normalize(fromRaw, toRaw);
  const list = await employees.listActive();
  const rows = [];
  for (const emp of list) rows.push(await employeeStats(emp, from, to));

  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const totals = {
    employees: rows.length,
    workedDays: sum((r) => r.workedDays), possibleDays: sum((r) => r.workDays),
    absentDays: sum((r) => r.absentDays), lateDays: sum((r) => r.lateDays), excusedDays: sum((r) => r.excusedDays),
    totalMinutes: sum((r) => r.totalMinutes),
    doneCount: sum((r) => r.doneCount), createdCount: sum((r) => r.createdCount),
    openCount: sum((r) => r.open.length), overdueCount: sum((r) => r.overdue.length),
    reportDays: sum((r) => r.reportDays),
  };
  totals.rate = pct(totals.doneCount, totals.createdCount);
  return { from, to, days, rows, totals };
};

/** Oldingi shuncha kunlik davr bilan solishtirish uchun faqat "bajarildi" soni */
const previousDone = async (from, to) => {
  const days = time.daysIn(from, to);
  const prevTo = time.addDays(from, -1);
  const prevFrom = time.addDays(prevTo, -(days - 1));
  let total = 0;
  for (const emp of await employees.listActive()) total += (await tasks.doneBetween(emp.id, prevFrom, prevTo)).length;
  return { from: prevFrom, to: prevTo, done: total };
};

/** '📈 +12%' / '📉 −8%' / "= o'zgarishsiz" */
const trend = (current, previous) => {
  if (!previous) return current ? '🆕 yangi' : '—';
  const diff = Math.round(((current - previous) / previous) * 100);
  if (diff === 0) return "= o'zgarishsiz";
  return diff > 0 ? `📈 +${diff}%` : `📉 ${diff}%`;
};

// ---------------------------------------------------------------------------
// MATNLAR
// ---------------------------------------------------------------------------

const header = (title, from, to) =>
  `📈 <b>${title}</b>\n🗓 <i>${time.prettyRange(from, to)}</i> · <b>${time.daysIn(from, to)} kun</b>\n${LINE}\n`;

/** Kunlar jadvali (<pre> ichida — Telegramda tekis ustun bo'lib turadi) */
const dayTable = (stats, limit = 31) => {
  const rows = stats.dayRows;
  const shown = rows.length > limit ? rows.slice(-limit) : rows;
  const lines = shown.map((r) => {
    const label = `${time.weekdayShort(r.date)} ${time.shortDate(r.date)}`;
    const dur = r.minutes === null ? '—' : `${Math.floor(r.minutes / 60)}s${String(r.minutes % 60).padStart(2, '0')}`;
    const mark = r.late ? '!' : r.status === 'excused' ? 's' : ' ';
    return `${label.padEnd(9)}${(r.in || '—').padStart(5)}${mark} ${(r.out || '—').padStart(5)} ${dur.padStart(6)} ${String(r.done.length).padStart(2)} ${r.report ? '📝' : '  '}`;
  });
  return (
    `📅 <b>KUNLAR</b>${rows.length > limit ? ` <i>(oxirgi ${limit} kun)</i>` : ''}\n` +
    `<pre>Kun      Keldi  Ketdi   Soat  ✅ 📝\n${'-'.repeat(37)}\n${lines.join('\n')}</pre>` +
    `\n<i>! — kech kelgan · s — sababli · 📝 — hisobot topshirgan</i>`
  );
};

/** Bitta hodimning davr hisoboti — direktor ekranda ko'radigan matn */
const employeeReport = async (emp, from, to, { maxItems = 20 } = {}) => {
  const s = await employeeStats(emp, from, to);
  const out = [];
  out.push(header('DAVR HISOBOTI', s.from, s.to));
  out.push(`👤 <b>${esc(emp.full_name)}</b>${emp.position ? ` · <i>${esc(emp.position)}</i>` : ''}${emp.department_name ? ` · ${esc(emp.department_name)}` : ''}${employees.isFlexible(emp) ? ' 🕊' : ''}`);
  out.push('');
  out.push('📌 <b>XULOSA</b>');
  out.push(`   🟢 Ishga kelgan: <b>${s.workedDays} / ${s.workDays}</b> ish kuni` + (s.absentDays ? ` · 🔴 kelmagan: <b>${s.absentDays}</b>` : '') + (s.excusedDays ? ` · 📄 sababli: <b>${s.excusedDays}</b>` : ''));
  out.push(`   🕘 Davomat: ${ui.pctBar(s.attPct)}`);
  out.push(`   ⏱ Jami ish vaqti: <b>${time.prettyDuration(s.totalMinutes)}</b>` + (s.avgMinutes ? ` · o'rtacha <b>${time.prettyDuration(s.avgMinutes)}</b>` : ''));
  out.push(`   🕘 O'rtacha kelish: <b>${s.avgArrival}</b>` + (s.lateDays ? ` · ⚠️ kech kelgan: <b>${s.lateDays}</b> kun (${time.prettyDuration(s.lateMinutes)})` : ''));
  out.push(`   ✅ Bajargan ishlari: <b>${s.doneCount}</b>   📝 Yozib qo'ygani: <b>${s.createdCount}</b>` + (s.rate !== null ? `\n   🎯 Bajarish darajasi: <b>${s.rate}%</b>` : ''));
  out.push(`   📋 Muddatida (KPI): ${s.ts.ontime}/${s.ts.total} — ${ui.pctBar(s.tasksPct)}${s.ts.penalty ? ` <i>(−${s.ts.penalty}% qaytarish)</i>` : ''}`);
  out.push(`   ⏳ Hozir ochiq: <b>${s.open.length}</b>` + (s.overdue.length ? ` <i>(${s.overdue.length} tasi kechikkan)</i>` : ''));
  out.push(`   📝 Kunlik hisobot topshirgan: <b>${s.reportDays}</b> kun`);
  out.push(`   👆 Bot faolligi: <b>${s.totalActs}</b> harakat · <b>${s.activeDays}</b> kun`);
  out.push('');
  out.push(dayTable(s));
  out.push('');

  out.push(`✅ <b>BAJARGAN ISHLARI (${s.doneCount})</b>`);
  if (s.doneCount) {
    s.doneRows.slice(0, maxItems).forEach((t) => {
      const d = String(t.done_at).slice(0, 10);
      out.push(`   <code>${time.shortDate(d)}</code> ${t.status === 'accepted' ? '✅' : '🕓'} ${esc(t.title)}${d > t.due_date ? ' <i>(kech)</i>' : ''}`);
    });
    if (s.doneCount > maxItems) out.push(`   <i>…yana ${s.doneCount - maxItems} ta (Excel faylda to'liq)</i>`);
  } else out.push("   <i>— bu davrda bajarilgan ish yo'q —</i>");
  out.push('');

  out.push(`⏳ <b>HOZIR ZIMMASIDA (${s.open.length})</b>`);
  if (s.open.length) {
    s.open.slice(0, maxItems).forEach((t) => {
      const late = t.due_date < time.today();
      out.push(`   ${late ? '🔴' : '🔹'} ${esc(t.title)}` + (late ? ` <i>— ${time.diffDays(t.due_date, time.today())} kun kechikdi</i>` : ` <i>(${time.prettyDate(t.due_date)} gacha)</i>`));
    });
    if (s.open.length > maxItems) out.push(`   <i>…yana ${s.open.length - maxItems} ta</i>`);
  } else out.push('   <i>— hammasi yopilgan 🎉 —</i>');

  if (s.reportRows.length) {
    out.push('', `📝 <b>KUNLIK HISOBOTLARI (${s.reportRows.length})</b>`);
    s.reportRows.slice(-7).forEach((r) => out.push(`   <code>${time.shortDate(r.work_date)}</code> ${esc(r.text).slice(0, 160).replace(/\n/g, ' ')}${r.text.length > 160 ? '…' : ''}`));
    if (s.reportRows.length > 7) out.push(`   <i>…oxirgi 7 tasi ko'rsatildi (Excel faylda to'liq)</i>`);
  }
  return out.join('\n');
};

/** Butun jamoa — bitta hisobotda hamma hodim */
const teamReport = async (from, to, { compare = true } = {}) => {
  const t = await teamStats(from, to);
  const out = [];
  out.push(header(`${COMPANY} — JAMOA HISOBOTI`, t.from, t.to));
  out.push('📊 <b>UMUMIY</b>');
  let trendText = '';
  if (compare) {
    const prev = await previousDone(t.from, t.to);
    if (prev.done) trendText = ` <i>(oldingi ${t.days} kunda: ${prev.done} — ${trend(t.totals.doneCount, prev.done)})</i>`;
  }
  out.push(`   ✅ Bajarilgan ishlar: <b>${t.totals.doneCount}</b>${trendText}`);
  out.push(`   📝 Yozib qo'yilgan: <b>${t.totals.createdCount}</b>` + (t.totals.rate !== null ? ` · 🎯 bajarish: <b>${t.totals.rate}%</b>` : ''));
  out.push(`   ⏳ Hozir ochiq: <b>${t.totals.openCount}</b>` + (t.totals.overdueCount ? ` <i>(${t.totals.overdueCount} tasi kechikkan)</i>` : ''));
  out.push(`   🟢 Davomat: <b>${t.totals.workedDays}/${t.totals.possibleDays}</b> ish kuni` + (t.totals.lateDays ? ` · ⚠️ kech: <b>${t.totals.lateDays}</b>` : '') + (t.totals.excusedDays ? ` · 📄 sababli: ${t.totals.excusedDays}` : ''));
  out.push(`   ⏱ Jami ish vaqti: <b>${time.prettyDuration(t.totals.totalMinutes)}</b>`);
  out.push(`   📝 Kunlik hisobotlar: <b>${t.totals.reportDays}</b>`);
  out.push(`   👥 Hodimlar: <b>${t.totals.employees}</b>`);
  out.push('');

  const rank = [...t.rows].sort((a, b) => b.doneCount - a.doneCount || (b.tasksPct || 0) - (a.tasksPct || 0));
  if (rank.length > 1 && rank[0].doneCount) {
    out.push('🏆 <b>REYTING</b>');
    const medals = ['🥇', '🥈', '🥉'];
    rank.slice(0, 5).forEach((r, i) => out.push(`   ${medals[i] || `${i + 1}.`} <b>${esc(r.emp.full_name)}</b> — ${r.doneCount} ta · muddatida ${r.tasksPct}% · davomat ${r.attPct}%`));
    out.push('');
  }

  out.push('👥 <b>HODIMLAR KESIMIDA</b>');
  if (!t.rows.length) out.push("   <i>Hodimlar ro'yxati bo'sh</i>");
  else {
    t.rows.forEach((r) => {
      out.push('');
      out.push(`👤 <b>${esc(r.emp.full_name)}</b>` + (r.emp.position ? ` · <i>${esc(r.emp.position)}</i>` : '') + (employees.isFlexible(r.emp) ? ' 🕊' : ''));
      out.push(`   🟢 ${r.workedDays}/${r.workDays} kun · ⏱ ${time.prettyDuration(r.totalMinutes)} · 🕘 ${r.avgArrival}${r.lateDays ? ` · ⚠️ ${r.lateDays}` : ''}${r.absentDays ? ` · 🔴 ${r.absentDays}` : ''}`);
      out.push(`   ✅ ${r.doneCount} bajardi · 📝 ${r.createdCount} yozdi` + (r.rate !== null ? ` · 🎯 ${r.rate}%` : '') + ` · 📋 ${r.tasksPct}%` + (r.open.length ? ` · ⏳ ${r.open.length}` : '') + (r.overdue.length ? ` 🔴 ${r.overdue.length}` : '') + ` · 📝 hisobot ${r.reportDays}`);
    });
  }
  return out.join('\n');
};

module.exports = {
  PRESETS, presetRange, normalize, eachDay, employeeStats, teamStats, previousDone, trend, employeeReport, teamReport, dayTable, pct,
};
