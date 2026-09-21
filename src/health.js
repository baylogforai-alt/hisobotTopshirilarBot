'use strict';

const http = require('http');
const { timingSafeEqual } = require('node:crypto');
const config = require('./config');
const crmFeed = require('./services/crmFeed');

/**
 * Koyeb (va shunga o'xshash platformalar) botning "tirik"ligini bilish uchun
 * ochiq portga HTTP so'rov yuboradi. Bot Telegram bilan long polling orqali
 * ishlaydi — kiruvchi trafik shart emas, shu sabab bu server faqat health
 * check uchun.
 *
 * Muhim: port band bo'lsa yoki boshqa xato chiqsa ham BOT TO'XTAMASLIGI kerak —
 * health server ixtiyoriy, xatosi yutiladi.
 *
 * 2026-09-04 dan shu serverda BITTA qo'shimcha manzil bor:
 *   GET /crm/snapshot   → BAYLOG CRM uchun bugungi hisobot (faqat o'qish)
 * U `x-crm-secret` sarlavhasini talab qiladi. CRM_API_SECRET yozilmagan
 * bo'lsa manzil umuman ochilmaydi (404) — ya'ni tasodifan ochilib qolmaydi.
 */

/** Kalitni belgi-belgi taqqoslab topib bo'lmasin */
const secretOk = (given, expected) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

const start = (port = config.port) => {
  const crmSecret = config.crmApiSecret;

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    /* ---- CRM uchun hisobot (faqat o'qish) ---- */
    if (url === '/crm/snapshot') {
      // Kalit qo'yilmagan bo'lsa bu manzil umuman yo'q hisoblanadi
      if (!crmSecret || req.method !== 'GET') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{"error":"not_found"}');
      }
      if (!secretOk(req.headers['x-crm-secret'], crmSecret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"error":"unauthorized"}');
      }
      try {
        const data = await crmFeed.snapshot();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(JSON.stringify(data));
      } catch (err) {
        console.warn('[crm] hisobot berib bolmadi:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end('{"error":"server_error"}');
      }
    }

    /* ---- oddiy tiriklik tekshiruvi ---- */
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OK — ${config.companyName} bot ishlamoqda\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[health] ${port}-port band — health server o'tkazib yuborildi (bot baribir ishlaydi).`);
    } else {
      console.warn('[health] server xatosi (e\'tiborsiz):', err.message);
    }
  });

  server.listen(port, () => {
    console.log(`[health] tekshiruv serveri ${port}-portda`);
    if (crmSecret) console.log("[crm] /crm/snapshot ochiq (kalit bilan)");
  });

  return server;
};

module.exports = { start };
