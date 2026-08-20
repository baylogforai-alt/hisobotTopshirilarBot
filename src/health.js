'use strict';

const http = require('http');

/**
 * Koyeb (va shunga o'xshash platformalar) botning "tirik"ligini bilish uchun
 * ochiq portga HTTP so'rov yuboradi. Bot Telegram bilan long polling orqali
 * ishlaydi — kiruvchi trafik shart emas, shu sabab bu server faqat health
 * check uchun.
 *
 * Muhim: port band bo'lsa yoki boshqa xato chiqsa ham BOT TO'XTAMASLIGI kerak —
 * health server ixtiyoriy, xatosi yutiladi.
 */
const start = (port = process.env.PORT || 8000) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OK — missiya bot ishlamoqda\n');
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
  });

  return server;
};

module.exports = { start };
