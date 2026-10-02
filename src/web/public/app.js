'use strict';

/*
 * BayLog Web App (Telegram Mini App).
 * Xavfsizlik: hamma matn DOM ga textContent orqali qo'yiladi (innerHTML ishlatilmaydi),
 * har bir so'rov Telegram initData bilan imzolanadi va server tomonida tekshiriladi.
 */
(() => {
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const INIT = tg && tg.initData ? tg.initData : '';
  if (INIT) document.documentElement.setAttribute('data-tg', '1');

  const $app = document.getElementById('app');
  const $title = document.getElementById('title');
  const $sub = document.getElementById('subtitle');
  const $sheet = document.getElementById('sheet');
  const $toast = document.getElementById('toast');

  const state = { me: null };

  // -------------------------------------------------------------------------
  // DOM yordamchilari
  // -------------------------------------------------------------------------
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = Boolean(v);
        else if (k === 'disabled') el.disabled = Boolean(v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };
  const mount = (...nodes) => { $app.replaceChildren(...nodes.flat(Infinity).filter(Boolean)); };
  const setTitle = (t, s = '') => { $title.textContent = t; $sub.textContent = s; document.title = t; };
  const go = (hash) => { if (location.hash === hash) router(); else location.hash = hash; };
  const haptic = (kind = 'success') => { try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(kind); } catch { /* yo'q */ } };

  let toastTimer = null;
  const toast = (msg, err = false) => {
    $toast.textContent = msg;
    $toast.className = err ? 'toast err' : 'toast';
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, err ? 4200 : 2600);
    haptic(err ? 'error' : 'success');
  };

  const confirmBox = (msg) => new Promise((resolve) => {
    if (tg && tg.showConfirm && INIT) { try { tg.showConfirm(msg, (ok) => resolve(Boolean(ok))); return; } catch { /* brauzer */ } }
    resolve(window.confirm(msg));
  });

  const openSheet = (title, ...content) => {
    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true' }, h('h3', null, title), ...content);
    $sheet.replaceChildren(panel);
    $sheet.hidden = false;
    $sheet.onclick = (e) => { if (e.target === $sheet) closeSheet(); };
    const first = panel.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 60);
  };
  const closeSheet = () => { $sheet.hidden = true; $sheet.replaceChildren(); };

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  const api = async (method, path, body) => {
    const opts = { method, headers: { Authorization: `tma ${INIT}` } };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    let res;
    try { res = await fetch(path, opts); } catch { throw Object.assign(new Error("Internet aloqasi yo'q"), { status: 0 }); }
    let data = null;
    try { data = await res.json(); } catch { /* bo'sh */ }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `Xato (${res.status})`), { status: res.status, code: data && data.code, data });
    return data;
  };
  const apiBlob = async (path) => {
    const res = await fetch(path, { headers: { Authorization: `tma ${INIT}` } });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* bo'sh */ }
      throw Object.assign(new Error((data && data.error) || `Xato (${res.status})`), { status: res.status, code: data && data.code });
    }
    return res.blob();
  };

  /** Tugmani bosilganda: kutish holati + xato toast */
  const action = (fn) => async (ev) => {
    const btn = ev && ev.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
    if (btn) btn.disabled = true;
    try { await fn(ev); } catch (e) { toast(e.message, true); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  };

  // -------------------------------------------------------------------------
  // Formatlash
  // -------------------------------------------------------------------------
  const clock = (iso) => { const m = /T(\d{2}:\d{2})/.exec(iso || ''); return m ? m[1] : '—'; };
  const parseD = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
  const fmtD = (dt) => dt.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = parseD(d); x.setUTCDate(x.getUTCDate() + n); return fmtD(x); };
  const today = () => (state.me ? state.me.today : fmtD(new Date()));
  const shortDate = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '—');
  const relDate = (d) => {
    const t = today();
    if (d === t) return 'bugun';
    if (d === addDays(t, 1)) return 'ertaga';
    if (d === addDays(t, -1)) return 'kecha';
    return shortDate(d);
  };
  const money = (n) => (n === null || n === undefined ? '—' : `${Math.round(Number(n)).toLocaleString('ru-RU').replace(/ /g, ' ')} so'm`);
  const dur = (min) => { if (!min) return '0 daq'; const hh = Math.floor(min / 60); const mm = min % 60; return hh ? `${hh} soat${mm ? ` ${mm} daq` : ''}` : `${mm} daq`; };
  const monthLabel = (m) => {
    const names = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
    return `${names[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  };
  const shiftMonth = (m, n) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const curMonth = () => today().slice(0, 7);
  const firstName = (n) => String(n || '').split(' ')[0];

  const DAY = {
    ontime: ['Vaqtida keldi', 'ontime'], late: ['Kech keldi', 'late'], absent: ['Kelmagan', 'absent'], excused: ['Sababli', 'excused'],
    pending: ['Sabab ko\'rilmoqda', 'pending'], future: ['Hali vaqti emas', 'future'], off: ['Dam olish', 'off'],
  };
  const dot = (st) => h('span', { class: `dot ${(DAY[st] || DAY.future)[1]}`, 'aria-hidden': 'true' });
  const chip = (txt, cls = '') => h('span', { class: `chip ${cls}`.trim() }, txt);
  const bar = (pct) => { const i = h('i'); i.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`; return h('div', { class: 'bar' }, i); };
  const empty = (txt) => h('div', { class: 'empty' }, txt);
  const section = (txt) => h('div', { class: 'section-title' }, txt);
  const SOURCE = { self: "o'zi", head: 'rahbar', admin: 'direktor' };
  const MEDIA_ICON = { voice: '🎤', audio: '🎵', video: '🎥', video_note: '🎥', photo: '🖼', document: '📄' };

  const seg = (items, active, onPick) => h('div', { class: 'seg', role: 'tablist' },
    items.map(([key, label]) => h('button', { class: key === active ? 'on' : '', type: 'button', role: 'tab', 'aria-selected': key === active ? 'true' : 'false', onclick: () => onPick(key) }, label)));

  /** Muddat tanlash: chiplar + sana */
  const duePicker = (initial = today()) => {
    let value = initial;
    const input = h('input', { class: 'input', type: 'date', min: today(), value });
    const opts = [['Bugun', 0], ['Ertaga', 1], ['3 kun', 3], ['1 hafta', 7]];
    const wrap = h('div', { class: 'seg' });
    const paint = () => { [...wrap.children].forEach((b, i) => b.classList.toggle('on', addDays(today(), opts[i][1]) === value)); };
    opts.forEach(([label, n]) => wrap.append(h('button', { type: 'button', onclick: () => { value = addDays(today(), n); input.value = value; paint(); } }, label)));
    input.addEventListener('change', () => { value = input.value || today(); paint(); });
    paint();
    return { el: h('div', { class: 'field' }, h('span', null, 'Muddat'), wrap, input), get: () => value };
  };

  const taskChips = (t, { withName = false } = {}) => {
    const c = [];
    if (withName) c.push(chip(`👤 ${t.employee.name}`));
    if (t.status === 'active') c.push(t.overdue ? chip(`🔴 muddat o'tdi (${shortDate(t.due)})`, 'red') : chip(`⏱ ${relDate(t.due)}`, t.due === today() ? 'amber' : ''));
    if (t.status === 'done') c.push(chip(`🕓 tekshiruvda · ${clock(t.doneAt)}`, t.lateDone ? 'red' : ''));
    if (t.status === 'accepted') c.push(chip(`✅ qabul · ${shortDate((t.doneAt || '').slice(0, 10))}`, t.lateDone ? 'amber' : 'green'));
    if (t.priority === 'high') c.push(chip('🔥 muhim', 'red'));
    if (t.returned) c.push(chip(`↩️ ${t.returned} marta qaytarilgan`, 'amber'));
    if (t.source !== 'self') c.push(chip(`bergan: ${SOURCE[t.source] || t.source}`));
    if (t.needsAck) c.push(chip("👂 «tushundim» yo'q", 'amber'));
    return h('div', { class: 'chips' }, c);
  };

  // -------------------------------------------------------------------------
  // Media (isbot / video) — serverdan oqim, blob URL
  // -------------------------------------------------------------------------
  const mediaNode = (blob, type) => {
    const url = URL.createObjectURL(blob);
    if (type === 'photo') return h('img', { src: url, alt: 'Isbot' });
    if (type === 'voice' || type === 'audio') return h('audio', { src: url, controls: true });
    if (type === 'video' || type === 'video_note') return h('video', { src: url, controls: true, playsinline: true });
    return h('a', { href: url, download: 'isbot' }, 'Faylni yuklab olish');
  };
  const showMedia = async (box, path, type, sendFallback) => {
    box.replaceChildren(h('div', { class: 'muted' }, 'Yuklanmoqda…'));
    try {
      box.replaceChildren(mediaNode(await apiBlob(path), type));
    } catch (e) {
      box.replaceChildren(h('div', { class: 'muted' }, e.message));
      if (sendFallback) box.append(h('button', { class: 'btn ghost small', type: 'button', onclick: action(sendFallback) }, '📨 Botda ochish'));
    }
  };

  // -------------------------------------------------------------------------
  // Xato ekrani
  // -------------------------------------------------------------------------
  const showError = (e) => {
    if (e.code === 'not_registered') {
      setTitle('BayLog', 'Yopiq ilova');
      return mount(h('div', { class: 'error-box' },
        h('div', { class: 'big' }, '⛔️'), h('p', null, "Siz ro'yxatda yo'qsiz. Direktor qo'shgandan keyin ilova ochiladi."),
        h('p', null, 'Telegram ID: ', h('b', null, String(e.data && e.data.tgId)))));
    }
    if (e.status === 401) {
      return mount(h('div', { class: 'error-box' }, h('div', { class: 'big' }, '🔒'),
        h('p', null, e.code === 'expired' ? "Sessiya eskirdi — ilovani yopib, bot ichidan qayta oching." : "Ilovani faqat Telegram'dagi bot ichidan ochish mumkin."),
        tg && INIT ? h('button', { class: 'btn', type: 'button', onclick: () => tg.close() }, 'Yopish') : null));
    }
    const final = e.status === 403 || e.status === 404;
    return mount(h('div', { class: 'error-box' }, h('div', { class: 'big' }, final ? '⛔️' : '⚠️'), h('p', null, e.message),
      final
        ? h('button', { class: 'btn', type: 'button', onclick: () => go('#/') }, 'Bosh sahifa')
        : h('button', { class: 'btn', type: 'button', onclick: () => router() }, 'Qayta urinish')));
  };

  // =========================================================================
  // BOSH SAHIFA
  // =========================================================================
  const reasonSheet = (title, hint, path, done) => {
    const ta = h('textarea', { class: 'input', maxlength: '300', placeholder: 'Sababini yozing…' });
    openSheet(title, h('p', { class: 'muted' }, hint), h('label', { class: 'field' }, ta),
      h('p', { class: 'hint' }, "Video yoki audio yubormoqchi bo'lsangiz — botdagi tugmadan foydalaning."),
      h('div', { class: 'btns' },
        h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'Bekor'),
        h('button', { class: 'btn', type: 'button', onclick: action(async () => {
          if (!ta.value.trim()) throw new Error('Sabab yozing');
          const r = await api('POST', path, { reason: ta.value });
          closeSheet(); done(r); router();
        }) }, 'Yuborish')));
  };

  const pageHome = async () => {
    const me = await api('GET', '/api/me');
    state.me = me;
    const r = me.roles;
    setTitle(`Salom, ${firstName(me.employee ? me.employee.name : me.name)}!`, `${me.company} · ${me.todayPretty}`);
    const out = [];

    if (me.employee && !me.monthConfirmed) {
      out.push(h('div', { class: 'banner' },
        h('p', null, h('b', null, 'Yangi ish oyi boshlandi. '), "Tasdiqlang — «Keldim» shundan keyin ochiladi. Vaqtida kelib, topshiriqlarni muddatida bajarganlarga KPI beriladi."),
        h('button', { class: 'btn block', type: 'button', onclick: action(async () => { await api('POST', '/api/month/confirm'); toast('Oy boshlandi. Omad! 💪'); router(); }) }, '✅ Tanishdim, boshladim')));
    }

    if (me.employee && me.attendance) {
      const a = me.attendance;
      const [label] = DAY[a.status] || DAY.future;
      const times = [];
      if (a.checkedIn) times.push(`keldi ${clock(a.checkedIn)}`);
      if (a.checkedOut) times.push(`ketdi ${clock(a.checkedOut)}`);
      if (a.status === 'late' && a.lateMinutes) times.push(`${dur(a.lateMinutes)} kech`);
      const btns = [];
      if (!a.checkedIn) {
        btns.push(h('button', { class: 'btn', type: 'button', onclick: () => { toast("Chatda «✅ Keldim» ni bosing (GPS + video)"); if (tg && INIT) setTimeout(() => tg.close(), 900); } }, '✅ Keldim (botda)'));
        btns.push(h('button', { class: 'btn ghost', type: 'button', onclick: () => reasonSheet('⏰ Kech qolaman', `Xabar HR va boshliqqa boradi. Ish boshlanishidan (${me.workStart}) kamida 1 soat oldin aytsangiz — kechikish hisoblanmaydi.`, '/api/att/late', (x) => toast(x.inTime ? 'Yuborildi — kechikish hisoblanmaydi' : 'Yuborildi')) }, '⏰ Kech qolaman'));
        if (a.excuse !== 'approved') btns.push(h('button', { class: 'btn ghost', type: 'button', onclick: () => reasonSheet('🙋 Bugun kelmayman', 'HR yoki boshliq tasdiqlasa — kun sababli hisoblanadi (KPI ga ta\'sir qilmaydi).', '/api/att/absence', () => toast("So'rov yuborildi")) }, '🙋 Kelmayman'));
      } else if (!a.checkedOut) {
        btns.push(h('button', { class: 'btn ghost', type: 'button', onclick: action(async () => {
          if (!(await confirmBox('Ish kunini yakunlaysizmi?'))) return;
          const x = await api('POST', '/api/att/checkout');
          toast(`Ish kuni yakunlandi${x.worked ? ` · ${dur(x.worked)}` : ''}`); router();
        }) }, '🏁 Ketdim'));
      }
      out.push(h('div', { class: 'card' },
        h('h2', null, 'Bugun'),
        h('div', { class: 'status-big' }, dot(a.status), label),
        h('p', { class: 'muted' }, times.join(' · ') || `Ish boshlanishi: ${me.workStart}`),
        a.lateNotice ? h('div', { class: 'chips' }, chip('⏰ kech qolishingizni bildirgansiz', 'amber')) : null,
        btns.length ? h('div', { class: 'btns' }, btns) : null));
    }

    const c = me.counts;
    const tile = (ic, label, hash, badge, soft = false) => h('button', { class: 'tile', type: 'button', onclick: () => go(hash) },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), h('span', { class: 'lb' }, label),
      badge ? h('span', { class: `badge ${soft ? 'soft' : ''}`.trim() }, String(badge)) : null);
    const tiles = [];
    if (me.employee) {
      tiles.push(tile('📋', 'Topshiriqlarim', '#/tasks', c.overdue || c.open, !c.overdue));
      tiles.push(tile('➕', "O'zimga vazifa", '#/self'));
    }
    if (r.isManager) {
      tiles.push(tile('📤', 'Topshiriq berish', '#/assign'));
      tiles.push(tile('🔎', 'Tekshiruv', '#/review', c.review));
      if (r.seeAll) tiles.push(tile('📋', 'Barcha topshiriqlar', '#/journal'));
      tiles.push(tile('👥', r.seeAll ? 'Hodimlar' : 'Jamoam', '#/people'));
    }
    if (r.seeAll || r.isViewer || r.isHead) tiles.push(tile('👁', 'Davomat', '#/att'));
    if (c.excuses !== undefined && (c.excuses || r.isManager)) tiles.push(tile('🙋', 'Sababli kunlar', '#/excuses', c.excuses));
    if (r.seeAll) tiles.push(tile('💰', 'KPI', `#/kpi/${curMonth()}`));
    if (r.isManager) tiles.push(tile('⭐', 'Baholash', `#/scores/${curMonth()}`));
    if (r.isAdmin) tiles.push(tile('🆕', "Hodim qo'shish", '#/new', c.requests));
    if (r.seeAll) tiles.push(tile('🏢', 'Tashkilot', '#/org'));
    if (me.employee && !me.roles.isBoss) tiles.push(tile('💵', 'Oylik va KPI', '#/pay'));
    if (r.isAdmin || (me.employee && !r.isHr)) tiles.push(tile('🔔', 'Eslatmalar', '#/reminders', c.reminders));
    if (r.isAdmin) tiles.push(tile('⚙️', 'Sozlamalar', '#/settings'));
    out.push(h('div', { class: 'tiles' }, tiles));
    if (!me.employee && r.isAdmin) out.push(h('p', { class: 'muted' }, "Siz direktor sifatida kirgansiz (hodim emas) — davomat va o'z topshiriqlaringiz yo'q."));
    mount(out);
  };

  // =========================================================================
  // TOPSHIRIQLARIM
  // =========================================================================
  const editTaskSheet = (t) => {
    const title = h('input', { class: 'input', maxlength: '500', value: t.title });
    const due = duePicker(t.due < today() ? today() : t.due);
    const prio = h('input', { type: 'checkbox', checked: t.priority === 'high' });
    openSheet('⚙️ Topshiriq',
      h('label', { class: 'field' }, h('span', null, 'Matn'), title), due.el,
      h('label', { class: 'check' }, prio, '🔥 Muhim'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn danger', type: 'button', onclick: action(async () => {
          if (!(await confirmBox("Topshiriq o'chirilsinmi?"))) return;
          await api('DELETE', `/api/tasks/${t.id}`); closeSheet(); toast("O'chirildi"); router();
        }) }, "🗑 O'chirish"),
        h('button', { class: 'btn', type: 'button', onclick: action(async () => {
          await api('PATCH', `/api/tasks/${t.id}`, { title: title.value, due: due.get(), priority: prio.checked ? 'high' : 'normal' });
          closeSheet(); toast('Saqlandi'); router();
        }) }, 'Saqlash')));
  };

  const doneTask = async (t) => {
    if (state.me && state.me.roles.isBoss && t.source === 'self') {
      if (!(await confirmBox(`«${t.title}» — bajarildi deb belgilansinmi? (isbot ixtiyoriy)`))) return;
      await api('POST', `/api/tasks/${t.id}/done`);
      toast('✅ Bajarildi');
      router();
      return;
    }
    if (!(await confirmBox(`«${t.title}» — isbot (rasm, video, audio yoki fayl) botga yuboriladi. Chatga o'tamizmi?`))) return;
    await api('POST', `/api/tasks/${t.id}/done`);
    toast('Chatda isbotni yuboring 📎');
    if (tg && INIT) setTimeout(() => tg.close(), 900);
  };

  const pageTasks = async (m, q) => {
    setTitle('📋 Topshiriqlarim');
    const data = await api('GET', '/api/tasks/my');
    const tab = q.get('tab') || 'open';
    const lists = { open: data.open, awaiting: data.awaiting, accepted: data.accepted };
    const items = lists[tab] || [];
    const tabs = seg([['open', `Ochiq (${data.open.length})`], ['awaiting', `Tekshiruvda (${data.awaiting.length})`], ['accepted', 'Qabul qilingan']], tab, (k) => go(`#/tasks?tab=${k}`));
    const list = items.map((t) => { const box = h('div', { class: 'media' }); return h('div', { class: 'item static' },
      h('div', { class: 'grow' },
        h('div', { class: 't' }, `${t.media ? `${MEDIA_ICON[t.media.type] || '📎'} ` : ''}${t.title}`), taskChips(t),
        t.reviewNote && t.status === 'active' ? h('p', { class: 'muted' }, `💬 Tekshiruvchi: «${t.reviewNote}»`) : null,
        box,
        t.media || t.needsAck ? h('div', { class: 'btns' },
          t.media ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => showMedia(box, `/api/tasks/${t.id}/media`, t.media.type, async () => { await api('POST', `/api/tasks/${t.id}/media/send`); toast('Chatga yuborildi'); }) }, `${MEDIA_ICON[t.media.type] || '📎'} Topshiriq`) : null,
          t.needsAck ? h('button', { class: 'btn ok small', type: 'button', onclick: action(async () => { await api('POST', `/api/tasks/${t.id}/ack`); toast('👂 Tushundim — belgilandi'); router(); }) }, '✅ Tushundim') : null) : null,
        t.status === 'active' ? h('div', { class: 'btns' },
          h('button', { class: 'btn small', type: 'button', onclick: action(() => doneTask(t)) }, '✔️ Bajardim'),
          t.source === 'self' ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => editTaskSheet(t) }, '⚙️ Tahrirlash') : null) : null)); });
    mount(tabs,
      items.length ? h('div', { class: 'list' }, list) : empty(tab === 'open' ? "🎉 Ochiq topshiriq yo'q" : "Bo'sh"),
      h('button', { class: 'btn ghost block', type: 'button', onclick: () => go('#/self') }, "➕ O'zimga vazifa"));
  };

  // =========================================================================
  // O'ZIMGA VAZIFA
  // =========================================================================
  const pageSelf = async () => {
    setTitle("➕ O'zimga vazifa", "Har qator — alohida vazifa");
    const ta = h('textarea', { class: 'input', maxlength: '5000', placeholder: "Masalan:\nHisobotni tayyorlash\n!Mijozga qo'ng'iroq" });
    const due = duePicker();
    const prio = h('input', { type: 'checkbox' });
    mount(h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', null, 'Vazifalar'), ta, h('div', { class: 'hint' }, "Boshiga ! qo'ysangiz — muhim.")),
      due.el, h('label', { class: 'check' }, prio, '🔥 Hammasi muhim'),
      h('button', { class: 'btn block', type: 'button', onclick: action(async () => {
        if (!ta.value.trim()) throw new Error("Vazifa matnini yozing");
        const r = await api('POST', '/api/tasks/self', { text: ta.value, due: due.get(), priority: prio.checked ? 'high' : null });
        toast(`${r.created.length} ta vazifa qo'shildi`); go('#/tasks');
      }) }, "Qo'shish")));
  };

  // =========================================================================
  // TOPSHIRIQ BERISH (bir nechta hodimga)
  // =========================================================================
  const pageAssign = async (m, q) => {
    setTitle('📤 Topshiriq berish', 'Bir yoki bir nechta hodimni belgilang');
    const data = await api('GET', '/api/assign/targets');
    const selected = new Set((q.get('e') || '').split(',').map(Number).filter((x) => data.people.some((p) => p.id === x)));
    let filter = 'all';
    let search = '';
    const filters = [['all', 'Hammasi']];
    data.heads.forEach((hd) => { if (hd.departmentId) filters.push([`h:${hd.id}`, `👥 ${firstName(hd.name)} jamoasi`]); });
    data.departments.forEach((d) => filters.push([`d:${d.id}`, `🏢 ${d.name}`]));
    data.directions.forEach((r) => filters.push([`r:${r.id}`, `${r.icon} ${r.name}`]));

    const visible = () => data.people.filter((p) => {
      if (search && !`${p.name} ${p.position || ''} ${p.title || ''}`.toLowerCase().includes(search)) return false;
      if (filter === 'all') return true;
      const [kind, raw] = filter.split(':');
      const fid = Number(raw);
      if (kind === 'd') return p.department && p.department.id === fid;
      if (kind === 'r') return p.directions.includes(fid);
      if (kind === 'h') { const hd = data.heads.find((x) => x.id === fid); return hd && p.department && p.department.id === hd.departmentId && p.id !== hd.id; }
      return true;
    });

    const listBox = h('div', { class: 'list' });
    const filterBox = h('div');
    const submit = h('button', { class: 'btn block', type: 'button' });
    const paintSubmit = () => { submit.textContent = selected.size ? `📤 Yuborish — ${selected.size} ta hodim` : 'Hodimni belgilang'; submit.disabled = !selected.size; };
    const paintList = () => {
      const vis = visible();
      const rows = vis.map((p) => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(p.id), 'aria-label': p.name });
        cb.addEventListener('change', () => { if (cb.checked) selected.add(p.id); else selected.delete(p.id); paintSubmit(); });
        return h('label', { class: 'pick' }, cb, dot(p.today), h('div', { class: 'grow' }, h('div', { class: 't' }, `${p.icon} ${p.name}`),
          h('div', { class: 's' }, [p.title, p.department && p.department.name].filter(Boolean).join(' · '))));
      });
      if (vis.length > 1) {
        const all = vis.every((p) => selected.has(p.id));
        rows.unshift(h('button', { class: 'item', type: 'button', onclick: () => { vis.forEach((p) => (all ? selected.delete(p.id) : selected.add(p.id))); paintList(); paintSubmit(); } },
          h('span', { class: 'grow muted' }, all ? '☑️ Belgilashni olib tashlash' : `☑️ Hammasini belgilash (${vis.length})`)));
      }
      listBox.replaceChildren(...(rows.length ? rows : [empty('Hech kim topilmadi')]));
    };
    const paintFilters = () => filterBox.replaceChildren(seg(filters, filter, (k) => { filter = k; paintFilters(); paintList(); }));

    const searchInput = h('input', { class: 'input', type: 'search', placeholder: '🔍 Ism yoki lavozim' });
    searchInput.addEventListener('input', () => { search = searchInput.value.trim().toLowerCase(); paintList(); });
    const ta = h('textarea', { class: 'input', maxlength: '5000', placeholder: "Topshiriq matni.\nBir nechta bo'lsa — har biri yangi qatorda." });
    const due = duePicker();
    const prio = h('input', { type: 'checkbox' });

    submit.addEventListener('click', action(async () => {
      if (!ta.value.trim()) throw new Error('Topshiriq matnini yozing');
      const r = await api('POST', '/api/tasks/assign', { employeeIds: [...selected], text: ta.value, due: due.get(), priority: prio.checked ? 'high' : null });
      haptic();
      setTitle('✅ Yuborildi');
      mount(h('div', { class: 'card' }, h('h2', null, `Muddat: ${relDate(r.due)}`),
        h('div', { class: 'list' }, r.results.map((x) => h('div', { class: 'item static' }, h('div', { class: 'grow t' }, x.name), h('div', { class: 'end' }, `${x.count} ta`)))),
        h('p', { class: 'muted' }, "Har bir hodimga botda xabar bordi."),
        h('div', { class: 'btns' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => go('#/') }, 'Bosh sahifa'),
          h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/assign'; router(); } }, 'Yana berish'))));
    }));

    paintFilters(); paintList(); paintSubmit();
    if (!data.people.length) return mount(empty("Sizga biriktirilgan hodim yo'q (bo'limingizda boshqa hodim yo'q)."));
    mount(
      data.people.length > 6 ? h('div', { class: 'field' }, searchInput) : null,
      filters.length > 1 ? filterBox : null,
      listBox,
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', null, 'Topshiriq'), ta, h('div', { class: 'hint' }, "Boshiga ! qo'ysangiz — muhim. Har bir belgilangan hodimga alohida beriladi.")),
        due.el, h('label', { class: 'check' }, prio, '🔥 Muhim')),
      h('div', { class: 'sticky-bar' }, submit));
  };

  // =========================================================================
  // TEKSHIRUV
  // =========================================================================
  const returnSheet = (t) => {
    const ta = h('textarea', { class: 'input', maxlength: '300', placeholder: "Nima uchun qaytaryapsiz? (hodim ko'radi)" });
    openSheet(`↩️ ${t.title}`, h('label', { class: 'field' }, ta),
      h('div', { class: 'btns' }, h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'Bekor'),
        h('button', { class: 'btn danger', type: 'button', onclick: action(async () => {
          await api('POST', `/api/tasks/${t.id}/return`, { note: ta.value.trim() || null }); closeSheet(); toast('Qaytarildi'); router();
        }) }, '↩️ Qaytarish')));
  };

  const pageReview = async () => {
    setTitle('🔎 Tekshiruv', '«Bajardim» deganlar');
    const { tasks } = await api('GET', '/api/review');
    if (!tasks.length) return mount(empty("Tekshiruvni kutayotgan ish yo'q ✅"));
    mount(h('div', { class: 'list' }, tasks.map((t) => {
      const box = h('div', { class: 'media' });
      const send = async () => { await api('POST', `/api/tasks/${t.id}/proof/send`); toast('Isbot chatga yuborildi'); };
      return h('div', { class: 'item static' }, h('div', { class: 'grow' },
        h('div', { class: 't' }, t.title),
        taskChips(t, { withName: true }),
        h('p', { class: 'muted' }, `Muddat: ${shortDate(t.due)} · bajarildi ${shortDate((t.doneAt || '').slice(0, 10))} ${clock(t.doneAt)}${t.lateDone ? ' — kech' : ''}`),
        t.proofNote ? h('p', null, `💬 «${t.proofNote}»`) : null,
        box,
        h('div', { class: 'btns' },
          t.hasProof ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => showMedia(box, `/api/tasks/${t.id}/proof`, t.proofType, send) }, "👁 Isbot") : h('span', { class: 'muted' }, "isbot yo'q"),
          h('button', { class: 'btn ok small', type: 'button', onclick: action(async () => {
            const r = await api('POST', `/api/tasks/${t.id}/accept`); toast(r.onTime ? 'Qabul qilindi ✅' : 'Qabul qilindi (muddatdan kech)'); router();
          }) }, '✅ Qabul'),
          h('button', { class: 'btn danger small', type: 'button', onclick: () => returnSheet(t) }, '↩️ Qaytarish'))));
    })));
  };

  // =========================================================================
  // JURNAL — barcha topshiriqlar (direktor va HR)
  // =========================================================================
  const J_PERIOD = [['d', 'Bugun'], ['w', '7 kun'], ['m', 'Shu oy'], ['p', "O'tgan oy"]];
  const J_GIVER = [['', 'Hammasi'], ['admin', 'Direktor'], ['hr', 'HR'], ['head', 'Rahbar'], ['self', "O'zi"]];
  const J_STATUS = [['', 'Hammasi'], ['open', '⏳ Ochiq'], ['review', '🕓 Tekshiruvda'], ['accepted', '✅ Bajarildi'], ['overdue', "🔴 O'tgan"], ['cancelled', '🚫 Bekor']];
  const J_KIND = { open: ['⏳ ochiq', ''], review: ['🕓 tekshiruvda', 'amber'], accepted: ['✅ bajarildi', 'green'], overdue: ["🔴 muddati o'tgan", 'red'], cancelled: ['🚫 bekor', ''] };
  const J_GIVER_LABEL = { admin: 'direktor', hr: 'HR', head: 'rahbar', self: "o'zi yozgan" };
  const pageJournal = async (m, q) => {
    const f = { period: q.get('period') || 'w', giver: q.get('giver') || '', status: q.get('status') || '', emp: q.get('emp') || '' };
    const qs = (x) => new URLSearchParams(Object.entries({ ...f, ...x }).filter(([, v]) => v)).toString();
    const d = await api('GET', `/api/tasks/all?${qs({})}`);
    setTitle('📋 Barcha topshiriqlar', `${shortDate(d.from)}${d.from !== d.to ? ` — ${shortDate(d.to)}` : ''} · jami ${d.total}`);
    const pick = (field) => (k) => go(`#/journal?${qs({ [field]: k })}`);
    const empSel = h('select', { class: 'input', onchange: (e) => go(`#/journal?${qs({ emp: e.target.value })}`) },
      h('option', { value: '' }, '👤 Hamma hodimlar'),
      d.employees.map((e) => h('option', { value: String(e.id), selected: String(e.id) === f.emp ? 'selected' : null }, e.name)));
    const c = d.counts;
    mount(
      seg(J_PERIOD, f.period, pick('period')),
      seg(J_GIVER, f.giver, pick('giver')),
      seg(J_STATUS, f.status, pick('status')),
      h('div', { class: 'card' }, empSel,
        h('p', { class: 'muted' }, `⏳ ${c.open} · 🕓 ${c.review} · ✅ ${c.accepted} · 🔴 ${c.overdue}${c.cancelled ? ` · 🚫 ${c.cancelled}` : ''}`)),
      d.tasks.length ? h('div', { class: 'list' }, d.tasks.map((t) => {
        const box = h('div', { class: 'media' });
        const send = async () => { await api('POST', `/api/tasks/${t.id}/proof/send`); toast('Isbot chatga yuborildi'); };
        const [kl, kc] = J_KIND[t.kind] || ['', ''];
        return h('div', { class: 'item static' }, h('div', { class: 'grow' },
          h('div', { class: 't' }, `${t.priority === 'high' ? '🔥 ' : ''}${t.media ? `${MEDIA_ICON[t.media.type] || '📎'} ` : ''}${t.title}`),
          h('div', { class: 'chips' },
            chip(`👤 ${t.employee.name}`), chip(kl, kc),
            chip(t.giverKind === 'self' ? "✍️ o'zi yozgan" : `bergan: ${t.giverName || '—'} (${J_GIVER_LABEL[t.giverKind] || t.giverKind})`),
            t.returned ? chip(`↩️ ${t.returned}`, 'amber') : null,
            t.giverKind !== 'self' && t.kind !== 'cancelled' ? (t.ackAt ? chip(`👂 tushundi · ${clock(t.ackAt)}`, 'green') : t.kind !== 'accepted' ? chip("👂 «tushundim» yo'q", 'amber') : null) : null),
          h('p', { class: 'muted' }, `Berilgan ${shortDate((t.createdAt || '').slice(0, 10))} ${clock(t.createdAt)} · muddat ${shortDate(t.due)}${t.doneAt ? ` · bajardi ${shortDate(t.doneAt.slice(0, 10))} ${clock(t.doneAt)}${t.lateDone ? ' (kech)' : ''}` : ''}`),
          t.proofNote ? h('p', null, `💬 «${t.proofNote}»`) : null,
          box,
          t.hasProof || t.media ? h('div', { class: 'btns' },
            t.media ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => showMedia(box, `/api/tasks/${t.id}/media`, t.media.type, async () => { await api('POST', `/api/tasks/${t.id}/media/send`); toast('Chatga yuborildi'); }) }, `${MEDIA_ICON[t.media.type] || '📎'} Topshiriq`) : null,
            t.hasProof ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => showMedia(box, `/api/tasks/${t.id}/proof`, t.proofType, send) }, '👁 Isbot') : null) : null));
      })) : empty("Bu filtr bo'yicha topshiriq yo'q"),
      d.total > d.tasks.length ? h('p', { class: 'muted' }, `Oxirgi ${d.tasks.length} tasi ko'rsatildi — davrni qisqartiring.`) : null,
    );
  };

  // =========================================================================
  // HODIMLAR
  // =========================================================================
  const pagePeople = async (m, q) => {
    const all = q.get('all') === '1';
    const data = await api('GET', `/api/employees${all ? '?all=1' : ''}`);
    const r = state.me ? state.me.roles : {};
    setTitle(r.seeAll ? '👥 Hodimlar' : '👥 Jamoam', `${data.employees.filter((e) => e.active).length} ta faol`);
    let dep = 'all';
    let search = '';
    const listBox = h('div', { class: 'list' });
    const paint = () => {
      const vis = data.employees.filter((e) => (dep === 'all' || (dep === 'none' ? !e.department : e.department && e.department.id === Number(dep)))
        && (!search || `${e.name} ${e.position || ''}`.toLowerCase().includes(search)));
      listBox.replaceChildren(...(vis.length ? vis.map((e) => h('button', { class: 'item', type: 'button', onclick: () => go(`#/emp/${e.id}`) },
        e.active ? dot(e.today) : h('span', { class: 'dot' }),
        h('div', { class: 'grow' }, h('div', { class: 't' }, `${e.icon} ${e.name}${e.active ? '' : ' ⛔'}`),
          h('div', { class: 's' }, [e.title, e.department && e.department.name].filter(Boolean).join(' · '))),
        e.active ? h('div', { class: 'end' }, `${e.attPct}%`, h('br'), e.openTasks ? `📋 ${e.openTasks}` : '') : null)) : [empty('Hech kim topilmadi')]));
    };
    const deps = [['all', 'Hammasi'], ...data.departments.map((d) => [String(d.id), d.name]), ['none', "Bo'limsiz"]];
    const segBox = h('div');
    const paintSeg = () => segBox.replaceChildren(seg(deps, dep, (k) => { dep = k; paintSeg(); paint(); }));
    const s = h('input', { class: 'input', type: 'search', placeholder: '🔍 Qidirish' });
    s.addEventListener('input', () => { search = s.value.trim().toLowerCase(); paint(); });
    paintSeg(); paint();
    mount(
      data.employees.length > 6 ? h('div', { class: 'field' }, s) : null,
      r.seeAll && data.departments.length ? segBox : null,
      listBox,
      h('p', { class: 'muted' }, "🟢 vaqtida · 🟡 kech · 🔴 kelmagan · 🔵 sababli · ⚪ hali vaqti emas. Foiz — shu oy davomati."),
      r.isAdmin ? h('div', { class: 'btns' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => go(all ? '#/people' : '#/people?all=1') }, all ? 'Faqat faollar' : 'Ishdan ketganlar ham'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('#/new') }, "➕ Hodim qo'shish")) : null);
  };

  const switchRow = (label, checked, onChange, hint = null) => {
    const cb = h('input', { type: 'checkbox', checked });
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try { await onChange(cb.checked); } catch (e) { cb.checked = !cb.checked; toast(e.message, true); } finally { cb.disabled = false; }
    });
    return h('label', { class: 'switch-row' }, h('div', null, h('div', null, label), hint ? h('div', { class: 'hint' }, hint) : null), cb);
  };

  const pageEmployee = async (m) => {
    const empId = Number(m[1]);
    const d = await api('GET', `/api/employees/${empId}`);
    const e = d.employee;
    const r = state.me ? state.me.roles : {};
    setTitle(`${e.icon} ${e.name}`, [e.title, e.department && e.department.name].filter(Boolean).join(' · '));
    const out = [];
    const t = d.today;
    const times = [t.checkedIn ? `keldi ${clock(t.checkedIn)}` : null, t.checkedOut ? `ketdi ${clock(t.checkedOut)}` : null, t.status === 'late' ? `${dur(t.lateMinutes)} kech` : null].filter(Boolean);
    out.push(h('div', { class: 'card' },
      h('div', { class: 'status-big' }, dot(t.status), (DAY[t.status] || DAY.future)[0]),
      h('p', { class: 'muted' }, times.join(' · ') || 'Bugun'),
      t.lateReason ? h('p', null, `⏰ «${t.lateReason}»`) : null,
      h('div', { class: 'chips' },
        chip(e.workMode === 'field' ? '🚶 Hudud (agent)' : '🏢 Ofis'), e.branch ? chip(`🏙 ${e.branch.name}`) : null,
        e.isHr ? chip('🧑‍💼 HR') : null, e.isViewer ? chip('👁 Davomat nazorati') : null, e.flexible ? chip('🕊 Erkin jadval') : null,
        e.workStart ? chip(`🕘 ${e.workStart}`) : null, e.active ? null : chip('⛔ ishdan ketgan', 'red')),
      h('div', { class: 'btns' },
        d.can.assign ? h('button', { class: 'btn', type: 'button', onclick: () => go(`#/assign?e=${e.id}`) }, '📤 Topshiriq berish') : null,
        e.username ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { const u = `https://t.me/${encodeURIComponent(e.username)}`; if (tg && tg.openTelegramLink) tg.openTelegramLink(u); else window.open(u, '_blank', 'noopener'); } }, '💬 Lichka') : null,
        r.seeAll ? h('button', { class: 'btn ghost', type: 'button', onclick: () => go(`#/kpi/${d.month}/${e.id}`) }, '💰 KPI') : null)));

    out.push(h('div', { class: 'card' }, h('h2', null, d.monthName),
      h('div', null, `📋 Topshiriq: ${d.tasksStats.ontime}/${d.tasksStats.total} muddatida — ${d.tasksStats.pct}%`), bar(d.tasksStats.pct),
      h('p', { class: 'muted' }, `ochiq ${d.tasksStats.open}${d.tasksStats.overdue ? ` · 🔴 muddati o'tgan ${d.tasksStats.overdue}` : ''}${d.tasksStats.returns ? ` · ↩️ ${d.tasksStats.returns}` : ''}`),
      h('div', null, `🕘 Davomat: ${d.attStats.ontime}/${d.attStats.workDays} vaqtida — ${d.attStats.pct}%`), bar(d.attStats.pct),
      h('p', { class: 'muted' }, `kech ${d.attStats.late} · kelmagan ${d.attStats.absent} · sababli ${d.attStats.excused}`),
      e.salary !== undefined ? h('div', { class: 'kv' }, h('div', { class: 'k' }, '💵 Oklad'), h('div', { class: 'v' }, money(e.salary)), h('div', { class: 'k' }, '🏆 KPI summasi'), h('div', { class: 'v' }, money(e.bonusFund))) : null));

    const tasksAll = [...d.open, ...d.awaiting];
    out.push(section(`Topshiriqlari (${tasksAll.length})`));
    out.push(tasksAll.length ? h('div', { class: 'list' }, tasksAll.map((x) => h('div', { class: 'item static' }, h('div', { class: 'grow' }, h('div', { class: 't' }, x.title), taskChips(x),
      d.can.assign && x.status === 'active' && (r.isAdmin || x.source !== 'self') ? h('div', { class: 'btns end' }, h('button', { class: 'btn danger small', type: 'button', onclick: action(async () => {
        if (!(await confirmBox(`«${x.title}» bekor qilinsinmi? Hodimga xabar boradi.`))) return;
        await api('DELETE', `/api/tasks/${x.id}`); toast('Bekor qilindi'); router();
      }) }, '🗑 Bekor qilish')) : null)))) : empty("Ochiq topshiriq yo'q"));

    if (d.can.directions) {
      const org = await api('GET', '/api/org');
      const mine = new Set(d.directions.map((x) => x.id));
      out.push(section("Yo'nalishlari"));
      out.push(h('div', { class: 'card' }, org.directions.length ? org.directions.map((x) => switchRow(`${x.icon} ${x.name}`, mine.has(x.id), async () => { await api('POST', `/api/employees/${e.id}/directions/${x.id}`); toast('Saqlandi'); })) : h('p', { class: 'muted' }, "Yo'nalish yo'q")));
      if (!d.can.edit) {
        out.push(h('div', { class: 'card' }, switchRow('👁 Davomat nazorati', e.isViewer, async (on) => { await api('PATCH', `/api/employees/${e.id}`, { isViewer: on }); toast('Saqlandi'); },
          "Hamma hodimning kelgan-ketgani, davomat % va KPI % (pulsiz). Topshiriqlarni ko'rmaydi.")));
      }
      if (d.can.edit) out.push(await editCard(e, org));
    }
    mount(out);
  };

  /** Direktor: kartochka formasi (faqat o'zgargan maydonlar yuboriladi) */
  const editCard = async (e, org) => {
    const f = {
      name: h('input', { class: 'input', maxlength: '100', value: e.name }),
      position: h('input', { class: 'input', maxlength: '60', value: e.position || '' }),
      department: h('select', { class: 'input' }, h('option', { value: '' }, "— Bo'limsiz"), org.departments.map((x) => h('option', { value: String(x.id) }, x.name))),
      branch: h('select', { class: 'input' }, h('option', { value: '' }, 'Asosiy ofis'), org.branches.map((x) => h('option', { value: String(x.id) }, x.name))),
      role: h('select', { class: 'input' }, h('option', { value: 'employee' }, '👤 Hodim'), h('option', { value: 'head' }, '🎖 Rahbar'), h('option', { value: 'admin' }, '👑 Direktor')),
      workMode: h('select', { class: 'input' }, h('option', { value: 'office' }, '🏢 Ofis (geofence + video)'), h('option', { value: 'field' }, '🚶 Hudud / agent (uydan 1 km+)')),
      salary: h('input', { class: 'input', type: 'number', min: '0', step: '10000', inputmode: 'numeric', value: e.salary === null ? '' : String(e.salary) }),
      bonusFund: h('input', { class: 'input', type: 'number', min: '0', step: '10000', inputmode: 'numeric', value: e.bonusFund === null ? '' : String(e.bonusFund) }),
      workStart: h('input', { class: 'input', type: 'time', value: e.workStart || '' }),
      isHr: h('input', { type: 'checkbox', checked: e.isHr }),
      isViewer: h('input', { type: 'checkbox', checked: e.isViewer }),
      flexible: h('input', { type: 'checkbox', checked: e.flexible }),
      videoRequired: h('input', { type: 'checkbox', checked: e.videoRequired }),
      active: h('input', { type: 'checkbox', checked: e.active }),
    };
    f.department.value = e.department ? String(e.department.id) : '';
    f.branch.value = e.branch ? String(e.branch.id) : '';
    f.role.value = e.role;
    f.workMode.value = e.workMode;
    const sw = (label, input, hint) => h('label', { class: 'switch-row' }, h('div', null, h('div', null, label), hint ? h('div', { class: 'hint' }, hint) : null), input);
    const fld = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
    const numOrNull = (v) => (v === '' ? null : Number(v));

    const save = h('button', { class: 'btn block', type: 'button', onclick: action(async () => {
      const patch = {};
      const set = (k, v, old) => { if (v !== old) patch[k] = v; };
      set('name', f.name.value.trim(), e.name);
      set('position', f.position.value.trim(), e.position || '');
      set('departmentId', f.department.value ? Number(f.department.value) : null, e.department ? e.department.id : null);
      set('branchId', f.branch.value ? Number(f.branch.value) : null, e.branch ? e.branch.id : null);
      set('role', f.role.value, e.role);
      set('workMode', f.workMode.value, e.workMode);
      set('salary', numOrNull(f.salary.value), e.salary);
      set('bonusFund', numOrNull(f.bonusFund.value), e.bonusFund);
      set('workStart', f.workStart.value || null, e.workStart);
      set('isHr', f.isHr.checked, e.isHr);
      set('isViewer', f.isViewer.checked, e.isViewer);
      set('flexible', f.flexible.checked, e.flexible);
      set('videoRequired', f.videoRequired.checked, e.videoRequired);
      set('active', f.active.checked, e.active);
      if (!Object.keys(patch).length) { toast("O'zgarish yo'q"); return; }
      if (patch.active === false && !(await confirmBox(`${e.name} — ishdan ketdi deb belgilansinmi?`))) return;
      await api('PATCH', `/api/employees/${e.id}`, patch);
      toast('Saqlandi'); router();
    }) }, '💾 Saqlash');

    const exDate = h('input', { class: 'input', type: 'date', value: today() });
    const exReason = h('input', { class: 'input', maxlength: '300', placeholder: "Ta'til, kasal, komandirovka…" });

    return h('div', null,
      section('Kartochka (direktor)'),
      h('div', { class: 'card' },
        fld('Ism-familiya', f.name), fld('Lavozim', f.position), fld("Bo'lim (rahbar jamoasi)", f.department), fld('Rol', f.role),
        fld('Filial', f.branch), fld('Ish turi', f.workMode),
        fld("💵 Oklad (so'm)", f.salary), fld("🏆 KPI summasi (so'm)", f.bonusFund, "Oy davomida vaqtida kelib, topshiriqlarni muddatida bajarsa — to'liq, aks holda 0."),
        fld('🕘 Alohida ish boshlanishi', f.workStart, "Bo'sh — umumiy vaqt."),
        sw('🧑‍💼 HR', f.isHr, "Hamma narsani ko'radi, kelmaslik xabarlarini oladi"),
        sw('👁 Davomat nazorati', f.isViewer, 'Kelgan-ketgan, davomat % va KPI % (topshiriqlarsiz)'),
        sw('🕊 Erkin jadval', f.flexible, 'Kechikish va masofadan ozod'),
        sw('🎥 Hududda video majburiy', f.videoRequired, 'Faqat hudud (agent) uchun'),
        sw('✅ Faol (ishlayapti)', f.active),
        save,
        h('p', { class: 'hint' }, "Rol, HR, ish turi o'zgarsa hodimga botda xabar boradi.")),
      section('Sababli kun belgilash'),
      h('div', { class: 'card' }, fld('Sana', exDate), fld('Sabab', exReason),
        h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => {
          await api('POST', `/api/employees/${e.id}/excuse`, { date: exDate.value, reason: exReason.value.trim() || null }); toast('Sababli deb belgilandi'); router();
        }) }, '📄 Sababli deb belgilash')),
      e.workMode === 'field' && e.homeSet ? h('button', { class: 'btn danger block', type: 'button', onclick: action(async () => {
        if (!(await confirmBox('Uy joylashuvi tozalansinmi? Keyingi «Keldim» da hodim qayta belgilaydi.'))) return;
        await api('POST', `/api/employees/${e.id}/clear-home`); toast('Tozalandi'); router();
      }) }, '🏠 Uy joyini tozalash') : null);
  };

  // =========================================================================
  // YANGI HODIM + SO'ROVLAR
  // =========================================================================
  const pageNew = async () => {
    setTitle("🆕 Hodim qo'shish");
    const [reqs, org] = await Promise.all([api('GET', '/api/requests'), api('GET', '/api/org')]);
    const f = {
      tgId: h('input', { class: 'input', inputmode: 'numeric', maxlength: '15', placeholder: '123456789' }),
      name: h('input', { class: 'input', maxlength: '100' }),
      position: h('input', { class: 'input', maxlength: '60' }),
      dep: h('select', { class: 'input' }, h('option', { value: '' }, "— Bo'limsiz"), org.departments.map((x) => h('option', { value: String(x.id) }, x.name))),
      role: h('select', { class: 'input' }, h('option', { value: 'employee' }, '👤 Hodim'), h('option', { value: 'head' }, "🎖 Rahbar (o'z bo'limi)"), h('option', { value: 'hr' }, "🧑‍💼 HR (hamma narsani ko'radi)"), h('option', { value: 'admin' }, '👑 Direktor')),
    };
    const fld = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
    const form = h('div', { class: 'card' },
      fld('Telegram ID', f.tgId, "Hodim botga /start bossa — ID si o'ziga ko'rinadi va pastda so'rov paydo bo'ladi."),
      fld('Ism-familiya', f.name), fld('Lavozim', f.position), fld("Bo'lim", f.dep), fld('Rol', f.role),
      h('button', { class: 'btn block', type: 'button', onclick: action(async () => {
        const r = await api('POST', '/api/employees', { tgId: Number(f.tgId.value.trim()), fullName: f.name.value.trim(), position: f.position.value.trim() || null, departmentId: f.dep.value ? Number(f.dep.value) : null, role: f.role.value });
        toast(`${r.employee.name} qo'shildi`); go(`#/emp/${r.employee.id}`);
      }) }, "✅ Qo'shish"));
    mount(
      reqs.requests.length ? [section(`Kutilayotgan so'rovlar (${reqs.requests.length})`), h('div', { class: 'list' }, reqs.requests.map((x) => h('div', { class: 'item static' },
        h('div', { class: 'grow' }, h('div', { class: 't' }, x.name), h('div', { class: 's' }, `ID ${x.tgId}${x.username ? ` · @${x.username}` : ''}`)),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: () => { f.tgId.value = String(x.tgId); f.name.value = x.name; f.name.focus(); toast("Lavozim, bo'lim va rolni tanlang"); } }, "➕"),
          h('button', { class: 'btn danger small', type: 'button', onclick: action(async () => {
            if (!(await confirmBox(`${x.name} — rad etilsinmi?`))) return;
            await api('POST', `/api/requests/${x.id}/reject`); toast('Rad etildi'); router();
          }) }, '🚫')))))] : null,
      section('Yangi hodim'), form);
  };

  // =========================================================================
  // TASHKILOT (bo'limlar, filiallar, yo'nalishlar)
  // =========================================================================
  const nameSheet = (title, value, onSave, extra = null) => {
    const inp = h('input', { class: 'input', maxlength: '60', value: value || '' });
    openSheet(title, h('label', { class: 'field' }, inp), extra, h('div', { class: 'btns' },
      h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'Bekor'),
      h('button', { class: 'btn', type: 'button', onclick: action(async () => { await onSave(inp.value.trim()); closeSheet(); toast('Saqlandi'); router(); }) }, 'Saqlash')));
  };

  const deptSheet = (d) => {
    const name = h('input', { class: 'input', maxlength: '60', value: d.name });
    const custom = h('input', { class: 'input', maxlength: '60', value: d.customName || '', placeholder: "Masalan: Sotuv rejasi" });
    const w = ['tasks', 'att', 'head', 'custom'].map((k) => h('input', { class: 'input', type: 'number', min: '0', max: '100', step: '5', inputmode: 'numeric', value: String(d.weights[k]) }));
    const labels = ['📋 Topshiriq', '🕘 Davomat', '⭐ Rahbar bahosi', '🎯 Mezon'];
    openSheet(`🏢 ${d.name}`,
      h('label', { class: 'field' }, h('span', null, 'Nomi'), name),
      h('label', { class: 'field' }, h('span', null, "🎯 Bo'limga xos mezon nomi"), custom),
      h('div', { class: 'section-title' }, "KPI vaznlari (yig'indi 100)"),
      h('div', { class: 'kv' }, w.map((inp, i) => [h('div', { class: 'k' }, labels[i]), inp])),
      h('div', { class: 'btns' },
        h('button', { class: 'btn danger', type: 'button', onclick: action(async () => {
          if (!(await confirmBox(`«${d.name}» yopilsinmi? Hodimlar bo'limsiz qoladi.`))) return;
          await api('DELETE', `/api/departments/${d.id}`); closeSheet(); toast('Yopildi'); router();
        }) }, '🗑 Yopish'),
        h('button', { class: 'btn', type: 'button', onclick: action(async () => {
          await api('PATCH', `/api/departments/${d.id}`, { name: name.value.trim(), customName: custom.value.trim() || null, weights: w.map((x) => Number(x.value)) });
          closeSheet(); toast('Saqlandi'); router();
        }) }, 'Saqlash')));
  };

  const branchSheet = (b) => {
    const name = h('input', { class: 'input', maxlength: '60', value: b.name });
    const radius = h('input', { class: 'input', type: 'number', min: '30', max: '5000', step: '10', value: b.radius ? String(b.radius) : '300' });
    openSheet(`🏙 ${b.name}`, h('label', { class: 'field' }, h('span', null, 'Nomi'), name),
      h('label', { class: 'field' }, h('span', null, 'Ofis radiusi (metr)'), radius),
      h('p', { class: 'hint' }, "Ofis nuqtasini belgilash — botda: Panel → 🏙 Filiallar → 📍 Ofis nuqtasi (ofisda turib)."),
      h('div', { class: 'btns' },
        h('button', { class: 'btn danger', type: 'button', onclick: action(async () => {
          if (!(await confirmBox(`«${b.name}» yopilsinmi? Hodimlari asosiy ofisga o'tadi.`))) return;
          await api('DELETE', `/api/branches/${b.id}`); closeSheet(); toast('Yopildi'); router();
        }) }, '🗑 Yopish'),
        h('button', { class: 'btn', type: 'button', onclick: action(async () => {
          await api('PATCH', `/api/branches/${b.id}`, { name: name.value.trim(), radius: Number(radius.value) }); closeSheet(); toast('Saqlandi'); router();
        }) }, 'Saqlash')));
  };

  const pageOrg = async () => {
    setTitle('🏢 Tashkilot', "Bo'limlar, filiallar, yo'nalishlar");
    const d = await api('GET', '/api/org');
    const edit = d.canEdit;
    mount(
      section("Bo'limlar (rahbar jamoasi)"),
      h('div', { class: 'list' }, d.departments.length ? d.departments.map((x) => h('button', { class: 'item', type: 'button', onclick: edit ? () => deptSheet(x) : null, disabled: !edit },
        h('div', { class: 'grow' }, h('div', { class: 't' }, `🏢 ${x.name}`),
          h('div', { class: 's' }, `${x.members} hodim · ${x.heads.length ? `rahbar: ${x.heads.join(', ')}` : "rahbar yo'q"}`),
          h('div', { class: 's' }, `KPI: topshiriq ${x.weights.tasks}% · davomat ${x.weights.att}% · baho ${x.weights.head}% · ${x.customName || 'mezon'} ${x.weights.custom}%`)),
        edit ? h('span', { class: 'chev' }, '›') : null)) : empty("Bo'lim yo'q")),
      edit ? h('button', { class: 'btn ghost block', type: 'button', onclick: () => nameSheet("➕ Yangi bo'lim", '', (v) => api('POST', '/api/departments', { name: v })) }, "➕ Yangi bo'lim") : null,

      section('Filiallar'),
      h('div', { class: 'list' },
        h('div', { class: 'item static' }, h('div', { class: 'grow' }, h('div', { class: 't' }, '🏢 Asosiy ofis'), h('div', { class: 's' }, d.office ? `radius ${d.office.radius} m` : "nuqta belgilanmagan — botda /ofis"))),
        d.branches.map((x) => h('button', { class: 'item', type: 'button', onclick: edit ? () => branchSheet(x) : null, disabled: !edit },
          h('div', { class: 'grow' }, h('div', { class: 't' }, `🏙 ${x.name}`), h('div', { class: 's' }, `${x.members} hodim · ${x.officeSet ? `radius ${x.radius} m` : "ofis nuqtasi yo'q"}`)),
          edit ? h('span', { class: 'chev' }, '›') : null))),
      edit ? h('button', { class: 'btn ghost block', type: 'button', onclick: () => nameSheet('➕ Yangi filial', '', (v) => api('POST', '/api/branches', { name: v })) }, '➕ Yangi filial') : null,

      section("Yo'nalishlar (kim nimaga mas'ul)"),
      h('div', { class: 'list' }, d.directions.map((x) => h('div', { class: 'item static' },
        h('div', { class: 'grow' }, h('div', { class: 't' }, `${x.icon} ${x.name}`), h('div', { class: 's' }, x.members.map((p) => p.name).join(', ') || "mas'ul yo'q")),
        edit ? h('div', { class: 'row' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => nameSheet("✏️ Yo'nalish nomi", x.name, (v) => api('PATCH', `/api/directions/${x.id}`, { name: v })) }, '✏️'),
          h('button', { class: 'btn danger small', type: 'button', onclick: action(async () => {
            if (!(await confirmBox(`«${x.name}» o'chirilsinmi?`))) return;
            await api('DELETE', `/api/directions/${x.id}`); toast("O'chirildi"); router();
          }) }, '🗑')) : null))),
      edit ? h('button', { class: 'btn ghost block', type: 'button', onclick: () => nameSheet("➕ Yangi yo'nalish", '', (v) => api('POST', '/api/directions', { name: v })) }, "➕ Yangi yo'nalish") : null,
      h('p', { class: 'muted' }, "Hodimni yo'nalishga biriktirish — hodim kartochkasida."));
  };

  // =========================================================================
  // KPI
  // =========================================================================
  const monthSeg = (month, base, back = 2) => {
    const cur = curMonth();
    const items = [];
    for (let i = back; i >= 0; i -= 1) { const mm = shiftMonth(cur, -i); items.push([mm, `${monthLabel(mm)}${i === 0 ? ' (joriy)' : ''}`]); }
    return seg(items, month, (k) => go(`${base}/${k}`));
  };
  const STATUS = { draft: ['⏳', 'Kutmoqda'], confirmed: ['✅', 'Tasdiqlangan'], excluded: ['⛔', 'Chiqarilgan'] };

  const pageKpi = async (m) => {
    const month = m[1] || curMonth();
    const d = await api('GET', `/api/kpi/${month}`);
    setTitle('💰 KPI', d.monthName);
    let confirmed = 0;
    let bonusSum = 0;
    for (const k of d.rows) if (k.status === 'confirmed') { confirmed += 1; bonusSum += k.bonus || 0; }
    mount(monthSeg(month, '#/kpi'),
      h('div', { class: 'card' }, h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Hodimlar'), h('div', { class: 'v' }, String(d.rows.length)),
        h('div', { class: 'k' }, '✅ Tasdiqlangan'), h('div', { class: 'v' }, String(confirmed)),
        h('div', { class: 'k' }, 'Tasdiqlangan KPI jami'), h('div', { class: 'v' }, money(bonusSum))),
        d.current ? h('p', { class: 'hint' }, "Joriy oy — natijalar taxminiy, oy yakunida tasdiqlanadi.") : null),
      h('div', { class: 'list' }, d.rows.length ? d.rows.map((k) => h('button', { class: 'item', type: 'button', onclick: () => go(`#/kpi/${month}/${k.employeeId}`) },
        h('span', null, STATUS[k.status][0]),
        h('div', { class: 'grow' }, h('div', { class: 't' }, k.name), h('div', { class: 's' }, [k.department, `📋 ${k.tasks.pct}% · 🕘 ${k.att.pct}%`].filter(Boolean).join(' · ')),
          d.kpiMode === 'gate' ? h('div', { class: 'chips' }, k.eligible ? chip('🟢 shart bajarilgan', 'green') : chip('🔴 shart bajarilmagan', 'red')) : null),
        h('div', { class: 'end' }, h('b', null, `${k.total}`), ' ball', h('br'), money(k.bonus)))) : [empty("Hodim yo'q")]),
      h('div', { class: 'btns' },
        h('button', { class: 'btn ghost', type: 'button', onclick: action(async () => { await api('POST', `/api/kpi/${month}/excel`); toast('Excel chatga yuborildi 📥'); }) }, '📥 Excel (chatga)'),
        d.canEdit && d.rows.some((k) => k.status === 'draft') ? h('button', { class: 'btn', type: 'button', onclick: action(async () => {
          if (!(await confirmBox(`${d.monthName} — kutilayotgan barcha natijalar tasdiqlansinmi? Har bir hodimga xabar boradi.`))) return;
          const r = await api('POST', `/api/kpi/${month}/confirm-all`); toast(`${r.confirmed} ta tasdiqlandi`); router();
        }) }, '✅ Hammasini tasdiqlash') : null));
  };

  const scorePicker = (value, onPick) => h('div', { class: 'score' }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
    h('button', { type: 'button', class: n === value ? 'on' : '', onclick: action(() => onPick(n)) }, String(n))));

  const pageKpiCard = async (m) => {
    const [month, empId] = [m[1], Number(m[2])];
    const d = await api('GET', `/api/kpi/${month}/${empId}`);
    const k = d.kpi;
    setTitle(`💰 ${k.name}`, d.monthName);
    const line = (label, pct, w) => [h('div', { class: 'k' }, `${label} × ${w}%`), h('div', { class: 'v' }, pct === null ? '—' : `${pct}%`)];
    const editable = d.canEdit && k.status === 'draft';
    const out = [
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', { class: 'big' }, `${k.total} ball`), chip(`${STATUS[k.status][0]} ${STATUS[k.status][1]}`)), bar(k.total),
        h('div', { class: 'kv' },
          line(`📋 Topshiriq (${k.tasks.ontime}/${k.tasks.total})`, k.tasks.pct, k.weights.tasks),
          line(`🕘 Davomat (${k.att.ontime}/${k.att.workDays})`, k.att.pct, k.weights.att),
          line('⭐ Rahbar bahosi', k.headScore === null ? null : k.headScore * 10, k.weights.head),
          line(`🎯 ${k.customName || 'Mezon'}`, k.customPct, k.weights.custom)),
        h('p', { class: 'muted' }, `kech ${k.att.late} · kelmagan ${k.att.absent} · sababli ${k.att.excused} · muddatida bajarilmagan ${k.tasks.missed}${k.tasks.returned ? ` · ↩️ ${k.tasks.returned} (−${k.tasks.returned * d.returnPenalty}%)` : ''}`),
        k.headNote ? h('p', null, `⭐ «${k.headNote}»`) : null),
      h('div', { class: 'card' },
        h('div', null, k.eligible ? chip('🟢 KPI sharti bajarildi', 'green') : chip(`🔴 bajarilmadi: ${k.fail || ''}`, 'red')),
        h('div', { class: 'kv' },
          h('div', { class: 'k' }, '🏆 KPI summasi'), h('div', { class: 'v' }, money(k.bonusFund)),
          h('div', { class: 'k' }, 'Beriladi'), h('div', { class: 'v' }, money(k.bonus)),
          h('div', { class: 'k' }, '💼 Oklad'), h('div', { class: 'v' }, money(k.salary)),
          h('div', { class: 'k' }, '💰 Jami'), h('div', { class: 'v' }, money((k.salary || 0) + (k.status === 'excluded' ? 0 : k.bonus || 0)))),
        k.note ? h('p', null, `💬 ${k.note}`) : null),
    ];
    if (editable) {
      const custom = h('input', { class: 'input', type: 'number', min: '0', max: '100', value: k.customPct === null ? '' : String(k.customPct) });
      const fund = h('input', { class: 'input', type: 'number', min: '0', step: '10000', value: k.bonusFund === null ? '' : String(k.bonusFund) });
      const note = h('input', { class: 'input', maxlength: '500', value: k.note || '', placeholder: "Hodim tasdiqlashda ko'radi" });
      out.push(section('Tahrirlash'), h('div', { class: 'card' },
        h('div', { class: 'field' }, h('span', null, '⭐ Rahbar bahosi (1–10)'), scorePicker(k.headScore, async (n) => { await api('PATCH', `/api/kpi/${month}/${empId}`, { headScore: n }); toast(`⭐ ${n}/10`); router(); })),
        h('label', { class: 'field' }, h('span', null, `🎯 ${k.customName || "Qo'shimcha mezon"} (%)`), custom),
        h('label', { class: 'field' }, h('span', null, "🏆 Shu oy KPI summasi (so'm)"), fund),
        h('label', { class: 'field' }, h('span', null, '💬 Izoh'), note),
        h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => {
          await api('PATCH', `/api/kpi/${month}/${empId}`, { customPct: custom.value === '' ? null : Number(custom.value), bonusFund: fund.value === '' ? null : Number(fund.value), note: note.value.trim() || null });
          toast('Saqlandi'); router();
        }) }, '💾 Saqlash')));
    }
    if (d.canEdit) {
      out.push(h('div', { class: 'btns' },
        k.status === 'draft' ? [
          h('button', { class: 'btn ok', type: 'button', onclick: action(async () => {
            if (!(await confirmBox(`${k.name} — natija tasdiqlansinmi? Hodimga xabar boradi.`))) return;
            await api('POST', `/api/kpi/${month}/${empId}/decide`, { status: 'confirmed' }); toast('Tasdiqlandi ✅'); router();
          }) }, '✅ Tasdiqlash'),
          h('button', { class: 'btn danger', type: 'button', onclick: () => {
            const ta = h('textarea', { class: 'input', maxlength: '500', placeholder: "Sabab (hodim ko'radi)" });
            openSheet('⛔ Bonusdan chiqarish', h('label', { class: 'field' }, ta), h('div', { class: 'btns' },
              h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'Bekor'),
              h('button', { class: 'btn danger', type: 'button', onclick: action(async () => {
                await api('POST', `/api/kpi/${month}/${empId}/decide`, { status: 'excluded', note: ta.value.trim() || null }); closeSheet(); toast('Chiqarildi'); router();
              }) }, '⛔ Chiqarish')));
          } }, '⛔ Chiqarish'),
        ] : h('button', { class: 'btn ghost', type: 'button', onclick: action(async () => {
          await api('POST', `/api/kpi/${month}/${empId}/decide`, { status: 'draft' }); toast('Qayta ochildi'); router();
        }) }, '↩️ Qaytadan ochish')));
    } else out.push(h('p', { class: 'muted' }, "👁 Faqat ko'rish — tahrirlash va tasdiqlash direktorda."));
    mount(out);
  };

  // --- rahbar baholashi ---
  const pageScores = async (m) => {
    const month = m[1] || curMonth();
    const d = await api('GET', `/api/scores/${month}`);
    setTitle('⭐ Baholash', `${d.monthName} · rahbar bahosi 1–10`);
    mount(monthSeg(month, '#/scores', 1),
      d.rows.length ? h('div', { class: 'list' }, d.rows.map((x) => {
        const note = h('input', { class: 'input', maxlength: '300', value: x.headNote || '', placeholder: 'Izoh (ixtiyoriy)' });
        const locked = x.status !== 'draft';
        return h('div', { class: 'item static' }, h('div', { class: 'grow' },
          h('div', { class: 'row between' }, h('div', { class: 't' }, x.name), h('span', { class: 'muted' }, x.headScore === null ? 'baholanmagan' : `⭐ ${x.headScore}/10`)),
          h('div', { class: 's' }, `📋 topshiriq ${x.tasksPct}% · 🕘 davomat ${x.attPct}%`),
          locked ? h('p', { class: 'muted' }, '✅ Natija tasdiqlangan') : [
            scorePicker(x.headScore, async (n) => { await api('POST', `/api/scores/${month}/${x.employeeId}`, { score: n, note: note.value.trim() || null }); toast(`⭐ ${x.name}: ${n}/10`); router(); }),
            h('div', { class: 'field' }, note)]));
      })) : empty("Baholanadigan hodim yo'q"),
      h('p', { class: 'muted' }, "Baho KPI ning «rahbar bahosi» qismi. Izohni yozib, keyin bahoni bosing."));
  };

  // =========================================================================
  // DAVOMAT
  // =========================================================================
  const pageAtt = async (m, q) => {
    const tab = q.get('tab') || 'today';
    const r = state.me ? state.me.roles : {};
    if (tab === 'month') {
      const month = q.get('m') || curMonth();
      const d = await api('GET', `/api/att/month/${month}`);
      setTitle('👁 Davomat', `${d.monthName} · davomat % va KPI %`);
      const items = [];
      for (let i = 2; i >= 0; i -= 1) { const mm = shiftMonth(curMonth(), -i); items.push([mm, monthLabel(mm)]); }
      return mount(seg([['today', 'Bugun'], ['month', 'Oy']], tab, (k) => go(`#/att?tab=${k}`)),
        seg(items, month, (k) => go(`#/att?tab=month&m=${k}`)),
        h('div', { class: 'list' }, d.rows.map((x, i) => h('div', { class: 'item static' }, h('div', { class: 'grow' },
          h('div', { class: 'row between' }, h('div', { class: 't' }, `${i + 1}. ${x.name}`), h('b', null, `${x.pct}%`)), bar(x.pct),
          h('div', { class: 's' }, `vaqtida ${x.ontime}/${x.workDays}${x.late ? ` · kech ${x.late}` : ''}${x.absent ? ` · kelmagan ${x.absent}` : ''}${x.excused ? ` · sababli ${x.excused}` : ''} · 🏆 KPI ${x.kpi}%`))))));
    }
    const d = await api('GET', '/api/att/today');
    const cnt = { ontime: 0, late: 0, absent: 0 };
    d.rows.forEach((x) => { if (cnt[x.status] !== undefined) cnt[x.status] += 1; });
    setTitle('👁 Davomat', d.datePretty);
    mount(seg([['today', 'Bugun'], ['month', 'Oy']], tab, (k) => go(`#/att?tab=${k}`)),
      h('div', { class: 'card' }, h('div', { class: 'row wrap' }, chip(`🟢 vaqtida ${cnt.ontime}`, 'green'), chip(`🟡 kech ${cnt.late}`, 'amber'), chip(`🔴 kelmagan ${cnt.absent}`, 'red'))),
      h('div', { class: 'list' }, d.rows.map((x) => {
        const box = h('div', { class: 'media' });
        return h('div', { class: 'item static' }, dot(x.status), h('div', { class: 'grow' },
          h('div', { class: 't' }, x.name),
          h('div', { class: 's' }, [(DAY[x.status] || DAY.future)[0], x.checkedIn ? `keldi ${clock(x.checkedIn)}` : null, x.checkedOut ? `ketdi ${clock(x.checkedOut)}` : null, x.status === 'late' ? dur(x.lateMinutes) : null].filter(Boolean).join(' · ')),
          x.lateNotice ? h('div', { class: 'chips' }, chip('⏰ oldindan bildirgan', 'amber')) : null,
          x.lateReason && x.status !== 'ontime' ? h('p', { class: 'muted' }, `«${x.lateReason}»`) : null,
          r.seeAll && x.hasVideo ? h('div', { class: 'btns' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => showMedia(box, `/api/att/${x.attId}/video`, 'video') }, '🎥 Keldim videosi')) : null,
          box));
      })));
  };

  // --- sababli kun so'rovlari ---
  const pageExcuses = async () => {
    setTitle('🙋 Sababli kunlar', "Kelmaslik so'rovlari");
    const d = await api('GET', '/api/excuses');
    if (!d.rows.length) return mount(empty("Kutilayotgan so'rov yo'q ✅"));
    mount(h('div', { class: 'list' }, d.rows.map((x) => {
      const box = h('div', { class: 'media' });
      const decide = (status) => action(async () => { await api('POST', `/api/excuses/${x.attId}`, { status }); toast(status === 'approved' ? 'Sababli ✅' : 'Sababsiz'); router(); });
      return h('div', { class: 'item static' }, h('div', { class: 'grow' },
        h('div', { class: 't' }, `${x.name} — ${x.datePretty}`), h('p', null, `«${x.reason}»`), box,
        h('div', { class: 'btns' },
          x.proofType ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => showMedia(box, `/api/excuses/${x.attId}/proof`, x.proofType) }, '👁 Isbot') : null,
          h('button', { class: 'btn ok small', type: 'button', onclick: decide('approved') }, '✅ Sababli'),
          h('button', { class: 'btn danger small', type: 'button', onclick: decide('rejected') }, '❌ Sababsiz'))));
    })));
  };

  // =========================================================================
  // OYLIK VA KPI (o'zim)
  // =========================================================================
  const pagePay = async () => {
    setTitle('💵 Oylik va KPI');
    const d = await api('GET', '/api/pay');
    mount(h('div', { class: 'list' }, d.months.map((x) => h('button', { class: 'item', type: 'button', onclick: () => go(`#/pay/${x.month}`) },
      h('div', { class: 'grow' }, h('div', { class: 't' }, `${x.monthName}${x.current ? ' (joriy)' : ''}`),
        h('div', { class: 's' }, `💼 ${money(x.salary)} · 🏆 KPI ${d.kpiMode === 'gate' ? (x.eligible ? '✅' : '❌') : `${x.total} ball`} ${money(x.bonus)}`)),
      h('div', { class: 'end' }, h('b', null, money(x.total)), h('br'), x.final ? STATUS[x.status][1] : 'taxminiy')))),
    h('p', { class: 'muted' }, 'Oylik = oklad + KPI. KPI oy yakunida direktor tasdiqlagach qo\'shiladi.'));
  };

  const pagePayMonth = async (m) => {
    const month = m[1];
    const d = await api('GET', `/api/pay/${month}`);
    const k = d.kpi;
    setTitle('💵 Oylik va KPI', d.monthName);
    const lim = (label, v, max) => [h('div', { class: 'k' }, `${v > max ? '❌' : '✅'} ${label}${max ? ` (ruxsat ${max})` : ''}`), h('div', { class: 'v' }, String(v))];
    mount(
      h('div', { class: 'card' }, h('div', { class: 'kv' },
        h('div', { class: 'k' }, '💼 Oklad'), h('div', { class: 'v' }, money(d.pay.salary)),
        h('div', { class: 'k' }, '🏆 KPI summasi'), h('div', { class: 'v' }, money(d.pay.bonusFund)),
        h('div', { class: 'k' }, 'KPI beriladi'), h('div', { class: 'v' }, money(d.pay.bonus)),
        h('div', { class: 'k' }, h('b', null, '💰 Jami')), h('div', { class: 'v' }, money(d.pay.total))),
        h('p', { class: 'muted' }, d.pay.final ? STATUS[k.status][1] : 'Taxminiy — oy yakunida direktor tasdiqlaydi'),
        d.monthStart ? h('p', { class: 'hint' }, `⏱ Oy hisobi: ${shortDate(d.monthStart.slice(0, 10))} ${clock(d.monthStart)} dan`) : null),
      d.kpiMode === 'gate' ? h('div', { class: 'card' }, h('h2', null, 'KPI sharti'),
        h('div', { class: 'kv' }, lim('🕘 Kech kelgan kunlar', k.att.late, d.limits.late), lim('🔴 Sababsiz kelmagan', k.att.absent, d.limits.absent), lim('📋 Muddatida bajarilmagan', k.tasks.missed, d.limits.missed),
          h('div', { class: 'k' }, '📄 Sababli kunlar'), h('div', { class: 'v' }, String(k.att.excused))),
        h('p', null, k.eligible ? (d.current ? '✅ Hozircha shart bajarilyapti — shu tarzda davom eting!' : '✅ Shart bajarildi') : `❌ KPI berilmaydi: ${k.fail || ''}`)) : null,
      h('div', { class: 'card' }, h('h2', null, `KPI ball: ${k.total}`), bar(k.total),
        h('p', { class: 'muted' }, `📋 topshiriq ${k.tasks.pct}% · 🕘 davomat ${k.att.pct}% · ⭐ ${k.headScore === null ? '—' : `${k.headScore}/10`}`),
        k.note ? h('p', null, `💬 ${k.note}`) : null),
      h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => { await api('POST', `/api/pay/${month}/excel`); toast('Excel chatga yuborildi 📥'); }) }, '📥 Batafsil hisobot (Excel, chatga)'));
  };

  // =========================================================================
  // ESLATMALAR
  // =========================================================================
  const pageReminders = async () => {
    setTitle('🔔 Eslatmalar', 'Ochiq topshiriqlar haqida eslatma vaqtlari');
    const r = state.me ? state.me.roles : {};
    const out = [];
    if (state.me && state.me.employee && !r.isAdmin) {
      const d = await api('GET', '/api/reminders');
      const custom = h('input', { class: 'input', maxlength: '100', placeholder: '10:00, 13:00, 16:30' });
      out.push(h('div', { class: 'card' },
        h('h2', null, 'Hozirgi vaqtlar'), h('div', { class: 'big' }, d.times.join(', ') || '—'),
        h('p', { class: 'muted' }, d.source === 'own' ? 'Shaxsiy jadval' : d.source === 'dept' ? "Bo'lim jadvali" : `Umumiy: har ${d.step} soatda`),
        d.pending ? h('div', { class: 'chips' }, chip(`⏳ tasdiq kutilmoqda: ${d.pending.join(', ')}`, 'amber')) : null),
      section("Boshqa vaqt so'rash"),
      h('div', { class: 'list' }, d.options.filter((o) => o.times.length).map((o) => h('button', { class: 'item', type: 'button', onclick: action(async () => {
        await api('POST', '/api/reminders', { step: o.step }); toast("So'rov yuborildi"); router();
      }) }, h('div', { class: 'grow' }, h('div', { class: 't' }, `Har ${o.step} soatda`), h('div', { class: 's' }, o.times.join(', '))), h('span', { class: 'chev' }, '›')))),
      h('div', { class: 'card' }, h('label', { class: 'field' }, h('span', null, "Vaqtlarni o'zim yozaman"), custom),
        h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => {
          await api('POST', '/api/reminders', { times: custom.value }); toast("So'rov yuborildi"); router();
        }) }, "So'rov yuborish"),
        h('p', { class: 'hint' }, `${d.approvers} tasdiqlagach shu vaqtlarda keladi.`)),
      d.own ? h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => { await api('POST', '/api/reminders', { reset: true }); toast('Umumiy jadvalga qaytdi'); router(); }) }, '↩️ Umumiy jadvalga qaytish') : null);
    }
    if (r.isAdmin) {
      const a = await api('GET', '/api/reminders/admin');
      const SRC = { own: '👤 shaxsiy', dept: "🏢 bo'lim", global: '🌐 umumiy' };
      /** Vaqt tanlash oynasi: har N soat / o'zim yozaman / tozalash */
      const timesSheet = (title, path, hasOwn) => {
        const inp = h('input', { class: 'input', maxlength: '100', placeholder: '10:00, 13:00, 16:30' });
        const save = async (body) => { const x = await api('POST', path, body); closeSheet(); toast(x.times ? `Saqlandi: ${x.times.join(', ')}` : 'Umumiy jadvalga qaytdi'); router(); };
        openSheet(title,
          seg([1, 2, 3, 4].map((n) => [String(n), `Har ${n} soat`]), '', action((k) => save({ step: Number(k) }))),
          h('label', { class: 'field' }, h('span', null, "Vaqtlarni o'zim yozaman"), inp),
          h('button', { class: 'btn block', type: 'button', onclick: action(() => save({ times: inp.value })) }, 'Saqlash'),
          hasOwn ? h('button', { class: 'btn ghost block', type: 'button', onclick: action(() => save({ reset: true })) }, '↩️ Umumiy jadvalga qaytarish') : null);
      };
      out.push(section('🌐 Umumiy oraliq'),
        h('div', { class: 'card' }, seg([1, 2, 3, 4].map((n) => [String(n), `Har ${n} soat`]), String(a.step), action(async (k) => {
          await api('POST', '/api/settings/remind-step', { step: Number(k) }); toast('Saqlandi'); router();
        })), h('p', { class: 'muted' }, `Vaqtlar: ${a.globalTimes.join(', ') || '—'}. Tartib: hodim vaqti → bo'lim vaqti → umumiy.`)),
        section("🏢 Bo'limlar"),
        a.departments.length ? h('div', { class: 'list' }, a.departments.map((d) => h('button', { class: 'item', type: 'button', onclick: () => timesSheet(`🏢 ${d.name}`, `/api/reminders/admin/dept/${d.id}`, Boolean(d.times)) },
          h('div', { class: 'grow' }, h('div', { class: 't' }, d.name), h('div', { class: 's' }, d.times ? d.times.join(', ') : `umumiy (har ${a.step} soat)`)), h('span', { class: 'chev' }, '›')))) : empty("Bo'lim yo'q"),
        section('👤 Hodimlar'),
        h('div', { class: 'list' }, a.employees.map((e) => h('button', { class: 'item', type: 'button', onclick: () => timesSheet(`👤 ${e.name}`, `/api/reminders/admin/emp/${e.id}`, e.source === 'own') },
          h('div', { class: 'grow' }, h('div', { class: 't' }, e.name), h('div', { class: 's' }, `${e.times.join(', ') || '—'} · ${SRC[e.source]}${e.department ? ` · ${e.department}` : ''}`)),
          e.pending ? chip('⏳ so\'rov', 'amber') : h('span', { class: 'chev' }, '›')))));
      const p = await api('GET', '/api/reminders/pending');
      out.push(section(`Tasdiq kutayotganlar (${p.rows.length})`));
      out.push(p.rows.length ? h('div', { class: 'list' }, p.rows.map((x) => h('div', { class: 'item static' }, h('div', { class: 'grow' },
        h('div', { class: 't' }, x.name), h('div', { class: 's' }, `➡️ ${x.pending.join(', ')} (hozir: ${x.current.join(', ') || '—'})`),
        h('div', { class: 'btns' },
          h('button', { class: 'btn ok small', type: 'button', onclick: action(async () => { await api('POST', `/api/reminders/${x.id}`, { approve: true }); toast('Tasdiqlandi'); router(); }) }, '✅ Tasdiqlash'),
          h('button', { class: 'btn danger small', type: 'button', onclick: action(async () => { await api('POST', `/api/reminders/${x.id}`, { approve: false }); toast('Rad etildi'); router(); }) }, '❌ Rad etish')))))) : empty("So'rov yo'q"));
    }
    mount(out);
  };

  // =========================================================================
  // SOZLAMALAR (direktor)
  // =========================================================================
  const pageSettings = async () => {
    setTitle('⚙️ Sozlamalar');
    const d = await api('GET', '/api/settings');
    const ws = h('input', { class: 'input', type: 'time', value: d.workStart });
    const reset = h('input', { type: 'checkbox' });
    const boss = h('input', { class: 'input', maxlength: '60', value: d.bossName });
    const yes = (v) => (v ? '✅ ulangan' : '❌ ulanmagan');
    mount(
      section('🕘 Ish vaqti'),
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', null, 'Umumiy ish boshlanishi'), ws,
          h('div', { class: 'hint' }, `${d.workStart} + ${d.lateGrace} daqiqadan keyin kelgan «kech» hisoblanadi. Ish oxiri ${d.workEndHour}:00, kunlar ${d.workDays}.`)),
        d.individual.length ? [h('p', { class: 'muted' }, `Alohida vaqti bor: ${d.individual.map((x) => `${x.name} (${x.workStart})`).join(', ')}`),
          h('label', { class: 'check' }, reset, 'Alohida vaqtlarni ham bekor qilish (hamma bir xil)')] : null,
        h('button', { class: 'btn block', type: 'button', onclick: action(async () => {
          if (!(await confirmBox(`Ish boshlanishi ${ws.value} bo'lsinmi? Hodimlarga xabar boradi.`))) return;
          const r = await api('POST', '/api/settings/worktime', { workStart: ws.value, resetIndividual: reset.checked }); toast(`Saqlandi · ${r.notified} ta hodimga xabar`); router();
        }) }, 'Saqlash')),
      section('🔔 Topshiriq eslatmalari (umumiy)'),
      h('div', { class: 'card' }, seg([1, 2, 3, 4].map((n) => [String(n), `Har ${n} soat`]), String(d.remindStep), action(async (k) => {
        await api('POST', '/api/settings/remind-step', { step: Number(k) }); toast('Saqlandi'); router();
      })), h('p', { class: 'muted' }, `Vaqtlar: ${d.remindTimes.join(', ') || '—'}`),
      h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => {
        if (!(await confirmBox('Hozir hamma ochiq topshiriqlar haqida eslatma yuborilsinmi?'))) return;
        const r = await api('POST', '/api/settings/remind-now'); toast(`${r.sent} ta hodimga yuborildi`);
      }) }, '🔔 Hozir eslatma yuborish')),
      section('📤 Rahbar bergan topshiriq nusxasi'),
      h('div', { class: 'card' }, seg([['1', '✅ Yoqilgan'], ['0', "🚫 O'chiq"]], d.headTaskCopy ? '1' : '0', action(async (k) => {
        await api('POST', '/api/settings/head-task-copy', { on: k === '1' }); toast('Saqlandi'); router();
      })), h('p', { class: 'muted' }, "Yoqilgan bo'lsa, bo'lim rahbari bergan topshiriq nusxasi direktor va HR ga boradi. Direktor va HR bergan topshiriqlar nusxasiz.")),
      section('🏷 Boshliq ismi'),
      h('div', { class: 'card' }, h('label', { class: 'field' }, boss, h('div', { class: 'hint' }, "«HR va boshliq (…)ga yuborildi» yorlig'ida ko'rinadi.")),
        h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => { await api('POST', '/api/settings/boss-name', { name: boss.value }); toast('Saqlandi'); }) }, 'Saqlash')),
      section(`🗓 ${d.monthStart.monthName} — oy boshi`),
      h('div', { class: 'card' }, h('p', null, `✅ Tasdiqlagan: ${d.monthStart.confirmed} · ⏳ Tasdiqlamagan: ${d.monthStart.waiting.length}`),
        d.monthStart.waiting.length ? [h('p', { class: 'muted' }, d.monthStart.waiting.join(', ')),
          h('button', { class: 'btn ghost block', type: 'button', onclick: action(async () => { const r = await api('POST', '/api/settings/month-start/resend'); toast(`${r.sent} ta hodimga qayta yuborildi`); }) }, '🔔 Qayta yuborish')] : null),
      section('🩺 Tizim'),
      h('div', { class: 'card' }, h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Faol hodimlar'), h('div', { class: 'v' }, String(d.employeesCount)),
        h('div', { class: 'k' }, 'Ishchi guruh'), h('div', { class: 'v' }, yes(d.groupLinked)),
        h('div', { class: 'k' }, 'Arxiv guruhi'), h('div', { class: 'v' }, yes(d.archiveLinked)),
        h('div', { class: 'k' }, 'Asosiy ofis'), h('div', { class: 'v' }, d.office ? `radius ${d.office.radius} m` : '❌ belgilanmagan'),
        h('div', { class: 'k' }, 'KPI rejimi'), h('div', { class: 'v' }, d.kpi.mode === 'gate' ? `shartli (kech ≤${d.kpi.maxLate}, kelmagan ≤${d.kpi.maxAbsent}, kech ish ≤${d.kpi.maxMissed})` : 'ball × summa'),
        h('div', { class: 'k' }, 'Qaytarish jarimasi'), h('div', { class: 'v' }, `${d.kpi.returnPenalty}%`)),
        h('p', { class: 'hint' }, 'Guruh/arxiv ulash (/guruh_ulash, /arxiv_ulash) va ofis nuqtasi (/ofis) — botda, chunki guruh ichida yoki GPS bilan qilinadi.')));
  };

  // =========================================================================
  // ROUTER
  // =========================================================================
  const ROUTES = [
    [/^\/$/, pageHome],
    [/^\/tasks$/, pageTasks],
    [/^\/self$/, pageSelf],
    [/^\/assign$/, pageAssign],
    [/^\/review$/, pageReview],
    [/^\/people$/, pagePeople],
    [/^\/emp\/(\d+)$/, pageEmployee],
    [/^\/new$/, pageNew],
    [/^\/org$/, pageOrg],
    [/^\/kpi(?:\/(\d{4}-\d{2}))?$/, pageKpi],
    [/^\/kpi\/(\d{4}-\d{2})\/(\d+)$/, pageKpiCard],
    [/^\/scores(?:\/(\d{4}-\d{2}))?$/, pageScores],
    [/^\/att$/, pageAtt],
    [/^\/journal$/, pageJournal],
    [/^\/excuses$/, pageExcuses],
    [/^\/pay$/, pagePay],
    [/^\/pay\/(\d{4}-\d{2})$/, pagePayMonth],
    [/^\/reminders$/, pageReminders],
    [/^\/settings$/, pageSettings],
  ];

  let seq = 0;
  async function router() {
    closeSheet();
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    const q = new URLSearchParams(qs || '');
    const found = ROUTES.map(([re, fn]) => [re.exec(path), fn]).find(([m]) => m);
    const mySeq = (seq += 1);
    if (tg && tg.BackButton) { if (path === '/') tg.BackButton.hide(); else tg.BackButton.show(); }
    if (!found) { location.hash = '#/'; return; }
    $app.replaceChildren(h('div', { class: 'loading' }, 'Yuklanmoqda…'));
    try {
      if (!state.me && path !== '/') state.me = await api('GET', '/api/me');
      if (mySeq !== seq) return;
      await found[1](found[0], q);
      window.scrollTo(0, 0);
    } catch (e) {
      if (mySeq === seq) showError(e);
    }
  }

  // -------------------------------------------------------------------------
  // KUNDUZGI / TUNGI REJIM: avto (Telegram mavzusi) → kunduzgi → tungi. Tanlov shu qurilmada eslab qolinadi.
  // -------------------------------------------------------------------------
  const THEMES = { auto: ['🌓', 'Avto (Telegram mavzusi)'], light: ['☀️', 'Kunduzgi rejim'], dark: ['🌙', 'Tungi rejim'] };
  const PALETTE = { light: { bg: '#f1f2f6', head: '#f1f2f6' }, dark: { bg: '#0f1115', head: '#0f1115' } };
  const readTheme = () => { try { const v = localStorage.getItem('baylog-theme'); return THEMES[v] ? v : 'auto'; } catch { return 'auto'; } };
  let theme = readTheme();
  const $themeBtn = document.getElementById('theme');

  /** Tabiiy elementlar (checkbox, sana) va Telegram sarlavha rangi tanlangan rejimga mos bo'lsin */
  const syncScheme = () => {
    const root = document.documentElement;
    if (theme === 'auto') {
      root.removeAttribute('data-theme');
      root.style.colorScheme = tg && INIT && tg.colorScheme ? tg.colorScheme : '';
    } else {
      root.setAttribute('data-theme', theme);
      root.style.colorScheme = theme;
    }
    if ($themeBtn) { $themeBtn.textContent = THEMES[theme][0]; $themeBtn.title = THEMES[theme][1]; }
    if (tg && INIT) {
      try {
        const p = theme === 'auto' ? null : PALETTE[theme];
        if (tg.setHeaderColor) tg.setHeaderColor(p ? p.head : 'secondary_bg_color');
        if (tg.setBackgroundColor) tg.setBackgroundColor(p ? p.bg : 'secondary_bg_color');
      } catch { /* eski klient */ }
    }
  };
  if ($themeBtn) {
    $themeBtn.addEventListener('click', () => {
      theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
      try { localStorage.setItem('baylog-theme', theme); } catch { /* saqlanmasa ham ishlaydi */ }
      syncScheme();
      toast(THEMES[theme][1]);
    });
  }
  syncScheme();

  if (tg) {
    try {
      tg.ready();
      tg.expand();
      syncScheme();
      tg.onEvent('themeChanged', syncScheme);
      if (tg.BackButton) tg.BackButton.onClick(() => { if (history.length > 1) history.back(); else go('#/'); });
    } catch { /* eski klient */ }
  }
  window.addEventListener('hashchange', router);
  if (!INIT) {
    setTitle('BayLog');
    mount(h('div', { class: 'error-box' }, h('div', { class: 'big' }, '📱'), h('p', null, "Bu ilova faqat Telegram'dagi bot ichida ishlaydi: botda «📱 Ilova» tugmasini bosing.")));
  } else router();
})();
