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
  if (actor.isHr) return true;
  return actor.isHead && Number(t.department_id) === Number(me.department_id);
};

/**
 * Bekor qilish (o'chirish emas — yozuv qoladi, kim va qachon bekor qilgani yoziladi).
 * Hodim O'Z topshirig'ini bekor qila olmaydi (o'zi yozganini ham). Direktor, HR, bo'lim rahbari — mumkin.
 */
const canCancelTask = (actor, t) => {
  const me = actor.employee;
  if (me && Number(t.employee_id) === Number(me.id)) return false;
  if (actor.isAdmin || actor.isHr) return true;
  return Boolean(me && actor.isHead && Number(t.department_id) === Number(me.department_id));
};

/** Tekshiruv (qabul/qaytarish) huquqi: rahbar/direktor, o'z hodimi, o'zini emas */
const canReview = (actor, emp) =>
  actor.isManager && employees.canManage(actor.employee, actor.isAdmin, emp) && Number(emp.tg_id) !== Number(actor.tgId);

/** Sababli kun qarori (bot: ab:*) — faqat rahbariyat (boshliq, HR) va direktorlar; bo'lim rahbari faqat xabar oladi */
const canDecideExcuse = (actor, emp) =>
  (actor.isAdmin || actor.isHr) && !(actor.employee && Number(emp.id) === Number(actor.employee.id));

module.exports = { resolve, canEditTask, canCancelTask, canReview, canDecideExcuse };
