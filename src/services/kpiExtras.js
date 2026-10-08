'use strict';

const db = require('../db');
const time = require('../time');
const { partPct } = require('./kpi');

/**
 * QO'SHIMCHA KPI (6-okt, direktor qarori) — asosiy KPI summasidan tashqari alohida KPI qatorlari:
 * masalan «Davomat uchun 500 000», «Bajargan ishlari uchun 1 000 000», «Qo'shimcha vazifa (yakshanba) 200 000».
 *
 * Har qator FOIZGA BOG'LIQ: beriladi = summa × asos foizi ÷ 100. Asoslar:
 *   tasks — topshiriq %, attendance — davomat %, head — boshliq bahosi ×10, custom — mezon %,
 *   total — jami KPI %, manual — qo'lda qo'yilgan foiz (`pct`, masalan yakshanba ishi 100%).
 * Muddat: bir martalik (`month` = 'YYYY-MM') yoki har oy (`month` NULL, `start_month` dan, `end_month` gacha).
 * Yozuvlar o'chirilmaydi: bir martalik — `removed_at`; har oylik — `end_month` = oldingi oy (o'tgan oylar o'zgarmaydi).
 * Tasdiqlangan/chiqarilgan oy (kpi_monthly.status) — qulf. KPI dan chiqarilgan (excluded) oyda qo'shimcha ham 0.
 * Hozircha qo'shish/o'chirish — faqat CRM'dan (POST /crm/kpi/extra, bosh direktor); bot ko'rsatadi va oylikka qo'shadi.
 */

const BASES = ['tasks', 'attendance', 'head', 'custom', 'total', 'manual'];
const BASIS_LABEL = {
  tasks: 'topshiriq %', attendance: 'davomat %', head: 'boshliq bahosi', custom: 'mezon %', total: 'jami KPI %', manual: 'belgilangan %',
};

const ACTIVE = `removed_at IS NULL AND (month = $2 OR (month IS NULL AND start_month <= $2 AND (end_month IS NULL OR end_month >= $2)))`;

const forMonth = (employeeId, month) =>
  db.query(`SELECT * FROM kpi_extras WHERE employee_id = $1 AND ${ACTIVE} ORDER BY id`, [Number(employeeId), month]);

const byId = (id) => db.one('SELECT * FROM kpi_extras WHERE id = $1', [Number(id)]);

/** Asos foizi (0..100) yoki null (kiritilmagan — masalan boshliq bahosi qo'yilmagan) */
const basisPct = (k, x) => {
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  // yo'nalish asoslari — 80% dan kam bo'lsa 0 (asosiy KPI bilan bir qoida)
  const part = partPct;
  switch (x.basis) {
    case 'tasks': return part(n(k && k.tasks_pct));
    case 'attendance': return part(n(k && k.att_pct));
    case 'head': return part(k && k.head_score !== null && k.head_score !== undefined ? Number(k.head_score) * 10 : null);
    case 'custom': return part(n(k && k.custom_pct));
    case 'total': return n(k && k.total);
    case 'manual': return n(x.pct);
    default: return null;
  }
};

/** Qatorlar + har birining berilishi (summa × foiz). KPI dan chiqarilgan oy — 0 */
const withEarned = (k, items) => {
  const excluded = k && k.status === 'excluded';
  const list = items.map((x) => {
    const pct = basisPct(k, x);
    const earned = excluded || pct === null ? 0 : Math.round((Number(x.amount) * Math.max(0, Math.min(100, pct))) / 100);
    return { ...x, basisPct: pct, earned };
  });
  return { list, total: list.reduce((s, x) => s + x.earned, 0) };
};

/** Bir oy uchun: qatorlar va jami (k — kpi_monthly qatori yoki preview) */
const forKpi = async (employeeId, month, k) => withEarned(k, await forMonth(employeeId, month));

const add = async ({ employeeId, month, title, basis, amount, pct = null, recurring = false, by = null }) => {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!t) return { error: 'title_required' };
  if (!BASES.includes(basis)) return { error: 'bad_basis' };
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0 || a > 1e11) return { error: 'bad_amount' };
  let p = null;
  if (basis === 'manual') {
    p = Number(pct);
    if (!Number.isFinite(p) || p < 0 || p > 100) return { error: 'bad_pct' };
    p = Math.round(p);
  }
  const rows = await db.query(
    `INSERT INTO kpi_extras (employee_id, title, basis, amount, pct, month, start_month, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [Number(employeeId), t, basis, Math.round(a), p, recurring ? null : month, month, by ? String(by).slice(0, 60) : null, time.stamp()],
  );
  return { ok: true, id: rows[0] && rows[0].id };
};

/** O'chirish shu oydan boshlab: bir martalik — butunlay; har oylik — shu oydan to'xtaydi (o'tgan oylar qoladi) */
const remove = async ({ id, employeeId, month, by = null }) => {
  const x = await byId(id);
  if (!x || Number(x.employee_id) !== Number(employeeId) || x.removed_at) return { error: 'not_found' };
  if (x.month || x.start_month >= month) {
    await db.query('UPDATE kpi_extras SET removed_at = $1, removed_by = $2 WHERE id = $3', [time.stamp(), by ? String(by).slice(0, 60) : null, Number(id)]);
  } else {
    await db.query('UPDATE kpi_extras SET end_month = $1, removed_by = $2 WHERE id = $3', [time.shiftMonth(month, -1), by ? String(by).slice(0, 60) : null, Number(id)]);
  }
  return { ok: true };
};

/** Bot matnlari uchun qator (HTML): «➕ Davomat uchun: 500 000 so'm × davomat % 80% = 400 000 so'm» */
const lineText = (x, fmtMoney, esc) =>
  `➕ ${esc(x.title)}: ${fmtMoney(x.amount)} × ${BASIS_LABEL[x.basis] || x.basis}${x.basisPct === null ? ' (kiritilmagan)' : ` ${x.basisPct}%`} = <b>${fmtMoney(x.earned)}</b>${x.month ? '' : ' · har oy'}`;

module.exports = { BASES, BASIS_LABEL, forMonth, forKpi, withEarned, basisPct, add, remove, byId, lineText };
