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
**106 tekshiruv**, v1 baza soxtalashtirilib migratsiya ham sinaladi). Deploy: `Dockerfile`, `railway.json`, `Procfile`.

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
                      score-nudge (25-kun), monthly-kpi (1-kun 9:20, + oylik davr hisoboti matni), backup (23:50, SQLite)
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

## Ishga tushirish

```bash
npm install
npm test
npm start
npm run admin -- 7802923308 "Islombek"   # botsiz admin
npm run db:check
```
