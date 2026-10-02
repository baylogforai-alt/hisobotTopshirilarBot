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

/** Direktorlar + HR — "direktor ko'rgan hamma narsa" boradiganlar */
const seeAllIds = async () => {
  const employees = require('./employees');
  const ids = new Set(await adminIds());
  try {
    (await employees.listHr()).forEach((e) => ids.add(Number(e.tg_id)));
  } catch (err) {
    console.error("[notify] HR ro'yxati olinmadi:", err.message);
  }
  return [...ids].filter(Boolean);
};

const toSeeAll = async (bot, text, extra = {}, exceptTgId = null) => {
  const ids = (await seeAllIds()).filter((id) => Number(id) !== Number(exceptTgId));
  for (const id of ids) {
    await toUser(bot, id, text, extra);
    await tg.throttle();
  }
  return ids.length;
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
  return sendWithInfoCopies(bot, emp, ids, text, extra, proof);
};

/** ids ga tugmalar bilan; texnik direktorlarga (ADMIN_IDS, rahbariyatda yo'q) — tugmasiz nusxa */
const sendWithInfoCopies = async (bot, emp, ids, text, extra = {}, proof = null) => {
  let sent = 0;
  const send = async (id, ex) => {
    const ok = proof && proof.fileId ? await sendProof(bot, id, proof, text, ex) : await toUser(bot, id, text, ex);
    if (ok) sent += 1;
    await tg.throttle();
  };
  for (const id of ids) await send(id, extra);
  const info = await require('./org').infoOnlyIds([...ids, Number(emp.tg_id)]);
  for (const id of info) await send(id, {});
  return sent;
};

const PROOF_METHOD = {
  photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument', video_note: 'sendVideoNote', voice: 'sendVoice', audio: 'sendAudio',
};

/**
 * Rasm / video / dumaloq video / audio / ovozli xabar (file_id bo'yicha) + HTML caption.
 * Caption 1024 dan uzun bo'lsa yoki dumaloq video bo'lsa (caption qo'llamaydi) — matn alohida xabar.
 */
const sendProof = async (bot, chatId, proof, caption, extra = {}) => {
  const method = PROOF_METHOD[proof.type] || 'sendDocument';
  const inline = caption.length <= 1000 && proof.type !== 'video_note';
  const opts = inline ? { caption, parse_mode: 'HTML', ...extra } : {};
  const res = await tg.safe(() => bot.telegram[method](chatId, proof.fileId, opts), `proof→${chatId}`);
  if (!inline) await sendText(bot, chatId, caption, extra);
  return res;
};

/** Kelmaslik / kechikish xabari: HR + boshliq (direktorlar) + bo'lim rahbari */
const toHrAndBoss = async (bot, emp, text, extra = {}, proof = null, { decideExtra = null } = {}) => {
  const org = require('./org');
  const ids = await org.absenceRecipientsOf(emp);
  if (!decideExtra) return sendWithInfoCopies(bot, emp, ids, text, extra, proof);
  // tasdiqlash tugmalari faqat rahbariyatga (boshliq + HR); bo'lim rahbari va boshqalarga — tugmasiz
  const top = new Set(await org.approversOf(emp));
  let sent = 0;
  for (const id of ids) {
    const ex = top.has(Number(id)) ? decideExtra : extra;
    const ok = proof && proof.fileId ? await sendProof(bot, id, proof, text, ex) : await toUser(bot, id, text, ex);
    if (ok) sent += 1;
    await tg.throttle();
  }
  for (const id of await org.infoOnlyIds([...ids, Number(emp.tg_id)])) {
    const ok = proof && proof.fileId ? await sendProof(bot, id, proof, text, extra) : await toUser(bot, id, text, extra);
    if (ok) sent += 1;
    await tg.throttle();
  }
  return sent;
};

// ---------------------------------------------------------------------------
// ARXIV GURUHI — hodimlar o'chira olmaydigan nusxa.
// Telegram shaxsiy chatda foydalanuvchiga xabarni o'chirishni taqiqlashga imkon bermaydi,
// shuning uchun barcha isbotlar (Keldim videosi, tashriflar, Bajardim isboti) direktor egasi bo'lgan
// yopiq guruhga ham nusxalanadi. Hodim o'z chatidan o'chirsa ham arxivda va bazada qoladi.
// ---------------------------------------------------------------------------
const ARCHIVE_KEY = 'archive_chat_id';
let cachedArchiveId;

const getArchiveId = async () => {
  if (cachedArchiveId !== undefined) return cachedArchiveId;
  const fromDb = await db.getSetting(ARCHIVE_KEY);
  cachedArchiveId = fromDb ? Number(fromDb) : null;
  return cachedArchiveId;
};

const setArchiveId = async (chatId) => {
  await db.setSetting(ARCHIVE_KEY, String(chatId));
  cachedArchiveId = Number(chatId);
};

/** Arxivga matn yoki isbot. Arxiv ulanmagan bo'lsa jim. */
const toArchive = async (bot, text, proof = null) => {
  const chatId = await getArchiveId();
  if (!chatId) return null;
  return proof && proof.fileId ? sendProof(bot, chatId, proof, text) : sendText(bot, chatId, text);
};

module.exports = {
  getGroupId, setGroupId, toGroup, toUser, docToGroup, docToUser, adminIds, toAdmins, docToAdmins, toMany, toReviewers, sendProof,
  getArchiveId, setArchiveId, toArchive, toHrAndBoss, seeAllIds, toSeeAll,
};
