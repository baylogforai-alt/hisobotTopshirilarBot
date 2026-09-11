'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const employees = require('../services/employees');
const notify = require('../services/notify');
const activity = require('../services/activity');
const session = require('../session');

/** Har bir update uchun hodim ma'lumotini biriktiradi */
const attachEmployee = async (ctx, next) => {
  const from = ctx.from;
  if (from) {
    const emp = await employees.byTgId(from.id);
    if (emp) await employees.touchUsername(from.id, from.username);
    ctx.state.employee = emp && emp.active ? emp : null;
    ctx.state.isAdmin = await employees.isAdmin(from.id);
  }
  return next();
};

/**
 * Hodimning botdagi HAR BIR harakatini jurnalga yozadi.
 * next() dan KEYIN ishlaydi: agar handler o'zi mazmunli yozuv qoldirgan bo'lsa
 * (ctx.state.logged), takroriy "botdan foydalandi" yozuvi qo'shilmaydi.
 */
const trackUsage = async (ctx, next) => {
  await next();
  try {
    if (!ctx.state || !ctx.state.employee || ctx.state.logged) return;
    if (ctx.chat && ctx.chat.type !== 'private') return;

    if (ctx.updateType === 'callback_query') {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (!data) return;
      await activity.log(ctx.state.employee, 'use', { title: 'Tugma bosdi', detail: data });
      return;
    }
    if (ctx.updateType === 'message' && ctx.message && ctx.message.text) {
      const text = ctx.message.text.trim();
      const isCommand = text.startsWith('/');
      await activity.log(ctx.state.employee, 'use', {
        title: isCommand ? text.split(/\s+/)[0] : text,
        detail: isCommand ? 'buyruq' : 'tugma / matn',
      });
    }
  } catch (err) {
    console.error('[activity] kuzatuv xatosi:', err.message);
  }
};

/** Ro'yxatdan o'tmaganlar uchun javob */
const notRegistered = (ctx) =>
  ctx.reply(
    `👋 Salom, ${ui.esc(ctx.from.first_name || '')}!\n\n` +
      `Siz hali <b>${ui.esc(config.companyName)}</b> tizimida hodim sifatida ro'yxatdan o'tmagansiz.\n\n` +
      `🆔 Sizning Telegram ID: <code>${ctx.from.id}</code>\n\n` +
      `Shu ID ni <b>administratorga</b> yuboring — u sizni tizimga qo'shadi.`,
    { parse_mode: 'HTML' },
  );

const HELP = `
<b>📖 BOT QO'LLANMASI</b>

<b>Kundalik tartib:</b>
1️⃣ Ishga kelganingizda — <b>«✅ Ishga keldim»</b>. Shunda yozib qo'ygan missiyalaringiz ishga tushadi.
2️⃣ Kun davomida bot har necha soatda guruhda va shaxsiy chatda eslatib turadi.
3️⃣ Biror ishni tugatsangiz — <b>«✔️ Bajardim»</b> → ro'yxatdan tanlang.
4️⃣ Ish oxirida — <b>«➕ Missiya qo'shish»</b> bilan ertangi (yoki 2-3 kunlik, 1 oylik) ishlaringizni yozing.
5️⃣ Keyin <b>«🏁 Ishdan ketaman»</b> tugmasini bosing.

⚠️ Bajarilmagan missiyalar <b>o'chib ketmaydi</b> — ertangi ro'yxatga qo'shilib qoladi.

<b>Buyruqlar:</b>
/start — botni ishga tushirish
/menu — asosiy menyu
/vazifa [matn] — yangi missiya (ertaga yoki keyingi kunlarga)
/bugun [matn] — bugun paydo bo'lgan qo'shimcha topshiriq
/missiyalarim — barcha missiyalarim
/bajardim — bajarilganini belgilash
/bekor — missiyani o'chirish
/hisobot — mening hisobotim
/excel — o'z ishlarimni Excel faylda yuklab olish (bugun / hafta / oy)
/id — Telegram ID ni bilish
/yordam — shu qo'llanma

<b>Admin buyruqlari:</b>
/hodim_qosh &lt;tg_id&gt; &lt;Ism Familiya&gt; — hodim qo'shish
/hodimlar — hodimlar ro'yxati (missiyalarini ko'rish tugmalari bilan)
/hodim_missiya &lt;tg_id&gt; — bitta hodimning barcha missiyalari
/hodim_ochir &lt;tg_id&gt; — hodimni o'chirish
/admin_qil &lt;tg_id&gt; — admin qilish
/erkin &lt;tg_id&gt; — erkin jadval (o'qish/kurs sababli nazoratdan ozod)
/topshiriq &lt;tg_id&gt; &lt;matn&gt; — hodimga missiya berish
/umumiy_hisobot — barcha hodimlar holati (hozirgi)
/kun_hisobot — kim aynan qaysi ishni qilgani (batafsil)
/jamoa_excel — Excel yuklab olish: davr (kun/hafta/oy) → butun jamoa, har bir hodim alohida yoki bitta hodim

<b>📈 Davr hisoboti (sana tanlab):</b>
/davr — hisobot markazi: boshlanish va tugash sanasini tanlang
<i>Kalendardan yoki tayyor tugmalardan (bugun, shu hafta, o'tgan oy, 30 kun…)
davrni tanlaysiz, keyin «Butun jamoa» yoki bitta hodimni tanlab, hisobotni
ekranda ko'rasiz yoki Excel qilib yuklab olasiz.</i>
/oraliq &lt;boshlanish&gt; &lt;tugash&gt; [tg_id] — bir buyruq bilan
<i>Masalan: /oraliq 2026-09-01 2026-09-07</i>

<b>🗂 Hodimlar arxivi (ilova):</b>
/arxiv — hodimlarni tanlab, kun-kun faoliyatini ko'rish
/hodim_hisobot &lt;tg_id&gt; — bitta hodimning bugungi kun daftari
<i>Arxiv ichida: kun daftari (qachon kelgan/ketgan, nima bajargan, nima
yozgan), harakatlar tarixi, 7 va 30 kunlik hisobot, Excel yuklab olish.</i>
/kechikkanlar — muddati o'tgan missiyalar
/eslat — hoziroq eslatma yuborish
/holat — tizim holati (baza, guruh)
/guruh_ulash — <i>guruh ichida</i> yozilsa, o'sha guruh ishchi guruh bo'ladi
`.trim();

const register = (bot) => {
  bot.use(attachEmployee);
  bot.use(trackUsage);

  bot.command('id', (ctx) =>
    ctx.reply(`🆔 Telegram ID: <code>${ctx.from.id}</code>\n💬 Chat ID: <code>${ctx.chat.id}</code>`, {
      parse_mode: 'HTML',
    }),
  );

  // Guruhni ulash
  bot.command('guruh_ulash', async (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('Bu buyruqni ishchi <b>guruh ichida</b> yozing.', { parse_mode: 'HTML' });
    }
    if (!ctx.state.isAdmin) return ctx.reply('⛔️ Faqat admin ulay oladi.');
    await notify.setGroupId(ctx.chat.id);
    return ctx.reply(
      `✅ Bu guruh ishchi guruh sifatida ulandi.\n<code>${ctx.chat.id}</code>\n\n` +
        `Endi missiya eslatmalari va kunlik hisobotlar shu yerga tushadi.`,
      { parse_mode: 'HTML' },
    );
  });

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    session.clear(ctx.from.id);
    const emp = ctx.state.employee;
    if (!emp) return notRegistered(ctx);
    activity.mark(ctx, 'start');
    return ctx.reply(
      `👋 Salom, <b>${ui.esc(emp.full_name)}</b>!\n` +
        `<i>${ui.esc(config.companyName)}${emp.position ? ` · ${ui.esc(emp.position)}` : ''}</i>\n\n` +
        `Bugun: <i>${time.prettyDate(time.today())}</i>\n\n` +
        `Pastdagi tugmalardan foydalaning. Qo'llanma: /yordam`,
      { parse_mode: 'HTML', ...ui.mainKeyboard(ctx.state.isAdmin) },
    );
  });

  bot.command('menu', (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!ctx.state.employee) return notRegistered(ctx);
    session.clear(ctx.from.id);
    activity.mark(ctx, 'menu');
    return ctx.reply('🏠 Asosiy menyu', ui.mainKeyboard(ctx.state.isAdmin));
  });

  bot.command(['yordam', 'help'], (ctx) => {
    activity.mark(ctx, 'help');
    return ctx.reply(HELP, { parse_mode: 'HTML' });
  });
};

module.exports = { register, attachEmployee, trackUsage, notRegistered, HELP };
