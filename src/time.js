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

module.exports = { TZ, now, today, stamp, clock, addDays, diffDays, prettyDate, isWorkHours };
