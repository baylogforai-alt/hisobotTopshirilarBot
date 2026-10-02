'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * TELEGRAM WEB APP initData TEKSHIRUVI (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
 *   secret = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)
 *   hash   = hex(HMAC_SHA256(key=secret, data=data_check_string))
 *   data_check_string — hash dan boshqa barcha maydonlar, kalit bo'yicha saralangan, "key=value" lar '\n' bilan.
 * Imzo to'g'ri bo'lsa ham auth_date eskirgan (WEBAPP_AUTH_TTL) yoki kelajakdagi bo'lsa — rad etiladi.
 * Faqat bot tokeni egasi (Telegram) to'g'ri imzo qo'ya oladi → foydalanuvchi ID sini soxtalashtirib bo'lmaydi.
 */

let secretCache = null;
const secretKey = () => {
  if (!secretCache) secretCache = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  return secretCache;
};

const MAX_LEN = 4096;

/** Imzo hisoblash (testlar va tekshiruv uchun) */
const sign = (params) => {
  const dataCheck = [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return crypto.createHmac('sha256', secretKey()).update(dataCheck).digest('hex');
};

/**
 * initData satrini tekshiradi. To'g'ri bo'lsa { ok:true, user:{id, first_name, ...}, authDate }, aks holda { ok:false, reason }.
 * nowSec — testlar uchun.
 */
const verify = (initData, nowSec = Math.floor(Date.now() / 1000)) => {
  if (typeof initData !== 'string' || !initData || initData.length > MAX_LEN) return { ok: false, reason: 'empty' };
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'parse' };
  }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'hash' };
  // takrorlangan kalit — imzo noaniq bo'ladi, rad etamiz
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'dup' };

  const expected = Buffer.from(sign(params), 'hex');
  const given = Buffer.from(hash, 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'signature' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'auth_date' };
  if (authDate > nowSec + 60) return { ok: false, reason: 'future' };
  if (nowSec - authDate > config.webAuthTtlSec) return { ok: false, reason: 'expired' };

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, reason: 'user' };
  }
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) return { ok: false, reason: 'user' };
  return {
    ok: true,
    authDate,
    user: {
      id: Number(user.id),
      first_name: String(user.first_name || '').slice(0, 64),
      last_name: String(user.last_name || '').slice(0, 64),
      username: user.username ? String(user.username).slice(0, 32) : null,
    },
  };
};

/** Testlar uchun: foydalanuvchi obyektidan imzolangan initData yasash */
const build = (user, authDate = Math.floor(Date.now() / 1000)) => {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAtest');
  params.set('user', JSON.stringify(user));
  params.set('hash', sign(params));
  return params.toString();
};

module.exports = { verify, sign, build };
