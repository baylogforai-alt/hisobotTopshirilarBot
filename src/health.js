'use strict';

const { timingSafeEqual } = require('node:crypto');
const config = require('./config');
const crmFeed = require('./services/crmFeed');

/**
 * CRM uchun faqat o'qiladigan manzil — web/server.js ichidan chaqiriladi (bitta PORT: health + Web App + CRM):
 *   GET /crm/snapshot   → BAYLOG CRM uchun bugungi hisobot
 * U `x-crm-secret` sarlavhasini talab qiladi. CRM_API_SECRET yozilmagan
 * bo'lsa manzil umuman ochilmaydi (404) — ya'ni tasodifan ochilib qolmaydi.
 */

/** Kalitni belgi-belgi taqqoslab topib bo'lmasin */
const secretOk = (given, expected) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** /crm/snapshot ni ishlaydi. true — javob berildi */
const handleCrm = async (req, res, pathname) => {
  if (pathname !== '/crm/snapshot') return false;
  const crmSecret = config.crmApiSecret;
  // Kalit qo'yilmagan bo'lsa bu manzil umuman yo'q hisoblanadi
  if (!crmSecret || req.method !== 'GET') { json(res, 404, '{"error":"not_found"}'); return true; }
  if (!secretOk(req.headers['x-crm-secret'], crmSecret)) { json(res, 401, '{"error":"unauthorized"}'); return true; }
  try {
    json(res, 200, await crmFeed.snapshot());
  } catch (err) {
    console.warn('[crm] hisobot berib bolmadi:', err.message);
    json(res, 500, '{"error":"server_error"}');
  }
  return true;
};

module.exports = { handleCrm, secretOk };
