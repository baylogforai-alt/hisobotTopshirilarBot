'use strict';

const config = require('../config');
const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const employees = require('../services/employees');
const requests = require('../services/requests');
const notify = require('../services/notify');
const activity = require('../services/activity');
const access = require('../services/access');
const webapp = require('../services/webapp');
const db = require('../db');

const { esc } = ui;

/** Har bir update uchun: hodim, rol */
const attachEmployee = async (ctx, next) => {
  const from = ctx.from;
  if (from) {
    const actor = await access.resolve(from.id, from);
    if (actor.employee) await employees.touchUsername(from.id, from.username);
    ctx.state.actor = actor;
    ctx.state.employee = actor.employee;
    ctx.state.isAdmin = actor.isAdmin;
    ctx.state.isHead = actor.isHead;
    ctx.state.isHr = actor.isHr;
    ctx.state.isManager = actor.isManager;
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
0️⃣ Har oyning 1-kuni «yangi ish oyi» xabari keladi — «✅ Tanishdim» ni bosing${config.monthStartRequired ? ' (shundan keyin «' + ui.BTN.checkIn + '» ochiladi)' : ''}.
1️⃣ Ishga kelganingizda — <b>«${ui.BTN.checkIn}»</b> → joylashuvni yuborasiz${config.officeCheckinVideo ? ' → <b>video</b>' : ''} (ofis radiusida; hudud agenti — uyidan ${(config.fieldMinDistanceM / 1000).toLocaleString('uz')} km dan uzoqda). Kechiksangiz sabab so'raladi.
📍 Hudud agenti borgan joyida — «${ui.BTN.visit}» → joylashuv → video yoki audio → izoh.
2️⃣ Missiyalaringiz «${ui.BTN.myTasks}» da. Boshliq yangi topshiriq bersa (matn, 🎤 ovoz, 🎥 video yoki 📄 fayl) — xabar keladi, <b>«✅ Eshitdim, tushundim»</b> ni bosing (yoki «tushundim» deb yozing).
3️⃣ Ishni tugatsangiz — <b>«${ui.BTN.done}»</b> → ro'yxatdan tanlang → isbot: rasm, video, audio yoki fayl (PDF, Excel, Word…). Boshliq tekshirib qabul qiladi yoki kamchilik yozib qaytaradi. «Bajardim» — faqat «${ui.BTN.checkIn}» dan keyin.
4️⃣ O'zingizga reja yozish — «${ui.BTN.selfTask}» (har birini yangi qatorda; boshiga <b>!</b> — muhim). Kun ichida paydo bo'lgan ish: <code>/bugun matn</code>.
5️⃣ Kun oxirida — <b>«${ui.BTN.dailyReport}»</b>: bugun nima qildingiz, qanday muammo bo'ldi — o'z so'zingiz bilan (rasm ham mumkin). Boshliq o'qiydi.
6️⃣ Ketishda — «${ui.BTN.checkOut}» → <b>joylashuv</b> → <b>izoh</b> (nima qildingiz). Ish tugashidan oldin ketsangiz — «erta ketdi» deb belgilanadi.
📌 «${ui.BTN.stActive}», «${ui.BTN.stFix}», «${ui.BTN.stReview}», «${ui.BTN.stDone}» — missiyalar holati bo'yicha (nechta va qaysilari).

⏰ Kech qolsangiz — «${ui.BTN.late}» → sababini yozing yoki video/audio yuboring. Ish boshlanishidan kamida ${config.lateNoticeMinBefore} daqiqa oldin aytsangiz — kechikish hisoblanmaydi.
🙋 Kela olmasangiz — «${ui.BTN.absence}» → sabab (matn, video, audio yoki rasm). Rahbar yoki boshliq tasdiqlasa kun sababli hisoblanadi.
↩️ Ishingiz kamchilik bilan qaytarilsa — «👌 Xo'p, tushundim» yoki «💬 O'z javobim» (matn, ovoz, video, rasm, fayl) bilan javob qaytarasiz.
⏰ Missiyaga boshlanish soati qo'yilgan bo'lsa — aynan o'sha soatda «hozir bajaring» xabari keladi.
🔴 Muddati o'tgan topshiriqlar qizil belgi bilan ko'rinadi va KPI ga ta'sir qiladi. Bajarilmagan ish yo'qolmaydi — ertangi ro'yxatda turadi.
📊 «${ui.BTN.myReport}» — shu oydagi natijalaringiz va KPI. /excel — hisobotingiz Excel faylda.
🔔 «${ui.BTN.reminders}» — topshiriq eslatmalari qachon kelsin (har N soat yoki o'z vaqtlaringiz) — direktor tasdiqlaydi.
💵 «${ui.BTN.salary}» — oklad, KPI va jami summa oyma-oy.
📢 Direktor e'lon yuborsa — «👁 O'qidim» ni bosing.

📱 /ilova — xuddi shu ishlar qulay oynada (agar ulangan bo'lsa).

<b>Buyruqlar:</b> /menu · /ilova · /keldim · /kech · /kelmayman · /ketdim · /missiyalarim · /bajardim · /vazifa · /bugun · /kunlik · /faol · /kutilmoqda · /bajarilgan · /korib_chiqish · /hisobot · /oylik · /kalkulyator · /eslatma · /tashrif · /excel · /id · /yordam
`.trim();

const HELP_MANAGER = `

<b>Boshliq / direktor / HR uchun:</b>
👥 «${ui.BTN.myTeam}» — jamoangiz: bugun kim keldi, har bir hodim hisoboti, topshiriq berish.
📤 «${ui.BTN.assign}» — topshiriq (matn, 🎤 ovoz, 🎥 video yoki 📄 fayl + muddat; hodim «✅ Tushundim» bilan tasdiqlaydi). Direktor avval rahbarni (HR, sotuv rahbari) ko'radi: o'ziga yoki «👥 Hodimlariga» → hodimni tanlaydi.
☑️ «Bir nechta / hammaga» — bir xil topshiriqni belgilangan hodimlarning har biriga. HR va direktor boshliqqa ham topshiriq bera oladi (u bajarganda isbot ixtiyoriy).
🔎 «${ui.BTN.review}» — «Bajardim» deganlarni qabul qilish / qaytarish. HR: «Bajardim» xabarlari o'ziga kelsinmi — shu yerdagi tugma bilan (/bajardim_xabar).
📢 «${ui.BTN.announce}» — e'lon (masalan «bugun majlis»): rahbar — o'z bo'limiga, HR va direktor — hammaga / bo'limlarga / tanlanganlarga.
⭐ «${ui.BTN.score}» — oy oxirida bo'lim hodimlarini 1–10 baholash (KPI ga kiradi).
🏢 «${ui.BTN.myDept}» — bo'lim holati (bugun va oy).
📝 Hodimlarning kunlik hisobotlari sizga shaxsiy keladi — «Ko'rdim» yoki izoh qoldirasiz.
/topshiriq · /tekshiruv · /bolim · /baholash
`.trim();

const HELP_ADMIN = `

<b>Direktor:</b>
⚙️ «${ui.BTN.panel}» — hodimlar, bo'limlar, so'rovlar, ofis va filiallar, ish vaqti, yo'nalishlar, eslatmalar, bugungi holat, kunlik hisobotlar, ko'rinish sozlamalari, KPI sharti.
📢 «${ui.BTN.announce}» — hammaga yoki tanlangan hodimlarga bitta e'lon (matn, rasm, video, ovoz, fayl) — kim o'qiganini ko'rasiz.
📋 «${ui.BTN.journal}» — barcha topshiriqlar jurnali: kim kimga qachon nima bergan, holati, «tushundi», isbot; 🗑 bekor qilish.
💰 «${ui.BTN.kpi}» — oylik KPI: hodimni tanlab ko'rish, tahrirlash, tasdiqlash, chiqarish, Excel.
🧮 /kalkulyator — KPI kalkulyator: «topshiriq 90%, baho 8 bo'lsa — qancha?» (kartochkada «🧮 Kalkulyatorda» — hodim raqamlari bilan).
📈 «${ui.BTN.reports}» — jamoa/bo'lim hisobotlari, davr hisoboti (istalgan sana oralig'i), Excel.
🗂 «${ui.BTN.archive}» — hodimlar arxivi: kun daftari, harakatlar tarixi, 7/30 kunlik, Excel.
💵 Panel → «Oyliklar» (/oyliklar) — hamma hodimning okladi va KPI summasi, bosib yoziladi.
📅 /chaqirish (Panel → «Dam olish kuniga chaqirish») — dam olish kuni ishlatish, qo'shimcha haq bilan.
🎬 /yordam_video — /yordam uchun video qo'llanma yuklash.
Hodim kartochkasida: filial, ish turi (ofis/hudud), ish boshlanishi va tugashi, video, oklad, KPI summasi, HR belgisi, davomat nazorati, topshiriqlari.
/panel · /elon · /jurnal · /kpi · /hisobotlar · /arxiv · /davr · /oraliq · /jamoa_excel · /hodim_qosh · /hodimlarim · /oyliklar · /chaqirish · /ish_vaqti · /nomlar · /filiallar · /tashriflar · /ofis · /holat · /guruh_ulash · /arxiv_ulash (guruh ichida)
`.trim();

const WEBAPP_HINT =
  `📱 <b>Ilova</b> — botning o'zi, faqat qulay oynada: topshiriq berish (bir nechta hodimga birdan), ro'yxatlar, tekshiruv, KPI, sozlamalar.\n` +
  `<i>Keldim (GPS + video) va «Bajardim» isboti — shu chatda. Qaysi biri qulay bo'lsa — o'shandan foydalaning.</i>`;

const helpText = (ctx) => HELP_EMPLOYEE + (ctx.state.isManager ? HELP_MANAGER : '') + (ctx.state.isAdmin ? HELP_ADMIN : '');

const welcome = (ctx) => {
  const emp = ctx.state.employee;
  const name = emp ? emp.full_name : require('../services/org').actorName(ctx);
  const role = emp ? employees.roleLabel(emp.role) : 'Direktor';
  return (
    `👋 Salom, <b>${esc(name)}</b>!\n` +
    `<i>${esc(config.companyName)} · ${esc(emp && emp.position ? emp.position : role)}${emp && emp.department_name ? ` · ${esc(emp.department_name)}` : ''}</i>\n\n` +
    `Bugun: ${time.prettyDate(time.today())}\n\nPastdagi tugmalardan foydalaning. Qo'llanma: /yordam` +
    (!emp && ctx.state.isAdmin ? `\n\n💡 O'zingizni ham hodim sifatida qo'shish: «${ui.BTN.panel}» → «➕ Hodim qo'shish» → ID: <code>${ctx.from.id}</code>` : '')
  );
};

/** Guruhlarda faqat shu buyruqlar ishlaydi — /oylik, /oyliklar, /kpi va h.k. guruhga chiqmasin */
const GROUP_COMMANDS = new Set(['/id', '/guruh_ulash', '/arxiv_ulash']);
const groupGuard = (ctx, next) => {
  if (!ctx.chat || ctx.chat.type === 'private') return next();
  const text = ctx.message && ctx.message.text;
  if (text && GROUP_COMMANDS.has(text.trim().split(/[\s@]/)[0].toLowerCase())) return next();
  if (ctx.updateType === 'callback_query') return ctx.answerCbQuery('Bu tugma faqat bot bilan shaxsiy chatda ishlaydi').catch(() => {});
  return undefined;
};

/** Menyu tugmasi yoki /buyruq — yarim qolgan bosqich tugaydi (keyingi matn eski bosqichga ketmasin) */
const KEEP_STEP = new Set([ui.BTN.cancel, ui.BTN.skip, ui.BTN.sendLocation]);
const MENU_TEXTS = new Set(Object.values(ui.BTN).filter((t) => !KEEP_STEP.has(t)));
const menuResetsStep = (ctx, next) => {
  const text = ctx.message && ctx.message.text && ctx.message.text.trim();
  if (text && ctx.from && ctx.chat && ctx.chat.type === 'private' && (MENU_TEXTS.has(text) || text.startsWith('/'))) session.clear(ctx.from.id);
  return next();
};

/**
 * Bir xil tugma (foydalanuvchi + callback_data) bir vaqtda ikki marta ishlamasin: Telegraf bitta paketdagi
 * update'larni parallel bajaradi — ikki marta tez bosish ikkita topshiriq / e'lon / xabar yaratardi.
 * Ketma-ket bosish esa handlerlarning o'zida (holat sharti bilan) to'xtatiladi.
 */
const inflight = new Set();
const dedupeCallbacks = async (ctx, next) => {
  if (ctx.updateType !== 'callback_query' || !ctx.from || !ctx.callbackQuery) return next();
  const key = `${ctx.from.id}:${ctx.callbackQuery.data}`;
  if (inflight.has(key)) return ctx.answerCbQuery('⏳ Bajarilmoqda…').catch(() => {});
  inflight.add(key);
  try {
    return await next();
  } finally {
    inflight.delete(key);
  }
};

const register = (bot) => {
  bot.use(dedupeCallbacks);
  bot.use(attachEmployee);
  bot.use(groupGuard);
  bot.use(menuResetsStep);
  bot.use(trackUsage);

  bot.command('id', (ctx) => ctx.reply(`🆔 Telegram ID: <code>${ctx.from.id}</code>\n💬 Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' }));

  bot.command('guruh_ulash', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('Bu buyruqni ishchi <b>guruh ichida</b> yozing.', { parse_mode: 'HTML' });
    if (!ctx.state.isAdmin) return ctx.reply('⛔️ Faqat direktor ulay oladi.');
    await notify.setGroupId(ctx.chat.id);
    return ctx.reply(`✅ Bu guruh ishchi guruh sifatida ulandi (<code>${ctx.chat.id}</code>). Ertalabki chaqiriq, eslatmalar va kun yakuni shu yerga tushadi.`, { parse_mode: 'HTML' });
  });

  bot.command('arxiv_ulash', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('Bu buyruqni <b>yopiq arxiv guruhi ichida</b> yozing (hodimlar a\'zo bo\'lmagan guruh).', { parse_mode: 'HTML' });
    if (!ctx.state.isAdmin) return ctx.reply('⛔️ Faqat direktor ulay oladi.');
    await notify.setArchiveId(ctx.chat.id);
    return ctx.reply(`🗄 Bu guruh <b>arxiv</b> sifatida ulandi (<code>${ctx.chat.id}</code>).\nKeldim videolari, tashriflar va «Bajardim» isbotlari shu yerga nusxalanadi — hodim o'z chatidan o'chirsa ham bu yerda va bazada qoladi.`, { parse_mode: 'HTML' });
  });

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    session.clear(ctx.from.id);
    if (!ctx.state.employee && !ctx.state.isAdmin) return notRegistered(ctx);
    // direktor (ADMIN_IDS) hodim sifatida qo'shilmagan bo'lsa ham eski «qo'shish» so'rovi osilib qolmasin
    if (!ctx.state.employee && ctx.state.isAdmin) await requests.closeFor(ctx.from.id, 'approved', ctx.from.id);
    activity.mark(ctx, 'start');
    await ctx.reply(welcome(ctx), { parse_mode: 'HTML', ...ui.kbFor(ctx) });
    if (webapp.enabled()) {
      await webapp.setMenuFor({ telegram: ctx.telegram }, ctx.from.id);
      await ctx.reply(WEBAPP_HINT, { parse_mode: 'HTML', ...webapp.keyboard('📱 Ilovani ochish') });
    }
  });

  bot.command('ilova', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!ctx.state.employee && !ctx.state.isAdmin) return notRegistered(ctx);
    if (!webapp.enabled()) return ctx.reply("📱 Web ilova hali ulanmagan — barcha amallar shu botda ishlaydi.");
    await webapp.setMenuFor({ telegram: ctx.telegram }, ctx.from.id);
    return ctx.reply(WEBAPP_HINT, { parse_mode: 'HTML', ...webapp.keyboard('📱 Ilovani ochish') });
  });

  bot.command('menu', (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!ctx.state.employee && !ctx.state.isAdmin) return notRegistered(ctx);
    session.clear(ctx.from.id);
    activity.mark(ctx, 'menu');
    return ctx.reply('🏠 Asosiy menyu', ui.kbFor(ctx));
  });

  bot.command(['yordam', 'help'], async (ctx) => {
    if (!ctx.state.employee && !ctx.state.isAdmin) return notRegistered(ctx);
    activity.mark(ctx, 'help');
    // video qo'llanma (boshliq /yordam_video bilan yuklaydi) — avval video, keyin matn
    const video = await helpVideo();
    if (video) await notify.sendProof({ telegram: ctx.telegram }, ctx.chat.id, video, "🎬 <b>Botdan foydalanish — video qo'llanma</b>");
    return ctx.reply(helpText(ctx), { parse_mode: 'HTML' });
  });

  // /yordam_video — boshliq/direktor qo'llanma videosini yuklaydi (keyingi yuborilgan video); «/yordam_video ochir» — olib tashlaydi
  bot.command('yordam_video', async (ctx) => {
    if (!ctx.state.isAdmin) return ctx.reply("⛔️ Faqat boshliq/direktor uchun.");
    if (/ochir|o'chir|olib/i.test(String(ctx.message.text || ''))) {
      await db.setSetting(HELP_VIDEO_KEY, '');
      return ctx.reply("🗑 /yordam videosi olib tashlandi.", ui.kbFor(ctx));
    }
    session.set(ctx.from.id, { step: 'help_video' });
    return ctx.reply(
      `🎬 <b>/yordam uchun video qo'llanma</b>\n\nVideoni shu yerga yuboring (oddiy video yoki fayl). Hodimlar /yordam bosganda avval shu video chiqadi.${(await helpVideo()) ? '\n<i>Hozir video bor — yangisi uning o\'rniga qo\'yiladi. Olib tashlash: /yordam_video ochir</i>' : ''}`,
      { parse_mode: 'HTML', ...ui.cancelKeyboard() },
    );
  });
  bot.on(['video', 'video_note', 'animation', 'document'], async (ctx, next) => {
    if (ctx.chat.type !== 'private' || session.get(ctx.from.id).step !== 'help_video') return next();
    if (!ctx.state.isAdmin) { session.clear(ctx.from.id); return next(); }
    const m = ctx.message;
    const media = m.video ? { type: 'video', fileId: m.video.file_id }
      : m.video_note ? { type: 'video_note', fileId: m.video_note.file_id }
        : m.animation ? { type: 'video', fileId: m.animation.file_id }
          : { type: 'document', fileId: m.document.file_id };
    session.clear(ctx.from.id);
    await db.setSetting(HELP_VIDEO_KEY, JSON.stringify(media));
    return ctx.reply("✅ Video saqlandi. Endi /yordam bosilganda avval shu video chiqadi.", ui.kbFor(ctx));
  });
};

const HELP_VIDEO_KEY = 'help_video';
/** /yordam video qo'llanmasi {type, fileId} yoki null */
const helpVideo = async () => {
  try {
    const raw = await db.getSetting(HELP_VIDEO_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && v.fileId ? v : null;
  } catch { return null; }
};

module.exports = { register, attachEmployee, trackUsage, notRegistered, helpText, helpVideo };
