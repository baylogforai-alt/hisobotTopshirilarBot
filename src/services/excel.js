'use strict';

const ExcelJS = require('exceljs');
const config = require('../config');
const time = require('../time');
const missions = require('./missions');

/** Missiya holatiga o'qiladigan yorliq beradi */
const statusLabel = (row, today) => {
  if (row.status === 'done') return 'Bajarildi';
  if (row.status === 'active' && row.due_date < today) return 'Kechikkan';
  if (row.status === 'active') return 'Bajarilmadi';
  return row.status || '';
};

/**
 * Berilgan kun uchun Excel (.xlsx) hisobotini tayyorlaydi.
 * employeeId berilsa — faqat o'sha hodim, aks holda butun jamoa.
 * Natija: { buffer, filename }.
 */
const buildDayReport = async (date = time.today(), { employeeId = null, scopeName = null } = {}) => {
  const rows = await missions.dayRows(date, employeeId);

  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  wb.created = new Date(`${date}T00:00:00`);

  const ws = wb.addWorksheet('Hisobot', {
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  ws.columns = [
    { key: 'name', width: 22 },
    { key: 'position', width: 18 },
    { key: 'title', width: 50 },
    { key: 'status', width: 15 },
    { key: 'due', width: 14 },
    { key: 'done', width: 12 },
  ];

  // Sarlavha
  ws.mergeCells('A1:F1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `${config.companyName} — Kunlik hisobot`;
  titleCell.font = { bold: true, size: 15, color: { argb: 'FF14213A' } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  ws.mergeCells('A2:F2');
  const subCell = ws.getCell('A2');
  subCell.value = `${time.prettyDate(date)}${scopeName ? ` · ${scopeName}` : ''}`;
  subCell.font = { italic: true, size: 11, color: { argb: 'FF55697A' } };

  // Ustun sarlavhalari
  const head = ws.getRow(3);
  head.values = ['Hodim', 'Lavozim', 'Missiya', 'Holat', 'Muddat', 'Bajarilgan'];
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14646B' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB9702A' } } };
  });

  const today = time.today();
  const statusColor = { Bajarildi: 'FF1B7F4B', Kechikkan: 'FFA83D3D', Bajarilmadi: 'FF96591F' };

  let count = 0;
  let lastName = null;
  for (const r of rows) {
    if (!r.title) {
      // Missiyasi yo'q hodim
      const row = ws.addRow([r.full_name, r.position || '', '— missiya yo\'q —', '', '', '']);
      row.getCell(3).font = { italic: true, color: { argb: 'FF9AA6B2' } };
      lastName = r.full_name;
      continue;
    }
    count += 1;
    const label = statusLabel(r, today);
    // Bir hodim ketma-ket qatorlarda faqat birinchisida ism ko'rinsin
    const nameCell = r.full_name === lastName ? '' : r.full_name;
    const posCell = r.full_name === lastName ? '' : r.position || '';
    lastName = r.full_name;

    const row = ws.addRow([
      nameCell,
      posCell,
      r.title,
      label,
      time.prettyDate(r.due_date),
      r.status === 'done' ? time.clock(r.done_at) : '',
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    const statusCellObj = row.getCell(4);
    statusCellObj.font = { bold: true, color: { argb: statusColor[label] || 'FF2C3B57' } };
    if (nameCell) row.getCell(1).font = { bold: true };
  }

  if (!count && !rows.length) {
    ws.addRow(['Hodimlar yo\'q', '', '', '', '', '']);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const scopeSlug = employeeId ? 'hodim' : 'jamoa';
  const filename = `hisobot-${scopeSlug}-${date}.xlsx`;
  return { buffer, filename };
};

// ---------------------------------------------------------------------------
// DAVR HISOBOTI (ko'p varaqli) — direktor tanlagan sana oralig'i uchun
// ---------------------------------------------------------------------------

const HEAD_BG = 'FF14646B';
const TITLE_COLOR = 'FF14213A';
const ZEBRA_BG = 'FFF3F7F8';

const STATUS_COLOR = {
  Bajarildi: 'FF1B7F4B',
  Kechikkan: 'FFA83D3D',
  Bajarilmadi: 'FF96591F',
  "O'chirilgan": 'FF9AA6B2',
  Kutmoqda: 'FF2C3B57',
};

/** 1 → 'A', 27 → 'AA' */
const colLetter = (n) => {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
};

/** Missiya holatining o'zbekcha nomi */
const missionLabel = (m, today = time.today()) => {
  if (m.status === 'done') return 'Bajarildi';
  if (m.status === 'cancelled') return "O'chirilgan";
  if (m.status === 'active' && m.due_date < today) return 'Kechikkan';
  if (m.status === 'active') return 'Bajarilmadi';
  return 'Kutmoqda';
};

/** Varaqqa sarlavha + ustun nomlarini qo'yadi (filtr va muzlatilgan sarlavha bilan) */
const decorate = (ws, cols, titleText, subText) => {
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  const last = colLetter(cols.length);

  ws.mergeCells(`A1:${last}1`);
  const t = ws.getCell('A1');
  t.value = titleText;
  t.font = { bold: true, size: 15, color: { argb: TITLE_COLOR } };
  t.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  ws.mergeCells(`A2:${last}2`);
  const s = ws.getCell('A2');
  s.value = subText;
  s.font = { italic: true, size: 11, color: { argb: 'FF55697A' } };

  const head = ws.getRow(3);
  head.values = cols.map((c) => c.header);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 22;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB9702A' } } };
  });

  ws.views = [{ state: 'frozen', ySplit: 3 }];
  ws.autoFilter = { from: `A3`, to: `${last}3` };
};

/** Har ikkinchi qatorni ochroq rangga bo'yaydi — o'qish oson bo'lsin */
const zebra = (ws, startRow = 4) => {
  for (let i = startRow; i <= ws.rowCount; i += 1) {
    if ((i - startRow) % 2 === 1) {
      ws.getRow(i).eachCell({ includeEmpty: true }, (cell) => {
        if (!cell.fill || cell.fill.type !== 'pattern') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_BG } };
        }
      });
    }
  }
};

const hours = (minutes) => (minutes === null || minutes === undefined ? null : Math.round((minutes / 60) * 100) / 100);

/**
 * BITTA HODIM — tanlangan davr uchun to'liq arxiv (4 varaq):
 *   1. Xulosa      — bir qarashda hamma raqam
 *   2. Kunlar      — kun-kun: keldi/ketdi/soat/bajardi/yozdi
 *   3. Missiyalar  — har bir ish: holati, muddati, bajarilgan vaqti
 *   4. Harakatlar  — botdagi har bir amal (vaqti bilan)
 */
const buildEmployeePeriod = async (emp, fromRaw, toRaw) => {
  const period = require('./period');
  const attendance = require('./attendance');
  const activity = require('./activity');

  const { from, to } = period.normalize(fromRaw, toRaw);
  const s = await period.employeeStats(emp, from, to);

  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  wb.created = new Date();

  const who = `${emp.full_name}${emp.position ? ` · ${emp.position}` : ''}`;
  const periodText = `${time.prettyDate(from)} — ${time.prettyDate(to)} (${s.days} kun)`;

  // ---------------- 1) Xulosa ----------------
  const wsSum = wb.addWorksheet('Xulosa');
  decorate(
    wsSum,
    [
      { key: 'k', header: "Ko'rsatkich", width: 34 },
      { key: 'v', header: 'Qiymat', width: 30 },
    ],
    `${config.companyName} — hodim hisoboti`,
    `${who} · ${periodText}`,
  );
  const facts = [
    ['Davr', periodText],
    ['Ish kunlari (davrdagi jami kun)', s.days],
    ['Ishga kelgan kunlar', s.workedDays],
    ['Kelmagan kunlar (yakshanbadan tashqari)', s.absentDays],
    ['Kech kelgan kunlar', s.lateDays],
    ['Ketishni belgilamagan kunlar', s.noCheckout],
    ['Jami ish vaqti', attendance.prettyDuration(s.totalMinutes)],
    ['Jami ish soati (raqam)', hours(s.totalMinutes)],
    ['Kunlik o\'rtacha ish vaqti', s.avgMinutes === null ? '—' : attendance.prettyDuration(s.avgMinutes)],
    ['O\'rtacha kelish vaqti', s.avgArrival],
    ['Bajargan missiyalari', s.doneCount],
    ['Yozib qo\'ygan missiyalari', s.createdCount],
    ['Bajarish darajasi', s.rate === null ? '—' : `${s.rate}%`],
    ['Hozir ochiq missiyalari', s.open.length],
    ['Ulardan kechikkani', s.overdue.length],
    ['Botdan foydalangan kunlar', s.activeDays],
    ['Jami bot harakatlari', s.totalActs],
  ];
  facts.forEach(([k, v]) => {
    const row = wsSum.addRow([k, v]);
    row.getCell(1).font = { bold: true, color: { argb: 'FF2C3B57' } };
  });
  zebra(wsSum);

  // ---------------- 2) Kunlar ----------------
  const wsDays = wb.addWorksheet('Kunlar');
  decorate(
    wsDays,
    [
      { key: 'date', header: 'Sana', width: 13 },
      { key: 'wd', header: 'Kun', width: 8 },
      { key: 'in', header: 'Keldi', width: 9 },
      { key: 'out', header: 'Ketdi', width: 9 },
      { key: 'h', header: 'Ish soati', width: 11 },
      { key: 'dur', header: 'Davomiylik', width: 17 },
      { key: 'done', header: 'Bajardi', width: 9 },
      { key: 'added', header: "Yozib qo'ydi", width: 13 },
      { key: 'acts', header: 'Bot harakatlari', width: 15 },
      { key: 'note', header: 'Izoh', width: 24 },
    ],
    `${config.companyName} — kun-kun faoliyat`,
    `${who} · ${periodText}`,
  );

  s.dayRows.forEach((d) => {
    const row = wsDays.addRow([
      d.date,
      time.weekdayShort(d.date),
      d.in || '—',
      d.out || '—',
      hours(d.minutes),
      d.minutes === null ? '—' : attendance.prettyDuration(d.minutes),
      d.done.length,
      d.created.length,
      d.acts,
      d.note,
    ]);
    row.getCell(5).numFmt = '0.00';
    if (d.in) row.getCell(3).font = { bold: true, color: { argb: d.late ? 'FFA83D3D' : 'FF1B7F4B' } };
    if (d.note === 'Kelmagan') row.getCell(10).font = { italic: true, color: { argb: 'FFA83D3D' } };
    else if (d.note) row.getCell(10).font = { italic: true, color: { argb: 'FF96591F' } };
  });

  const totalRow = wsDays.addRow([
    'JAMI',
    `${s.workedDays} kun`,
    s.avgArrival,
    '',
    hours(s.totalMinutes),
    attendance.prettyDuration(s.totalMinutes),
    s.doneCount,
    s.createdCount,
    s.totalActs,
    s.lateDays ? `${s.lateDays} kun kech` : '',
  ]);
  totalRow.font = { bold: true };
  totalRow.getCell(5).numFmt = '0.00';
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EFF0' } };
  });

  // ---------------- 3) Missiyalar ----------------
  const wsMis = wb.addWorksheet('Missiyalar');
  decorate(
    wsMis,
    [
      { key: 'title', header: 'Missiya', width: 52 },
      { key: 'status', header: 'Holat', width: 14 },
      { key: 'created', header: 'Yozilgan kuni', width: 15 },
      { key: 'start', header: 'Boshlanish', width: 14 },
      { key: 'due', header: 'Muddat', width: 14 },
      { key: 'done', header: 'Bajarilgan vaqti', width: 20 },
    ],
    `${config.companyName} — missiyalar`,
    `${who} · ${periodText}`,
  );

  const list = await missions.forRange(emp.id, from, to);
  const today = time.today();
  for (const m of list) {
    const label = missionLabel(m, today);
    const row = wsMis.addRow([
      m.title,
      label,
      String(m.created_at).slice(0, 10),
      m.start_date,
      m.due_date,
      m.done_at ? `${String(m.done_at).slice(0, 10)} ${time.clock(m.done_at)}` : '—',
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(2).font = { bold: true, color: { argb: STATUS_COLOR[label] || 'FF2C3B57' } };
  }
  if (!list.length) wsMis.addRow(["— bu davrda missiya yo'q —", '', '', '', '', '']);

  // ---------------- 4) Harakatlar ----------------
  const wsAct = wb.addWorksheet('Harakatlar');
  decorate(
    wsAct,
    [
      { key: 'date', header: 'Sana', width: 13 },
      { key: 'time', header: 'Vaqt', width: 9 },
      { key: 'action', header: 'Harakat', width: 26 },
      { key: 'title', header: 'Tafsilot', width: 50 },
      { key: 'detail', header: "Qo'shimcha", width: 30 },
    ],
    `${config.companyName} — bot harakatlari`,
    `${who} · ${periodText}`,
  );

  const acts = await activity.forRange(emp.id, from, to);
  for (const a of acts) {
    wsAct.addRow([
      a.work_date,
      time.clock(a.created_at),
      activity.meta(a.action).label,
      a.title || '',
      a.detail || '',
    ]).alignment = { vertical: 'top', wrapText: true };
  }
  if (!acts.length) wsAct.addRow(["— harakat yozuvi yo'q —", '', '', '', '']);

  const buffer = await wb.xlsx.writeBuffer();
  const slug = String(emp.full_name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'hodim';
  return { buffer, filename: `hisobot-${slug}-${from}_${to}.xlsx` };
};

/**
 * BUTUN JAMOA — tanlangan davr uchun bitta fayl (5 varaq):
 *   1. Jamlanma    — har bir hodim bitta qator (kim qancha ishlagan)
 *   2. Kunlar      — hamma hodimning kun-kun davomati
 *   3. Missiyalar  — hamma missiyalar, hodimi bilan
 *   4. Kechikkanlar— hozir muddati o'tib ketgan ishlar
 *   5. Bajarilganlar — davrda bajarilgan ishlar ro'yxati (sana bo'yicha)
 */
const buildTeamPeriod = async (fromRaw, toRaw) => {
  const period = require('./period');
  const attendance = require('./attendance');

  const t = await period.teamStats(fromRaw, toRaw);
  const { from, to } = t;

  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  wb.created = new Date();

  const periodText = `${time.prettyDate(from)} — ${time.prettyDate(to)} (${t.days} kun)`;

  // ---------------- 1) Jamlanma ----------------
  const ws = wb.addWorksheet('Jamlanma');
  decorate(
    ws,
    [
      { key: 'name', header: 'Hodim', width: 24 },
      { key: 'pos', header: 'Lavozim', width: 18 },
      { key: 'days', header: 'Kelgan kun', width: 12 },
      { key: 'absent', header: 'Kelmagan', width: 11 },
      { key: 'late', header: 'Kech kelgan', width: 12 },
      { key: 'h', header: 'Jami soat', width: 11 },
      { key: 'avg', header: "O'rtacha kelish", width: 15 },
      { key: 'done', header: 'Bajardi', width: 10 },
      { key: 'added', header: "Yozdi", width: 10 },
      { key: 'rate', header: 'Bajarish %', width: 12 },
      { key: 'open', header: 'Ochiq', width: 9 },
      { key: 'overdue', header: 'Kechikkan', width: 11 },
    ],
    `${config.companyName} — jamoa jamlanmasi`,
    periodText,
  );

  t.rows.forEach((r) => {
    const row = ws.addRow([
      r.emp.full_name,
      r.emp.position || '',
      `${r.workedDays} / ${r.days}`,
      r.absentDays,
      r.lateDays,
      hours(r.totalMinutes),
      r.avgArrival,
      r.doneCount,
      r.createdCount,
      r.rate === null ? '—' : r.rate / 100,
      r.open.length,
      r.overdue.length,
    ]);
    row.getCell(1).font = { bold: true };
    row.getCell(6).numFmt = '0.00';
    if (r.rate !== null) row.getCell(10).numFmt = '0%';
    if (r.lateDays) row.getCell(5).font = { bold: true, color: { argb: 'FFA83D3D' } };
    if (r.overdue.length) row.getCell(12).font = { bold: true, color: { argb: 'FFA83D3D' } };
  });

  if (t.rows.length) {
    const sumRow = ws.addRow([
      'JAMI',
      `${t.totals.employees} hodim`,
      `${t.totals.workedDays} / ${t.totals.possibleDays}`,
      t.totals.absentDays,
      t.totals.lateDays,
      hours(t.totals.totalMinutes),
      '',
      t.totals.doneCount,
      t.totals.createdCount,
      t.totals.rate === null ? '—' : t.totals.rate / 100,
      t.totals.openCount,
      t.totals.overdueCount,
    ]);
    sumRow.font = { bold: true };
    sumRow.getCell(6).numFmt = '0.00';
    if (t.totals.rate !== null) sumRow.getCell(10).numFmt = '0%';
    sumRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EFF0' } };
    });
  } else {
    ws.addRow(["— hodimlar yo'q —"]);
  }

  // ---------------- 2) Kunlar ----------------
  const wsDays = wb.addWorksheet('Kunlar');
  decorate(
    wsDays,
    [
      { key: 'name', header: 'Hodim', width: 24 },
      { key: 'date', header: 'Sana', width: 13 },
      { key: 'wd', header: 'Kun', width: 8 },
      { key: 'in', header: 'Keldi', width: 9 },
      { key: 'out', header: 'Ketdi', width: 9 },
      { key: 'h', header: 'Ish soati', width: 11 },
      { key: 'done', header: 'Bajardi', width: 9 },
      { key: 'added', header: "Yozdi", width: 9 },
      { key: 'note', header: 'Izoh', width: 24 },
    ],
    `${config.companyName} — kun-kun davomat`,
    periodText,
  );

  t.rows.forEach((r) => {
    r.dayRows.forEach((d) => {
      const row = wsDays.addRow([
        r.emp.full_name,
        d.date,
        time.weekdayShort(d.date),
        d.in || '—',
        d.out || '—',
        hours(d.minutes),
        d.done.length,
        d.created.length,
        d.note,
      ]);
      row.getCell(6).numFmt = '0.00';
      if (d.late) row.getCell(4).font = { bold: true, color: { argb: 'FFA83D3D' } };
      if (d.note === 'Kelmagan') row.getCell(9).font = { italic: true, color: { argb: 'FFA83D3D' } };
    });
  });

  // ---------------- 3) Missiyalar ----------------
  const wsMis = wb.addWorksheet('Missiyalar');
  decorate(
    wsMis,
    [
      { key: 'name', header: 'Hodim', width: 22 },
      { key: 'title', header: 'Missiya', width: 50 },
      { key: 'status', header: 'Holat', width: 14 },
      { key: 'created', header: 'Yozilgan', width: 13 },
      { key: 'start', header: 'Boshlanish', width: 13 },
      { key: 'due', header: 'Muddat', width: 13 },
      { key: 'done', header: 'Bajarilgan', width: 19 },
    ],
    `${config.companyName} — barcha missiyalar`,
    periodText,
  );

  const today = time.today();
  for (const r of t.rows) {
    const list = await missions.forRange(r.emp.id, from, to);
    for (const m of list) {
      const label = missionLabel(m, today);
      const row = wsMis.addRow([
        r.emp.full_name,
        m.title,
        label,
        String(m.created_at).slice(0, 10),
        m.start_date,
        m.due_date,
        m.done_at ? `${String(m.done_at).slice(0, 10)} ${time.clock(m.done_at)}` : '—',
      ]);
      row.alignment = { vertical: 'top', wrapText: true };
      row.getCell(3).font = { bold: true, color: { argb: STATUS_COLOR[label] || 'FF2C3B57' } };
    }
  }

  // ---------------- 4) Kechikkanlar ----------------
  const wsLate = wb.addWorksheet('Kechikkanlar');
  decorate(
    wsLate,
    [
      { key: 'name', header: 'Hodim', width: 24 },
      { key: 'title', header: 'Missiya', width: 52 },
      { key: 'due', header: 'Muddat edi', width: 14 },
      { key: 'days', header: 'Necha kun kechikdi', width: 20 },
    ],
    `${config.companyName} — kechikkan missiyalar`,
    `Holat: ${time.prettyDate(today)}`,
  );
  const overdue = await missions.allOverdue();
  overdue.forEach((m) => {
    const row = wsLate.addRow([m.full_name, m.title, m.due_date, time.diffDays(m.due_date, today)]);
    row.getCell(4).font = { bold: true, color: { argb: 'FFA83D3D' } };
    row.alignment = { vertical: 'top', wrapText: true };
  });
  if (!overdue.length) wsLate.addRow(['— kechikkan ish yo\'q 🎉 —', '', '', '']);

  // ---------------- 5) Bajarilganlar ----------------
  const wsDone = wb.addWorksheet('Bajarilganlar');
  decorate(
    wsDone,
    [
      { key: 'date', header: 'Sana', width: 13 },
      { key: 'time', header: 'Vaqt', width: 9 },
      { key: 'name', header: 'Hodim', width: 24 },
      { key: 'title', header: 'Bajarilgan ish', width: 56 },
    ],
    `${config.companyName} — davrda bajarilgan ishlar`,
    periodText,
  );
  const allDone = [];
  t.rows.forEach((r) => {
    r.doneRows.forEach((m) => allDone.push({ emp: r.emp, m }));
  });
  allDone.sort((a, b) => String(a.m.done_at).localeCompare(String(b.m.done_at)));
  allDone.forEach(({ emp, m }) => {
    wsDone.addRow([
      String(m.done_at).slice(0, 10),
      time.clock(m.done_at),
      emp.full_name,
      m.title,
    ]).alignment = { vertical: 'top', wrapText: true };
  });
  if (!allDone.length) wsDone.addRow(["— bu davrda bajarilgan ish yo'q —", '', '', '']);

  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, filename: `jamoa-hisobot-${from}_${to}.xlsx` };
};

/** Eski chaqiruvlar uchun: oxirgi N kun → davr hisoboti */
const buildEmployeeHistory = (emp, days = 30) =>
  buildEmployeePeriod(emp, time.addDays(time.today(), -(days - 1)), time.today());

const buildTeamSummary = (days = 30) =>
  buildTeamPeriod(time.addDays(time.today(), -(days - 1)), time.today());

module.exports = {
  buildDayReport, buildEmployeePeriod, buildTeamPeriod,
  buildEmployeeHistory, buildTeamSummary,
};
