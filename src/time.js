'use strict';

const { DateTime } = require('luxon');
const config = require('./config');

const TZ = config.timezone;

const UZ_WEEKDAYS = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];
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

const addDays = (dateStr, n) =>
  DateTime.fromISO(dateStr, { zone: TZ }).plus({ days: n }).toFormat('yyyy-MM-dd');

const diffDays = (fromDate, toDate) =>
  Math.round(
    DateTime.fromISO(toDate, { zone: TZ }).diff(DateTime.fromISO(fromDate, { zone: TZ }), 'days').days,
  );

/** '19-avgust, Chorshanba' */
const prettyDate = (dateStr) => {
  const d = DateTime.fromISO(dateStr, { zone: TZ });
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

const dt = (dateStr) => DateTime.fromISO(dateStr, { zone: TZ });
const fmt = (d) => d.toFormat('yyyy-MM-dd');

/** Oyning birinchi kuni: '2026-09-17' → '2026-09-01' */
const startOfMonth = (dateStr) => fmt(dt(dateStr).startOf('month'));

/** Oyning oxirgi kuni */
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

const UZ_SHORT = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

/** 'Du' — qisqa hafta kuni */
const weekdayShort = (dateStr) => UZ_SHORT[dt(dateStr).weekday - 1];

/** Dam olish kunimi (yakshanba) */
const isSunday = (dateStr) => dt(dateStr).weekday === 7;

/** 'sentabr 2026' — kalendar sarlavhasi */
const monthLabel = (dateStr) => {
  const d = dt(dateStr);
  return `${UZ_MONTHS[d.month - 1]} ${d.year}`;
};

/** '1-sentabr — 7-sentabr, 2026' ko'rinishidagi davr sarlavhasi */
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
    const d = DateTime.fromObject(
      { year: +m[1], month: +m[2], day: +m[3] }, { zone: TZ },
    );
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

module.exports = {
  TZ, now, today, stamp, clock, addDays, diffDays, prettyDate, isWorkHours,
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, addMonths, daysIn,
  shortDate, weekdayShort, isSunday, monthLabel, prettyRange, isValidDate, parseDate,
  UZ_MONTHS, UZ_SHORT,
};
