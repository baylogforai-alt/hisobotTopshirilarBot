'use strict';

/**
 * «📅 Dam olish kuniga chaqirish» (Panel → xc:home, /chaqirish) — faqat boshliq/direktor.
 * Sana (dam olish kuni) → hodimlar (picker «xp») → qo'shimcha haq summasi → tasdiq → hodimlarga xabar.
 * O'sha kuni «Keldim» qilsa — summa oylikka qo'shiladi (services/extradays). Chaqirilmagan dam olish kuni — bonussiz.
 *   xc:home · xc:new · xc:dt:<yyyy-mm-dd|type> · xc:ok · xc:x · xc:del:<id>
 */

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const extradays = require('../services/extradays');
const notify = require('../services/notify');
const kpi = require('../services/kpi');
const picker = require('./picker');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

const guard = async (ctx) => {
  if (ctx.state.isAdmin) return true;
  if (ctx.callbackQuery) await ctx.answerCbQuery('⛔️ Faqat boshliq uchun');
  else await ctx.reply('⛔️ Faqat boshliq uchun.');
  return false;
};

const home = async (ctx) => {
  if (!(await guard(ctx))) return;
  const list = await extradays.upcoming();
  const lines = list.map((x) => `• ${time.prettyDate(x.work_date)} — <b>${esc(x.full_name)}</b> · +${kpi.fmtMoney(x.amount)}${x.worked_at ? ' ✅ keldi' : ''}`);
  const rows = list.filter((x) => !x.worked_at).slice(0, 20).map((x) => [cb(`🗑 ${time.shortDate(x.work_date)} ${x.full_name}`.slice(0, 50), `xc:del:${x.id}`)]);
  rows.unshift([cb('➕ Yangi chaqiruv', 'xc:new')]);
  return render(
    ctx,
    `📅 <b>DAM OLISH KUNIGA CHAQIRISH</b>\n<i>Chaqirilgan hodim o'sha kuni «${ui.BTN.checkIn}» qilsa — qo'shimcha haq oylikka qo'shiladi. O'zi kelgan dam olish kuni — bonussiz.</i>\n${ui.LINE}\n` +
      (lines.join('\n') || "<i>Rejalashtirilgan chaqiruv yo'q.</i>"),
    inline(rows),
  );
};

/** Keyingi dam olish kunlari (30 kun ichida, ko'pi bilan 4 ta) */
const nextOffDays = () => {
  const out = [];
  for (let i = 0; i <= 30 && out.length < 4; i += 1) {
    const d = time.addDays(time.today(), i);
    if (!time.isWorkDay(d)) out.push(d);
  }
  return out;
};

const askDate = async (ctx) => {
  if (!(await guard(ctx))) return;
  session.set(ctx.from.id, { step: null, xc: {} });
  const rows = nextOffDays().map((d) => [cb(`🗓 ${time.prettyDate(d)}`, `xc:dt:${d}`)]);
  rows.push([cb('✍️ Sana yozish', 'xc:dt:type')], [cb(ui.BTN.cancel, 'xc:x')]);
  return render(ctx, '📅 <b>Qaysi dam olish kuniga chaqirasiz?</b>', inline(rows));
};

const setDate = async (ctx, d) => {
  if (!d || d < time.today()) return ctx.reply("O'tgan sana bo'lmaydi. Qaytadan yozing:", ui.cancelKeyboard());
  if (time.isWorkDay(d)) return ctx.reply(`${time.prettyDate(d)} — ish kuni. Dam olish kunini yozing (masalan yakshanba):`, ui.cancelKeyboard());
  session.set(ctx.from.id, { step: null, xc: { date: d } });
  return pick.show(ctx, { reset: true });
};

const pick = picker.create({
  prefix: 'xp',
  allowed: (ctx) => ctx.state.isAdmin,
  candidates: async () => employees.listStaff(),
  title: (ctx, n) => {
    const s = session.get(ctx.from.id);
    return `📅 <b>${s.xc && s.xc.date ? time.prettyDate(s.xc.date) : ''}</b> — kimlarni chaqirasiz?${n ? ` Belgilandi: <b>${n}</b>` : ''}`;
  },
  onDone: async (ctx, ids) => {
    const s = session.get(ctx.from.id);
    if (!s.xc || !s.xc.date) return render(ctx, 'Sessiya eskirgan — qaytadan boshlang.');
    session.set(ctx.from.id, { step: 'xc_amount', xc: { ...s.xc, ids }, pick: null, pickFor: null });
    return render(ctx, `💰 <b>Qo'shimcha haq</b> — har bir hodimga necha so'm? (masalan <b>200000</b>)`);
  },
});

/** xc_amount bosqichi (matn) */
const handleAmount = async (ctx) => {
  const s = session.get(ctx.from.id);
  const n = Number(String(ctx.message.text || '').replace(/[^\d]/g, ''));
  if (!s.xc || !s.xc.date || !Array.isArray(s.xc.ids)) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  if (!n || n <= 0) return ctx.reply("Summani raqam bilan yozing (masalan 200000):", ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'xc_confirm', xc: { ...s.xc, amount: n } });
  const list = [];
  for (const id of s.xc.ids) list.push(await employees.byId(id));
  await ctx.reply('👌', ui.kbFor(ctx));
  return ctx.reply(
    `📅 <b>${time.prettyDate(s.xc.date)}</b> — ishga chaqirish\n👥 ${picker.namesText(list.filter(Boolean), 10)}\n💰 Har biriga: <b>+${kpi.fmtMoney(n)}</b> (o'sha kuni «Keldim» qilsa)\n\nYuborilsinmi?`,
    { parse_mode: 'HTML', ...inline([[cb('📤 Yuborish', 'xc:ok'), cb(ui.BTN.cancel, 'xc:x')]]) },
  );
};

const confirm = async (ctx) => {
  if (!(await guard(ctx))) return;
  const s = session.get(ctx.from.id);
  if (s.step !== 'xc_confirm' || !s.xc || !s.xc.amount) return ctx.answerCbQuery('Eskirgan tugma', { show_alert: true });
  session.clear(ctx.from.id); // ikki marta bosilsa — ikkinchisi o'tmaydi
  await ctx.answerCbQuery();
  const { date, ids, amount } = s.xc;
  const who = require('../services/org').actorName(ctx);
  let n = 0;
  for (const id of ids) {
    const e = await employees.byId(id);
    if (!e || !e.active) continue;
    await extradays.create({ employeeId: e.id, date, amount, createdBy: ctx.from.id });
    n += 1;
    await notify.toUser(botOf(ctx), e.tg_id,
      `📅 <b>${esc(who)}</b> sizni <b>${time.prettyDate(date)}</b> (dam olish kuni) ishga chaqirdi.\n💰 Qo'shimcha haq: <b>+${kpi.fmtMoney(amount)}</b> — o'sha kuni «${ui.BTN.checkIn}» qilsangiz oylikka qo'shiladi.`);
  }
  return render(ctx, `✅ ${n} ta hodim ${time.prettyDate(date)} ga chaqirildi (+${kpi.fmtMoney(amount)}). Ularga xabar bordi.`, inline([[cb('📅 Chaqiruvlar', 'xc:home')]]));
};

const remove = async (ctx, id) => {
  if (!(await guard(ctx))) return;
  const x = await extradays.byId(id);
  if (!x || !(await extradays.cancel(id, ctx.from.id))) { await ctx.answerCbQuery('Bekor qilib bo\'lmaydi (keldi yoki allaqachon bekor)', { show_alert: true }); return home(ctx); }
  await ctx.answerCbQuery('Bekor qilindi');
  await notify.toUser(botOf(ctx), x.tg_id, `🚫 ${time.prettyDate(x.work_date)} (dam olish kuni) ga chaqiruv <b>bekor qilindi</b>.`);
  return home(ctx);
};

const register = (bot) => {
  bot.command('chaqirish', home);
  bot.action('xc:home', async (ctx) => { await ctx.answerCbQuery(); return home(ctx); });
  bot.action('xc:new', async (ctx) => { await ctx.answerCbQuery(); return askDate(ctx); });
  bot.action(/^xc:dt:(\d{4}-\d{2}-\d{2}|type)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'type') {
      session.set(ctx.from.id, { step: 'xc_date' });
      return ctx.reply('📆 Sanani yozing (masalan 12.10 yoki 12-oktabr):', ui.cancelKeyboard());
    }
    return setDate(ctx, ctx.match[1]);
  });
  bot.action('xc:ok', confirm);
  bot.action('xc:x', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); return render(ctx, '❌ Bekor qilindi.'); });
  bot.action(/^xc:del:(\d+)$/, (ctx) => remove(ctx, Number(ctx.match[1])));
  pick.register(bot);
};

/** xc_date bosqichi (matn) */
const handleDate = (ctx) => setDate(ctx, time.parseDate(ctx.message.text));

module.exports = { register, home, handleAmount, handleDate };
