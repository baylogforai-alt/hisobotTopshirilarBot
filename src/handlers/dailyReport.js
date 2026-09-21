'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render, guard } = require('../render');
const employees = require('../services/employees');
const tasks = require('../services/tasks');
const dailyReports = require('../services/dailyReports');
const notify = require('../services/notify');
const activity = require('../services/activity');
const { notRegistered } = require('./common');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * KUNLIK HISOBOT — «hisobot topshiriladigan bot» ning asosiy qismi.
 *   Hodim:   «📝 Kunlik hisobot» → matn (rasm bilan ham bo'ladi, caption = matn) → saqlanadi →
 *            tekshiruvchilarga (boshliq/direktor) yuboriladi: «👁 Ko'rdim» / «💬 Izoh».
 *   Ketdim bosilganda hisobot yo'q bo'lsa — avtomatik so'raladi (DAILY_REPORT_REQUIRED).
 *   Direktor: paneldagi «📋 Kunlik hisobotlar» — bugun kim topshirdi, kim yo'q; matnlarini o'qish.
 * Sessiya: { step: 'daily_report_text', afterCheckout }  ·  { step: 'daily_review_note', reportId }
 */

const mustEmployee = (ctx) => {
  if (ctx.state.employee) return true;
  if (ctx.state.isAdmin) ctx.reply("ℹ️ Siz hodim sifatida ro'yxatda yo'qsiz — kunlik hisobot hodimlar uchun.");
  else notRegistered(ctx);
  return false;
};

/** Hisobot matnini so'rash (bugun bajarilganlar eslatma sifatida ko'rsatiladi) */
const askReport = async (ctx, { afterCheckout = false } = {}) => {
  if (!mustEmployee(ctx)) return null;
  const emp = ctx.state.employee;
  const existing = await dailyReports.get(emp.id);
  const done = await tasks.doneOn(emp.id);
  const open = await tasks.openFor(emp.id);
  session.set(ctx.from.id, { step: 'daily_report_text', afterCheckout });
  const hint = done.length ? `\n\n<i>Bugun belgilaganlaringiz:</i>\n${done.map((t) => `   ✅ ${esc(t.title)}`).join('\n')}` : '';
  const openHint = open.length ? `\n<i>Ochiq qolganlar: ${open.length} ta</i>` : '';
  return ctx.reply(
    `📝 <b>Bugungi kunlik hisobot</b> · ${time.prettyDate(time.today())}\n\n` +
      (existing ? `Siz bugun ${time.clock(existing.submitted_at)} da hisobot topshirgansiz. Yangisini yozsangiz — almashadi.\n\n` : '') +
      `Bugun <b>nima ish qildingiz</b>, qanday natija, qanday <b>muammo / taklif</b> bor — o'z so'zingiz bilan yozing. ` +
      `Rasm yuborsangiz ham bo'ladi (izohini rasm ostiga yozing).${hint}${openHint}` +
      (afterCheckout ? `\n\n<i>Keyinroq yozmoqchi bo'lsangiz — «${ui.BTN.skip}».</i>` : ''),
    { parse_mode: 'HTML', ...(afterCheckout ? ui.skipKeyboard() : ui.cancelKeyboard()) },
  );
};

/** Matn (yoki rasm caption) keldi */
const saveReport = async (ctx, { text, photoFileId = null }) => {
  const emp = ctx.state.employee;
  session.clear(ctx.from.id);
  if (!emp) return notRegistered(ctx);
  const clean = String(text || '').trim();
  if (clean.length < 3) {
    session.set(ctx.from.id, { step: 'daily_report_text' });
    return ctx.reply("Hisobot juda qisqa — kamida bir jumla yozing (yoki «❌ Bekor qilish»).", ui.cancelKeyboard());
  }
  const rep = await dailyReports.submit(emp.id, { text: clean, photoFileId });
  activity.mark(ctx, 'daily_report', { title: clean.slice(0, 120), detail: photoFileId ? 'rasm bilan' : null });
  const done = await tasks.doneOn(emp.id);
  const open = await tasks.openFor(emp.id);
  await ctx.reply(`✅ <b>Kunlik hisobot qabul qilindi</b> (${time.clock(rep.submitted_at)}). Rahmat! 🙌`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });

  const caption =
    `📝 <b>KUNLIK HISOBOT</b> — <b>${esc(emp.full_name)}</b>${emp.position ? ` (${esc(emp.position)})` : ''}\n` +
    `<i>${time.prettyDate(time.today())} · ${time.clock(rep.submitted_at)} · ✅ ${done.length} bajardi · ⏳ ${open.length} ochiq</i>\n\n${esc(clean)}`;
  await notify.toReviewers(botOf(ctx), emp, caption, ui.dailyReviewKeyboard(rep.id), photoFileId ? { type: 'photo', fileId: photoFileId } : null);
};

const handleReportText = (ctx, { skip = false } = {}) => {
  if (skip) {
    session.clear(ctx.from.id);
    return ctx.reply(`Yaxshi. Hisobotni keyinroq «${ui.BTN.dailyReport}» tugmasi bilan yozishingiz mumkin.`, ui.kbFor(ctx));
  }
  return saveReport(ctx, { text: ctx.message.text });
};

/** Rasm keldi — daily_report_text bosqichida bo'lsa hisobot */
const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const s = session.get(ctx.from.id);
  if (s.step !== 'daily_report_text') return next();
  const m = ctx.message;
  const photo = m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id : null;
  if (!photo) return ctx.reply('Hisobotga faqat rasm biriktirish mumkin. Matnni yozing yoki rasm yuboring.');
  return saveReport(ctx, { text: m.caption || 'Rasm bilan hisobot', photoFileId: photo });
};

// ---------------------------------------------------------------------------
// TEKSHIRUVCHI: ko'rdim / izoh
// ---------------------------------------------------------------------------

const reviewGuard = async (ctx, id) => {
  const rep = await dailyReports.byId(id);
  if (!rep) { await ctx.answerCbQuery('Topilmadi'); return null; }
  const emp = await employees.byId(rep.employee_id);
  if (!ctx.state.isManager || !employees.canManage(ctx.state.employee, ctx.state.isAdmin, emp) || Number(emp.tg_id) === Number(ctx.from.id)) {
    await ctx.answerCbQuery("⛔️ Ruxsat yo'q"); return null;
  }
  return { rep, emp };
};

const editAny = async (ctx, text) => {
  try {
    const m = ctx.callbackQuery && ctx.callbackQuery.message;
    if (m && (m.photo || m.video || m.document)) return await ctx.editMessageCaption(text, { parse_mode: 'HTML' });
    return await render(ctx, text);
  } catch { return ctx.reply(text, { parse_mode: 'HTML' }); }
};

const markSeen = async (ctx, id) => {
  const g = await reviewGuard(ctx, id);
  if (!g) return;
  await dailyReports.review(id, ctx.from.id);
  await ctx.answerCbQuery("Ko'rildi 👁");
  await editAny(ctx, `👁 <b>Ko'rildi</b> — ${esc(g.emp.full_name)}, ${time.prettyDate(g.rep.work_date)}\n\n${esc(g.rep.text)}`);
  await notify.toUser(botOf(ctx), g.emp.tg_id, `👁 ${time.prettyDate(g.rep.work_date)} kungi hisobotingiz ko'rib chiqildi.`);
};

const startNote = async (ctx, id) => {
  const g = await reviewGuard(ctx, id);
  if (!g) return;
  session.set(ctx.from.id, { step: 'daily_review_note', reportId: Number(id) });
  await ctx.answerCbQuery();
  return ctx.reply(`💬 <b>${esc(g.emp.full_name)}</b> hisobotiga izoh yozing (hodim ko'radi):`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
};

const handleReviewNote = async (ctx) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  if (!s.reportId) return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx));
  const note = ctx.message.text.trim().slice(0, 500);
  const rep = await dailyReports.review(s.reportId, ctx.from.id, note);
  if (!rep) return ctx.reply('Hisobot topilmadi.', ui.kbFor(ctx));
  await ctx.reply(`✅ Izoh yuborildi: «${esc(note)}»`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  const who = ctx.state.employee ? ctx.state.employee.full_name : 'Direktor';
  await notify.toUser(botOf(ctx), rep.tg_id, `💬 <b>${esc(who)}</b> ${time.prettyDate(rep.work_date)} kungi hisobotingizga izoh qoldirdi:\n«${esc(note)}»`);
};

// ---------------------------------------------------------------------------
// DIREKTOR / BOSHLIQ: bugungi hisobotlar ro'yxati
// ---------------------------------------------------------------------------

const listToday = async (ctx, date = time.today()) => {
  if (!ctx.state.isManager) return ctx.reply('⛔️ Faqat boshliq va direktor uchun.');
  const deptId = ctx.state.isAdmin ? null : ctx.state.employee.department_id;
  const list = deptId ? await employees.listByDepartment(deptId) : await employees.listActive();
  const reps = new Map((await dailyReports.forDate(date, deptId)).map((r) => [Number(r.employee_id), r]));
  const submitted = [], missing = [];
  for (const e of list) (reps.get(Number(e.id)) ? submitted : missing).push(e);
  const lines = submitted.map((e) => {
    const r = reps.get(Number(e.id));
    return `✅ <b>${esc(e.full_name)}</b> <i>${time.clock(r.submitted_at)}${r.reviewed_at ? " · 👁" : ''}${r.photo_file_id ? ' · 📎' : ''}</i>\n   ${esc(r.text).slice(0, 200).replace(/\n/g, ' ')}${r.text.length > 200 ? '…' : ''}`;
  });
  const text =
    `📋 <b>KUNLIK HISOBOTLAR</b> · ${time.prettyDate(date)}\n${ui.LINE}\n` +
    `📝 topshirdi: <b>${submitted.length}</b> · ⏳ topshirmadi: <b>${missing.length}</b>\n\n` +
    (lines.join('\n\n') || '<i>hali hech kim topshirmagan</i>') +
    (missing.length ? `\n\n⏳ <b>Topshirmaganlar:</b> ${missing.map((e) => esc(e.full_name)).join(', ')}` : '');
  const prev = time.addDays(date, -1);
  const next = time.addDays(date, 1);
  const rows = submitted.map((e) => [cb(`📄 ${e.full_name}`, `dr:view:${reps.get(Number(e.id)).id}`)]);
  rows.push([cb(`◀️ ${time.shortDate(prev)}`, `dr:day:${prev}`), ...(next <= time.today() ? [cb(`${time.shortDate(next)} ▶️`, `dr:day:${next}`)] : [])]);
  if (missing.length && date === time.today()) rows.push([cb('🔔 Topshirmaganlarga eslatma', 'dr:remind')]);
  rows.push([cb(ctx.state.isAdmin ? '⬅️ Panel' : '⬅️ Menyu', ctx.state.isAdmin ? 'adm:home' : 'rp:dept:' + time.month())]);
  return render(ctx, text, inline(rows));
};

const viewReport = async (ctx, id) => {
  const rep = await dailyReports.byId(id);
  if (!rep) return ctx.answerCbQuery('Topilmadi');
  const emp = await employees.byId(rep.employee_id);
  if (!ctx.state.isManager || !employees.canManage(ctx.state.employee, ctx.state.isAdmin, emp)) return ctx.answerCbQuery('⛔️');
  await ctx.answerCbQuery();
  const caption = `📝 <b>${esc(emp.full_name)}</b> — ${time.prettyDate(rep.work_date)} · ${time.clock(rep.submitted_at)}${rep.reviewed_at ? " · 👁 ko'rilgan" : ''}\n\n${esc(rep.text)}${rep.review_note ? `\n\n💬 <i>Izoh: ${esc(rep.review_note)}</i>` : ''}`;
  const kb = Number(emp.tg_id) === Number(ctx.from.id) ? {} : ui.dailyReviewKeyboard(rep.id);
  if (rep.photo_file_id) return notify.sendProof(botOf(ctx), ctx.chat.id, { type: 'photo', fileId: rep.photo_file_id }, caption, kb);
  return ctx.reply(caption, { parse_mode: 'HTML', ...kb });
};

/** Hisobot topshirmaganlarga eslatma (cron ham shu funksiyani ishlatadi) */
const remindMissing = async (bot) => {
  const list = await dailyReports.missingToday();
  let n = 0;
  for (const e of list) {
    await notify.toUser(bot, e.tg_id, `📝 <b>Kunlik hisobotingizni topshiring.</b>\nBugun nima ish qildingiz, qanday muammo bo'ldi — «${ui.BTN.dailyReport}» tugmasini bosib yozing.`);
    n += 1;
  }
  return n;
};

const register = (bot) => {
  bot.hears(ui.BTN.dailyReport, (ctx) => askReport(ctx));
  bot.command(['kunlik', 'kunlik_hisobot'], (ctx) => askReport(ctx));
  bot.on(['photo'], onMedia);

  bot.action(/^dr:seen:(\d+)$/, (ctx) => markSeen(ctx, ctx.match[1]));
  bot.action(/^dr:note:(\d+)$/, (ctx) => startNote(ctx, ctx.match[1]));
  bot.action(/^dr:view:(\d+)$/, (ctx) => viewReport(ctx, ctx.match[1]));
  bot.action('dr:today', async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await listToday(ctx); });
  bot.action(/^dr:day:(\d{4}-\d{2}-\d{2})$/, async (ctx) => { if (!ctx.state.isManager) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); await listToday(ctx, ctx.match[1]); });
  bot.command('kunlik_hisobotlar', (ctx) => listToday(ctx));
  bot.action('dr:remind', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery('Yuborilmoqda…');
    const n = await remindMissing(botOf(ctx));
    await ctx.reply(`🔔 ${n} ta hodimga eslatma yuborildi.`);
  });
};

module.exports = { register, askReport, handleReportText, handleReviewNote, listToday, remindMissing, onMedia };
