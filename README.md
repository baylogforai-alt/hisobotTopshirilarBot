# 🎯 BayLog Cargo — Missiya Bot v2

Davomat (GPS), missiya/topshiriq + tekshiruv, **kunlik hisobot topshirish**, KPI-bonus,
hodimlar arxivi va Excel hisobotlarini bitta yopiq Telegram botga birlashtiradi.
Faqat direktor qo'shgan Telegram ID lar ishlaydi; begona `/start` bossa — direktorga
«➕ Hodim qilib qo'shish» tugmasi boradi.

---

## Kim nima qiladi

| Rol | Tugmalar |
|---|---|
| 👤 **Hodim** | ✅ Ishga keldim (GPS, faqat ofisdan) · 🏁 Ishdan ketdim · 📋 Missiyalarim · ✔️ Bajardim (rasm/video bilan) · ➕ Missiya qo'shish · **📝 Kunlik hisobot** · 📊 Hisobotim · 🙋 Kelmayman (sabab) |
| 🎖 **Bo'lim boshlig'i** | hodim tugmalari + 📤 Topshiriq berish (o'z bo'limiga) · 🔎 Tekshiruv (qabul / qaytarish) · 🏢 Bo'limim · ⭐ Baholash (1–10, KPI ga kiradi) |
| 👑 **Direktor / HR** | hammasi + ⚙️ Panel (hodimlar, bo'limlar, so'rovlar, ofis, kunlik hisobotlar) · 💰 KPI · 📈 Hisobotlar (davr hisoboti, Excel) · 🗂 Arxiv (kun daftari, harakatlar tarixi) |

## Kundalik oqim

1. **8:55** — bot hali kelmaganlardan «Ishga kelyapsizmi?» (Ha / Yo'q) so'raydi. **9:00** — guruhga «Xayrli tong» + kutilayotganlar; har hodimga o'z ish boshlanishi vaqtida shaxsiy eslatma.
2. Hodim **«✅ Ishga keldim»** → joylashuv → ofis radiusida bo'lsa qayd etiladi. Kech kelsa sabab so'raladi. Boshliqqa va (`ANNOUNCE_DONE`) guruhga xabar.
3. Boshliq **«📤 Topshiriq berish»** → hodim → matn (bir nechta qator = bir nechta ish, `!` — muhim) → muddat. Hodim o'ziga **«➕ Missiya qo'shish»** bilan reja yozadi; kun ichida paydo bo'lgan ish — `/bugun matn`.
4. Har 2 soatda: hodimga tugmali eslatma, guruhga ochiq ishlar ro'yxati, tekshiruvchiga kutayotganlar soni.
5. Hodim **«✔️ Bajardim»** (checklist) → rasm/video (ixtiyoriy) → boshliqqa **✅ Qabul / ↩ Qaytarish**. KPI ga faqat qabul qilinganlar kiradi. Qaytarilgan ish yana faol bo'ladi (`RETURN_PENALTY_PCT` jarima).
6. **17:30** — kunlik hisobot topshirmaganlarga eslatma. Hodim **«📝 Kunlik hisobot»**: bugun nima qildi, muammo/taklif — matn (+rasm). Boshliq/direktorga keladi: **👁 Ko'rdim / 💬 Izoh**. «Ketdim» bosganda hisobot yo'q bo'lsa — avtomatik so'raladi.
7. **18:00** — guruhga kun yakuni (kim keldi, aynan qaysi ishlarni bajardi/qoldirdi; pul yo'q), direktorga batafsil + kunlik hisobotlar holati, hodimlarga «ertangi rejani yoz». **18:45** — rejasi yo'qlarga eslatma.
8. **Dushanba 9:10** — o'tgan hafta jamoa hisoboti + Excel direktorga. **Oyning 1-kuni 9:20** — o'tgan oy KPI hisoblanadi → direktorga Excel + «💰 KPI» tugmasi (tahrirlash, tasdiqlash, chiqarish); hodimga natija + bonus.
9. Bajarilmagan missiyalar **yo'qolmaydi** — ertangi ro'yxatda 🔴 kechikkan belgisi bilan turadi.

## Kunlik hisobot (📝)

Bot nomi «hisobot topshiriladi» — shu funksiya markazda:

- Hodim kun oxirida o'z so'zi bilan yozadi (bugun belgilangan ✅ ishlar eslatma sifatida ko'rsatiladi), rasm biriktirish mumkin. Bir kun = bitta hisobot (qayta yozsa almashadi).
- Tekshiruvchilarga (bo'lim boshlig'i, bo'lmasa direktor) darhol keladi — «👁 Ko'rdim» / «💬 Izoh yozish»; hodimga bildirishnoma.
- Direktor: Panel → **📋 Kunlik hisobotlar** — bugun kim topshirdi/topshirmadi, matnlarni ochish, kunlar bo'ylab yurish, topshirmaganlarga eslatma.
- Arxiv kun daftarida, davr hisobotida (📝 ustuni), oylik/shaxsiy hisobotda («Kunlik hisobotlar: N ta»), CRM feed'da va barcha Excel fayllarda («Kunlik hisobotlar» varag'i, «Kunlar» varag'ida matn) ko'rinadi.
- `DAILY_REPORT_REQUIRED=false` — «Ketdim» da so'ralmaydi va eslatma yuborilmaydi (tugma qoladi).

## KPI formulasi

Har bo'lim uchun 4 ta vazn (yig'indi 100), standart **40 / 20 / 20 / 20**:

| Komponent | Manba |
|---|---|
| 📋 Topshiriq % | muddatida qabul qilingan / muddati kelgan ishlar − har qaytarish uchun `RETURN_PENALTY_PCT` (avto) |
| 🕘 Davomat % | (vaqtida + kech×0.5) / ish kunlari, sababli kunlar chiqariladi (avto) |
| ⭐ Boshliq bahosi | 1–10 (boshliq oy oxirida) ×10 |
| 🎯 Bo'limga xos mezon | nomi bo'lim kartochkasida, foizni direktor kiritadi |

`KPI = Σ(komponent% × vazn) / Σ(vazn)`; kiritilmagan komponent hisobdan chiqariladi. `Bonus = fond × ball / 100` (fond hodim kartochkasida so'mda; kiritilmasa faqat ball). Bo'lim yaratilmasa hamma «Bo'limsiz» bo'lib standart vaznlar ishlaydi.

## Direktor hisobotlari

- **📈 Davr hisoboti** (`/davr`) — istalgan sana oralig'i: tayyor tugmalar (bugun, shu hafta, o'tgan oy, 7/30/90 kun, shu yil), **kalendar** (🟢 boshlanish, 🔴 tugash) yoki qo'lda `01.09.2026 - 07.09.2026`. Butun jamoa (umumiy raqamlar + oldingi davr bilan solishtirish + 🏆 reyting + har hodim) yoki bitta hodim (xulosa, kun-kun jadval, bajargan ishlari, ochiqlari, kunlik hisobotlari). `/oraliq 2026-09-01 2026-09-07 [tg_id]` — bir buyruq bilan.
- **🗂 Arxiv** (`/arxiv`) — hodim → **kun daftari** (qachon keldi/ketdi, ofisdan masofa, bajargan/bajarmagan ishlari, yozib qo'yganlari, o'chirganlari, kunlik hisoboti, botga yozgan matnlari, faolligi) → ◀️ ▶️ kunlar bo'ylab · 📜 harakatlar tarixi (har bir tugma/buyruq vaqti bilan) · 📊 7/30 kunlik · 📥 Excel.
- **📥 Excel** (`/jamoa_excel`, Panel, Hisobotlar) — davr (bugun / shu hafta / o'tgan hafta / shu oy / o'tgan oy) → butun jamoa (1 fayl) / har bir hodim alohida / bitta hodim. Hodim o'zi uchun `/excel`.

| Fayl | Varaqlar |
|---|---|
| Oylik (KPI) | KPI · Topshiriqlar · Davomat · Kunlik hisobotlar · Bo'limlar |
| Hodim, davr | Xulosa · Bajarilgan ishlar · Kunlar (keldi/ketdi/soat/nima qildi/hisobot) · Missiyalar · Kunlik hisobotlar · Harakatlar |
| Jamoa, davr | Jamlanma (har hodim bitta qator + JAMI) · Kunlar · Missiyalar · Kechikkanlar · Bajarilganlar · Kunlik hisobotlar |
| Bugun | Kun (hodim/ish/holat) · Davomat · Kunlik hisobotlar |

Sarlavha muzlatilgan, filtr yoqilgan, soatlar raqam, holatlar rangli.

## Buyruqlar

Hodim: `/keldim /ketdim /missiyalarim /bajardim /vazifa /bugun /kunlik /kelmayman /hisobot /excel /id /yordam`
Boshliq: `/topshiriq /tekshiruv /bolim /baholash /kunlik_hisobotlar`
Direktor: `/panel /kpi /hisobotlar /arxiv /davr /oraliq /jamoa_excel /hodim_qosh <id> /hodimlar /bolimlar /sorovlar /hodim_hisobot <id> /hodim_missiya <id> /hodim_ochir <id> /hodim_tikla <id> /admin_qil <id> /erkin <id> /kechikkanlar /eslat /holat /kun_hisobot /tizim /ofis /ofis_radius <m> /ofis_korish /ofis_ochir /guruh_ulash (guruh ichida)`

## Ishga tushirish

```bash
npm install
cp .env.example .env    # BOT_TOKEN va ADMIN_IDS ni to'ldiring
npm test                # oflayn: 106 tekshiruv, soxta Telegram bilan to'liq oqim
npm start
```

Birinchi qadamlar botda (direktor sifatida): `/panel` → **📍 Ofis joylashuvi** (ofisda turib) → hodimlar `/start` bosganda qo'shish (yoki `src/hodimlar.js` ro'yxati — bot ishga tushganda bazada yo'qlari avtomatik qo'shiladi) → kerak bo'lsa **🏢 Bo'limlar** va boshliq roli → guruhda `/guruh_ulash`. Direktor o'zini ham hodim qilib qo'shsa Keldim/Bajardim ishlaydi.

`npm run admin -- <tg_id> "Ism"` — botsiz admin qo'shish · `npm run seed` — hodimlar.js ro'yxatini bazaga kiritish · `npm run db:check` — baza · `npm run backup` — SQLite zaxira.

### v1 dan o'tish

Bot ishga tushganda eski `missions` jadvali topilsa (va `tasks` bo'sh bo'lsa) yozuvlar avtomatik `tasks` ga ko'chiriladi (`done` → `accepted`, direktor bergan → `source=admin`), eski jadval `missions_v1` nomi bilan saqlanib qoladi. Hodimlar, davomat, sozlamalar o'zgarmaydi.

## Baza va deploy

`SUPABASE_DB_PASSWORD` (yoki `DATABASE_URL`) bo'lsa PostgreSQL, bo'lmasa `data/bot.db` (SQLite, har kuni 23:50 zaxira `data/backups/`). Railway/Koyeb: `Dockerfile` + `railway.json`/`Procfile`; SQLite bo'lsa `/app/data` ga volume ulang (`DB_PATH=/app/data/bot.db`). Bir vaqtda faqat **bitta nusxa** ishlashi kerak (aks holda 409 Conflict).

`CRM_API_SECRET` qo'yilsa health serverda `GET /crm/snapshot` (sarlavha `x-crm-secret`) ochiladi — CRM uchun bugungi missiyalar, davomat va kunlik hisobotlar (faqat o'qish).

## Struktura

```
src/app.js          createBot() — handlerlar + STEP_HANDLERS (sessiya bosqichi → matn qayerga)
src/index.js        launch, hodimlar.js seed, cron, health (+CRM feed)
src/services/       employees, departments, tasks, attendance, dailyReports, activity, history (kun daftari),
                    period (davr hisoboti), reports, excel, kpi, requests, notify, office, backup, crmFeed
src/handlers/       common (start/whitelist/harakat kuzatuvi), join (hodim qo'shish), attendance (+intent),
                    tasks (+/bugun), dailyReport, admin, kpi, reports, hr (arxiv), period, excelMenu
src/db/schema.js    departments · employees · tasks · attendance · daily_reports · activity_log · kpi_monthly · join_requests · sessions · settings
scripts/smoke.js    npm test
```
