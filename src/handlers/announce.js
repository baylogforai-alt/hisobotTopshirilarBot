'use strict';

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');
const notify = require('../services/notify');
const announcements = require('../services/announcements');
const activity = require('../services/activity');
const org = require('../services/org');

const { esc, cb, inline } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * «📢 E'LON» — bitta xabarni birdaniga ko'p odamga yuborish.
 *   Kim: direktor va HR — hamma hodimga; bo'lim rahbari — o'z jamoasiga.
 *   1) «👥 Hammaga», «🏢 Bo'limlarga» (direktor/HR — bir yoki bir nechta bo'lim, «Bo'limsizlar» ham) yoki «👤 Hodim tanlash» (1, 2 … hodimni belgilab)
 *   2) matn YOKI rasm / video / ovozli xabar / audio / fayl (izohi — e'lon matni)
 *   3) ko'rib chiqish → «📤 Yuborish» (direktor: guruhga ham yuborish mumkin)
 *   Oluvchida «👁 O'qidim» tugmasi; yuboruvchi «📊 Kim o'qidi» da o'qigan / o'qimaganlarni ko'radi, o'qimaganlarga qayta yuboradi.
 *
 * Callback: an:start · an:all · an:pick · an:p:<sahifa> · an:t:<empId>:<sahifa> · an:sa:<sahifa> · an:none:<sahifa> · an:go ·
 *           an:dl · an:dt:<deptId|0> · an:dok (bo'limlarga) ·
 *           an:grp · an:send · an:edit · an:cancel · an:r:<id> (o'qidim) · an:v:<id> · an:rs:<id> · an:list
 * Sessiya: announce_pick → announce_text → announce_confirm
 */

const PAGE = 8;

const canAnnounce = (ctx) => ctx.state.isAdmin || ctx.state.isHr || ctx.state.isHead;
const seesAll = (ctx) => ctx.state.isAdmin || ctx.state.isHr;

/** Yuboruvchi kimlarga e'lon bera oladi (o'zidan tashqari) */
const audienceOf = async (ctx) => {
  const me = ctx.state.employee;
  const list = seesAll(ctx) ? await employees.listActive() : await employees.teamOf(me);
  return list.filter((e) => Number(e.tg_id) !== Number(ctx.from.id));
};

const deny = (ctx) =>
  ctx.callbackQuery ? ctx.answerCbQuery("⛔️ E'lon faqat direktor, HR va bo'lim rahbari uchun", { show_alert: true }) : ctx.reply("⛔️ E'lon faqat direktor, HR va bo'lim rahbari uchun.");

const start = async (ctx) => {
  if (!canAnnounce(ctx)) return deny(ctx);
  const audience = await audienceOf(ctx);
  session.set(ctx.from.id, { step: 'announce_pick', ann: { ids: [], target: null, toGroup: false } });
  if (!audience.length) {
    session.clear(ctx.from.id);
    return render(ctx, seesAll(ctx) ? "Hozircha boshqa faol hodim yo'q." : "Bo'limingizda boshqa hodim yo'q — e'lon beradigan odam yo'q.");
  }
  return render(
    ctx,
    `📢 <b>E'LON</b>\n\nKimga yuboramiz?\n\n` +
      `👥 <b>${seesAll(ctx) ? 'Hammaga' : 'Jamoamga'}</b> — ${audience.length} kishi birdaniga oladi.\n` +
      (seesAll(ctx) ? `🏢 <b>Bo'limlarga</b> — bir yoki bir nechta bo'lim hodimlariga.\n` : '') +
      `👤 <b>Hodim tanlash</b> — 1, 2 yoki bir nechta odamni belgilab yuborasiz.\n\n` +
      `<i>E'lon — matn, 🖼 rasm, 🎥 video, 🎤 ovozli xabar yoki 📄 fayl bo'lishi mumkin. Har kimda «👁 O'qidim» tugmasi bo'ladi — kim o'qiganini ko'rasiz.</i>`,
    inline([
      [cb(`👥 ${seesAll(ctx) ? 'Hammaga' : 'Jamoamga'} (${audience.length})`, 'an:all'), cb('👤 Hodim tanlash', 'an:pick')],
      ...(seesAll(ctx) ? [[cb("🏢 Bo'limlarga", 'an:dl')]] : []),
      [cb("📜 Oldingi e'lonlar", 'an:list'), cb(ui.BTN.cancel, 'an:cancel')],
    ]),
  );
};

/** Hodim tanlash ro'yxati (sahifalab, ✅ / ☐) */
const pickList = async (ctx, page = 0) => {
  const s = session.get(ctx.from.id);
  if (!s.ann) return start(ctx);
  const audience = await audienceOf(ctx);
  const chosen = new Set((s.ann.ids || []).map(Number));
  const pages = Math.max(1, Math.ceil(audience.length / PAGE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const slice = audience.slice(p * PAGE, p * PAGE + PAGE);
  const rows = slice.map((e) => [
    cb(`${chosen.has(Number(e.id)) ? '✅' : '☐'} ${e.full_name}${e.department_name ? ` · ${e.department_name}` : e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `an:t:${e.id}:${p}`),
  ]);
  if (pages > 1) {
    rows.push([
      ...(p > 0 ? [cb('⬅️', `an:p:${p - 1}`)] : []),
      cb(`${p + 1}/${pages}`, `an:p:${p}`),
      ...(p < pages - 1 ? [cb('➡️', `an:p:${p + 1}`)] : []),
    ]);
  }
  rows.push([cb('☑️ Hammasini belgilash', `an:sa:${p}`), cb('🔲 Tozalash', `an:none:${p}`)]);
  rows.push([cb(`✅ Tayyor — davom etish (${chosen.size})`, 'an:go')]);
  rows.push([cb('⬅️ Orqaga', 'an:start'), cb(ui.BTN.cancel, 'an:cancel')]);
  const names = audience.filter((e) => chosen.has(Number(e.id))).map((e) => esc(e.full_name));
  return render(
    ctx,
    `👤 <b>Kimlarga yuboramiz?</b>\nIsmni bosing — belgilanadi (✅). Yana bossangiz — olib tashlanadi.\n\n` +
      `Tanlangan: <b>${chosen.size}</b>${names.length ? ` — ${names.join(', ')}` : ''}`,
    inline(rows),
  );
};

/** «🏢 Bo'limlarga» — bo'limlar ro'yxati (✅ / ☐), har birida rahbari va hodimlar soni; «👤 Bo'limsizlar» (id 0) */
const deptList = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.ann) return start(ctx);
  const audience = await audienceOf(ctx);
  const chosen = new Set((s.ann.depts || []).map(Number));
  const rows = [];
  const lines = [];
  for (const d of await departments.listActive()) {
    const members = audience.filter((e) => Number(e.department_id) === Number(d.id));
    const heads = members.filter((e) => e.role === 'head').map((e) => e.full_name);
    rows.push([cb(`${chosen.has(Number(d.id)) ? '✅' : '☐'} ${d.name} (${members.length})`.slice(0, 60), `an:dt:${d.id}`)]);
    lines.push(`• <b>${esc(d.name)}</b> — ${members.length} kishi${heads.length ? ` · rahbar: ${esc(heads.join(', '))}` : ''}`);
  }
  const loose = audience.filter((e) => !e.department_id);
  if (loose.length) {
    rows.push([cb(`${chosen.has(0) ? '✅' : '☐'} 👤 Bo'limsizlar (${loose.length})`, 'an:dt:0')]);
    lines.push(`• <b>Bo'limsizlar</b> — ${loose.length} kishi <i>(bo'limga biriktirilmagan: ${esc(loose.map((e) => e.full_name).join(', '))})</i>`);
  }
  const n = audience.filter((e) => chosen.has(Number(e.department_id || 0))).length;
  rows.push([cb(`✅ Tayyor — davom etish (${n} kishi)`, 'an:dok')]);
  rows.push([cb('⬅️ Orqaga', 'an:start'), cb(ui.BTN.cancel, 'an:cancel')]);
  return render(
    ctx,
    `🏢 <b>Qaysi bo'limlarga?</b>\nBo'limni bosing — belgilanadi (✅).\n\n${lines.join('\n') || "<i>bo'lim yo'q</i>"}\n\n` +
      `<i>Bo'lim = hodim kartochkasidagi bo'lim. Rahbar bo'limga biriktirilmagan bo'lsa — o'z bo'limi e'loniga kirmaydi.</i>`,
    inline(rows),
  );
};

const askContent = async (ctx) => {
  const s = session.get(ctx.from.id);
  session.set(ctx.from.id, { step: 'announce_text', ann: s.ann });
  const who = s.ann.target === 'all' ? `<b>${seesAll(ctx) ? 'hamma hodimga' : 'jamoangizga'}</b>` : `<b>${s.ann.ids.length} kishiga</b>`;
  await render(ctx, `📢 E'lon ${who} yuboriladi.`);
  return ctx.reply(
    `✍️ <b>E'lon matnini yozing</b>\n— yoki 🖼 rasm, 🎥 video, 🎤 ovozli xabar, 📄 fayl yuboring (ostiga izoh yozsangiz — e'lon matni bo'ladi).\n\n<i>Yuborishdan oldin ko'rib chiqasiz.</i>`,
    { parse_mode: 'HTML', ...ui.cancelKeyboard() },
  );
};

/** Media → {type, fileId, fileName} */
const mediaOf = (m) => {
  if (m.photo && m.photo.length) return { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  if (m.video) return { type: 'video', fileId: m.video.file_id };
  if (m.video_note) return { type: 'video_note', fileId: m.video_note.file_id };
  if (m.voice) return { type: 'voice', fileId: m.voice.file_id };
  if (m.audio) return { type: 'audio', fileId: m.audio.file_id, fileName: m.audio.file_name || m.audio.title || null };
  if (m.document) return { type: 'document', fileId: m.document.file_id, fileName: m.document.file_name || null };
  return null;
};

const targetsOf = async (ctx, ann) => {
  const audience = await audienceOf(ctx);
  if (ann.target === 'all') return audience;
  const chosen = new Set((ann.ids || []).map(Number));
  return audience.filter((e) => chosen.has(Number(e.id)));
};

/** Ko'rib chiqish oynasi */
const showConfirm = async (ctx) => {
  const s = session.get(ctx.from.id);
  const ann = s.ann;
  if (!ann || (!ann.text && !ann.media)) return start(ctx);
  const targets = await targetsOf(ctx, ann);
  const groupOk = ctx.state.isAdmin && Boolean(await notify.getGroupId());
  const whoLine = ann.target === 'all'
    ? `👥 ${seesAll(ctx) ? 'Hamma hodim' : 'Jamoangiz'}: <b>${targets.length} kishi</b>`
    : `${ann.target === 'depts' ? `🏢 ${esc(ann.deptLabel || "Bo'limlar")} — ` : '👤 '}${targets.length} kishi: ${targets.map((e) => esc(e.full_name)).join(', ')}`;
  const preview = announcements.bodyOf({ sender_name: org.actorName(ctx), created_at: time.stamp(), text: ann.text });
  const mediaLine = ann.media ? `\n📎 Ilova: ${ui.MEDIA_LABEL[ann.media.type] || '📎 fayl'}${ann.media.fileName ? ` (${esc(ann.media.fileName)})` : ''}` : '';
  const rows = [[cb(`📤 Yuborish (${targets.length})`, 'an:send')]];
  if (groupOk) rows.push([cb(ann.toGroup ? '💬 Guruhga ham: ✅ ha' : "💬 Guruhga ham: yo'q", 'an:grp')]);
  rows.push([cb('✏️ Qayta yozish', 'an:edit'), cb('👥 Kimga — o\'zgartirish', 'an:start')], [cb(ui.BTN.cancel, 'an:cancel')]);
  return render(ctx, `👀 <b>Ko'rib chiqing</b>\n${whoLine}${mediaLine}\n${ui.LINE}\n${preview}\n${ui.LINE}\nHammasi to'g'rimi?`, inline(rows));
};

/** announce_text — matn keldi */
const handleText = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.ann || !canAnnounce(ctx)) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  const text = ctx.message.text.trim().slice(0, 3500);
  if (!text) return ctx.reply("Matn bo'sh. Qaytadan yozing:", ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'announce_confirm', ann: { ...s.ann, text, media: null } });
  await ctx.reply('👌', ui.kbFor(ctx));
  return showConfirm(ctx);
};

/** announce_text — media keldi; boshqa bosqichda keyingi handlerga */
const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const s = session.get(ctx.from.id);
  if (s.step !== 'announce_text' || !canAnnounce(ctx)) return next();
  const media = mediaOf(ctx.message);
  if (!media) return ctx.reply('Matn, rasm, video, ovozli xabar yoki fayl yuboring.', ui.cancelKeyboard());
  const text = (ctx.message.caption || '').trim().slice(0, 900) || null;
  session.set(ctx.from.id, { step: 'announce_confirm', ann: { ...s.ann, text, media } });
  await ctx.reply('👌', ui.kbFor(ctx));
  return showConfirm(ctx);
};

const doSend = async (ctx) => {
  const s = session.get(ctx.from.id);
  const ann = s.ann;
  if (s.step !== 'announce_confirm' || !ann || (!ann.text && !ann.media)) return ctx.answerCbQuery('Sessiya eskirgan', { show_alert: true });
  const targets = await targetsOf(ctx, ann);
  if (!targets.length) return ctx.answerCbQuery("Oluvchi yo'q", { show_alert: true });
  session.clear(ctx.from.id);
  await ctx.answerCbQuery('Yuborilmoqda…');
  await render(ctx, `⏳ ${targets.length} kishiga yuborilmoqda…`);
  const sender = { tgId: ctx.from.id, name: org.actorName(ctx), employee: ctx.state.employee };
  const res = await announcements.send(botOf(ctx), sender, targets, { text: ann.text, media: ann.media }, {
    target: ann.target === 'all' ? 'all' : ann.target === 'depts' ? 'depts' : 'some', toGroup: Boolean(ann.toGroup && ctx.state.isAdmin),
  });
  ctx.state.logged = true;
  if (!ctx.state.employee) activity.track(null, 'announce', { tgId: ctx.from.id, title: ann.text || 'media', detail: `${targets.length} kishiga` });
  return ctx.reply(
    `✅ <b>E'lon yuborildi:</b> ${res.delivered} / ${targets.length}` +
      (res.failed.length ? `\n⚠️ Yetkazilmadi (${res.failed.length}): ${res.failed.map((e) => esc(e.full_name)).join(', ')} — botni hali ochmagan yoki bloklagan.` : '') +
      (res.ann.to_group ? '\n💬 Guruhga ham yuborildi.' : '') +
      `\n\nKim o'qiganini «📊 Kim o'qidi» da ko'rasiz.`,
    { parse_mode: 'HTML', ...inline([[cb("📊 Kim o'qidi", `an:v:${res.ann.id}`)]]) },
  );
};

/** Yuboruvchi (yoki direktor/HR) e'lon statistikasini ko'ra oladimi */
const canView = (ctx, ann) => ann && (Number(ann.created_by) === Number(ctx.from.id) || seesAll(ctx));

const viewStats = async (ctx, id) => {
  const ann = await announcements.byId(id);
  if (!canView(ctx, ann)) return ctx.answerCbQuery('Topilmadi');
  const st = await announcements.stats(id);
  const read = st.rows.filter((r) => r.read_at);
  const unread = st.rows.filter((r) => !r.read_at);
  const what = ann.text ? esc(ann.text.length > 160 ? `${ann.text.slice(0, 160)}…` : ann.text) : ui.MEDIA_LABEL[ann.media_type] || '📎';
  const text =
    `📊 <b>E'lon #${ann.id}</b> · ${time.prettyDate(String(ann.created_at).slice(0, 10))} ${time.clock(ann.created_at)}\n` +
    `<i>${esc(ann.sender_name || '')}</i>${ann.media_type ? ` · ${ui.MEDIA_ICON[ann.media_type] || '📎'}` : ''}\n«${what}»\n${ui.LINE}\n` +
    `👁 O'qidi: <b>${st.read} / ${st.total}</b> · 📬 yetkazildi: ${st.delivered}\n` +
    (read.length ? `\n✅ <b>O'qiganlar:</b>\n${read.map((r) => `   ✅ ${esc(r.full_name)} — ${time.clock(r.read_at)}${String(r.read_at).slice(0, 10) !== String(ann.created_at).slice(0, 10) ? ` (${time.prettyDate(String(r.read_at).slice(0, 10))})` : ''}`).join('\n')}\n` : '') +
    (unread.length ? `\n⏳ <b>Hali o'qimagan:</b>\n${unread.map((r) => `   ${Number(r.delivered) ? '⏳' : '⚠️'} ${esc(r.full_name)}${Number(r.delivered) ? '' : ' <i>(yetkazilmagan)</i>'}`).join('\n')}` : "\n🎉 Hamma o'qidi.");
  const rows = [[cb('🔄 Yangilash', `an:v:${ann.id}`)]];
  if (unread.length) rows.push([cb(`🔔 O'qimaganlarga qayta yuborish (${unread.length})`, `an:rs:${ann.id}`)]);
  rows.push([cb("📜 E'lonlar", 'an:list')]);
  if (ctx.callbackQuery) await ctx.answerCbQuery();
  return render(ctx, text, inline(rows));
};

const showList = async (ctx) => {
  if (!canAnnounce(ctx)) return deny(ctx);
  const list = await announcements.list(10, seesAll(ctx) ? null : ctx.from.id);
  if (!list.length) return render(ctx, "📜 Hali e'lon yuborilmagan.", inline([[cb("📢 Yangi e'lon", 'an:start')]]));
  const rows = [];
  for (const a of list) {
    const st = await announcements.stats(a.id);
    const label = (a.text || ui.MEDIA_LABEL[a.media_type] || '📎').replace(/\s+/g, ' ');
    rows.push([cb(`${time.shortDate(String(a.created_at).slice(0, 10))} · 👁 ${st.read}/${st.total} · ${label}`.slice(0, 60), `an:v:${a.id}`)]);
  }
  rows.push([cb("📢 Yangi e'lon", 'an:start')]);
  return render(ctx, `📜 <b>Oxirgi e'lonlar</b> (${list.length})\n<i>👁 o'qiganlar / jami</i>`, inline(rows));
};

/** Oluvchi «👁 O'qidim» bosdi */
const onRead = async (ctx, id) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.answerCbQuery('⛔️');
  const ann = await announcements.byId(id);
  if (!ann) return ctx.answerCbQuery('Topilmadi');
  const marked = await announcements.markRead(id, emp.id);
  await ctx.answerCbQuery(marked ? '✅ Rahmat! O\'qilgan deb belgilandi' : 'Allaqachon belgilangan');
  if (marked) activity.mark(ctx, 'announce_read', { title: ann.text || ui.MEDIA_LABEL[ann.media_type] || "E'lon", detail: ann.sender_name });
  // tugma o'rniga belgi
  await ctx.editMessageReplyMarkup(inline([[cb(`✅ O'qildi · ${time.clock(time.stamp())}`, `an:ok:${id}`)]]).reply_markup).catch(() => {});
};

const register = (bot) => {
  bot.hears(ui.BTN.announce, start);
  bot.command(['elon', 'eloon', 'announce'], (ctx) => (ctx.chat.type === 'private' ? start(ctx) : null));
  bot.action('an:start', async (ctx) => { if (!canAnnounce(ctx)) return deny(ctx); await ctx.answerCbQuery(); return start(ctx); });
  bot.action('an:cancel', async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); return render(ctx, "❌ E'lon bekor qilindi."); });
  bot.action('an:all', async (ctx) => {
    if (!canAnnounce(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    session.set(ctx.from.id, { ann: { ...(s.ann || {}), target: 'all', ids: [] } });
    await ctx.answerCbQuery();
    return askContent(ctx);
  });
  bot.action('an:pick', async (ctx) => {
    if (!canAnnounce(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    session.set(ctx.from.id, { step: 'announce_pick', ann: { ...(s.ann || { ids: [] }), target: 'some', ids: s.ann && s.ann.target === 'depts' ? [] : (s.ann && s.ann.ids) || [] } });
    await ctx.answerCbQuery();
    return pickList(ctx, 0);
  });
  bot.action('an:dl', async (ctx) => {
    if (!canAnnounce(ctx) || !seesAll(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    session.set(ctx.from.id, { step: 'announce_pick', ann: { ...(s.ann || { ids: [] }), depts: (s.ann && s.ann.depts) || [] } });
    await ctx.answerCbQuery();
    return deptList(ctx);
  });
  bot.action(/^an:dt:(\d+)$/, async (ctx) => {
    if (!canAnnounce(ctx) || !seesAll(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    if (!s.ann) { await ctx.answerCbQuery('Sessiya eskirgan'); return start(ctx); }
    const id = Number(ctx.match[1]);
    const depts = new Set((s.ann.depts || []).map(Number));
    if (depts.has(id)) depts.delete(id); else depts.add(id);
    session.set(ctx.from.id, { ann: { ...s.ann, depts: [...depts] } });
    await ctx.answerCbQuery();
    return deptList(ctx);
  });
  bot.action('an:dok', async (ctx) => {
    if (!canAnnounce(ctx) || !seesAll(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    if (!s.ann) { await ctx.answerCbQuery('Sessiya eskirgan'); return start(ctx); }
    const depts = new Set((s.ann.depts || []).map(Number));
    const ids = (await audienceOf(ctx)).filter((e) => depts.has(Number(e.department_id || 0))).map((e) => Number(e.id));
    if (!ids.length) return ctx.answerCbQuery("Kamida bitta bo'limni belgilang (unda hodim bo'lsin)", { show_alert: true });
    const names = (await departments.listActive()).filter((d) => depts.has(Number(d.id))).map((d) => d.name);
    if (depts.has(0)) names.push("Bo'limsizlar");
    session.set(ctx.from.id, { ann: { ...s.ann, target: 'depts', ids, deptLabel: names.join(', ') } });
    await ctx.answerCbQuery();
    return askContent(ctx);
  });
  bot.action(/^an:p:(\d+)$/, async (ctx) => { if (!canAnnounce(ctx)) return deny(ctx); await ctx.answerCbQuery(); return pickList(ctx, ctx.match[1]); });
  bot.action(/^an:t:(\d+):(\d+)$/, async (ctx) => {
    if (!canAnnounce(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    if (!s.ann) { await ctx.answerCbQuery('Sessiya eskirgan'); return start(ctx); }
    const id = Number(ctx.match[1]);
    if (!(await audienceOf(ctx)).some((e) => Number(e.id) === id)) return ctx.answerCbQuery('⛔️');
    const ids = new Set((s.ann.ids || []).map(Number));
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    session.set(ctx.from.id, { ann: { ...s.ann, target: 'some', ids: [...ids] } });
    await ctx.answerCbQuery();
    return pickList(ctx, ctx.match[2]);
  });
  bot.action(/^an:sa:(\d+)$/, async (ctx) => {
    if (!canAnnounce(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    session.set(ctx.from.id, { ann: { ...(s.ann || {}), target: 'some', ids: (await audienceOf(ctx)).map((e) => Number(e.id)) } });
    await ctx.answerCbQuery('Hammasi belgilandi');
    return pickList(ctx, ctx.match[1]);
  });
  bot.action(/^an:none:(\d+)$/, async (ctx) => {
    if (!canAnnounce(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    session.set(ctx.from.id, { ann: { ...(s.ann || {}), target: 'some', ids: [] } });
    await ctx.answerCbQuery('Tozalandi');
    return pickList(ctx, ctx.match[1]);
  });
  bot.action('an:go', async (ctx) => {
    if (!canAnnounce(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    if (!s.ann || !(s.ann.ids || []).length) return ctx.answerCbQuery('Kamida bitta hodimni belgilang', { show_alert: true });
    await ctx.answerCbQuery();
    return askContent(ctx);
  });
  bot.action('an:edit', async (ctx) => {
    if (!canAnnounce(ctx)) return deny(ctx);
    const s = session.get(ctx.from.id);
    if (!s.ann) { await ctx.answerCbQuery('Sessiya eskirgan'); return start(ctx); }
    await ctx.answerCbQuery();
    return askContent(ctx);
  });
  bot.action('an:grp', async (ctx) => {
    if (!ctx.state.isAdmin) return ctx.answerCbQuery('⛔️');
    const s = session.get(ctx.from.id);
    if (s.step !== 'announce_confirm' || !s.ann) return ctx.answerCbQuery('Sessiya eskirgan');
    session.set(ctx.from.id, { ann: { ...s.ann, toGroup: !s.ann.toGroup } });
    await ctx.answerCbQuery();
    return showConfirm(ctx);
  });
  bot.action('an:send', async (ctx) => { if (!canAnnounce(ctx)) return deny(ctx); return doSend(ctx); });
  bot.action(/^an:r:(\d+)$/, (ctx) => onRead(ctx, ctx.match[1]));
  bot.action(/^an:ok:(\d+)$/, (ctx) => ctx.answerCbQuery('✅ Allaqachon o\'qilgan'));
  bot.action(/^an:v:(\d+)$/, (ctx) => viewStats(ctx, ctx.match[1]));
  bot.action(/^an:rs:(\d+)$/, async (ctx) => {
    const ann = await announcements.byId(ctx.match[1]);
    if (!canView(ctx, ann)) return ctx.answerCbQuery('Topilmadi');
    await ctx.answerCbQuery('Yuborilmoqda…');
    const n = await announcements.resendUnread(botOf(ctx), ann.id);
    await ctx.reply(`🔔 Qayta yuborildi: ${n} kishiga.`);
    return viewStats(ctx, ann.id);
  });
  bot.action('an:list', async (ctx) => { if (!canAnnounce(ctx)) return deny(ctx); await ctx.answerCbQuery(); return showList(ctx); });
  bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], onMedia);
};

module.exports = { register, handleText, start, PAGE };
