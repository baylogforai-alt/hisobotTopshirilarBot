'use strict';

const config = require('../config');
const tg = require('../telegram');

/**
 * WEB APP (Telegram Mini App) TUGMALARI.
 *   Chat pastidagi «📱 Ilova» menyu tugmasi FAQAT ro'yxatdagi hodim va direktorlarga (chat bo'yicha) qo'yiladi —
 *   begonalarda standart «Menu» (buyruqlar) qoladi. Ilova ichida ham har so'rov initData + whitelist bilan tekshiriladi.
 *   WEBAPP_URL bo'sh bo'lsa hamma narsa jim o'tkaziladi.
 */

const MENU_TEXT = '📱 Ilova';

const enabled = () => Boolean(config.webAppUrl);
/** hash — ilova ichidagi sahifa, masalan '#/assign' */
const url = (hash = '') => `${config.webAppUrl}${hash}`;

const inlineButton = (label = MENU_TEXT, hash = '') => ({ text: label, web_app: { url: url(hash) } });
/** Bitta tugmali inline klaviatura (Telegraf extra) */
const keyboard = (label = MENU_TEXT, hash = '') => ({ reply_markup: { inline_keyboard: [[inlineButton(label, hash)]] } });

const setMenuFor = (bot, tgId) => {
  if (!enabled() || !tgId) return null;
  return tg.safe(
    () => bot.telegram.setChatMenuButton({ chatId: Number(tgId), menuButton: { type: 'web_app', text: MENU_TEXT, web_app: { url: url() } } }),
    `menu→${tgId}`,
  );
};

const resetMenuFor = (bot, tgId) => {
  if (!enabled() || !tgId) return null;
  return tg.safe(() => bot.telegram.setChatMenuButton({ chatId: Number(tgId), menuButton: { type: 'commands' } }), `menu-reset→${tgId}`);
};

/** Ishga tushganda: barcha faol hodimlar va ADMIN_IDS ga menyu tugmasi */
const syncMenus = async (bot) => {
  if (!enabled()) return 0;
  const employees = require('./employees');
  const ids = new Set(config.adminIds.map(Number));
  for (const e of await employees.listActive()) ids.add(Number(e.tg_id));
  let n = 0;
  for (const id of ids) {
    if (await setMenuFor(bot, id)) n += 1;
    await tg.throttle();
  }
  return n;
};

module.exports = { MENU_TEXT, enabled, url, inlineButton, keyboard, setMenuFor, resetMenuFor, syncMenus };
