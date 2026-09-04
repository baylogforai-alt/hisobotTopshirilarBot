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
// HODIM FAOLIYAT ARXIVI (ko'p varaqli)
// ---------------------------------------------------------------------------

const HEAD_BG = 'FF14646B';
const TITLE_COLOR = 'FF14213A';

/** Varaqqa sarlavha + ustun nomlarini qo'yadi */
const decorate = (ws, cols, titleText, subText) => {
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  const last = String.fromCharCode(64 + cols.length);

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
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB9702A' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
};

/**
 * Bitta hodimning N kunlik to'liq arxivi — 3 ta varaq:
 *   1. Kunlar     — sana, keldi, ketdi, ish soati, bajarilgan/yozilgan soni
 *   2. Missiyalar — har bir missiya: nomi, holati, muddati, bajarilgan vaqti
 *   3. Harakatlar — hodim botda qilgan har bir amal (vaqti bilan)
 */
const buildEmployeeHistory = async (emp, days = 30) => {
  // Aylanma bog'lanishning oldini olish uchun shu yerda talab qilamiz
  const attendance = require('./attendance');
  const activity = require('./activity');

  const to = time.today();
  const from = time.addDays(to, -(days - 1));

  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  wb.created = new Date();

  const period = `${time.prettyDate(from)} — ${time.prettyDate(to)} (${days} kun)`;
  const who = `${emp.full_name}${emp.position ? ` · ${emp.position}` : ''}`;

  // ---------------- 1) Kunlar ----------------
  const wsDays = wb.addWorksheet('Kunlar');
  decorate(
    wsDays,
    [
      { key: 'date', header: 'Sana', width: 22 },
      { key: 'in', header: 'Keldi', width: 10 },
      { key: 'out', header: 'Ketdi', width: 10 },
      { key: 'dur', header: 'Ish davomiyligi', width: 18 },
      { key: 'done', header: 'Bajardi', width: 10 },
      { key: 'added', header: 'Yozib qoydi', width: 14 },
      { key: 'acts', header: 'Bot harakatlari', width: 16 },
      { key: 'note', header: 'Izoh', width: 24 },
    ],
    `${config.companyName} — hodim faoliyati`,
    `${who} · ${period}`,
  );

  const attRows = await attendance.range(emp.id, from, to);
  const attByDate = new Map(attRows.map((r) => [r.work_date, r]));
  const actCounts = await activity.countsByDay(emp.id, from, to);

  let workedDays = 0;
  let totalMinutes = 0;
  let totalDone = 0;
  let totalAdded = 0;

  for (let i = 0; i < days; i += 1) {
    const d = time.addDays(from, i);
    const att = attByDate.get(d);
    const done = await missions.doneOn(emp.id, d);
    const added = await missions.createdOn(emp.id, d);
    const mins = attendance.workedMinutes(att);

    let note = '';
    if (!att || !att.checked_in) note = att && att.intent === 'no' ? 'Kelmasligini bildirgan' : 'Kelmagan';
    else if (!att.checked_out) note = 'Ketishni belgilamagan';

    totalDone += done.length;
    totalAdded += added.length;
    if (att && att.checked_in) workedDays += 1;
    if (mins !== null) totalMinutes += mins;

    const row = wsDays.addRow([
      time.prettyDate(d),
      att && att.checked_in ? time.clock(att.checked_in) : '—',
      att && att.checked_out ? time.clock(att.checked_out) : '—',
      mins === null ? '—' : attendance.prettyDuration(mins),
      done.length,
      added.length,
      actCounts.get(d) || 0,
      note,
    ]);
    if (note) row.getCell(8).font = { italic: true, color: { argb: 'FFA83D3D' } };
    if (att && att.checked_in) row.getCell(2).font = { bold: true };
  }

  wsDays.addRow([]);
  const sum = wsDays.addRow([
    'JAMI',
    `${workedDays} kun ishga kelgan`,
    '',
    attendance.prettyDuration(totalMinutes),
    totalDone,
    totalAdded,
    '',
    '',
  ]);
  sum.font = { bold: true };

  // ---------------- 2) Missiyalar ----------------
  const wsMis = wb.addWorksheet('Missiyalar');
  decorate(
    wsMis,
    [
      { key: 'title', header: 'Missiya', width: 50 },
      { key: 'status', header: 'Holat', width: 14 },
      { key: 'created', header: 'Yozilgan kuni', width: 20 },
      { key: 'start', header: 'Boshlanish', width: 18 },
      { key: 'due', header: 'Muddat', width: 18 },
      { key: 'done', header: 'Bajarilgan vaqti', width: 20 },
    ],
    `${config.companyName} — missiyalar`,
    `${who} · ${period}`,
  );

  const list = await missions.forRange(emp.id, from, to);
  const today = time.today();
  const statusColor = {
    Bajarildi: 'FF1B7F4B',
    Kechikkan: 'FFA83D3D',
    Bajarilmadi: 'FF96591F',
    "O'chirilgan": 'FF9AA6B2',
  };

  for (const m of list) {
    let label;
    if (m.status === 'done') label = 'Bajarildi';
    else if (m.status === 'cancelled') label = "O'chirilgan";
    else if (m.status === 'active' && m.due_date < today) label = 'Kechikkan';
    else if (m.status === 'active') label = 'Bajarilmadi';
    else label = 'Kutmoqda';

    const row = wsMis.addRow([
      m.title,
      label,
      time.prettyDate(String(m.created_at).slice(0, 10)),
      time.prettyDate(m.start_date),
      time.prettyDate(m.due_date),
      m.done_at ? `${String(m.done_at).slice(0, 10)} ${time.clock(m.done_at)}` : '—',
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(2).font = { bold: true, color: { argb: statusColor[label] || 'FF2C3B57' } };
  }
  if (!list.length) wsMis.addRow(['— bu davrda missiya yoq —', '', '', '', '', '']);

  // ---------------- 3) Harakatlar ----------------
  const wsAct = wb.addWorksheet('Harakatlar');
  decorate(
    wsAct,
    [
      { key: 'date', header: 'Sana', width: 20 },
      { key: 'time', header: 'Vaqt', width: 10 },
      { key: 'action', header: 'Harakat', width: 26 },
      { key: 'title', header: 'Tafsilot', width: 50 },
      { key: 'detail', header: 'Qoshimcha', width: 30 },
    ],
    `${config.companyName} — bot harakatlari`,
    `${who} · ${period}`,
  );

  const acts = await activity.forRange(emp.id, from, to);
  for (const a of acts) {
    wsAct.addRow([
      time.prettyDate(a.work_date),
      time.clock(a.created_at),
      activity.meta(a.action).label,
      a.title || '',
      a.detail || '',
    ]).alignment = { vertical: 'top', wrapText: true };
  }
  if (!acts.length) wsAct.addRow(['— harakat yozuvi yoq —', '', '', '', '']);

  const buffer = await wb.xlsx.writeBuffer();
  const slug = String(emp.full_name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'hodim';
  return { buffer, filename: `faoliyat-${slug}-${from}_${to}.xlsx` };
};

/**
 * Butun jamoa uchun N kunlik jamlanma — har bir hodim bitta qator.
 * Direktor bir qarashda kim qancha ishlaganini ko'radi.
 */
const buildTeamSummary = async (days = 30) => {
  const attendance = require('./attendance');
  const activity = require('./activity');
  const employees = require('./employees');

  const to = time.today();
  const from = time.addDays(to, -(days - 1));

  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  wb.created = new Date();

  const ws = wb.addWorksheet('Jamoa');
  decorate(
    ws,
    [
      { key: 'name', header: 'Hodim', width: 24 },
      { key: 'pos', header: 'Lavozim', width: 18 },
      { key: 'days', header: 'Kelgan kunlar', width: 15 },
      { key: 'hours', header: 'Jami ish vaqti', width: 18 },
      { key: 'avg', header: 'Ortacha kelish', width: 16 },
      { key: 'late', header: 'Kech kelgan', width: 13 },
      { key: 'done', header: 'Bajardi', width: 10 },
      { key: 'acts', header: 'Bot harakatlari', width: 16 },
    ],
    `${config.companyName} — jamoa jamlanmasi`,
    `${time.prettyDate(from)} — ${time.prettyDate(to)} (${days} kun)`,
  );

  const list = await employees.listActive();
  for (const emp of list) {
    const rows = await attendance.range(emp.id, from, to);
    let minutes = 0;
    let late = 0;
    const arrivals = [];
    rows.forEach((r) => {
      const m = attendance.workedMinutes(r);
      if (m !== null) minutes += m;
      if (r.checked_in) {
        const [h, mm] = time.clock(r.checked_in).split(':').map(Number);
        arrivals.push(h * 60 + mm);
        if (h * 60 + mm > config.workStartHour * 60) late += 1;
      }
    });
    const avg = arrivals.length
      ? Math.round(arrivals.reduce((a, b) => a + b, 0) / arrivals.length)
      : null;
    const done = (await missions.doneBetween(emp.id, from, to)).length;
    const counts = await activity.countsByDay(emp.id, from, to);
    let acts = 0;
    counts.forEach((v) => {
      acts += v;
    });

    const row = ws.addRow([
      emp.full_name,
      emp.position || '',
      `${rows.filter((r) => r.checked_in).length} / ${days}`,
      attendance.prettyDuration(minutes),
      avg === null
        ? '—'
        : `${String(Math.floor(avg / 60)).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`,
      late,
      done,
      acts,
    ]);
    row.getCell(1).font = { bold: true };
    if (late) row.getCell(6).font = { bold: true, color: { argb: 'FFA83D3D' } };
  }
  if (!list.length) ws.addRow(['— hodimlar yoq —', '', '', '', '', '', '', '']);

  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, filename: `jamoa-jamlanma-${from}_${to}.xlsx` };
};

module.exports = { buildDayReport, buildEmployeeHistory, buildTeamSummary };
