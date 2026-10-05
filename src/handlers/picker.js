'use strict';

const ui = require('../ui');
const session = require('../session');
const { render } = require('../render');
const employees = require('../services/employees');
const departments = require('../services/departments');

const { esc, cb, inline } = ui;

/**
 * BIR NECHTA HODIMNI BELGILASH (inline ✅ / ▫️) — e'lon va bir nechta hodimga topshiriq uchun.
 * Holat sessiyada: s.pick = [empId, …], s.pickFor = prefix.
 *   <p>:t:<id>  belgilash / olib tashlash      <p>:all  hammasi / hech kim
 *   <p>:dl      bo'limlar (direktor/HR)        <p>:d:<deptId>  bo'limni to'liq belgilash / olib tashlash
 *   <p>:ok      davom etish                    <p>:x  bekor
 *
 * opts: { prefix, title(ctx, n), candidates(ctx) → hodimlar, allowed(ctx) → bool, onDone(ctx, ids), backData }
 */
const create = (opts) => {
  const { prefix } = opts;

  const picked = (ctx) => {
    const s = session.get(ctx.from.id);
    return s.pickFor === prefix && Array.isArray(s.pick) ? s.pick.map(Number) : [];
  };
  const save = (ctx, ids) => session.set(ctx.from.id, { pickFor: prefix, pick: [...new Set(ids.map(Number))] });

  const show = async (ctx, { reset = false } = {}) => {
    if (reset) session.set(ctx.from.id, { pickFor: prefix, pick: [] });
    const list = await opts.candidates(ctx);
    const sel = new Set(picked(ctx));
    if (!list.length) return render(ctx, "Tanlash uchun hodim yo'q.", opts.backData ? ui.backKeyboard(opts.backData) : undefined);
    const rows = [];
    for (let i = 0; i < list.length; i += 2) {
      rows.push(list.slice(i, i + 2).map((e) => cb(`${sel.has(Number(e.id)) ? '✅' : '▫️'} ${e.full_name}`.slice(0, 32), `${prefix}:t:${e.id}`)));
    }
    const all = list.every((e) => sel.has(Number(e.id)));
    const tools = [cb(all ? '☑️ Hech kim' : `☑️ Hammasi (${list.length})`, `${prefix}:all`)];
    if (ctx.state.isAdmin || ctx.state.isHr) tools.push(cb("🏢 Bo'lim bo'yicha", `${prefix}:dl`));
    rows.push(tools);
    const n = list.filter((e) => sel.has(Number(e.id))).length;
    rows.push([cb(n ? `➡️ Davom etish (${n})` : '➡️ Davom etish', `${prefix}:ok`), cb(ui.BTN.cancel, `${prefix}:x`)]);
    return render(ctx, `${opts.title(ctx, n)}\n\n<i>Ismni bossangiz — belgilanadi (✅), yana bossangiz — olib tashlanadi.</i>`, inline(rows));
  };

  const deptList = async (ctx) => {
    const list = await opts.candidates(ctx);
    const sel = new Set(picked(ctx));
    const rows = [];
    for (const d of await departments.listActive()) {
      const members = list.filter((e) => Number(e.department_id) === Number(d.id));
      if (!members.length) continue;
      const full = members.every((e) => sel.has(Number(e.id)));
      rows.push([cb(`${full ? '✅' : '▫️'} 🏢 ${d.name} (${members.length})`.slice(0, 50), `${prefix}:d:${d.id}`)]);
    }
    if (!rows.length) rows.push([cb("Bo'limlar yo'q", `${prefix}:back`)]);
    rows.push([cb('⬅️ Ro\'yxatga', `${prefix}:back`)]);
    return render(ctx, "🏢 <b>Bo'limni bossangiz — uning hamma hodimlari belgilanadi</b> (yana bossangiz — olib tashlanadi).", inline(rows));
  };

  const register = (bot) => {
    const guard = async (ctx) => {
      if (opts.allowed(ctx)) return true;
      await ctx.answerCbQuery('⛔️ Ruxsat yo\'q');
      return false;
    };
    bot.action(new RegExp(`^${prefix}:t:(\\d+)$`), async (ctx) => {
      if (!(await guard(ctx))) return;
      const id = Number(ctx.match[1]);
      if (!(await opts.candidates(ctx)).some((e) => Number(e.id) === id)) return ctx.answerCbQuery('Hodim topilmadi');
      const ids = picked(ctx);
      save(ctx, ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
      await ctx.answerCbQuery();
      return show(ctx);
    });
    bot.action(`${prefix}:all`, async (ctx) => {
      if (!(await guard(ctx))) return;
      const list = (await opts.candidates(ctx)).map((e) => Number(e.id));
      const sel = new Set(picked(ctx));
      save(ctx, list.every((id) => sel.has(id)) ? [] : list);
      await ctx.answerCbQuery();
      return show(ctx);
    });
    bot.action(`${prefix}:dl`, async (ctx) => {
      if (!(await guard(ctx))) return;
      if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️');
      await ctx.answerCbQuery();
      return deptList(ctx);
    });
    bot.action(new RegExp(`^${prefix}:d:(\\d+)$`), async (ctx) => {
      if (!(await guard(ctx))) return;
      if (!ctx.state.isAdmin && !ctx.state.isHr) return ctx.answerCbQuery('⛔️');
      const members = (await opts.candidates(ctx)).filter((e) => Number(e.department_id) === Number(ctx.match[1])).map((e) => Number(e.id));
      const sel = new Set(picked(ctx));
      const full = members.length && members.every((id) => sel.has(id));
      save(ctx, full ? [...sel].filter((id) => !members.includes(id)) : [...sel, ...members]);
      await ctx.answerCbQuery(full ? 'Olib tashlandi' : `${members.length} ta hodim belgilandi`);
      return deptList(ctx);
    });
    bot.action(`${prefix}:back`, async (ctx) => { if (!(await guard(ctx))) return; await ctx.answerCbQuery(); return show(ctx); });
    bot.action(`${prefix}:ok`, async (ctx) => {
      if (!(await guard(ctx))) return;
      const allowedIds = new Set((await opts.candidates(ctx)).map((e) => Number(e.id)));
      const ids = picked(ctx).filter((id) => allowedIds.has(id));
      if (!ids.length) return ctx.answerCbQuery('Kamida bitta hodimni belgilang', { show_alert: true });
      await ctx.answerCbQuery();
      return opts.onDone(ctx, ids);
    });
    bot.action(`${prefix}:x`, async (ctx) => { session.clear(ctx.from.id); await ctx.answerCbQuery(); return render(ctx, '❌ Bekor qilindi.'); });
  };

  return { show, register };
};

/** Tanlangan hodimlar ro'yxati — qisqa matn (5 tadan ko'p bo'lsa «… va yana N») */
const namesText = (list, max = 5) => {
  const names = list.slice(0, max).map((e) => esc(e.full_name));
  return names.join(', ') + (list.length > max ? ` va yana ${list.length - max} kishi` : '');
};

/** Rahbar → o'z bo'limi; direktor / HR → hamma faol hodim (o'zidan tashqari) */
const managedCandidates = async (ctx) => {
  const me = ctx.state.employee;
  if (ctx.state.isAdmin || ctx.state.isHr) return (await employees.listActive()).filter((e) => !me || Number(e.id) !== Number(me.id));
  if (ctx.state.isHead && me) return employees.teamOf(me);
  return [];
};

module.exports = { create, namesText, managedCandidates };
