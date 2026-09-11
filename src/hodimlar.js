'use strict';

/**
 * Kompaniyaning doimiy hodimlar ro'yxati.
 *
 * Bot ishga tushganda shu ro'yxatdagi BAZADA YO'Q hodimlar avtomatik qo'shiladi
 * (employees.ensureMany). Bazada bor bo'lganlarga tegilmaydi — ism/lavozim/
 * faollik botdan (/hodim_qosh, /hodim_ochir) o'zgartirilgan bo'lsa saqlanib qoladi.
 * `npm run seed` esa hammasini ro'yxatdagi holatga majburan tenglashtiradi.
 */
const HODIMLAR = [
  { tgId: 8254184544, fullName: 'Samandar', position: 'Sotuv menejeri' },
  { tgId: 5934117099, fullName: 'Akbarali', position: 'Marketolog' },
  { tgId: 7963610051, fullName: 'Durdona', position: 'Operator' },
  { tgId: 7802923308, fullName: 'Islombek', position: 'Dasturchi' },
  { tgId: 7956294912, fullName: 'Buxgalter', position: 'Buxgalter' },
];

module.exports = { HODIMLAR };
