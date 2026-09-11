# 🎯 Missiya Bot — hodimlar vazifalari va hisobot boti

Har bir hodim o'z missiyalarini (vazifalarini) botga yozib qo'yadi, ertasi kuni
«Ishga keldim» deganda ular ishga tushadi, bot kun davomida **guruhda va shaxsiy
chatda** eslatib turadi, hodim bajarganini «Bajardim» tugmasi bilan belgilaydi.
Bajarilmagan missiyalar **yo'qolmaydi** — ertangi ro'yxatga qo'shilib qoladi.

---

## 1. O'rnatish

```bash
npm install
```

## 2. Sozlash

`.env.example` dan nusxa oling va to'ldiring:

```bash
cp .env.example .env
```

| Sozlama | Ma'nosi |
|---|---|
| `BOT_TOKEN` | @BotFather dan olinadi (**majburiy**) |
| `ADMIN_IDS` | Bosh adminlar Telegram ID si, vergul bilan (**majburiy**) |
| `GROUP_CHAT_ID` | Ishchi guruh ID si (yoki guruhda `/guruh_ulash` yozing) |
| `SUPABASE_PROJECT_REF` | Supabase loyiha kodi — `jiqukkidabklemienwcp` |
| `SUPABASE_DB_PASSWORD` | Supabase baza paroli. Bo'sh bo'lsa — mahalliy SQLite fayl |
| `SUPABASE_POOLER_HOST` | Ulanmasa: Session pooler host nomi |
| `DATABASE_URL` | (ixtiyoriy) to'liq ulanish satri — yozilsa yuqoridagilar o'rniga ishlaydi |
| `COMPANY_NAME` | Xabarlar sarlavhasidagi kompaniya nomi — `BayLog Cargo` |
| `TIMEZONE` | `Asia/Tashkent` |
| `WORK_START_HOUR` / `WORK_END_HOUR` | Ish vaqti, standart `9` – `18` |
| `REMINDER_INTERVAL_HOURS` | Necha soatda bir eslatilsin, standart `2` |
| `WORK_DAYS` | Ish kunlari (cron): `1-6` = dushanba–shanba |
| `ANNOUNCE_DONE` | Bajarilgan missiya guruhga e'lon qilinsinmi |

> **O'z Telegram ID ingizni bilish:** botga `/id` yozing.

## 3. Ishga tushirish

```bash
npm start
```

Tekshiruv testlari (Telegramsiz, oflayn):

```bash
npm test
```

---

## 4. Hozirgi holat (BayLog Cargo)

Bot: **@topshirila_hisobot** — token `.env` ga yozilgan.

Bazaga kiritilgan hodimlar (`npm run seed` bilan qayta tiklash mumkin):

| Telegram ID | Ism | Lavozim |
|---|---|---|
| `8254184544` | Samandar | Sotuv menejeri |
| `5934117099` | Akbarali | Marketolog |
| `7963610051` | Durdona | Operator |
| `7802923308` | Islombek | Dasturchi |

### Qolgan 3 qadam

1. **Rahbarni admin qilish** — botga `/id` yozing, chiqqan raqam bilan:
   ```bash
   npm run admin -- 123456789 "Rahbar"
   ```
2. **Botni guruhga qo'shing** va guruhda administrator qiling (xabar yubora olishi uchun).
3. Guruh ichida **`/guruh_ulash`** yozing → guruh bog'lanadi va eslatmalar o'sha yerga tusha boshlaydi.

### Keyinchalik yangi hodim qo'shish

```
/hodim_qosh 123456789 Akbar Karimov | Menejer
```

Hodim shu zahoti botdan xabar oladi va ishlata boshlaydi.

---

## 5. Hodim uchun kundalik tartib

| Bosqich | Nima qiladi |
|---|---|
| 🌅 Ertalab | **«✅ Ishga keldim»** → **📍 joylashuvni yuboradi** (ofisda ekani tekshiriladi) → missiyalar faollashadi, guruhga va boshqaruvchiga e'lon qilinadi |
| ⏰ Kun davomida | Bot har `N` soatda guruhda va shaxsiy chatda «shu missiyani bajardingmi?» deb eslatadi |
| ✔️ Ish tugagach | **«✔️ Bajardim»** → ro'yxatdan tanlaydi → guruhga «bajardi» deb yoziladi |
| 📝 Kech kirganda | **«➕ Missiya qo'shish»** — ertangi / 2-3 kunlik / 1 oylik ishlarni yozib qo'yadi |
| 🏁 Ketishdan oldin | **«🏁 Ishdan ketaman»** — kunlik yakun chiqadi, bajarilmaganlar ertaga o'tadi |

### Bir vaqtning o'zida bir nechta missiya yozish

Har birini yangi qatorga yozing. Muddatni qator oxirida `| kun` bilan
alohida belgilash mumkin:

```
Xitoydan kelgan yuklarni ro'yxatga olish
Mijoz Akbar bilan shartnoma imzolash | 3
Oylik moliyaviy hisobotni tayyorlash | 30
```

Keyin chiqqan tugmalardan umumiy muddat tanlanadi:
**Bugun · Ertaga · 2 kunlik · 3 kunlik · 1 haftalik · 1 oylik**.

---

## 6. Buyruqlar

### Hodim
| Buyruq | Vazifasi |
|---|---|
| `/start`, `/menu` | Asosiy menyu |
| `/keldim` | Ishga keldim |
| `/ketdim` | Ishdan ketaman |
| `/vazifa [matn]` | Yangi missiya |
| `/missiyalarim` | Barcha missiyalarim (bugungi, kelajakdagi, bajarilgan) |
| `/bajardim` | Bajarilganini belgilash |
| `/bekor` | Missiyani o'chirish |
| `/hisobot` | Shaxsiy hisobot (bugun / 7 kun / 30 kun) |
| `/id` | Telegram ID |
| `/yordam` | Qo'llanma |

### Administrator
| Buyruq | Vazifasi |
|---|---|
| `/hodim_qosh <id> <Ism> [\| Lavozim]` | Hodim qo'shish |
| `/hodimlar` | Hodimlar ro'yxati va hozirgi holati |
| `/hodim_ochir <id>` | Hodimni ro'yxatdan chiqarish |
| `/hodim_tikla <id>` | Qayta faollashtirish |
| `/admin_qil <id>` | Admin qilish / adminlikdan olish |
| `/topshiriq <id> <matn> [\| kun]` | Hodimga topshiriq berish |
| `/umumiy_hisobot` | Barcha hodimlarning hozirgi holati |
| `/kun_hisobot` | Bugun kim aynan qaysi ishni bajargani (batafsil) |
| **`/jamoa_excel`** | **📥 Excel yuklab olish menyusi: bugun / shu hafta / o'tgan hafta / shu oy / o'tgan oy → butun jamoa (1 fayl), har bir hodim alohida yoki bitta hodim** |
| **`/davr`** | **📈 Davr hisoboti — boshlanish/tugash sanasini o'zingiz tanlaysiz** |
| `/oraliq <dan> <gacha> [id]` | Bir buyruq bilan davr hisoboti (masalan `/oraliq 2026-09-01 2026-09-07`) |
| **`/arxiv`** | **🗂 Hodimlar arxivi — ilova ko'rinishidagi panel** |
| `/hodim_hisobot <id>` | Bitta hodimning bugungi kun daftari |
| `/hodim_missiya <id>` | Bitta hodimning barcha missiyalari |
| `/erkin <id>` | Erkin jadval (nazoratdan ozod) yoqish/o'chirish |
| `/kechikkanlar` | Muddati o'tgan missiyalar |
| `/eslat` | Hoziroq eslatma yuborish |
| `/holat` | Tizim holati — baza, guruh, ofis geofence, kim ishda |
| `/ofis` | Ofis joylashuvini o'rnatish (ofisda turib joylashuv yuboriladi) — geofence markazi |
| `/ofis_radius <metr>` | Ruxsat etilgan radiusni o'zgartirish (standart 250 m) |
| `/ofis_korish` | Hozirgi ofis joylashuvi va radiusni ko'rish |
| `/ofis_ochir` | Geofence tekshiruvini o'chirish |
| `/guruh_ulash` | *(guruh ichida)* shu guruhni ishchi guruh qilish |

> **📍 Joylashuv tekshiruvi:** «Ishga keldim» bosilganda bot `request_location`
> tugmasi orqali hodimning **haqiqiy joriy GPS**'ini so'raydi — qo'lda xaritadan
> tanlangan yoki forward qilingan joylashuv qabul qilinmaydi. Ofis `/ofis` bilan
> o'rnatilgan bo'lsa, radiusdan tashqaridan check-in **rad etiladi**.
>
> *Cheklov:* GPS'ni maxsus «fake GPS» ilovasi bilan aldash texnik jihatdan
> mumkin (root/dev telefon). Oddiy foydalanuvchi uchun bu himoya yetarli, lekin
> mutlaq kafolat emas — geofence real himoyaning asosi.

---

## 6.0. 📈 Davr hisoboti — istalgan sana oralig'i

Direktor uchun asosiy hisobot oynasi. `/davr` buyrug'i yoki asosiy
klaviaturadagi **«📈 Davr hisoboti»** tugmasi ochadi.

Uch qadam, hammasi tugmalar bilan:

1. **🗓 Davrni tanlash** — uchta yo'l:
   - tayyor tugmalar: *Bugun · Kecha · Shu hafta · O'tgan hafta · Shu oy ·
     O'tgan oy · 7 / 30 / 90 kun · Shu yil*;
   - **kalendar**: oyma-oy yurib, avval 🟢 boshlanish, keyin 🔴 tugash kunini
     bosasiz (kelajakdagi kunlar tanlanmaydi);
   - **qo'lda yozish**: `01.09.2026 - 07.09.2026`, `2026-09-01 2026-09-07`,
     `1-sentabr 7-sentabr` yoki `01.09.2026 dan 07.09.2026 gacha`.
2. **👥 Kimni ko'ramiz?** — «🏢 Butun jamoa» (hammasi bitta hisobotda) yoki
   ro'yxatdan bitta hodim.
3. **📊 Hisobotni ko'rish** yoki **📥 Excel yuklab olish**.

Tanlangan davr sessiyada saqlanadi — bir marta sana tanlab, hodimdan hodimga
o'tib chiqish mumkin.

### Ekranda nima ko'rinadi

**Butun jamoa:** umumiy raqamlar (bajarilgan/yozilgan ishlar, bajarish foizi,
ochiq va kechikkanlar, davomat, jami ish vaqti) + **oldingi shuncha kunlik davr
bilan solishtirish** (📈 +12% / 📉 −8%) + **🏆 reyting** + har bir hodim
kesimida qisqa qator.

**Bitta hodim:** xulosa (kelgan kunlar, jami va o'rtacha ish vaqti, o'rtacha
kelish vaqti, kech kelgan kunlar, bajargan/yozgan ishlari, bajarish foizi,
hozir ochiq va kechikkanlari) + **kun-kun jadval** (keldi / ketdi / soat /
bajarilgan soni; `!` — kech kelgan kun) + **bajargan ishlari ro'yxati sanasi
bilan** + **hozir zimmasida turgan ishlar**.

Uzun hisobot Telegram chegarasidan oshsa — avtomatik bo'laklarga bo'linib
yuboriladi, hech narsa kesilmaydi.

### 📥 Excel yuklab olish — ikki bosishda

Admin paneldagi **«📥 Excel yuklab olish (kun / hafta / oy)»**, arxivdagi
shu nomli tugma yoki `/jamoa_excel` buyrug'i sodda menyuni ochadi:

```
1-qadam · DAVR                          2-qadam · KIM
  📅 Bugun · 11.09                        🏢 Butun jamoa — bitta fayl
  📆 Shu hafta · 08.09–11.09 (4 kun)      👥 Har bir hodim alohida — N ta fayl
  📆 O'tgan hafta · 01.09–07.09 (7 kun)   👤 Akbar Karimov
  🗓 Shu oy · sentabr (11 kun)            👤 ...
  🗓 O'tgan oy · avgust (31 kun)
  🗓 Boshqa sana oralig'i (kalendar)
```

Oy — **kalendar oy**: 30 kunlik oyda 30 kun, 31 kunlik oyda 31 kun, fevralda
28/29 kun chiqadi (tugmaning o'zida kunlar soni yozilgan). Hafta dushanbadan
boshlanadi. Hodimlar o'zlari uchun `/excel` yozib xuddi shu davrlarni tanlaydi.

| Kim uchun | Varaqlar |
|---|---|
| **Bitta hodim** | **Xulosa** (barcha raqamlar bitta ustunda) · **Bajarilgan ishlar** (davrda nima ish qilgani — №, sana, kun, vaqt, ish, muddati edi, muddatida) · **Kunlar** (sana, kun, keldi, ketdi, ish soati raqam bilan, davomiylik, bajardi, **nima ish qildi**, yozdi, bot harakatlari, izoh + JAMI qator) · **Missiyalar** · **Harakatlar** |
| **Butun jamoa** | **Jamlanma** (har bir hodim bitta qator + JAMI) · **Kunlar** (hamma hodimning kun-kun davomati + **nima ish qildi**) · **Missiyalar** (hodimi bilan) · **Kechikkanlar** · **Bajarilganlar** (davrda bajarilgan barcha ishlar, sana va vaqti bilan) |
| **Bugun** (1 kun) | Bitta sodda jadval: hodim, lavozim, missiya, holat, muddat, bajarilgan vaqti |

Har bir varaqda sarlavha muzlatilgan, **filtr** yoqilgan, ish soatlari
**raqam** ko'rinishida (Excelda yig'indi/o'rtacha olish mumkin), holatlar
rangli: 🟩 Bajarildi · 🟥 Kechikkan · 🟧 Bajarilmadi.

---

## 6.1. 🗂 Hodimlar arxivi — direktor uchun «ilova»

`/arxiv` buyrug'i yoki asosiy klaviaturadagi **«🗂 Hodimlar arxivi»**
tugmasi bitta xabar ichida ochiladigan panelni beradi. Har bosishda o'sha
xabar yangilanadi — chat toza qoladi, ilovadek yuriladi.

```
🗂 HODIMLAR ARXIVI
   └─ 👤 Akbar Karimov
        ├─ 🗂 Kun daftari      ◀️ oldingi kun │ keyingi kun ▶️
        ├─ 📜 Harakatlar tarixi
        ├─ 🗓 Kun tanlash (oxirgi 14 kun)
        ├─ 📊 7 kunlik / 30 kunlik hisobot
        ├─ 🎯 Missiyalari
        └─ 📥 Excel (hafta / oy)  → davr tanlab, shu hodimning fayli
   └─ 🏢 Jamoa · 7 / 30 kun  → 📥 jamoa jamlanmasi
   └─ 📥 Excel yuklab olish (kun / hafta / oy)
```

### Kun daftari nimani ko'rsatadi

Bitta hodim, bitta kun — hammasi bir ekranda:

| Bo'lim | Nima ko'rinadi |
|---|---|
| ⏰ **Ish vaqti** | Qachon kelgan (kech bo'lsa ⚠️), ofisdan masofa, qachon ketgan, necha soat ishlagan |
| ✅ **Bajargan ishlari** | Har bir missiya — nomi va aniq bajarilgan vaqti |
| ⏳ **Bajarilmagani** | O'sha kuni zimmasida bo'lgan, lekin yopilmagan ishlar (kechikkani ⚠️ bilan) |
| 📝 **Shu kuni yozib qo'yganlari** | O'zi kiritgan yangi missiyalar va ularning muddati |
| 🗑 **O'chirganlari** | Bekor qilingan missiyalar |
| 💬 **Botga yozgan matnlari** | Hodim yozgan erkin matnlar — vaqti bilan |
| 📈 **Bot faolligi** | O'sha kuni nechta harakat qilgani va oxirgi faolligi |

### Harakatlar tarixi

Hodimning **botdagi har bir amali** yozib boriladi — tugma bosishi, buyruq,
yozgan matni, ishga kelishi, missiya bajarishi. Kun bo'yicha vaqt lentasi
ko'rinishida chiqadi:

```
09:12 🟢 Ishga keldi: 09:12   ofisdan 40 m
09:14 📋 Missiyalarini ko'rdi
11:07 ✅ Missiyani bajardi: Yuklarni ro'yxatga olish   yana 4 ta qoldi
14:30 💬 Matn yozdi: Ombor kaliti topilmadi
18:02 🏁 Ishdan ketdi: 18:02   5 ta bajarildi, 1 ta qoldi
```

### Davr hisoboti (7 / 30 kun)

Kun-kun jadval + xulosa: nechta kun kelgan, jami necha soat ishlagan,
o'rtacha kelish vaqti, necha kun kech qolgan, nechta missiya bajargan va
yozgan, bajarish foizi, bot faolligi.

### Excel arxivi

**📥 Excel (hafta / oy)** tugmasi davrni so'raydi (bugun / shu hafta /
o'tgan hafta / shu oy / o'tgan oy) va shu hodimning **5 varaqli** faylini beradi:

| Varaq | Ustunlar |
|---|---|
| **Xulosa** | Barcha ko'rsatkichlar bitta ustunda |
| **Bajarilgan ishlar** | №, sana, kun, vaqt, bajarilgan ish, muddati edi, muddatida (Ha/Kech) |
| **Kunlar** | Sana, keldi, ketdi, ish soati, davomiylik, bajardi, nima ish qildi, yozib qo'ydi, bot harakatlari, izoh |
| **Missiyalar** | Missiya, holat (Bajarildi / Kechikkan / Bajarilmadi / O'chirilgan), yozilgan kuni, boshlanish, muddat, bajarilgan vaqti |
| **Harakatlar** | Sana, vaqt, harakat, tafsilot — hodimning botdagi to'liq izi |

7 / 30 kunlik hisobot ostidagi **📥 Excel (N kun)** tugmasi esa oxirgi N
kunning (bugundan orqaga) faylini beradi.

Jamoa ko'rinishida esa **📥 Jamoa jamlanmasi** — har bir hodim bitta qator:
kelgan kunlar, jami ish vaqti, o'rtacha kelish, kech kelgan kunlar,
bajargan missiyalari, bot harakatlari.

---

## 7. Bot avtomatik nima qiladi

Standart sozlamada (9:00–18:00, har 2 soatda, dushanba–shanba):

| Vaqt | Amal |
|---|---|
| `00:05` | Muddati kelgan missiyalar faollashadi |
| `08:55` | Hali «Ishga keldim» qilmaganlarga: **«Ishga kelyapsizmi?»** — Ha/Yo'q tugmasi bilan shaxsiy xabar |
| `09:00` | Guruhga «Ishga keldim» chaqirig'i + kelmaganlarga shaxsiy xabar |
| `11:00, 13:00, 15:00, 17:00` | **«Bu missiyalarni bajardingizmi?»** — guruhga ro'yxat, hodimga tugmali ro'yxat |
| `18:00` | Kunlik hisobot guruhga + har kimga «ertangi rejani yoz» so'rovi |
| `18:45` | Ertangi kun uchun rejasi yo'q hodimlarga aniq eslatma + guruhga ogohlantirish |
| **Har dushanba 9:10** | **O'tgan haftaning to'liq jamoa hisoboti + Excel — faqat direktor(lar)ga** |
| **Har oyning 1-kuni 9:20** | **O'tgan oyning to'liq jamoa hisoboti + Excel — faqat direktor(lar)ga** |

---

## 8. Loyiha tuzilishi

```
src/
  index.js              bot ishga tushishi, handlerlar tartibi
  hodimlar.js           doimiy hodimlar ro'yxati — bot ishga tushganda yo'qlari avtomatik qo'shiladi
  config.js             .env o'qish
  db/                   baza qatlami (postgres | sqlite avtomatik tanlanadi)
  time.js               Toshkent vaqti, sana formatlari
  ui.js                 tugmalar va matn formatlari
  jobs.js               cron: eslatma, hisobot, rollover
  session.js            missiya yozish sehrgari uchun holat
  services/
    employees.js        hodimlar
    missions.js         missiyalar (yaratish, bajarish, o'tkazish)
    attendance.js       kelish–ketish
    activity.js         hodimning botdagi har bir harakati jurnali
    history.js          hodim faoliyati arxivi (kun daftari, 7/30 kunlik)
    period.js           davr hisoboti — istalgan sana oraligi (jamoa va hodim)
    excel.js            Excel hisobotlar (kunlik, davr: hodim va jamoa)
    office.js           ofis geofence sozlamasi
    notify.js           guruh / shaxsiy xabar yuborish
    reports.js          eslatma va hisobot matnlari
  handlers/
    common.js  attendance.js  missions.js  admin.js
    excelMenu.js        📥 Excel yuklab olish menyusi (davr → kim → fayl)
    hr.js (arxiv paneli)  period.js (davr hisoboti + kalendar)
scripts/
  seed.js               hodimlarni bazaga kiritish   (npm run seed)
  admin.js              rahbarni admin qilish        (npm run admin -- <id>)
  db-check.js           baza ulanishini tekshirish   (npm run db:check)
  smoke.js              oflayn tekshiruv testlari    (npm test)
data/
  bot.db                SQLite bazasi (avtomatik yaratiladi)
```

## 9. Baza: Supabase (PostgreSQL)

Bot ikkita bazani qo'llab-quvvatlaydi va o'zi tanlaydi:

| Holat | Ishlatiladigan baza |
|---|---|
| `SUPABASE_DB_PASSWORD` to'ldirilgan | **PostgreSQL / Supabase** — bulutda, doimiy |
| Parol bo'sh | **SQLite** — `data/bot.db` fayli, faqat shu kompyuterda |

### Supabase ni ulash — faqat 1 ta qator

1. **Parolni oling:** Supabase → **Project Settings → Database → Database password**
   → `Reset database password` → chiqqan parolni nusxalang.
   *(Parol boshqa hech qayerda ko'rsatilmaydi — faqat shu yerda beriladi.)*
2. `.env` dagi shu qatorga qo'ying:

```
SUPABASE_DB_PASSWORD=sizning_parolingiz
```

To'liq ulanish satrini yozish shart emas — bot uni `SUPABASE_PROJECT_REF` dan
o'zi yasaydi va paroldagi maxsus belgilarni (`@ # : /`) to'g'ri kodlaydi.

3. Tekshiring — bu buyruq jadvallarni yaratadi va hamma so'rovni sinaydi
   (hech narsa o'chirmaydi):

```bash
npm run db:check
```

4. Hodimlarni bulutdagi bazaga ko'chiring:

```bash
npm run seed
```

> **Ulanmasa** (`ENETUNREACH`, `timeout`): Supabase'ning to'g'ridan-to'g'ri
> manzili faqat IPv6 orqali ishlaydi. Supabase → Project Settings → Database →
> Connection string → **Session pooler** ni tanlang va undagi host nomini
> `.env` dagi `SUPABASE_POOLER_HOST` ga yozing
> (masalan `aws-0-eu-central-1.pooler.supabase.com`).

> **"Connect to your project" oynasidagi 5 ta tab** (Framework / Server / Direct /
> ORM / MCP) — bularning hammasi bazaga **ulanish usullari**, hosting emas.
> Bizga faqat **Direct** kerak, u ham endi avtomatik yasaladi.

> `sb_publishable_...` kaliti — bu Supabase'ning **brauzer uchun** public kaliti.
> Botga kerak emas: bot bazaga to'g'ridan-to'g'ri PostgreSQL orqali ulanadi,
> `@supabase/supabase-js` ham o'rnatilmaydi.

---

## 10. 24/7 ishlashi uchun (hosting)

⚠️ **Supabase — bu faqat baza. Botning o'zi emas.** `node src/index.js` jarayoni
doim ishlab turishi kerak: kompyuter o'chsa yoki terminal yopilsa, eslatmalar to'xtaydi.

Bot **long polling** ishlatadi (kiruvchi port kerak emas), shuning uchun oddiy
konteyner yoki VPS yetarli. Vercel kabi serverless platformalar bunga mos emas.

### Variant A — Railway (eng oson)

Loyihada tayyor `Dockerfile`, `railway.json` va `Procfile` bor.

1. Kodni GitHub'ga yuklang (`.env` yuklanmaydi — u `.gitignore` da).
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
3. **Variables** bo'limiga `.env` dagi qiymatlarni ko'chiring:
   `BOT_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `ADMIN_IDS`,
   `COMPANY_NAME`, `TIMEZONE`, `WORK_START_HOUR`, `WORK_END_HOUR`,
   `REMINDER_INTERVAL_HOURS`, `WORK_DAYS`.
4. Deploy. Bot 24/7 ishlaydi, ma'lumot Supabase'da saqlanadi.

> Render'da xizmat turini **Background Worker** qilib tanlang (Web Service emas —
> u ishlamay turganda uxlab qoladi va eslatmalar to'xtaydi).

### Variant B — VPS (o'z serveringiz)

```bash
npm ci --omit=dev
npm i -g pm2
pm2 start src/index.js --name missiya-bot
pm2 save
pm2 startup
```

### Variant C — Docker (istalgan joyda)

```bash
docker build -t missiya-bot .
docker run -d --restart=always --env-file .env --name missiya-bot missiya-bot
```

> Bir vaqtning o'zida **faqat bitta nusxa** ishlashi kerak. Ikkita joyda
> ishga tushirilsa Telegram `409 Conflict` xatosini beradi va xabarlar ikki marta ketadi.

---

## 11. Buyruqlar (terminal)

```bash
npm start        # botni ishga tushirish
npm run seed     # hodimlarni bazaga kiritish
npm run admin -- <tg_id> "Ism"   # rahbarni admin qilish
npm run db:check # baza ulanishini tekshirish
npm test         # oflayn testlar (bazaga tegmaydi)
```
