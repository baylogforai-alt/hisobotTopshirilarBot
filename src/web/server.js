'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const auth = require('./auth');
const access = require('../services/access');
const employees = require('../services/employees');
const api = require('./api');

/**
 * HTTP SERVER: health check + Web App (Telegram Mini App) sahifasi + JSON API.
 *   GET  /, /health      — platforma (Railway) tekshiruvi
 *   GET  /crm/snapshot   — BAYLOG CRM uchun bugungi hisobot (x-crm-secret, CRM_API_SECRET bo'lsa) — health.js
 *   GET  /crm/kpi?month= — CRM uchun oylik KPI (o'sha kalit; bazaga yozmaydi) — health.js + services/crmKpi.js
 *   POST /crm/kpi/set    — CRM'dan KPI summasi / oklad / boshliq bahosi (o'sha kalit) — crmKpi.setFromCrm
 *   GET  /app            — ilova (index.html, app.css, app.js — faqat ro'yxatdagi fayllar, yo'l bilan o'qilmaydi)
 *   *    /api/...        — Authorization: tma <initData>  (imzo + muddat + whitelist har so'rovda)
 * Xavfsizlik: qat'iy CSP, nosniff, frame-ancestors (faqat Telegram), JSON-only body (32 KB), so'rovlar limiti,
 * xatoda ichki tafsilot chiqarilmaydi. CORS ochilmagan — boshqa saytdan chaqirib bo'lmaydi.
 */

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/app': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
};

const loadStatic = () => {
  const out = {};
  for (const [route, s] of Object.entries(STATIC)) {
    const body = fs.readFileSync(path.join(PUBLIC, s.file));
    out[route] = { body, type: s.type, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
  }
  return out;
};

const CSP = [
  "default-src 'none'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  'frame-ancestors https://web.telegram.org https://*.telegram.org',
].join('; ');

const baseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

const send = (res, status, body, headers = {}) => {
  if (res.headersSent) return;
  res.writeHead(status, { ...baseHeaders, ...headers });
  res.end(body);
};

const sendJson = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

// ---------------------------------------------------------------------------
// SO'ROVLAR LIMITI (xotirada, oyna — 60 soniya)
// ---------------------------------------------------------------------------
const buckets = new Map();
const LIMITS = { ip: 300, user: 240, write: 60 };
const hit = (key, max) => {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { n: 0, reset: now + 60_000 }; buckets.set(key, b); }
  b.n += 1;
  return b.n <= max;
};
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60_000);
sweep.unref();

const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);

// ---------------------------------------------------------------------------
// BODY
// ---------------------------------------------------------------------------
const MAX_BODY = 32 * 1024;
const readJson = (req) => new Promise((resolve, reject) => {
  const type = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(type)) { reject(new api.HttpError(415, 'JSON kerak')); return; }
  let size = 0;
  let tooBig = Number(req.headers['content-length'] || 0) > MAX_BODY;
  if (tooBig) reject(new api.HttpError(413, "So'rov juda katta"));
  const chunks = [];
  // ortiqchasi o'qib tashlanadi (ulanish uzilmasin — javob yetib borsin)
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(new api.HttpError(413, "So'rov juda katta")); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return;
    if (!chunks.length) { resolve({}); return; }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not object');
      resolve(data);
    } catch {
      reject(new api.HttpError(400, "JSON noto'g'ri"));
    }
  });
  req.on('error', reject);
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const handleApi = async (req, res, url, bot) => {
  const ip = ipOf(req);
  if (!hit(`ip:${ip}`, LIMITS.ip)) return sendJson(res, 429, { error: 'Juda ko\'p so\'rov, birozdan keyin urinib ko\'ring' });

  const header = String(req.headers.authorization || '');
  const m = header.match(/^tma (.+)$/);
  const v = m ? auth.verify(m[1]) : { ok: false, reason: 'missing' };
  if (!v.ok) return sendJson(res, 401, { error: 'Avtorizatsiya xatosi — ilovani bot ichidan qayta oching', code: v.reason === 'expired' ? 'expired' : 'auth' });

  const actor = await access.resolve(v.user.id, v.user);
  if (!actor.registered) return sendJson(res, 403, { error: "Siz ro'yxatda yo'qsiz", code: 'not_registered', tgId: v.user.id });
  if (actor.employee && v.user.username) await employees.touchUsername(v.user.id, v.user.username);

  if (!hit(`u:${actor.tgId}`, LIMITS.user)) return sendJson(res, 429, { error: "Juda ko'p so'rov, birozdan keyin urinib ko'ring" });
  const write = req.method !== 'GET';
  if (write && !hit(`w:${actor.tgId}`, LIMITS.write)) return sendJson(res, 429, { error: "Juda ko'p amal, birozdan keyin urinib ko'ring" });

  const route = api.match(req.method, url.pathname);
  if (!route) return sendJson(res, 404, { error: 'Topilmadi' });

  const body = write ? await readJson(req) : {};
  const result = await route.handler({ actor, params: route.params, query: url.searchParams, body, bot, res });
  if (result === api.STREAMED) return undefined;
  if (write) console.log(`[web] ${actor.tgId} ${req.method} ${url.pathname}`);
  return sendJson(res, 200, result === undefined ? { ok: true } : result);
};

const createServer = ({ bot }) => {
  const files = loadStatic();
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'Bad request');
    }
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, bot);
      if (await require('../health').handleCrm(req, res, url.pathname, url)) return null;

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET' });
      if (url.pathname === '/' || url.pathname === '/health') {
        return send(res, 200, `OK — ${config.companyName} bot ishlamoqda\n`, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      const f = files[url.pathname];
      if (!f) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (req.headers['if-none-match'] === f.etag) return send(res, 304, '', { ETag: f.etag });
      return send(res, 200, req.method === 'HEAD' ? '' : f.body, {
        'Content-Type': f.type,
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-cache',
        ETag: f.etag,
      });
    } catch (err) {
      if (err instanceof api.HttpError) return sendJson(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
      console.error('[web] xato:', err);
      if (!res.headersSent) return sendJson(res, 500, { error: 'Serverda xato. Qayta urinib ko\'ring.' });
      return res.destroy();
    }
  });
};

/** Port band bo'lsa yoki boshqa xato chiqsa ham BOT TO'XTAMASLIGI kerak */
const start = ({ bot, port = config.port } = {}) => {
  const server = createServer({ bot });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.warn(`[web] ${port}-port band — server o'tkazib yuborildi (bot baribir ishlaydi).`);
    else console.warn("[web] server xatosi (e'tiborsiz):", err.message);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.listen(port, () => console.log(`[web] server ${port}-portda${config.webAppUrl ? ` · Web App: ${config.webAppUrl}` : ' · Web App: WEBAPP_URL berilmagan'}${config.crmApiSecret ? ' · /crm/snapshot ochiq (kalit bilan)' : ''}`));
  return server;
};

module.exports = { start, createServer };
