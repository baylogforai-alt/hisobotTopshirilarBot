'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const employees = require('../services/employees');
const requests = require('../services/requests');
const notify = require('../services/notify');
const activity = require('../services/activity');

const { esc } = ui;

/** Har bir update uchun: hodim, rol */
const attachEmployee = async (ctx, next) => {
  const from = ctx.from;
  if (from) {
    const emp = await employees.byTgId(from.id);
    if (emp) await employees.touchUsername(from.id, from.username);
    ctx.state.employee = emp && emp.active ? emp : null;
    ctx.state.isAdmin = employees.isAdmin(ctx.state.employee, from.id);
    ctx.state.isHead = employees.isHead(ctx.state.employee);
    ctx.state.isManager = ctx.state.isAdmin || ctx.state.isHead;
    // Ro'yxatda yo'qlar tugma bossa — hech qanday handler ishlamasin
    if (ctx.updateType === 'callback_query' && !ctx.state.employee && !ctx.state.isAdmin) {
      return ctx.answerCbQuery("⛔️ Siz ro'yxatda yo'qsiz", { show_alert: true }).catch(() => {});
    }
  }
  return next();
};

/**
 * Hodimning botdagi HAR BIR harakatini jurnalga yozadi (arxiv / kun daftari uchun).
 * next() dan KEYIN ishlaydi: handler o'zi mazmunli yozuv qoldirgan bo'lsa
 * (ctx.state.logged), takroriy "botdan foydalandi" yozuvi qo'shilmaydi.
 */
const trackUsage = async (ctx, next) => {
  await next();
  try {
    if (!ctx.state || !ctx.state.employee || ctx.state.logged) return;
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (ctx.updateType === 'callback_query') {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (data) await activity.log(ctx.state.employee, 'use', { title: 'Tugma bosdi', detail: data });
      return;
    }
    if (ctx.updateType === 'message' && ctx.message && ctx.message.text) {
      const text = ctx.message.text.trim();
      const isCommand = text.startsWith('/');
      await activity.log(ctx.state.employee, 'use', { title: isCommand ? text.split(/\s+/)[0] : text, detail: isCommand ? 'buyruq' : 'tugma / matn' });
    }
  } catch (err) {
    console.error('[activity] kuzatuv xatosi:', err.message);
  }
};

/**
 * Ro'yxatda yo'q odam. Faqat ID ko'rsatiladi; direktorga BIR MARTA so'rov boradi
 * (jr:add / jr:no tugmalari bilan). Boshqa hech narsa ishlamaydi.
 */
const notRegistered = async (ctx, { notifyAdmins = true } = {}) => {
  if (ctx.chat.type !== 'private') return;
  const from = ctx.from;
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || `ID ${from.id}`;
  const { request, created } = await requests.create({ tgId: from.id, fullName, username: from.username || null });

  await ctx.reply(
    `👋 Salom, ${esc(from.first_name || '')}!\n\n` +
      `Bu <b>${esc(config.companyName)}</b> hodimlari uchun yopiq bot. Siz hali ro'yxatda yo'qsiz.\n\n` +
      `🆔 Sizning Telegram ID: <code>${from.id}</code>\n\n` +
      (created
        ? `📨 Direktorga so'rov yuborildi. Tasdiqlanishi bilan bot ishga tushadi.`
        : `⏳ So'rovingiz ${time.clock(request.created_at)} da yuborilgan, direktor ko'rib chiqishini kuting.`),
    { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
  );

  if (created && notifyAdmins) {
    await notify.toAdmins(
      { telegram: ctx.telegram },
      `🆕 <b>Yangi odam botga kirdi</b>\n\n👤 ${esc(fullName)}${from.username ? ` (@${esc(from.username)})` : ''}\n🆔 <code>${from.id}</code>\n\nHodim qilib qo'shasizmi?`,
      ui.joinKeyboard(request.id),
    );
  }
};

const HELP_EMPLOYEE = `
<b>📖 QO'LLANMA</b>

<b>Har kuni:</b>
1️⃣ Ishga kelganingizda — <b>«${ui.BTN.checkIn}»</b> → joylashuvni yuborasiz (faqat ofisdan qabul qilinadi). Kechiksangiz sabab so'raladi.
2️⃣ Missiyalaringiz «${ui.BTN.myTasks}» da. Boshliq yangi topshiriq bersa — xabar keladi.
3️⃣ Ishni tugatsangiz — <b>«${ui.BTN.done}»</b> → ro'yxatdan tanlang → xohlasangiz rasm/video biriktiring. Boshliq tekshirib qabul qiladi yoki qaytaradi.
4️⃣ O'zingizga reja yozish — «${ui.BTN.selfTask}» (har birini yangi qatorda; boshiga <b>!</b> — muhim). Kun ichida paydo bo'lgan ish: <code>/bugun matn</code>.
5️⃣ Kun oxirida — <b>«${ui.BTN.dailyReport}»</b>: bugun nima qildingiz, qanday muammo bo'ldi — o'z so'zingiz bilan (rasm ham mumkin). Boshliq o'qiydi.
6️⃣ Ketishda — «${ui.BTN.checkOut}».

🙋 Kela olmasangiz — «${ui.BTN.absence}» → sababini yozing, boshliq tasdiqlasa kun sababli hisoblanadi.
🔴 Muddati o'tgan topshiriqlar qizil belgi bilan ko'rinadi va KPI ga ta'sir qiladi. Bajarilmagan ish yo'qolmaydi — ertangi ro'yxatda turadi.
📊 «${ui.BTN.myReport}» — shu oydagi natijalaringiz va KPI. /excel — hisobotingiz Excel faylda.

<b>Buyruqlar:</b> /menu · /keldim · /ketdim · /missiyalarim · /bajardim · /vazifa · /bugun · /kunlik · /hisobot · /excel · /id · /yordam
`.trim();

const HELP_MANAGER = `

<b>Boshliq / direktor uchun:</b>
📤 «${ui.BTN.assign}» — hodimga topshiriq (matn + muddat). Hodimga darhol xabar boradi.
🔎 «${ui.BTN.review}» — «Bajardim» deganlarni qabul qilish / qaytarish.
⭐ «${ui.BTN.score}» — oy oxirida bo'lim hodimlarini 1–10 baholash (KPI ga kiradi).
🏢 «${ui.BTN.myDept}» — bo'lim holati (bugun va oy).
📝 Hodimlarning kunlik hisobotlari sizga shaxsiy keladi — «Ko'rdim» yoki izoh qoldirasiz.
/topshiriq · /tekshiruv · /bolim · /baholash
`.trim();

const HELP_ADMIN = `

<b>Direktor:</b>
⚙️ «${ui.BTN.panel}» — hodimlar, bo'limlar, so'rovlar, ofis, bugungi holat, kunlik hisobotlar, eslatma.
💰 «${ui.BTN.kpi}» — oylik KPI: hodimni tanlab ko'rish, tahrirlash, tasdiqlash, chiqarish, Excel.
📈 «${ui.BTN.reports}» — jamoa/bo'lim hisobotlari, davr hisoboti (istalgan sana oralig'i), Excel.
🗂 «${ui.BTN.archive}» — hodimlar arxivi: kun daftari, harakatlar tarixi, 7/30 kunlik, Excel.
/panel · /kpi · /hisobotlar · /arxiv · /davr · /oraliq · /jamoa_excel · /hodim_qosh · /ofis · /holat · /guruh_ulash (guruh ichida)
`.trim();

const helpText = (ctx) => HELP_EMPLOYEE + (ctx.state.isManager ? HELP_MANAGER : '') + (ctx.state.isAdmin ? HELP_ADMIN : '');

const welcome = (ctx) => {
  const emp = ctx.state.employee;
  const name = emp ? emp.full_name : ctx.from.first_name || 'Rahbar';
  const role = emp ? employees.roleLabel(emp.role) : 'Direktor / HR';
  return (
    `👋 Salom, <b>${esc(name)}</b>!\n` +
    `<i>${esc(config.companyName)} · ${esc(emp && emp.position ? emp.position : role)}${emp && emp.department_name ? ` · ${esc(emp.department_name)}` : ''}</i>\n\n` +
    `Bugun: ${time.prettyDate(time.today())}\n\nPastdagi tugmalardan foydalaning. Qo'llanma: /yordam` +
    (!emp && ctx.state.isAdmin ? `\n\n💡 O'zingizni ham hodim sifatida qo'shish: «${ui.BTN.panel}» → «➕ Hodim qo'shish» → ID: <code>${ctx.from.id}</code>` : '')
  );
};

const register = (bot) => {
  bot.use(attachEmployee);
  bot.use(trackUsage);

  bot.command('id', (ctx) => ctx.reply(`🆔 Telegram ID: <code>${ctx.from.id}</code>\n💬 Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' }));

  bot.command('guruh_ulash', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('Bu buyruqni ishchi <b>guruh ichida</b> yozing.', { parse_mode: 'HTML' });
    if (!ctx.state.isAdmin) return ctx.reply('⛔️ Faqat direktor ulay oladi.');
    await notify.setGroupId(ctx.chat.id);
    return ctx.reply(`✅ Bu guruh ishchi guruh sifatida ulandi (<code>${ctx.chat.id}</code>). Ertalabki chaqiriq, eslatmalar va kun yakuni shu yerga tushadi.`, { parse_mode: 'HTML' });
  });

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    session.clear(ctx.from.id);
    if (!ctx.state.employee && !ctx.state.isAdmin) return notRegistered(ctx);
    activity.mark(ctx, 'start');
    return ctx.reply(welcome(ctx), { parse_mode: 'HTML', ...ui.kbFor(ctx) });
  });

  bot.command('menu', (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!ctx.state.employee && !ctx.state.isAdmin) return notRegistered(ctx);
    session.clear(ctx.from.id);
    activity.mark(ctx, 'menu');
    return ctx.reply('🏠 Asosiy menyu', ui.kbFor(ctx));
  });

  bot.command(['yordam', 'help'], (ctx) => {
    if (!ctx.state.employee && !ctx.state.isAdmin) return notRegistered(ctx);
    activity.mark(ctx, 'help');
    return ctx.reply(helpText(ctx), { parse_mode: 'HTML' });
  });
};

module.exports = { register, attachEmployee, trackUsage, notRegistered, helpText };
