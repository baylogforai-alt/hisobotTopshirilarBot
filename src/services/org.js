'use strict';

const db = require('../db');
const config = require('../config');

/**
 * TASHKILOT NOMLARI VA XABAR OLUVCHILAR.
 *   Boshliq (direktor) ismi — settings.boss_name (standart BOSS_NAME yoki 'Direktor'), panel → «🏷 Nomlar» da o'zgartiriladi.
 *   HR — employees.is_hr (ismi hodim kartochkasidan o'zgartiriladi).
 *   Kelmaslik / kechikish sabablari: HR + boshliq (direktorlar) + hodimning bo'lim rahbari.
 */

const BOSS_KEY = 'boss_name';

const bossName = async () => (await db.getSetting(BOSS_KEY)) || config.bossName;
const setBossName = (name) => db.setSetting(BOSS_KEY, String(name).trim().slice(0, 60));

/** Rahbar bergan topshiriq nusxasi direktor/HR ga boradimi (standart — ha). Faqat direktor o'zgartiradi */
const HEAD_COPY_KEY = 'head_task_copy';
const headTaskCopy = async () => (await db.getSetting(HEAD_COPY_KEY)) !== '0';
const setHeadTaskCopy = (on) => db.setSetting(HEAD_COPY_KEY, on ? '1' : '0');

/** Kelmaslik/kechikish xabarini oladiganlar (tg_id lar), hodimning o'zidan tashqari */
const absenceRecipientsOf = async (emp) => {
  const employees = require('./employees');
  const notify = require('./notify');
  const ids = new Set(await employees.reviewersOf(emp));
  for (const h of await employees.listHr()) ids.add(Number(h.tg_id));
  ids.delete(Number(emp.tg_id));
  return [...ids];
};

/** Tasdiqlovchilar (eslatma jadvali va h.k.): HR + direktorlar, hodimning o'zidan tashqari */
const approversOf = async (emp) => {
  const employees = require('./employees');
  const ids = new Set((await employees.bossTgIds()).map(Number));
  for (const h of await employees.listHr()) ids.add(Number(h.tg_id));
  ids.delete(Number(emp.tg_id));
  return [...ids];
};

/** Texnik direktorlar (ADMIN_IDS, rahbariyatda yo'q) — faqat ma'lumot oladi, tasdiqlash tugmalarisiz */
const infoOnlyIds = async (exclude = []) => {
  const employees = require('./employees');
  const notify = require('./notify');
  const top = new Set((await employees.bossTgIds()).map(Number));
  for (const h of await employees.listHr()) top.add(Number(h.tg_id));
  const ex = new Set(exclude.map(Number));
  return (await notify.adminIds()).map(Number).filter((id) => !top.has(id) && !ex.has(id));
};

/** "HR (…) va direktor (…)" — hodimga tasdiq matni uchun; approvers — "boshliq (…) yoki HR (…)" */
const recipientsLabel = async (emp = null, { approvers = false } = {}) => {
  const employees = require('./employees');
  const hr = (await employees.listHr()).filter((h) => !emp || Number(h.id) !== Number(emp.id));
  const boss = await bossName();
  const hrText = hr.map((h) => h.full_name).join(', ');
  if (approvers) return hr.length ? `Boshliq (${boss}) yoki HR (${hrText})` : `Boshliq (${boss})`;
  return hr.length ? `HR (${hrText}) va boshliq (${boss})` : `boshliq (${boss})`;
};

/**
 * Harakat qilayotgan odamning ismi (topshiriq bergan, qaror qilgan): hodim bo'lsa bazadagi ismi,
 * bo'lmasa (ADMIN_IDS dagi direktor) Telegram ismi. Direktorlar bir nechta — boss_name hammaga yozilmasin.
 */
const actorName = (ctx) => {
  if (ctx.state && ctx.state.employee) return ctx.state.employee.full_name;
  const f = ctx.from || {};
  return [f.first_name, f.last_name].filter(Boolean).join(' ').trim() || 'Direktor';
};

module.exports = { infoOnlyIds, actorName, bossName, setBossName, headTaskCopy, setHeadTaskCopy, absenceRecipientsOf, approversOf, recipientsLabel };
