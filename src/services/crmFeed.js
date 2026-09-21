'use strict';

const db = require('../db');
const time = require('../time');

/**
 * CRM UCHUN QISQA HISOBOT (faqat o'qish).
 *
 * BAYLOG CRM "Vazifalar > Bot vazifalari" bo'limida shu ma'lumotni ko'rsatadi:
 * kim ishga keldi/ketdi va qaysi missiya qaysi kunga tegishli.
 *
 * Nega baza emas, HTTP? Bot va CRM Railway'da AYRIM loyihalarda turadi —
 * biri ikkinchisining ichki tarmog'iga kira olmaydi. Bazani internetga ochish
 * o'rniga bitta o'qiydigan manzil ochamiz: kalitsiz hech kim ko'ra olmaydi va
 * bu yerdan hech narsa o'zgartirib bo'lmaydi.
 *
 * Yozuv yo'q — faqat SELECT.
 */

/** ISO vaqtdan "HH:MM" (Toshkent) */
const clock = (iso) => (iso ? time.clock(iso) : null);

const minutesBetween = (a, b) => {
  const x = Date.parse(a || '');
  const y = Date.parse(b || '');
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= x) return null;
  return Math.round((y - x) / 60000);
};

const snapshot = async () => {
  const today = time.today();
  const tomorrow = time.addDays(today, 1);

  /* Ochiq topshiriqlar (active) + tekshiruvdagilar (done) + BUGUN qabul qilinganlari.
     Bekor qilinganlari ko'rsatilmaydi — ular hodim tomonidan o'chirilgan. */
  const missionRows = await db.query(
    `SELECT m.id, m.employee_id, m.title, m.status, m.priority, m.source, m.proof_note AS note,
            m.start_date, m.due_date, m.done_at, m.returned_count,
            e.full_name, COALESCE(e.position, '') AS position
       FROM tasks m
       JOIN employees e ON e.id = m.employee_id
      WHERE e.active = 1
        AND ( m.status IN ('active','done')
              OR (m.status = 'accepted' AND substr(m.done_at, 1, 10) = $1) )
      ORDER BY m.due_date ASC, m.id ASC`,
    [today],
  );

  const missions = missionRows.map((r) => {
    const due = String(r.due_date || '');
    let bucket;
    if (r.status === 'accepted' || r.status === 'done') bucket = 'done';
    else if (due < today) bucket = 'overdue';
    else if (due === today) bucket = 'today';
    else if (due === tomorrow) bucket = 'tomorrow';
    else bucket = 'later';

    return {
      id: String(r.id),
      employeeId: String(r.employee_id),
      employeeName: String(r.full_name || ''),
      position: String(r.position || ''),
      title: String(r.title || ''),
      status: String(r.status || ''),
      priority: String(r.priority || 'normal'),
      source: String(r.source || 'self'),
      returned: Number(r.returned_count) || 0,
      startDate: String(r.start_date || ''),
      dueDate: due,
      doneAt: clock(r.done_at) || undefined,
      note: r.note ? String(r.note) : undefined,
      bucket,
    };
  });

  /* Bugungi davomat — kelmaganlar ham chiqadi (LEFT JOIN) */
  const attRows = await db.query(
    `SELECT e.id AS employee_id, e.full_name, COALESCE(e.position, '') AS position,
            a.checked_in, a.checked_out, a.intent, a.late_minutes, a.excuse_status,
            r.text AS report_text, r.submitted_at AS report_at
       FROM employees e
       LEFT JOIN daily_reports r ON r.employee_id = e.id AND r.work_date = $1
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
      WHERE e.active = 1
      ORDER BY lower(e.full_name)`,
    [today],
  );

  const attendance = attRows.map((r) => {
    const inAt = clock(r.checked_in);
    const outAt = clock(r.checked_out);
    return {
      employeeId: String(r.employee_id),
      name: String(r.full_name || ''),
      position: String(r.position || ''),
      in: inAt || undefined,
      out: outAt || undefined,
      intent: r.intent ? String(r.intent) : undefined,
      lateMinutes: Number(r.late_minutes) > 0 ? Number(r.late_minutes) : undefined,
      excused: r.excuse_status === 'approved' ? true : undefined,
      minutes: minutesBetween(r.checked_in, r.checked_out) || undefined,
      dailyReport: r.report_text ? { text: String(r.report_text), at: clock(r.report_at) } : undefined,
      state: outAt ? 'left' : inAt ? 'working' : r.excuse_status === 'approved' ? 'excused' : 'absent',
    };
  });

  const count = (b) => missions.filter((m) => m.bucket === b).length;

  return {
    today,
    missions,
    attendance,
    totals: {
      overdue: count('overdue'),
      today: count('today'),
      tomorrow: count('tomorrow'),
      later: count('later'),
      doneToday: count('done'),
      working: attendance.filter((a) => a.state === 'working').length,
      absent: attendance.filter((a) => a.state === 'absent').length,
      reports: attendance.filter((a) => a.dailyReport).length,
      staff: attendance.length,
    },
  };
};

module.exports = { snapshot };
