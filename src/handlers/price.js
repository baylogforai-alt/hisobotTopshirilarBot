'use strict';

const { DateTime } = require('luxon');

const ui = require('../ui');
const time = require('../time');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const pr = require('../services/priceRequests');
const notify = require('../services/notify');
const excel = require('../services/excel');
const worktime = require('../services/worktime');
const config = require('../config');
const activity = require('../services/activity');

const { esc, cb, inline, LINE } = ui;
const botOf = (ctx) => ({ telegram: ctx.telegram });

/**
 * 💲 NARX SO'ROVLARI (31-okt-2026): sotuvchi yuk tavsifi bilan deklarantdan narx so'raydi.
 * So'rov sehrgari: pq_pick → pq_desc → pq_media → pq_due → pq_confirm (sessiya: { step, pq: { declarantId, description, media, dueKey, parentId, id } }).
 * Deklarant: pq_price → pq_price_note, pq_question; so'rovchi: pq_answer.
 * Barcha holat o'tishlari priceRequests xizmatida (false = eskirgan tugma) — natija doim tekshiriladi.
 * Tarix / qidiruv (pq:h, pq:hs → pq_search) — deklarant, ruxsatli va rahbarga; statistika / barcha ochiq / Excel (pq:st, pq:all, pq:xl) — faqat rahbarga.
 * Eslatma (nag) — pastda.
 */

const PAGE = 10;
const MEDIA_STEPS = ['pq_desc', 'pq_media', 'pq_question', 'pq_answer'];

const isMgr = (ctx) => Boolean(ctx.state.isAdmin || ctx.state.isHr);
const isDecl = (ctx) => employees.isDeclarant(ctx.state.employee);
const canAsk = (ctx) => isMgr(ctx) || employees.canAskPrice(ctx.state.employee);
const same = (a, b) => Number(a) === Number(b);
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const stale = (ctx) => ctx.answerCbQuery('Eskirgan tugma');
const deny = (ctx) => ctx.answerCbQuery("⛔️ Ruxsat yo'q");

/** chat.js naqshi: rasm / hujjat / video / ovoz / audio → { type, fileId } */
const mediaOf = (m) => {
  if (m.photo && m.photo.length) return { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id };
  if (m.document) return { type: 'document', fileId: m.document.file_id };
  if (m.video) return { type: 'video', fileId: m.video.file_id };
  if (m.video_note) return { type: 'video_note', fileId: m.video_note.file_id };
  if (m.voice) return { type: 'voice', fileId: m.voice.file_id };
  if (m.audio) return { type: 'audio', fileId: m.audio.file_id };
  return null;
};
const reqMedia = (r) => (r.media_file_id ? { type: r.media_type, fileId: r.media_file_id } : null);

/** «bugun 17:00» / «ertaga 17:00» / «02.11 17:00» / «muddatsiz» */
const dueText = (iso) => {
  if (!iso) return 'muddatsiz';
  const d = String(iso).slice(0, 10);
  const t = time.today();
  const day = d === t ? 'bugun' : d === time.addDays(t, 1) ? 'ertaga' : time.shortDate(d);
  return `${day} ${time.clock(iso)}`;
};
/** Deklarant hozir ishlay oladimi (faol va bayroq yoqilgan) — so'rov qatoridan */
const declOk = (r) => Boolean(Number(r.declarant_active) && Number(r.declarant_flag));
const markOf = (r) => (r.status === 'asked' ? '💬' : isOverdue(r) ? '🔴' : '🟡');
const hourOf = (r) => (r.due_at ? time.clock(r.due_at) : '—');
const isOverdue = (r) => Boolean(r.due_at && r.due_at <= time.stamp());
const workEnded = () => { const n = time.now(); return n.hour * 60 + n.minute >= employees.endMinutesOf(null); };

// ---------------- kartochka (deklarant / so'rovchi / rahbar) ----------------

const cardText = (r, history = []) => {
  const lines = [`💲 <b>NARX SO'ROVI №${r.id}</b>`, `👤 ${esc(r.requester_name)}`, `⏰ Muddat: ${dueText(r.due_at)}`];
  if (history.length || r.status !== 'open') lines.push(`📑 Deklarant: ${esc(r.declarant_name)}`);
  if (r.status === 'asked') lines.push('💬 <i>javob kutilmoqda</i>');
  if (r.status === 'cancelled') lines.push('❌ <i>bekor qilingan</i>');
  if (r.status === 'priced') lines.push(`✅ Narx: <b>${esc(r.price)}</b>${r.price_note ? `\n📝 ${esc(r.price_note)}` : ''}`);
  lines.push(LINE, esc(r.description));
  for (const m of history) {
    lines.push(`${m.kind === 'question' ? '❓' : '💬'} <b>${esc(m.author_name)}:</b> ${m.text ? esc(m.text) : `<i>${ui.MEDIA_ICON[m.media_type] || '📎'} media</i>`}`);
  }
  return lines.join('\n');
};

/** Kartochka tugmalari — ko'ruvchi kimligi va holatiga qarab */
const cardRows = (r, ctx) => {
  const emp = ctx.state.employee;
  const open = r.status === 'open' || r.status === 'asked';
  const asDecl = emp && same(r.declarant_id, emp.id) && isDecl(ctx);
  const asReq = emp && same(r.requester_id, emp.id);
  const rows = [];
  if (open && asDecl) rows.push([cb('💲 Narx berish', `pq:p:${r.id}`), cb('❓ Savol bor', `pq:q:${r.id}`)], [cb("📥 Barcha so'rovlar", 'pq:in')]);
  if (r.status === 'asked' && asReq) rows.push([cb('💬 Javob berish', `pq:a:${r.id}`)]);
  if (open && (asReq || isMgr(ctx))) rows.push([cb('❌ Bekor qilish', `pq:x:${r.id}`)]);
  if ((r.status === 'priced' || r.status === 'cancelled') && asReq) rows.push([cb("🔄 Qayta so'rash", `pq:r:${r.id}`)]);
  return rows;
};

const declRows = (r) => [[cb('💲 Narx berish', `pq:p:${r.id}`), cb('❓ Savol bor', `pq:q:${r.id}`)], [cb("📥 Barcha so'rovlar", 'pq:in')]];

/** Kartochkani (media bo'lsa nusxasi bilan) tgId ga yuboradi; yetkazilmasa null */
const sendCard = (ctx, tgId, r, rows, history = []) => {
  const extra = rows.length ? inline(rows) : {};
  const m = reqMedia(r);
  return m ? notify.sendProof(botOf(ctx), tgId, m, cardText(r, history), extra) : notify.toUser(botOf(ctx), tgId, cardText(r, history), extra);
};

/** Matn (+ ixtiyoriy media) xabari: sarlavha, tavsif boshi, matn */
const sendNote = (ctx, tgId, head, r, body, media, rows) => {
  const text = `${head}\n${esc(short(r.description, 200))}\n${LINE}\n${body}`;
  const extra = inline(rows);
  return media ? notify.sendProof(botOf(ctx), tgId, media, text, extra) : notify.toUser(botOf(ctx), tgId, text, extra);
};

// ---------------- menyu va ro'yxatlar ----------------

const showList = async (ctx, rows, { title, page, base, who }) => {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const p = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const slice = rows.slice(p * PAGE, p * PAGE + PAGE);
  const lines = slice.map((r) => `${markOf(r)} №${r.id} · ${esc(r[who])} · ${esc(short(r.description, 60))} · ⏰ ${hourOf(r)}`);
  const kb = slice.map((r) => [cb(`${markOf(r)} №${r.id} · ${r[who]} · ${short(r.description, 30)} · ${hourOf(r)}`.slice(0, 60), `pq:v:${r.id}`)]);
  const nav = [];
  if (p > 0) nav.push(cb('◀️', `${base}:${p - 1}`));
  if (p < pages - 1) nav.push(cb('▶️', `${base}:${p + 1}`));
  if (nav.length) kb.push(nav);
  kb.push(canAsk(ctx) ? [cb('⬅️ Menyu', 'pq:menu')] : [cb('📜 Narxlar tarixi', 'pq:h')]); // faqat-deklarantda menyu yo'q — tarixga shu yerdan
  return render(ctx, `${title} (${rows.length})\n${LINE}\n${lines.join('\n') || "<i>Hozircha so'rov yo'q ✅</i>"}`, inline(kb));
};

const showInbox = async (ctx, page) => {
  const emp = ctx.state.employee;
  if (!isDecl(ctx)) return ctx.reply("⛔️ Siz deklarant emassiz.", ui.kbFor(ctx));
  return showList(ctx, await pr.inbox(emp.id), { title: '📥 <b>NARX KUTILMOQDA</b>', page, base: 'pq:in', who: 'requester_name' });
};

const showMine = async (ctx, page) => {
  const emp = ctx.state.employee;
  if (!emp) return ctx.reply("⛔️ Profilingiz topilmadi.", ui.kbFor(ctx));
  return showList(ctx, await pr.mine(emp.id), { title: "📤 <b>MENING SO'ROVLARIM</b>", page, base: 'pq:my', who: 'declarant_name' });
};

const menu = async (ctx) => {
  const emp = ctx.state.employee;
  const decl = isDecl(ctx);
  if (!decl && !canAsk(ctx)) return ctx.reply("⛔️ Narx bo'limi sizga ochiq emas.", ui.kbFor(ctx));
  if (decl && !canAsk(ctx)) return showInbox(ctx, 0);
  const rows = [];
  if (decl) rows.push([cb(`📥 Narx kutilmoqda (${await pr.countInbox(emp.id)})`, 'pq:in')]);
  rows.push([cb("➕ Yangi so'rov", 'pq:new')]);
  if (emp) rows.push([cb(`📤 Mening so'rovlarim (${await pr.countMine(emp.id)})`, 'pq:my')]);
  rows.push([cb('📜 Narxlar tarixi', 'pq:h')]);
  if (isMgr(ctx)) rows.push([cb('📊 Statistika', 'pq:st:7'), cb('📋 Barcha ochiq', 'pq:all')]);
  return render(ctx, `💲 <b>NARX SO'ROVLARI</b>\n${LINE}\nDeklarantdan yuk narxini so'rang yoki so'rovlaringiz holatini ko'ring.`, inline(rows));
};

// ---------------- so'rov sehrgari ----------------

/** Deklarant tanlash (pq_pick). Qoralama (tavsif/media) bo'lsa saqlanadi */
const pickDeclarant = async (ctx, draft) => {
  const emp = ctx.state.employee;
  const list = (await employees.listDeclarants()).filter((e) => !same(e.id, emp.id));
  if (!list.length) return ctx.reply("⚠️ Deklarant belgilanmagan — rahbarga ayting.", ui.kbFor(ctx));
  session.set(ctx.from.id, { step: 'pq_pick', pq: draft || {} });
  const rows = list.map((e) => [cb(`📑 ${e.full_name}`.slice(0, 60), `pq:d:${e.id}`)]);
  rows.push([cb(ui.BTN.cancel, 'pq:x0')]);
  return render(ctx, "💲 <b>Qaysi deklarantdan narx so'raysiz?</b>", inline(rows));
};

const startNew = async (ctx) => {
  if (!ctx.state.employee || !canAsk(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  const s = session.get(ctx.from.id);
  const keep = s.step === 'pq_due' && s.pq && s.pq.description; // «Deklarantni almashtirish» — qoralama saqlanadi
  return pickDeclarant(ctx, keep ? { ...s.pq, declarantId: null, dueKey: null } : {});
};

const askDue = async (ctx, { fresh = false } = {}) => {
  const s = session.get(ctx.from.id);
  const row2 = [cb('☀️ Ertaga', 'pq:due:tomorrow')];
  if (!workEnded()) row2.unshift(cb('📅 Bugun', 'pq:due:today'));
  const rows = [[cb('⏱ 1 soat', 'pq:due:1h'), cb('⏱ 3 soat', 'pq:due:3h')], row2, [cb('♾ Muddatsiz', 'pq:due:none')]];
  if (s.pq && s.pq.parentId) rows.push([cb('👤 Deklarantni almashtirish', 'pq:new')]);
  rows.push([cb(ui.BTN.cancel, 'pq:x0')]);
  const text = '⏰ <b>Javob muddati qancha?</b>';
  return fresh ? ctx.reply(text, { parse_mode: 'HTML', ...inline(rows) }) : render(ctx, text, inline(rows));
};

const pickChosen = async (ctx, id) => {
  const emp = ctx.state.employee;
  const s = session.get(ctx.from.id);
  if (!emp || !canAsk(ctx)) return deny(ctx);
  if (s.step !== 'pq_pick' || !s.pq) return stale(ctx);
  const d = await employees.byId(id);
  if (!employees.isDeclarant(d) || same(d.id, emp.id)) return stale(ctx);
  await ctx.answerCbQuery();
  const draft = Boolean(s.pq.description);
  session.set(ctx.from.id, { step: draft ? 'pq_due' : 'pq_desc', pq: { ...s.pq, declarantId: d.id } });
  if (draft) return askDue(ctx);
  return ctx.reply(`📑 <b>${esc(d.full_name)}</b>\n\n✍️ Yuk tavsifini yozing (mijoz, tovar, miqdor, qayerdan — qayerga). Eng ko'pi 2000 belgi.`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
};

const handleDesc = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.pq || !ctx.state.employee || !canAsk(ctx)) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  const text = String(ctx.message.text || '').trim();
  if (!text) return ctx.reply('✍️ Tavsifni matn bilan yozing (media keyingi qadamda).', ui.cancelKeyboard());
  if (text.length > 2000) return ctx.reply(`Juda uzun (${text.length}/2000). Qisqartirib qayta yozing:`, ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'pq_media', pq: { ...s.pq, description: text } });
  return ctx.reply("📎 Rasm, hujjat, video yoki ovoz yuboring (ixtiyoriy):", inline([[cb("⏭ O'tkazish", 'pq:sk'), cb(ui.BTN.cancel, 'pq:x0')]]));
};

/** Media bosqichi — matn (STEP_HANDLERS; skip) yoki media (onMedia) */
const handleMedia = async (ctx, { skip = false } = {}) => {
  const s = session.get(ctx.from.id);
  if (s.step !== 'pq_media' || !s.pq || !canAsk(ctx)) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  const media = skip ? null : mediaOf(ctx.message);
  if (!skip && !media) return ctx.reply("📎 Rasm, hujjat, video yoki ovoz yuboring — yoki «⏭ O'tkazish» ni bosing.", inline([[cb("⏭ O'tkazish", 'pq:sk')]]));
  session.set(ctx.from.id, { step: 'pq_due', pq: { ...s.pq, media } });
  return askDue(ctx);
};

const dueChosen = async (ctx, key) => {
  const s = session.get(ctx.from.id);
  if (s.step !== 'pq_due' || !s.pq) return stale(ctx);
  if (!canAsk(ctx)) return deny(ctx);
  if (pr.dueAtFor(key) === undefined || (key === 'today' && workEnded())) return stale(ctx);
  const d = await employees.byId(s.pq.declarantId);
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step: 'pq_confirm', pq: { ...s.pq, dueKey: key } });
  return render(
    ctx,
    `📨 <b>Tekshiring</b>\n📑 Deklarant: <b>${esc(d ? d.full_name : '—')}</b>\n⏰ Muddat: ${dueText(pr.dueAtFor(key))}\n📎 Media: ${s.pq.media ? 'bor' : "yo'q"}\n${LINE}\n${esc(s.pq.description)}`,
    inline([[cb('✅ Yuborish', 'pq:send'), cb(ui.BTN.cancel, 'pq:x0')]]),
  );
};

const send = async (ctx) => {
  const emp = ctx.state.employee;
  const s = session.get(ctx.from.id);
  if (s.step !== 'pq_confirm' || !s.pq || !s.pq.description || !s.pq.declarantId) return stale(ctx);
  if (!emp || !canAsk(ctx)) return deny(ctx);
  session.clear(ctx.from.id); // ikki marta bosishdan himoya
  const d = await employees.byId(s.pq.declarantId);
  if (!employees.isDeclarant(d)) {
    await ctx.answerCbQuery('Deklarant endi faol emas');
    return ctx.reply("⚠️ Tanlangan deklarant endi faol emas. «💲 Narxlar» orqali qaytadan boshlang.", ui.kbFor(ctx));
  }
  await ctx.answerCbQuery('Yuborilmoqda…');
  const r = await pr.create({
    requesterId: emp.id, declarantId: d.id, description: s.pq.description, media: s.pq.media || null,
    dueAt: pr.dueAtFor(s.pq.dueKey) || null, parentId: s.pq.parentId || null,
  });
  const delivered = await sendCard(ctx, d.tg_id, r, declRows(r));
  activity.mark(ctx, 'price_ask', { title: `№${r.id} ${short(r.description, 60)}` });
  await render(ctx, `✅ <b>№${r.id}</b> so'rov <b>${esc(d.full_name)}</b> ga yuborildi.\n⏰ Muddat: ${dueText(r.due_at)}${delivered ? '' : "\n⚠️ Xabar yetib bormadi (deklarant botni ochmagan bo'lishi mumkin) — unga to'g'ridan aytib qo'ying."}`);
  return ctx.reply('👌', ui.kbFor(ctx));
};

const cancelDraft = async (ctx) => {
  if (!String(session.get(ctx.from.id).step || '').startsWith('pq_')) return stale(ctx); // boshqa oqim bosqichini o'chirmaymiz
  session.clear(ctx.from.id);
  await ctx.answerCbQuery('Bekor qilindi');
  return ctx.reply('❌ Bekor qilindi.', ui.kbFor(ctx));
};

// ---------------- kartochkani ochish, narx, savol, javob ----------------

const view = async (ctx, id) => {
  const r = await pr.byId(id);
  const emp = ctx.state.employee;
  if (!r) return stale(ctx);
  const party = emp && (same(r.declarant_id, emp.id) || same(r.requester_id, emp.id));
  if (!isMgr(ctx) && !party && !(r.status === 'priced' && canSee(ctx))) return deny(ctx); // narx berilganni tarixdan ko'rish (faqat o'qish)
  await ctx.answerCbQuery();
  return sendCard(ctx, ctx.from.id, r, cardRows(r, ctx), await pr.messages(r.id));
};

/** Narx/savol boshlash: faqat tayinlangan deklarant, so'rov hali ochiq (open|asked) */
const startDeclarantStep = async (ctx, id, step, prompt) => {
  const r = await pr.byId(id);
  const emp = ctx.state.employee;
  if (!r || !emp || !same(r.declarant_id, emp.id) || !isDecl(ctx)) return deny(ctx);
  if (r.status !== 'open' && r.status !== 'asked') return stale(ctx);
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step, pq: { id: r.id } });
  return ctx.reply(prompt, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
};

const handlePrice = async (ctx) => {
  const s = session.get(ctx.from.id);
  if (!s.pq || !s.pq.id) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  const price = String(ctx.message.text || '').trim();
  if (!price) return ctx.reply('💲 Narxni matn bilan yozing:', ui.cancelKeyboard());
  if (price.length > 200) return ctx.reply(`Juda uzun (${price.length}/200). Qisqartiring:`, ui.cancelKeyboard());
  session.set(ctx.from.id, { step: 'pq_price_note', pq: { id: s.pq.id, price } });
  return ctx.reply("📝 Izoh yozing (ixtiyoriy) — yoki «⏭ O'tkazib yuborish».", ui.skipKeyboard());
};

const handlePriceNote = async (ctx, { skip = false } = {}) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.pq || !s.pq.id || !s.pq.price) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  const note = skip ? null : String(ctx.message.text || '').trim();
  if (note && note.length > 1500) return ctx.reply(`Juda uzun (${note.length}/1500). Qisqartiring:`, ui.skipKeyboard());
  session.clear(ctx.from.id);
  const r = await pr.byId(s.pq.id);
  if (!r || !emp || !isDecl(ctx) || !same(r.declarant_id, emp.id) || !(await pr.setPrice(r.id, emp.id, s.pq.price, note))) {
    return ctx.reply("⚠️ Bu so'rov allaqachon yopilgan (narx berilgan yoki bekor qilingan).", ui.kbFor(ctx));
  }
  activity.mark(ctx, 'price_given', { title: `№${r.id} ${short(r.description, 60)}`, detail: s.pq.price });
  await notify.toUser(
    botOf(ctx), r.requester_tg,
    `✅ <b>№${r.id} — NARX BERILDI</b>\n${esc(short(r.description, 200))}\n${LINE}\n💲 <b>${esc(s.pq.price)}</b>${note ? `\n📝 ${esc(note)}` : ''}\n<i>${esc(r.declarant_name)}</i>`,
    inline([[cb("🔄 Qayta so'rash", `pq:r:${r.id}`)]]),
  );
  return ctx.reply(`✅ №${r.id} — narx ${esc(r.requester_name)} ga yuborildi.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
};

/** Matn yoki media(+izoh) → { text, media }; bo'sh bo'lsa null */
const noteOf = (ctx) => {
  const media = mediaOf(ctx.message);
  const text = String((ctx.message.text || ctx.message.caption || '')).trim();
  return text || media ? { text: text || null, media } : null;
};

const handleQuestion = async (ctx) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.pq || !s.pq.id) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  const note = noteOf(ctx);
  if (!note) return ctx.reply('❓ Savolni yozing yoki rasm / ovoz / fayl yuboring:', ui.cancelKeyboard());
  if (note.text && note.text.length > 1500) return ctx.reply(`Juda uzun (${note.text.length}/1500). Qisqartiring:`, ui.cancelKeyboard());
  session.clear(ctx.from.id);
  const r = await pr.byId(s.pq.id);
  if (!r || !emp || !isDecl(ctx) || !same(r.declarant_id, emp.id) || !(await pr.ask(r.id, emp.id, note))) {
    return ctx.reply("⚠️ Bu so'rov allaqachon yopilgan (narx berilgan yoki bekor qilingan).", ui.kbFor(ctx));
  }
  activity.mark(ctx, 'price_question', { title: `№${r.id} ${short(r.description, 60)}`, detail: note.text });
  await sendNote(ctx, r.requester_tg, `❓ <b>№${r.id} — DEKLARANT SAVOLI</b>`, r, `${esc(note.text || '')}\n<i>${esc(r.declarant_name)}</i>`, note.media, [[cb('💬 Javob berish', `pq:a:${r.id}`)]]);
  return ctx.reply(`✅ Savol ${esc(r.requester_name)} ga yuborildi. Javob kelganda xabar beraman.`, { parse_mode: 'HTML', ...ui.kbFor(ctx) });
};

const startAnswer = async (ctx, id) => {
  const r = await pr.byId(id);
  const emp = ctx.state.employee;
  if (!r || !emp || !same(r.requester_id, emp.id)) return deny(ctx);
  if (r.status !== 'asked') return stale(ctx);
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step: 'pq_answer', pq: { id: r.id } });
  return ctx.reply(`💬 <b>№${r.id}</b> — deklarant savoliga javobingizni yozing (yoki rasm / ovoz / fayl):`, { parse_mode: 'HTML', ...ui.cancelKeyboard() });
};

const handleAnswer = async (ctx) => {
  const s = session.get(ctx.from.id);
  const emp = ctx.state.employee;
  if (!s.pq || !s.pq.id) { session.clear(ctx.from.id); return ctx.reply('Sessiya eskirgan.', ui.kbFor(ctx)); }
  const note = noteOf(ctx);
  if (!note) return ctx.reply('💬 Javobni yozing yoki rasm / ovoz / fayl yuboring:', ui.cancelKeyboard());
  if (note.text && note.text.length > 1500) return ctx.reply(`Juda uzun (${note.text.length}/1500). Qisqartiring:`, ui.cancelKeyboard());
  session.clear(ctx.from.id);
  const r = await pr.byId(s.pq.id);
  if (!r || !emp || !same(r.requester_id, emp.id) || !(await pr.answer(r.id, emp.id, note))) {
    return ctx.reply("⚠️ Bu savol allaqachon yopilgan.", ui.kbFor(ctx));
  }
  activity.mark(ctx, 'price_answer', { title: `№${r.id} ${short(r.description, 60)}`, detail: note.text });
  await sendNote(ctx, r.declarant_tg, `💬 <b>№${r.id} — JAVOB</b>`, r, `${esc(note.text || '')}\n<i>${esc(r.requester_name)}</i>`, note.media, declRows(r));
  return ctx.reply('✅ Javob deklarantga yuborildi.', ui.kbFor(ctx));
};

// ---------------- bekor qilish / qayta so'rash ----------------

const cancelRequest = async (ctx, id) => {
  const r = await pr.byId(id);
  const emp = ctx.state.employee;
  if (!r) return stale(ctx);
  const byRequester = Boolean(emp && same(r.requester_id, emp.id));
  if (!byRequester && !isMgr(ctx)) return deny(ctx);
  if (!(await pr.cancel(r.id, emp ? emp.id : 0))) return stale(ctx);
  activity.mark(ctx, 'price_cancel', { title: `№${r.id} ${short(r.description, 60)}` });
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  const text = `❌ №${r.id} so'rov bekor qilindi\n${esc(short(r.description, 100))}`;
  await notify.toUser(botOf(ctx), r.declarant_tg, text);
  if (!byRequester) await notify.toUser(botOf(ctx), r.requester_tg, `${text}\n<i>Rahbar bekor qildi</i>`);
  return ctx.reply(`❌ №${r.id} bekor qilindi.`, ui.kbFor(ctx));
};

const reRequest = async (ctx, id) => {
  const r = await pr.byId(id);
  const emp = ctx.state.employee;
  if (!r || !emp || !same(r.requester_id, emp.id) || !canAsk(ctx)) return deny(ctx);
  if (r.status !== 'priced' && r.status !== 'cancelled') return stale(ctx);
  await ctx.answerCbQuery();
  const draft = { description: r.description, media: reqMedia(r), parentId: r.id };
  const d = await employees.byId(r.declarant_id);
  if (!employees.isDeclarant(d)) return pickDeclarant(ctx, draft); // deklarant endi faol emas — boshqasini tanlash
  session.set(ctx.from.id, { step: 'pq_due', pq: { ...draft, declarantId: d.id } });
  return askDue(ctx, { fresh: true });
};

// ---------------- tarix, qidiruv, statistika, barcha ochiqlar, Excel ----------------

const canSee = (ctx) => isDecl(ctx) || canAsk(ctx);
const SEARCH_MIN = 2;
const SEARCH_MAX = 100;
const HISTORY_LIMIT = 10;
const SEARCH_LIMIT = 20;

/** Tarix / qidiruv natijasi (q bor bo'lsa — qidiruv): oxirgi 10 / 20 tagacha narx berilgan so'rov */
const showHistory = async (ctx, q = null) => {
  const rows = await pr.history({ q, limit: q ? SEARCH_LIMIT : HISTORY_LIMIT });
  const lines = rows.map((r) => `№${r.id} · ${time.shortDate(String(r.priced_at || r.created_at).slice(0, 10))} · ${esc(r.requester_name)}\n   ${esc(short(r.description, 60))} → 💲 ${esc(r.price)}`);
  const empty = q ? '<i>Topilmadi</i>' : "<i>Hozircha narx berilgan so'rov yo'q</i>";
  const kb = inline([
    ...rows.map((r) => [cb(`№${r.id} · ${short(r.description, 40)}`.slice(0, 60), `pq:v:${r.id}`)]), // bosib kartochkani ochish
    [cb('🔎 Qidirish', 'pq:hs'), cb('⬅️ Menyu', 'pq:menu')],
  ]);
  const text = `📜 <b>NARXLAR TARIXI</b>${q ? ` · «${esc(q)}»` : ''}\n${LINE}\n${lines.join('\n') || empty}`;
  return render(ctx, text, kb); // uzun natija bo'linadi
};

const startSearch = async (ctx) => {
  if (!canSee(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  session.set(ctx.from.id, { step: 'pq_search' });
  return ctx.reply(`🔎 Qidiruv so'zini yozing (tavsif bo'yicha, kamida ${SEARCH_MIN} belgi):`, ui.cancelKeyboard());
};

const handleSearch = async (ctx) => {
  if (!canSee(ctx)) { session.clear(ctx.from.id); return ctx.reply("⛔️ Narx bo'limi sizga ochiq emas.", ui.kbFor(ctx)); }
  const q = String(ctx.message.text || '').trim().slice(0, SEARCH_MAX);
  if (q.length < SEARCH_MIN) return ctx.reply(`🔎 Kamida ${SEARCH_MIN} belgi yozing:`, ui.cancelKeyboard());
  session.clear(ctx.from.id);
  return showHistory(ctx, q);
};

/** Davr: bugun−(d−1) … bugun */
const periodOf = (days) => ({ from: time.addDays(time.today(), -(Number(days) - 1)), to: time.today() });

const showStats = async (ctx, days) => {
  if (!isMgr(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  const { from, to } = periodOf(days);
  const stats = await pr.stats(from, to);
  const requesters = await pr.byRequester(from, to);
  const lines = stats.map((d) => `👤 <b>${esc(d.name)}</b> — so'rov ${d.total} · narx ${d.priced} · o'rtacha ${time.prettyDuration(d.avgMinutes)} · 🔴 kechikkan ${d.late} · ⏳ ochiq ${d.open}`);
  const kb = inline([
    [cb('7 kun', 'pq:st:7'), cb('30 kun', 'pq:st:30')],
    [cb('📋 Barcha ochiq', 'pq:all'), cb('📥 Excel', `pq:xl:${days}`)],
    [cb('⬅️ Menyu', 'pq:menu')],
  ]);
  const reqBlock = requesters.length ? `\n\n👤 <b>So'rovchilar</b>\n${requesters.map((x) => `${esc(x.name)} — ${x.total}`).join('\n')}` : '';
  return render(ctx, `📊 <b>NARX SO'ROVLARI</b> · ${time.prettyRange(from, to)} (${days} kun)\n${LINE}\n${lines.join('\n') || "<i>Bu davrda so'rov yo'q</i>"}${reqBlock}`, kb);
};

/** Barcha ochiq so'rovlar — deklarant bo'yicha guruhlangan; nofaol deklarant sarlavhada ⚠️ */
const showAllOpen = async (ctx) => {
  if (!isMgr(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  const groups = new Map();
  for (const r of await pr.allOpen()) {
    if (!groups.has(r.declarant_id)) groups.set(r.declarant_id, []);
    groups.get(r.declarant_id).push(r);
  }
  const out = [];
  let size = 0;
  let cut = 0; // sig'madigan so'rov qatorlari
  let full = false;
  for (const list of groups.values()) {
    const head = `
📑 <b>${esc(list[0].declarant_name)}</b> (${list.length})${declOk(list[0]) ? '' : ' ⚠️ nofaol'}`;
    const lines = list.map((r) => `${markOf(r)} №${r.id} · ${esc(r.requester_name)} · ${esc(short(r.description, 60))} · ⏰ ${hourOf(r)}`);
    // birinchi to'lishda to'xtaymiz: qator o'z deklarant sarlavhasisiz hech qachon ko'rinmaydi (sarlavha + birinchi qator birga sig'ishi kerak)
    if (!full && size + head.length + lines[0].length + 1 > 3500) full = true;
    if (full) { cut += lines.length; continue; }
    out.push(head);
    size += head.length + 1;
    lines.forEach((l) => {
      if (!full && size + l.length > 3500) full = true; // Telegram 4096 chegarasi
      if (full) { cut += 1; return; }
      out.push(l);
      size += l.length + 1;
    });
  }
  const total = [...groups.values()].reduce((a, l) => a + l.length, 0);
  const text = `📋 <b>BARCHA OCHIQ NARX SO'ROVLARI (${total})</b>\n${LINE}${out.join('\n') || "\n<i>Ochiq so'rov yo'q ✅</i>"}${cut ? `\n<i>… yana ${cut} qator sig'madi</i>` : ''}`;
  return render(ctx, text, inline([[cb('📊 Statistika', 'pq:st:7'), cb('⬅️ Menyu', 'pq:menu')]]));
};

const sendExcel = async (ctx, days) => {
  if (!isMgr(ctx)) return deny(ctx);
  await ctx.answerCbQuery('Tayyorlanmoqda…');
  const { from, to } = periodOf(days);
  const file = await excel.buildPriceRequests(from, to);
  await notify.docToUser(botOf(ctx), ctx.from.id, file.buffer, file.filename, `📥 <b>Narx so'rovlari</b> — ${time.prettyRange(from, to)} (${days} kun)`);
};

// ---------------- ro'yxatdan o'tkazish ----------------

const onMedia = async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const step = session.get(ctx.from.id).step;
  if (!MEDIA_STEPS.includes(step) || !ctx.state.employee) return next();
  if (step === 'pq_desc') return ctx.reply('✍️ Avval tavsifni matn bilan yozing — media keyingi qadamda.', ui.cancelKeyboard());
  if (step === 'pq_media') return handleMedia(ctx);
  return step === 'pq_question' ? handleQuestion(ctx) : handleAnswer(ctx);
};

const register = (bot) => {
  const open = async (ctx) => {
    if (ctx.chat.type !== 'private') return null;
    session.clear(ctx.from.id);
    return menu(ctx);
  };
  const reg = (fn) => async (ctx) => (ctx.state.employee || ctx.state.isAdmin ? fn(ctx) : ctx.answerCbQuery('⛔️'));
  const num = (ctx) => Number(ctx.match[1]);
  bot.hears(ui.BTN.prices, open);
  bot.command('narx', open);
  bot.action('pq:menu', reg(async (ctx) => { await ctx.answerCbQuery(); session.clear(ctx.from.id); return menu(ctx); }));
  bot.action('pq:new', reg(startNew));
  bot.action(/^pq:d:(\d+)$/, reg((ctx) => pickChosen(ctx, num(ctx))));
  bot.action('pq:sk', reg(async (ctx) => {
    if (session.get(ctx.from.id).step !== 'pq_media') return stale(ctx);
    await ctx.answerCbQuery();
    return handleMedia(ctx, { skip: true });
  }));
  bot.action(/^pq:due:(\w+)$/, reg((ctx) => dueChosen(ctx, ctx.match[1])));
  bot.action('pq:send', reg(send));
  bot.action('pq:x0', reg(cancelDraft));
  bot.action(/^pq:in(?::(\d+))?$/, reg(async (ctx) => { if (!isDecl(ctx)) return deny(ctx); await ctx.answerCbQuery(); return showInbox(ctx, ctx.match[1]); }));
  bot.action(/^pq:my(?::(\d+))?$/, reg(async (ctx) => { await ctx.answerCbQuery(); return showMine(ctx, ctx.match[1]); }));
  bot.action(/^pq:v:(\d+)$/, reg((ctx) => view(ctx, num(ctx))));
  bot.action(/^pq:p:(\d+)$/, reg((ctx) => startDeclarantStep(ctx, num(ctx), 'pq_price', "💲 <b>Narxni yozing</b> (masalan: <code>1 250$</code> yoki <code>3.5$/kg</code>):")));
  bot.action(/^pq:q:(\d+)$/, reg((ctx) => startDeclarantStep(ctx, num(ctx), 'pq_question', '❓ <b>Savolingizni yozing</b> (yoki rasm / ovoz / fayl yuboring):')));
  bot.action(/^pq:a:(\d+)$/, reg((ctx) => startAnswer(ctx, num(ctx))));
  bot.action(/^pq:x:(\d+)$/, reg((ctx) => cancelRequest(ctx, num(ctx))));
  bot.action(/^pq:r:(\d+)$/, reg((ctx) => reRequest(ctx, num(ctx))));
  bot.action('pq:h', reg(async (ctx) => { if (!canSee(ctx)) return deny(ctx); await ctx.answerCbQuery(); session.clear(ctx.from.id); return showHistory(ctx); }));
  bot.action('pq:hs', reg(startSearch));
  bot.action(/^pq:st:(7|30)$/, reg((ctx) => showStats(ctx, num(ctx))));
  bot.action('pq:all', reg(showAllOpen));
  bot.action(/^pq:xl:(7|30)$/, reg((ctx) => sendExcel(ctx, num(ctx))));
  bot.on(['photo', 'document', 'video', 'video_note', 'voice', 'audio'], onMedia);
};

// ---------------- eslatmalar (cron: jobs.js «price-nag») ----------------

/**
 * Narx so'rovlari eslatmalari — faqat ish kuni va ish vaqti ichida; "hozir" — `now` dan (testlar uchun deterministik).
 *  1) deklarantga: kutilayotgan (open) so'rovlar bo'yicha har PRICE_REMIND_MIN daqiqada BITTA xabar (ro'yxat);
 *  2) muddati o'tganlar — so'rovchiga va (faol) deklarantga, bir martadan;
 *  3) deklarant savol bergan, so'rovchi javob bermagan — so'rovchiga bir marta turtki.
 * Yuborilgan xabarlar sonini qaytaradi.
 */
const nag = async (bot, now = time.now()) => {
  if (!time.isWorkDay(now.toFormat('yyyy-MM-dd'))) return 0;
  const nowMin = now.hour * 60 + now.minute;
  if (nowMin < worktime.minutes() || nowMin >= employees.endMinutesOf(null)) return 0;
  const nowIso = now.toISO();
  let n = 0;
  const deliver = async (tgId, text, extra) => {
    if (!tgId) return;
    if (await notify.toUser(bot, tgId, text, extra)) n += 1;
  };

  // 1) deklarantga bitta ro'yxat: biror ochiq so'rovi eslatma muddatiga yetgan deklarantga BARCHA ochiq (open) so'rovlari bitta xabarda
  const declIds = [...new Set((await pr.dueForReminder(nowIso, config.priceRemindMin)).map((r) => r.declarant_id))];
  const listed = new Set(); // ro'yxatda ko'rsatilgan so'rovlar — ularga alohida «muddati o'tdi» yuborilmaydi
  for (const declId of declIds) {
    const list = (await pr.inbox(declId)).filter((r) => r.status === 'open');
    if (!list.length) continue;
    const lines = list.map((r) => {
      const mins = Math.max(0, Math.round(now.diff(DateTime.fromISO(r.created_at, { zone: time.TZ }), 'minutes').minutes));
      return `${r.due_at && r.due_at <= nowIso ? '🔴' : '🟡'} №${r.id} · ${esc(r.requester_name)} · ${esc(short(r.description, 40))} · (${time.prettyDuration(mins)}dan beri)`;
    });
    const rows = [...list.map((r) => [cb(`💲 №${r.id}`, `pq:p:${r.id}`)]), [cb("📥 Barcha so'rovlar", 'pq:in')]];
    await deliver(list[0].declarant_tg, `⏰ <b>NARX KUTILMOQDA (${list.length})</b>\n${LINE}\n${lines.join('\n')}`, inline(rows));
    await pr.markReminded(list.map((r) => r.id), nowIso);
    list.forEach((r) => listed.add(r.id));
  }

  // 2) muddati o'tganlar — bir marta (nofaol / bayroqsiz deklarantga yuborilmaydi, so'rovchiga esa boradi)
  for (const r of await pr.overdue(nowIso)) {
    await deliver(r.requester_tg, `⚠️ №${r.id} ga hali narx berilmadi (muddat ${dueText(r.due_at)})\n${esc(short(r.description, 60))}`);
    if (declOk(r) && !listed.has(r.id)) await deliver(r.declarant_tg, `🔴 №${r.id} muddati o'tdi\n${esc(short(r.description, 60))}`, inline([[cb('💲 Narx berish', `pq:p:${r.id}`)]]));
    await pr.markOverdue(r.id, nowIso);
  }

  // 3) deklarant savoliga javob kutilmoqda
  for (const r of await pr.askedStale(nowIso, config.priceRemindMin)) {
    await deliver(r.requester_tg, `💬 №${r.id} — deklarant savoliga javob kutilmoqda\n${esc(short(r.description, 60))}`, inline([[cb('💬 Javob berish', `pq:a:${r.id}`)]]));
    await pr.markAskedNudged(r.id, nowIso);
  }
  return n;
};

module.exports = { register, nag, handleSearch, handleDesc, handleMedia, handlePrice, handlePriceNote, handleQuestion, handleAnswer };
