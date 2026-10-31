# 💲 Deklarant va narx so'rovlari — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ruxsatli hodim deklarantga yuk bo'yicha narx so'rovi yuboradi; deklarant ro'yxatdan narx beradi yoki savol beradi; narx berilmaguncha ish vaqtida har 60 daqiqada eslatma boradi; tarix, statistika, bekor qilish va qayta so'rash bor.

**Architecture:** Yangi `services/priceRequests.js` (faqat baza, bot yo'q) + yangi `handlers/price.js` (UI, sessiya bosqichlari, xabarlar, `nag(bot, now)` eslatma funksiyasi; `dailyReport.remindMissing` kabi jobs dan chaqiriladi). Rollar — `employees` dagi ikki bayroq, hodim kartochkasida almashtiriladi. Oddiy topshiriqlar/KPI ga tegilmaydi.

**Tech Stack:** Node ≥20 CommonJS, telegraf 4.16, `pg` / `better-sqlite3` (ikkala dialekt — `$1` parametrlar, `db.query/db.one/db.count`), luxon (`time.js`), exceljs, node-cron.

**Spec:** `docs/superpowers/specs/2026-10-31-deklarant-narx-sorovi-design.md`

## Global Constraints

- Callback prefiksi — `pq:`; sessiya bosqichlari — `pq_` bilan boshlanadi; callback_data ≤ 64 bayt.
- Barcha `*_id` ustunlar `price_requests` / `price_request_msgs` da — **employee id** (tg_id emas), shuning uchun `fixes.js TG_COLUMNS` o'zgarmaydi.
- Holatlar aynan: `open`, `asked`, `priced`, `cancelled`. Holat o'tishi faqat `UPDATE … WHERE id = $1 AND status IN (…) RETURNING id` bilan (bo'sh natija → `false`).
- Vaqt — `time.stamp()` ISO (`+05:00`); taqqoslash ISO satr bo'yicha (bir xil zona). Cutoff — `now.minus({ minutes }).toISO()`.
- Eslatma oralig'i: `config.priceRemindMin` = `PRICE_REMIND_MIN` env, standart **60**. Faqat ish kuni (`time.isWorkDay`) va `worktime.minutes() ≤ nowMin < employees.endMinutesOf(null)`.
- Tavsif ≤ **2000** belgi, bo'sh bo'lmasin; narx ≤ 200, izoh/savol/javob ≤ 1500.
- Muddat kalitlari: `1h` (+60 daq), `3h` (+180 daq), `today` (bugun `workEndOf(null)`), `tomorrow` (ertaga `workEndOf(null)`), `none` (null).
- «Rahbar» (narx bo'limida): `ctx.state.isAdmin || ctx.state.isHr` — bayroqsiz so'ray oladi, hammasini ko'radi, bekor qila oladi.
- Bayroqlarni faqat direktor almashtiradi (`render.guard`, hodim kartochkasi).
- Samandar tg_id = **8254184544**; fix id = `samandar-narx-20261031`.
- Matnlar o'zbekcha (lotin), kod/izohlar uslubi — atrofdagi fayllardek (o'zbekcha JSDoc izohlar, ingliz identifikatorlar). Commit xabarlari — inglizcha.
- `git add` faqat aniq fayllar; `git add -A` / `.` **taqiqlangan** — ishchi papkada boshqa sessiyaning commit qilinmagan IaC ishi bor (`railway.json` o'chirilgan, `.railway/`, `CLAUDE.md` tahrirlari).
- `attendance.guard` («Keldim»siz bot yopiq) `pq:` ga ham amal qiladi — `OPEN_CB` ga qo'shilmaydi.

## Review Focus

1. **Eskirgan / ikki marta bosilgan «💲 Narx berish»** (so'rov allaqachon `priced` yoki `cancelled`) → «Eskirgan tugma» javobi, so'rovchiga ikkinchi xabar bormaydi. — Task 3 testi.
2. **Begona odam `pq:p:<id>` / `pq:a:<id>` / `pq:x:<id>` bossa** (tayinlanmagan deklarant, boshqa hodim) → rad, holat o'zgarmaydi. — Task 3 testi.
3. **Deklarant nofaol qilinsa** → `nag` unga yubormaydi; so'rov rahbarning «Barcha ochiq» ro'yxatida ⚠️ bilan. — Task 4 va Task 5 testlari.
4. **Muddat ish vaqtidan keyin tushsa** → overdue xabari faqat ish vaqtidagi birinchi `nag` da, **bir marta**. — Task 4 testi.
5. **Bitta deklarantda bir nechta muddati yetgan so'rov** → bitta xabar (ro'yxat), har biri `last_reminded_at` yangilanadi. — Task 4 testi.

---

## File Structure

- Create `src/services/priceRequests.js` — baza qatlami (CRUD, holat o'tishlari, eslatma tanlovlari, tarix, statistika, `dueAtFor`).
- Create `src/handlers/price.js` — menyu, so'rov sehrgari, deklarant ro'yxati/kartochkasi, narx/savol/javob, bekor/qayta, tarix/qidiruv, statistika/Excel, `nag(bot, now)`.
- Modify `src/db/schema.js` — `employees` ga 2 ustun (CREATE + MIGRATIONS), 2 yangi jadval + indekslar.
- Modify `src/services/employees.js` — `isDeclarant, canAskPrice, setDeclarant, setCanAskPrice, listDeclarants`.
- Modify `src/handlers/admin.js` — kartochkada 2 tugma + `emp:dc`, `emp:ap` actionlar.
- Modify `src/ui.js` — `BTN.prices = '💲 Narxlar'`, `mainKeyboard({ isPrice })`, `kbFor/kbForEmp`.
- Modify `src/app.js` — require + register + `STEP_HANDLERS` (pq_desc, pq_media, pq_price, pq_price_note, pq_question, pq_answer, pq_search) + kutish bosqichlari matni (`pq_pick`, `pq_due`, `pq_confirm`).
- Modify `src/services/activity.js` — `price_ask, price_given, price_question, price_answer, price_cancel`.
- Modify `src/config.js` — `priceRemindMin`.
- Modify `src/jobs.js` — `price-nag` cron + yuqoridagi izoh jadvaliga qator.
- Modify `src/services/excel.js` — `buildPriceRequests(from, to)`.
- Modify `src/fixes.js` — Samandar fix + `askPrice` action.
- Modify `src/index.js` — `setMyCommands` ga `/narx` (apostrofsiz matn!).
- Test: `scripts/smoke.js` — oxiridagi `await sleep(50); await db.close();` dan OLDIN `// --- 💲 Narx so'rovlari ---` bloki.
- Docs: `CLAUDE.md` (yangi 25-bo'lim), `LOYIHA.md` (bo'lsa).

---

### Task 1: Rollar — sxema, bayroqlar, kartochka tugmalari, menyu, Samandar fix

**Files:**
- Modify: `src/db/schema.js` (employees CREATE ~80-qator; MIGRATIONS oxiri; jadvallar `warnings` dan keyin ~456)
- Modify: `src/services/employees.js` (`isHr` yonida ~135; exports)
- Modify: `src/handlers/admin.js` (kartochka qatorlari ~114; `emp:hr` action ~927 yonida)
- Modify: `src/ui.js` (BTN, mainKeyboard, kbFor, kbForEmp)
- Modify: `src/fixes.js`
- Test: `scripts/smoke.js`

**Interfaces:**
- Produces: `employees.isDeclarant(e) -> boolean` (active && is_declarant=1), `employees.canAskPrice(e) -> boolean` (active && can_ask_price=1), `employees.setDeclarant(id, on) -> Promise`, `employees.setCanAskPrice(id, on) -> Promise`, `employees.listDeclarants() -> Promise<row[]>` (faol, `is_declarant=1`, `lower(full_name)` bo'yicha; `SELECT` konstantasi bilan — `department_name` ham bor). `ui.BTN.prices = '💲 Narxlar'`. Jadvallar `price_requests`, `price_request_msgs` (Task 2 ishlatadi).

- [ ] **Step 1: Failing testlar (`scripts/smoke.js` yangi blok)**

Blok boshida: `USERS` ga `50001: { id: 50001, first_name: 'Dilshod', username: 'dilshod' }`, `50002: { id: 50002, first_name: 'Samandar', username: 'samandar' }`; `employees.add({ tgId: 50001, fullName: 'Dilshod Deklarant', position: 'Deklarant' })`, `employees.add({ tgId: 50002, fullName: 'Samandar', position: 'Sotuv menejeri' })`. `const kbText = (chatId) => JSON.stringify(to(chatId).slice(-1)[0].payload.reply_markup || {})`.

```js
ok('narx: bayroqsiz hodimda «💲 Narxlar» yo\'q', /* send msg(50002,'/menu') */ !kbText(50002).includes('💲 Narxlar'));
// direktor kartochkadan: cbq(1000, `emp:dc:${dil.id}:1`), cbq(1000, `emp:ap:${sam.id}:1`)
ok('narx: kartochkada deklarant yoqildi', employees.isDeclarant(await employees.byId(dil.id)));
ok('narx: kartochkada «narx so\'ray oladi» yoqildi', employees.canAskPrice(await employees.byId(sam.id)));
ok('narx: eskirgan tugma (qayta :1) holatni o\'zgartirmaydi', /* cbq(1000, `emp:dc:${dil.id}:1`) yana */ employees.isDeclarant(await employees.byId(dil.id)));
ok('narx: hodim kartochkani o\'zgartira olmaydi', /* cbq(30001, `emp:dc:${dil.id}:0`) */ employees.isDeclarant(await employees.byId(dil.id)));
ok('narx: ruxsatlilarda «💲 Narxlar» bor', /* /menu 50001 va 50002 */ kbText(50001).includes('💲 Narxlar') && kbText(50002).includes('💲 Narxlar'));
ok('narx: listDeclarants', (await employees.listDeclarants()).map((e) => e.id).join() === String(dil.id));
ok('narx: Samandar fix ro\'yxatda', require('../src/fixes').FIXES.some((f) => f.id === 'samandar-narx-20261031' && f.action === 'askPrice' && f.match({ tg_id: 8254184544 })));
ok('narx: jadvallar bor', (await db.count('SELECT COUNT(*) AS c FROM price_requests')) === 0 && (await db.count('SELECT COUNT(*) AS c FROM price_request_msgs')) === 0);
```

- [ ] **Step 2: `npm test` → yangi `narx:` qatorlari ❌**

- [ ] **Step 3: Sxema**

`employees` CREATE ga va MIGRATIONS oxiriga (`// 31-okt-2026: deklarant va narx so'rovi ruxsati`): `is_declarant INTEGER NOT NULL DEFAULT 0`, `can_ask_price INTEGER NOT NULL DEFAULT 0`. Yangi jadvallar (`${pk}` naqshi bilan, spec §10 ustunlari aynan; qo'shimcha `asked_at TEXT`):

```
price_requests: id, requester_id INTEGER NOT NULL, declarant_id INTEGER NOT NULL, description TEXT NOT NULL,
  media_type TEXT, media_file_id TEXT, due_at TEXT, status TEXT NOT NULL DEFAULT 'open', price TEXT, price_note TEXT,
  created_at TEXT NOT NULL, priced_at TEXT, cancelled_at TEXT, cancelled_by INTEGER, asked_at TEXT,
  last_reminded_at TEXT, overdue_notified_at TEXT, asked_nudged_at TEXT, parent_id INTEGER
INDEX idx_price_decl ON price_requests(declarant_id, status); idx_price_req ON price_requests(requester_id, status)
price_request_msgs: id, request_id INTEGER NOT NULL, author_id INTEGER NOT NULL, kind TEXT NOT NULL,
  text TEXT, media_type TEXT, media_file_id TEXT, created_at TEXT NOT NULL
INDEX idx_price_msgs ON price_request_msgs(request_id)
```

- [ ] **Step 4: employees, ui, admin, fixes**

- `employees`: `isViewer/setViewer` naqshida 5 ta funksiya (Interfaces).
- `ui`: `BTN.prices`; `mainKeyboard({ …, isPrice = false })` — rollar qatorlaridan keyin, `isViewer` qatoridan oldin `if (isPrice) rows.push([BTN.prices])`. `kbFor`: `isPrice: ctx.state.isAdmin || flag(emp,'is_hr') || flag(emp,'is_declarant') || flag(emp,'can_ask_price')`; `kbForEmp` — xuddi shunday (`emp.role === 'admin'`).
- `admin.js` kartochka: `[🧑‍💼 HR …]` qatoridan keyin yangi qator — `cb(isDeclarant ? '📑 Deklarant: ha' : "📑 Deklarant: yo'q", `emp:dc:${id}:${0|1}`)`, `cb(canAskPrice ? "💲 Narx so'ray oladi: ha" : "💲 Narx so'ray oladi: yo'q", `emp:ap:${id}:${0|1}`)`. Actionlar `emp:hr` aynan naqshida (`guard`, `stale`, `answerCbQuery('Saqlandi')`, `employeeCard`); hodimga xabar yuborilmaydi.
- `fixes.js`: `{ id: 'samandar-narx-20261031', action: 'askPrice', match: (e) => Number(e.tg_id) === 8254184544 }` (izoh bilan) va `if (f.action === 'askPrice') await employees.setCanAskPrice(e.id, true);`.

- [ ] **Step 5: `npm test` → ikkala fayl to'liq ✅, handler xatosi 0**

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.js src/services/employees.js src/handlers/admin.js src/ui.js src/fixes.js scripts/smoke.js
git commit -m "Price requests: declarant / can-ask-price flags, schema, menu button, Samandar fix"
```

---

### Task 2: `services/priceRequests.js` — baza qatlami

**Files:**
- Create: `src/services/priceRequests.js`
- Test: `scripts/smoke.js` (narx bloki davomi)

**Interfaces:**
- Consumes: Task 1 jadvallari.
- Produces (hammasi `async`, `id` lar — Number):
  - `dueAtFor(key, now = time.now()) -> string|null` — Global Constraints dagi kalitlar; noma'lum kalit → `undefined`.
  - `create({ requesterId, declarantId, description, media = null, dueAt = null, parentId = null }) -> row` (`media = { type, fileId }`)
  - `byId(id) -> row|null` — `requester_name`, `requester_tg`, `declarant_name`, `declarant_tg`, `declarant_active` JOIN bilan.
  - `inbox(declarantId) -> row[]` — open|asked; tartib: `due_at IS NULL` oxirida, `due_at` o'sish, keyin `id` o'sish.
  - `mine(requesterId) -> row[]` — open|asked, `id DESC`.
  - `allOpen() -> row[]` — open|asked, `declarant_name, id`.
  - `setPrice(id, declarantId, price, note = null) -> boolean` — open|asked → priced (`priced_at`).
  - `ask(id, declarantId, { text = null, media = null }) -> boolean` — open|asked → asked (`asked_at = now`, `asked_nudged_at = NULL`) + msg `kind='question'`.
  - `answer(id, requesterId, { text = null, media = null }) -> boolean` — asked → open (`last_reminded_at = now`) + msg `kind='answer'`.
  - `cancel(id, byEmployeeId) -> boolean` — open|asked → cancelled (`cancelled_at`, `cancelled_by`).
  - `messages(id) -> row[]` (`author_name` bilan, `id` o'sish).
  - `history({ q = null, limit = 10 }) -> row[]` — priced, `priced_at DESC`; `q` bo'lsa `LOWER(description) LIKE LOWER($1)` (`%q%`).
  - `forPeriod(from, to) -> row[]` — `created_at` sanasi `[from, to]` (yyyy-MM-dd; `substr(created_at,1,10)` — ikkala dialektda), `id` o'sish.
  - `stats(from, to, now = time.now()) -> [{ declarantId, name, total, priced, avgMinutes|null, late, open }]` — `forPeriod` asosida JS da; `late` = (priced va `priced_at > due_at`) yoki (open|asked va `due_at <= now`).
  - `dueForReminder(nowIso, minutes) -> row[]` — status `open`, `COALESCE(last_reminded_at, created_at) <= cutoff`, faol deklarant.
  - `markReminded(ids, nowIso)`; `overdue(nowIso) -> row[]` (open|asked, `due_at <= now`, `overdue_notified_at IS NULL`); `markOverdue(id, nowIso)`;
    `askedStale(nowIso, minutes) -> row[]` (asked, `asked_nudged_at IS NULL`, `asked_at <= cutoff`); `markAskedNudged(id, nowIso)`.
  - `countInbox(declarantId)`, `countMine(requesterId) -> number`.

- [ ] **Step 1: Failing testlar**

```js
const pr = require('../src/services/priceRequests');
const t0 = time.now().set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
ok('narx svc: dueAtFor', pr.dueAtFor('1h', t0) === t0.plus({ minutes: 60 }).toISO() && pr.dueAtFor('none', t0) === null
  && pr.dueAtFor('today', t0).startsWith(`${t0.toFormat('yyyy-MM-dd')}T${employees.workEndOf(null)}`));
const r1 = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'Mijoz Ali: 20 quti telefon g\'ilofi', dueAt: pr.dueAtFor('3h', t0) });
const r2 = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'Mijoz Vali: mebel 2 t' });
ok('narx svc: inbox tartibi (muddatlisi birinchi)', (await pr.inbox(dil.id)).map((r) => r.id).join() === `${r1.id},${r2.id}`);
ok('narx svc: ask → asked, msg yozildi', await pr.ask(r1.id, dil.id, { text: 'Brendmi?' }) && (await pr.byId(r1.id)).status === 'asked' && (await pr.messages(r1.id)).length === 1);
ok('narx svc: begona javob bera olmaydi', !(await pr.answer(r1.id, dil.id, { text: 'x' })));
ok('narx svc: answer → open', await pr.answer(r1.id, sam.id, { text: 'Yo\'q' }) && (await pr.byId(r1.id)).status === 'open');
ok('narx svc: begona deklarant narx bera olmaydi', !(await pr.setPrice(r1.id, sam.id, '100$')));
ok('narx svc: setPrice', await pr.setPrice(r1.id, dil.id, '1 250$', 'yetkazish bilan') && (await pr.byId(r1.id)).price === '1 250$');
ok('narx svc: ikkinchi setPrice → false', !(await pr.setPrice(r1.id, dil.id, '1$')));
ok('narx svc: cancel', await pr.cancel(r2.id, sam.id) && !(await pr.cancel(r2.id, sam.id)));
ok('narx svc: history qidiruv', (await pr.history({ q: 'TELEFON' })).map((r) => r.id).join() === String(r1.id) && (await pr.history({ q: 'mebel' })).length === 0);
const st = await pr.stats(bugun, bugun);
ok('narx svc: stats', st.length === 1 && st[0].total === 2 && st[0].priced === 1 && st[0].avgMinutes !== null);
ok('narx svc: countInbox 0', (await pr.countInbox(dil.id)) === 0);
```

- [ ] **Step 2: `npm test` → `narx svc:` ❌ (modul yo'q)**

- [ ] **Step 3: `src/services/priceRequests.js` ni yozish** — `services/warnings.js` uslubida (fayl boshida JSDoc: maqsad, holatlar, «hech narsa o'chirilmaydi»). `avgMinutes` — luxon `DateTime.fromISO(priced_at).diff(DateTime.fromISO(created_at), 'minutes')`, yaxlitlangan o'rtacha.

- [ ] **Step 4: `npm test` → ✅**

- [ ] **Step 5: Commit** — `git add src/services/priceRequests.js scripts/smoke.js` · `Price requests: data service (transitions, history, stats, reminder queries)`

---

### Task 3: `handlers/price.js` — menyu, so'rov sehrgari, deklarant ro'yxati, narx/savol/javob, bekor/qayta

**Files:**
- Create: `src/handlers/price.js`
- Modify: `src/app.js` (require, `register` — `warnHandler` dan keyin, `tasksHandler` dan OLDIN, chunki media ushlagichi; STEP_HANDLERS; kutish bosqichlari matni)
- Modify: `src/services/activity.js` (5 ta ACTIONS: `price_ask 💲 Narx so'radi`, `price_given ✅ Narx berdi`, `price_question ❓ Narx bo'yicha savol`, `price_answer 💬 Savolga javob`, `price_cancel ❌ Narx so'rovini bekor qildi`; `major: true`)
- Modify: `src/index.js` (`/narx` — tavsif matnida apostrof yo'q: `'Narx sorovlari'`)
- Test: `scripts/smoke.js`

**Interfaces:**
- Consumes: Task 1 (`employees.*`, `ui.BTN.prices`), Task 2 (`priceRequests.*`).
- Produces: `price.register(bot)`, `price.nag(bot, now)` (Task 4 to'ldiradi — hozircha yo'q), handler funksiyalari STEP_HANDLERS uchun: `handleDesc(ctx)`, `handleMedia(ctx, { skip })`, `handlePrice(ctx)`, `handlePriceNote(ctx, { skip })`, `handleQuestion(ctx)`, `handleAnswer(ctx)`, `handleSearch(ctx)` (Task 5).
- Sessiya: `{ step, pq: { declarantId, description, media, dueKey, parentId, id } }`.
- Huquq yordamchilari (fayl ichida): `canAsk(ctx)` = rahbar || `employees.canAskPrice(emp)`; `isMgr(ctx)` = `ctx.state.isAdmin || ctx.state.isHr`; `isDecl(ctx)` = `employees.isDeclarant(emp)`.

Callbacklar: `pq:menu`, `pq:new`, `pq:d:<empId>`, `pq:sk` (media o'tkazish), `pq:due:<key>`, `pq:send`, `pq:x0` (qoralamani bekor), `pq:in` / `pq:in:<page>`, `pq:v:<id>`, `pq:p:<id>`, `pq:q:<id>`, `pq:a:<id>`, `pq:x:<id>`, `pq:r:<id>`, `pq:my`.

- [ ] **Step 1: Failing testlar (to'liq oqim)**

```js
// so'rov: Samandar
await send(msg(50002, '💲 Narxlar')); await send(cbq(50002, 'pq:new'));
ok('narx oqim: deklarant ro\'yxati (o\'zi yo\'q)', Boolean(findCb(50002, new RegExp(`^pq:d:${dil.id}$`))) && !findCb(50002, new RegExp(`^pq:d:${sam.id}$`)));
await send(cbq(50002, `pq:d:${dil.id}`)); await send(msg(50002, 'Mijoz Karim: 50 kg kosmetika'));
await send(photo(50002, '')); await send(cbq(50002, 'pq:due:3h'));
mark = sent.length; await send(cbq(50002, 'pq:send')); // `mark` smoke.js da allaqachon e'lon qilingan — qayta `let` qilinmaydi
const q1 = (await pr.mine(sam.id))[0];
ok('narx oqim: so\'rov yaratildi (rasm + muddat)', q1 && q1.media_file_id === 'BIG_FILE_ID' && q1.due_at && q1.status === 'open');
ok('narx oqim: deklarantga rasm + 3 tugma', sent.slice(mark).some((s) => s.method === 'sendPhoto' && Number(s.payload.chat_id) === 50001
  && ['pq:p:', 'pq:q:', 'pq:in'].every((k) => JSON.stringify(s.payload.reply_markup).includes(k))));
// ro'yxat
await send(msg(50001, '💲 Narxlar'));
ok('narx oqim: deklarant darhol ro\'yxatni ko\'radi', lastText(50001).includes('Karim') && Boolean(findCb(50001, new RegExp(`^pq:v:${q1.id}$`))));
// savol → javob
await send(cbq(50001, `pq:q:${q1.id}`)); mark = sent.length; await send(msg(50001, 'Qaysi brend?'));
ok('narx oqim: savol so\'rovchiga + «Javob berish»', allText(50002, mark).includes('Qaysi brend?') && Boolean(findCb(50002, new RegExp(`^pq:a:${q1.id}$`))));
ok('narx oqim: holat asked', (await pr.byId(q1.id)).status === 'asked');
await send(cbq(50002, `pq:a:${q1.id}`)); mark = sent.length; await send(msg(50002, 'Nivea'));
ok('narx oqim: javob deklarantga, holat open', allText(50001, mark).includes('Nivea') && (await pr.byId(q1.id)).status === 'open');
// begona
await send(cbq(30001, `pq:p:${q1.id}`));
ok('narx oqim: begona narx bera olmaydi', session.get(30001).step !== 'pq_price');
// narx
await send(cbq(50001, `pq:p:${q1.id}`)); await send(msg(50001, '320$')); mark = sent.length; await send(msg(50001, '⏭ O\'tkazib yuborish'));
ok('narx oqim: narx so\'rovchiga + «Qayta so\'rash»', allText(50002, mark).includes('320$') && Boolean(findCb(50002, new RegExp(`^pq:r:${q1.id}$`))) && (await pr.byId(q1.id)).status === 'priced');
mark = sent.length; await send(cbq(50001, `pq:p:${q1.id}`));
ok('narx oqim: eskirgan «Narx berish» — sessiya ochilmaydi, xabar yo\'q', session.get(50001).step !== 'pq_price' && countSince(mark, 50002) === 0);
// qayta so'rash
await send(cbq(50002, `pq:r:${q1.id}`)); await send(cbq(50002, 'pq:due:none')); await send(cbq(50002, 'pq:send'));
const q2 = (await pr.mine(sam.id))[0];
ok('narx oqim: qayta so\'rash — parent_id, tavsif/media nusxa', q2.parent_id === q1.id && q2.description === q1.description && q2.media_file_id === 'BIG_FILE_ID' && q2.due_at === null);
// bekor
await send(cbq(30001, `pq:x:${q2.id}`));
ok('narx oqim: begona bekor qila olmaydi', (await pr.byId(q2.id)).status === 'open');
mark = sent.length; await send(cbq(50002, `pq:x:${q2.id}`));
ok('narx oqim: bekor → deklarantga xabar', (await pr.byId(q2.id)).status === 'cancelled' && allText(50001, mark).includes('bekor'));
```

- [ ] **Step 2: `npm test` → `narx oqim:` ❌**

- [ ] **Step 3: `src/handlers/price.js` ni yozish** (`handlers/warn.js` uslubi: `render`, `ui.inline/cb/esc`, `session`, `botOf`)

Matn shablonlari (aniq):
- Deklarantga: `💲 <b>NARX SO'ROVI №${id}</b>\n👤 ${so'rovchi}\n⏰ Muddat: ${muddat|'muddatsiz'}\n${LINE}\n${esc(tavsif)}`; media bo'lsa `notify.sendProof(bot, tg, media, text, kb)`, aks holda `notify.toUser`. Tugmalar: `[💲 Narx berish pq:p:id] [❓ Savol bor pq:q:id]`, `[📥 Barcha so'rovlar pq:in]`.
- Ro'yxat sarlavhasi: `📥 <b>NARX KUTILMOQDA (${n})</b>`; har tugma: `${belgi} №${id} · ${requester_name} · ${tavsif.slice(0,30)} · ${muddat soati|—}`, belgi: muddati o'tgan 🔴, `asked` 💬, aks holda 🟡; 10 tadan sahifa (`pq:in:<page>`), bo'sh bo'lsa `<i>Hozircha so'rov yo'q ✅</i>`.
- So'rovchiga narx: `✅ <b>№${id} — NARX BERILDI</b>\n${esc(tavsif.slice(0,200))}\n${LINE}\n💲 <b>${esc(narx)}</b>${izoh ? `\n📝 ${esc(izoh)}` : ''}\n<i>${deklarant}</i>` + `[🔄 Qayta so'rash pq:r:id]`.
- Savol: `❓ <b>№${id} — DEKLARANT SAVOLI</b>` …  + `[💬 Javob berish pq:a:id]`; javob: `💬 <b>№${id} — JAVOB</b>` … + `[💲 Narx berish] [❓ Savol bor]`.
- Bekor: deklarantga `❌ №${id} so'rov bekor qilindi` + tavsif boshi.
- `pq:menu`: faqat deklarant (so'ray olmaydi, rahbar emas) → darhol ro'yxat; aks holda inline menyu (spec §2), sanoqlar `countInbox/countMine`. Hech qanday ruxsati yo'q → `⛔️ Narx bo'limi sizga ochiq emas.` + `ui.kbFor(ctx)`.
- Muddat klaviaturasi: `[⏱ 1 soat pq:due:1h] [⏱ 3 soat pq:due:3h]`, `[📅 Bugun pq:due:today] [☀️ Ertaga pq:due:tomorrow]`, `[♾ Muddatsiz pq:due:none]`, qayta so'rashda qo'shimcha `[👤 Deklarantni almashtirish pq:new]` (qoralama saqlanadi), `[❌ Bekor qilish pq:x0]`.
- Media bosqichi: `[⏭ O'tkazish pq:sk]` inline + `ui.skipKeyboard()` matni ham ishlaydi; media turlari `photo, document, video, voice, audio` (`chat.js mediaOf` naqshi — faylga lokal nusxa). `bot.on([...], onMedia)` — `pq_media`, `pq_question`, `pq_answer` bosqichlarida, aks holda `next()`.
- Har harakatda `activity.mark(ctx, 'price_*', { title: `№${id} ${tavsif.slice(0,60)}` })`.

`app.js` STEP_HANDLERS (huquq handler ichida tekshiriladi — flaglarsiz `{ run }`): `pq_desc, pq_media (skip), pq_price, pq_price_note (skip), pq_question, pq_answer, pq_search`. Kutish bosqichlari ro'yxatiga (`'⬆️ Yuqoridagi tugmalardan tanlang (yoki /menu).'`) `pq_pick, pq_due, pq_confirm` qo'shiladi.

- [ ] **Step 4: `npm test` → ✅, handler xatosi 0**

- [ ] **Step 5: Commit** — `git add src/handlers/price.js src/app.js src/services/activity.js src/index.js scripts/smoke.js` · `Price requests: bot flow (request wizard, declarant inbox, price/question/answer, cancel/re-request)`

---

### Task 4: Eslatmalar — `nag(bot, now)` + cron

**Files:**
- Modify: `src/handlers/price.js` (`nag` qo'shiladi, export)
- Modify: `src/config.js` (`priceRemindMin: num(process.env.PRICE_REMIND_MIN, 60)`)
- Modify: `src/jobs.js` (`schedule('price-nag', `*/5 6-21 * * ${dow}`, async () => { const n = await price.nag(bot); if (n) await logRun('price-nag', n); })`; yuqoridagi izohlar jadvaliga `har 5 daq   price-nag   — 💲 narx so'rovi: deklarantga har PRICE_REMIND_MIN daqiqada, muddat o'tsa so'rovchiga`)
- Test: `scripts/smoke.js`

**Interfaces:**
- Consumes: Task 2 `dueForReminder, markReminded, overdue, markOverdue, askedStale, markAskedNudged`.
- Produces: `price.nag(bot, now = time.now()) -> Promise<number>` — yuborilgan xabarlar soni; ish kuni/vaqti tashqarisida darhol `0`.

Xatti-harakat:
1. Ish kuni emas yoki `nowMin` oynadan tashqarida → `0`.
2. `dueForReminder` → deklarant bo'yicha guruhlash → har deklarantga **bitta** xabar: `⏰ <b>NARX KUTILMOQDA (${n})</b>` + har qator `🟡|🔴 №id · so'rovchi · tavsif 40 · (…dan beri — time.prettyDuration)`; tugmalar: har so'rovga `💲 №id` (`pq:p:id`), oxirida `📥 Barcha so'rovlar`; keyin `markReminded`.
3. `overdue` → so'rovchiga `⚠️ №id ga hali narx berilmadi (muddat ${soat})`, deklarantga `🔴 №id muddati o'tdi` → `markOverdue`.
4. `askedStale(now, priceRemindMin)` → so'rovchiga `💬 №id — deklarant savoliga javob kutilmoqda` + `pq:a:id` → `markAskedNudged`.

- [ ] **Step 1: Failing testlar**

```js
const price = require('../src/handlers/price');
const wd = (() => { let d = time.now(); while (!time.isWorkDay(d.toFormat('yyyy-MM-dd'))) d = d.plus({ days: 1 }); return d; })();
const at10 = wd.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
const old = at10.minus({ minutes: 70 }).toISO();
const a = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'A yuk' });
const b = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'B yuk', dueAt: at10.minus({ minutes: 5 }).toISO() });
const c = await pr.create({ requesterId: sam.id, declarantId: dil.id, description: 'C yuk' });
await db.query('UPDATE price_requests SET created_at = $1 WHERE id IN ($2, $3, $4)', [old, a.id, b.id, c.id]);
await pr.ask(c.id, dil.id, { text: 'savol' }); await db.query('UPDATE price_requests SET asked_at = $1 WHERE id = $2', [old, c.id]);
mark = sent.length; await price.nag(bot, at10);
const toDil = sent.slice(mark).filter((s) => Number(s.payload.chat_id) === 50001 && (s.payload.text || '').includes('NARX KUTILMOQDA'));
ok('narx eslatma: bitta xabar, 2 ta so\'rov (asked yo\'q)', toDil.length === 1 && toDil[0].payload.text.includes(`№${a.id}`) && toDil[0].payload.text.includes(`№${b.id}`) && !toDil[0].payload.text.includes(`№${c.id}`));
ok('narx eslatma: muddat o\'tdi — so\'rovchiga', allText(50002, mark).includes(`№${b.id} ga hali narx berilmadi`));
ok('narx eslatma: savolga javob kutilmoqda — so\'rovchiga', allText(50002, mark).includes(`№${c.id}`) && Boolean(findCb(50002, new RegExp(`^pq:a:${c.id}$`))));
mark = sent.length; await price.nag(bot, at10.plus({ minutes: 5 }));
ok('narx eslatma: 5 daqiqadan keyin takror yo\'q (overdue ham bir marta)', countSince(mark, 50001) === 0 && countSince(mark, 50002) === 0);
mark = sent.length; await price.nag(bot, at10.plus({ minutes: 61 }));
ok('narx eslatma: 60 daqiqadan keyin yana', countSince(mark, 50001) === 1);
mark = sent.length; await price.nag(bot, wd.set({ hour: 20, minute: 0 }));
ok('narx eslatma: ish vaqtidan tashqari — yo\'q', sent.length === mark);
await employees.deactivate(dil.id); mark = sent.length; await price.nag(bot, at10.plus({ minutes: 130 }));
ok('narx eslatma: nofaol deklarantga yo\'q', countSince(mark, 50001) === 0);
await employees.activate(dil.id);
```

- [ ] **Step 2: `npm test` → `narx eslatma:` ❌**
- [ ] **Step 3: `nag`, config, jobs ni yozish**
- [ ] **Step 4: `npm test` → ✅**
- [ ] **Step 5: Commit** — `git add src/handlers/price.js src/config.js src/jobs.js scripts/smoke.js` · `Price requests: hourly reminders in work hours, overdue and unanswered-question notices`

---

### Task 5: Tarix/qidiruv, rahbar statistikasi, barcha ochiqlar, Excel

**Files:**
- Modify: `src/handlers/price.js` (`pq:h`, `pq:hs` → `pq_search`, `pq:st:<7|30>`, `pq:all`, `pq:xl:<7|30>`)
- Modify: `src/services/excel.js` (`buildPriceRequests(from, to) -> { buffer, filename }`, export)
- Test: `scripts/smoke.js`

**Interfaces:**
- Consumes: Task 2 `history, stats, forPeriod, allOpen`; `notify.docToUser`.
- Produces: `excel.buildPriceRequests(from, to)` — bitta varaq `Narx so'rovlari`, ustunlar: `№, Sana, So'rovchi, Deklarant, Tavsif, Muddat, Holat, Narx, Izoh, Narx berildi, Javob (daq)`; fayl nomi `narx-sorovlari-${from}_${to}.xlsx`.

Xatti-harakat: `pq:h` — oxirgi 10 ta (`📜 <b>NARXLAR TARIXI</b>`; qator: `№id · sana · so'rovchi\n   tavsif 60 → 💲 narx`) + `[🔎 Qidirish pq:hs]`; qidiruv natijasi 20 tagacha, topilmasa `<i>Topilmadi</i>`. Ko'radi: deklarant, ruxsatli, rahbar. `pq:st:<d>` — davr `[bugun−(d−1), bugun]`, har deklarant qatori `👤 ism — so'rov N · narx N · o'rtacha ${prettyDuration|—} · 🔴 kechikkan N · ⏳ ochiq N`; tugmalar `[7 kun] [30 kun]`, `[📋 Barcha ochiq pq:all]`, `[📥 Excel pq:xl:d]`. `pq:all` — deklarant bo'yicha guruhlangan, `declarant_active = 0` bo'lsa sarlavhada `⚠️ nofaol`. Statistika/all/Excel — faqat `isMgr`.

- [ ] **Step 1: Failing testlar**

```js
await send(cbq(50002, 'pq:h'));
ok('narx tarix: oxirgi narx ko\'rinadi', lastText(50002).includes('320$'));
await send(cbq(50002, 'pq:hs')); await send(msg(50002, 'kosmetika'));
ok('narx tarix: qidiruv topdi', lastText(50002).includes('Karim'));
await send(cbq(50002, 'pq:hs')); await send(msg(50002, 'zzzz'));
ok('narx tarix: topilmadi', lastText(50002).includes('Topilmadi'));
await send(cbq(50002, 'pq:st:7'));
ok('narx stat: hodimga yopiq', !lastText(50002).includes('o\'rtacha'));
await send(cbq(1000, 'pq:st:7'));
ok('narx stat: direktor ko\'radi', lastText(1000).includes('Dilshod') && lastText(1000).includes('o\'rtacha'));
await employees.deactivate(dil.id); await send(cbq(1000, 'pq:all'));
ok('narx stat: nofaol deklarant ochiqlari ⚠️', lastText(1000).includes('nofaol'));
await employees.activate(dil.id);
mark = sent.length; await send(cbq(1000, 'pq:xl:7'));
ok('narx stat: Excel yuborildi', sent.slice(mark).some((s) => s.method === 'sendDocument' && Number(s.payload.chat_id) === 1000));
const xf = await excel.buildPriceRequests(bugun, bugun); const xwb = new ExcelJS.Workbook(); await xwb.xlsx.load(xf.buffer);
ok('narx stat: Excel varag\'i va qatorlar', Boolean(xwb.getWorksheet('Narx so\'rovlari')) && xwb.getWorksheet('Narx so\'rovlari').rowCount >= 3);
```

- [ ] **Step 2: `npm test` → ❌**
- [ ] **Step 3: Yozish**
- [ ] **Step 4: `npm test` → ✅**
- [ ] **Step 5: Commit** — `git add src/handlers/price.js src/services/excel.js scripts/smoke.js` · `Price requests: history search, manager stats, all-open list, Excel`

---

### Task 6: Yakuniy tekshiruv va hujjatlar

**Files:**
- Modify: `CLAUDE.md` (yangi `## 25. 31-okt-2026: 💲 Deklarant va narx so'rovlari` — qisqa: rollar, oqim, callbacklar `pq:*`, jadvallar, `PRICE_REMIND_MIN`, cron `price-nag`, Samandar fix, test soni, «deploy qilinmagan — Railway trial»; 3-bo'limdagi fayl ro'yxatiga `priceRequests.js`, `price.js`)
- Modify: `LOYIHA.md` agar papkada bo'lsa (rollar, biznes oqim, qarorlar 31-okt)

- [ ] **Step 1: Sintaksis** — `for f in $(git ls-files 'src/*.js' 'src/**/*.js') src/services/priceRequests.js src/handlers/price.js; do node --check "$f" || echo XATO $f; done` → `XATO` yo'q.
- [ ] **Step 2: `npm test`** → `smoke.js` va `smoke-bayoma.js` ikkalasi `🎉 … 0 yiqildi · handler xatolari: 0`.
- [ ] **Step 3: Postgres** (lokal PG 17 mavjud bo'lsa) — `SMOKE_DATABASE_URL=postgres://…/bo'sh_baza node scripts/smoke.js` → ✅. Mavjud bo'lmasa — hisobotda «Postgres'da sinalmadi» deb yoziladi.
- [ ] **Step 4: Hujjatlar** — CLAUDE.md 25-bo'lim, LOYIHA.md.
- [ ] **Step 5: Commit** — `git diff CLAUDE.md` ni ko'rish: boshqa sessiyaning IaC tahrirlari bo'lsa, foydalanuvchidan so'rash (ular bilan commit qilish yoki faqat 25-bo'limni `git add -p` siz alohida qoldirish). Keyin `git add docs/superpowers CLAUDE.md [LOYIHA.md]` · `Docs: price requests (declarant) section, spec and plan`.
- [ ] **Step 6: 2-miyya** — `brain.mjs search missiya` → `event <id> milestone "Missiya bot: deklarant narx so'rovlari qo'shildi (deploy kutilmoqda)"`.

Deploy bu rejaga kirmaydi (Railway trial tugagan — CLAUDE.md §24); foydalanuvchi tarif tanlagach alohida.
