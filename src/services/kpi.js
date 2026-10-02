'use strict';

const db = require('../db');
const config = require('../config');
const time = require('../time');
const employees = require('./employees');
const departments = require('./departments');
const tasks = require('./tasks');
const attendance = require('./attendance');
const months = require('./months');

/**
 * OYLIK KPI.
 *   tasks_pct  — muddatida qabul qilingan / muddati kelgan topshiriqlar − qaytarishlar × RETURN_PENALTY_PCT (avto)
 *   att_pct    — davomat % (avto)
 *   head_score — bo'lim boshlig'i bahosi 1–10 (qo'lda) → ×10 = %
 *   custom_pct — bo'limga xos mezon % (admin qo'lda)
 *   total      — vaznli o'rtacha. Kiritilmagan komponent (boshliq bahosi / mezon) hisobdan chiqariladi,
 *                qolgan vaznlar qayta 100 ga keltiriladi — hodim boshliq baho qo'ymagani uchun jabr ko'rmasin.
 *   bonus_amount = bonus_fund × total / 100
 * status: draft → confirmed | excluded (direktor qarori). confirmed/excluded qator avto qayta hisoblanmaydi.
 *
 * KPI SHARTI (KPI_MODE=gate, standart): oy davomida vaqtida kelgan VA topshiriqlarni muddatida bajargan bo'lsa —
 * KPI summasi (bonus_fund) TO'LIQ beriladi, aks holda umuman berilmaydi (0). Chegaralar .env da:
 * KPI_MAX_LATE, KPI_MAX_ABSENT, KPI_MAX_MISSED_TASKS (standart 0), KPI_EXCUSED_OK (sababli kun zarar qilmaydi).
 * Ball (total) ma'lumot uchun hisoblanaveradi. KPI_MODE=score — eski usul: summa × ball / 100.
 * Oylik: salary (oklad, hodim kartochkasidan snapshot) + bonus_amount = jami.
 */

const SELECT = `SELECT k.*, e.full_name, e.tg_id, e.position, e.department_id, d.name AS department_name, d.custom_name
                FROM kpi_monthly k JOIN employees e ON e.id = k.employee_id
                LEFT JOIN departments d ON d.id = e.department_id`;

const get = (employeeId, month) => db.one(`${SELECT} WHERE k.employee_id = $1 AND k.month = $2`, [Number(employeeId), month]);
const byId = (id) => db.one(`${SELECT} WHERE k.id = $1`, [Number(id)]);

const listMonth = (month) =>
  db.query(`${SELECT} WHERE k.month = $1 AND e.active = 1 ORDER BY lower(d.name), lower(e.full_name)`, [month]);

/** Yakuniy ball (0–100) */
const computeTotal = (row) => {
  const parts = [
    { pct: Number(row.tasks_pct), w: Number(row.w_tasks) },
    { pct: Number(row.att_pct), w: Number(row.w_attendance) },
    { pct: row.head_score === null || row.head_score === undefined ? null : Number(row.head_score) * 10, w: Number(row.w_head) },
    { pct: row.custom_pct === null || row.custom_pct === undefined ? null : Number(row.custom_pct), w: Number(row.w_custom) },
  ].filter((p) => p.w > 0 && p.pct !== null);
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  if (!wsum) return 0;
  return Math.round(parts.reduce((a, p) => a + p.pct * p.w, 0) / wsum);
};

const bonusOf = (fund, total) => (fund === null || fund === undefined || fund === '' ? null : Math.round((Number(fund) * total) / 100));

/** KPI sharti: { eligible, reasons[] } — ts: tasks.stats, at: attendance.stats */
const checkGate = (ts, at, { monthConfirmed = true } = {}) => {
  const reasons = [];
  if (at.late > config.kpiMaxLate) reasons.push(`${at.late} marta kech kelgan`);
  if (at.absent > config.kpiMaxAbsent) reasons.push(`${at.absent} kun sababsiz kelmagan`);
  if (!config.kpiExcusedOk && at.excused > 0) reasons.push(`${at.excused} kun sababli kelmagan`);
  if (ts.missed > config.kpiMaxMissedTasks) reasons.push(`${ts.missed} ta topshiriq muddatida bajarilmagan`);
  if (!monthConfirmed) reasons.push('oy boshi tasdiqlanmagan');
  return { eligible: reasons.length === 0, reasons };
};

/** Bonus summasi rejimga qarab */
const bonusFor = (row) => {
  if (row.bonus_fund === null || row.bonus_fund === undefined || row.bonus_fund === '') return null;
  if (config.kpiMode === 'score') return bonusOf(row.bonus_fund, Number(row.total));
  return Number(row.kpi_eligible) === 1 ? Math.round(Number(row.bonus_fund)) : 0;
};

/** Oylik jami: oklad + KPI (KPI faqat tasdiqlangan bo'lsa qo'shiladi) */
const payOf = (k) => {
  const salary = k.salary === null || k.salary === undefined ? 0 : Number(k.salary);
  const bonus = k.status === 'confirmed' && k.bonus_amount !== null ? Number(k.bonus_amount) : 0;
  return { salary, bonus, total: salary + bonus };
};

/** Avto qismlarni qayta hisoblab saqlaydi. Tasdiqlangan/chiqarilgan qator (force bo'lmasa) o'zgarmaydi. */
const compute = async (emp, month, { force = false } = {}) => {
  const existing = await get(emp.id, month);
  if (existing && existing.status !== 'draft' && !force) return existing;

  const { from, to } = time.monthRange(month);
  const ts = await tasks.stats(emp.id, from, to);
  const at = await attendance.stats(emp, from, to);
  const dept = emp.department_id ? await departments.byId(emp.department_id) : null;
  const w = departments.weightsOf(dept);

  const row = {
    tasks_total: ts.total, tasks_ontime: ts.ontime, tasks_pct: ts.pct, tasks_returned: ts.returns,
    work_days: at.workDays, ontime_days: at.ontime, late_days: at.late, absent_days: at.absent, excused_days: at.excused, att_pct: at.pct,
    head_score: existing ? existing.head_score : null,
    custom_pct: existing ? existing.custom_pct : null,
    ...w,
    // direktor shu oy uchun qo'lda kiritgan fond (fund_manual=1) kartochkadagi standartdan ustun turadi
    bonus_fund: existing && Number(existing.fund_manual)
      ? (existing.bonus_fund === null ? null : Number(existing.bonus_fund))
      : (emp.bonus_fund === null || emp.bonus_fund === undefined ? null : Number(emp.bonus_fund)),
    salary: emp.salary === null || emp.salary === undefined ? null : Number(emp.salary),
  };
  const gate = checkGate(ts, at, { monthConfirmed: !config.monthStartRequired || (await months.isConfirmed(emp.id, month)) });
  row.kpi_eligible = gate.eligible ? 1 : 0;
  row.kpi_fail = gate.reasons.join('; ') || null;
  row.total = computeTotal(row);
  row.bonus_amount = bonusFor(row);

  await db.query(
    `INSERT INTO kpi_monthly (employee_id, month, tasks_total, tasks_ontime, tasks_pct, work_days, ontime_days, late_days, absent_days,
       excused_days, att_pct, head_score, custom_pct, w_tasks, w_attendance, w_head, w_custom, total, bonus_fund, bonus_amount, status, updated_at, tasks_returned,
       kpi_eligible, kpi_fail, salary, tasks_missed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'draft', $21, $22, $23, $24, $25, $26)
     ON CONFLICT (employee_id, month) DO UPDATE SET
       tasks_total = EXCLUDED.tasks_total, tasks_ontime = EXCLUDED.tasks_ontime, tasks_pct = EXCLUDED.tasks_pct, tasks_returned = EXCLUDED.tasks_returned,
       work_days = EXCLUDED.work_days, ontime_days = EXCLUDED.ontime_days, late_days = EXCLUDED.late_days,
       absent_days = EXCLUDED.absent_days, excused_days = EXCLUDED.excused_days, att_pct = EXCLUDED.att_pct,
       w_tasks = EXCLUDED.w_tasks, w_attendance = EXCLUDED.w_attendance, w_head = EXCLUDED.w_head, w_custom = EXCLUDED.w_custom,
       total = EXCLUDED.total, bonus_fund = EXCLUDED.bonus_fund, bonus_amount = EXCLUDED.bonus_amount, updated_at = EXCLUDED.updated_at,
       kpi_eligible = EXCLUDED.kpi_eligible, kpi_fail = EXCLUDED.kpi_fail, salary = EXCLUDED.salary, tasks_missed = EXCLUDED.tasks_missed`,
    [
      Number(emp.id), month, row.tasks_total, row.tasks_ontime, row.tasks_pct, row.work_days, row.ontime_days, row.late_days,
      row.absent_days, row.excused_days, row.att_pct, row.head_score, row.custom_pct, row.w_tasks, row.w_attendance, row.w_head,
      row.w_custom, row.total, row.bonus_fund, row.bonus_amount, time.stamp(), row.tasks_returned,
      row.kpi_eligible, row.kpi_fail, row.salary, ts.missed,
    ],
  );
  return get(emp.id, month);
};

/** Barcha faol hodimlar uchun oy hisobini yangilaydi */
const computeAll = async (month, opts = {}) => {
  const out = [];
  for (const emp of await employees.listStaff()) out.push(await compute(emp, month, opts));
  return out;
};

/** Qo'lda kiritiladigan maydonlardan keyin totalni qayta hisoblash */
const recalc = async (employeeId, month) => {
  const row = await get(employeeId, month);
  if (!row) return null;
  const total = computeTotal(row);
  await db.query('UPDATE kpi_monthly SET total = $1, bonus_amount = $2, updated_at = $3 WHERE id = $4', [
    total, bonusFor({ ...row, total }), time.stamp(), row.id,
  ]);
  return get(employeeId, month);
};

/**
 * Qo'lda o'zgartirishdan oldin: qator bo'lmasa yaratadi. Tasdiqlangan/chiqarilgan bo'lsa false —
 * hodimga aytilgan summa jimgina o'zgarmasin, avval direktor «Qayta ochish» qiladi.
 */
const editable = async (employeeId, month) => {
  const row = (await get(employeeId, month)) || (await compute(await employees.byId(employeeId), month));
  return Boolean(row) && row.status === 'draft';
};

/** set* funksiyalari qulflangan (draft emas) qatorda null qaytaradi */
const setHeadScore = async (employeeId, month, score, note = null) => {
  if (!(await editable(employeeId, month))) return null;
  await db.query('UPDATE kpi_monthly SET head_score = $1, head_note = $2 WHERE employee_id = $3 AND month = $4', [
    score === null ? null : Math.max(1, Math.min(10, Math.round(Number(score)))), note ? String(note).slice(0, 300) : null, Number(employeeId), month,
  ]);
  return recalc(employeeId, month);
};

const setCustomPct = async (employeeId, month, pct) => {
  if (!(await editable(employeeId, month))) return null;
  await db.query('UPDATE kpi_monthly SET custom_pct = $1 WHERE employee_id = $2 AND month = $3', [
    pct === null ? null : Math.max(0, Math.min(100, Math.round(Number(pct)))), Number(employeeId), month,
  ]);
  return recalc(employeeId, month);
};

/** Shu oy uchun bonus fondi (hodim kartochkasidagi standartdan farq qilishi mumkin) */
const setBonusFund = async (employeeId, month, fund) => {
  if (!(await editable(employeeId, month))) return null;
  await db.query('UPDATE kpi_monthly SET bonus_fund = $1, fund_manual = 1 WHERE employee_id = $2 AND month = $3', [
    fund === null ? null : Math.round(Number(fund)), Number(employeeId), month,
  ]);
  return recalc(employeeId, month);
};

const setNote = (employeeId, month, note) =>
  db.query('UPDATE kpi_monthly SET note = $1 WHERE employee_id = $2 AND month = $3', [note ? String(note).slice(0, 500) : null, Number(employeeId), month]);

/** Direktor qarori: confirmed | excluded | draft (qaytarish) */
const decide = async (employeeId, month, status, byTgId) => {
  await db.query('UPDATE kpi_monthly SET status = $1, decided_by = $2, decided_at = $3 WHERE employee_id = $4 AND month = $5', [
    status, Number(byTgId), status === 'draft' ? null : time.stamp(), Number(employeeId), month,
  ]);
  return get(employeeId, month);
};

const STATUS = { draft: '⏳ Kutmoqda', confirmed: '✅ Tasdiqlangan', excluded: '⛔ Chiqarilgan' };
const statusLabel = (s) => STATUS[s] || STATUS.draft;

const fmtMoney = (n) => (n === null || n === undefined ? '—' : `${Math.round(Number(n)).toLocaleString('ru-RU').replace(/ /g, ' ')} so'm`);

module.exports = {
  get, byId, listMonth, computeTotal, bonusOf, checkGate, bonusFor, payOf, compute, computeAll, recalc, editable, setHeadScore, setCustomPct, setBonusFund, setNote, decide,
  statusLabel, fmtMoney,
};
