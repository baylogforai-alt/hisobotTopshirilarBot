'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const directions = require('../services/directions');
const attendance = require('../services/attendance');
const kpi = require('../services/kpi');
const notify = require('../services/notify');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * YO'NALISHLAR, DAVOMAT NAZORATI, RUXSATLAR.
 *   as:dirs → as:dir:<id> | as:dir:self (Shaxsiy) → as:who:<empId> (lichka + «📤 Topshiriq / savol» → as:emp)  — HR va direktor
 *   dn:*    — Panel → «🧭 Yo'nalishlar» (direktor): ro'yxat, yangi, nomi, o'chirish
 *   ed:<empId>, ed:t:<empId>:<dirId> — hodimning yo'nalishlari (HR / direktor)
 *   vw:*    — «👁 Davomat nazorati»: hamma hodimning kelgan-ketgani, davomat % va KPI % (TOPSHIRIQLARSIZ).
 *             Ko'ruvchi (can_view_att) — HR yoki direktor beradi: vw:grant:<empId>
 */

const seeAll = (ctx) => ctx.state.isAdmin || ctx.state.isHr;
const denySeeAll = async (ctx) => {
  if (seeAll(ctx)) return false;
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('⛔️ Faqat direktor va HR');
  else await ctx.reply('⛔️ Faqat direktor va HR uchun.');
  return true;
};

// ---------------------------------------------------------------------------
// YO'NALISH BO'YICHA TOPSHIRIQ / SAVOL
// ---------------------------------------------------------------------------

const dirsMenu = async (ctx) => {
  const list = await directions.listActive();
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((r) => cb(directions.label(r), `as:dir:${r.id}`)));
  rows.push([cb('👤 Shaxsiy (istalgan hodim)', 'as:dir:self')]);
  rows.push([cb('👥 Rahbarlar orqali', 'as:mgrs'), cb(ui.BTN.cancel, 'as:cancel')]);
  return render(ctx, `📤 <b>Qaysi yo'nalish bo'yicha?</b>\n<i>Masalan: moliya bo'yicha savol, ta'minot bo'yicha topshiriq. Shaxsiy masala bo'lsa — «Shaxsiy».</i>`, inline(rows));
};

const dirMembers = async (ctx, dirId) => {
  const self = dirId === 'self';
  const r = self ? null : await directions.byId(dirId);
  let list = self ? await employees.listActive() : await directions.membersOf(dirId);
  const me = ctx.state.employee;
  if (me) list = list.filter((e) => Number(e.id) !== Number(me.id));
  if (!list.length) {
    return render(ctx, `${self ? '👤 Shaxsiy' : esc(directions.label(r))} — mas'ul hodim belgilanmagan.\n<i>Hodimga yo'nalish: 👥 Hodimlarim → hodim → «🧭 Yo'nalishlari».</i>`, ui.backKeyboard('as:dirs'));
  }
  const rows = list.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}${e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `as:who:${e.id}`)]);
  rows.push([cb('⬅️ Yo\'nalishlar', 'as:dirs')]);
  return render(ctx, `📤 <b>${self ? '👤 Shaxsiy' : esc(directions.label(r))}</b> — kimga?`, inline(rows));
};

/** Tanlangan hodim: lichkasi + topshiriq/savol berish */
const whoCard = async (ctx, empId) => {
  const e = await employees.byId(empId);
  if (!e || !e.active) return dirsMenu(ctx);
  const dirs = await directions.ofEmployee(e.id);
  const rows = [[cb('📤 Topshiriq / savol berish', `as:emp:${e.id}`)]];
  if (e.username) rows.push([ui.urlButton('💬 Lichkaga yozish', `https://t.me/${e.username}`)]);
  rows.push([cb('⬅️ Yo\'nalishlar', 'as:dirs')]);
  return render(
    ctx,
    `${employees.personIcon(e)} <b>${esc(e.full_name)}</b>${e.position ? ` · ${esc(e.position)}` : ''}\n` +
      `${dirs.length ? `🧭 ${dirs.map((r) => esc(directions.label(r))).join(', ')}\n` : ''}` +
      `💬 Lichka: ${employees.contactHtml(e)}\n\n<i>Ismni bossangiz — Telegram lichkasi ochiladi. Yoki bot orqali topshiriq/savol bering.</i>`,
    inline(rows),
  );
};

// ---------------------------------------------------------------------------
// HODIMNING YO'NALISHLARI (HR / direktor)
// ---------------------------------------------------------------------------

const empDirs = async (ctx, empId) => {
  const e = await employees.byId(empId);
  if (!e) return null;
  const mine = new Set((await directions.ofEmployee(e.id)).map((r) => Number(r.id)));
  const rows = (await directions.listActive()).map((r) => [cb(`${mine.has(Number(r.id)) ? '✅' : '▫️'} ${directions.label(r)}`, `ed:t:${e.id}:${r.id}`)]);
  rows.push([cb('⬅️ Orqaga', ctx.state.isAdmin ? `emp:${e.id}` : `tm:e:${e.id}`)]);
  return render(ctx, `🧭 <b>${esc(e.full_name)}</b> — qaysi yo'nalishlarga mas'ul?\n<i>Belgilanganlar bo'yicha HR / direktor unga topshiriq va savol yo'naltiradi.</i>`, inline(rows));
};

// ---------------------------------------------------------------------------
// DAVOMAT NAZORATI (ruxsat berilgan hodim) — topshiriqlarsiz
// ---------------------------------------------------------------------------

const canView = (ctx) => seeAll(ctx) || employees.isViewer(ctx.state.employee);
const DAY_ICON = { ontime: '🟢', late: '🟡', absent: '🔴', excused: '📄', pending: '🙋', future: '⚪', off: '⚪' };

const viewToday = async (ctx) => {
  const lines = [];
  const cnt = { ontime: 0, late: 0, absent: 0 };
  for (const e of await employees.listStaff()) {
    const row = await attendance.get(e.id);
    const st = attendance.dayStatus(row, time.today(), time.today(), e);
    if (cnt[st] !== undefined) cnt[st] += 1;
    const inOut = row && row.checked_in ? ` · keldi ${time.clock(row.checked_in)}${row.checked_out ? ` · ketdi ${time.clock(row.checked_out)}` : ''}` : '';
    const late = st === 'late' ? ` ⏰ ${time.prettyDuration(Number(row.late_minutes))}` : '';
    lines.push(`${DAY_ICON[st] || '⚪'} ${esc(e.full_name)}${inOut}${late}`);
  }
  return render(
    ctx,
    `👁 <b>DAVOMAT — ${time.prettyDate(time.today())}</b>\n🟢 vaqtida ${cnt.ontime} · 🟡 kech ${cnt.late} · 🔴 kelmagan ${cnt.absent}\n${ui.LINE}\n${lines.join('\n') || "<i>hodim yo'q</i>"}`,
    inline([
      [cb(`📊 ${time.monthName(time.month())}: davomat % va KPI %`, `vw:m:${time.month()}`)],
      ...(seeAll(ctx) ? [[cb('🎥 Keldim videolari', 'vw:vids')]] : []),
      [cb('🔄 Yangilash', 'vw:today')],
    ]),
  );
};

const viewMonth = async (ctx, month) => {
  const { from, to } = time.monthRange(month);
  const rows = [];
  for (const e of await employees.listStaff()) {
    const at = await attendance.stats(e, from, to);
    const k = await kpi.compute(e, month);
    rows.push({ e, at, k });
  }
  rows.sort((a, b) => b.at.pct - a.at.pct);
  const lines = rows.map(({ e, at, k }, i) =>
    `${i + 1}. <b>${esc(e.full_name)}</b>\n   🕘 davomat <b>${at.pct}%</b> (${at.ontime}/${at.workDays} vaqtida${at.late ? `, 🟡 ${at.late}` : ''}${at.absent ? `, 🔴 ${at.absent}` : ''}) · 🏆 KPI <b>${k.total}%</b>`);
  const prev = time.shiftMonth(month, -1);
  const nav = [cb(`◀️ ${time.monthName(prev)}`, `vw:m:${prev}`)];
  if (month < time.month()) nav.push(cb(`${time.monthName(time.shiftMonth(month, 1))} ▶️`, `vw:m:${time.shiftMonth(month, 1)}`));
  return render(ctx, `📊 <b>${time.monthName(month)}</b> — davomat % va KPI %\n${ui.LINE}\n${lines.join('\n') || "<i>hodim yo'q</i>"}`, inline([nav, [cb('👁 Bugun', 'vw:today')]]));
};

/** Bugungi Keldim videolari — faqat direktor va HR */
const viewVideos = async (ctx, date = time.today()) => {
  const rows = [];
  const lines = [];
  for (const e of await employees.listStaff()) {
    const r = await attendance.get(e.id, date);
    if (!r || !r.checked_in) continue;
    const hasVideo = Boolean(r.checkin_proof_file_id);
    lines.push(`${hasVideo ? '🎥' : '▫️'} ${esc(e.full_name)} — ${time.clock(r.checked_in)}${r.checked_out ? ` · ketdi ${time.clock(r.checked_out)}` : ''}${hasVideo ? '' : ' <i>(videosiz)</i>'}`);
    if (hasVideo) rows.push([cb(`🎥 ${e.full_name} · ${time.clock(r.checked_in)}`.slice(0, 60), `vw:vid:${r.id}`)]);
  }
  rows.push([cb('👁 Davomat', 'vw:today')]);
  return render(ctx, `🎥 <b>KELDIM VIDEOLARI — ${time.prettyDate(date)}</b>\n${ui.LINE}\n${lines.join('\n') || "<i>Bugun hali hech kim kelmagan.</i>"}\n\n👇 Videoni ochish uchun bosing.`, inline(rows));
};

// ---------------------------------------------------------------------------
// PANEL → YO'NALISHLAR (direktor)
// ---------------------------------------------------------------------------

const dirList = async (ctx) => {
  const lines = [];
  for (const r of await directions.listActive()) {
    const m = await directions.membersOf(r.id);
    lines.push(`${esc(directions.label(r))} — ${m.length ? m.map((e) => esc(e.full_name)).join(', ') : "<i>mas'ul yo'q</i>"}`);
  }
  const rows = (await directions.listActive()).map((r) => [cb(directions.label(r), `dn:${r.id}`)]);
  rows.push([cb("➕ Yangi yo'nalish", 'dn:new'), cb('⬅️ Panel', 'adm:home')]);
  return render(ctx, `🧭 <b>YO'NALISHLAR</b>\n<i>Mas'ulni belgilash: hodim kartochkasi → «🧭 Yo'nalishlari».</i>\n${ui.LINE}\n${lines.join('\n')}`, inline(rows));
};

const dirCard = async (ctx, id) => {
  const r = await directions.byId(id);
  if (!r || !Number(r.active)) return dirList(ctx);
  const m = await directions.membersOf(r.id);
  return render(ctx, `${esc(directions.label(r))}\n${ui.LINE}\nMas'ullar: ${m.map((e) => esc(e.full_name)).join(', ') || "<i>yo'q</i>"}`, inline([
    [cb('✏️ Nomi', `dn:name:${r.id}`), cb("🗑 O'chirish", `dn:del:${r.id}`)], [cb("⬅️ Yo'nalishlar", 'dn:list')],
  ]));
};

const handleDirText = async (ctx, field) => {
  const s = session.get(ctx.from.id);
  session.clear(ctx.from.id);
  const text = ctx.message.text.trim();
  if (!text) return ctx.reply("Nom bo'sh bo'lmasin.", ui.kbFor(ctx));
  if (field === 'new') {
    const { direction } = await directions.create(text);
    await ctx.reply(`🧭 «${esc(direction.name)}» qo'shildi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
    return dirList(ctx);
  }
  if (s.dirId) await directions.rename(s.dirId, text);
  await ctx.reply('✅ Saqlandi.', ui.kbFor(ctx));
  return dirCard(ctx, s.dirId);
};

const register = (bot) => {
  // yo'nalish bo'yicha topshiriq
  bot.action('as:dirs', async (ctx) => { if (await denySeeAll(ctx)) return; await ctx.answerCbQuery(); return dirsMenu(ctx); });
  bot.action(/^as:dir:(\d+|self)$/, async (ctx) => { if (await denySeeAll(ctx)) return; await ctx.answerCbQuery(); return dirMembers(ctx, ctx.match[1]); });
  bot.action(/^as:who:(\d+)$/, async (ctx) => { if (await denySeeAll(ctx)) return; await ctx.answerCbQuery(); return whoCard(ctx, ctx.match[1]); });

  // hodimning yo'nalishlari
  bot.action(/^ed:(\d+)$/, async (ctx) => { if (await denySeeAll(ctx)) return; await ctx.answerCbQuery(); return empDirs(ctx, ctx.match[1]); });
  bot.action(/^ed:t:(\d+):(\d+)$/, async (ctx) => {
    if (await denySeeAll(ctx)) return;
    const on = await directions.toggle(ctx.match[1], ctx.match[2]);
    await ctx.answerCbQuery(on ? "Qo'shildi" : 'Olib tashlandi');
    return empDirs(ctx, ctx.match[1]);
  });

  // davomat nazorati
  bot.hears(ui.BTN.attView, async (ctx) => { if (!canView(ctx)) return ctx.reply('⛔️ Ruxsat yo\'q.'); return viewToday(ctx); });
  bot.command('davomat', async (ctx) => { if (!canView(ctx)) return ctx.reply('⛔️ Ruxsat yo\'q.'); return viewToday(ctx); });
  bot.action('vw:today', async (ctx) => { if (!canView(ctx)) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); return viewToday(ctx); });
  bot.action(/^vw:m:(\d{4}-\d{2})$/, async (ctx) => { if (!canView(ctx)) return ctx.answerCbQuery('⛔️'); await ctx.answerCbQuery(); return viewMonth(ctx, ctx.match[1]); });
  bot.action('vw:vids', async (ctx) => { if (await denySeeAll(ctx)) return; await ctx.answerCbQuery(); return viewVideos(ctx); });
  bot.action(/^vw:vid:(\d+)$/, async (ctx) => {
    if (await denySeeAll(ctx)) return;
    const r = await attendance.byId(ctx.match[1]);
    if (!r || !r.checkin_proof_file_id) return ctx.answerCbQuery('Video topilmadi');
    await ctx.answerCbQuery();
    const e = await employees.byId(r.employee_id);
    return notify.sendProof(
      botOf(ctx), ctx.chat.id, { type: r.checkin_proof_type, fileId: r.checkin_proof_file_id },
      `🎥 <b>${esc(e.full_name)}</b> — keldi ${time.prettyDate(r.work_date)} ${time.clock(r.checked_in)}` +
        `${Number(r.late_minutes) > 0 ? ` ⏰ ${time.prettyDuration(Number(r.late_minutes))} kech` : ''}` +
        `${r.checkin_dist ? ` · 📍 ${r.checkin_mode === 'field' ? 'uydan' : 'ofisdan'} ${r.checkin_dist} m` : ''}${r.checkin_note ? `\n💬 «${esc(r.checkin_note)}»` : ''}`,
    );
  });
  bot.action(/^vw:grant:(\d+)$/, async (ctx) => {
    if (await denySeeAll(ctx)) return;
    const e = await employees.byId(ctx.match[1]);
    const on = !employees.isViewer(e);
    await employees.setViewer(e.id, on);
    await ctx.answerCbQuery(on ? 'Ruxsat berildi' : 'Ruxsat olindi');
    const u = await employees.byId(e.id);
    await notify.toUser(
      botOf(ctx), u.tg_id,
      on ? `👁 Sizga <b>davomat nazorati</b> ruxsati berildi: hamma hodimning kelgan-ketgani, davomat % va KPI %. Tugma — «${ui.BTN.attView}».`
        : '👁 Davomat nazorati ruxsati olib qo\'yildi.',
      ui.kbForEmp(u),
    );
    return ctx.state.isAdmin ? require('./admin').employeeCard(ctx, e.id) : require('./team').memberView(ctx, e.id);
  });

  // panel → yo'nalishlar
  const guardAdmin = async (ctx) => { if (ctx.state.isAdmin) return true; await ctx.answerCbQuery('⛔️'); return false; };
  bot.action('dn:list', async (ctx) => { if (await guardAdmin(ctx)) { await ctx.answerCbQuery(); await dirList(ctx); } });
  bot.action(/^dn:(\d+)$/, async (ctx) => { if (await guardAdmin(ctx)) { await ctx.answerCbQuery(); await dirCard(ctx, ctx.match[1]); } });
  bot.action('dn:new', async (ctx) => {
    if (!(await guardAdmin(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'dir_new' });
    return ctx.reply("🧭 Yangi yo'nalish nomi (masalan: Marketing):", ui.cancelKeyboard());
  });
  bot.action(/^dn:name:(\d+)$/, async (ctx) => {
    if (!(await guardAdmin(ctx))) return;
    await ctx.answerCbQuery();
    session.set(ctx.from.id, { step: 'dir_name', dirId: Number(ctx.match[1]) });
    return ctx.reply("✏️ Yo'nalishning yangi nomi:", ui.cancelKeyboard());
  });
  bot.action(/^dn:del:(\d+)$/, async (ctx) => {
    if (!(await guardAdmin(ctx))) return;
    await directions.deactivate(ctx.match[1]);
    await ctx.answerCbQuery("O'chirildi");
    return dirList(ctx);
  });
};

module.exports = { register, dirsMenu, handleDirText, viewToday, seeAll };
