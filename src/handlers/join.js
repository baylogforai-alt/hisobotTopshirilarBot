'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render, guard } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const requests = require('../services/requests');
const notify = require('../services/notify');

const { esc, cb, inline } = ui;

/**
 * HODIM QO'SHISH SEHRGARI (faqat direktor).
 *   jr:add:<reqId>  — so'rovdan (ID va ism tayyor)          ┐
 *   ea:start        — paneldan (avval ID so'raladi)          ┴→ ism → lavozim → bo'lim → rol → tasdiqlash
 * Sessiya: { step, add: { tgId, fullName, username, position, departmentId, role, reqId } }
 */

const botOf = (ctx) => ({ telegram: ctx.telegram });

const askName = (ctx, add) => {
  session.set(ctx.from.id, { step: 'add_name', add });
  return ctx.reply(
    `👤 <b>Hodimning ism-familiyasini yozing.</b>\n` +
      (add.fullName ? `Telegramdagi ismi: <b>${esc(add.fullName)}</b> — shuni qoldirish uchun «${ui.BTN.skip}».` : ''),
    { parse_mode: 'HTML', ...(add.fullName ? ui.skipKeyboard() : ui.cancelKeyboard()) },
  );
};

const askPosition = (ctx, add) => {
  session.set(ctx.from.id, { step: 'add_position', add });
  return ctx.reply(
    `💼 <b>Lavozimi?</b> (masalan: Buxgalter, Sotuv menejeri, Ombor mudiri)\nBo'lmasa «${ui.BTN.skip}».`,
    { parse_mode: 'HTML', ...ui.skipKeyboard() },
  );
};

const askDepartment = async (ctx, add) => {
  session.set(ctx.from.id, { step: 'add_dept', add });
  const list = await departments.listActive();
  const rows = list.map((d) => [cb(`🏢 ${d.name}`, `ea:dept:${d.id}`)]);
  rows.push([cb("➕ Yangi bo'lim yaratish", 'ea:dept:new'), cb("— Bo'limsiz", 'ea:dept:0')]);
  rows.push([cb(ui.BTN.cancel, 'ea:cancel')]);
  return ctx.reply(`🏢 <b>Qaysi bo'limga?</b>`, { parse_mode: 'HTML', ...inline(rows) });
};

const askRole = (ctx, add) => {
  session.set(ctx.from.id, { step: 'add_role', add });
  return ctx.reply(
    `🎖 <b>Roli?</b>\n\n👤 <b>Hodim</b> — topshiriq oladi, bajaradi.\n🎖 <b>Bo'lim boshlig'i</b> — o'z bo'limiga topshiriq beradi, tekshiradi, baholaydi.\n👑 <b>Direktor / HR</b> — hamma narsa.`,
    { parse_mode: 'HTML', ...inline([
      [cb('👤 Hodim', 'ea:role:employee'), cb("🎖 Bo'lim boshlig'i", 'ea:role:head')],
      [cb('👑 Direktor / HR', 'ea:role:admin')],
      [cb(ui.BTN.cancel, 'ea:cancel')],
    ]) },
  );
};

const summary = async (add) => {
  const dept = add.departmentId ? await departments.byId(add.departmentId) : null;
  return (
    `🆔 <code>${add.tgId}</code>${add.username ? ` (@${esc(add.username)})` : ''}\n` +
    `👤 <b>${esc(add.fullName)}</b>\n💼 ${esc(add.position || '—')}\n🏢 ${esc(dept ? dept.name : "Bo'limsiz")}\n🎖 ${employees.roleLabel(add.role)}`
  );
};

const confirm = async (ctx, add) => {
  session.set(ctx.from.id, { step: 'add_confirm', add });
  return render(ctx, `✅ <b>Tekshiring:</b>\n\n${await summary(add)}\n\nQo'shamizmi?`, ui.confirmKeyboard('ea:ok', 'ea:cancel', "✅ Ha, qo'shish", '❌ Bekor'));
};

const finish = async (ctx) => {
  const { add } = session.get(ctx.from.id);
  if (!add || !add.tgId) return ctx.answerCbQuery('Sessiya eskirgan');
  const { employee, created } = await employees.add({
    tgId: add.tgId, fullName: add.fullName, position: add.position || null, role: add.role || 'employee',
    departmentId: add.departmentId || null, username: add.username || null,
  });
  await requests.closeFor(add.tgId, 'approved', ctx.from.id);
  session.clear(ctx.from.id);

  await render(ctx, `🎉 <b>${esc(employee.full_name)}</b> ${created ? "qo'shildi" : 'yangilandi'}.\n\n${await summary(add)}`, ui.backKeyboard(`emp:${employee.id}`, '👤 Kartochkasi'));
  await ctx.reply('⚙️ Panel', ui.kbFor(ctx));

  const kb = ui.mainKeyboard({ isAdmin: employee.role === 'admin', isHead: employee.role === 'head' });
  await notify.toUser(
    botOf(ctx), employee.tg_id,
    `🎉 <b>Xush kelibsiz, ${esc(employee.full_name)}!</b>\n\n` +
      `Siz tizimga <b>${employees.roleLabel(employee.role)}</b>${employee.department_name ? ` (${esc(employee.department_name)})` : ''} sifatida qo'shildingiz.\n\n` +
      `Ertaga ishga kelganingizda «${ui.BTN.checkIn}» tugmasini bosing. Qo'llanma: /yordam`,
    kb,
  );
};

// --- matn bosqichlari ---

const handleTgId = async (ctx) => {
  const { add = {} } = session.get(ctx.from.id);
  const m = ctx.message.text.match(/\d{5,15}/);
  if (!m) return ctx.reply('Telegram ID faqat raqamlardan iborat (masalan 123456789). Qaytadan yozing:', ui.cancelKeyboard());
  add.tgId = Number(m[0]);
  const existing = await employees.byTgId(add.tgId);
  if (existing && existing.active) {
    session.clear(ctx.from.id);
    return ctx.reply(`ℹ️ Bu ID allaqachon ro'yxatda: <b>${esc(existing.full_name)}</b>.`, { parse_mode: 'HTML', ...ui.backKeyboard(`emp:${existing.id}`, '👤 Kartochkasi') });
  }
  if (existing) { add.fullName = existing.full_name; add.position = existing.position; add.username = existing.username; }
  return askName(ctx, add);
};

const handleName = async (ctx, { skip = false } = {}) => {
  const { add } = session.get(ctx.from.id);
  if (!add) return ctx.reply('Sessiya eskirgan. /panel');
  if (!skip) add.fullName = ctx.message.text.trim().slice(0, 100);
  if (!add.fullName) return askName(ctx, add);
  return askPosition(ctx, add);
};

const handlePosition = async (ctx, { skip = false } = {}) => {
  const { add } = session.get(ctx.from.id);
  if (!add) return ctx.reply('Sessiya eskirgan. /panel');
  add.position = skip ? add.position || null : ctx.message.text.trim().slice(0, 60);
  await ctx.reply('👌', { reply_markup: { remove_keyboard: true } });
  return askDepartment(ctx, add);
};

const handleDeptName = async (ctx) => {
  const { add } = session.get(ctx.from.id);
  if (!add) return ctx.reply('Sessiya eskirgan. /panel');
  const { department, created } = await departments.create(ctx.message.text);
  add.departmentId = department.id;
  await ctx.reply(`🏢 Bo'lim «<b>${esc(department.name)}</b>» ${created ? 'yaratildi' : 'tanlandi'}.`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
  return askRole(ctx, add);
};

// --- so'rovlar ro'yxati ---

const listRequests = async (ctx) => {
  const list = await requests.listPending();
  if (!list.length) return render(ctx, "📝 Kutilayotgan so'rovlar yo'q.", ui.backKeyboard('adm:home'));
  const text = `📝 <b>KUTILAYOTGAN SO'ROVLAR (${list.length})</b>\n\n` +
    list.map((r, i) => `${i + 1}. <b>${esc(r.full_name)}</b>${r.username ? ` (@${esc(r.username)})` : ''} · <code>${r.tg_id}</code> · ${time.shortDate(String(r.created_at).slice(0, 10))} ${time.clock(r.created_at)}`).join('\n');
  const rows = list.map((r) => [cb(`➕ ${r.full_name.slice(0, 20)}`, `jr:add:${r.id}`), cb('🚫', `jr:no:${r.id}`)]);
  rows.push([cb('⬅️ Panel', 'adm:home')]);
  return render(ctx, text, inline(rows));
};

const register = (bot) => {
  bot.action(/^jr:add:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const req = await requests.byId(ctx.match[1]);
    if (!req) return ctx.answerCbQuery("So'rov topilmadi");
    await ctx.answerCbQuery();
    const existing = await employees.byTgId(req.tg_id);
    if (existing && existing.active) {
      await requests.decide(req.id, 'approved', ctx.from.id);
      return render(ctx, `ℹ️ <b>${esc(existing.full_name)}</b> allaqachon ro'yxatda.`, ui.backKeyboard(`emp:${existing.id}`, '👤 Kartochkasi'));
    }
    return askName(ctx, { tgId: req.tg_id, fullName: req.full_name, username: req.username, reqId: req.id });
  });

  bot.action(/^jr:no:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const req = await requests.byId(ctx.match[1]);
    if (!req) return ctx.answerCbQuery("So'rov topilmadi");
    await requests.decide(req.id, 'rejected', ctx.from.id);
    await ctx.answerCbQuery('Rad etildi');
    await render(ctx, `🚫 <b>${esc(req.full_name)}</b> (<code>${req.tg_id}</code>) rad etildi.`);
    await notify.toUser(botOf(ctx), req.tg_id, `Kechirasiz, so'rovingiz rad etildi.`);
  });

  bot.action('jr:list', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await listRequests(ctx); } });
  bot.command('sorovlar', async (ctx) => { if (await guard(ctx)) await listRequests(ctx); });

  bot.action('ea:start', async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'add_tgid', add: {} });
    return ctx.reply(
      `🆔 <b>Yangi hodimning Telegram ID sini yozing.</b>\n\n` +
        `Hodim botga kirib /start bossa — ID si o'ziga ko'rinadi va sizga so'rov keladi (u holda bu bosqich shart emas).`,
      { parse_mode: 'HTML', ...ui.cancelKeyboard() },
    );
  });

  bot.command('hodim_qosh', async (ctx) => {
    if (!(await guard(ctx))) return;
    session.set(ctx.from.id, { step: 'add_tgid', add: {} });
    const arg = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
    if (/^\d{5,15}$/.test(arg)) { ctx.message.text = arg; return handleTgId(ctx); }
    return ctx.reply('🆔 Yangi hodimning Telegram ID sini yozing:', ui.cancelKeyboard());
  });

  bot.action(/^ea:dept:(\d+|new)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const { add } = session.get(ctx.from.id);
    if (!add) return ctx.answerCbQuery('Sessiya eskirgan');
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'new') {
      session.set(ctx.from.id, { step: 'add_dept_name', add });
      return ctx.reply("🏢 Yangi bo'lim nomini yozing (masalan: Buxgalteriya):", ui.cancelKeyboard());
    }
    add.departmentId = Number(ctx.match[1]) || null;
    return askRole(ctx, add);
  });

  bot.action(/^ea:role:(employee|head|admin)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const { add } = session.get(ctx.from.id);
    if (!add) return ctx.answerCbQuery('Sessiya eskirgan');
    await ctx.answerCbQuery();
    add.role = ctx.match[1];
    return confirm(ctx, add);
  });

  bot.action('ea:ok', async (ctx) => { if (await guard(ctx)) { await ctx.answerCbQuery(); await finish(ctx); } });
  bot.action('ea:cancel', async (ctx) => {
    session.clear(ctx.from.id);
    await ctx.answerCbQuery('Bekor qilindi');
    await render(ctx, '❌ Bekor qilindi.');
  });
};

module.exports = { register, handleTgId, handleName, handlePosition, handleDeptName, listRequests };
