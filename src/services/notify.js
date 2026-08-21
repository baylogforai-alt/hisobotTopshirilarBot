'use strict';

const config = require('../config');
const db = require('../db');

const GROUP_KEY = 'group_chat_id';

/** Bazadagi qiymat ustun, aks holda .env dagi GROUP_CHAT_ID */
let cachedGroupId;

const getGroupId = async () => {
  if (cachedGroupId !== undefined) return cachedGroupId;
  const fromDb = await db.getSetting(GROUP_KEY);
  cachedGroupId = fromDb ? Number(fromDb) : config.groupChatId || null;
  return cachedGroupId;
};

const setGroupId = async (chatId) => {
  await db.setSetting(GROUP_KEY, String(chatId));
  cachedGroupId = Number(chatId);
};

/** Guruhga xabar. Guruh ulanmagan bo'lsa jim o'tkazib yuboradi. */
const toGroup = async (bot, text, extra = {}) => {
  const chatId = await getGroupId();
  if (!chatId) return null;
  try {
    return await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch (err) {
    console.error("[notify] guruhga yuborib bo'lmadi:", err.description || err.message);
    return null;
  }
};

/** Hodimga shaxsiy xabar. Bloklagan bo'lsa xato yutiladi. */
const toUser = async (bot, tgId, text, extra = {}) => {
  try {
    return await bot.telegram.sendMessage(tgId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch (err) {
    console.error(`[notify] ${tgId} ga yuborib bo'lmadi:`, err.description || err.message);
    return null;
  }
};

/** Guruhga fayl (masalan Excel) yuborish */
const docToGroup = async (bot, buffer, filename, caption = '') => {
  const chatId = await getGroupId();
  if (!chatId) return null;
  try {
    return await bot.telegram.sendDocument(
      chatId,
      { source: Buffer.from(buffer), filename },
      caption ? { caption, parse_mode: 'HTML' } : {},
    );
  } catch (err) {
    console.error("[notify] guruhga fayl yuborib bo'lmadi:", err.description || err.message);
    return null;
  }
};

/** Hodimga fayl yuborish */
const docToUser = async (bot, tgId, buffer, filename, caption = '') => {
  try {
    return await bot.telegram.sendDocument(
      tgId,
      { source: Buffer.from(buffer), filename },
      caption ? { caption, parse_mode: 'HTML' } : {},
    );
  } catch (err) {
    console.error(`[notify] ${tgId} ga fayl yuborib bo'lmadi:`, err.description || err.message);
    return null;
  }
};

module.exports = { getGroupId, setGroupId, toGroup, toUser, docToGroup, docToUser };
