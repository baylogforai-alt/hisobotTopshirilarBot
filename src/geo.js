'use strict';

/** Ikki koordinata orasidagi masofa (metrda) — Haversine formulasi */
const distanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Yer radiusi, metr
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
};

/** Masofani odam o'qiy oladigan ko'rinishga: 340 m / 1.2 km */
const prettyDistance = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

module.exports = { distanceMeters, prettyDistance };
