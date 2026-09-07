'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const employees = require('./employees');
const missions = require('./missions');
const attendance = require('./attendance');
const activity = require('./activity');
const history = require('./history');

/**
 * DAVR HISOBOTI — direktor o'zi boshlanish va tugash sanasini tanlaydi.
 *
 * Bu yerda faqat HISOB-KITOB va MATN bor. Excel shu yerdagi
 * employeeStats/teamStats natijasidan foydalanadi — ya'ni ekrandagi son bilan
 * fayldagi son doim bir xil bo'ladi.
 */

const COMPANY = config.companyName.toUpperCase();
const LINE = '━━━━━━━━━━━━━━━━━━';

/** Ikki sanani tartibga soladi va bugundan keyingi chegarani kesadi */
const normalize = (from, to) => {
  let a = time.isValidDate(from) ? from : time.startOfMonth(time.today());
  let b = time.isValidDate(to) ? to : time.today();
  if (a > b) [a, b] = [b, a];
  return { from: a, to: b, days: time.daysIn(a, b) };
};

/** Tayyor davrlar — tugmalar uchun */
const PRESETS = {
  today: { label: '📅 Bugun', range: () => [time.today(), time.today()] },
  yesterday: {
    label: '🌙 Kecha',
    range: () => [time.addDays(time.today(), -1), time.addDays(time.today(), -1)],
  },
  week: { label: '📆 Shu hafta', range: () => [time.startOfWeek(time.today()), time.today()] },
  lastweek: {
    label: '📆 O\'tgan hafta',
    range: () => {
      const d = time.addDays(time.startOfWeek(time.today()), -1);
      return [time.startOfWeek(d), time.endOfWeek(d)];
    },
  },
  month: { label: '🗓 Shu oy', range: () => [time.startOfMonth(time.today()), time.today()] },
  lastmonth: {
    label: '🗓 O\'tgan oy',
    range: () => {
      const d = time.addDays(time.startOfMonth(time.today()), -1);
      return [time.startOfMonth(d), time.endOfMonth(d)];
    },
  },
  d7: { label: '7 kun', range: () => [time.addDays(time.today(), -6), time.today()] },
  d30: { label: '30 kun', range: () => [time.addDays(time.today(), -29), time.today()] },
  d90: { label: '90 kun', range: () => [time.addDays(time.today(), -89), time.today()] },
  year: { label: '📚 Shu yil', range: () => [`${time.today().slice(0, 4)}-01-01`, time.today()] },
};

const presetRange = (key) => (PRESETS[key] ? PRESETS[key].range() : null);

const hhmm = (mins) => {
  if (mins === null || mins === undefined) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

/** Sanalar ro'yxati: from dan to gacha */
const eachDay = (from, to) => {
  const out = [];
  const n = time.daysIn(from, to);
  for (let i = 0; i < n; i += 1) out.push(time.addDays(from, i));
  return out;
};

// ---------------------------------------------------------------------------
// HISOB-KITOB
// ---------------------------------------------------------------------------

/**
 * Bitta hodimning davr bo'yicha to'liq ko'rsatkichlari.
 * Kunlar soni qancha bo'lishidan qat'i nazar — bazaga 5 ta so'rov.
 */
const employeeStats = async (emp, fromRaw, toRaw) => {
  const { from, to, days } = normalize(fromRaw, toRaw);

  const attRows = await attendance.range(emp.id, from, to);
  const attByDate = new Map(attRows.map((r) => [r.work_date, r]));
  const doneRows = await missions.doneBetween(emp.id, from, to);
  const createdRows = await missions.createdBetween(emp.id, from, to);
  const actCounts = await activity.countsByDay(emp.id, from, to);
  const open = await missions.openFor(emp.id);

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

  const dayRows = [];
  let workedDays = 0;
  let totalMinutes = 0;
  let lateDays = 0;
  let absentDays = 0;
  let noCheckout = 0;
  const arrivals = [];

  for (const d of eachDay(from, to)) {
    const att = attByDate.get(d);
    const mins = attendance.workedMinutes(att);
    const came = Boolean(att && att.checked_in);
    const late = came && history.isLate(att.checked_in);

    if (came) {
      workedDays += 1;
      const [h, m] = time.clock(att.checked_in).split(':').map(Number);
      arrivals.push(h * 60 + m);
      if (late) lateDays += 1;
      if (!att.checked_out) noCheckout += 1;
    } else if (!time.isSunday(d) && !employees.isFlexible(emp)) {
      absentDays += 1;
    }
    if (mins !== null) totalMinutes += mins;

    let note = '';
    if (!came) {
      if (employees.isFlexible(emp)) note = 'Erkin jadval';
      else if (att && att.intent === 'no') note = 'Kelmasligini bildirgan';
      else if (time.isSunday(d)) note = 'Dam olish kuni';
      else note = 'Kelmagan';
    } else if (!att.checked_out) note = 'Ketishni belgilamagan';
    else if (late) note = 'Kech keldi';

    dayRows.push({
      date: d,
      in: came ? time.clock(att.checked_in) : null,
      out: att && att.checked_out ? time.clock(att.checked_out) : null,
      minutes: mins,
      late,
      done: doneByDate.get(d) || [],
      created: createdByDate.get(d) || [],
      acts: actCounts.get(d) || 0,
      note,
    });
  }

  let totalActs = 0;
  actCounts.forEach((v) => {
    totalActs += v;
  });

  const overdue = open.filter((m) => m.due_date < time.today());

  return {
    emp,
    from,
    to,
    days,
    dayRows,
    doneRows,
    createdRows,
    open,
    overdue,
    workedDays,
    absentDays,
    lateDays,
    noCheckout,
    totalMinutes,
    avgMinutes: workedDays ? Math.round(totalMinutes / workedDays) : null,
    avgArrival: arrivals.length
      ? hhmm(arrivals.reduce((a, b) => a + b, 0) / arrivals.length)
      : '—',
    doneCount: doneRows.length,
    createdCount: createdRows.length,
    rate: pct(doneRows.length, createdRows.length),
    activeDays: [...actCounts.values()].filter((v) => v > 0).length,
    totalActs,
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
    workedDays: sum((r) => r.workedDays),
    possibleDays: rows.length * days,
    absentDays: sum((r) => r.absentDays),
    lateDays: sum((r) => r.lateDays),
    totalMinutes: sum((r) => r.totalMinutes),
    doneCount: sum((r) => r.doneCount),
    createdCount: sum((r) => r.createdCount),
    openCount: sum((r) => r.open.length),
    overdueCount: sum((r) => r.overdue.length),
  };
  totals.rate = pct(totals.doneCount, totals.createdCount);

  return { from, to, days, rows, totals };
};

/** Oldingi shuncha kunlik davr bilan solishtirish uchun faqat "bajarildi" soni */
const previousDone = async (from, to) => {
  const days = time.daysIn(from, to);
  const prevTo = time.addDays(from, -1);
  const prevFrom = time.addDays(prevTo, -(days - 1));
  const list = await employees.listActive();
  let total = 0;
  for (const emp of list) total += (await missions.doneBetween(emp.id, prevFrom, prevTo)).length;
  return { from: prevFrom, to: prevTo, done: total };
};

/** '↑ 12%' / '↓ 8%' / '= o'zgarishsiz' */
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
    const mark = r.in ? (r.late ? '!' : ' ') : ' ';
    return `${label.padEnd(9)}${(r.in || '—').padStart(5)}${mark} ${(r.out || '—').padStart(5)} ${dur.padStart(6)} ${String(r.done.length).padStart(2)}`;
  });
  const anyLate = shown.some((r) => r.late);
  return (
    `📅 <b>KUNLAR</b>${rows.length > limit ? ` <i>(oxirgi ${limit} kun)</i>` : ''}\n` +
    `<pre>Kun      Keldi  Ketdi   Soat  ✅\n${'-'.repeat(34)}\n${lines.join('\n')}</pre>` +
    (anyLate ? "\n<i>! — kech kelgan kun</i>" : '')
  );
};

/** Bitta hodimning davr hisoboti — direktor ekranda ko'radigan matn */
const employeeReport = async (emp, from, to, { maxItems = 20 } = {}) => {
  const s = await employeeStats(emp, from, to);

  const out = [];
  out.push(header('DAVR HISOBOTI', s.from, s.to));
  out.push(
    `👤 <b>${ui.esc(emp.full_name)}</b>${emp.position ? ` · <i>${ui.esc(emp.position)}</i>` : ''}` +
      (employees.isFlexible(emp) ? ' 🕊' : ''),
  );
  out.push('');

  out.push('📌 <b>XULOSA</b>');
  out.push(`   🟢 Ishga kelgan: <b>${s.workedDays} / ${s.days}</b> kun` +
    (s.absentDays ? ` · 🚫 kelmagan: <b>${s.absentDays}</b>` : ''));
  out.push(`   ⏱ Jami ish vaqti: <b>${attendance.prettyDuration(s.totalMinutes)}</b>` +
    (s.avgMinutes ? ` · o'rtacha <b>${attendance.prettyDuration(s.avgMinutes)}</b>` : ''));
  out.push(`   🕘 O'rtacha kelish: <b>${s.avgArrival}</b>` +
    (s.lateDays ? ` · ⚠️ kech kelgan: <b>${s.lateDays}</b> kun` : ''));
  out.push(`   ✅ Bajargan ishlari: <b>${s.doneCount}</b>` +
    `   📝 Yozib qo'ygani: <b>${s.createdCount}</b>` +
    (s.rate !== null ? `\n   🎯 Bajarish darajasi: <b>${s.rate}%</b>` : ''));
  out.push(`   ⏳ Hozir ochiq: <b>${s.open.length}</b>` +
    (s.overdue.length ? ` <i>(${s.overdue.length} tasi kechikkan)</i>` : ''));
  out.push(`   👆 Bot faolligi: <b>${s.totalActs}</b> harakat · <b>${s.activeDays}</b> kun`);
  out.push('');

  out.push(dayTable(s));
  out.push('');

  // Bajarganlari — kun bo'yicha
  out.push(`✅ <b>BAJARGAN ISHLARI (${s.doneCount})</b>`);
  if (s.doneCount) {
    const list = s.doneRows.slice(0, maxItems);
    list.forEach((m) => {
      const d = String(m.done_at).slice(0, 10);
      out.push(`   <code>${time.shortDate(d)}</code> ✅ ${ui.esc(m.title)}`);
    });
    if (s.doneCount > maxItems) out.push(`   <i>…yana ${s.doneCount - maxItems} ta (Excel faylda to'liq)</i>`);
  } else {
    out.push('   <i>— bu davrda bajarilgan ish yo\'q —</i>');
  }
  out.push('');

  // Hozir zimmasida turgan ishlar
  out.push(`⏳ <b>HOZIR ZIMMASIDA (${s.open.length})</b>`);
  if (s.open.length) {
    s.open.slice(0, maxItems).forEach((m) => {
      const late = m.due_date < time.today();
      out.push(
        `   ${late ? '🔴' : '🔹'} ${ui.esc(m.title)}` +
          (late
            ? ` <i>— ${time.diffDays(m.due_date, time.today())} kun kechikdi</i>`
            : ` <i>(${time.prettyDate(m.due_date)} gacha)</i>`),
      );
    });
    if (s.open.length > maxItems) out.push(`   <i>…yana ${s.open.length - maxItems} ta</i>`);
  } else {
    out.push('   <i>— hammasi yopilgan 🎉 —</i>');
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
    if (prev.done) {
      trendText = ` <i>(oldingi ${t.days} kunda: ${prev.done} — ${trend(t.totals.doneCount, prev.done)})</i>`;
    }
  }
  out.push(`   ✅ Bajarilgan ishlar: <b>${t.totals.doneCount}</b>${trendText}`);
  out.push(`   📝 Yozib qo'yilgan: <b>${t.totals.createdCount}</b>` +
    (t.totals.rate !== null ? ` · 🎯 bajarish: <b>${t.totals.rate}%</b>` : ''));
  out.push(`   ⏳ Hozir ochiq: <b>${t.totals.openCount}</b>` +
    (t.totals.overdueCount ? ` <i>(${t.totals.overdueCount} tasi kechikkan)</i>` : ''));
  out.push(`   🟢 Davomat: <b>${t.totals.workedDays}/${t.totals.possibleDays}</b> kun` +
    (t.totals.lateDays ? ` · ⚠️ kech: <b>${t.totals.lateDays}</b>` : ''));
  out.push(`   ⏱ Jami ish vaqti: <b>${attendance.prettyDuration(t.totals.totalMinutes)}</b>`);
  out.push(`   👥 Hodimlar: <b>${t.totals.employees}</b>`);
  out.push('');

  // Reyting — kim ko'p ish bajardi
  const rank = [...t.rows].sort((a, b) => b.doneCount - a.doneCount || (b.rate || 0) - (a.rate || 0));
  if (rank.length > 1 && rank[0].doneCount) {
    out.push('🏆 <b>REYTING</b>');
    const medals = ['🥇', '🥈', '🥉'];
    rank.slice(0, 5).forEach((r, i) => {
      out.push(
        `   ${medals[i] || `${i + 1}.`} <b>${ui.esc(r.emp.full_name)}</b> — ` +
          `${r.doneCount} ta${r.rate !== null ? ` · ${r.rate}%` : ''}`,
      );
    });
    out.push('');
  }

  out.push('👥 <b>HODIMLAR KESIMIDA</b>');
  if (!t.rows.length) {
    out.push("   <i>Hodimlar ro'yxati bo'sh</i>");
  } else {
    t.rows.forEach((r) => {
      out.push('');
      out.push(
        `👤 <b>${ui.esc(r.emp.full_name)}</b>` +
          (r.emp.position ? ` · <i>${ui.esc(r.emp.position)}</i>` : '') +
          (employees.isFlexible(r.emp) ? ' 🕊' : ''),
      );
      out.push(
        `   🟢 ${r.workedDays}/${r.days} kun · ⏱ ${attendance.prettyDuration(r.totalMinutes)}` +
          ` · 🕘 ${r.avgArrival}${r.lateDays ? ` · ⚠️ ${r.lateDays}` : ''}`,
      );
      out.push(
        `   ✅ ${r.doneCount} bajardi · 📝 ${r.createdCount} yozdi` +
          (r.rate !== null ? ` · 🎯 ${r.rate}%` : '') +
          (r.open.length ? ` · ⏳ ${r.open.length}` : '') +
          (r.overdue.length ? ` 🔴 ${r.overdue.length}` : ''),
      );
    });
  }

  return out.join('\n');
};

/** Telegram chegarasiga (4096) sig'adigan bo'laklarga bo'ladi — <pre> buzilmaydi */
const splitText = (text, limit = 3800) => {
  if (text.length <= limit) return [text];
  const parts = [];
  let buf = '';
  let open = 0;
  for (const line of text.split('\n')) {
    open += (line.match(/<pre>/g) || []).length;
    open -= (line.match(/<\/pre>/g) || []).length;
    if (buf.length + line.length + 1 > limit && open === 0 && buf) {
      parts.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) parts.push(buf);
  return parts;
};

module.exports = {
  PRESETS, presetRange, normalize, eachDay, splitText,
  employeeStats, teamStats, previousDone, trend,
  employeeReport, teamReport, dayTable, hhmm, pct,
};
