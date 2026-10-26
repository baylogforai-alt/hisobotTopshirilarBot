'use strict';

const ui = require('../ui');
const time = require('../time');
const { render } = require('../render');
const employees = require('../services/employees');
const attendance = require('../services/attendance');
const tasks = require('../services/tasks');
const reports = require('../services/reports');
const access = require('../services/access');

const { esc, cb, inline } = ui;

/**
 * «👥 HODIMLARIM» — tashkiliy tuzilma.
 *   Rahbarlar = role 'head' (HR — is_hr belgisi, sotuv rahbari va h.k. — lavozimi bilan). Rahbarning jamoasi — uning bo'limidagi hodimlar.
 *   Direktor: rahbarlar ro'yxati → rahbar (jamoasi, bugungi holat) → hodim kartochkasi; «Rahbarsiz» — rahbari yo'q hodimlar.
 *   Rahbar: o'z jamoasi → hodim (oylik hisobot + topshiriq berish).
 */

const DAY_ICON = { ontime: '🟢', late: '🟡', absent: '🔴', excused: '📄', pending: '🙋', future: '⚪', off: '⚪', extra: '🟢' };

const todayIcon = async (e) => DAY_ICON[attendance.dayStatus(await attendance.get(e.id), time.today(), time.today(), e)] || '⚪';

const personLine = async (e) => `${await todayIcon(e)} ${employees.personIcon(e)} <b>${esc(e.full_name)}</b>${employees.titleOf(e) ? ` · ${esc(employees.titleOf(e))}` : ''}`;

const PROOF_ICON = { voice: '🎙', audio: '🎙', video: '🎥', video_note: '🎥', photo: '🖼', document: '📄' };

/**
 * 8-okt: bo'lim rahbari jamoasining bugungi holatini to'liq ko'rsin — kech qolaman / kelmayman / kechikish sababi, keldi-ketdi.
 * { lines: matn qatorlari, proofs: [{ label, data }] } — sabab ovoz/video bo'lsa qayta eshitish tugmasi (tm:pf)
 */
const todayNotes = async (e) => {
  const r = await attendance.get(e.id);
  const lines = [];
  const proofs = [];
  if (!r) return { lines, proofs };
  const first = e.full_name.split(' ')[0];
  if (r.checked_in) lines.push(`keldi ${time.clock(r.checked_in)}${r.checked_out ? ` · ketdi ${time.clock(r.checked_out)}` : ''}`);
  if (r.late_notice_at) lines.push(`⏰ kech qolaman (${time.clock(r.late_notice_at)}): «${esc(r.late_reason || '')}»`);
  else if (r.late_reason) lines.push(`⏰ kechikish sababi: «${esc(r.late_reason)}»`);
  if (r.late_proof_file_id) proofs.push({ label: `${PROOF_ICON[r.late_proof_type] || '📎'} ${first} — kechikish sababi`, data: `tm:pf:${r.id}:l` });
  if (r.excuse_status) lines.push(`🙋 kelmayman (${r.excuse_status === 'approved' ? 'sababli' : r.excuse_status === 'rejected' ? 'rad etilgan' : 'kutilmoqda'}): «${esc(r.excuse_reason || '')}»`);
  if (r.excuse_proof_file_id) proofs.push({ label: `${PROOF_ICON[r.excuse_proof_type] || '📎'} ${first} — kelmaslik sababi`, data: `tm:pf:${r.id}:x` });
  if (r.checkout_note) lines.push(`🏁 «${esc(r.checkout_note)}»`);
  return { lines, proofs };
};

const seeAll = (ctx) => ctx.state.isAdmin || ctx.state.isHr;

const SHOW_TASKS = 4;
const shortDue = (d) => (d === time.today() ? 'bugun' : `${String(d).slice(8, 10)}.${String(d).slice(5, 7)}`);

/** 9-okt: jamoa oynasida hodim vazifalari — hisob qatori + ochiq vazifalar (kechikkanlar birinchi) */
const taskNotes = (x) => {
  if (!x || (!x.open.length && !x.done)) return ["📋 <i>vazifa yo'q</i>"];
  const lines = [`📋 ⏳ ${x.active} faol${x.late ? ` (🔴 ${x.late} kechikkan)` : ''} · 🕓 ${x.review} tekshiruvda · ✅ ${x.done} bajarildi`];
  for (const t of x.open.slice(0, SHOW_TASKS)) {
    const icon = t.status === 'done' ? '🕓' : t.due_date < time.today() ? '🔴' : Number(t.returned_count) ? '🔁' : '🔹';
    const title = t.title.length > 45 ? `${t.title.slice(0, 44)}…` : t.title;
    lines.push(`${icon} ${t.task_media_type ? `${ui.MEDIA_ICON[t.task_media_type] || '📎'} ` : ''}${esc(title)} — ${shortDue(t.due_date)}`);
  }
  if (x.open.length > SHOW_TASKS) lines.push(`<i>… yana ${x.open.length - SHOW_TASKS} ta</i>`);
  return lines;
};

const teamHome = async (ctx) => {
  if (!ctx.state.isManager) return ctx.reply('⛔️ Faqat rahbarlar uchun.');
  if (!seeAll(ctx)) return managerView(ctx, ctx.state.employee.id);
  const managers = await employees.listHeads();
  const lines = [];
  const rows = [];
  for (const m of managers) {
    const team = await employees.teamOf(m);
    lines.push(`${await personLine(m)} — ${team.length} hodim`);
    rows.push([cb(`${employees.personIcon(m)} ${m.full_name} · ${employees.titleOf(m)} (${team.length})`.slice(0, 60), `tm:m:${m.id}`)]);
  }
  const loose = await employees.listUnmanaged();
  if (loose.length) rows.push([cb(`👤 Rahbarsiz hodimlar (${loose.length})`, 'tm:none')]);
  rows.push([cb('📤 Topshiriq berish', 'as:start'), ctx.state.isAdmin ? cb("👥 Hamma ro'yxat", 'emp:list') : cb('👁 Davomat', 'vw:today')]);
  return render(
    ctx,
    `👥 <b>HODIMLARIM</b>\n<i>🟢 vaqtida · 🟡 kech · 🔴 kelmagan · 📄 sababli · ⚪ hali yo'q</i>\n${ui.LINE}\n` +
      `${lines.join('\n') || "<i>Hali rahbar (HR, sotuv rahbari) yo'q — hodim kartochkasida rolni «Bo'lim boshlig'i» qiling.</i>"}` +
      (loose.length ? `\n\n👤 Rahbarsiz: ${loose.length} hodim` : ''),
    inline(rows),
  );
};

const managerView = async (ctx, mgrId) => {
  const m = await employees.byId(mgrId);
  if (!m || !m.active) return teamHome(ctx);
  const own = ctx.state.employee && Number(ctx.state.employee.id) === Number(m.id);
  if (!seeAll(ctx) && !own) return ctx.reply('⛔️');
  const team = await employees.teamOf(m);
  const work = await tasks.summaryFor(ctx.state.actor, team.map((e) => e.id));
  const lines = [];
  const proofRows = [];
  for (const e of team) {
    const notes = await todayNotes(e);
    lines.push(`${await personLine(e)}${[...notes.lines, ...taskNotes(work.get(Number(e.id)))].map((l) => `\n      ${l}`).join('')}`);
    notes.proofs.forEach((p) => proofRows.push([cb(p.label.slice(0, 60), p.data)]));
  }
  const rows = team.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}${e.position ? ` · ${e.position}` : ''}`.slice(0, 60), `tm:e:${e.id}`)]);
  rows.push(...proofRows);
  if (seeAll(ctx) && !own) {
    rows.push([cb(`📤 ${m.full_name.split(' ')[0]}ga topshiriq`, `as:emp:${m.id}`), cb('👥 Hodimlariga topshiriq', `as:team:${m.id}`)]);
    if (ctx.state.isAdmin) rows.push([cb(`📨 ${m.full_name.split(' ')[0]} bergan topshiriqlar`, `emp:given:${m.id}`)]);
    rows.push([cb('👤 Kartochka', ctx.state.isAdmin ? `emp:${m.id}` : `tm:e:${m.id}`), cb('⬅️ Hodimlarim', 'tm:home')]);
  } else {
    rows.push([cb('📤 Topshiriq berish', 'as:start')]);
  }
  const head = own
    ? `👥 <b>MENING JAMOAM</b> · ${esc(m.department_name || '')}`
    : `${await personLine(m)}\n🏢 ${esc(m.department_name || "bo'lim biriktirilmagan")}`;
  return render(
    ctx,
    `${head}\n<i>🔹 faol · 🔴 kechikkan · 🔁 qaytarilgan · 🕓 tekshiruvda · hodimni bosing — batafsil</i>\n${ui.LINE}\n${lines.join('\n\n') || (m.department_id ? "<i>Jamoada hodim yo'q.</i>" : "<i>Bo'lim biriktirilmagan — kartochkada bo'lim tanlang, shu bo'lim hodimlari jamoasi bo'ladi.</i>")}`,
    inline(rows),
  );
};

const memberView = async (ctx, empId) => {
  const e = await employees.byId(empId);
  if (!e) return teamHome(ctx);
  if (ctx.state.isAdmin) return require('./admin').employeeCard(ctx, e.id);
  if (!employees.canManage(ctx.state.employee, false, e)) return ctx.answerCbQuery ? ctx.answerCbQuery('⛔️') : null;
  const open = tasks.visibleFor(ctx.state.actor, await tasks.openFor(e.id));
  const home = employees.homeOf(e);
  const homeLine = employees.isField(e) ? `\n🏠 Uy joylashuvi: ${home ? require('./field').mapLink(home.lat, home.lon) : '<i>belgilanmagan</i>'}` : '';
  const notes = await todayNotes(e);
  const todayText = notes.lines.length ? `\n\n📅 <b>Bugun:</b>\n${notes.lines.map((l) => `• ${l}`).join('\n')}` : '';
  const text = `${await reports.buildMyReport(e, time.month(), ctx.state.actor)}${todayText}\n\n💬 Lichka: ${employees.contactHtml(e)}${homeLine}`;
  const rows = [[cb('📤 Topshiriq berish', `as:emp:${e.id}`), cb(`📋 Ochiq (${open.length})`, `rp:emp:${e.id}:${time.month()}`)]];
  notes.proofs.forEach((p) => rows.push([cb(p.label.slice(0, 60), p.data)]));
  if (access.canSetHome(ctx.state.actor, e)) rows.push([cb(home ? "🏠 Uy joyini o'zgartirish" : '🏠 Uy joyini belgilash', `fh:${e.id}`)]);
  // 20-okt: o'tkazib yuborilgan kunni to'g'rilash va intizom ogohlantirishi — bo'lim rahbari ham
  const extra = [];
  if (access.canMarkPresent(ctx.state.actor, e)) extra.push(cb('✅ Keldi deb belgilash', `emp:present:${e.id}`));
  if (access.canWarn(ctx.state.actor, e)) extra.push(cb('⚠️ Ogohlantirish', `wn:e:${e.id}`));
  if (extra.length) rows.push(extra);
  if (ctx.state.isHr) {
    rows.push([cb("🧭 Yo'nalishlari", `ed:${e.id}`), cb(employees.isViewer(e) ? '👁 Nazorat: ha' : "👁 Nazorat: yo'q", `vw:grant:${e.id}`)]);
  }
  rows.push([cb('⬅️ Hodimlarim', 'tm:home')]);
  return render(ctx, text, inline(rows));
};

const unmanagedView = async (ctx) => {
  const list = await employees.listUnmanaged();
  const lines = [];
  for (const e of list) lines.push(await personLine(e));
  const rows = list.map((e) => [cb(`${employees.personIcon(e)} ${e.full_name}`.slice(0, 60), ctx.state.isAdmin ? `emp:${e.id}` : `tm:e:${e.id}`)]);
  rows.push([cb('⬅️ Hodimlarim', 'tm:home')]);
  return render(ctx, `👤 <b>RAHBARSIZ HODIMLAR</b>\n<i>Bo'limida rahbar (HR / sotuv rahbari) yo'q. Kartochkada bo'limini o'zgartiring.</i>\n${ui.LINE}\n${lines.join('\n') || "<i>yo'q</i>"}`, inline(rows));
};

const guardMgr = async (ctx) => {
  if (ctx.state.isManager) return true;
  await ctx.answerCbQuery('⛔️ Faqat rahbarlar uchun');
  return false;
};

const register = (bot) => {
  bot.hears(ui.BTN.myTeam, teamHome);
  bot.command('hodimlarim', teamHome);
  bot.action('tm:home', async (ctx) => { if (await guardMgr(ctx)) { await ctx.answerCbQuery(); await teamHome(ctx); } });
  bot.action(/^tm:m:(\d+)$/, async (ctx) => { if (await guardMgr(ctx)) { await ctx.answerCbQuery(); await managerView(ctx, ctx.match[1]); } });
  bot.action(/^tm:e:(\d+)$/, async (ctx) => { if (await guardMgr(ctx)) { await ctx.answerCbQuery(); await memberView(ctx, ctx.match[1]); } });
  // sabab (ovoz / video / rasm) — qayta eshitish: jamoasini boshqaradigan rahbar, HR, direktor
  bot.action(/^tm:pf:(\d+):([lx])$/, async (ctx) => {
    if (!(await guardMgr(ctx))) return undefined;
    const r = await attendance.byId(ctx.match[1]);
    const e = r && (await employees.byId(r.employee_id));
    if (!e || !(seeAll(ctx) || employees.canManage(ctx.state.employee, false, e))) return ctx.answerCbQuery('⛔️');
    const late = ctx.match[2] === 'l';
    const type = late ? r.late_proof_type : r.excuse_proof_type;
    const fileId = late ? r.late_proof_file_id : r.excuse_proof_file_id;
    if (!fileId) return ctx.answerCbQuery("Fayl yo'q");
    await ctx.answerCbQuery();
    const reason = late ? r.late_reason : r.excuse_reason;
    return require('../services/notify').sendProof({ telegram: ctx.telegram }, ctx.chat.id, { type, fileId },
      `${late ? '⏰' : '🙋'} <b>${esc(e.full_name)}</b> · ${time.prettyDate(r.work_date)}\n«${esc(reason || '')}»`);
  });
  bot.action('tm:none', async (ctx) => {
    if (!seeAll(ctx)) return ctx.answerCbQuery('⛔️');
    await ctx.answerCbQuery();
    return unmanagedView(ctx);
  });
};

module.exports = { register, teamHome, managerView, memberView };
