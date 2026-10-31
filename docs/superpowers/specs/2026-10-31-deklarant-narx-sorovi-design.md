# 💲 Deklarant va narx so'rovlari — dizayn (31-okt-2026)

## Maqsad
Yukka narx kerak bo'lganda ruxsatli hodim (hozir — Samandar) deklarantga so'rov yuboradi; narx berilmaguncha deklarantga
ish vaqtida har soat eslatma boradi. Yuk ko'p bo'lsa chalkashmasligi uchun deklarantda alohida ro'yxat: qaysi so'rovchining
qaysi yukiga narx kutilmoqda. Muvaffaqiyat mezoni: hech bir so'rov «unutilib» qolmaydi; deklarant bitta tugma bilan barcha
ochiq so'rovlarni ko'radi; so'rovchi narxni botdan oladi.

## Foydalanuvchi qarorlari (31-okt)
| Savol | Javob |
|---|---|
| Kim so'raydi | Boshliq ruxsat bergan hodimlar; Samandar — boshidanoq |
| So'rovda nima | Yuk tavsifi (matn, mijoz ismi ham shu ichida), rasm/hujjat/ovoz (ixtiyoriy), muddat |
| Kimga boradi | So'rovchi deklarantni o'zi tanlaydi |
| Javob | Narx + izoh → so'rovchiga; qo'shimcha «❓ Savol bor» — deklarant yuk haqida savol beradi |
| Eslatma | Faqat ish kunlari va ish vaqtida, har 60 daq; savolga javob kutilayotganda — to'xtaydi; muddat o'tsa so'rovchiga xabar |
| Deklarant | Hali botda yo'q — yangi qo'shiladi, rahbar kartochkadan belgilaydi |
| Qo'shimcha | Narxlar tarixi va qidiruv · Statistika rahbarga · Bekor qilish / qayta so'rash |
| Kerak emas | Mijoz javobi (rozi/rad) — qilinmaydi |

## 1. Rollar
`employees` ga ikki ustun (MIGRATIONS `col(...)`, standart 0):
- `is_declarant` — «📑 Deklarant: ha/yo'q»
- `can_ask_price` — «💲 Narx so'ray oladi: ha/yo'q»

Hodim kartochkasida (admin.js, «🧑‍💼 HR» qatori ostida) almashtirish tugmalari: `emp:dc:<id>:<0|1>`, `emp:ap:<id>:<0|1>`
(mavjud `emp:hr` naqshi: eskirgan tugma — `stale`). O'zgartira oladi: direktor (role=admin / ADMIN_IDS) — hodim kartochkasi
faqat unga ochiq (`render.guard`); HR uchun alohida yo'l qilinmaydi.
`employees.isDeclarant(e)`, `employees.canAskPrice(e)`, `setDeclarant`, `setCanAskPrice`; `listDeclarants()` — faol deklarantlar.
Rahbarlar (boshliq, HR, ADMIN_IDS) bayroqsiz ham so'rov yubora oladi va hammasini ko'radi.
Samandar: `fixes.js` `samandar-narx-20261031` — `can_ask_price = 1` (bir marta).

## 2. Kirish nuqtasi
Asosiy menyuda **«💲 Narxlar»** tugmasi (va `/narx`) — faqat deklarant, ruxsatli hodim yoki rahbarga ko'rinadi.
Bosilganda inline menyu (`pq:menu`), kimga nima tegishli bo'lsa:
- 📥 **Narx kutilmoqda (N)** — deklarant (faqat deklarant bo'lsa menyu o'rniga darhol shu ro'yxat ochiladi)
- ➕ **Yangi so'rov** — ruxsatli / rahbar
- 📤 **Mening so'rovlarim (N)** — yuborgan ochiq so'rovlari
- 📜 **Narxlar tarixi** — hammasi
- 📊 **Statistika** va 📋 **Barcha ochiq so'rovlar** — rahbar

## 3. So'rov yuborish
Sessiya bosqichlari: `pq_pick` → `pq_desc` → `pq_media` → `pq_due` → tasdiq.
1. Deklarant tanlash (`pq:d:<empId>`). Faol deklarant yo'q bo'lsa — «Deklarant belgilanmagan, rahbarga ayting».
2. Yuk tavsifi — matn (bo'sh bo'lmasin, ≤ 2000 belgi).
3. Rasm/hujjat/video/ovoz — bitta media (`file_id` + turi) yoki «⏭ O'tkazish».
4. Muddat (`pq:due:<k>`): 1 soat · 3 soat · Bugun (ish oxiri) · Ertaga (ish oxiri) · Muddatsiz.
5. Ko'rib chiqish → «📨 Yuborish» / «✖️ Bekor».

Deklarantga xabar: «💲 NARX SO'ROVI №12 — Samandar; tavsif; muddat» (+ media nusxasi), tugmalar:
`💲 Narx berish` (`pq:p:<id>`) · `❓ Savol bor` (`pq:q:<id>`) · `📥 Barcha so'rovlar` (`pq:in`).

## 4. Deklarant ro'yxati (`pq:in`)
Ochiq so'rovlar (status `open`/`asked`) — har biri tugma: `🔴 №12 · Samandar · <tavsif 30 belgi> · 15:00`.
Tartib: muddati o'tganlar → muddati yaqinlar → muddatsiz (eng eskisi birinchi). `asked` — «💬 javob kutilmoqda» belgisi.
Bittasini bosish (`pq:v:<id>`) — to'liq kartochka: tavsif, media (qayta yuboriladi), muddat, savol-javob tarixi, tugmalar.
Ro'yxat 10 tadan sahifalanadi.

## 5. Narx berish va savol
- **Narx** (`pq:p:<id>` → sessiya `pq_price` → `pq_price_note` yoki «⏭ Izohsiz»): narx — erkin matn (masalan «1 250$», «3.5$/kg»).
  Holat `priced`, `priced_at`. So'rovchiga: «✅ №12 narx: … izoh: …» + `🔄 Qayta so'rash` tugmasi. Deklarantga: «Yuborildi».
- **Savol** (`pq:q:<id>` → `pq_question`): matn yoki media. Holat `asked`. So'rovchiga savol + `💬 Javob berish` (`pq:a:<id>`) →
  `pq_answer` → deklarantga javob, holat yana `open`. Takrorlanishi mumkin. Har yozuv `price_request_msgs` da.
- Holat o'tishlari `UPDATE … WHERE id = $1 AND status IN (…) RETURNING id` (ikki marta bosish / eskirgan tugma himoyasi).
  Faqat tayinlangan deklarant narx/savol bera oladi; faqat so'rovchi javob beradi/bekor qiladi (rahbar ham bekor qila oladi).

## 6. Bekor qilish / qayta so'rash
- `pq:x:<id>` (so'rovchi yoki rahbar; `open`/`asked` da) → `cancelled`; deklarantga «❌ №12 bekor qilindi», eslatmalar to'xtaydi.
- `pq:r:<id>` (`priced` yoki `cancelled` dagi so'rovda, so'rovchi) → yangi so'rov: tavsif/media/deklarant nusxa, `parent_id = <id>`,
  faqat muddat qayta tanlanadi (deklarantni almashtirish ham mumkin).

## 7. Eslatmalar (`jobs.js`)
- `price-nag` — `*/5 <start>-<end> * * <dow>` (ish kunlari). Shartlar: status `open`, hozir ish vaqti ichida,
  `COALESCE(last_reminded_at, created_at)` dan ≥ `PRICE_REMIND_MIN` (standart 60) daqiqa o'tgan → deklarantga
  «⏰ №12 — Samandar: <tavsif> — narx kutilmoqda (… dan beri)» + `💲 Narx berish` / `📥 Barcha so'rovlar`; `last_reminded_at = now`.
  Bir deklarantda bir nechta so'rov bo'lsa — **bitta xabar** ro'yxat bilan (chalkashmaslik uchun).
- Muddat o'tganda (bir marta, `overdue_notified_at`): so'rovchiga «⚠️ №12 ga hali narx berilmadi», deklarantga ham 🔴 bilan.
- `asked` holatida deklarantga eslatma yo'q; so'rovchiga «javob bering» eslatmasi — bir marta, 60 daqiqadan keyin.

## 8. Narxlar tarixi va qidiruv
`pq:h` — oxirgi 10 ta narxlangan so'rov (sana, so'rovchi, tavsif, narx). «🔎 Qidirish» → sessiya `pq_search` →
`LOWER(description) LIKE LOWER($1)` (SQLite va Postgres ikkalasida ishlaydi), 20 tagacha natija. Bosilsa — kartochka (o'qish uchun).
Ko'radi: deklarantlar, ruxsatli hodimlar, rahbarlar (hammasini).

## 9. Statistika (rahbar)
`pq:st:<7|30>` — davr bo'yicha har deklarant: so'rovlar, narx berilgan, o'rtacha javob vaqti (created → priced, soat:daqiqa),
muddatdan kechikkan, hozir ochiq; so'rovchilar bo'yicha soni. `pq:all` — barcha ochiq so'rovlar (deklarant bo'yicha guruhlab),
nofaol deklarantdagi ochiqlar ⚠️ bilan. «📥 Excel» — shu davr so'rovlari ro'yxati (bitta varaq, `excel.buildPriceRequests`).

## 10. Ma'lumot modeli (schema.js tables(), IF NOT EXISTS)
```
price_requests: id, requester_id (employee), declarant_id (employee), description TEXT, media_type, media_file_id,
  due_at (TEXT stamp | NULL), status (open|asked|priced|cancelled), price TEXT, price_note TEXT,
  created_at, priced_at, cancelled_at, cancelled_by (tg), last_reminded_at, overdue_notified_at, asked_nudged_at, parent_id
  indekslar: (declarant_id, status), (requester_id, status)
price_request_msgs: id, request_id, author_id (employee), kind (question|answer), text, media_type, media_file_id, created_at
```
Activity: `price_ask`, `price_given`, `price_question`, `price_answer`, `price_cancel`.

## 11. Doirada YO'Q (ataylab)
Mijoz javobi (rozi/rad), KPI ga ta'sir, Web App, CRM feed, deklarantni boshqasiga o'tkazish (bekor qilib qayta so'raladi),
valyuta/summa maydoni (narx — erkin matn). «Keldim»siz bot yopiq qoidasi (`attendance.guard`) deklarantga ham avvalgidek.

## 12. Chekka holatlar
- Deklarant nofaol qilinsa — ochiq so'rovlari rahbarning «Barcha ochiq» ro'yxatida ⚠️; so'rovchi bekor qilib qayta so'raydi.
- So'rovchi o'zi deklarant bo'lsa — o'ziga yuborishi mumkin emas (ro'yxatda o'zi chiqmaydi).
- Telegram xabar yetmasa (bloklagan) — `notify.toUser` xatoni yutadi, so'rov bazada qoladi, ro'yxatda ko'rinadi.
- Media `file_id` boshqa chatga `sendPhoto/sendDocument/sendVoice/sendVideo` bilan qayta yuboriladi (turi saqlanadi).
- Muddat ish vaqtidan keyin tushsa — overdue xabari ertangi ish boshida (cron faqat ish vaqtida).

## 13. Testlar
`scripts/smoke.js` ga +: bayroqlar (kartochka tugmasi, ruxsatsiz hodimga «💲 Narxlar» yo'q), to'liq oqim (so'rov → deklarantga
xabar → savol → javob → narx → so'rovchiga), eslatma (60 daq oldin yaratilgan → bitta xabar; `asked` → yo'q; ish vaqtidan tashqari → yo'q),
overdue bir marta, bekor qilish, qayta so'rash (`parent_id`), tarix qidiruvi, statistika, ikki marta bosish. Postgres'da ham
(`SMOKE_DATABASE_URL`). Deploydan oldin `node --check` barcha `src/*.js`.
