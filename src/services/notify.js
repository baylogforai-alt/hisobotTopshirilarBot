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

/** .env dagi ADMIN_IDS + bazadagi role='admin' — takrorlanmagan ro'yxat */
const adminIds = async () => {
  const employees = require('./employees');
  const ids = new Set(config.adminIds.map(Number));
  try {
    (await employees.listAdmins()).forEach((e) => ids.add(Number(e.tg_id)));
  } catch (err) {
    console.error("[notify] adminlar ro'yxati olinmadi:", err.message);
  }
  return [...ids].filter(Boolean);
};

/** Barcha adminlarga xabar (uzun matn bo'laklarga bo'linadi) */
const toAdmins = async (bot, text, extra = {}) => {
  const period = require('./period');
  const ids = await adminIds();
  for (const id of ids) {
    for (const part of period.splitText(text)) {
      await toUser(bot, id, part, extra);
    }
  }
  return ids.length;
};

/** Barcha adminlarga fayl */
const docToAdmins = async (bot, buffer, filename, caption = '') => {
  const ids = await adminIds();
  for (const id of ids) await docToUser(bot, id, buffer, filename, caption);
  return ids.length;
};

module.exports = {
  getGroupId, setGroupId, toGroup, toUser, docToGroup, docToUser,
  adminIds, toAdmins, docToAdmins,
};
