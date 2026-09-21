'use strict';

const { DateTime } = require('luxon');
const config = require('./config');

const TZ = config.timezone;

const UZ_WEEKDAYS = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];
const UZ_SHORT = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
const UZ_MONTHS = [
  'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
];

const now = () => DateTime.now().setZone(TZ);

/** 'yyyy-MM-dd' bugungi sana */
const today = () => now().toFormat('yyyy-MM-dd');

/** ISO timestamp (log/audit uchun) */
const stamp = () => now().toISO();

/** 'HH:mm' */
const clock = (iso) => (iso ? DateTime.fromISO(iso).setZone(TZ).toFormat('HH:mm') : '—');

/** ISO vaqt → kun boshidan o'tgan daqiqalar (Toshkent bo'yicha) */
const minutesOfDay = (iso) => {
  if (!iso) return null;
  const d = DateTime.fromISO(iso).setZone(TZ);
  return d.isValid ? d.hour * 60 + d.minute : null;
};

const dt = (dateStr) => DateTime.fromISO(dateStr, { zone: TZ });
const fmt = (d) => d.toFormat('yyyy-MM-dd');

const addDays = (dateStr, n) => fmt(dt(dateStr).plus({ days: n }));

const diffDays = (fromDate, toDate) => Math.round(dt(toDate).diff(dt(fromDate), 'days').days);

/** '19-avgust, Chorshanba' */
const prettyDate = (dateStr) => {
  const d = dt(dateStr);
  return `${d.day}-${UZ_MONTHS[d.month - 1]}, ${UZ_WEEKDAYS[d.weekday - 1]}`;
};

/** Hozir ish vaqti ichidami (soat bo'yicha) */
const isWorkHours = () => {
  const h = now().hour;
  return h >= config.workStartHour && h <= config.workEndHour;
};

// ---------------------------------------------------------------------------
// SANA ORALIG'I (davr hisobotlari uchun)
// ---------------------------------------------------------------------------

const startOfMonth = (dateStr) => fmt(dt(dateStr).startOf('month'));
const endOfMonth = (dateStr) => fmt(dt(dateStr).endOf('month'));
/** Hafta boshi — dushanba */
const startOfWeek = (dateStr) => fmt(dt(dateStr).startOf('week'));
/** Hafta oxiri — yakshanba */
const endOfWeek = (dateStr) => fmt(dt(dateStr).endOf('week'));
const addMonths = (dateStr, n) => fmt(dt(dateStr).plus({ months: n }));

/** Oralig'dagi kunlar soni (ikkala chegara ham kiradi) */
const daysIn = (from, to) => diffDays(from, to) + 1;

/** '07.09' — jadval uchun qisqa sana */
const shortDate = (dateStr) => `${dateStr.slice(8, 10)}.${dateStr.slice(5, 7)}`;

/** 'Du' — qisqa hafta kuni */
const weekdayShort = (dateStr) => UZ_SHORT[dt(dateStr).weekday - 1];

/** Dam olish kunimi (yakshanba) */
const isSunday = (dateStr) => dt(dateStr).weekday === 7;

/** 'sentabr 2026' — kalendar sarlavhasi */
const monthLabel = (dateStr) => {
  const d = dt(dateStr);
  return `${UZ_MONTHS[d.month - 1]} ${d.year}`;
};

/** '1 — 7-sentabr, 2026' ko'rinishidagi davr sarlavhasi */
const prettyRange = (from, to) => {
  const a = dt(from);
  const b = dt(to);
  if (from === to) return prettyDate(from);
  const left = a.year === b.year && a.month === b.month
    ? `${a.day}`
    : `${a.day}-${UZ_MONTHS[a.month - 1]}${a.year === b.year ? '' : ` ${a.year}`}`;
  return `${left} — ${b.day}-${UZ_MONTHS[b.month - 1]}, ${b.year}`;
};

/** Sana to'g'rimi ('yyyy-MM-dd') */
const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && dt(String(s)).isValid;

/**
 * Foydalanuvchi yozgan sanani o'qiydi:
 * '2026-09-07', '07.09.2026', '7.9.2026', '07/09/2026', '7-sentabr', '7 sentabr'.
 * Yil ko'rsatilmasa — joriy yil. Tushunilmasa null.
 */
const parseDate = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (m) {
    const d = DateTime.fromObject({ year: +m[1], month: +m[2], day: +m[3] }, { zone: TZ });
    return d.isValid ? fmt(d) : null;
  }

  m = s.match(/^(\d{1,2})[-./](\d{1,2})(?:[-./](\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? Number(m[3]) : now().year;
    if (year < 100) year += 2000;
    const d = DateTime.fromObject({ year, month: +m[2], day: +m[1] }, { zone: TZ });
    return d.isValid ? fmt(d) : null;
  }

  m = s.match(/^(\d{1,2})[-\s]*([a-zA-Zʼ'`]+)\s*(\d{4})?$/);
  if (m) {
    const idx = UZ_MONTHS.findIndex((x) => x.startsWith(m[2].slice(0, 3)));
    if (idx >= 0) {
      const d = DateTime.fromObject(
        { year: m[3] ? Number(m[3]) : now().year, month: idx + 1, day: +m[1] }, { zone: TZ },
      );
      return d.isValid ? fmt(d) : null;
    }
  }
  return null;
};

/** 512 → "8 soat 32 daqiqa" */
const prettyDuration = (minutes) => {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} daqiqa`;
  return m ? `${h} soat ${m} daqiqa` : `${h} soat`;
};

/** 545 → '09:05' */
const hhmm = (mins) => {
  if (mins === null || mins === undefined) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// OY ('yyyy-MM') — KPI va oylik hisobotlar uchun
// ---------------------------------------------------------------------------

/** Joriy oy: '2026-09' */
const month = () => now().toFormat('yyyy-MM');

/** Sananing oyi: '2026-09-17' → '2026-09' */
const monthOf = (dateStr) => String(dateStr).slice(0, 7);

/** '2026-09' → { from: '2026-09-01', to: '2026-09-30' } */
const monthRange = (m) => {
  const d = DateTime.fromISO(`${m}-01`, { zone: TZ });
  return { from: fmt(d.startOf('month')), to: fmt(d.endOf('month')) };
};

/** '2026-09' + (-1) → '2026-08' */
const shiftMonth = (m, n) => DateTime.fromISO(`${m}-01`, { zone: TZ }).plus({ months: n }).toFormat('yyyy-MM');

/** O'tgan oy */
const prevMonth = () => shiftMonth(month(), -1);

/** '2026-09' → 'sentabr 2026' */
const monthName = (m) => monthLabel(`${m}-01`);

/** 'yyyy-MM' ko'rinishi to'g'rimi */
const isValidMonth = (m) => /^\d{4}-\d{2}$/.test(String(m)) && DateTime.fromISO(`${m}-01`, { zone: TZ }).isValid;

/** Ish kunimi (WORK_DAYS bo'yicha) */
const isWorkDay = (dateStr) => config.workDaySet.has(dt(dateStr).weekday);

/** Oraliqdagi ish kunlari (bugundan keyingilari hisobga olinmaydi) */
const workDaysBetween = (from, to, upTo = today()) => {
  const out = [];
  const last = to < upTo ? to : upTo;
  for (let d = from; d <= last; d = addDays(d, 1)) if (isWorkDay(d)) out.push(d);
  return out;
};

module.exports = {
  TZ, now, today, stamp, clock, minutesOfDay, addDays, diffDays, prettyDate, isWorkHours,
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, addMonths, daysIn,
  shortDate, weekdayShort, isSunday, monthLabel, prettyRange, isValidDate, parseDate,
  prettyDuration, hhmm, UZ_MONTHS, UZ_SHORT, UZ_WEEKDAYS,
  month, monthOf, monthRange, shiftMonth, prevMonth, monthName, isValidMonth, isWorkDay, workDaysBetween,
};
