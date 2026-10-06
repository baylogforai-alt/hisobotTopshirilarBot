'use strict';

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
 * Oklad (salary) CRM'ga berilmaydi.
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
        }
        : null,
    });
  }
  return { month, from, to: toEff, generatedAt: new Date().toISOString(), rows };
};

module.exports = { monthKpi };
