'use strict';

/**
 * Telegram API bilan XAVFSIZ ishlash.
 *
 * v1 da xabar yuborishda xato bo'lsa shunchaki konsolga yozilardi. Endi:
 *  • 429 (Too Many Requests) — Telegram aytgan `retry_after` soniyani kutib,
 *    qayta urinadi (ko'p hodimga ketma-ket yuborganda tez-tez bo'ladi);
 *  • 403 (bot bloklangan) / 400 (chat topilmadi) — jim o'tkaziladi, null qaytadi;
 *  • ommaviy yuborishda har bir xabar orasida qisqa pauza (`throttle`).
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ommaviy yuborishlar orasidagi pauza (ms) — Telegram limiti ~30 xabar/soniya */
const THROTTLE_MS = 60;

const codeOf = (err) => Number((err && (err.response?.error_code || err.code)) || 0);

const retryAfterMs = (err) => {
  const s = err && err.response && err.response.parameters && err.response.parameters.retry_after;
  return Number.isFinite(Number(s)) ? Number(s) * 1000 + 250 : 0;
};

/**
 * fn() ni bajaradi; 429 bo'lsa kutib qayta urinadi (2 martagacha).
 * Boshqa xatolarda null qaytaradi va sababini konsolga yozadi.
 */
const safe = async (fn, label = 'telegram') => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const code = codeOf(err);
      if (code === 429 && attempt < 2) {
        const wait = retryAfterMs(err) || 1500;
        console.warn(`[${label}] 429 — ${Math.round(wait / 1000)}s kutamiz`);
        await sleep(wait);
        continue;
      }
      const desc = (err && (err.description || err.message)) || String(err);
      if (code === 403) {
        console.warn(`[${label}] bloklangan yoki chatdan chiqqan: ${desc}`);
      } else if (/message is not modified/i.test(desc)) {
        // Matn o'zgarmagan — bu xato emas
      } else {
        console.error(`[${label}] xato:`, desc);
      }
      return null;
    }
  }
  return null;
};

const throttle = () => sleep(THROTTLE_MS);

module.exports = { safe, sleep, throttle, codeOf };
