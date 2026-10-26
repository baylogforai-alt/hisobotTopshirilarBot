'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const attendance = require('../services/attendance');
const employees = require('../services/employees');
const leaves = require('../services/leaves');
const org = require('../services/org');
const flows = require('../services/flows');
const access = require('../services/access');
const { notRegistered } = require('./common');

const { esc } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

// ---------------------------------------------------------------------------
// ISHDAN JAVOB SO'RASH (7-okt)
//   1. «🚪 Javob so'rash» — bugun Keldim qilgan, hali ketmagan hodim
//   2. Qancha vaqtga: 1 / 2 / 3 soatga chiqib kelish yoki bugunga erta ketish (jv:k:<kind>)
//   3. Sabab — matn, video, audio yoki rasm (bosqich leave_reason)
//   4. Bo'lim rahbari yoki boshliq: ✅ Javob berish / ❌ Yo'q (jv:ok|no:<id>); HR — tugmasiz xabar
//   Ruxsat bilan bugunga ketsa — «Ketdim» da «erta ketdi» o'rniga «javob olgan».
// ---------------------------------------------------------------------------

/** So'rash mumkin emas bo'lsa — sababi (HTML), mumkin bo'lsa null. Bot va ilova uchun bitta qoida */
const blockReason = async (emp) => {
  if (employees.isBoss(emp)) return 'ℹ️ Siz kompaniya rahbarisiz — javob so\'rash shart emas.';
  if (!(await attendance.isCheckedIn(emp.id))) return `ℹ️ Avval «${ui.BTN.checkIn}» qiling — javob ish vaqtida so'raladi. Bugun kela olmasangiz — «${ui.BTN.absence}».`;
  if (await attendance.isCheckedOut(emp.id)) return 'ℹ️ Bugun ketganingiz allaqachon belgilangan.';
  if (await leaves.pendingFor(emp.id)) return "⏳ Javob so'rovingiz hali ko'rib chiqilmoqda — qaror chiqqach xabar keladi.";
  return null;
};

const kindKeyboard = () => ui.inline([
  [ui.cb('⏱ 1 soatga', 'jv:k:60'), ui.cb('⏱ 2 soatga', 'jv:k:120'), ui.cb('⏱ 3 soatga', 'jv:k:180')],
  [ui.cb('🏠 Bugunga (erta ketish)', 'jv:k:day')],
  [ui.cb(ui.BTN.cancel, 'jv:x')],
]);

const start = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.state.isAdmin ? ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz.") : notRegistered(ctx);
  const block = await blockReason(emp);
  if (block) return ctx.reply(block, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  session.clear(ctx.from.id);
  return ctx.reply(
    `🚪 <b>Ishdan javob so'rash</b>\n\nQancha vaqtga kerak?\n<i>So'rov ${esc(await org.recipientsLabel(emp, { approvers: true }))}ga boradi.</i>`,
    { parse_mode: 'HTML', ...kindKeyboard() },
  );
};

const onKind = async (ctx) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery('Eskirgan tugma');
  const kind = ctx.match[1];
  const block = await blockReason(emp);
  if (block) {
    await ctx.answerCbQuery();
    return ctx.editMessageText(block, { parse_mode: 'HTML' }).catch(() => ctx.reply(block, { parse_mode: 'HTML' }));
  }
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step: 'leave_reason', leaveKind: kind });
  await ctx.editMessageText(`🚪 <b>Javob so'rash</b> — ${esc(leaves.kindLabel(kind))}`, { parse_mode: 'HTML' }).catch(() => {});
  return ctx.reply(
    "✍️ <b>Sababini yozing</b> yoki 🎥 video / 🎙 audio / 🖼 rasm yuboring.\nMasalan: shifokorga, bankka, bolani maktabdan olish, oilaviy sabab.",
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

const onCancel = async (ctx) => {
  session.clear(ctx.from.id);
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.editMessageText('Bekor qilindi.').catch(() => {});
};

/** leave_reason bosqichi — matn (STEP_HANDLERS) yoki media (onMedia) */
const handleReason = async (ctx) => {
  const emp = ctx.state.employee;
  const s = session.get(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  const { reasonProof, reasonOf } = require('./attendance');
  const proof = ctx.message.text ? null : reasonProof(ctx.message);
  const reason = reasonOf(ctx, proof);
  if (!reason) return ctx.reply('✍️ Sababini yozing:', ui.cancelKeyboard());
  session.clear(ctx.from.id);
  if (!leaves.isKind(s.leaveKind)) return ctx.reply(`Sessiya eskirgan — qaytadan «${ui.BTN.leave}» bosing.`, ui.kbFor(ctx));
  const block = await blockReason(emp);
  if (block) return ctx.reply(block, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  await flows.requestLeave(botOf(ctx), emp, s.leaveKind, reason, proof);
  return ctx.reply(
    `📨 Javob so'rovi ${esc(await org.recipientsLabel(emp, { approvers: true }))}ga yuborildi:\n⏱ ${esc(leaves.kindLabel(s.leaveKind))} · «${esc(reason)}»\n\nRuxsat berilsa — xabar keladi. Ungacha ish joyingizda qoling.`,
    { parse_mode: 'HTML', ...ui.kbFor(ctx) },
  );
};

const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private' || !ctx.state.employee) return next();
  if (session.get(ctx.from.id).step !== 'leave_reason') return next();
  if (!require('./attendance').reasonProof(ctx.message)) return ctx.reply('Matn, video, dumaloq video, audio yoki rasm yuboring.', ui.cancelKeyboard());
  return handleReason(ctx);
};

const onDecision = async (ctx) => {
  const [, verdict, id] = ctx.match;
  const row = await leaves.byId(id);
  if (!row) return ctx.answerCbQuery('Topilmadi');
  const emp = await employees.byId(row.employee_id);
  if (!(await access.canDecideExcuse(ctx.state.actor, emp))) {
    return ctx.answerCbQuery("⛔️ Javobni bo'lim rahbari (u yo'q bo'lsa — HR) yoki boshliq beradi", { show_alert: true });
  }
  if (row.work_date !== time.today() && row.status === 'pending') {
    return ctx.answerCbQuery("Bu so'rov o'tgan kunga tegishli — eskirgan", { show_alert: true });
  }
  const status = verdict === 'ok' ? 'approved' : 'rejected';
  const by = org.actorName(ctx);
  const res = await flows.decideLeave(botOf(ctx), row.id, status, ctx.from.id, by);
  if (!res) {
    return ctx.answerCbQuery(`Allaqachon hal qilingan: ${row.status === 'approved' ? `javob berilgan (${row.decided_name || ''})` : `rad etilgan (${row.decided_name || ''})`}`, { show_alert: true });
  }
  await ctx.answerCbQuery(status === 'approved' ? 'Javob berildi' : 'Rad etildi');
  const until = leaves.untilOf(res);
  const verdictText = `🚪 <b>${esc(emp.full_name)}</b> — ${esc(leaves.kindLabel(res.kind))}${res.reason ? `\n«${esc(res.reason)}»` : ''}\n\n` +
    `${status === 'approved' ? `✅ <b>Javob berildi</b>${until ? ` · ${until} gacha` : ''}` : "❌ <b>Javob berilmadi</b>"}\n<i>qaror: ${esc(by)}</i>`;
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  if (msg && (msg.photo || msg.video || msg.voice || msg.audio || msg.document)) await ctx.editMessageCaption(verdictText, { parse_mode: 'HTML' }).catch(() => ctx.reply(verdictText, { parse_mode: 'HTML' }));
  else if (msg && msg.video_note) await ctx.reply(verdictText, { parse_mode: 'HTML' });
  else await ctx.editMessageText(verdictText, { parse_mode: 'HTML' }).catch(() => ctx.reply(verdictText, { parse_mode: 'HTML' }));
  return undefined;
};

const register = (bot) => {
  bot.hears(ui.BTN.leave, start);
  bot.command('javob', start);
  bot.action(/^jv:k:(60|120|180|day)$/, onKind);
  bot.action('jv:x', onCancel);
  bot.action(/^jv:(ok|no):(\d+)$/, onDecision);
  bot.on(['video', 'video_note', 'voice', 'audio', 'photo', 'document'], onMedia);
};

module.exports = { register, handleReason, blockReason };
