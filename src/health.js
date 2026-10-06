'use strict';

const { timingSafeEqual } = require('node:crypto');
const config = require('./config');
const crmFeed = require('./services/crmFeed');
const crmKpi = require('./services/crmKpi');

/**
 * CRM uchun faqat o'qiladigan manzil — web/server.js ichidan chaqiriladi (bitta PORT: health + Web App + CRM):
 *   GET /crm/snapshot   → BAYLOG CRM uchun bugungi hisobot
 *   GET /crm/kpi?month=YYYY-MM → oylik KPI (topshiriq, davomat, kunlik hisobot, KPI ball, oklad) — bazaga yozmaydi
 *   POST /crm/kpi/set {employeeId, month, bonusFund?, salary?, headScore?, customPct?, by?} → KPI sozlash (crmKpi.setFromCrm)
 *   POST /crm/kpi/extra {action:add|remove, ...} → qo'shimcha KPI qatori (crmKpi.extraFromCrm)
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

/** So'rov tanasi (JSON, ≤ 10 KB) */
const readJson = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 10_000) { req.destroy(); resolve(null); } });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
  req.on('error', () => resolve(null));
});

/** /crm/snapshot, /crm/kpi, /crm/kpi/set ni ishlaydi. true — javob berildi */
const handleCrm = async (req, res, pathname, url = null) => {
  const POSTS = ['/crm/kpi/set', '/crm/kpi/extra'];
  if (pathname !== '/crm/snapshot' && pathname !== '/crm/kpi' && !POSTS.includes(pathname)) return false;
  const crmSecret = config.crmApiSecret;
  const method = POSTS.includes(pathname) ? 'POST' : 'GET';
  // Kalit qo'yilmagan bo'lsa bu manzil umuman yo'q hisoblanadi
  if (!crmSecret || req.method !== method) { json(res, 404, '{"error":"not_found"}'); return true; }
  if (!secretOk(req.headers['x-crm-secret'], crmSecret)) { json(res, 401, '{"error":"unauthorized"}'); return true; }
  if (POSTS.includes(pathname)) {
    const body = await readJson(req);
    if (!body || typeof body !== 'object') { json(res, 400, '{"error":"bad_json"}'); return true; }
    try {
      const r = pathname === '/crm/kpi/set' ? await crmKpi.setFromCrm(body) : await crmKpi.extraFromCrm(body);
      json(res, r.error ? (r.error === 'not_found' ? 404 : 400) : 200, r);
    } catch (err) {
      console.warn('[crm] KPI sozlab bolmadi:', err.message);
      json(res, 500, '{"error":"server_error"}');
    }
    return true;
  }
  try {
    if (pathname === '/crm/kpi') json(res, 200, await crmKpi.monthKpi(url ? url.searchParams.get('month') : null));
    else json(res, 200, await crmFeed.snapshot());
  } catch (err) {
    console.warn('[crm] hisobot berib bolmadi:', err.message);
    json(res, 500, '{"error":"server_error"}');
  }
  return true;
};

module.exports = { handleCrm, secretOk };
