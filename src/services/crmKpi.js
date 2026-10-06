'use strict';

const config = require('../config');
const time = require('../time');
const employees = require('./employees');
const period = require('./period');
const kpi = require('./kpi');

/**
 * CRM UCHUN OYLIK KPI (faqat o'qish) — `GET /crm/kpi?month=YYYY-MM` (health.handleCrm, x-crm-secret).
 *
 * BAYLOG CRM → AI yordamchi → KPI shu ma'lumotni CRM Vazifalar moduli bilan birga ko'rsatadi.
 * Har hodim: topshiriqlar (tasks.stats — KPI bilan bir xil), davomat (attendance.stats), kunlik hisobotlar
 * (period.employeeStats — davr hisoboti / Excel bilan bir xil son) va oylik KPI (kpi.preview — BAZAGA YOZMAYDI:
 * tasdiqlangan bo'lsa o'sha qator, aks holda compute formulasi bo'yicha hozirgi holat).
 * 6-okt (2-bosqich, direktor qarori): oklad, vaznlar va rejim ham beriladi — CRM "KPI va oylik" jadvali
 * (oklad + KPI summasi = jami oylik). CRM'dan sozlash — `setFromCrm` (POST /crm/kpi/set).
 */

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const monthKpi = async (monthRaw) => {
  const month = time.isValidMonth(monthRaw) ? monthRaw : time.month();
  const { from, to } = time.monthRange(month);
  const today = time.today();
  const future = from > today;
  const toEff = to > today ? today : to;

  const rows = [];
  for (const emp of await employees.listStaff()) {
    const st = future ? null : await period.employeeStats(emp, from, toEff);
    const k = future ? null : await kpi.preview(emp, month);
    const ts = st ? st.ts : null;
    rows.push({
      employeeId: String(emp.id),
      name: emp.full_name,
      position: emp.position || '',
      department: emp.department_name || emp.custom_name || '',
      tasks: ts
        ? {
          due: ts.total, // muddati shu oyda kelgan (bugungacha)
          accepted: ts.accepted, // qabul qilingan
          ontime: ts.ontime, // muddatida qabul qilingan
          late: ts.late, // kech qabul qilingan
          awaiting: ts.awaiting, // topshirilgan, tekshiruvda
          open: ts.open, // hali bajarilmagan
          overdue: ts.overdue, // muddati o'tgan, ochiq
          returns: ts.returns, // qaytarishlar soni
          pct: ts.pct, // KPI topshiriq % (muddatida ÷ muddati kelgan − qaytarish)
          created: st.createdCount, // oyda yozilgan
          doneInMonth: st.doneCount, // oyda bajarilgan (sana bo'yicha)
        }
        : null,
      attendance: st
        ? {
          workDays: st.workDays, // o'tgan ish kunlari
          workedDays: st.workedDays,
          lateDays: st.lateDays,
          lateMinutes: st.lateMinutes,
          absentDays: st.absentDays,
          excusedDays: st.excusedDays,
          pct: st.attPct,
          avgArrival: st.avgArrival,
          hours: Math.round((st.totalMinutes / 60) * 10) / 10,
        }
        : null,
      reportDays: st ? st.reportDays : null,
      kpi: k
        ? {
          total: num(k.total), // yakuniy ball 0–100
          tasksPct: num(k.tasks_pct),
          attPct: num(k.att_pct),
          headScore: num(k.head_score), // boshliq bahosi 1–10
          customPct: num(k.custom_pct),
          eligible: Number(k.kpi_eligible) === 1,
          fail: k.kpi_fail || null,
          status: k.status || 'draft', // draft | confirmed | excluded
          saved: Boolean(k.saved),
          bonusFund: num(k.bonus_fund),
          bonusAmount: num(k.bonus_amount),
          salary: num(k.salary),
          weights: { tasks: num(k.w_tasks), attendance: num(k.w_attendance), head: num(k.w_head), custom: num(k.w_custom) },
        }
        : null,
      // Hodim kartochkasidagi standartlar (keyingi oylar ham shundan boshlanadi)
      defaults: { bonusFund: num(emp.bonus_fund), salary: num(emp.salary) },
    });
  }
  return { month, from, to: toEff, mode: config.kpiMode, generatedAt: new Date().toISOString(), rows };
};

/** null | 0..max son; noto'g'ri qiymat — undefined (xato) */
const money = (v) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1e11 ? Math.round(n) : undefined;
};

/**
 * CRM'dan KPI sozlash (POST /crm/kpi/set) — faqat bosh direktor (CRM tekshiradi). Bot o'z funksiyalari bilan yozadi:
 *   bonusFund — KPI summasi (100% da): hodim kartochkasi (employees.setBonusFund) + shu oy qatori (kpi.setBonusFund)
 *   salary    — oklad: hodim kartochkasi (employees.setSalary) + shu oy qatori qayta hisoblanadi (snapshot)
 *   headScore — boshliq bahosi 1–10 (kpi.setHeadScore), customPct — maxsus mezon 0–100 (kpi.setCustomPct)
 * Tasdiqlangan/chiqarilgan oy QULF: oy maydonlari o'zgarmaydi (`locked`), kartochka standartlari baribir saqlanadi.
 * Qaytadi: { ok, locked, row } yoki { error }.
 */
const setFromCrm = async (body = {}) => {
  const month = time.isValidMonth(body.month) ? body.month : time.month();
  if (month > time.month()) return { error: 'future_month' };
  const emp = await employees.byId(Number(body.employeeId));
  if (!emp || !emp.active) return { error: 'not_found' };
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  const fund = has('bonusFund') ? money(body.bonusFund) : undefined;
  const salary = has('salary') ? money(body.salary) : undefined;
  if ((has('bonusFund') && fund === undefined) || (has('salary') && salary === undefined)) return { error: 'bad_amount' };
  let head;
  if (has('headScore')) {
    head = body.headScore === null || body.headScore === '' ? null : Number(body.headScore);
    if (head !== null && !(Number.isInteger(head) && head >= 1 && head <= 10)) return { error: 'bad_score' };
  }
  let custom;
  if (has('customPct')) {
    custom = body.customPct === null || body.customPct === '' ? null : Number(body.customPct);
    if (custom !== null && !(Number.isFinite(custom) && custom >= 0 && custom <= 100)) return { error: 'bad_pct' };
  }

  // Kartochka standartlari — qulfdan qat'i nazar
  if (fund !== undefined) await employees.setBonusFund(emp.id, fund);
  if (salary !== undefined) await employees.setSalary(emp.id, salary);

  const locked = !(await kpi.editable(emp.id, month));
  if (!locked) {
    if (salary !== undefined) await kpi.compute(await employees.byId(emp.id), month); // oklad snapshot
    if (fund !== undefined) await kpi.setBonusFund(emp.id, month, fund);
    if (head !== undefined) await kpi.setHeadScore(emp.id, month, head, body.note ? `CRM: ${String(body.note).slice(0, 200)}` : 'CRM');
    if (custom !== undefined) await kpi.setCustomPct(emp.id, month, custom);
  }
  console.log(`[crm] KPI sozlandi: ${emp.full_name} ${month} ${JSON.stringify({ fund, salary, head, custom, locked, by: String(body.by || '').slice(0, 60) })}`);
  const fresh = await employees.byId(emp.id);
  const row = await kpi.preview(fresh, month);
  return { ok: true, locked, row: { total: num(row.total), bonusFund: num(row.bonus_fund), bonusAmount: num(row.bonus_amount), salary: num(row.salary), headScore: num(row.head_score), customPct: num(row.custom_pct), status: row.status } };
};

module.exports = { monthKpi, setFromCrm };
