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
| 🌅 Ertalab | **«✅ Ishga keldim»** — yozib qo'yilgan missiyalar faollashadi va guruhga e'lon qilinadi |
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
| `/kechikkanlar` | Muddati o'tgan missiyalar |
| `/eslat` | Hoziroq eslatma yuborish |
| `/holat` | Tizim holati — qaysi baza, guruh ulanganmi, kim ishda |
| `/guruh_ulash` | *(guruh ichida)* shu guruhni ishchi guruh qilish |

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

---

## 8. Loyiha tuzilishi

```
src/
  index.js              bot ishga tushishi, handlerlar tartibi
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
    notify.js           guruh / shaxsiy xabar yuborish
    reports.js          eslatma va hisobot matnlari
  handlers/
    common.js  attendance.js  missions.js  admin.js
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
