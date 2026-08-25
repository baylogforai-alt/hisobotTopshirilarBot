'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const employees = require('../services/employees');
const notify = require('../services/notify');
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
/excel — o'z ishlarimni Excel faylda yuklab olish
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
/jamoa_excel — butun jamoa hisobotini Excel faylda olish
/kechikkanlar — muddati o'tgan missiyalar
/eslat — hoziroq eslatma yuborish
/holat — tizim holati (baza, guruh)
/guruh_ulash — <i>guruh ichida</i> yozilsa, o'sha guruh ishchi guruh bo'ladi
`.trim();

const register = (bot) => {
  bot.use(attachEmployee);

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
    return ctx.reply('🏠 Asosiy menyu', ui.mainKeyboard(ctx.state.isAdmin));
  });

  bot.command(['yordam', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
};

module.exports = { register, attachEmployee, notRegistered, HELP };
