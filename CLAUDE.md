# BayLog Cargo Missiya Bot v2 — davomat · missiya/topshiriq · kunlik hisobot · KPI · arxiv

> Keyingi Claude sessiyasi uchun: loyihani qayta tushuntirmasdan shu joydan davom ettirish uchun yetarli.

## 1. Loyiha nima

BayLog Cargo uchun **yopiq** Telegram bot (`@topshirila_hisobot`). 21-sen-2026 da v1 («missiya bot») **BAYOMA v3**
(`C:\Users\user\Desktop\BAYOMA\missiya bot bayoma`) arxitekturasi asosida qayta qurildi va v1 ning o'ziga xos
funksiyalari ko'chirildi + yangi «kunlik hisobot» qo'shildi:

- **BAYOMA'dan**: bo'limlar + boshliq roli, topshiriq berish → «Bajardim» (isbot rasm/video) → qabul/qaytarish, sababli kun,
  alohida ish boshlanishi, KPI-bonus (oylik), join_requests sehrgari, sessiya bazada, `telegram.safe`, `render` (edit-in-place), backup.
- **v1 dan**: `activity_log` (har bir harakat), 🗂 arxiv (kun daftari, harakatlar tarixi, 7/30 kun), 📈 davr hisoboti (kalendar, qo'lda sana,
  oldingi davr bilan solishtirish, reyting), 📥 Excel menyusi (kun/hafta/oy → jamoa/har hodim/bitta), CRM feed (`/crm/snapshot`),
  8:55 «kelyapsizmi?» (intent), 18:45 reja eslatmasi, haftalik hisobot, `/bugun`, `hodimlar.js` avtomatik seed, guruhga real vaqt e'lonlari (`ANNOUNCE_DONE`).
- **Yangi**: 📝 **Kunlik hisobot** (`daily_reports`) — hodim matn (+rasm) yozadi → tekshiruvchilarga «👁 Ko'rdim / 💬 Izoh» → arxiv/davr/Excel/CRM da ko'rinadi;
  «Ketdim» da hisobot yo'q bo'lsa so'raladi; 17:30 eslatma; Panel → «📋 Kunlik hisobotlar».
- **v1 → v2 migratsiya**: `missions` jadvali topilsa (va `tasks` bo'sh) → `tasks` ga ko'chiriladi, eski jadval `missions_v1` (schema.LEGACY_COPY, sqlite/postgres `migrateLegacy`).
  `idx_employees_dept` indeksi MIGRATIONS dan keyin (`POST_MIGRATION`) yaratiladi — eski bazada ustun yo'q edi.

## 2. Tex-stek

Node ≥20 (muhitda 24), CommonJS, `telegraf` 4.16 long polling, `pg` **yoki** `better-sqlite3` ^12 (v11 Node 24 da yiqiladi),
`node-cron` (Asia/Tashkent), `exceljs`, `luxon`, `dotenv`. Test: `npm test` → `scripts/smoke.js` (alohida SQLite, `Telegram.prototype.callApi` stub,
**133 tekshiruv**, v1 baza soxtalashtirilib migratsiya ham sinaladi) **+ `scripts/smoke-bayoma.js`** (BAYOMA'ning 504 tekshiruvi,
BAYOMA sozlamalari bilan: video, oy boshi, gate KPI, majburiy isbot; tugma nomlari `LABELS` bilan BayLog'ga o'giriladi). `npm test` ikkalasini ishlatadi.
Deploy: `Dockerfile`, `railway.json`, `Procfile`.

## 3. Fayl strukturasi (BAYOMA CLAUDE.md dagi bilan bir xil + qo'shimchalar)

```
src/app.js            createBot(); STEP_HANDLERS — +daily_report_text (emp, skip), daily_review_note (mgr), period_dates (admin)
src/index.js          launch + hodimlar.js ensureMany + setMyCommands + cron + health
src/config.js         +announceDone, dailyReportRequired, dailyReportRemindMin, crmApiSecret, officeRadiusM (250), reminderIntervalHours (2)
src/health.js         HTTP OK + GET /crm/snapshot (x-crm-secret, CRM_API_SECRET bo'lsa)
src/ui.js             BTN (✅ Ishga keldim · 🏁 Ishdan ketdim · 📋 Missiyalarim · ✔️ Bajardim · ➕ Missiya qo'shish · 📝 Kunlik hisobot · 📊 Hisobotim · 🗂 Arxiv ...),
                      doneChecklist, intentKeyboard, dailyReviewKeyboard, panelKeyboard (arxiv/davr/excel/kunlik hisobotlar bilan)
src/services/
  tasks.js            BAYOMA + createdOn/cancelledOn/dueOn/doneBetween/createdBetween/forRange/hasCoverageFor/dayRows
  attendance.js       BAYOMA + setIntent, workingNow
  employees.js        BAYOMA + ensureMany
  dailyReports.js     byId/get/submit (UPSERT)/review/forDate/range/rangeAll/missingToday/countBetween
  activity.js         ACTIONS (start/checkin/checkin_far/late_reason/checkout/intent_*/absence/task_add/task_today/task_done/task_cancel/task_edit/
                      assigned/assign/review_ok/review_back/daily_report/note/my_tasks/my_report/excel/help/menu/use/admin); log/track/mark; forDay/forRange/countsByDay/lastSeen
  history.js          dayCard (kun daftari: ish vaqti, bajargan, bajarmagan, yozgan, o'chirgan, KUNLIK HISOBOTI, matnlar, faollik), timeline, teamOverview, statusLine
  period.js           employeeStats (attendance.stats + tasks.stats + doneBetween + reports + activity) / teamStats / employeeReport / teamReport (trend, reyting)
  reports.js          buildToday (+📝), buildDailyGroupText (itemli ✅/⏳), buildMorningDigest, sendMorningGroupCall, sendReminder (DM tugmali + guruh + tekshiruvchi),
                      buildMyReport (+hisobotlar soni), buildMonthTable (+📝), buildEmployeeTasks
  excel.js            buildMonthly (5 varaq), buildEmployeeMonth (4), buildDay (3), buildEmployeePeriod (6), buildTeamPeriod (6), buildEmployeeHistory, buildTeamSummary
  crmFeed.js          snapshot(): tasks (active/done + bugun accepted), attendance (+lateMinutes, excused, dailyReport), totals
src/handlers/
  common.js           attachEmployee + trackUsage (ctx.state.logged bo'lmasa 'use' yoziladi) + notRegistered + yordam
  attendance.js       BAYOMA + intent:yes/no, activity marks, guruh e'lonlari, Ketdim → dailyReport.askReport (hisobot yo'q bo'lsa)
  tasks.js            BAYOMA + activity marks, guruhga «bajarildi», /bugun, /missiyalarim, doneChecklist
  dailyReport.js      askReport / handleReportText / onMedia (photo) / dr:seen / dr:note / dr:view / dr:today / dr:day / dr:remind / remindMissing
  admin.js            BAYOMA + kartochkada arxiv/Excel tugmalari, /umumiy_hisobot /kun_hisobot /kechikkanlar /eslat /tizim /ofis_korish /ofis_ochir
                      /hodim_ochir /hodim_tikla /admin_qil /erkin /hodim_missiya
  reports.js          BAYOMA + rp:daily, hisobotlar menyusida davr/arxiv/excel; /excel endi excelMenu da
  hr.js               hr:* arxiv (render/guard umumiy), 7/30 kun period.employeeReport orqali
  period.js           pr:* (preset, kalendar, qo'lda sana, kim, ko'rish, Excel), /oraliq
  excelMenu.js        xl:* (davr → kim → fayl), xlme:* hodim
src/jobs.js           pre-start-intent (start−5), morning-group (start), morning-call (0,30), morning-digest, overdue-alert, reminder (har N soat),
                      report-nudge (end−30), daily-report (end: guruh + direktor + hodimlarga reja), plan-nudge (end:45), weekly-report (Du 9:10),
                      score-nudge (25-kun), monthly-kpi (1-kun 9:20, + oylik davr hisoboti matni), backup (23:50, SQLite) / backup-export (23:50, Postgres → direktorga JSON)
```

## 4. Baza — BAYOMA jadvallari + `daily_reports` (employee_id+work_date UNIQUE, text, photo_file_id, submitted_at, reviewed_by/at, review_note),
`activity_log`, `attendance.intent/intent_at`. Callback prefikslari: BAYOMA'niki + `dr:` kunlik hisobot · `hr:` arxiv · `pr:` davr · `xl:`/`xlme:` Excel · `intent:`.

## 5. Qarorlar (21-sen-2026)

- Guruhga real vaqt e'lonlari (keldi/ketdi/bajarildi/kelmayman) `ANNOUNCE_DONE` bilan boshqariladi (v1 odati saqlandi); BAYOMA'da bunday yo'q edi.
- Kunlik hisobot KPI ga kirmaydi (faqat ko'rinadi/eslatiladi) — kerak bo'lsa keyin bo'limga xos mezon sifatida qo'lda kiritiladi.
- v1 dagi `pending` (kelajakdagi) missiya holati yo'q — hamma ish darhol `active`, muddat bilan; `plan-nudge` `hasCoverageFor` = due_date ≥ ertaga.
- Texnik: uzun fayllar Write bilan; ko'p joyli patchlar scratchpad'dagi python skript orqali (Bash heredoc uzun matnda ishonchsiz); `rm`/`git rm` auto-mode da taqiqlangan → `mv` scratchpad'ga.
  v1 fayllari (`services/missions.js`, `handlers/missions.js`) scratchpad'ga ko'chirildi; git tarixida (`f2a7fc4`) bor.

## 6. Holat

- ✅ `npm test` — 106/106, handler xatosi 0. `npm run db:check` lokal `data/bot.db` da v1 → v2 migratsiyasini bajardi (1 missiya → tasks, `missions_v1` qoldi; `data/bot.db.pre-v2-backup` nusxasi bor).
- ✅ 21-sen-2026 **Railway'ga deploy qilindi**: loyiha `missiya-bot-baylog` (`1f7a7f70-a8f5-427d-a874-2b50bc60baf4`), servis `missiya-bot`, baza — shu loyihadagi **Postgres** servisi (`DATABASE_URL` → `postgres.railway.internal`, tashqi TCP proxy yo'q).
  Prod migratsiyasi o'tdi: `[db] v1 missions → tasks: 154 ta yozuv ko'chirildi (eski jadval: missions_v1)`. Health: https://missiya-bot-production.up.railway.app/ ; `/crm/snapshot` kalit bilan (CRM_API_SECRET prod'da bor).
  Deploy usuli: `git push origin master:main` (GitHub `baylogforai-alt/hisobotTopshirilarBot`, lokal branch `master` → remote `main`) + **`railway up --detach`** (GitHub auto-deploy emas). Papka `railway link` qilingan.
  Rolling deploy paytida eski konteyner bilan bir marta 409 Conflict bo'ladi — jarayon qayta ishga tushib o'zi tuzaladi.
  Prod Variables: BOT_TOKEN, DATABASE_URL, COMPANY_NAME, TIMEZONE, WORK_START_HOUR=9, WORK_END_HOUR=19, WORK_DAYS, REMINDER_INTERVAL_HOURS=2, ANNOUNCE_DONE, CRM_API_SECRET. `ADMIN_IDS` yo'q — adminlar bazada role=admin.
  Yangi ixtiyoriy kalitlar (standart bilan ishlaydi): DAILY_REPORT_REQUIRED, DAILY_REPORT_REMIND_MIN, LATE_GRACE_MINUTES, RETURN_PENALTY_PCT, OFFICE_RADIUS_M, BACKUP_KEEP.
- ⬜ Haqiqiy Telegramda hodimlar bilan to'liq oqim (GPS, rasm bilan Bajardim, kunlik hisobot) hali sinalmagan. Lokal `npm start` prod bilan 409 beradi.
- ⚠️ Auto-mode: `railway ssh` (prod o'qish) rad etiladi — prod bazani zaxiralash uchun foydalanuvchi o'zi Railway dashboard'dan qilishi kerak.
- ✅ 23-sen-2026 **audit tuzatishlari** (hisobot: sessiya scratchpad `audit-hisobot.md`, 5/10 edi) — commit/deploy qilinmagan bo'lsa, git status'ga qarang:
  K1 `hs:*` da `canRate` (faqat boshliq/direktor, o'ziga emas) · Y1 `kpi_monthly.fund_manual` — oylik fond compute'da saqlanadi ·
  Y2 `kpi.editable()` — draft bo'lmagan qatorda setHeadScore/setCustomPct/setBonusFund null qaytaradi («Qayta ochish» kerak) ·
  Y3 hodim muddati o'tgan o'z ishini ko'chira/o'chira olmaydi (`scheduleGuard`), ko'chirish/o'chirishda tekshiruvchiga xabar ·
  Y4 aniqligi (`horizontal_accuracy`) yo'q joylashuv — qabul + tekshiruvchiga ⚠️; `STRICT_GPS=1` — rad etiladi (haqiqiy Telegramda sinalmagan) ·
  Y5 `attendance.stats` — `created_at` dan oldingi yozuvsiz kunlar hisobga kirmaydi · Y6 Postgres'da 23:50 `backup-export` → direktorga `.json.gz` (Panel «💾 Zaxira nusxa» ham) ·
  O2 tasks holat o'tishlari `WHERE status=… RETURNING id` · O3 bo'limsiz boshliq kompaniya ro'yxatini ko'rmaydi · O4 `adminLossBlock` (o'zini/oxirgi adminni) ·
  O5 fond maydoniga faqat raqam · O7 `dropPendingUpdates: false` · P12 `splitText` uzun qatorni ham bo'ladi.
  Qolgan (qilinmagan): O1 bayramlar, O6 `fixes.js` regex, O8 og'ir Excel botni to'xtatadi, O9 klaviatura sahifalash, O10 eslatma filtrlari, 🟢 past darajalar.
  Taqdimot: `Desktop\BAYCARGO\BayLog_Missiya_Bot_taqdimot.pptx` (generator: scratchpad `pptx/gen.js` + `post.py` — Morph + kirish animatsiyalari) va veb-versiya https://claude.ai/artifact/QiGck8z5VtM87nvvsdWeeX

## Ishga tushirish

```bash
npm install
npm test
npm start
npm run admin -- 7802923308 "Islombek"   # botsiz admin
npm run db:check
```

## 7. 2-okt-2026: BAYOMA (1–2-okt holati) yangiliklari ko'chirildi + 📢 E'lon

Foydalanuvchi: «BAYOMA botiga qara, bizni ham shunaqa takomillashtir, hammaga birdaniga 1 ta e'lon bo'lsin» → «bizda yo'q hammasini qo'sh»;
e'lon — «hammaga yoki hodimga degan tugma, 1–2 hodim tanlab yuborish».

**Usul:** v2 BAYOMA `a530279` (21-sen) asosida qurilgan edi → har bir fayl `git merge-file` (ours / base a530279 / BAYOMA HEAD `cfdcb77`) bilan
3 tomonlama birlashtirildi, ~77 konflikt qo'lda hal qilindi. Zaxira: sessiya scratchpad `src-before-port.tgz`, `audit-fixes.patch`.

**Ko'chirilganlar (BAYOMA §1–§7):** HR roli (`is_hr`), «👥 Hodimlarim» (team.js), yo'nalishlar (directions — callback **`dn:`**, chunki `dr:` bizda
kunlik hisobot; seed: Moliya, Logistika, Ombor, Sotuv), davomat nazoratchisi (`can_view_att`, `vw:`), «📋 Barcha topshiriqlar» jurnali (`tj:`),
topshiriq ovoz/video/fayl/rasm bilan + «✅ Eshitdim, tushundim» (`ak:`, `ackByText`), «⏰ Kech qolaman» (1 soat oldin — kechikish emas),
sabablar media bilan, rahbariyat (direktor + HR) tasdig'i, boshliq rejimi (`employees.isBoss` — role=admin hodim davomat/KPI/ro'yxatlardan chiqadi),
eslatmalar hodim/bo'lim bo'yicha (`rm:`/`rs:`, tick), umumiy ish vaqti (Panel «🕘 Ish vaqti», `worktime`), «🏷 Nomlar», rahbar nusxasi (`adm:htc`),
filiallar (`br:`), ofis/hudud rejimi + uy joylashuvi + «📍 Hududga keldim» (field.js, visits), Keldim videosi, oy boshi (`ms:`), «💵 Oylik va KPI»
(`pay:`, oklad `salary`), shartli KPI (gate), arxiv guruhi (`/arxiv_ulash`), `flows.js`/`access.js` (bot va Web App bitta mantiq),
**Web App** (`src/web/*`, `/app`, `/api/*`; `WEBAPP_URL` bo'sh — tugmalar o'chiq). `/crm/snapshot` endi `web/server.js` ichida (`health.handleCrm`).

**BayLog standartlari saqlandi (config):** `OFFICE_CHECKIN_VIDEO=false`, `MONTH_START_REQUIRED=false`, `KPI_MODE=score`, `PROOF_REQUIRED=0`
(«⏭ Isbotsiz yuborish» bor), `WORK_START` bo'lmasa `WORK_START_HOUR` (prod: 9 → 09:00), `BOSS_NAME=Direktor`, `BOSS_IS_STAFF=0`
(1 — direktor ham hodimdek hisoblanadi). Guruh e'lonlari (`ANNOUNCE_DONE`), kunlik hisobot, arxiv/davr/Excel, CRM, intent — o'z joyida;
pre-start-intent va morning-group endi tick ichida (ish vaqti dinamik). BayLog modullari (arxiv, davr, Excel menyusi, CRM, kunlik hisobot) `listStaff` ishlatadi.
O'zgargan qoidalar (BAYOMA'dan): hodim o'z topshirig'ini **bekor qila olmaydi** (faqat rahbar/HR/direktor; o'chirilmaydi — `cancelled`);
sababli kunni faqat direktor/HR hal qiladi (bo'lim rahbari faqat xabar oladi).

**📢 E'lon (yangi, BAYOMA'da yo'q):** `handlers/announce.js` + `services/announcements.js`; jadvallar `announcements`, `announcement_recipients`.
Kim: direktor/HR — hammaga, bo'lim rahbari — o'z jamoasiga. «👥 Hammaga» yoki «👤 Hodim tanlash» (✅/☐, sahifalab, «hammasini belgilash») →
matn yoki rasm/video/ovoz/fayl → ko'rib chiqish (direktor: «💬 Guruhga ham») → yuborish. Oluvchida «👁 O'qidim» (`an:r:<id>`),
yuboruvchida «📊 Kim o'qidi» (`an:v`), «🔔 O'qimaganlarga qayta yuborish» (`an:rs`), tarix (`an:list`). Kirish: tugma «📢 E'lon», `/elon`, Panel.
Sessiya: `announce_pick` → `announce_text` → `announce_confirm`. Activity: `announce`, `announce_read` (+ `task_ack`, `late_notice`, `visit`).

**Holat (2-okt):** `npm test` — 133/133 + 504/504, handler xatosi 0. Lokal v1 va v2 baza nusxalarida migratsiya o'tdi (`db:check`).
⬜ **Commit va deploy qilinmagan** (foydalanuvchi aytganda: `git push origin master:main` + `railway up --detach`). Postgres'da yangi SQL sinalmagan
(faqat ikkala dialektdagi konstruksiyalar ishlatilgan). Web App ga «📢 E'lon», kunlik hisobot, arxiv qo'shilmagan (faqat botda).
Web App yoqish uchun Railway'da `WEBAPP_URL=https://missiya-bot-production.up.railway.app/app`.

## 8. 5-okt-2026: «Bajardim» — bir nechtasini birdaniga

«✔️ Bajardim» ro'yxatida (2+ ochiq ish bo'lsa) «☑️ Bir nechtasini birdaniga belgilash» (`done:multi`) → ☑️/☐ belgilash (`done:t:<id>`, `done:all`),
sessiya `done_pick` (`donePicked`) → «✅ Davom etish» (`done:go`) → `done_proof` (`doneTaskIds`) → **bitta isbot hammasiga** (`finishDoneMany`).
Tekshiruvchiga bitta xabar (rasm bilan): har bir ishga `rv:ok:<id>` / `rv:back:<id>` + «✅ Hammasini qabul qilish» (`rv:okm:1,2,3`, ≤64 bayt bo'lsa).
Bittasi qabul qilinsa — xabar tugmalaridan o'sha qator olib tashlanadi (`dropReviewRow`). Bitta ish bosish (`done:<id>`) avvalgidek.
`npm test` — 142/142 + 504/504. ✅ 5-okt deploy qilindi (commit 8d69628).

## 9. 6-okt-2026: BAYOMA (2–5-okt, `cfdcb77..b439a7b`, 40 commit) yangiliklari ko'chirildi

Foydalanuvchi: «BAYOMA botini ko'rib chiq, olish mumkin bo'lgan yaxshi narsalarni hammasini ol, deploy qil, tizimni buzma».
Usul avvalgidek: har fayl `git merge-file` (ours / base `cfdcb77` / BAYOMA HEAD `b439a7b`), ~90 konflikt qo'lda. Zaxira: sessiya scratchpad `src-before-port2.tgz`.
**Keyingi ko'chirish uchun base = `b439a7b`.** Taqdimot (`taqdimot/`) ko'chirilmadi.

**Ko'chirilganlar:** ⏳ Faol · 🔁 Ko'rib chiqish · 🕓 Kutilmoqda · ✅ Bajarilgan — menyuda holat tugmalari (`handlers/status.js`, `sk:*`, /faol /kutilmoqda /bajarilgan /korib_chiqish);
topshiriqqa **boshlanish soati** (muddatdan keyin `as:tm:`/`st:tm:`, cron `task-start` har daqiqa → «hozir bajaring»); izohsiz ovoz/video topshiriqqa qisqa mazmun;
**«🏁 Ishdan ketdim» = joylashuv + izoh** (ofisdan tashqarida / agent uyiga yaqin — rad; erkin jadval — ⚠️), ish tugashidan oldin — «erta ketdi» (hodimga alohida `work_end`, kartochka «🏁 Ish tugashi»);
**Keldimsiz «Bajardim» yo'q** (`flows.doneBlocked`, bir nechtasini birdaniga ham); tekshiruvda «📝 Kamchilik bor» — izoh **majburiy** + **tuzatish muddati** (`rv:fd:*`; muddat berilmasa eski muddat — o'tgan bo'lsa kechikkan);
hodimga «👌 Xo'p, tushundim» / «💬 O'z javobim» (`tr:*`, `task_replies`); «💬 Savol-javob» chati (`/chat`, `qa:*` — menyuda tugmasi yo'q, BAYOMA'dagidek);
topshiriqni o'chirish (bekor qilish) — faol yoki tekshiruvdagi, boshliq o'z missiyasini ham; bir nechta hodimga topshiriq (`am:*`, `handlers/picker.js`);
HR boshliq/direktor topshiriqlarini ko'rmaydi (Panel «👁 HR boshliq topshiriqlarini», `hr_boss_tasks`; Excel ham — **BayLog davr/hafta Excellari ham** `{viewer}`);
KPI sharti (gate rejimida): 25 kun / 90% — Panel «🚦 KPI sharti» (BayLog `KPI_MODE=score` — faqat ma'lumot); **joriy oy KPI si oy tugamay tasdiqlanmaydi** (`kpi.decideBlock`);
dam olish kuni Keldim → `'extra'` holat (kechikish yo'q) + **«📅 Dam olish kuniga chaqirish»** (Panel `xc:*`, `extra_days`, summa oylikka); kechikishni sababli qilish (`lx:*`);
sababli kunni **bo'lim rahbari va boshliq** hal qiladi (HR faqat ko'radi); /yordam video (`/yordam_video`); agent uy joylashuvi eslatmasi (cron `home-location`);
ikki marta bosishdan himoya (`dedupeCallbacks`, almashtirish tugmalari `…:<0|1>`), guruhda buyruqlar yopiq (`groupGuard`), menyu tugmasi bosqichni tugatadi, bosqich 30 daqiqada eskiradi;
xaritadan tanlangan joy (venue) rad; o'ziga vazifa yozganda rahbarga xabar **bormaydi** (`b439a7b`; arxivda baribir ko'rinadi); Rahbar KPI summasi ko'rinishi (`adm:hm`).

**BayLog'da boshqacha qoldirilgan (config / qaror):** ish boshlanishi `WORK_START_HOUR` (9:00, BAYOMA 08:40), ofis radiusi 250 m (150 emas), agent 1 km, «Kech qolaman» 60 daq (20 emas),
`OFFICE_CHECKIN_VIDEO=false`, `MONTH_START_REQUIRED=false`, `KPI_MODE=score`, `PROOF_REQUIRED=0`. **Yangi: `BOSS_SEES_ATTENDANCE` (standart `true`)** — BAYOMA'da boshliq
keldi-ketdi/hisobotlarni standart olmaydi; BayLog'da adminlar faqat bazada (role=admin) — o'chirilsa ertalabki/kun yakuni hisoboti hech kimga bormas edi. Panel «👁 Boshliq keldi-ketdini» bilan o'zgaradi.
`notify.seeAllIds({noBoss})` — boshliqlarsiz hech kim qolmasa, boshliqlarga baribir boradi. `DAILY_REPORT_HOUR` standarti = `WORK_END_HOUR` (BAYOMA 19).
**📢 E'lon — BayLog'niki qoldi** (jadvallar boshqacha: `text/created_by/read_at`, «👁 O'qidim» `an:r:`), BAYOMA'dan **«🏢 Bo'limlarga»** qo'shildi (`an:dl` → `an:dt:<id|0>` → `an:dok`, «Bo'limsizlar» ham).
Web App `/api/announce*` va `flows.sendAnnouncement/resendAnnouncement` BayLog xizmatiga ulandi. Kunlik hisobot, arxiv (kun daftarida endi Ketdim joyi/izohi, dam olish kuni), davr, Excel, CRM, intent — o'z joyida.

**Testlar:** `npm test` — **144/144 + 770/770**, handler xatosi 0. Ikkalasi **Postgres'da ham** o'tdi: `SMOKE_DATABASE_URL=postgres://…/bo'sh_baza node scripts/smoke.js`
(v1-migratsiya bo'limi Postgres'da o'tkazib yuboriladi; mahalliy PG 17 — `C:\Program Files\PostgreSQL\17\bin`, `initdb -A trust` scratchpad'da, port 55432).
Postgres'da topilib tuzatilgan: `done:np` eskirgan tugmada `byId(undefined)` → NaN xatosi. Eski (HEAD `ebe91fc`) sxemali PG baza yangi kod bilan migratsiyadan keyin yangi bazaga **aynan teng** (ustunlar/indekslar).

**6-okt 09:24 — 📱 Ilova (Web App) yoqildi:** Railway'da `WEBAPP_URL=https://missiya-bot-production.up.railway.app/app` qo'yildi (avtomatik redeploy, SUCCESS).
Logda «📱 Web App menyu tugmasi: 6 ta chat». Odilxon (8726834955) botni /start qildi va shu akkauntdan foydalanadi — «chat not found» xatolari to'xtadi.
Ilovada kunlik hisobot, arxiv, davr hisoboti yo'q (faqat botda); «Ketdim» ilovadan bot orqali (joylashuv + izoh).

## 10. 6-okt-2026: 🧮 KPI kalkulyator

`handlers/kpiCalc.js` (callback **`kc:`**) — «agar … bo'lsa, qancha?»; **bazaga yozmaydi**. Holat butunlay callback ichida
(`kc:v:<d>.<t>.<a>.<h>.<c>.<f>.<s>.<g>` — bo'lim vaznlari, topshiriq %, davomat %, baho 1–10/n, mezon %/n, KPI summasi, oklad, gate sharti),
shuning uchun menyu sessiyani tozalasa ham karta ishlaydi; qo'lda son — sessiya `kc_input` (`kcField`, `kcState`).
Formula `kpi.computeTotal` / `kpi.bonusOf` bilan bir xil (gate rejimida — shart 🟢 bo'lsa summa to'liq). ±1/±10 tugmalar, «🏢 Vaznlar (bo'lim)», «💯 Hammasi a'lo»,
«+1% … ≈ N so'm» maslahatlari. Kirish: `/kalkulyator` (hodim — o'z joriy oyi), «💵 Oylik va KPI» (ro'yxat + oy tafsiloti «🧮 Kalkulyatorda»),
KPI bo'limi bosh sahifasi, hodim KPI kartochkasi («🧮 Kalkulyatorda» — hodim raqamlari bilan). Web App'da yo'q.
`npm test` — 159/159 + 771/771. ✅ 6-okt ~13:45 deploy qilindi (11-bo'lim bilan birga).

## 11. 6-okt-2026: 📊 CRM uchun oylik KPI — `GET /crm/kpi?month=YYYY-MM`

BAYLOG CRM → AI yordamchi → KPI (va Xodimlar sahifasidagi KPI bloki) endi shu botdan oladi (direktor qarori: «bot + CRM Vazifalar,
hammasi + botdagi KPI ball»). `services/crmKpi.js` `monthKpi(month)` — har faol hodim (`listStaff`): topshiriqlar (`tasks.stats`:
due/accepted/ontime/late/awaiting/open/overdue/returns/pct + `period.employeeStats` created/doneInMonth), davomat (workDays, workedDays,
lateDays, lateMinutes, absentDays, excusedDays, pct, avgArrival, hours), `reportDays`, KPI (`kpi.preview`). Noto'g'ri oy → joriy oy;
kelajak oy — null qiymatlar. Oklad (salary) CRM'ga BERILMAYDI.
`kpi.preview(emp, month)` — **BAZAGA YOZMAYDI**: tasdiqlangan/chiqarilgan qator bo'lsa o'sha, aks holda `buildRow` (compute bilan umumiy
hisob — `compute` endi `buildRow` + INSERT) natijasi, `saved` — kpi_monthly da qator bormi. Manzil `health.handleCrm` da
(`/crm/snapshot` bilan bir xil kalit `x-crm-secret` = CRM_API_SECRET; server.js `handleCrm(req, res, pathname, url)`).
Smoke: «CRM KPI: … bazaga yozmaydi» (kpi_monthly soni o'zgarmaydi), «noto'g'ri oy → joriy oy». `npm test` — 161/161 + 771/771.
CRM tomoni: `src/lib/missiya.ts` `missiyaKpi`, `src/lib/kpi-merge.ts` (ism bo'yicha moslash: x→h, kirill, to'liq mos ustun, «Akbar»↔«Akbarali»).
Zaxira (deploy oldi): `..\missiya-bot-zaxiralar\missiya-20261006-1342-deploy-oldi.sql` (bot papkasidan TASHQARIDA — `railway up` ga tushmasin).

⚠️ **6-okt 13:43 — bot ~1 daqiqa yiqildi**: `src/index.js` 29-qator `setMyCommands` matnida qochirilmagan apostrof
(`'... bo'lsa ...'` → SyntaxError, CRASHED). `npm test` buni USHLAMAYDI — smoke `index.js` ni yuklamaydi. Tuzatildi (`0a96828`).
**Deploydan oldin DOIM:** `for f in $(git ls-files 'src/*.js' 'src/**/*.js'); do node --check "$f" || echo XATO $f; done`.

## 12. 6-okt-2026: CRM'dan KPI sozlash — `POST /crm/kpi/set` (✅ 6-okt 14:52 deploy, `13314d6`; zaxira `..\missiya-bot-zaxiralar\missiya-20261006-1452-deploy-oldi.sql`; prod'da tekshirildi: /crm/kpi yangi maydonlar, /crm/kpi/set 404/400)

Direktor qarori: KPI summasi CRM'da kiritiladi va botga yoziladi; natijada oklad + KPI = jami oylik; CRM'da AI maslahat.
`crmKpi.setFromCrm(body)` — `{employeeId, month, bonusFund?, salary?, headScore?, customPct?, note?, by?}`: bot o'z funksiyalari
bilan yozadi — `employees.setBonusFund/setSalary` (kartochka standarti, qulfdan qat'i nazar) + shu oy qatori
(`kpi.compute` oklad snapshot, `kpi.setBonusFund/setHeadScore/setCustomPct` — faqat draft). Tasdiqlangan/chiqarilgan oy — `locked`.
Xatolar: `not_found` (faol emas), `bad_amount`, `bad_score` (1–10 butun), `bad_pct`, `future_month`. Log: `[crm] KPI sozlandi: ...`.
`health.handleCrm`: POST faqat `/crm/kpi/set` (JSON ≤ 10 KB), qolganlari GET. `/crm/kpi` javobiga `mode`, `kpi.salary`,
`kpi.weights`, `defaults {bonusFund, salary}` qo'shildi. Ruxsat CRM'da: faqat bosh direktor (mainOwner).
Smoke: +5 («CRM KPI set: ...», tasdiqlangan oy qulfi). `npm test` — 166/166 + 771/771. Deploydan oldin `node --check` (10-bo'lim ostidagi qoida).

## 13. 6-okt-2026: ➕ Qo'shimcha KPI — `kpi_extras` (⬜ commit qilingan, PUSH/DEPLOY QILINMAGAN)

Direktor: «+ bosib alohida KPI qo'shish — davomatga, bajargan ishlarga, qo'shimcha vazifaga (yakshanba); faqat foizga bog'liq;
muddat tanlanadi; bot ham, CRM ham». Jadval `kpi_extras` (schema.js tables(), IF NOT EXISTS): title, basis
(tasks|attendance|head|custom|total|manual), amount (100% da), pct (manual), month (bir martalik) | start_month..end_month (har oy),
removed_at. `services/kpiExtras.js`: forMonth/forKpi/withEarned (beriladi = summa × asos foizi, 0..100; excluded oy — 0), add, remove
(bir martalik — removed_at; har oylik — end_month = oldingi oy), lineText (HTML esc bilan). CRM: `crmKpi.extraFromCrm`
(POST /crm/kpi/extra; tasdiqlangan oy `locked`, kelajak oy rad), `/crm/kpi` → extras[], extrasTotal, offDays {total, dates}.
Bot ko'rinishlari: `month.js payInfo(k, extra, kpiExtra)` — xodimning «Oylik va KPI» (ro'yxat + oy tafsilotida «Qo'shimcha KPI»
bo'limi), `kpi.js kpiCardText(k, dept, ex)` — direktor kartasi, Jami ichida. Qo'shish/o'chirish hozircha FAQAT CRM'dan.
Ko'rsatilmaydi (ataylab, keyin): flows.js (ilova) va excel.js oylik Jami — eski hisob (extra_days ham kirmas edi).
Smoke +6 («qo'shimcha KPI: ...»). `npm test` — 172/172 + 771/771.
