'use strict';

const db = require('../db');
const config = require('../config');

/**
 * Ofis geofence sozlamalari settings jadvalida saqlanadi (redeploy shart emas).
 * .env dagi qiymatlar faqat boshlang'ich standart sifatida ishlatiladi.
 */
const DEFAULT_RADIUS = config.officeRadiusM || 250;

const get = async () => {
  const lat = await db.getSetting('office_lat');
  const lon = await db.getSetting('office_lon');
  const radius = await db.getSetting('office_radius_m');
  // null yoki bo'sh string (clear() dan keyin) — o'rnatilmagan hisoblanadi
  if (!lat || !lon) {
    if (config.officeLat !== null && config.officeLon !== null) {
      return { lat: config.officeLat, lon: config.officeLon, radius: DEFAULT_RADIUS, source: 'env' };
    }
    return null;
  }
  return {
    lat: Number(lat),
    lon: Number(lon),
    radius: radius !== null ? Number(radius) : DEFAULT_RADIUS,
    source: 'db',
  };
};

const set = async (lat, lon, radius = DEFAULT_RADIUS) => {
  await db.setSetting('office_lat', String(lat));
  await db.setSetting('office_lon', String(lon));
  await db.setSetting('office_radius_m', String(radius));
  return { lat, lon, radius };
};

const clear = async () => {
  await db.setSetting('office_lat', '');
  await db.setSetting('office_lon', '');
  // bo'sh string → get() da null bo'lib ko'rinishi uchun alohida tekshiramiz
};

module.exports = { get, set, clear, DEFAULT_RADIUS };
