'use strict';

const employees = require('./employees');

/**
 * KIM NIMA QILA OLADI — bot (ctx.state) va Web App (API) uchun bitta manba.
 *   actor = { tgId, employee, isAdmin, isHead, isHr, isManager, isViewer, seeAll, registered, name }
 *   seeAll   — direktor yoki HR (hamma narsani ko'radi)
 *   isViewer — davomat nazoratchisi (topshiriqlarsiz)
 */
const resolve = async (tgId, from = null) => {
  const emp = await employees.byTgId(tgId);
  const employee = emp && emp.active ? emp : null;
  const isAdmin = employees.isAdmin(employee, tgId);
  const isHead = employees.isHead(employee);
  const isHr = employees.isHr(employee);
  const f = from || {};
  return {
    tgId: Number(tgId),
    employee,
    isAdmin,
    isHead,
    isHr,
    isManager: isAdmin || isHead,
    isViewer: employees.isViewer(employee),
    seeAll: isAdmin || isHr,
    // HR boshliq/direktor topshiriqlarini ko'radimi — boshliq sozlamasi (tasks.visibleTo)
    hrSeesBoss: isHr && !isAdmin ? await require('./org').hrSeesBossTasks() : true,
    registered: Boolean(employee) || isAdmin,
    name: employee ? employee.full_name : [f.first_name, f.last_name].filter(Boolean).join(' ').trim() || 'Direktor',
  };
};

/**
 * Topshiriqni tahrirlash huquqi (bot: tk:*). Hodim o'zi yozgan vazifani faqat muddati o'tmaguncha tahrirlaydi
 * (muddati o'tganini uzaytirib KPI dan qochib bo'lmaydi). HR — hamma topshiriqni (o'zinikidan tashqari).
 */
const canEditTask = (actor, t) => {
  if (actor.isAdmin) return true;
  const me = actor.employee;
  if (!me) return false;
  if (Number(t.employee_id) === Number(me.id)) return t.source === 'self' && t.due_date >= require('../time').today();
  if (actor.isHr) return require('./tasks').visibleTo(actor, t);
  return actor.isHead && Number(t.department_id) === Number(me.department_id);
};

/**
 * Muddatni o'zgartirish: canEditTask + hodim O'Z vazifasini muddat kunida (yoki keyin) uzaytira olmaydi —
 * aks holda «bugun tugatolmayman» deb muddatni surib KPI dan qochardi. Qisqartirish mumkin.
 */
const canSetDue = (actor, t, newDue) => {
  if (!canEditTask(actor, t)) return false;
  const own = actor.employee && Number(t.employee_id) === Number(actor.employee.id) && !actor.isAdmin;
  if (own && newDue > t.due_date && t.due_date <= require('../time').today()) return false;
  return true;
};
const DUE_LOCKED = "🔒 Muddat kuni o'z vazifangiz muddatini uzaytirib bo'lmaydi — bajaring yoki rahbaringizga ayting.";

/**
 * Bekor qilish (o'chirish emas — yozuv qoladi, kim va qachon bekor qilgani yoziladi). Faol yoki tekshiruvdagi (done) topshiriq.
 * Hodim O'Z topshirig'ini bekor qila olmaydi (o'zi yozganini ham) — boshliq/direktor bundan mustasno (undan yuqori yo'q).
 * Direktor, HR, bo'lim rahbari — boshqalarnikini.
 */
const canCancelTask = (actor, t) => {
  if (!t || !['active', 'done'].includes(t.status)) return false;
  const me = actor.employee;
  if (me && Number(t.employee_id) === Number(me.id)) return Boolean(actor.isAdmin);
  if (actor.isAdmin) return true;
  if (actor.isHr) return require('./tasks').visibleTo(actor, t);
  return Boolean(me && actor.isHead && Number(t.department_id) === Number(me.department_id));
};

/** Tekshiruv (qabul/qaytarish) huquqi: rahbar/direktor, o'z hodimi, o'zini emas */
const canReview = (actor, emp) =>
  actor.isManager && employees.canManage(actor.employee, actor.isAdmin, emp) && Number(emp.tg_id) !== Number(actor.tgId);

/**
 * Sababli qilish (kelmayman ab:*, kechikish lx:*) — boshliq/direktor va hodimning bo'lim rahbari.
 * 5-okt qarori: HR faqat ko'radi, tasdiqlamaydi.
 */
const canDecideExcuse = (actor, emp) => {
  const me = actor.employee;
  if (!emp || (me && Number(emp.id) === Number(me.id))) return false;
  if (actor.isAdmin) return true;
  return Boolean(actor.isHead && !actor.isHr && me && me.department_id && Number(me.department_id) === Number(emp.department_id));
};

/**
 * «Savol-javob» — kim bilan gaplasha oladi (faol hodimlar, o'zidan tashqari):
 * direktor / HR — hamma; bo'lim rahbari — jamoasi + rahbariyat; hodim — o'z bo'lim rahbari, HR va boshliq.
 */
const chatCandidates = async (actor) => {
  const me = actor.employee;
  const notMe = (e) => !me || Number(e.id) !== Number(me.id);
  const all = await employees.listActive();
  if (actor.isAdmin || actor.isHr) return all.filter(notMe);
  const ids = new Set();
  if (actor.isHead && me) for (const e of await employees.teamOf(me)) ids.add(Number(e.id));
  for (const e of all) {
    if (e.role === 'admin' || Number(e.is_hr) === 1) ids.add(Number(e.id));
    if (me && me.department_id && e.role === 'head' && Number(e.department_id) === Number(me.department_id)) ids.add(Number(e.id));
  }
  return all.filter((e) => ids.has(Number(e.id)) && notMe(e));
};

/**
 * Topshiriqni ko'ra oladimi (bot va ilova uchun bitta qoida): egasi; qolganlar — HR yashirish qoidasi (visibleTo) bilan,
 * direktor/HR — hamma, rahbar — o'z bo'limi.
 */
const canSeeTask = async (actor, t) => {
  if (!t) return false;
  if (actor.employee && Number(t.employee_id) === Number(actor.employee.id)) return true;
  if (!require('./tasks').visibleTo(actor, t)) return false;
  if (actor.seeAll) return true;
  return Boolean(actor.isManager && employees.canManage(actor.employee, actor.isAdmin, await employees.byId(t.employee_id)));
};

/** Ro'yxatlar doirasi: direktor/HR — hamma (null); rahbar — o'z bo'limi; bo'limsiz rahbar — hech kim (-1, «hammasi» emas) */
const deptScope = (actor) => (actor.isAdmin || actor.isHr ? null : (actor.employee && actor.employee.department_id) || -1);

/** Topshiriq bo'yicha yozishma: topshiriq egasi, uni qaytargan / bergan odam yoki tekshirish huquqi borlar */
const canReplyTask = (actor, t, emp) => {
  if (actor.employee && Number(t.employee_id) === Number(actor.employee.id)) return true;
  // HR boshliq/direktor topshiriqlarini (sozlama o'chiq bo'lsa) yozishmasi bilan ham ko'rmaydi
  if (!require('./tasks').visibleTo(actor, t)) return false;
  if ([t.reviewed_by, t.created_by].some((x) => x && Number(x) === Number(actor.tgId))) return true;
  return Boolean(emp && canReview(actor, emp));
};

/**
 * «⏳ Faol / 🕓 Kutilmoqda / ✅ Bajarilgan» ro'yxatlari: kimning topshiriqlari ko'rinadi.
 * null — hamma (boshliq/direktor, HR); rahbar — o'zi + bo'limi; hodim (yoki mine) — faqat o'zi
 */
const taskScopeIds = async (actor, { mine = false } = {}) => {
  const me = actor.employee;
  if (mine || !actor.isManager) return me ? [Number(me.id)] : [];
  if (actor.seeAll) return null;
  return me ? [Number(me.id), ...(await employees.teamOf(me)).map((e) => Number(e.id))] : [];
};

/** Holat bo'yicha topshiriqlar (HR cheklovi bilan). kind: active · review · accepted (shu oy) */
const tasksByKind = async (actor, kind, { mine = false } = {}) => {
  const tasks = require('./tasks');
  const ids = await taskScopeIds(actor, { mine });
  if (ids && !ids.length) return [];
  return tasks.visibleFor(actor, await tasks.listByKind(kind, { employeeIds: ids }));
};

module.exports = { taskScopeIds, tasksByKind, resolve, canEditTask, canCancelTask, canReview, canDecideExcuse, chatCandidates, canReplyTask, canSeeTask, deptScope, canSetDue, DUE_LOCKED };
