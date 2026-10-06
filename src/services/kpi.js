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

/**
 * KPI SHARTI (3-okt qarori): oyiga MIN_DAYS (standart 25) kun vaqtida kelish va topshiriqlarning ≥ MIN_TASK_PCT (90%)
 * muddatida bajarilishi. Boshliq Panel → «🚦 KPI sharti» dan o'zgartiradi (settings kpi_min_days / kpi_task_pct).
 *   - kech kelgan kun hisobga kirmaydi; rahbariyat uni sababli qilsa (yoki LATE_NOTICE_MIN_BEFORE daq oldin ogohlantirgan bo'lsa) — kiradi;
 *   - sababli kunlar talabni kamaytiradi (2 sababli → 23 kun); dam olish kuni kelgani ham kelgan kunlarga qo'shiladi;
 *   - oyda ish kunlari kamroq bo'lsa (fevral) — talab ish kunlaridan oshmaydi; oy o'rtasida qo'shilgan hodim va
 *     joriy oy uchun talab o'tgan ish kunlariga mutanosib.
 */
const GATE_DAYS_KEY = 'kpi_min_days';
const GATE_TASK_KEY = 'kpi_task_pct';
const GATE_DEFAULTS = { minDays: 25, minTaskPct: 90 };
const intIn = (v, def, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
};
const gateSettings = async () => ({
  minDays: intIn(await db.getSetting(GATE_DAYS_KEY), GATE_DEFAULTS.minDays, 1, 31),
  minTaskPct: intIn(await db.getSetting(GATE_TASK_KEY), GATE_DEFAULTS.minTaskPct, 0, 100),
});
const setGateSettings = async ({ minDays, minTaskPct } = {}) => {
  if (minDays !== undefined) await db.setSetting(GATE_DAYS_KEY, String(intIn(minDays, GATE_DEFAULTS.minDays, 1, 31)));
  if (minTaskPct !== undefined) await db.setSetting(GATE_TASK_KEY, String(intIn(minTaskPct, GATE_DEFAULTS.minTaskPct, 0, 100)));
  return gateSettings();
};

/** KPI sharti: { eligible, reasons[], required, attended } — ts: tasks.stats, at: attendance.stats */
const checkGate = (ts, at, { monthConfirmed = true, minDays = GATE_DEFAULTS.minDays, minTaskPct = GATE_DEFAULTS.minTaskPct, monthWorkDays = null } = {}) => {
  const reasons = [];
  const counted = (Number(at.workDays) || 0) + (Number(at.excused) || 0);
  const full = Math.max(Number(monthWorkDays) || counted, counted);
  const cap = Math.min(minDays, full);
  const required = full ? Math.max(0, Math.round((cap * counted) / full) - (Number(at.excused) || 0)) : 0;
  const attended = (Number(at.ontime) || 0) + (Number(at.extra) || 0);
  if (attended < required) {
    const why = [at.late ? `${at.late} kech` : '', at.absent ? `${at.absent} kelmagan` : ''].filter(Boolean).join(', ');
    reasons.push(`vaqtida kelgan kunlar ${attended}/${required}${why ? ` (${why})` : ''}`);
  }
  const tp = ts.gatePct === undefined ? ts.pct : ts.gatePct;
  if (Number(ts.total) > 0 && tp !== undefined && tp < minTaskPct) reasons.push(`topshiriqlar ${tp}% muddatida (kerak ≥${minTaskPct}%)`);
  if (!monthConfirmed) reasons.push('oy boshi tasdiqlanmagan');
  return { eligible: reasons.length === 0, reasons, required, attended };
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

/**
 * Oy qatorini HISOBLAYDI (bazaga yozmaydi) — compute (saqlaydi) va preview (CRM, faqat o'qish) uchun umumiy.
 * `existing` — shu oy uchun saqlangan qator (boshliq bahosi, mezon, qo'lda KPI summasi undan olinadi).
 */
const buildRow = async (emp, month, existing) => {
  const { from, to } = time.monthRange(month);
  const ts = await tasks.stats(emp.id, from, to);
  const at = await attendance.stats(emp, from, to);
  const dept = emp.department_id ? await departments.byId(emp.department_id) : null;
  const w = departments.weightsOf(dept);
  const gs = await gateSettings();
  const monthWorkDays = time.workDaysBetween(from, to, to).length;
  // qo'lda o'zgartirilgan shu oy KPI summasi saqlanadi (kartochkadagi standart ustidan yozilmaydi)
  const manualFund = existing && Number(existing.fund_manual) === 1;

  const row = {
    tasks_total: ts.total, tasks_ontime: ts.ontime, tasks_pct: ts.pct, tasks_returned: ts.returns,
    work_days: at.workDays, ontime_days: at.ontime, late_days: at.late, absent_days: at.absent, excused_days: at.excused, att_pct: at.pct,
    head_score: existing ? existing.head_score : null,
    custom_pct: existing ? existing.custom_pct : null,
    ...w,
    bonus_fund: manualFund ? (existing.bonus_fund === null ? null : Number(existing.bonus_fund))
      : emp.bonus_fund === null || emp.bonus_fund === undefined ? null : Number(emp.bonus_fund),
    salary: emp.salary === null || emp.salary === undefined ? null : Number(emp.salary),
  };
  const gate = checkGate(ts, at, { monthConfirmed: !config.monthStartRequired || (await months.isConfirmed(emp.id, month)), ...gs, monthWorkDays });
  row.kpi_eligible = gate.eligible ? 1 : 0;
  row.kpi_fail = gate.reasons.join('; ') || null;
  row.total = computeTotal(row);
  row.bonus_amount = bonusFor(row);
  return { row, ts, at, gate };
};

/** Avto qismlarni qayta hisoblab saqlaydi. Tasdiqlangan/chiqarilgan qator (force bo'lmasa) o'zgarmaydi. */
const compute = async (emp, month, { force = false } = {}) => {
  const existing = await get(emp.id, month);
  if (existing && existing.status !== 'draft' && !force) return existing;
  const { row, ts, at, gate } = await buildRow(emp, month, existing);

  await db.query(
    `INSERT INTO kpi_monthly (employee_id, month, tasks_total, tasks_ontime, tasks_pct, work_days, ontime_days, late_days, absent_days,
       excused_days, att_pct, head_score, custom_pct, w_tasks, w_attendance, w_head, w_custom, total, bonus_fund, bonus_amount, status, updated_at, tasks_returned,
       kpi_eligible, kpi_fail, salary, tasks_missed, extra_days, required_days, tasks_gate_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'draft', $21, $22, $23, $24, $25, $26, $27, $28, $29)
     ON CONFLICT (employee_id, month) DO UPDATE SET
       tasks_total = EXCLUDED.tasks_total, tasks_ontime = EXCLUDED.tasks_ontime, tasks_pct = EXCLUDED.tasks_pct, tasks_returned = EXCLUDED.tasks_returned,
       work_days = EXCLUDED.work_days, ontime_days = EXCLUDED.ontime_days, late_days = EXCLUDED.late_days,
       absent_days = EXCLUDED.absent_days, excused_days = EXCLUDED.excused_days, att_pct = EXCLUDED.att_pct,
       w_tasks = EXCLUDED.w_tasks, w_attendance = EXCLUDED.w_attendance, w_head = EXCLUDED.w_head, w_custom = EXCLUDED.w_custom,
       total = EXCLUDED.total, bonus_fund = EXCLUDED.bonus_fund, bonus_amount = EXCLUDED.bonus_amount, updated_at = EXCLUDED.updated_at,
       kpi_eligible = EXCLUDED.kpi_eligible, kpi_fail = EXCLUDED.kpi_fail, salary = EXCLUDED.salary, tasks_missed = EXCLUDED.tasks_missed,
       extra_days = EXCLUDED.extra_days, required_days = EXCLUDED.required_days, tasks_gate_pct = EXCLUDED.tasks_gate_pct`,
    [
      Number(emp.id), month, row.tasks_total, row.tasks_ontime, row.tasks_pct, row.work_days, row.ontime_days, row.late_days,
      row.absent_days, row.excused_days, row.att_pct, row.head_score, row.custom_pct, row.w_tasks, row.w_attendance, row.w_head,
      row.w_custom, row.total, row.bonus_fund, row.bonus_amount, time.stamp(), row.tasks_returned,
      row.kpi_eligible, row.kpi_fail, row.salary, ts.missed, at.extra || 0, gate.required, ts.gatePct,
    ],
  );
  return get(emp.id, month);
};

/**
 * CRM uchun — BAZAGA YOZMAYDI. Tasdiqlangan/chiqarilgan qator bo'lsa o'sha (direktor qarori), aks holda
 * compute bilan bir xil formula bo'yicha hozirgi holat. `saved` — kpi_monthly da qator bormi.
 */
const preview = async (emp, month) => {
  const existing = await get(emp.id, month);
  if (existing && existing.status !== 'draft') return { ...existing, saved: true };
  const { row } = await buildRow(emp, month, existing);
  return { ...row, status: existing ? existing.status : 'draft', saved: Boolean(existing) };
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
  if (row.status !== 'draft') return row; // tasdiqlangan/chiqarilgan oy muzlatilgan
  const total = computeTotal(row);
  await db.query('UPDATE kpi_monthly SET total = $1, bonus_amount = $2, updated_at = $3 WHERE id = $4', [
    total, bonusFor({ ...row, total }), time.stamp(), row.id,
  ]);
  return get(employeeId, month);
};

/**
 * Tahrirga ochiqmi: qator yo'q bo'lsa hisoblab yaratadi. Tasdiqlangan/chiqarilgan bo'lsa false —
 * hodimga aytilgan summa jimgina o'zgarmasin, avval direktor «Qayta ochish» qiladi.
 */
const editable = async (employeeId, month) => {
  const row = (await get(employeeId, month)) || (await compute(await employees.byId(employeeId), month));
  return Boolean(row) && row.status === 'draft';
};
const isLocked = async (employeeId, month) => !(await editable(employeeId, month));

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

/**
 * Tasdiqlash/chiqarishga to'siq (null — mumkin): oy tugamagan, hal qilinmagan sababli kun so'rovi bor.
 */
const decideBlock = async (employeeId, month) => {
  if (month >= time.month()) return `${time.monthName(month)} hali tugamagan — oy yakunida tasdiqlanadi`;
  const { from, to } = time.monthRange(month);
  const p = await db.one(
    "SELECT COUNT(*) AS n FROM attendance WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3 AND excuse_status = 'pending'",
    [Number(employeeId), from, to],
  );
  if (p && Number(p.n) > 0) return `${p.n} ta «Kelmayman» so'rovi hal qilinmagan — avval sababli/sababsiz deb belgilang`;
  return null;
};

/**
 * Direktor qarori: confirmed | excluded — faqat «kutmoqda» dan (eski tugma qayta bosilsa o'zgarmaydi); draft — qayta ochish.
 * Natija: qator; o'tmagan bo'lsa row.blocked = sabab.
 */
const decide = async (employeeId, month, status, byTgId) => {
  if (status !== 'draft') {
    const why = await decideBlock(employeeId, month);
    if (why) return { ...(await get(employeeId, month)), blocked: why };
  }
  const rows = await db.query(
    `UPDATE kpi_monthly SET status = $1, decided_by = $2, decided_at = $3 WHERE employee_id = $4 AND month = $5
       AND (${status === 'draft' ? "status <> 'draft'" : "status = 'draft'"}) RETURNING id`,
    [status, Number(byTgId), status === 'draft' ? null : time.stamp(), Number(employeeId), month],
  );
  const row = await get(employeeId, month);
  return rows.length ? row : { ...row, blocked: 'allaqachon hal qilingan' };
};

const STATUS = { draft: '⏳ Kutmoqda', confirmed: '✅ Tasdiqlangan', excluded: '⛔ Chiqarilgan' };
const statusLabel = (s) => STATUS[s] || STATUS.draft;

const fmtMoney = (n) => (n === null || n === undefined ? '—' : `${Math.round(Number(n)).toLocaleString('ru-RU').replace(/ /g, ' ')} so'm`);

module.exports = {
  get, byId, listMonth, computeTotal, bonusOf, checkGate, bonusFor, payOf, compute, preview, computeAll, recalc, editable, setHeadScore, setCustomPct, setBonusFund, setNote, decide,
  decideBlock, isLocked, gateSettings, setGateSettings, GATE_DEFAULTS,
  statusLabel, fmtMoney,
};
