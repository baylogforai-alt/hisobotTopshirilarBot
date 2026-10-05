'use strict';

const https = require('https');
const config = require('../config');
const extradays = require('../services/extradays');
const time = require('../time');
const ui = require('../ui');
const session = require('../session');
const access = require('../services/access');
const flows = require('../services/flows');
const employees = require('../services/employees');
const tasks = require('../services/tasks');
const attendance = require('../services/attendance');
const departments = require('../services/departments');
const branches = require('../services/branches');
const directions = require('../services/directions');
const kpi = require('../services/kpi');
const months = require('../services/months');
const requests = require('../services/requests');
const reminders = require('../services/reminders');
const worktime = require('../services/worktime');
const notify = require('../services/notify');
const office = require('../services/office');
const org = require('../services/org');
const excel = require('../services/excel');
const announcements = require('../services/announcements');
const chats = require('../services/chats');

/**
 * WEB APP API. Har bir handler: ({ actor, params, query, body, bot, res }) → JSON.
 * Huquqlar bot bilan bir xil (access.js, employees.canManage). Davomat nazoratchisi (isViewer) topshiriqlarni ko'rmaydi.
 * Pul (oklad, KPI summasi) — faqat direktor, HR va hodimning o'ziga.
 */

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const STREAMED = Symbol('streamed');

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
};
const match = (method, pathname) => {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  return null;
};

// ---------------------------------------------------------------------------
// TEKSHIRUVCHILAR
// ---------------------------------------------------------------------------
const deny = (msg = "Ruxsat yo'q") => { throw new HttpError(403, msg); };
const need = (cond, msg) => { if (!cond) deny(msg); };
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (msg = 'Topilmadi') => { throw new HttpError(404, msg); };

const id = (v, name = 'ID') => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) bad(`${name} noto'g'ri`);
  return n;
};
const text = (v, max, { required = true, name = 'Matn' } = {}) => {
  if (v === undefined || v === null) { if (required) bad(`${name} kerak`); return null; }
  if (typeof v !== 'string') bad(`${name} noto'g'ri`);
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!s && required) bad(`${name} bo'sh`);
  if (s.length > max) bad(`${name} juda uzun (ko'pi bilan ${max})`);
  return s || null;
};
const bool = (v, name) => { if (typeof v !== 'boolean') bad(`${name} — ha/yo'q bo'lishi kerak`); return v; };
const monthOf = (v) => { if (!time.isValidMonth(v)) bad("Oy noto'g'ri"); return v; };
const dueOf = (v) => {
  if (!time.isValidDate(v)) bad("Muddat noto'g'ri");
  if (v < time.today()) bad("Muddat o'tgan sana bo'lishi mumkin emas");
  if (v > time.addDays(time.today(), 366)) bad('Muddat juda uzoq');
  return v;
};
const moneyOf = (v, name) => {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) bad(`${name} noto'g'ri`);
  return n > 0 ? Math.round(n) : null;
};
/** Boshlanish soati 'HH:mm' (ixtiyoriy). Muddat bugun bo'lsa — o'tgan soat bo'lmasin */
const startOf = (v, due) => {
  if (v === undefined || v === null || v === '') return null;
  const t = tasks.normTime(v);
  if (!t) bad("Soat noto'g'ri (masalan 09:00)");
  if (tasks.startPassed(due, t)) bad("Bu soat o'tib ketgan");
  return t;
};
const prioOf = (v) => (v === undefined || v === null ? null : v === 'high' ? 'high' : v === 'normal' ? 'normal' : bad("Ustuvorlik noto'g'ri"));

const mustEmployee = (actor) => {
  if (!actor.employee) throw new HttpError(403, "Siz hodim sifatida ro'yxatda yo'qsiz — bu bo'lim hodimlar uchun", 'no_employee');
  return actor.employee;
};
/** Davomat / oylik — boshliq (kompaniya rahbari) uchun yuritilmaydi */
const mustStaff = (actor) => {
  const emp = mustEmployee(actor);
  if (employees.isBoss(emp)) throw new HttpError(403, 'Kompaniya rahbari uchun davomat va oylik yuritilmaydi', 'boss');
  return emp;
};

// ---------------------------------------------------------------------------
// KO'RINISHLAR (JSON shakllari)
// ---------------------------------------------------------------------------
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const empOut = (e, { money = false } = {}) => ({
  id: Number(e.id),
  tgId: Number(e.tg_id),
  name: e.full_name,
  position: e.position || null,
  username: e.username || null,
  role: e.role,
  isHr: Number(e.is_hr) === 1,
  isViewer: Number(e.can_view_att) === 1,
  active: Number(e.active) === 1,
  department: e.department_id ? { id: Number(e.department_id), name: e.department_name || null } : null,
  branch: e.branch_id ? { id: Number(e.branch_id), name: e.branch_name || null } : null,
  workMode: e.work_mode === 'field' ? 'field' : 'office',
  flexible: Number(e.flexible) === 1,
  videoRequired: Number(e.video_required) === 1,
  homeSet: Boolean(e.home_lat && e.home_lon),
  workStart: e.work_start || null,
  workEnd: e.work_end || null,
  title: employees.titleOf(e),
  icon: employees.personIcon(e),
  ...(money ? { salary: numOrNull(e.salary), bonusFund: numOrNull(e.bonus_fund) } : {}),
});

const taskOut = (t) => {
  const today = time.today();
  const doneDay = t.done_at ? String(t.done_at).slice(0, 10) : null;
  return {
    id: Number(t.id),
    title: t.title,
    status: t.status,
    priority: t.priority === 'high' ? 'high' : 'normal',
    source: t.source,
    due: t.due_date,
    createdAt: t.created_at,
    doneAt: t.done_at || null,
    overdue: t.status === 'active' && t.due_date < today,
    lateDone: Boolean(doneDay && doneDay > t.due_date),
    returned: Number(t.returned_count) || 0,
    reviewNote: t.review_note || null,
    proofType: t.proof_type || null,
    proofNote: t.proof_note || null,
    hasProof: Boolean(t.proof_file_id),
    media: t.task_file_id ? { type: t.task_media_type, name: t.task_file_name || null } : null,
    ackAt: t.ack_at || null,
    needsAck: tasks.needsAck(t),
    startTime: t.start_time || null,
    employee: { id: Number(t.employee_id), name: t.full_name },
  };
};

const todayOf = async (e) => {
  const today = time.today();
  const row = await attendance.get(e.id, today);
  let status = attendance.dayStatus(row, today, today, e);
  if (employees.isFlexible(e) && status === 'late') status = 'ontime';
  if (employees.isFlexible(e) && status === 'absent') status = 'excused';
  return {
    status,
    checkedIn: row && row.checked_in ? row.checked_in : null,
    checkedOut: row && row.checked_out ? row.checked_out : null,
    lateMinutes: row ? Number(row.late_minutes) || 0 : 0,
    lateNotice: Boolean(row && row.late_notice_at),
    lateReason: row && row.late_reason ? row.late_reason : null,
    excuse: row && row.excuse_status ? row.excuse_status : null,
  };
};

const kpiOut = (k, { money = false } = {}) => ({
  employeeId: Number(k.employee_id),
  name: k.full_name,
  position: k.position || null,
  department: k.department_name || null,
  customName: k.custom_name || null,
  month: k.month,
  tasks: { total: Number(k.tasks_total), ontime: Number(k.tasks_ontime), pct: Number(k.tasks_pct), returned: Number(k.tasks_returned) || 0, missed: Number(k.tasks_missed) || 0 },
  att: { workDays: Number(k.work_days), ontime: Number(k.ontime_days), late: Number(k.late_days), absent: Number(k.absent_days), excused: Number(k.excused_days), pct: Number(k.att_pct) },
  headScore: numOrNull(k.head_score),
  headNote: k.head_note || null,
  customPct: numOrNull(k.custom_pct),
  weights: { tasks: Number(k.w_tasks), att: Number(k.w_attendance), head: Number(k.w_head), custom: Number(k.w_custom) },
  total: Number(k.total),
  eligible: Number(k.kpi_eligible) === 1,
  fail: k.kpi_fail || null,
  status: k.status,
  note: k.note || null,
  gate: { attended: Number(k.ontime_days) + (Number(k.extra_days) || 0), required: numOrNull(k.required_days), extra: Number(k.extra_days) || 0, taskPct: numOrNull(k.tasks_gate_pct) },
  ...(money ? { bonusFund: numOrNull(k.bonus_fund), bonus: numOrNull(k.bonus_amount), salary: numOrNull(k.salary), pay: kpi.payOf(k) } : {}),
});

/** Rahbar/HR/direktor boshqaradigan faol hodimlar (o'zidan tashqari) */
const managedList = async (actor) => {
  const me = actor.employee ? Number(actor.employee.id) : -1;
  if (actor.seeAll) return (await employees.listActive()).filter((e) => Number(e.id) !== me);
  if (actor.isHead && actor.employee.department_id) return employees.teamOf(actor.employee);
  return [];
};

const loadEmp = async (empId) => {
  const e = await employees.byId(id(empId));
  if (!e) notFound('Hodim topilmadi');
  return e;
};

const loadTask = async (taskId) => {
  const t = await tasks.byId(id(taskId));
  if (!t || t.status === 'cancelled') notFound('Topshiriq topilmadi');
  return t;
};

/** Topshiriqni ko'rish: o'zi, tekshiruvchisi yoki direktor/HR (nazoratchi — yo'q) */
const canSeeTask = access.canSeeTask;

// ---------------------------------------------------------------------------
// ISBOT FAYLLARI (Telegram'dan oqim — bot tokeni brauzerga chiqmaydi)
// ---------------------------------------------------------------------------
const MIME = { photo: 'image/jpeg', video: 'video/mp4', video_note: 'video/mp4', voice: 'audio/ogg', audio: 'audio/mpeg', document: 'application/octet-stream' };
const MAX_STREAM = 20 * 1024 * 1024;

const streamProof = async (bot, res, proof) => {
  let link;
  try {
    link = await bot.telegram.getFileLink(proof.fileId);
  } catch (err) {
    const desc = String((err && err.description) || '');
    if (/too big/i.test(desc)) throw new HttpError(413, "Fayl katta (20 MB+) — «Botda ochish» tugmasini bosing", 'too_big');
    console.warn('[web] getFile xatosi:', desc || (err && err.message));
    throw new HttpError(502, "Faylni Telegram'dan olib bo'lmadi");
  }
  await new Promise((resolve, reject) => {
    const req = https.get(link, (up) => {
      const len = Number(up.headers['content-length'] || 0);
      if (up.statusCode !== 200 || len > MAX_STREAM) {
        up.resume();
        reject(new HttpError(502, "Faylni Telegram'dan olib bo'lmadi"));
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[proof.type] || 'application/octet-stream',
        ...(len ? { 'Content-Length': String(len) } : {}),
        'Cache-Control': 'private, max-age=600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      up.pipe(res);
      up.on('end', resolve);
      up.on('error', reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e instanceof HttpError ? e : new HttpError(502, "Faylni Telegram'dan olib bo'lmadi")));
  });
  return STREAMED;
};

// ===========================================================================
// MEN — bosh sahifa
// ===========================================================================
route('GET', '/api/me', async ({ actor }) => {
  const emp = actor.employee;
  const out = {
    tgId: actor.tgId,
    name: actor.name,
    company: config.companyName,
    today: time.today(),
    todayPretty: time.prettyDate(time.today()),
    workStart: worktime.get(), lateNoticeMin: config.lateNoticeMinBefore,
    lateGrace: config.lateGraceMinutes,
    kpiMode: config.kpiMode,
    roles: {
      isAdmin: actor.isAdmin, isHead: actor.isHead, isHr: actor.isHr, isManager: actor.isManager, isViewer: actor.isViewer, seeAll: actor.seeAll,
      isBoss: employees.isBoss(emp),
    },
    employee: emp ? empOut(emp, { money: true }) : null,
    doneNotify: actor.isHr ? employees.wantsDoneNotify(emp) : null,
    counts: {},
  };
  if (emp) {
    const open = await tasks.openFor(emp.id);
    const awaiting = await tasks.awaitingReviewFor(emp.id);
    out.counts.open = open.length;
    out.counts.overdue = open.filter((t) => t.due_date < time.today()).length;
    out.counts.awaiting = awaiting.length;
    if (!employees.isBoss(emp)) out.attendance = await todayOf(emp);
    out.monthConfirmed = employees.isBoss(emp) || !config.monthStartRequired || (await months.isConfirmed(emp.id));
    out.workStart = emp.work_start || worktime.get();
  }
  if (emp || actor.isAdmin) {
    // «⏳ Faol · 🕓 Kutilmoqda · ✅ Bajarilgan» plitkalari: hodim — o'ziniki, rahbar — bo'limi, boshliq/HR — hamma
    const st = {};
    for (const k of ['active', 'fix', 'review', 'accepted']) st[k] = (await access.tasksByKind(actor, k)).length;
    out.counts.status = st;
  }
  if (actor.isManager) {
    const list = tasks.visibleFor(actor, await tasks.pendingReview(actor.seeAll ? null : emp && emp.department_id));
    let n = 0;
    for (const t of list) if (access.canReview(actor, await employees.byId(t.employee_id))) n += 1;
    out.counts.review = n;
  }
  if (actor.isManager || actor.isHr) {
    let n = 0;
    for (const r of await attendance.pendingExcuses()) if (access.canDecideExcuse(actor, await employees.byId(r.employee_id))) n += 1;
    out.counts.excuses = n;
  }
  if (actor.isAdmin) {
    out.counts.reminders = (await employees.listActive()).filter((e) => e.remind_pending && !(emp && Number(e.id) === Number(emp.id))).length;
  }
  if (actor.isAdmin) out.counts.requests = (await requests.listPending()).length;
  return out;
});

// ===========================================================================
// TOPSHIRIQLAR
// ===========================================================================
/** Holat bo'yicha: ?kind=active|review|accepted&mine=1 — hodim o'ziniki, rahbar bo'limi, boshliq/HR hamma (HR — boshliq berganlarsiz) */
route('GET', '/api/tasks/status', async ({ actor, query }) => {
  need(actor.employee || actor.isAdmin, "Ruxsat yo'q");
  const kind = query.get('kind') || 'active';
  if (!['active', 'fix', 'review', 'accepted'].includes(kind)) bad("Holat noto'g'ri");
  const mine = query.get('mine') === '1' || !actor.isManager;
  const emp = !mine && query.get('emp') ? id(query.get('emp'), 'Hodim') : null;
  const counts = {};
  let list = [];
  for (const k of ['active', 'fix', 'review', 'accepted']) {
    const l = (await access.tasksByKind(actor, k, { mine })).filter((t) => !emp || Number(t.employee_id) === emp);
    counts[k] = l.length;
    if (k === kind) list = l;
  }
  const rc = await tasks.replyCounts();
  return {
    kind, mine, emp, empName: emp ? ((await employees.byId(emp)) || {}).full_name || null : null, canTeam: actor.isManager, counts, total: list.length,
    tasks: list.slice(0, 300).map((t) => ({
      ...taskOut(t), replies: rc.get(Number(t.id)) || 0, kind: t.status_kind, giverKind: t.giver_kind,
      giverName: t.giver_kind === 'self' ? null : t.giver_name || (t.giver_kind === 'admin' ? 'Direktor' : null),
    })),
  };
});

route('GET', '/api/tasks/my', async ({ actor }) => {
  const emp = mustEmployee(actor);
  const rc = await tasks.replyCounts();
  const out = (t) => ({ ...taskOut(t), replies: rc.get(Number(t.id)) || 0 });
  return {
    open: (await tasks.openFor(emp.id)).map(out),
    awaiting: (await tasks.awaitingReviewFor(emp.id)).map(out),
    accepted: (await tasks.acceptedSince(emp.id, time.addDays(time.today(), -30))).map(out),
  };
});

/** O'zimga vazifa: { text, due, priority? } — har qator alohida vazifa */
route('POST', '/api/tasks/self', async ({ actor, body, bot }) => {
  const emp = mustEmployee(actor);
  const titles = flows.splitTitles(text(body.text, 5000, { name: 'Vazifa matni' }));
  if (!titles.length) bad("Vazifa matni bo'sh");
  const due = dueOf(body.due);
  const created = await flows.addSelfTasks(bot, emp, titles, due, { priority: prioOf(body.priority), startTime: startOf(body.time, due) });
  return { created: created.map(taskOut) };
});

/** Topshiriq berish uchun: kimlarga bera olaman + guruhlash uchun bo'limlar, yo'nalishlar, rahbarlar */
route('GET', '/api/assign/targets', async ({ actor }) => {
  need(actor.isManager, "Topshiriq berish faqat rahbar, HR va direktor uchun");
  const list = await managedList(actor);
  const dirMap = new Map();
  if (actor.seeAll) {
    for (const r of await directions.listActive()) {
      for (const m of await directions.membersOf(r.id)) {
        if (!dirMap.has(Number(m.id))) dirMap.set(Number(m.id), []);
        dirMap.get(Number(m.id)).push(Number(r.id));
      }
    }
  }
  const people = [];
  for (const e of list) {
    const t = await todayOf(e);
    people.push({ ...empOut(e), directions: dirMap.get(Number(e.id)) || [], today: t.status });
  }
  const heads = actor.seeAll
    ? (await employees.listHeads()).map((h) => ({ id: Number(h.id), name: h.full_name, title: employees.titleOf(h), departmentId: numOrNull(h.department_id) }))
    : [];
  return {
    people,
    departments: actor.seeAll ? (await departments.listActive()).map((d) => ({ id: Number(d.id), name: d.name })) : [],
    directions: actor.seeAll ? (await directions.listActive()).map((r) => ({ id: Number(r.id), name: r.name, icon: r.icon || '🧭' })) : [],
    heads,
  };
});

/** { employeeIds:[...], text, due, priority? } — bir nechta hodimga bir xil topshiriq(lar) */
route('POST', '/api/tasks/assign', async ({ actor, body, bot }) => {
  need(actor.isManager, "Topshiriq berish faqat rahbar, HR va direktor uchun");
  if (!Array.isArray(body.employeeIds) || !body.employeeIds.length) bad('Kamida bitta hodimni tanlang');
  if (body.employeeIds.length > 100) bad("Juda ko'p hodim tanlangan");
  const ids = [...new Set(body.employeeIds.map((v) => id(v, 'Hodim')))];
  const titles = flows.splitTitles(text(body.text, 5000, { name: 'Topshiriq matni' }));
  if (!titles.length) bad("Topshiriq matni bo'sh");
  const due = dueOf(body.due);
  const priority = prioOf(body.priority);
  const startTime = startOf(body.time, due);
  const targets = [];
  for (const empId of ids) {
    const e = await employees.byId(empId);
    if (!e || !Number(e.active)) bad('Hodim topilmadi yoki ishdan ketgan');
    if (actor.employee && Number(e.id) === Number(actor.employee.id)) bad("O'zingizga — «O'zimga vazifa» orqali yozing");
    need(employees.canManage(actor.employee, actor.isAdmin, e), `${e.full_name} — sizning bo'limingiz emas`);
    targets.push(e);
  }
  const results = [];
  for (const e of targets) {
    const { created } = await flows.assignTasks(bot, actor, e, titles, due, { priority, startTime });
    results.push({ employeeId: Number(e.id), name: e.full_name, count: created.length });
  }
  return { results, due, startTime };
});

/** Tahrirlash: { title?, due?, priority? } */
route('PATCH', '/api/tasks/:id', async ({ actor, params, body }) => {
  const t = await loadTask(params.id);
  if (t.status !== 'active') bad('Topshiriq ochiq emas');
  need(access.canEditTask(actor, t), "Bu topshiriqni faqat bergan odam o'zgartira oladi");
  if (body.title !== undefined) {
    const p = flows.parseTitle(text(body.title, 500, { name: 'Matn' }));
    if (!p.title) bad("Matn bo'sh");
    await tasks.rename(t.id, p.title);
  }
  if (body.due !== undefined) {
    const due = dueOf(body.due);
    need(access.canSetDue(actor, t, due), access.DUE_LOCKED);
    await tasks.setDue(t.id, due);
  }
  if (body.priority !== undefined) await tasks.setPriority(t.id, prioOf(body.priority) || 'normal');
  return { task: taskOut(await tasks.byId(t.id)) };
});

route('DELETE', '/api/tasks/:id', async ({ actor, params, bot }) => {
  const t = await loadTask(params.id);
  if (!['active', 'done'].includes(t.status)) bad('Topshiriq yopilgan');
  need(access.canCancelTask(actor, t), "O'z topshirig'ingizni o'chirib bo'lmaydi — rahbaringiz bekor qiladi");
  await flows.cancelTask(bot, t, actor.employee ? actor.employee.id : null, actor.tgId);
  return { ok: true };
});

/** «Bajardim» — isbot botda: sessiya ochiladi, bot hodimdan rasm/video/audio so'raydi */
route('POST', '/api/tasks/:id/done', async ({ actor, params, bot }) => {
  const emp = mustEmployee(actor);
  const t = await loadTask(params.id);
  if (Number(t.employee_id) !== Number(emp.id)) deny();
  if (t.status !== 'active') bad('Topshiriq ochiq emas');
  if (await flows.doneBlocked(emp)) bad(`Avval «Keldim» bosing — ishga kelmasdan vazifani «Bajardim» qilib bo'lmaydi`);
  if (tasks.isBossOwn(emp, t)) {
    const own = await flows.completeBossTask(bot, emp, t.id, null);
    if (!own.ok) bad('Topshiriq ochiq emas');
    return { ok: true, accepted: true };
  }
  session.set(actor.tgId, { step: 'done_proof', doneTaskId: t.id });
  await notify.toUser(
    bot, actor.tgId,
    `📎 <b>${ui.esc(t.title)}</b>\n\n<b>Isbot majburiy:</b> 🖼 rasm, 🎥 video, 🎙 audio yoki 📄 fayl (PDF, Excel, Word…) yuboring — izohni ostiga yozsangiz bo'ladi.\nIsbotsiz bajarilgan deb qabul qilinmaydi.`,
    ui.proofKeyboard(),
  );
  return { ok: true };
});

/** Jurnal: hamma topshiriqlar — boshliq/direktor va HR. ?period=d|w|m|p&giver=&status=&emp=&from=&to= */
route('GET', '/api/tasks/all', async ({ actor, query }) => {
  need(actor.seeAll, 'Faqat direktor va HR');
  const today = time.today();
  const period = query.get('period') || 'w';
  let range;
  if (period === 'd') range = { from: today, to: today };
  else if (period === 'w') range = { from: time.addDays(today, -6), to: today };
  else if (period === 'p') range = time.monthRange(time.prevMonth());
  else if (period === 'm') range = { from: time.monthRange(time.month()).from, to: today };
  else bad("Davr noto'g'ri");
  const giver = query.get('giver') || null;
  if (giver && !['admin', 'hr', 'head', 'self'].includes(giver)) bad("Beruvchi noto'g'ri");
  const status = query.get('status') || null;
  if (status && !['open', 'review', 'accepted', 'overdue', 'cancelled'].includes(status)) bad("Holat noto'g'ri");
  const emp = query.get('emp') ? Number(query.get('emp')) : null;
  if (emp !== null && !Number.isInteger(emp)) bad("Hodim noto'g'ri");
  const list = tasks.visibleFor(actor, await tasks.journal({ ...range, employeeId: emp, giver, status }));
  const counts = { open: 0, review: 0, accepted: 0, overdue: 0, cancelled: 0 };
  for (const t of list) counts[t.status_kind] += 1;
  const rc = await tasks.replyCounts();
  return {
    from: range.from, to: range.to, counts, total: list.length,
    tasks: list.slice(0, 300).map((t) => ({
      ...taskOut(t), replies: rc.get(Number(t.id)) || 0, kind: t.status_kind, giverKind: t.giver_kind,
      giverName: t.giver_kind === 'self' ? null : t.giver_name || (t.giver_kind === 'admin' ? 'Direktor' : null),
    })),
    employees: (await employees.listActive()).map((e) => ({ id: Number(e.id), name: e.full_name })),
  };
});

/** Tekshiruvni kutayotganlar */
// ===========================================================================
// E'LONLAR — boshliq/direktor, HR (hammaga), bo'lim rahbari (o'z bo'limiga)
// ===========================================================================
const canAnnounce = (actor) => Boolean(actor.isAdmin || actor.isHr || actor.isHead);

route('GET', '/api/announce/targets', async ({ actor }) => {
  need(canAnnounce(actor), "E'lon — boshliq, direktor, HR va bo'lim rahbarlari uchun");
  return {
    people: (await managedList(actor)).map((e) => empOut(e)),
    departments: actor.seeAll ? (await departments.listActive()).map((d) => ({ id: Number(d.id), name: d.name })) : [],
  };
});

/** { to: 'all' | 'depts' | 'emps', ids?: [...], text } */
route('POST', '/api/announce', async ({ actor, body, bot }) => {
  need(canAnnounce(actor), "E'lon — boshliq, direktor, HR va bo'lim rahbarlari uchun");
  const msg = text(body.text, 3500, { name: "E'lon matni" });
  const list = await managedList(actor);
  let targets;
  let label;
  if (body.to === 'all') {
    targets = list;
    label = actor.seeAll ? 'Hammaga' : `Bo'limim: ${actor.employee.department_name || ''}`;
  } else if (body.to === 'depts' || body.to === 'emps') {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200) bad('Kamida bittasini tanlang');
    const ids = new Set(body.ids.map((v) => id(v)));
    if (body.to === 'depts') {
      need(actor.seeAll, "Bo'limlarga — faqat direktor va HR");
      targets = list.filter((e) => ids.has(Number(e.department_id)));
      const names = (await departments.listActive()).filter((d) => ids.has(Number(d.id))).map((d) => d.name);
      label = `Bo'lim${names.length > 1 ? 'lar' : ''}: ${names.join(', ')}`;
    } else {
      targets = list.filter((e) => ids.has(Number(e.id)));
      if (targets.length !== ids.size) deny("Ba'zi hodimlarga e'lon bera olmaysiz");
      label = targets.length === 1 ? targets[0].full_name : `Tanlanganlar: ${targets.map((e) => e.full_name).join(', ')}`.slice(0, 300);
    }
  } else bad("Kimga — noto'g'ri");
  if (!targets.length) bad("Qabul qiluvchi yo'q");
  const r = await flows.sendAnnouncement(bot, actor, targets, { body: msg, target: label });
  return { id: Number(r.announcement.id), total: r.total, delivered: r.delivered, target: label };
});

/** a — announcements qatori, st — announcements.stats() (total, delivered, read) */
const annOut = (a, st = {}) => ({
  id: Number(a.id), from: a.sender_name || null, text: a.text || null, mediaType: a.media_type || null, target: a.target || null, at: a.created_at,
  total: st.total, seen: st.read, delivered: st.delivered,
});
const loadAnn = async (actor, annId) => {
  const a = await announcements.byId(id(annId));
  if (!a) notFound("E'lon topilmadi");
  need(actor.seeAll || Number(a.created_by) === Number(actor.tgId));
  return a;
};

route('GET', '/api/announce', async ({ actor }) => {
  need(canAnnounce(actor), "E'lon — boshliq, direktor, HR va bo'lim rahbarlari uchun");
  const items = [];
  for (const a of await announcements.list(30, actor.seeAll ? null : actor.tgId)) items.push(annOut(a, await announcements.stats(a.id)));
  return { items };
});

route('GET', '/api/announce/:id', async ({ actor, params }) => {
  const a = await loadAnn(actor, params.id);
  const st = await announcements.stats(a.id);
  const recipients = st.rows.map((r) => ({ name: r.full_name, delivered: Number(r.delivered) === 1, seenAt: r.read_at || null }));
  return { announcement: annOut(a, st), recipients };
});

route('POST', '/api/announce/:id/resend', async ({ actor, params, bot }) => {
  const a = await loadAnn(actor, params.id);
  return { sent: await flows.resendAnnouncement(bot, a) };
});

// ===========================================================================
// «💬 SAVOL-JAVOB» — bitta odam, bir nechta, bo'lim(lar), hamma bilan (access.chatCandidates)
// ===========================================================================
const loadChat = async (actor, chatId) => {
  const c = await chats.byId(id(chatId));
  if (!c) notFound('Chat topilmadi');
  need(await chats.isParticipant(c, actor.tgId), 'Siz bu chatda emassiz');
  return c;
};
const chatMsgOut = (actor, c, m) => ({
  id: Number(m.id), fromName: m.from_name || null, fromTg: Number(m.from_tg), mine: Number(m.from_tg) === Number(actor.tgId),
  fromStarter: chats.isStarter(c, m.from_tg),
  to: m.to_tg ? (Number(m.to_tg) === Number(actor.tgId) ? 'me' : 'other') : 'all',
  text: m.body || null, media: m.file_id ? { type: m.media_type, name: m.file_name || null } : null, at: m.created_at,
});
const chatOut = (actor, c) => ({
  id: Number(c.id), target: c.target || null, title: c.title || null, mode: c.mode, at: c.created_at,
  starter: { tgId: Number(c.starter_tg), name: c.starter_name || null }, mine: chats.isStarter(c, actor.tgId),
  membersCount: c.members_count !== undefined ? Number(c.members_count) : undefined,
});
/** Xabarni shu odam ko'ra oladimi (starter rejimida — faqat o'ziniki / o'ziga / boshlovchining umumiy xabari) */
const canSeeChatMsg = (actor, c, m) => c.mode === 'all' || chats.isStarter(c, actor.tgId)
  || [m.from_tg, m.to_tg].some((x) => x && Number(x) === Number(actor.tgId)) || (!m.to_tg && chats.isStarter(c, m.from_tg));

route('GET', '/api/chats', async ({ actor }) => ({
  items: (await chats.listFor(actor.tgId, 30)).map((c) => chatOut(actor, c)),
}));

route('GET', '/api/chats/targets', async ({ actor }) => {
  const seeAll = Boolean(actor.isAdmin || actor.isHr);
  return {
    people: (await access.chatCandidates(actor)).map((e) => empOut(e)),
    departments: seeAll ? (await departments.listActive()).map((d) => ({ id: Number(d.id), name: d.name })) : [],
    canAll: seeAll || actor.isHead,
    canDepts: seeAll,
  };
});

/** Yangi chat: { to: 'emps' | 'depts' | 'all', ids?, mode: 'all' | 'starter', text } */
route('POST', '/api/chats', async ({ actor, body, bot }) => {
  const msg = text(body.text, 3500, { name: 'Xabar' });
  const seeAll = Boolean(actor.isAdmin || actor.isHr);
  const list = await access.chatCandidates(actor);
  let targets;
  let label;
  if (body.to === 'all') {
    need(seeAll || actor.isHead, "«Hamma bilan» — direktor, HR va bo'lim rahbari uchun");
    targets = seeAll ? list : await employees.teamOf(actor.employee);
    label = seeAll ? 'Hamma bilan' : `Bo'limim: ${actor.employee.department_name || ''}`;
  } else if (body.to === 'depts' || body.to === 'emps') {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200) bad('Kamida bittasini tanlang');
    const ids = new Set(body.ids.map((v) => id(v)));
    if (body.to === 'depts') {
      need(seeAll, "Bo'limlar bilan — faqat direktor va HR");
      targets = list.filter((e) => ids.has(Number(e.department_id)));
      const names = (await departments.listActive()).filter((d) => ids.has(Number(d.id))).map((d) => d.name);
      label = `Bo'lim${names.length > 1 ? 'lar' : ''}: ${names.join(', ')}`;
    } else {
      targets = list.filter((e) => ids.has(Number(e.id)));
      if (targets.length !== ids.size) deny("Ba'zi odamlar bilan chat ocha olmaysiz");
      label = targets.length === 1 ? `${targets[0].full_name} bilan` : `Tanlanganlar: ${targets.map((e) => e.full_name).join(', ')}`.slice(0, 300);
    }
  } else bad("Kim bilan — noto'g'ri");
  if (!targets.length) bad("Qabul qiluvchi yo'q");
  const mode = body.mode === 'starter' ? 'starter' : 'all';
  const r = await flows.startChat(bot, actor, targets, { target: label, mode, body: msg });
  return { id: Number(r.chat.id), total: r.total, delivered: r.delivered, target: label };
});

route('GET', '/api/chats/:id', async ({ actor, params }) => {
  const c = await loadChat(actor, params.id);
  const members = (await chats.members(c.id)).map((m) => ({
    tgId: Number(m.tg_id), name: m.name, username: m.username || null, delivered: Number(m.delivered) === 1,
    icon: employees.personIcon(m), title: m.position || (Number(m.is_hr) === 1 ? 'HR' : null),
  }));
  const starterEmp = await employees.byTgId(c.starter_tg);
  return {
    chat: chatOut(actor, c),
    starter: { tgId: Number(c.starter_tg), name: c.starter_name || null, username: starterEmp && starterEmp.username ? starterEmp.username : null },
    members,
    messages: (await chats.messagesFor(c, actor.tgId, 50)).map((m) => chatMsgOut(actor, c, m)),
  };
});

/** Xabar / javob: { text, replyTo? } — replyTo: kimning xabariga (starter rejimida boshlovchi shu odamga shaxsan yozadi) */
route('POST', '/api/chats/:id/messages', async ({ actor, params, body, bot }) => {
  const c = await loadChat(actor, params.id);
  const msg = text(body.text, 3500, { name: 'Xabar' });
  let replyMsg = null;
  if (body.replyTo !== undefined && body.replyTo !== null) {
    replyMsg = await chats.messageById(id(body.replyTo));
    if (!replyMsg || Number(replyMsg.chat_id) !== Number(c.id) || !canSeeChatMsg(actor, c, replyMsg)) notFound('Xabar topilmadi');
  }
  const r = await flows.sendChatMessage(bot, actor, c, { body: msg, replyMsg });
  return { message: chatMsgOut(actor, c, r.message), total: r.total, delivered: r.delivered };
});

const loadChatMedia = async (actor, chatId, msgId) => {
  const c = await loadChat(actor, chatId);
  const m = await chats.messageById(id(msgId));
  if (!m || Number(m.chat_id) !== Number(c.id) || !canSeeChatMsg(actor, c, m)) notFound('Xabar topilmadi');
  if (!m.file_id) notFound("Media yo'q");
  return m;
};
route('GET', '/api/chats/:id/messages/:msg/media', async ({ actor, params, bot, res }) => {
  const m = await loadChatMedia(actor, params.id, params.msg);
  return streamProof(bot, res, { type: m.media_type, fileId: m.file_id });
});
route('POST', '/api/chats/:id/messages/:msg/media/send', async ({ actor, params, bot }) => {
  const m = await loadChatMedia(actor, params.id, params.msg);
  await notify.sendProof(bot, actor.tgId, { type: m.media_type, fileId: m.file_id }, `💬 ${ui.esc(m.from_name || '')}${m.body ? `: ${ui.esc(m.body)}` : ''}`);
  return { ok: true };
});

/**
 * Lichka havolasi botga (username yo'q odam uchun — Mini App tg://user ni ocha olmaydi).
 * { tgId, chatId? | taskId? } — faqat gaplasha oladigan odam, chatdoshi yoki topshiriq bo'yicha suhbatdoshi.
 */
route('POST', '/api/contact', async ({ actor, body, bot }) => {
  const tgId = id(body.tgId, 'tgId');
  let name = null;
  const cand = (await access.chatCandidates(actor)).find((e) => Number(e.tg_id) === tgId);
  if (cand) name = cand.full_name;
  if (!name && body.chatId !== undefined && body.chatId !== null) {
    const c = await loadChat(actor, body.chatId);
    if (chats.isStarter(c, tgId)) name = c.starter_name;
    else { const m = (await chats.members(c.id)).find((x) => Number(x.tg_id) === tgId); if (m) name = m.name; }
  }
  if (!name && body.taskId !== undefined && body.taskId !== null) {
    const t = await loadTask(body.taskId);
    if (access.canReplyTask(actor, t, await employees.byId(t.employee_id)) && flows.taskReplyTarget(actor, t) === tgId) {
      const e = await employees.byTgId(tgId);
      name = e ? e.full_name : 'Rahbariyat';
    }
  }
  if (!name) deny();
  const e = await employees.byTgId(tgId);
  await notify.toUser(bot, actor.tgId, `👤 Lichkaga o'tish — ismni bosing: ${e ? employees.contactHtml(e) : flows.personLink(tgId, name)}`);
  return { ok: true };
});

// --- qaytarilgan topshiriq bo'yicha yozishma ---
const replyOut = (actor, r) => ({
  id: Number(r.id), fromName: r.from_name || null, mine: Number(r.from_tg) === Number(actor.tgId),
  text: r.body || null, mediaType: r.media_type || null, at: r.created_at,
});

route('GET', '/api/tasks/:id/replies', async ({ actor, params }) => {
  const t = await loadTask(params.id);
  const emp = await employees.byId(t.employee_id);
  const canWrite = access.canReplyTask(actor, t, emp);
  need(canWrite || (await canSeeTask(actor, t)), "Ruxsat yo'q");
  const toTg = canWrite ? flows.taskReplyTarget(actor, t) : null;
  const to = toTg ? await employees.byTgId(toTg) : null;
  return {
    replies: (await tasks.replies(t.id)).map((r) => replyOut(actor, r)),
    canWrite: Boolean(canWrite && toTg),
    to: toTg ? { tgId: toTg, name: to ? to.full_name : 'Rahbariyat', username: to && to.username ? to.username : null } : null,
  };
});

/** { text } — hodim → qaytargan (bergan) odamga; tekshiruvchi → hodimga */
route('POST', '/api/tasks/:id/replies', async ({ actor, params, body, bot }) => {
  const t = await loadTask(params.id);
  need(access.canReplyTask(actor, t, await employees.byId(t.employee_id)), "Bu topshiriq bo'yicha yoza olmaysiz");
  const toTg = flows.taskReplyTarget(actor, t);
  if (!toTg) bad('Kimga yozishni aniqlab bo\'lmadi');
  const msg = text(body.text, 2000, { name: 'Javob' });
  const r = await flows.sendTaskReply(bot, actor, t, toTg, { body: msg });
  return { reply: replyOut(actor, r.reply), delivered: r.delivered };
});

/** HR: «Bajardim» xabarlari o'ziga kelsinmi. { on: true|false } */
route('POST', '/api/me/done-notify', async ({ actor, body }) => {
  need(actor.isHr && actor.employee, 'Faqat HR uchun');
  const on = bool(body.on, 'on');
  await employees.setNotifyDone(actor.employee.id, on);
  return { doneNotify: on };
});

route('GET', '/api/review', async ({ actor }) => {
  need(actor.isManager, 'Faqat rahbar va direktor uchun');
  const list = tasks.visibleFor(actor, await tasks.pendingReview(actor.seeAll ? null : actor.employee && actor.employee.department_id));
  const out = [];
  for (const t of list) if (access.canReview(actor, await employees.byId(t.employee_id))) out.push(taskOut(t));
  return { tasks: out };
});

const reviewTask = async (actor, taskId) => {
  const t = await loadTask(taskId);
  if (t.status !== 'done') throw new HttpError(409, "Bu ish allaqachon ko'rib chiqilgan");
  need(access.canReview(actor, await employees.byId(t.employee_id)) && tasks.visibleTo(actor, t), "Bu sizning bo'limingiz emas");
  return t;
};

route('POST', '/api/tasks/:id/accept', async ({ actor, params, bot }) => {
  const t = await reviewTask(actor, params.id);
  const res = await flows.acceptTask(bot, t.id, actor.tgId);
  if (!res.ok) throw new HttpError(409, "Bu ish allaqachon ko'rib chiqilgan");
  return { task: taskOut(res.task), onTime: res.onTime };
});

route('POST', '/api/tasks/:id/return', async ({ actor, params, body, bot }) => {
  const t = await reviewTask(actor, params.id);
  const note = text(body.note, 300, { name: 'Kamchiliklar' });
  // hodim kech topshirgan bo'lsa — tekshiruvchi tanlaydi: kechikish KPI da qolsinmi (countLate)
  // 5-okt: fixDue — tuzatish muddati (bugun yoki keyin); berilmasa eski muddat qoladi
  let fixDue = null;
  if (body.fixDue) {
    fixDue = time.parseDate(String(body.fixDue)) || (/^\d{4}-\d{2}-\d{2}$/.test(String(body.fixDue)) ? String(body.fixDue) : null);
    if (!fixDue || fixDue < time.today()) bad("Tuzatish muddati noto'g'ri (bugun yoki keyingi sana)");
  }
  const res = await flows.returnTask(bot, t.id, actor.tgId, note, { countLate: body.countLate === true && tasks.submittedLate(t), fixDue });
  if (!res.ok) throw new HttpError(409, "Bu ish allaqachon ko'rib chiqilgan");
  return { task: taskOut(res.task) };
});

/** Isbot faylini ko'rish (oqim) */
route('GET', '/api/tasks/:id/proof', async ({ actor, params, bot, res }) => {
  const t = await loadTask(params.id);
  need(await canSeeTask(actor, t), "Ruxsat yo'q");
  if (!t.proof_file_id) notFound("Isbot yo'q");
  return streamProof(bot, res, { type: t.proof_type, fileId: t.proof_file_id });
});

/** Topshiriqning o'zi (ovoz / video / fayl) — oqim */
route('GET', '/api/tasks/:id/media', async ({ actor, params, bot, res }) => {
  const t = await loadTask(params.id);
  need(await canSeeTask(actor, t), "Ruxsat yo'q");
  if (!t.task_file_id) notFound("Topshiriq media'si yo'q");
  return streamProof(bot, res, { type: t.task_media_type, fileId: t.task_file_id });
});

/** Topshiriq media'sini botga yuborish (katta fayl uchun) */
route('POST', '/api/tasks/:id/media/send', async ({ actor, params, bot }) => {
  const t = await loadTask(params.id);
  need(await canSeeTask(actor, t), "Ruxsat yo'q");
  if (!t.task_file_id) notFound("Topshiriq media'si yo'q");
  const mine = actor.employee && Number(t.employee_id) === Number(actor.employee.id);
  await flows.sendTaskMedia(bot, actor.tgId, t, mine && tasks.needsAck(t) ? ui.inline(ui.ackRows([t])) : {});
  return { ok: true };
});

/** «Eshitdim, tushundim» — faqat o'z topshirig'i */
route('POST', '/api/tasks/:id/ack', async ({ actor, params, bot }) => {
  const emp = mustEmployee(actor);
  const t = await loadTask(params.id);
  if (Number(t.employee_id) !== Number(emp.id)) deny();
  if (!tasks.needsAck(t)) bad('Tasdiqlash kerak emas yoki allaqachon tasdiqlangan');
  await flows.ackTasks(bot, emp, [t.id]);
  return { ok: true };
});

/** Isbotni botga yuborish (katta video uchun) — tekshiruvchiga qabul/qaytarish tugmalari bilan */
route('POST', '/api/tasks/:id/proof/send', async ({ actor, params, bot }) => {
  const t = await loadTask(params.id);
  need(await canSeeTask(actor, t), "Ruxsat yo'q");
  if (!t.proof_file_id) notFound("Isbot yo'q");
  const canRv = t.status === 'done' && access.canReview(actor, await employees.byId(t.employee_id));
  await notify.sendProof(
    bot, actor.tgId, { type: t.proof_type, fileId: t.proof_file_id },
    `🕓 <b>${ui.esc(t.full_name)}</b>: <b>${ui.esc(t.title)}</b>${t.proof_note ? `\n💬 «${ui.esc(t.proof_note)}»` : ''}`,
    canRv ? ui.reviewKeyboard(t.id) : {},
  );
  return { ok: true };
});

// ===========================================================================
// DAVOMAT (hodimning o'zi)
// ===========================================================================
route('POST', '/api/att/late', async ({ actor, body, bot }) => {
  const emp = mustStaff(actor);
  if (await attendance.isCheckedIn(emp.id)) bad('Siz bugun allaqachon kelgansiz');
  const reason = text(body.reason, 300, { name: 'Sabab' });
  const { inTime } = await flows.lateNotice(bot, emp, reason);
  return { inTime, recipients: await org.recipientsLabel(emp), minBefore: config.lateNoticeMinBefore };
});

route('POST', '/api/att/absence', async ({ actor, body, bot }) => {
  const emp = mustStaff(actor);
  if (await attendance.isCheckedIn(emp.id)) bad('Siz bugun allaqachon kelgansiz');
  const row = await attendance.get(emp.id);
  if (row && row.excuse_status === 'approved') bad('Bugungi kun allaqachon sababli deb belgilangan');
  const reason = text(body.reason, 300, { name: 'Sabab' });
  const { auto } = await flows.requestAbsence(bot, emp, reason);
  return { recipients: await org.recipientsLabel(emp), auto };
});

route('POST', '/api/att/checkout', async ({ actor, bot }) => {
  const emp = mustStaff(actor);
  if (!(await attendance.isCheckedIn(emp.id))) bad("Bugun «Keldim» qilmagansiz");
  if (await attendance.isCheckedOut(emp.id)) bad('Ketganingiz allaqachon belgilangan');
  // «Ketdim» — lokatsiya + izoh bilan, faqat botda: bot so'raydi, ilova yopiladi
  session.set(actor.tgId, { step: 'awaiting_checkout_location' });
  await notify.toUser(bot, actor.tgId, flows.CHECKOUT_PROMPT, ui.locationKeyboard());
  return { viaBot: true };
});

/** Oy boshini tasdiqlash (Keldim ochiladi) */
route('POST', '/api/month/confirm', async ({ actor }) => {
  const emp = mustStaff(actor);
  const { row } = await months.confirm(emp.id, time.month());
  return { confirmedAt: row.confirmed_at };
});

// ===========================================================================
// HODIMLAR
// ===========================================================================
route('GET', '/api/employees', async ({ actor, query }) => {
  need(actor.isManager || actor.seeAll, "Faqat rahbar, HR va direktor uchun");
  const money = actor.seeAll;
  const kpiMoney = !money && actor.isHead && (await org.headSeesMoney());
  let list;
  if (actor.isAdmin && query.get('all') === '1') list = await employees.listAll();
  else if (actor.seeAll) list = await employees.listActive();
  else list = await employees.teamOf(actor.employee);
  const { from, to } = time.monthRange(time.month());
  const out = [];
  for (const e of list) {
    const item = { ...empOut(e, { money }) };
    if (kpiMoney) item.bonusFund = numOrNull(e.bonus_fund);
    if (Number(e.active)) {
      item.today = (await todayOf(e)).status;
      item.attPct = (await attendance.stats(e, from, to)).pct;
      item.openTasks = (await tasks.openFor(e.id)).length;
    }
    out.push(item);
  }
  return {
    employees: out,
    departments: (await departments.listActive()).map((d) => ({ id: Number(d.id), name: d.name })),
  };
});

route('GET', '/api/employees/:id', async ({ actor, params }) => {
  const e = await loadEmp(params.id);
  const self = actor.employee && Number(actor.employee.id) === Number(e.id);
  need(self || actor.seeAll || (actor.isManager && employees.canManage(actor.employee, actor.isAdmin, e)), "Bu hodimni ko'ra olmaysiz");
  const { from, to } = time.monthRange(time.month());
  const ts = await tasks.stats(e.id, from, to);
  const at = await attendance.stats(e, from, to);
  return {
    employee: empOut(e, { money: actor.seeAll || self }),
    today: await todayOf(e),
    month: time.month(),
    monthName: time.monthName(time.month()),
    tasksStats: { total: ts.total, ontime: ts.ontime, pct: ts.pct, overdue: ts.overdue, open: ts.open, returns: ts.returns, missed: ts.missed },
    attStats: { workDays: at.workDays, ontime: at.ontime, late: at.late, absent: at.absent, excused: at.excused, pct: at.pct },
    open: tasks.visibleFor(actor, await tasks.openFor(e.id)).map(taskOut),
    awaiting: tasks.visibleFor(actor, await tasks.awaitingReviewFor(e.id)).map(taskOut),
    directions: (await directions.ofEmployee(e.id)).map((r) => ({ id: Number(r.id), name: r.name, icon: r.icon || '🧭' })),
    remind: { times: e.remind_times ? reminders.listOf(e.remind_times) : null, pending: e.remind_pending ? reminders.listOf(e.remind_pending) : null },
    can: {
      edit: actor.isAdmin,
      assign: actor.isManager && !self && employees.canManage(actor.employee, actor.isAdmin, e),
      viewer: actor.seeAll,
      directions: actor.seeAll,
    },
  };
});

const ROLE_NEW = ['employee', 'head', 'hr', 'admin'];

/** Yangi hodim (direktor): { tgId, fullName, position?, departmentId?, role } */
route('POST', '/api/employees', async ({ actor, body, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const tgId = id(body.tgId, 'Telegram ID');
  if (String(tgId).length < 5 || String(tgId).length > 15) bad("Telegram ID noto'g'ri");
  const fullName = text(body.fullName, 100, { name: 'Ism' });
  const position = text(body.position, 60, { required: false, name: 'Lavozim' });
  let departmentId = null;
  if (body.departmentId !== undefined && body.departmentId !== null) {
    const d = await departments.byId(id(body.departmentId, "Bo'lim"));
    if (!d || !Number(d.active)) bad("Bo'lim topilmadi");
    departmentId = Number(d.id);
  }
  if (!ROLE_NEW.includes(body.role)) bad("Rol noto'g'ri");
  const existing = await employees.byTgId(tgId);
  if (existing && Number(existing.active)) throw new HttpError(409, `Bu ID allaqachon ro'yxatda: ${existing.full_name}`);
  const isHr = body.role === 'hr';
  const req = await requests.pendingOf(tgId);
  const { employee } = await employees.add({
    tgId, fullName, position: position || (isHr ? 'HR' : null), role: isHr ? 'head' : body.role, departmentId,
    username: existing ? existing.username : req ? req.username : null, isHr,
  });
  await requests.closeFor(tgId, 'approved', actor.tgId);
  await flows.welcome(bot, employee);
  return { employee: empOut(employee, { money: true }) };
});

/** Kartochkani o'zgartirish. Direktor — hammasi; HR — faqat «davomat nazorati» ruxsati */
route('PATCH', '/api/employees/:id', async ({ actor, params, body, bot }) => {
  const e = await loadEmp(params.id);
  const keys = Object.keys(body);
  if (!keys.length) bad("O'zgarish yo'q");
  if (!actor.isAdmin) need(actor.isHr && keys.every((k) => k === 'isViewer'), 'Faqat direktor');
  const self = actor.employee && Number(actor.employee.id) === Number(e.id);
  if (self && (keys.includes('role') || keys.includes('active'))) bad("O'zingizning rolingiz va holatingizni o'zgartira olmaysiz");
  const ALLOWED = ['name', 'position', 'departmentId', 'branchId', 'role', 'isHr', 'isViewer', 'flexible', 'workMode', 'videoRequired', 'salary', 'bonusFund', 'workStart', 'workEnd', 'active'];
  for (const k of keys) if (!ALLOWED.includes(k)) bad(`Noma'lum maydon: ${k}`);

  if ('name' in body) await employees.rename(e.id, text(body.name, 100, { name: 'Ism' }));
  if ('position' in body) await employees.setPosition(e.id, text(body.position, 60, { required: false, name: 'Lavozim' }));
  if ('departmentId' in body) {
    let dep = null;
    if (body.departmentId !== null) {
      const d = await departments.byId(id(body.departmentId, "Bo'lim"));
      if (!d || !Number(d.active)) bad("Bo'lim topilmadi");
      dep = Number(d.id);
    }
    await employees.setDepartment(e.id, dep);
  }
  if ('branchId' in body) {
    let br = null;
    if (body.branchId !== null) {
      const b = await branches.byId(id(body.branchId, 'Filial'));
      if (!b || !Number(b.active)) bad('Filial topilmadi');
      br = Number(b.id);
    }
    await employees.setBranch(e.id, br);
  }
  if ('flexible' in body) await employees.setFlexible(e.id, bool(body.flexible, 'Erkin jadval'));
  if ('videoRequired' in body) await employees.setVideoRequired(e.id, bool(body.videoRequired, 'Video'));
  if ('salary' in body) await employees.setSalary(e.id, moneyOf(body.salary, 'Oklad'));
  if ('bonusFund' in body) await employees.setBonusFund(e.id, moneyOf(body.bonusFund, 'KPI summasi'));
  if ('workStart' in body) {
    if (body.workStart === null || body.workStart === '') await employees.setWorkStart(e.id, null);
    else {
      const hhmm = employees.parseWorkStart(text(body.workStart, 5, { name: 'Ish boshlanishi' }));
      if (!hhmm) bad('Vaqt HH:mm ko\'rinishida bo\'lsin (masalan 09:00)');
      await employees.setWorkStart(e.id, hhmm);
    }
  }
  if ('workEnd' in body) {
    if (body.workEnd === null || body.workEnd === '') await employees.setWorkEnd(e.id, null);
    else {
      const hhmm = employees.parseWorkStart(text(body.workEnd, 5, { name: 'Ish tugashi' }));
      if (!hhmm) bad('Vaqt HH:mm ko\'rinishida bo\'lsin (masalan 19:00)');
      await employees.setWorkEnd(e.id, hhmm);
    }
  }
  if ('isViewer' in body) await employees.setViewer(e.id, bool(body.isViewer, 'Davomat nazorati'));
  if ('role' in body) {
    if (!['employee', 'head', 'admin'].includes(body.role)) bad("Rol noto'g'ri");
    if (body.role !== e.role) {
      await employees.setRole(e.id, body.role);
      await flows.roleNotice(bot, await employees.byId(e.id));
    }
  }
  if ('isHr' in body) {
    const on = bool(body.isHr, 'HR');
    if (on !== (Number(e.is_hr) === 1)) {
      await employees.setHr(e.id, on);
      if (on) await flows.hrNotice(bot, await employees.byId(e.id));
    }
  }
  if ('workMode' in body) {
    if (!['office', 'field'].includes(body.workMode)) bad("Ish turi noto'g'ri");
    if (body.workMode !== (e.work_mode === 'field' ? 'field' : 'office')) {
      await employees.setWorkMode(e.id, body.workMode);
      await flows.modeNotice(bot, await employees.byId(e.id));
    }
  }
  if ('active' in body) {
    const on = bool(body.active, 'Holat');
    if (on !== (Number(e.active) === 1)) await flows.setActive(bot, e, on);
  }
  return { employee: empOut(await employees.byId(e.id), { money: true }) };
});

/** Direktor kunni sababli deb belgilaydi: { date, reason? } */
route('POST', '/api/employees/:id/excuse', async ({ actor, params, body, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const e = await loadEmp(params.id);
  if (!time.isValidDate(body.date)) bad("Sana noto'g'ri");
  await flows.markExcused(bot, e, body.date, actor.tgId, text(body.reason, 300, { required: false, name: 'Sabab' }));
  return { ok: true };
});

route('POST', '/api/employees/:id/clear-home', async ({ actor, params, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const e = await loadEmp(params.id);
  await employees.clearHome(e.id);
  await flows.homeClearedNotice(bot, e);
  return { ok: true };
});

/** Hodimning yo'nalishi (HR / direktor) — almashtirish */
route('POST', '/api/employees/:id/directions/:dirId', async ({ actor, params }) => {
  need(actor.seeAll, 'Faqat direktor va HR');
  const e = await loadEmp(params.id);
  const r = await directions.byId(id(params.dirId, "Yo'nalish"));
  if (!r || !Number(r.active)) notFound("Yo'nalish topilmadi");
  const on = await directions.toggle(e.id, r.id);
  return { on };
});

// --- qo'shilish so'rovlari ---
route('GET', '/api/requests', async ({ actor }) => {
  need(actor.isAdmin, 'Faqat direktor');
  return { requests: (await requests.listPending()).map((r) => ({ id: Number(r.id), tgId: Number(r.tg_id), name: r.full_name, username: r.username || null, createdAt: r.created_at })) };
});

route('POST', '/api/requests/:id/reject', async ({ actor, params, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const r = await requests.byId(id(params.id));
  if (!r || r.status !== 'pending') notFound("So'rov topilmadi");
  await requests.decide(r.id, 'rejected', actor.tgId);
  await notify.toUser(bot, r.tg_id, `Kechirasiz, so'rovingiz rad etildi.`);
  return { ok: true };
});

// ===========================================================================
// TASHKILOT: bo'limlar, filiallar, yo'nalishlar
// ===========================================================================
route('GET', '/api/org', async ({ actor }) => {
  need(actor.seeAll, 'Faqat direktor va HR');
  const deps = [];
  for (const d of await departments.listActive()) {
    deps.push({
      id: Number(d.id), name: d.name, customName: d.custom_name || null,
      weights: { tasks: Number(d.w_tasks), att: Number(d.w_attendance), head: Number(d.w_head), custom: Number(d.w_custom) },
      members: await departments.memberCount(d.id),
      heads: (await departments.headsOf(d.id)).map((h) => h.full_name),
    });
  }
  const brs = [];
  for (const b of await branches.listActive()) {
    const off = branches.officeOfBranch(b);
    brs.push({ id: Number(b.id), name: b.name, officeSet: Boolean(off), radius: off ? off.radius : Number(b.radius_m) || null, members: await branches.memberCount(b.id) });
  }
  const dirs = [];
  for (const r of await directions.listActive()) {
    dirs.push({ id: Number(r.id), name: r.name, icon: r.icon || '🧭', members: (await directions.membersOf(r.id)).map((m) => ({ id: Number(m.id), name: m.full_name })) });
  }
  const main = await office.get();
  return { departments: deps, branches: brs, directions: dirs, office: main ? { radius: main.radius } : null, canEdit: actor.isAdmin };
});

const weightsOf = (w) => {
  if (!Array.isArray(w) || w.length !== 4) bad("Vaznlar: 4 ta son kerak");
  const s = departments.parseWeights(w.map((n) => (Number.isInteger(n) ? n : NaN)).join(' '));
  if (!s) bad("Vaznlar 0–100 butun son, yig'indisi 100 bo'lsin");
  return s;
};

route('POST', '/api/departments', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const { department, created } = await departments.create(text(body.name, 60, { name: "Bo'lim nomi" }));
  return { id: Number(department.id), created };
});

route('PATCH', '/api/departments/:id', async ({ actor, params, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const d = await departments.byId(id(params.id));
  if (!d || !Number(d.active)) notFound("Bo'lim topilmadi");
  if ('name' in body) await departments.rename(d.id, text(body.name, 60, { name: 'Nomi' }));
  if ('customName' in body) await departments.setCustomName(d.id, text(body.customName, 60, { required: false, name: 'Mezon nomi' }));
  if ('weights' in body) await departments.setWeights(d.id, weightsOf(body.weights));
  return { ok: true };
});

route('DELETE', '/api/departments/:id', async ({ actor, params }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const d = await departments.byId(id(params.id));
  if (!d || !Number(d.active)) notFound("Bo'lim topilmadi");
  await departments.deactivate(d.id);
  return { ok: true };
});

route('POST', '/api/branches', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const { branch, created } = await branches.create(text(body.name, 60, { name: 'Filial nomi' }));
  return { id: Number(branch.id), created };
});

route('PATCH', '/api/branches/:id', async ({ actor, params, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const b = await branches.byId(id(params.id));
  if (!b || !Number(b.active)) notFound('Filial topilmadi');
  if ('name' in body) await branches.rename(b.id, text(body.name, 60, { name: 'Nomi' }));
  if ('radius' in body) {
    const r = Number(body.radius);
    if (!Number.isInteger(r) || r < 30 || r > 5000) bad("Radius 30–5000 metr oralig'ida");
    await branches.setRadius(b.id, r);
  }
  return { ok: true };
});

route('DELETE', '/api/branches/:id', async ({ actor, params }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const b = await branches.byId(id(params.id));
  if (!b || !Number(b.active)) notFound('Filial topilmadi');
  await branches.deactivate(b.id);
  return { ok: true };
});

route('POST', '/api/directions', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const { direction, created } = await directions.create(text(body.name, 40, { name: "Yo'nalish nomi" }));
  return { id: Number(direction.id), created };
});

route('PATCH', '/api/directions/:id', async ({ actor, params, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const r = await directions.byId(id(params.id));
  if (!r || !Number(r.active)) notFound("Yo'nalish topilmadi");
  await directions.rename(r.id, text(body.name, 40, { name: 'Nomi' }));
  return { ok: true };
});

route('DELETE', '/api/directions/:id', async ({ actor, params }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const r = await directions.byId(id(params.id));
  if (!r || !Number(r.active)) notFound("Yo'nalish topilmadi");
  await directions.deactivate(r.id);
  return { ok: true };
});

// ===========================================================================
// KPI (direktor — tahrir/tasdiq; HR — ko'rish)
// ===========================================================================
route('GET', '/api/kpi/:month', async ({ actor, params }) => {
  need(actor.seeAll, 'Faqat direktor va HR');
  const month = monthOf(params.month);
  if (month > time.month()) bad('Kelajakdagi oy');
  const rows = await kpi.computeAll(month);
  return {
    month, monthName: time.monthName(month), current: month === time.month(), canEdit: actor.isAdmin, kpiMode: config.kpiMode,
    rows: rows.map((k) => kpiOut(k, { money: true })),
  };
});

route('GET', '/api/kpi/:month/:empId', async ({ actor, params }) => {
  need(actor.seeAll, 'Faqat direktor va HR');
  const month = monthOf(params.month);
  const e = await loadEmp(params.empId);
  const k = await kpi.compute(e, month);
  return {
    kpi: kpiOut(k, { money: true }),
    monthName: time.monthName(month),
    canEdit: actor.isAdmin,
    returnPenalty: config.returnPenaltyPct,
    gate: await kpi.gateSettings(),
  };
});

/** { headScore?, headNote?, customPct?, bonusFund?, note? } — faqat «kutmoqda» holatida */
route('PATCH', '/api/kpi/:month/:empId', async ({ actor, params, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const month = monthOf(params.month);
  const e = await loadEmp(params.empId);
  const cur = await kpi.compute(e, month);
  if (cur.status !== 'draft') throw new HttpError(409, 'Avval «Qaytadan ochish» — tasdiqlangan natija o\'zgarmaydi');
  if ('headScore' in body || 'headNote' in body) {
    let score = 'headScore' in body ? body.headScore : numOrNull(cur.head_score);
    if (score !== null) { score = Number(score); if (!Number.isInteger(score) || score < 1 || score > 10) bad('Baho 1–10'); }
    const note = 'headNote' in body ? text(body.headNote, 300, { required: false, name: 'Izoh' }) : cur.head_note;
    await kpi.setHeadScore(e.id, month, score, note);
  }
  if ('customPct' in body) {
    let pct = body.customPct;
    if (pct !== null) { pct = Number(pct); if (!Number.isFinite(pct) || pct < 0 || pct > 100) bad('Mezon 0–100'); }
    await kpi.setCustomPct(e.id, month, pct);
  }
  if ('bonusFund' in body) await kpi.setBonusFund(e.id, month, moneyOf(body.bonusFund, 'KPI summasi'));
  if ('note' in body) await kpi.setNote(e.id, month, text(body.note, 500, { required: false, name: 'Izoh' }));
  return { kpi: kpiOut(await kpi.get(e.id, month), { money: true }) };
});

/** { status: confirmed | excluded | draft, note? } */
route('POST', '/api/kpi/:month/:empId/decide', async ({ actor, params, body, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const month = monthOf(params.month);
  const e = await loadEmp(params.empId);
  if (!['confirmed', 'excluded', 'draft'].includes(body.status)) bad("Holat noto'g'ri");
  await kpi.compute(e, month);
  if (body.status !== 'draft') {
    const why = await kpi.decideBlock(e.id, month);
    if (why) throw new HttpError(409, why);
  }
  if ('note' in body) await kpi.setNote(e.id, month, text(body.note, 500, { required: false, name: 'Izoh' }));
  const k = await flows.decideKpi(bot, e.id, month, body.status, actor.tgId);
  if (k.blocked) throw new HttpError(409, k.blocked);
  return { kpi: kpiOut(k, { money: true }) };
});

route('POST', '/api/kpi/:month/confirm-all', async ({ actor, params, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const month = monthOf(params.month);
  if (month >= time.month()) throw new HttpError(409, `${time.monthName(month)} hali tugamagan — oy yakunida tasdiqlanadi`);
  await kpi.computeAll(month);
  let n = 0;
  const skipped = [];
  for (const k of await kpi.listMonth(month)) {
    if (k.status !== 'draft') continue;
    const d = await flows.decideKpi(bot, k.employee_id, month, 'confirmed', actor.tgId);
    if (d.blocked) { skipped.push({ name: k.full_name, reason: d.blocked }); continue; }
    n += 1;
  }
  return { confirmed: n, skipped };
});

route('POST', '/api/kpi/:month/excel', async ({ actor, params, bot }) => {
  need(actor.seeAll, 'Faqat direktor va HR');
  const month = monthOf(params.month);
  const { buffer, filename } = await excel.buildMonthly(month, { viewer: actor });
  await notify.docToUser(bot, actor.tgId, buffer, filename, `📥 <b>${time.monthName(month)}</b> — KPI, topshiriqlar, davomat`);
  return { ok: true };
});

// --- rahbar baholashi (1–10) ---
const scoreScope = async (actor) => {
  need(actor.isManager, "Faqat rahbar va direktor");
  const me = actor.employee ? Number(actor.employee.id) : -1;
  if (actor.isAdmin) return (await employees.listActive()).filter((e) => Number(e.id) !== me);
  if (!actor.employee.department_id) bad("Sizga bo'lim biriktirilmagan — direktorga ayting");
  return (await employees.listByDepartment(actor.employee.department_id)).filter((e) => Number(e.id) !== me);
};

route('GET', '/api/scores/:month', async ({ actor, params }) => {
  const month = monthOf(params.month);
  const out = [];
  for (const e of await scoreScope(actor)) {
    const k = await kpi.compute(e, month);
    out.push({ employeeId: Number(e.id), name: e.full_name, position: e.position || null, headScore: numOrNull(k.head_score), headNote: k.head_note || null, tasksPct: Number(k.tasks_pct), attPct: Number(k.att_pct), status: k.status });
  }
  return { month, monthName: time.monthName(month), rows: out };
});

route('POST', '/api/scores/:month/:empId', async ({ actor, params, body }) => {
  const month = monthOf(params.month);
  const e = await loadEmp(params.empId);
  const scope = await scoreScope(actor);
  need(scope.some((x) => Number(x.id) === Number(e.id)) && employees.canManage(actor.employee, actor.isAdmin, e), "Bu sizning bo'limingiz emas");
  const k = await kpi.compute(e, month);
  if (k.status !== 'draft') throw new HttpError(409, 'Bu oy natijasi tasdiqlangan — baho o\'zgarmaydi');
  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > 10) bad('Baho 1–10');
  await kpi.setHeadScore(e.id, month, score, text(body.note, 300, { required: false, name: 'Izoh' }));
  return { ok: true };
});

// ===========================================================================
// DAVOMAT NAZORATI (direktor, HR, nazoratchi — hamma; rahbar — o'z bo'limi). Topshiriqlarsiz.
// ===========================================================================
const attScope = async (actor) => {
  if (actor.seeAll || actor.isViewer) return employees.listStaff();
  if (actor.isHead && actor.employee.department_id) return employees.listStaff(actor.employee.department_id);
  return deny("Davomat nazorati ruxsati yo'q");
};

route('GET', '/api/att/today', async ({ actor }) => {
  const list = await attScope(actor);
  const out = [];
  for (const e of list) {
    const t = await todayOf(e);
    out.push({ id: Number(e.id), name: e.full_name, position: e.position || null, department: e.department_name || null, ...t, hasVideo: false });
  }
  if (actor.seeAll) {
    for (const item of out) {
      const row = await attendance.get(item.id);
      item.hasVideo = Boolean(row && row.checkin_proof_file_id);
      item.attId = row ? Number(row.id) : null;
    }
  }
  return { date: time.today(), datePretty: time.prettyDate(time.today()), rows: out };
});

route('GET', '/api/att/month/:month', async ({ actor, params }) => {
  const month = monthOf(params.month);
  if (month > time.month()) bad('Kelajakdagi oy');
  const list = await attScope(actor);
  const { from, to } = time.monthRange(month);
  const out = [];
  for (const e of list) {
    const at = await attendance.stats(e, from, to);
    const k = await kpi.compute(e, month);
    out.push({ id: Number(e.id), name: e.full_name, department: e.department_name || null, pct: at.pct, workDays: at.workDays, ontime: at.ontime, late: at.late, absent: at.absent, excused: at.excused, kpi: Number(k.total) });
  }
  out.sort((a, b) => b.pct - a.pct);
  return { month, monthName: time.monthName(month), rows: out };
});

/** Keldim videosi (direktor va HR) */
route('GET', '/api/att/:attId/video', async ({ actor, params, bot, res }) => {
  need(actor.seeAll, 'Faqat direktor va HR');
  const row = await attendance.byId(id(params.attId));
  if (!row || !row.checkin_proof_file_id) notFound("Video yo'q");
  return streamProof(bot, res, { type: row.checkin_proof_type, fileId: row.checkin_proof_file_id });
});

// --- sababli kun so'rovlari ---
route('GET', '/api/excuses', async ({ actor }) => {
  need(actor.isManager || actor.isHr, "Ruxsat yo'q");
  const out = [];
  for (const r of await attendance.pendingExcuses()) {
    const e = await employees.byId(r.employee_id);
    // 5-okt: HR so'rovlarni ko'radi, lekin hal qilmaydi (canDecide=false)
    const canDecide = access.canDecideExcuse(actor, e);
    if (!canDecide && !(actor.isHr && Number(e.id) !== Number(actor.employee && actor.employee.id))) continue;
    out.push({ attId: Number(r.id), employeeId: Number(e.id), name: e.full_name, date: r.work_date, datePretty: time.prettyDate(r.work_date), reason: r.excuse_reason || '', proofType: r.excuse_proof_type || null, canDecide });
  }
  return { rows: out };
});

const loadExcuse = async (actor, attId, { view = false } = {}) => {
  const row = await attendance.byId(id(attId));
  if (!row) notFound();
  const e = await employees.byId(row.employee_id);
  need(access.canDecideExcuse(actor, e) || (view && actor.isHr), "Sababli qilish — faqat bo'lim rahbari yoki boshliq");
  return { row, e };
};

route('POST', '/api/excuses/:attId', async ({ actor, params, body, bot }) => {
  const { row, e } = await loadExcuse(actor, params.attId);
  if (row.excuse_status !== 'pending') throw new HttpError(409, "Allaqachon ko'rib chiqilgan");
  if (!['approved', 'rejected'].includes(body.status)) bad("Qaror noto'g'ri");
  await flows.decideExcuse(bot, e, row.work_date, body.status, actor.tgId);
  return { ok: true };
});

route('GET', '/api/excuses/:attId/proof', async ({ actor, params, bot, res }) => {
  const { row } = await loadExcuse(actor, params.attId, { view: true });
  if (!row.excuse_proof_file_id) notFound("Isbot yo'q");
  return streamProof(bot, res, { type: row.excuse_proof_type, fileId: row.excuse_proof_file_id });
});

// ===========================================================================
// OYLIK VA KPI (hodimning o'zi)
// ===========================================================================
const payMonths = (emp) => {
  const cur = time.month();
  const first = String(emp.created_at || '').slice(0, 7);
  const list = [];
  for (let i = 0; i < 6; i += 1) {
    const m = time.shiftMonth(cur, -i);
    if (first && m < first) break;
    list.push(m);
  }
  return list;
};

const payRow = (k, extra = 0) => {
  const salary = numOrNull(k.salary);
  const bonus = k.status === 'excluded' ? 0 : numOrNull(k.bonus_amount);
  return { salary, bonusFund: numOrNull(k.bonus_fund), bonus, extra: Number(extra) || 0, total: (salary || 0) + (bonus || 0) + (Number(extra) || 0), final: k.status !== 'draft' };
};

route('GET', '/api/pay', async ({ actor }) => {
  const emp = mustStaff(actor);
  const out = [];
  for (const m of payMonths(emp)) {
    const k = await kpi.compute(emp, m);
    out.push({ month: m, monthName: time.monthName(m), current: m === time.month(), status: k.status, eligible: Number(k.kpi_eligible) === 1, total: Number(k.total), ...payRow(k, await extradays.sumForMonth(emp.id, m)) });
  }
  return { kpiMode: config.kpiMode, months: out };
});

route('GET', '/api/pay/:month', async ({ actor, params }) => {
  const emp = mustStaff(actor);
  const month = monthOf(params.month);
  if (month > time.month()) bad('Kelajakdagi oy');
  const k = await kpi.compute(emp, month);
  const ms = await months.get(emp.id, month);
  return {
    monthName: time.monthName(month), current: month === time.month(), kpiMode: config.kpiMode,
    gate: await kpi.gateSettings(),
    monthStart: ms ? ms.confirmed_at : null,
    kpi: kpiOut(k),
    pay: payRow(k, await extradays.sumForMonth(emp.id, month)),
  };
});

route('POST', '/api/pay/:month/excel', async ({ actor, params, bot }) => {
  const emp = mustStaff(actor);
  const month = monthOf(params.month);
  const { buffer, filename } = await excel.buildEmployeeMonth(emp, month);
  await notify.docToUser(bot, actor.tgId, buffer, filename, `📥 <b>${time.monthName(month)}</b> — hisobotingiz`);
  return { ok: true };
});

// ===========================================================================
// ESLATMALAR
// ===========================================================================
/** HR — eslatma sozlamalari yo'q (faqat boshliq) */
const noHrReminders = (actor) => { if (actor.isHr && !actor.isAdmin) deny('Eslatma vaqtlarini boshliq belgilaydi'); };

route('GET', '/api/reminders', async ({ actor }) => {
  const emp = mustEmployee(actor);
  noHrReminders(actor);
  const step = await reminders.globalStep();
  const start = employees.startMinutesOf(emp);
  return {
    times: reminders.timesFor(emp, step, start),
    own: Boolean(emp.remind_times),
    source: reminders.sourceOf(emp),
    pending: emp.remind_pending ? reminders.listOf(emp.remind_pending) : null,
    step,
    options: [1, 2, 3, 4].map((n) => ({ step: n, times: reminders.intervalTimes(start, n) })),
    approvers: `Boshliq (${await org.bossName()})`,
  };
});

/** { step } yoki { times: '10:00, 14:00' } yoki { reset: true } */
route('POST', '/api/reminders', async ({ actor, body, bot }) => {
  const emp = mustEmployee(actor);
  noHrReminders(actor);
  if (body.reset === true) { await reminders.reset(emp.id); return { reset: true }; }
  let times;
  let label;
  if (body.step !== undefined) {
    const n = Number(body.step);
    if (!Number.isInteger(n) || n < 1 || n > 4) bad("Oraliq noto'g'ri");
    times = reminders.intervalTimes(employees.startMinutesOf(emp), n);
    if (!times.length) bad("Bu oraliq ish vaqtiga sig'maydi");
    label = `har ${n} soatda`;
  } else {
    times = reminders.parseTimes(text(body.times, 100, { name: 'Vaqtlar' }));
    if (!times) bad("Vaqtlarni vergul bilan yozing, 06:00–21:55 oralig'ida, ko'pi bilan 8 ta");
    label = "o'zi tanlagan vaqtlar";
  }
  const { auto } = await flows.requestReminders(bot, emp, times, label);
  return { requested: times, auto };
});

/** { step } / { times } / { reset } → vaqtlar yoki null */
const remindTimesOf = (body, startMin) => {
  if (body.reset === true) return null;
  if (body.step !== undefined) {
    const n = Number(body.step);
    if (!Number.isInteger(n) || n < 1 || n > 4) bad("Oraliq noto'g'ri");
    const t = reminders.intervalTimes(startMin, n);
    if (!t.length) bad("Bu oraliq ish vaqtiga sig'maydi");
    return t;
  }
  const t = reminders.parseTimes(text(body.times, 100, { name: 'Vaqtlar' }));
  if (!t) bad("Vaqtlarni vergul bilan yozing, 06:00–21:55 oralig'ida, ko'pi bilan 8 ta");
  return t;
};

/** Boshliq: umumiy, bo'lim va hodim vaqtlari */
route('GET', '/api/reminders/admin', async ({ actor }) => {
  need(actor.isAdmin, 'Faqat boshliq');
  const step = await reminders.globalStep();
  return {
    step,
    globalTimes: reminders.intervalTimes(worktime.minutes(), step),
    departments: (await departments.listActive()).map((d) => ({ id: Number(d.id), name: d.name, times: d.remind_times ? reminders.listOf(d.remind_times) : null })),
    employees: (await employees.listActive()).map((e) => ({
      id: Number(e.id), name: e.full_name, department: e.department_name || null, source: reminders.sourceOf(e),
      times: reminders.timesFor(e, step, employees.startMinutesOf(e)), pending: e.remind_pending ? reminders.listOf(e.remind_pending) : null,
    })),
  };
});

route('POST', '/api/reminders/admin/dept/:id', async ({ actor, params, body, bot }) => {
  need(actor.isAdmin, 'Faqat boshliq');
  const d = await departments.byId(Number(params.id));
  if (!d) notFound("Bo'lim topilmadi");
  const times = remindTimesOf(body, worktime.minutes());
  const notified = await flows.setReminderTimes(bot, { department: d }, times, actor.name);
  return { times, notified };
});

route('POST', '/api/reminders/admin/emp/:id', async ({ actor, params, body, bot }) => {
  need(actor.isAdmin, 'Faqat boshliq');
  const e = await loadEmp(params.id);
  const times = remindTimesOf(body, employees.startMinutesOf(e));
  const notified = await flows.setReminderTimes(bot, { employee: e }, times, actor.name);
  return { times, notified };
});

route('GET', '/api/reminders/pending', async ({ actor }) => {
  need(actor.isAdmin, 'Faqat boshliq');
  const me = actor.employee ? Number(actor.employee.id) : -1;
  const step = await reminders.globalStep();
  return {
    rows: (await employees.listActive())
      .filter((e) => e.remind_pending && Number(e.id) !== me)
      .map((e) => ({ id: Number(e.id), name: e.full_name, pending: reminders.listOf(e.remind_pending), current: reminders.timesFor(e, step, employees.startMinutesOf(e)) })),
  };
});

route('POST', '/api/reminders/:empId', async ({ actor, params, body, bot }) => {
  need(actor.isAdmin, 'Faqat boshliq');
  const e = await loadEmp(params.empId);
  if (actor.employee && Number(actor.employee.id) === Number(e.id)) deny("O'zingizning so'rovingizni tasdiqlay olmaysiz");
  const times = await flows.decideReminders(bot, e, bool(body.approve, 'Qaror'), actor.name);
  if (times === null) throw new HttpError(409, "Allaqachon ko'rib chiqilgan");
  return { ok: true };
});

// ===========================================================================
// SOZLAMALAR (direktor)
// ===========================================================================
route('GET', '/api/settings', async ({ actor }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const active = await employees.listActive();
  const step = await reminders.globalStep();
  const { confirmed, waiting } = await months.statusOf(time.month());
  const main = await office.get();
  return {
    workStart: worktime.get(),
    lateGrace: config.lateGraceMinutes,
    workEndHour: config.workEndHour,
    workDays: config.workDays,
    individual: active.filter((e) => e.work_start).map((e) => ({ id: Number(e.id), name: e.full_name, workStart: e.work_start })),
    remindStep: step,
    remindTimes: reminders.intervalTimes(worktime.minutes(), step),
    bossName: await org.bossName(),
    headTaskCopy: await org.headTaskCopy(),
    hrBossTasks: await org.hrSeesBossTasks(),
    bossAttendance: await org.bossSeesAttendance(),
    groupLinked: Boolean(await notify.getGroupId()),
    archiveLinked: Boolean(await notify.getArchiveId()),
    office: main ? { radius: main.radius } : null,
    kpi: { mode: config.kpiMode, ...(await kpi.gateSettings()), returnPenalty: config.returnPenaltyPct },
    headMoney: await org.headSeesMoney(),
    monthStart: { month: time.month(), monthName: time.monthName(time.month()), confirmed: confirmed.length, waiting: waiting.map((r) => r.full_name) },
    employeesCount: active.length,
  };
});

/** { workStart: 'HH:mm', resetIndividual: bool } */
route('POST', '/api/settings/worktime', async ({ actor, body, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const hhmm = employees.parseWorkStart(text(body.workStart, 5, { name: 'Vaqt' }));
  if (!hhmm) bad("Vaqt HH:mm ko'rinishida bo'lsin (masalan 08:50)");
  const all = body.resetIndividual === true;
  await worktime.set(hhmm, { resetIndividual: all });
  const sent = await flows.announceWorktime(bot, hhmm, all);
  return { workStart: hhmm, notified: sent };
});

route('POST', '/api/settings/remind-step', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const n = Number(body.step);
  if (!Number.isInteger(n) || n < 1 || n > 4) bad("Oraliq 1–4 soat");
  await reminders.setGlobalStep(n);
  return { step: n };
});

route('POST', '/api/settings/head-task-copy', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  await org.setHeadTaskCopy(body.on === true);
  return { on: await org.headTaskCopy() };
});

/** { on } — HR boshliq/direktor bergan topshiriqlarni ko'radimi */
route('POST', '/api/settings/hr-boss-tasks', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  await org.setHrSeesBossTasks(body.on === true);
  return { on: await org.hrSeesBossTasks() };
});

/** { minDays?, minTaskPct? } — KPI sharti */
route('POST', '/api/settings/kpi-gate', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const patchGate = {};
  if ('minDays' in body) { const n = Number(body.minDays); if (!Number.isInteger(n) || n < 1 || n > 31) bad('Kunlar 1–31'); patchGate.minDays = n; }
  if ('minTaskPct' in body) { const n = Number(body.minTaskPct); if (!Number.isInteger(n) || n < 0 || n > 100) bad('Foiz 0–100'); patchGate.minTaskPct = n; }
  return { gate: await kpi.setGateSettings(patchGate) };
});

/** { on } — bo'lim rahbari jamoasining KPI summasini ko'radimi */
route('POST', '/api/settings/head-money', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  await org.setHeadSeesMoney(body.on === true);
  return { on: await org.headSeesMoney() };
});

/** { on } — boshliq keldi-ketdi va davomat xabarlarini oladimi */
route('POST', '/api/settings/boss-attendance', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  await org.setBossSeesAttendance(body.on === true);
  return { on: await org.bossSeesAttendance() };
});

route('POST', '/api/settings/boss-name', async ({ actor, body }) => {
  need(actor.isAdmin, 'Faqat direktor');
  await org.setBossName(text(body.name, 60, { name: 'Ism' }));
  return { name: await org.bossName() };
});

route('POST', '/api/settings/month-start/resend', async ({ actor, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const sent = await require('../handlers/month').sendMonthStart(bot);
  return { sent };
});

route('POST', '/api/settings/remind-now', async ({ actor, bot }) => {
  need(actor.isAdmin, 'Faqat direktor');
  const r = await require('../services/reports').sendReminder(bot);
  return { sent: r.sent, reviewers: r.reviewers };
});

module.exports = { match, HttpError, STREAMED, routes };
