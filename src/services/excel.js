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

module.exports = { buildDayReport };
