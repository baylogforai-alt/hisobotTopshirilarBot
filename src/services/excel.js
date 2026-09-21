'use strict';

const ExcelJS = require('exceljs');
const config = require('../config');
const time = require('../time');
const employees = require('./employees');
const departments = require('./departments');
const tasks = require('./tasks');
const attendance = require('./attendance');
const kpi = require('./kpi');
const activity = require('./activity');
const dailyReports = require('./dailyReports');

/**
 * EXCEL HISOBOTLAR.
 *   buildMonthly(month)             — direktor: KPI · Topshiriqlar · Davomat · Kunlik hisobotlar · Bo'limlar
 *   buildEmployeeMonth(emp, month)  — bitta hodim (oy): Xulosa · Topshiriqlar · Davomat · Kunlik hisobotlar
 *   buildDay(date, {employeeId})    — bitta kun: davomat + topshiriqlar + kunlik hisobotlar
 *   buildEmployeePeriod(emp, from, to) — istalgan davr, bitta hodim: Xulosa · Bajarilgan ishlar · Kunlar · Missiyalar · Kunlik hisobotlar · Harakatlar
 *   buildTeamPeriod(from, to)       — istalgan davr, jamoa: Jamlanma · Kunlar · Missiyalar · Kechikkanlar · Bajarilganlar · Kunlik hisobotlar
 * Raqamlar tasks.stats / attendance.stats / period.employeeStats dan — ekran bilan bir xil.
 */

const HEAD_BG = 'FF14646B';
const TITLE_COLOR = 'FF14213A';
const ZEBRA_BG = 'FFF3F7F8';
const ACCENT = 'FFB9702A';
const GREEN = 'FF1B7F4B';
const RED = 'FFA83D3D';
const AMBER = 'FF96591F';
const GREY = 'FF9AA6B2';
const NAVY = 'FF2C3B57';
const TOTAL_BG = 'FFE7EFF0';

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
  head.height = 24;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
    cell.border = { bottom: { style: 'thin', color: { argb: ACCENT } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
  ws.autoFilter = { from: 'A3', to: `${last}3` };
};

/** Har ikkinchi qatorni ochroq rangga bo'yaydi */
const zebra = (ws, startRow = 4) => {
  for (let i = startRow; i <= ws.rowCount; i += 1) {
    if ((i - startRow) % 2 === 1) {
      ws.getRow(i).eachCell({ includeEmpty: true }, (cell) => {
        if (!cell.fill || cell.fill.type !== 'pattern') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_BG } };
      });
    }
  }
};

const colorCell = (cell, argb) => { cell.font = { ...(cell.font || {}), color: { argb }, bold: true }; };
const wrap = (row) => { row.alignment = { vertical: 'top', wrapText: true }; return row; };
const totalStyle = (row) => {
  row.font = { bold: true };
  row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } }; });
  return row;
};
const hours = (minutes) => (minutes === null || minutes === undefined ? null : Math.round((minutes / 60) * 100) / 100);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fayl';
const stamp = (iso) => (iso ? `${String(iso).slice(0, 10)} ${time.clock(iso)}` : '');

const taskStatusLabel = (t, today = time.today()) => {
  if (t.status === 'accepted') return tasks.isOnTime(t) ? 'Muddatida' : 'Kech qabul';
  if (t.status === 'done') return 'Tekshiruvda';
  if (t.status === 'cancelled') return "O'chirilgan";
  if (t.due_date < today) return "Muddati o'tgan";
  return 'Ochiq';
};
const TASK_COLOR = { Muddatida: GREEN, 'Kech qabul': AMBER, Tekshiruvda: NAVY, "O'chirilgan": GREY, "Muddati o'tgan": RED, Ochiq: NAVY };
const SOURCE = { self: "O'zi", head: 'Boshliq', admin: 'Direktor' };

const DAY_LABEL = { ontime: 'Vaqtida', late: 'Kech', absent: 'Kelmagan', excused: 'Sababli', pending: "So'rov kutilmoqda", future: '', off: 'Dam olish' };
const DAY_COLOR = { Vaqtida: GREEN, Kech: AMBER, Kelmagan: RED, Sababli: NAVY, "So'rov kutilmoqda": AMBER };

/** Bir kunda bajarilgan ishlar — har biri yangi qatorda */
const doneList = (rows) => rows.map((t) => `✓ ${time.clock(t.done_at)}  ${t.title}`).join('\n');

// ---------------------------------------------------------------------------
// UMUMIY VARAQLAR
// ---------------------------------------------------------------------------

const addTasksSheet = (wb, rows, title, sub, { withName = true, name = 'Topshiriqlar' } = {}) => {
  const ws = wb.addWorksheet(name);
  const cols = [
    ...(withName ? [{ key: 'name', header: 'Hodim', width: 24 }, { key: 'dept', header: "Bo'lim", width: 16 }] : []),
    { key: 'title', header: 'Topshiriq', width: 48 },
    { key: 'source', header: 'Kim berdi', width: 12 },
    { key: 'prio', header: 'Ustuvorlik', width: 11 },
    { key: 'start', header: 'Berilgan', width: 12 },
    { key: 'due', header: 'Muddat', width: 12 },
    { key: 'done', header: 'Bajarildi', width: 16 },
    { key: 'status', header: 'Holat', width: 14 },
    { key: 'proof', header: 'Isbot', width: 8 },
    { key: 'returned', header: 'Qaytarilgan', width: 11 },
    { key: 'note', header: 'Tekshiruvchi izohi', width: 30 },
  ];
  decorate(ws, cols, title, sub);
  for (const t of rows) {
    const label = taskStatusLabel(t);
    const r = wrap(ws.addRow({
      name: t.full_name, dept: t.department_name || '', title: t.title, source: SOURCE[t.source] || t.source,
      prio: t.priority === 'high' ? 'Muhim' : 'Oddiy', start: t.start_date, due: t.due_date, done: stamp(t.done_at),
      status: label, proof: t.proof_file_id ? 'Bor' : '', returned: Number(t.returned_count) || 0, note: t.review_note || '',
    }));
    colorCell(r.getCell('status'), TASK_COLOR[label] || NAVY);
  }
  if (!rows.length) ws.addRow({ title: "— topshiriq yo'q —" });
  zebra(ws);
  return ws;
};

const addAttendanceSheet = (wb, entries, title, sub, { withName = true } = {}) => {
  const ws = wb.addWorksheet('Davomat');
  const cols = [
    ...(withName ? [{ key: 'name', header: 'Hodim', width: 24 }] : []),
    { key: 'date', header: 'Sana', width: 12 },
    { key: 'wd', header: 'Kun', width: 6 },
    { key: 'in', header: 'Keldi', width: 8 },
    { key: 'out', header: 'Ketdi', width: 8 },
    { key: 'h', header: 'Ish soati', width: 10 },
    { key: 'late', header: 'Kechikish (daq)', width: 14 },
    { key: 'status', header: 'Holat', width: 16 },
    { key: 'reason', header: 'Sabab / izoh', width: 36 },
    { key: 'dist', header: 'Ofisdan (m)', width: 11 },
  ];
  decorate(ws, cols, title, sub);
  for (const { e, day } of entries) {
    if (day.status === 'future') continue;
    const row = day.row;
    const label = DAY_LABEL[day.status] || '';
    const r = ws.addRow({
      name: e.full_name, date: day.date, wd: time.weekdayShort(day.date),
      in: row && row.checked_in ? time.clock(row.checked_in) : '', out: row && row.checked_out ? time.clock(row.checked_out) : '',
      h: hours(attendance.workedMinutes(row)),
      late: row && Number(row.late_minutes) > 0 ? Number(row.late_minutes) : '',
      status: label, reason: (row && (row.excuse_reason || row.late_reason)) || '',
      dist: row && row.checkin_dist ? Number(row.checkin_dist) : '',
    });
    r.getCell('h').numFmt = '0.00';
    if (DAY_COLOR[label]) colorCell(r.getCell('status'), DAY_COLOR[label]);
  }
  zebra(ws);
  return ws;
};

/** Kunlik hisobotlar varag'i (hodim kun oxirida yozgan matn) */
const addReportsSheet = (wb, rows, title, sub, { withName = true } = {}) => {
  const ws = wb.addWorksheet('Kunlik hisobotlar');
  decorate(ws, [
    ...(withName ? [{ key: 'name', header: 'Hodim', width: 24 }] : []),
    { key: 'date', header: 'Sana', width: 12 }, { key: 'wd', header: 'Kun', width: 6 }, { key: 'time', header: 'Topshirgan', width: 11 },
    { key: 'text', header: 'Hisobot matni', width: 80 }, { key: 'photo', header: 'Rasm', width: 7 },
    { key: 'seen', header: "Ko'rilgan", width: 12 }, { key: 'note', header: 'Boshliq izohi', width: 30 },
  ], title, sub);
  for (const r of rows) {
    wrap(ws.addRow({
      name: r.full_name, date: r.work_date, wd: time.weekdayShort(r.work_date), time: time.clock(r.submitted_at),
      text: r.text, photo: r.photo_file_id ? 'Bor' : '', seen: r.reviewed_at ? 'Ha' : '', note: r.review_note || '',
    }));
  }
  if (!rows.length) ws.addRow({ text: "— kunlik hisobot yo'q —" });
  zebra(ws);
  return ws;
};

const addActivitySheet = (wb, acts, title, sub) => {
  const ws = wb.addWorksheet('Harakatlar');
  decorate(ws, [
    { key: 'date', header: 'Sana', width: 13 }, { key: 'time', header: 'Vaqt', width: 9 }, { key: 'action', header: 'Harakat', width: 26 },
    { key: 'title', header: 'Tafsilot', width: 50 }, { key: 'detail', header: "Qo'shimcha", width: 30 },
  ], title, sub);
  for (const a of acts) wrap(ws.addRow({ date: a.work_date, time: time.clock(a.created_at), action: activity.meta(a.action).label, title: a.title || '', detail: a.detail || '' }));
  if (!acts.length) ws.addRow({ action: "— harakat yozuvi yo'q —" });
  zebra(ws);
  return ws;
};

// ---------------------------------------------------------------------------
// KPI (oylik)
// ---------------------------------------------------------------------------

const kpiRowOf = (k, dept) => ({
  name: k.full_name, dept: k.department_name || '', position: k.position || '',
  t_total: k.tasks_total, t_ontime: k.tasks_ontime, t_ret: Number(k.tasks_returned) || 0, t_pct: k.tasks_pct,
  wd: k.work_days, ontime: k.ontime_days, late: k.late_days, absent: k.absent_days, excused: k.excused_days, a_pct: k.att_pct,
  head: k.head_score === null ? '' : k.head_score, custom: k.custom_pct === null ? '' : k.custom_pct,
  custom_name: (dept && dept.custom_name) || '',
  weights: `${k.w_tasks}/${k.w_attendance}/${k.w_head}/${k.w_custom}`,
  total: k.total, fund: k.bonus_fund === null ? '' : k.bonus_fund, bonus: k.bonus_amount === null ? '' : k.bonus_amount,
  status: kpi.statusLabel(k.status).replace(/^\S+\s/, ''), note: k.note || '',
});

const KPI_COLS = [
  { key: 'name', header: 'Hodim', width: 24 }, { key: 'dept', header: "Bo'lim", width: 14 }, { key: 'position', header: 'Lavozim', width: 14 },
  { key: 't_total', header: 'Topshiriq jami', width: 9 }, { key: 't_ontime', header: 'Muddatida', width: 9 }, { key: 't_ret', header: 'Qaytarishlar', width: 10 }, { key: 't_pct', header: 'Topshiriq %', width: 10 },
  { key: 'wd', header: 'Ish kuni', width: 8 }, { key: 'ontime', header: 'Vaqtida', width: 8 }, { key: 'late', header: 'Kech', width: 6 },
  { key: 'absent', header: 'Kelmagan', width: 9 }, { key: 'excused', header: 'Sababli', width: 8 }, { key: 'a_pct', header: 'Davomat %', width: 10 },
  { key: 'head', header: 'Boshliq bahosi (1-10)', width: 12 }, { key: 'custom', header: "Qo'shimcha mezon %", width: 12 }, { key: 'custom_name', header: 'Mezon nomi', width: 16 },
  { key: 'weights', header: 'Vaznlar T/D/B/Q', width: 13 }, { key: 'total', header: 'KPI ball', width: 9 },
  { key: 'fund', header: "Bonus fondi (so'm)", width: 15 }, { key: 'bonus', header: "Bonus (so'm)", width: 15 },
  { key: 'status', header: 'Holat', width: 13 }, { key: 'note', header: 'Izoh', width: 30 },
];

const styleKpiRow = (r) => {
  const total = Number(r.getCell('total').value);
  colorCell(r.getCell('total'), total >= 80 ? GREEN : total >= 60 ? AMBER : RED);
  r.getCell('fund').numFmt = '#,##0';
  r.getCell('bonus').numFmt = '#,##0';
};

/** Direktor uchun oylik fayl */
const buildMonthly = async (month) => {
  const { from, to } = time.monthRange(month);
  const wb = new ExcelJS.Workbook();
  wb.creator = `${config.companyName} bot`;
  const sub = `${config.companyName} · ${time.monthName(month)} · tuzildi ${time.now().toFormat('dd.MM.yyyy HH:mm')}`;
  const list = await employees.listActive();
  const deptMap = new Map((await departments.listAll()).map((d) => [Number(d.id), d]));

  const wsK = wb.addWorksheet('KPI');
  decorate(wsK, KPI_COLS, `KPI — ${time.monthName(month)}`, sub);
  for (const e of list) styleKpiRow(wsK.addRow(kpiRowOf(await kpi.compute(e, month), deptMap.get(Number(e.department_id)))));
  zebra(wsK);

  addTasksSheet(wb, await tasks.rangeAll(from, to), `Topshiriqlar — ${time.monthName(month)}`, sub);

  const entries = [];
  for (const e of list) for (const day of (await attendance.stats(e, from, to)).days) entries.push({ e, day });
  addAttendanceSheet(wb, entries, `Davomat — ${time.monthName(month)}`, sub);

  addReportsSheet(wb, await dailyReports.rangeAll(from, to), `Kunlik hisobotlar — ${time.monthName(month)}`, sub);

  const wsD = wb.addWorksheet("Bo'limlar");
  decorate(wsD, [
    { key: 'name', header: "Bo'lim", width: 22 }, { key: 'n', header: 'Hodimlar', width: 9 },
    { key: 'wt', header: 'Topshiriq %', width: 11 }, { key: 'wa', header: 'Davomat %', width: 11 }, { key: 'wh', header: 'Boshliq bahosi %', width: 14 },
    { key: 'wc', header: "Qo'shimcha %", width: 12 }, { key: 'cn', header: 'Mezon nomi', width: 20 },
  ], "Bo'limlar va KPI vaznlari", sub);
  for (const d of await departments.listActive()) {
    wsD.addRow({ name: d.name, n: await departments.memberCount(d.id), wt: d.w_tasks, wa: d.w_attendance, wh: d.w_head, wc: d.w_custom, cn: d.custom_name || '' });
  }
  zebra(wsD);

  return { buffer: await wb.xlsx.writeBuffer(), filename: `${slug(config.companyName)}-${month}.xlsx` };
};

/** Bitta hodim — oy */
const buildEmployeeMonth = async (emp, month) => {
  const { from, to } = time.monthRange(month);
  const wb = new ExcelJS.Workbook();
  const sub = `${emp.full_name}${emp.position ? ` · ${emp.position}` : ''}${emp.department_name ? ` · ${emp.department_name}` : ''} · ${time.monthName(month)}`;
  const dept = emp.department_id ? await departments.byId(emp.department_id) : null;
  const wsK = wb.addWorksheet('Xulosa');
  decorate(wsK, KPI_COLS, `Xulosa — ${time.monthName(month)}`, sub);
  styleKpiRow(wsK.addRow(kpiRowOf(await kpi.compute(emp, month), dept)));
  addTasksSheet(wb, await tasks.range(emp.id, from, to), `Topshiriqlar — ${time.monthName(month)}`, sub, { withName: false });
  const st = await attendance.stats(emp, from, to);
  addAttendanceSheet(wb, st.days.map((day) => ({ e: emp, day })), `Davomat — ${time.monthName(month)}`, sub, { withName: false });
  addReportsSheet(wb, await dailyReports.range(emp.id, from, to), `Kunlik hisobotlar — ${time.monthName(month)}`, sub, { withName: false });
  return { buffer: await wb.xlsx.writeBuffer(), filename: `${slug(emp.full_name)}-${month}.xlsx` };
};

/** Bitta kun — jamoa (yoki bitta hodim): davomat + bugungi ishlar + kunlik hisobotlar */
const buildDay = async (date = time.today(), { employeeId = null } = {}) => {
  const wb = new ExcelJS.Workbook();
  const list = employeeId ? [await employees.byId(employeeId)].filter(Boolean) : await employees.listActive();
  const sub = `${config.companyName} · ${time.prettyDate(date)}${employeeId && list[0] ? ` · ${list[0].full_name}` : ''}`;

  const ws = wb.addWorksheet('Kun');
  decorate(ws, [
    { key: 'name', header: 'Hodim', width: 22 }, { key: 'position', header: 'Lavozim', width: 16 },
    { key: 'title', header: 'Topshiriq', width: 50 }, { key: 'status', header: 'Holat', width: 15 },
    { key: 'due', header: 'Muddat', width: 12 }, { key: 'done', header: 'Bajarilgan', width: 11 }, { key: 'source', header: 'Kim berdi', width: 10 },
  ], `${config.companyName} — kunlik hisobot`, sub);
  const rows = await tasks.dayRows(date, employeeId);
  let lastName = null;
  for (const r of rows) {
    const same = r.full_name === lastName;
    lastName = r.full_name;
    if (!r.title) { const row = ws.addRow({ name: r.full_name, position: r.position || '', title: "— ish yo'q —" }); row.getCell('title').font = { italic: true, color: { argb: GREY } }; continue; }
    const label = taskStatusLabel(r, date);
    const row = wrap(ws.addRow({
      name: same ? '' : r.full_name, position: same ? '' : r.position || '', title: r.title, status: label,
      due: r.due_date, done: r.done_at ? time.clock(r.done_at) : '', source: SOURCE[r.source] || '',
    }));
    colorCell(row.getCell('status'), TASK_COLOR[label] || NAVY);
    if (!same) row.getCell('name').font = { bold: true };
  }
  zebra(ws);

  const entries = [];
  for (const e of list) {
    const row = await attendance.get(e.id, date);
    entries.push({ e, day: { date, status: attendance.dayStatus(row, date, time.today(), e), row } });
  }
  addAttendanceSheet(wb, entries, `Davomat — ${time.prettyDate(date)}`, sub);
  addReportsSheet(wb, employeeId ? (await dailyReports.range(employeeId, date, date)) : await dailyReports.forDate(date), `Kunlik hisobotlar — ${time.prettyDate(date)}`, sub);
  return { buffer: await wb.xlsx.writeBuffer(), filename: `hisobot-${employeeId ? slug(list[0] ? list[0].full_name : 'hodim') : 'jamoa'}-${date}.xlsx` };
};

// ---------------------------------------------------------------------------
// DAVR (istalgan sana oralig'i)
// ---------------------------------------------------------------------------

/** BITTA HODIM — tanlangan davr uchun to'liq arxiv */
const buildEmployeePeriod = async (emp, fromRaw, toRaw) => {
  const period = require('./period');
  const { from, to } = period.normalize(fromRaw, toRaw);
  const s = await period.employeeStats(emp, from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  const who = `${emp.full_name}${emp.position ? ` · ${emp.position}` : ''}${emp.department_name ? ` · ${emp.department_name}` : ''}`;
  const periodText = `${time.prettyDate(from)} — ${time.prettyDate(to)} (${s.days} kun)`;

  // 1) Xulosa
  const wsSum = wb.addWorksheet('Xulosa');
  decorate(wsSum, [{ key: 'k', header: "Ko'rsatkich", width: 36 }, { key: 'v', header: 'Qiymat', width: 30 }], `${config.companyName} — hodim hisoboti`, `${who} · ${periodText}`);
  [
    ['Davr', periodText], ['Davrdagi kunlar', s.days], ['Ish kunlari', s.workDays], ['Ishga kelgan kunlar', s.workedDays],
    ['Kelmagan kunlar', s.absentDays], ['Sababli kunlar', s.excusedDays], ['Kech kelgan kunlar', s.lateDays], ['Jami kechikish', time.prettyDuration(s.lateMinutes)],
    ['Davomat %', s.attPct], ['Ketishni belgilamagan kunlar', s.noCheckout],
    ['Jami ish vaqti', time.prettyDuration(s.totalMinutes)], ['Jami ish soati (raqam)', hours(s.totalMinutes)],
    ["Kunlik o'rtacha ish vaqti", s.avgMinutes === null ? '—' : time.prettyDuration(s.avgMinutes)], ["O'rtacha kelish vaqti", s.avgArrival],
    ['Bajargan ishlari', s.doneCount], ["Yozib qo'ygan ishlari", s.createdCount], ['Bajarish darajasi', s.rate === null ? '—' : `${s.rate}%`],
    ['Muddatida bajarilgan (KPI)', `${s.ts.ontime} / ${s.ts.total}`], ['Topshiriq % (KPI)', s.tasksPct], ['Qaytarilgan ishlar', s.ts.returns],
    ['Hozir ochiq', s.open.length], ['Ulardan kechikkani', s.overdue.length],
    ['Kunlik hisobot topshirgan kunlar', s.reportDays],
    ['Botdan foydalangan kunlar', s.activeDays], ['Jami bot harakatlari', s.totalActs],
  ].forEach(([k, v]) => { wsSum.addRow([k, v]).getCell(1).font = { bold: true, color: { argb: NAVY } }; });
  zebra(wsSum);

  // 2) Bajarilgan ishlar
  const wsDone = wb.addWorksheet('Bajarilgan ishlar');
  decorate(wsDone, [
    { key: 'n', header: '№', width: 6 }, { key: 'date', header: 'Sana', width: 13 }, { key: 'wd', header: 'Kun', width: 8 }, { key: 'time', header: 'Vaqt', width: 9 },
    { key: 'title', header: 'Bajarilgan ish', width: 60 }, { key: 'due', header: 'Muddati edi', width: 14 }, { key: 'ontime', header: 'Muddatida', width: 12 },
    { key: 'status', header: 'Holat', width: 13 }, { key: 'source', header: 'Kim berdi', width: 10 },
  ], `${config.companyName} — bajarilgan ishlar`, `${who} · ${periodText} · jami ${s.doneCount} ta`);
  [...s.doneRows].sort((a, b) => String(a.done_at).localeCompare(String(b.done_at))).forEach((t, i) => {
    const d = String(t.done_at).slice(0, 10);
    const onTime = d <= t.due_date;
    const row = wrap(wsDone.addRow({ n: i + 1, date: d, wd: time.weekdayShort(d), time: time.clock(t.done_at), title: t.title, due: t.due_date, ontime: onTime ? 'Ha' : 'Kech', status: t.status === 'accepted' ? 'Qabul qilingan' : 'Tekshiruvda', source: SOURCE[t.source] || '' }));
    colorCell(row.getCell('ontime'), onTime ? GREEN : RED);
  });
  if (!s.doneRows.length) wsDone.addRow({ title: "— bu davrda bajarilgan ish yo'q —" });
  zebra(wsDone);

  // 3) Kunlar
  const wsDays = wb.addWorksheet('Kunlar');
  decorate(wsDays, [
    { key: 'date', header: 'Sana', width: 13 }, { key: 'wd', header: 'Kun', width: 8 }, { key: 'in', header: 'Keldi', width: 9 }, { key: 'out', header: 'Ketdi', width: 9 },
    { key: 'h', header: 'Ish soati', width: 11 }, { key: 'dur', header: 'Davomiylik', width: 17 }, { key: 'late', header: 'Kechikish (daq)', width: 13 },
    { key: 'done', header: 'Bajardi', width: 9 }, { key: 'what', header: 'Nima ish qildi', width: 55 }, { key: 'added', header: "Yozib qo'ydi", width: 12 },
    { key: 'report', header: 'Kunlik hisobot', width: 50 }, { key: 'acts', header: 'Bot harakatlari', width: 14 }, { key: 'note', header: 'Izoh', width: 24 },
  ], `${config.companyName} — kun-kun faoliyat`, `${who} · ${periodText}`);
  s.dayRows.forEach((d) => {
    const row = wrap(wsDays.addRow({
      date: d.date, wd: time.weekdayShort(d.date), in: d.in || '—', out: d.out || '—', h: hours(d.minutes),
      dur: d.minutes === null ? '—' : time.prettyDuration(d.minutes), late: d.lateMinutes || '', done: d.done.length, what: doneList(d.done),
      added: d.created.length, report: d.report ? d.report.text : '', acts: d.acts, note: d.note,
    }));
    row.getCell('h').numFmt = '0.00';
    if (d.in) colorCell(row.getCell('in'), d.late ? RED : GREEN);
    if (d.note === 'Kelmagan') row.getCell('note').font = { italic: true, color: { argb: RED } };
    else if (d.note) row.getCell('note').font = { italic: true, color: { argb: AMBER } };
  });
  const total = totalStyle(wsDays.addRow({
    date: 'JAMI', wd: `${s.workedDays} kun`, in: s.avgArrival, h: hours(s.totalMinutes), dur: time.prettyDuration(s.totalMinutes), late: s.lateMinutes || '',
    done: s.doneCount, what: `${s.doneCount} ta ish`, added: s.createdCount, report: `${s.reportDays} kun`, acts: s.totalActs, note: s.lateDays ? `${s.lateDays} kun kech` : '',
  }));
  total.getCell('h').numFmt = '0.00';

  // 4) Missiyalar (davrga tegishli barcha)
  addTasksSheet(wb, await tasks.forRange(emp.id, from, to), `${config.companyName} — missiyalar`, `${who} · ${periodText}`, { withName: false, name: 'Missiyalar' });

  // 5) Kunlik hisobotlar
  addReportsSheet(wb, s.reportRows, `${config.companyName} — kunlik hisobotlar`, `${who} · ${periodText}`, { withName: false });

  // 6) Harakatlar
  addActivitySheet(wb, await activity.forRange(emp.id, from, to), `${config.companyName} — bot harakatlari`, `${who} · ${periodText}`);

  return { buffer: await wb.xlsx.writeBuffer(), filename: `hisobot-${slug(emp.full_name)}-${from}_${to}.xlsx` };
};

/** BUTUN JAMOA — tanlangan davr uchun bitta fayl */
const buildTeamPeriod = async (fromRaw, toRaw) => {
  const period = require('./period');
  const t = await period.teamStats(fromRaw, toRaw);
  const { from, to } = t;
  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  const periodText = `${time.prettyDate(from)} — ${time.prettyDate(to)} (${t.days} kun)`;

  // 1) Jamlanma
  const ws = wb.addWorksheet('Jamlanma');
  decorate(ws, [
    { key: 'name', header: 'Hodim', width: 24 }, { key: 'pos', header: 'Lavozim', width: 16 }, { key: 'dept', header: "Bo'lim", width: 14 },
    { key: 'days', header: 'Kelgan / ish kuni', width: 15 }, { key: 'absent', header: 'Kelmagan', width: 10 }, { key: 'excused', header: 'Sababli', width: 9 },
    { key: 'late', header: 'Kech kelgan', width: 11 }, { key: 'att', header: 'Davomat %', width: 10 }, { key: 'h', header: 'Jami soat', width: 10 },
    { key: 'avg', header: "O'rtacha kelish", width: 14 }, { key: 'done', header: 'Bajardi', width: 9 }, { key: 'added', header: 'Yozdi', width: 8 },
    { key: 'rate', header: 'Bajarish %', width: 11 }, { key: 'tpct', header: 'Muddatida % (KPI)', width: 15 },
    { key: 'open', header: 'Ochiq', width: 8 }, { key: 'overdue', header: 'Kechikkan', width: 10 }, { key: 'rep', header: 'Kunlik hisobot', width: 13 },
  ], `${config.companyName} — jamoa jamlanmasi`, periodText);
  t.rows.forEach((r) => {
    const row = ws.addRow({
      name: r.emp.full_name, pos: r.emp.position || '', dept: r.emp.department_name || '', days: `${r.workedDays} / ${r.workDays}`,
      absent: r.absentDays, excused: r.excusedDays, late: r.lateDays, att: r.attPct, h: hours(r.totalMinutes), avg: r.avgArrival,
      done: r.doneCount, added: r.createdCount, rate: r.rate === null ? '—' : r.rate / 100, tpct: r.tasksPct,
      open: r.open.length, overdue: r.overdue.length, rep: r.reportDays,
    });
    row.getCell('name').font = { bold: true };
    row.getCell('h').numFmt = '0.00';
    if (r.rate !== null) row.getCell('rate').numFmt = '0%';
    if (r.lateDays) colorCell(row.getCell('late'), RED);
    if (r.overdue.length) colorCell(row.getCell('overdue'), RED);
  });
  if (t.rows.length) {
    const sum = totalStyle(ws.addRow({
      name: 'JAMI', pos: `${t.totals.employees} hodim`, days: `${t.totals.workedDays} / ${t.totals.possibleDays}`, absent: t.totals.absentDays, excused: t.totals.excusedDays,
      late: t.totals.lateDays, h: hours(t.totals.totalMinutes), done: t.totals.doneCount, added: t.totals.createdCount,
      rate: t.totals.rate === null ? '—' : t.totals.rate / 100, open: t.totals.openCount, overdue: t.totals.overdueCount, rep: t.totals.reportDays,
    }));
    sum.getCell('h').numFmt = '0.00';
    if (t.totals.rate !== null) sum.getCell('rate').numFmt = '0%';
  } else ws.addRow({ name: "— hodimlar yo'q —" });

  // 2) Kunlar
  const wsDays = wb.addWorksheet('Kunlar');
  decorate(wsDays, [
    { key: 'name', header: 'Hodim', width: 24 }, { key: 'date', header: 'Sana', width: 13 }, { key: 'wd', header: 'Kun', width: 8 },
    { key: 'in', header: 'Keldi', width: 9 }, { key: 'out', header: 'Ketdi', width: 9 }, { key: 'h', header: 'Ish soati', width: 11 }, { key: 'late', header: 'Kechikish (daq)', width: 13 },
    { key: 'done', header: 'Bajardi', width: 9 }, { key: 'what', header: 'Nima ish qildi', width: 50 }, { key: 'added', header: 'Yozdi', width: 8 },
    { key: 'report', header: 'Kunlik hisobot', width: 45 }, { key: 'note', header: 'Izoh', width: 24 },
  ], `${config.companyName} — kun-kun davomat`, periodText);
  t.rows.forEach((r) => r.dayRows.forEach((d) => {
    if (d.status === 'future') return;
    const row = wrap(wsDays.addRow({
      name: r.emp.full_name, date: d.date, wd: time.weekdayShort(d.date), in: d.in || '—', out: d.out || '—', h: hours(d.minutes), late: d.lateMinutes || '',
      done: d.done.length, what: doneList(d.done), added: d.created.length, report: d.report ? d.report.text : '', note: d.note,
    }));
    row.getCell('h').numFmt = '0.00';
    if (d.late) colorCell(row.getCell('in'), RED);
    if (d.note === 'Kelmagan') row.getCell('note').font = { italic: true, color: { argb: RED } };
  }));
  zebra(wsDays);

  // 3) Missiyalar
  const all = [];
  for (const r of t.rows) all.push(...(await tasks.forRange(r.emp.id, from, to)));
  addTasksSheet(wb, all, `${config.companyName} — barcha missiyalar`, periodText, { name: 'Missiyalar' });

  // 4) Kechikkanlar
  const today = time.today();
  const wsLate = wb.addWorksheet('Kechikkanlar');
  decorate(wsLate, [
    { key: 'name', header: 'Hodim', width: 24 }, { key: 'title', header: 'Missiya', width: 52 }, { key: 'due', header: 'Muddat edi', width: 14 },
    { key: 'days', header: 'Necha kun kechikdi', width: 18 }, { key: 'source', header: 'Kim berdi', width: 10 },
  ], `${config.companyName} — kechikkan missiyalar`, `Holat: ${time.prettyDate(today)}`);
  const overdue = await tasks.overdue();
  overdue.forEach((m) => { const row = wrap(wsLate.addRow({ name: m.full_name, title: m.title, due: m.due_date, days: time.diffDays(m.due_date, today), source: SOURCE[m.source] || '' })); colorCell(row.getCell('days'), RED); });
  if (!overdue.length) wsLate.addRow({ name: "— kechikkan ish yo'q 🎉 —" });
  zebra(wsLate);

  // 5) Bajarilganlar
  const wsDone = wb.addWorksheet('Bajarilganlar');
  decorate(wsDone, [
    { key: 'date', header: 'Sana', width: 13 }, { key: 'time', header: 'Vaqt', width: 9 }, { key: 'name', header: 'Hodim', width: 24 },
    { key: 'title', header: 'Bajarilgan ish', width: 56 }, { key: 'ontime', header: 'Muddatida', width: 11 }, { key: 'status', header: 'Holat', width: 14 },
  ], `${config.companyName} — davrda bajarilgan ishlar`, periodText);
  const allDone = [];
  t.rows.forEach((r) => r.doneRows.forEach((m) => allDone.push({ emp: r.emp, m })));
  allDone.sort((a, b) => String(a.m.done_at).localeCompare(String(b.m.done_at)));
  allDone.forEach(({ emp, m }) => {
    const d = String(m.done_at).slice(0, 10);
    const row = wrap(wsDone.addRow({ date: d, time: time.clock(m.done_at), name: emp.full_name, title: m.title, ontime: d <= m.due_date ? 'Ha' : 'Kech', status: m.status === 'accepted' ? 'Qabul qilingan' : 'Tekshiruvda' }));
    colorCell(row.getCell('ontime'), d <= m.due_date ? GREEN : RED);
  });
  if (!allDone.length) wsDone.addRow({ title: "— bu davrda bajarilgan ish yo'q —" });
  zebra(wsDone);

  // 6) Kunlik hisobotlar
  addReportsSheet(wb, await dailyReports.rangeAll(from, to), `${config.companyName} — kunlik hisobotlar`, periodText);

  return { buffer: await wb.xlsx.writeBuffer(), filename: `jamoa-hisobot-${from}_${to}.xlsx` };
};

/** Oxirgi N kun → davr hisoboti */
const buildEmployeeHistory = (emp, days = 30) => buildEmployeePeriod(emp, time.addDays(time.today(), -(days - 1)), time.today());
const buildTeamSummary = (days = 30) => buildTeamPeriod(time.addDays(time.today(), -(days - 1)), time.today());

module.exports = { buildMonthly, buildEmployeeMonth, buildDay, buildEmployeePeriod, buildTeamPeriod, buildEmployeeHistory, buildTeamSummary };
