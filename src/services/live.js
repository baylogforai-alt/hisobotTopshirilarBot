'use strict';

const db = require('../db');
const time = require('../time');
const geo = require('../geo');
const config = require('../config');
const ui = require('../ui');
const employees = require('./employees');
const attendance = require('./attendance');

const { esc } = ui;

/**
 * AGENT JONLI JOYLASHUVI (6-okt, sinov).
 *   Agent Telegram'da «Jonli joylashuvni ulashish» ni yoqadi → har bir «Live Location» xabari = live_shares qatori.
 *   Telegram har harakatda o'sha xabarni tahrirlaydi (edited_message) → oxirgi joy yangilanadi, yo'l nuqtalari live_points ga
 *   (har ≥60 s yoki ≥100 m da bitta; faqat «Keldim» dan «Ketdim» gacha). live_period yo'q tahrir = agent o'chirdi.
 *   Cron (watch): yoqmagan agentga eslatma, 30 daq (LIVE_GAP_MIN) yangilanmasa / muddati tugasa — rahbar va HR ga.
 *   Kim ko'radi — access.canSeeLive: boshliq/direktor, HR, agentning bo'lim rahbari.
 */

/** Telegram: «Men o'chirgunimcha» */
const FOREVER = 0x7fffffff;
const POINT_MIN_SEC = 60;
const POINT_MOVE_M = 100;
const POINT_MOVE_MIN_SEC = 15;

const isLive = (m) => Boolean(m && m.location && Number(m.location.live_period) > 0);
/** live_period → tugash vaqti (ISO) yoki null (cheksiz) */
const untilOf = (m) => {
  const p = Number(m.location.live_period);
  return p >= FOREVER ? null : time.stampOf(Number(m.date) + p);
};
const ms = (iso) => Date.parse(iso);

const shareById = (id) => db.one('SELECT * FROM live_shares WHERE id = $1', [Number(id)]);
const byMessage = (empId, messageId) =>
  db.one('SELECT * FROM live_shares WHERE employee_id = $1 AND message_id = $2 ORDER BY id DESC LIMIT 1', [Number(empId), Number(messageId)]);
/**
 * Shu kungi oxirgi jonli joylashuv. Bugun uchun — kechadan yoniq qolgani (to'xtatilmagan) ham (8-okt: agent ertalab
 * yangi yubormasdan, kechagi «Men o'chirgunimcha» bilan keladi — bu ham hisob).
 */
const latest = (empId, date = time.today()) => (date === time.today()
  ? db.one('SELECT * FROM live_shares WHERE employee_id = $1 AND (work_date = $2 OR stopped_at IS NULL) ORDER BY id DESC LIMIT 1', [Number(empId), date])
  : db.one('SELECT * FROM live_shares WHERE employee_id = $1 AND work_date = $2 ORDER BY id DESC LIMIT 1', [Number(empId), date]));

const isActive = (share, now = Date.now()) => Boolean(share && !share.stopped_at && (!share.live_until || ms(share.live_until) > now));

const points = (empId, date = time.today()) =>
  db.query('SELECT at, lat, lon, acc FROM live_points WHERE employee_id = $1 AND work_date = $2 ORDER BY at, id', [Number(empId), date]);

const lastPoint = (empId, date) =>
  db.one('SELECT at, lat, lon FROM live_points WHERE employee_id = $1 AND work_date = $2 ORDER BY at DESC, id DESC LIMIT 1', [Number(empId), date]);

/** Yo'l nuqtasi — juda tez-tez emas (har ≥60 s, yoki ≥100 m siljib ≥15 s) */
const addPoint = async (empId, shareId, at, loc, { force = false } = {}) => {
  const date = time.today();
  const last = await lastPoint(empId, date);
  if (last && !force) {
    const dt = (ms(at) - ms(last.at)) / 1000;
    const moved = geo.distanceMeters(Number(last.lat), Number(last.lon), loc.latitude, loc.longitude);
    if (dt < POINT_MIN_SEC && !(moved >= POINT_MOVE_M && dt >= POINT_MOVE_MIN_SEC)) return false;
  }
  const acc = loc.horizontal_accuracy != null ? Math.round(Number(loc.horizontal_accuracy)) : null;
  await db.query(
    'INSERT INTO live_points (employee_id, share_id, work_date, at, lat, lon, acc) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [Number(empId), Number(shareId), date, at, String(loc.latitude), String(loc.longitude), acc],
  );
  return true;
};

/**
 * Yangi «Live Location» xabari yoki uning tahriri. record — yo'l nuqtasi yozilsinmi (Keldim ↔ Ketdim oralig'i).
 * Qaytaradi: { share, isNew, stopped, resumed, ignored }
 */
const track = async (emp, m, { record = true } = {}) => {
  const today = time.today();
  const at = m.edit_date ? time.stampOf(m.edit_date) : m.date ? time.stampOf(m.date) : time.stamp();
  const live = isLive(m);
  let share = await byMessage(emp.id, m.message_id);
  let isNew = false;
  if (!share) {
    if (!live) return { share: null, ignored: true };
    // oldingi jonli joylashuv (bo'lsa, «Ketdim» dan keyin yoniq qolgani ham) — almashtirildi
    await db.query(
      "UPDATE live_shares SET stopped_at = COALESCE(stopped_at, $1), stop_reason = 'replaced' WHERE employee_id = $2 AND (stopped_at IS NULL OR stop_reason = 'checkout')",
      [at, Number(emp.id)],
    );
    const rows = await db.query(
      `INSERT INTO live_shares (employee_id, work_date, message_id, started_at, live_until, last_at, last_lat, last_lon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [Number(emp.id), today, Number(m.message_id), at, untilOf(m), at, String(m.location.latitude), String(m.location.longitude)],
    );
    share = await shareById(rows[0].id);
    isNew = true;
  } else if (share.stopped_at) {
    if (share.stop_reason !== 'checkout') return { share, ignored: true };
    // 8-okt: «Ketdim» dan keyin Telegram'da yoniq qoldi — o'chirsa yakuniy to'xtadi, aks holda joyi yangilanib boradi
    if (!live) {
      await db.query("UPDATE live_shares SET stopped_at = $1, stop_reason = 'stopped' WHERE id = $2 AND stop_reason = 'checkout'", [at, Number(share.id)]);
      return { share: await shareById(share.id), ignored: true };
    }
    await db.query('UPDATE live_shares SET last_at = $1, last_lat = $2, last_lon = $3 WHERE id = $4',
      [at, String(m.location.latitude), String(m.location.longitude), Number(share.id)]);
    if (!record) return { share: await shareById(share.id), ignored: true };
    // yangi ish kuni, «Keldim» qilingan — o'sha jonli joylashuv bilan kuzatuv qayta boshlanadi
    await db.query("UPDATE live_shares SET stopped_at = NULL, stop_reason = NULL, gap_alert_at = NULL, work_date = $1 WHERE id = $2", [today, Number(share.id)]);
    share = await shareById(share.id);
    isNew = true;
  }
  if (!live) {
    const rows = await db.query("UPDATE live_shares SET stopped_at = $1, stop_reason = 'stopped' WHERE id = $2 AND stopped_at IS NULL RETURNING id", [at, Number(share.id)]);
    return { share: await shareById(share.id), stopped: rows.length > 0, ignored: !rows.length };
  }
  const resumed = Boolean(share.gap_alert_at);
  if (!isNew) {
    await db.query(
      'UPDATE live_shares SET last_at = $1, last_lat = $2, last_lon = $3, gap_alert_at = NULL, work_date = $4 WHERE id = $5',
      [at, String(m.location.latitude), String(m.location.longitude), today, Number(share.id)],
    );
  }
  if (record) await addPoint(emp.id, share.id, at, m.location, { force: isNew });
  return { share: await shareById(share.id), isNew, resumed };
};

/**
 * «Keldim» — kechadan yoniq qolgan jonli joylashuv (Ketdimdan keyin o'chirilmagan yoki Ketdim qilinmagan) bugungi kuzatuvga olinadi,
 * agar u yaqinda (LIVE_GAP_MIN ichida) yangilangan bo'lsa — demak Telegram'da hali yoniq. Qaytaradi: share yoki null
 */
const adopt = async (emp, now = Date.now()) => {
  const share = await db.one(
    "SELECT * FROM live_shares WHERE employee_id = $1 AND (stopped_at IS NULL OR stop_reason = 'checkout') ORDER BY id DESC LIMIT 1",
    [Number(emp.id)],
  );
  if (!share || (share.live_until && ms(share.live_until) <= now)) return null;
  if (!share.last_at || (now - ms(share.last_at)) / 60000 > config.liveGapMin) return null;
  await db.query('UPDATE live_shares SET stopped_at = NULL, stop_reason = NULL, gap_alert_at = NULL, work_date = $1 WHERE id = $2', [time.today(), Number(share.id)]);
  return shareById(share.id);
};

/** «Ketdim» — kuzatuv tugadi. To'xtatilganlar soni */
const stopFor = async (empId, reason = 'checkout') =>
  (await db.query('UPDATE live_shares SET stopped_at = $1, stop_reason = $2 WHERE employee_id = $3 AND stopped_at IS NULL RETURNING id', [time.stamp(), reason, Number(empId)])).length;

// ---------------------------------------------------------------------------
// HISOB: yo'l uzunligi va to'xtashlar
// ---------------------------------------------------------------------------

const pt = (p) => ({ at: p.at, lat: Number(p.lat), lon: Number(p.lon), acc: p.acc == null ? null : Number(p.acc) });
const d = (a, b) => geo.distanceMeters(a.lat, a.lon, b.lat, b.lon);

/** Yurgan yo'li (metr) — aniqligi past (>150 m) nuqtalar hisobga olinmaydi */
const pathLength = (list) => {
  const good = list.map(pt).filter((p) => p.acc == null || p.acc <= 150);
  let sum = 0;
  for (let i = 1; i < good.length; i += 1) sum += d(good[i - 1], good[i]);
  return sum;
};

/**
 * To'xtashlar: radius ichida ≥ minMin daqiqa. Tugashi — joydan chiqqan birinchi nuqta vaqti (turgan joyda Telegram
 * yangilanmasligi mumkin), oxirgi to'xtash — endAt (hozir / oxirgi yangilanish) gacha.
 */
const stops = (list, { radius = 120, minMin = 15, endAt = null } = {}) => {
  const p = list.map(pt);
  const out = [];
  let i = 0;
  while (i < p.length) {
    let j = i + 1;
    while (j < p.length && d(p[i], p[j]) <= radius) j += 1;
    const to = j < p.length ? p[j].at : endAt && ms(endAt) > ms(p[j - 1].at) ? endAt : p[j - 1].at;
    const min = Math.round((ms(to) - ms(p[i].at)) / 60000);
    if (min >= minMin) {
      out.push({ from: p[i].at, to, min, lat: p[i].lat, lon: p[i].lon, ongoing: j >= p.length });
      i = j;
    } else i += 1;
  }
  return out;
};

/** Yandex Maps marshruti — ko'pi bilan 10 nuqta (birinchi va oxirgisi bilan) */
const routeUrl = (list) => {
  const p = list.map(pt);
  if (p.length < 2) return null;
  const n = Math.min(10, p.length);
  const pick = [];
  for (let k = 0; k < n; k += 1) pick.push(p[Math.round((k * (p.length - 1)) / (n - 1))]);
  return geo.routeUrl(pick);
};

// ---------------------------------------------------------------------------
// HOLAT (ko'ruvchi uchun)
// ---------------------------------------------------------------------------

/**
 * kind: absent (kelmagan) · nolive (keldi, jonli joylashuv yo'q) · live · stale (yangilanmayapti) · stopped (o'chirgan / muddati tugagan) · out (ketdi)
 */
const statusOf = async (emp, date = time.today()) => {
  const att = await attendance.get(emp.id, date);
  const share = await latest(emp.id, date);
  const now = Date.now();
  const base = { att, share, lat: null, lon: null, lastAt: null, ageMin: null };
  if (share) Object.assign(base, { lat: Number(share.last_lat), lon: Number(share.last_lon), lastAt: share.last_at, ageMin: Math.max(0, Math.round((now - ms(share.last_at)) / 60000)) });
  else if (att && att.checkin_lat) Object.assign(base, { lat: Number(att.checkin_lat), lon: Number(att.checkin_lon), lastAt: att.checked_in });
  if (att && att.checked_out) return { ...base, kind: 'out' };
  if (!att || !att.checked_in) return { ...base, kind: 'absent' };
  if (att.live_excused_at && !isActive(share, now)) return { ...base, kind: 'excused' };
  if (!share) return { ...base, kind: 'nolive' };
  if (!isActive(share, now)) return { ...base, kind: 'stopped' };
  if (base.ageMin >= config.liveGapMin) return { ...base, kind: 'stale' };
  return { ...base, kind: 'live' };
};

const KIND = {
  live: ['🟢', 'jonli'],
  stale: ['🟡', 'yangilanmayapti'],
  stopped: ['🔴', "o'chirilgan"],
  nolive: ['⚪️', "jonli joylashuv yoqilmagan"],
  excused: ['📵', 'jonli joylashuvsiz (sabab bilan)'],
  absent: ['⚫️', 'kelmagan'],
  out: ['🏁', 'ketdi'],
};
const ago = (min) => (min == null ? '' : min < 1 ? 'hozirgina' : `${time.prettyDuration(min)} oldin`);
const kindText = (s) => {
  const [ic, label] = KIND[s.kind];
  if (s.kind === 'live' || s.kind === 'stale') return `${ic} ${label} · ${ago(s.ageMin)}`;
  if (s.kind === 'stopped') return `${ic} ${s.share.stop_reason === 'expired' ? 'muddati tugagan' : label} · ${time.clock(s.share.stopped_at || s.share.live_until)}`;
  if (s.kind === 'out') return `${ic} ${label} · ${time.clock(s.att.checked_out)}`;
  if (s.kind === 'nolive') return `${ic} ${label} · keldi ${time.clock(s.att.checked_in)}`;
  if (s.kind === 'excused') return `${ic} ${label} · ${time.clock(s.att.live_excused_at)}: «${esc(String(s.att.live_excuse || '').slice(0, 80))}»`;
  return `${ic} ${label}`;
};

// ---------------------------------------------------------------------------
// XABARLAR
// ---------------------------------------------------------------------------

/** 8-okt: Keldimdan keyin jonli joylashuv ishlamasa — sabab yozib, o'sha kunga ozod bo'lish (lv:nl) */
const NOLIVE_BTN = '📵 Jonli joylashuv ishlamayapti';
const noLiveKb = () => ui.inline([[ui.cb(NOLIVE_BTN, 'lv:nl')]]);

/**
 * 14-okt: Olimjon (iPhone) — Telegram fonda bo'lganda (Instagram'da, ekran o'chiq) joylashuv 33 daq kelmadi, shu payt 24 km yurgan;
 * Telegram'ni ochishi bilan darhol yangilandi. Telefon fonda yubormasa — bot ko'rmaydi.
 */
const BACKGROUND_TIPS =
  `📱 <b>Telegram yopiq turganda ham joylashuv borishi uchun</b> (boshqa ilovada yoki ekran o'chganda):\n` +
  `• <b>iPhone:</b> Sozlamalar → Telegram → Joylashuv → <b>«Har doim»</b> (Always), «Aniq joylashuv» (Precise Location) yoniq; ` +
  `Sozlamalar → Asosiy → «Fon rejimida yangilash» (Background App Refresh) → Telegram yoniq; Quvvat tejash rejimi (Low Power Mode) o'chiq.\n` +
  `• <b>Android:</b> Telegram'ga joylashuv ruxsati <b>«Har doim»</b> (Allow all the time); Ilovalar → Telegram → Batareya → <b>«Cheklovsiz»</b> (Unrestricted).\n` +
  `Telegram'ni ochiq ilovalar ro'yxatidan surib yopmang.`;

const LIVE_PROMPT =
  `📡 <b>Jonli joylashuvni yoqing</b> — ish vaqtida qayerda yurganingiz rahbar va HR ga ko'rinib turadi.\n\n` +
  `1. Pastdagi 📎 (skrepka) → <b>«Joylashuv»</b>\n` +
  `2. <b>«Jonli joylashuvni ulashish»</b> (Share My Live Location)\n` +
  `3. Muddat: <b>«Men o'chirgunimcha»</b> (Until I turn it off)\n\n` +
  `❓ <b>«Joylashuv» ko'rinmasa:</b> 📎 bosgandan keyin pastki qatorni (Galereya, Fayl…) <b>chapga suring</b> — u oxirida turadi; ` +
  `Telegram'ni yangilang (Play Market / App Store) va telefon sozlamalarida Telegram'ga joylashuv ruxsatini bering. ` +
  `Baribir bo'lmasa — «${NOLIVE_BTN}» tugmasini bosib sababini yozing (rahbaringiz va HR ga boradi).\n\n` +
  `${BACKGROUND_TIPS}\n\n` +
  `<i>«🏁 Ketdim» bosganingizdan keyin kuzatuv tugaydi — o'chirib qo'yishingiz mumkin.</i>`;

/** LIVE_GAP_MIN yangilanmadi — agentga: eng tez yechim Telegram'ni ochish */
const gapText = (min) =>
  `📡 Joylashuvingiz <b>${time.prettyDuration(min)}dan beri</b> yangilanmayapti — bot sizni ko'rmayapti.\n\n` +
  `👉 <b>Telegram'ni oching</b> — joylashuv darhol yangilanadi. Jonli joylashuv to'xtagan bo'lsa — qayta yoqing.\n\n` +
  `Tez-tez takrorlansa — telefoningiz Telegram yopiq turganda joylashuv yubormayapti:\n\n${BACKGROUND_TIPS}`;

const mapLink = (lat, lon, label = '🗺 xaritada') => `<a href="${geo.mapUrl(lat, lon)}">${label}</a>`;
const homeDist = (emp, lat, lon) => {
  const h = employees.homeOf(emp);
  return h && lat != null ? ` · uydan ${geo.prettyDistance(geo.distanceMeters(h.lat, h.lon, lat, lon))}` : '';
};

/** Agentga — jonli joylashuv qabul qilindi (yoki ish tugashigacha yetmaydi) */
const startedText = (emp, share, checkedIn) => {
  let t = `📡 <b>Jonli joylashuv ulandi.</b> ${checkedIn ? "Ish vaqtida yo'lingiz rahbar va HR ga ko'rinib turadi." : `Yo'l «${ui.BTN.checkIn}» dan keyin yozila boshlaydi.`}`;
  if (share.live_until) {
    const endIso = `${time.today()}T${employees.workEndOf(emp)}`;
    if (share.live_until.slice(0, 16) < endIso) {
      t += `\n\n⚠️ Siz <b>${time.clock(share.live_until)} gacha</b> yoqdingiz — ish tugashigacha (${employees.workEndOf(emp)}) yetmaydi. ` +
        `Qayta yuborib, muddatni <b>«Men o'chirgunimcha»</b> tanlang.`;
    }
  }
  return t;
};

const notify = () => require('./notify');

/** 7-okt: jonli joylashuvi o'chiq agentga har 10 daqiqada eslatma */
const NUDGE_EVERY_MIN = 10;

/**
 * 7-okt: agent Keldim qilgan, hali ketmagan, ish tugamagan va jonli joylashuvi yoqilmagan / o'chgan bo'lsa — bot va ilovada
 * boshqa hech narsa ishlamaydi (faqat joylashuv yuborish va «Ketdim»). Ofis hodimi va boshliq — hech qachon.
 */
const offFor = async (emp, now = time.now()) => {
  if (!emp || !employees.isField(emp) || employees.isBoss(emp)) return false;
  if (now.hour * 60 + now.minute >= employees.endMinutesOf(emp)) return false;
  const att = await attendance.get(emp.id);
  if (!att || !att.checked_in || att.checked_out || Number(att.checkin_noloc) || att.live_excused_at) return false;
  return !isActive(await latest(emp.id), now.toMillis());
};

const BLOCKED_TEXT =
  `⛔️ <b>Jonli joylashuvingiz o'chiq</b> — yoqmaguningizcha bot ishlamaydi (topshiriqlar, Bajardim, tashrif va boshqalar yopiq; faqat «${ui.BTN.checkOut}» ishlaydi).\n` +
  `Rahbaringiz va HR ga xabar borgan.\n\n`;

/**
 * 8-okt: agent «yoniq» deydi, lekin botga hech narsa kelmagan (telefonda GPS yoqilgan, xolos) — aniq tushuntirish.
 * share — bugungi oxirgi jonli joylashuv (null — bugun umuman yuborilmagan)
 */
const NEVER_SENT_HINT =
  `❗️ <b>Bot sizdan bugun bitta ham jonli joylashuv olmagan.</b> Telefonda GPS (joylashuv) yoniq bo'lishi <b>yetmaydi</b> — ` +
  `jonli joylashuvni aynan <b>shu bot chatiga</b> yuborish kerak. Yuborganingizda chatda xarita xabari paydo bo'ladi va bot ` +
  `«📡 Jonli joylashuv ulandi» deb javob beradi. Shu javob kelmasa — yuborilmagan.\n\n`;
const blockedText = (share) => `${BLOCKED_TEXT}${share ? '' : NEVER_SENT_HINT}`;

/**
 * 8-okt: Keldimdan keyin agent jonli emas, oddiy joylashuv yubordi («Joriy joylashuvni yuborish» yoki xaritadan joy) —
 * avval bot «Avval Keldim bosing» derdi, agent «Keldim» bossa — yana yopiq xabar: aylanib qolishardi.
 */
const STATIC_HINT =
  `📍 Siz <b>oddiy (bir martalik) joylashuv</b> yubordingiz — bu jonli emas, kuzatuv uchun yaramaydi.\n` +
  `📎 → «Joylashuv» oynasida <b>«Joriy joylashuvni yuborish»</b> (Send My Current Location) ni emas, ` +
  `<b>«Jonli joylashuvni ulashish»</b> (Share My Live Location) ni bosing. To'g'ri yuborilsa bot «📡 Jonli joylashuv ulandi» deb javob beradi.\n\n`;

/** Agent o'chirdi (Telegram tahriri, live_period yo'q) */
const onStopped = async (bot, emp, share) => {
  await notify().toUser(bot, emp.tg_id, `📡 Jonli joylashuvingiz <b>to'xtadi</b> (Telegram'da o'chirildi). Ish vaqti tugamaguncha qayta yoqing.\n\n${BLOCKED_TEXT}${LIVE_PROMPT}`, noLiveKb());
  await notify().toAttendanceWatchers(bot, emp,
    `⚠️ <b>${esc(emp.full_name)}</b> jonli joylashuvni <b>o'chirdi</b> · ${time.clock(share.stopped_at)}` +
      (share.last_lat ? `\nOxirgi joy: ${mapLink(share.last_lat, share.last_lon)}${homeDist(emp, Number(share.last_lat), Number(share.last_lon))}` : ''),
    { link_preview_options: { is_disabled: true } });
};

/** Ogohlantirishdan keyin yana yangilana boshladi */
const onResumed = (bot, emp, share) =>
  notify().toAttendanceWatchers(bot, emp, `🔄 <b>${esc(emp.full_name)}</b> jonli joylashuvi tiklandi · ${mapLink(share.last_lat, share.last_lon)}`, { link_preview_options: { is_disabled: true } });

/** Kun davomida o'chirgan / ogohlantirilgan bo'lsa — qayta yoqqanini ham bilsin */
const onRestarted = (bot, emp, share) =>
  notify().toAttendanceWatchers(bot, emp, `📡 <b>${esc(emp.full_name)}</b> jonli joylashuvni qayta yoqdi · ${mapLink(share.last_lat, share.last_lon)}`, { link_preview_options: { is_disabled: true } });

/** Bugun oldin to'xtatilgan / ogohlantirilgan bo'lganmi (qayta yoqqanini aytish uchun) */
const hadTroubleToday = async (emp, exceptId) => {
  const att = await attendance.get(emp.id);
  if (att && att.live_alert_at) return true;
  const n = await db.count(
    "SELECT COUNT(*) AS c FROM live_shares WHERE employee_id = $1 AND work_date = $2 AND id <> $3 AND (stop_reason IN ('stopped', 'expired') OR gap_alert_at IS NOT NULL)",
    [Number(emp.id), time.today(), Number(exceptId)],
  );
  return n > 0;
};

/**
 * Cron (har 5 daq, ish vaqtida): Keldim qilgan, hali ketmagan agentlar.
 *   — yoqmagan / o'chgan / muddati tugagan: agentga har 10 daqiqada (yoqmaguncha); yoqmagan — 10 daq da rahbar va HR ga (kuniga bir marta)
 *   — muddati tugagan: agent va rahbar/HR ga
 *   — LIVE_GAP_MIN yangilanmagan: rahbar/HR va agentga (tiklanganda — «tiklandi»)
 */
const watch = async (bot, now = time.now()) => {
  const nowMs = now.toMillis();
  const nowMin = now.hour * 60 + now.minute;
  const stamp = now.toISO();
  const gap = config.liveGapMin;
  let n = 0;
  for (const e of await employees.listStaff()) {
    if (!employees.isField(e) || nowMin >= employees.endMinutesOf(e)) continue;
    const att = await attendance.get(e.id);
    if (!att || !att.checked_in || att.checked_out || Number(att.checkin_noloc) || att.live_excused_at) continue;
    const sinceIn = (nowMs - ms(att.checked_in)) / 60000;
    const share = await latest(e.id);

    if (share && !share.stopped_at && share.live_until && ms(share.live_until) <= nowMs) {
      const rows = await db.query("UPDATE live_shares SET stopped_at = live_until, stop_reason = 'expired' WHERE id = $1 AND stopped_at IS NULL RETURNING id", [Number(share.id)]);
      if (rows.length) {
        await notify().toUser(bot, e.tg_id, `📡 Jonli joylashuv muddati <b>tugadi</b> (${time.clock(share.live_until)}). Qayta yoqing — muddatni «Men o'chirgunimcha» tanlang.\n\n${BLOCKED_TEXT}${LIVE_PROMPT}`, noLiveKb());
        await notify().toAttendanceWatchers(bot, e, `⚠️ <b>${esc(e.full_name)}</b> jonli joylashuv muddati tugadi · ${time.clock(share.live_until)} · oxirgi joy: ${mapLink(share.last_lat, share.last_lon)}`, { link_preview_options: { is_disabled: true } });
        n += 1;
      }
      continue;
    }

    if (!share || share.stopped_at) {
      // o'chirganda / muddati tugaganda rahbar va HR ga darhol xabar ketgan; umuman yoqmaganlar — 10 daq da (kuniga bir marta)
      if (!share && sinceIn >= NUDGE_EVERY_MIN && !att.live_alert_at) {
        await db.query('UPDATE attendance SET live_alert_at = $1 WHERE id = $2', [stamp, att.id]);
        await notify().toAttendanceWatchers(bot, e, `📡 <b>${esc(e.full_name)}</b> keldi (${time.clock(att.checked_in)}), lekin <b>jonli joylashuvni yoqmadi</b>. Yoqmaguncha unga bot yopiq.`);
        n += 1;
      }
      // agentning o'ziga — yoqmaguncha har 10 daqiqada (cron har 5 daq, shuning uchun 1 daq zaxira)
      const offSince = share ? ms(share.stopped_at) : ms(att.checked_in);
      const lastNudge = att.live_nudge_at && ms(att.live_nudge_at) > offSince ? ms(att.live_nudge_at) : offSince;
      const offMin = (nowMs - offSince) / 60000;
      if (offMin >= NUDGE_EVERY_MIN - 1 && (nowMs - lastNudge) / 60000 >= NUDGE_EVERY_MIN - 1) {
        await db.query('UPDATE attendance SET live_nudge_at = $1 WHERE id = $2', [stamp, att.id]);
        await notify().toUser(bot, e.tg_id, `⏰ <b>Joylashuvni yoqing!</b> (${time.prettyDuration(Math.round(offMin))} dan beri o'chiq)\n\n${blockedText(share)}${LIVE_PROMPT}`, noLiveKb());
        n += 1;
      }
      continue;
    }

    const age = (nowMs - ms(share.last_at)) / 60000;
    if (age >= gap && !share.gap_alert_at) {
      await db.query('UPDATE live_shares SET gap_alert_at = $1 WHERE id = $2', [stamp, share.id]);
      await notify().toAttendanceWatchers(bot, e,
        `⏳ <b>${esc(e.full_name)}</b> joylashuvi <b>${time.prettyDuration(Math.round(age))}dan beri</b> yangilanmayapti ` +
          `(internet yo'q, telefon o'chgan yoki telefon Telegram yopiq turganda joylashuv yubormayapti — iPhone'da ko'p uchraydi) · oxirgi joy: ${mapLink(share.last_lat, share.last_lon)}`,
        { link_preview_options: { is_disabled: true } });
      await notify().toUser(bot, e.tg_id, gapText(Math.round(age)));
      n += 1;
    }
  }
  return n;
};

module.exports = {
  FOREVER, isLive, untilOf, track, adopt, stopFor, latest, blockedText, NEVER_SENT_HINT, STATIC_HINT, byMessage, isActive, points, pathLength, stops, routeUrl,
  statusOf, kindText, KIND, ago, LIVE_PROMPT, BACKGROUND_TIPS, gapText, NOLIVE_BTN, noLiveKb, BLOCKED_TEXT, NUDGE_EVERY_MIN, offFor, mapLink, homeDist, startedText, onStopped, onResumed, onRestarted, hadTroubleToday, watch,
};
