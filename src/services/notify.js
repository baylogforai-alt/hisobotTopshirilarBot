'use strict';

const config = require('../config');
const db = require('../db');
const tg = require('../telegram');
const { splitText, HTML } = require('../render');

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

/** Bitta chatga matn — uzun bo'lsa bo'laklarga bo'lib (429/403 himoyasi bilan) */
const sendText = async (bot, chatId, text, extra = {}) => {
  const parts = splitText(text);
  let last = null;
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    last = await tg.safe(
      () => bot.telegram.sendMessage(chatId, parts[i], isLast ? { ...HTML, ...extra } : HTML),
      `notify→${chatId}`,
    );
  }
  return last;
};

/** Guruhga xabar. Guruh ulanmagan bo'lsa jim o'tkazib yuboradi. */
const toGroup = async (bot, text, extra = {}) => {
  const chatId = await getGroupId();
  if (!chatId) return null;
  return sendText(bot, chatId, text, extra);
};

/** Hodimga shaxsiy xabar. Bloklagan bo'lsa xato yutiladi. */
const toUser = (bot, tgId, text, extra = {}) => sendText(bot, tgId, text, extra);

const sendDoc = (bot, chatId, buffer, filename, caption = '') =>
  tg.safe(
    () =>
      bot.telegram.sendDocument(
        chatId,
        { source: Buffer.from(buffer), filename },
        caption ? { caption, parse_mode: 'HTML' } : {},
      ),
    `doc→${chatId}`,
  );

const docToGroup = async (bot, buffer, filename, caption = '') => {
  const chatId = await getGroupId();
  if (!chatId) return null;
  return sendDoc(bot, chatId, buffer, filename, caption);
};

const docToUser = (bot, tgId, buffer, filename, caption = '') => sendDoc(bot, tgId, buffer, filename, caption);

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

/**
 * Barcha adminlarga xabar. exceptTgId — hodimning o'zi admin bo'lsa, o'ziga yubormaslik uchun.
 * Har biriga alohida extra (masalan tugma) bir xil ketadi.
 */
const toAdmins = async (bot, text, extra = {}, exceptTgId = null) => {
  const ids = (await adminIds()).filter((id) => Number(id) !== Number(exceptTgId));
  for (const id of ids) {
    await toUser(bot, id, text, extra);
    await tg.throttle();
  }
  return ids.length;
};

const docToAdmins = async (bot, buffer, filename, caption = '') => {
  const ids = await adminIds();
  for (const id of ids) {
    await docToUser(bot, id, buffer, filename, caption);
    await tg.throttle();
  }
  return ids.length;
};

/** Bir nechta hodimga ketma-ket (pauza bilan) */
const toMany = async (bot, tgIds, text, extra = {}) => {
  let sent = 0;
  for (const id of tgIds) {
    if (await toUser(bot, id, text, extra)) sent += 1;
    await tg.throttle();
  }
  return sent;
};

/**
 * Hodimning tekshiruvchilariga (bo'lim boshlig'i, bo'lmasa direktor) xabar.
 * Rasm/video isboti bo'lsa — o'sha fayl bilan (caption sifatida matn).
 */
const toReviewers = async (bot, emp, text, extra = {}, proof = null) => {
  const employees = require('./employees');
  const ids = await employees.reviewersOf(emp);
  let sent = 0;
  for (const id of ids) {
    const ok = proof ? await sendProof(bot, id, proof, text, extra) : await toUser(bot, id, text, extra);
    if (ok) sent += 1;
    await tg.throttle();
  }
  return sent;
};

/** Rasm yoki video (file_id bo'yicha) + HTML caption. Caption 1024 dan uzun bo'lsa alohida matn. */
const sendProof = async (bot, chatId, proof, caption, extra = {}) => {
  const short = caption.length <= 1000;
  const opts = short ? { caption, parse_mode: 'HTML', ...extra } : {};
  const method = proof.type === 'video' ? 'sendVideo' : proof.type === 'document' ? 'sendDocument' : 'sendPhoto';
  const res = await tg.safe(() => bot.telegram[method](chatId, proof.fileId, opts), `proof→${chatId}`);
  if (!short) await sendText(bot, chatId, caption, extra);
  return res;
};

module.exports = {
  getGroupId, setGroupId, toGroup, toUser, docToGroup, docToUser, adminIds, toAdmins, docToAdmins, toMany, toReviewers, sendProof,
};
