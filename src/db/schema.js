'use strict';

/**
 * Bir xil mantiq, ikki dialekt (PostgreSQL / SQLite).
 * Umumiy qoidalar:
 *  - vaqtlar TEXT (ISO satr), sanalar TEXT ('yyyy-MM-dd'), oy TEXT ('yyyy-MM')
 *  - boolean maydonlar INTEGER 0/1
 *  - placeholderlar $1, $2 ... (SQLite qatlami ? ga o'giradi)
 *
 * Jadvallar:
 *  departments    — bo'limlar + KPI vaznlari (topshiriq/davomat/boshliq bahosi/qo'shimcha mezon)
 *  employees      — hodimlar: rol (admin/head/employee), bo'lim, bonus fondi, erkin jadval, alohida ish boshlanishi (work_start 'HH:mm')
 *  tasks          — topshiriqlar (missiyalar): kim berdi, kimga, muddat, holat, isbot (rasm/video), tekshiruv
 *  attendance     — kunlik davomat: kelish/ketish, GPS, kechikish, sababli kun (excuse), "kelyapsizmi?" javobi (intent)
 *  daily_reports  — hodimning KUNLIK HISOBOTI: kun oxirida nima qilganini yozadi (+rasm), boshliq ko'radi
 *  activity_log   — hodimning botdagi HAR BIR harakati (arxiv, kun daftari, harakatlar tarixi uchun)
 *  kpi_monthly    — oylik KPI: hisoblangan foizlar, boshliq bahosi, qo'shimcha mezon, bonus, holat
 *  join_requests  — ro'yxatda yo'q odam /start bosganda direktorga yuborilgan so'rov
 *  sessions       — sehrgar (wizard) holati — restartdan keyin ham saqlanadi
 *  settings       — kalit/qiymat (guruh ID, ofis GPS)
 *  reminder_log   — cron ishlari jurnali
 *  branches       — filiallar (Toshkent, Andijon …) — har birining o'z ofis nuqtasi va radiusi
 *  month_starts   — hodim yangi ish oyini tasdiqlagan payt (oy hisobi shundan boshlanadi)
 *  visits         — hudud agentlarining tashriflari (lokatsiya + video/audio + izoh)
 *  directions     — yo'nalishlar (Moliya, Logistika …) va employee_directions — kim mas'ul (HR topshiriq beradi)
 *  announcements  — direktor/HR/rahbar e'lonlari (hammaga yoki tanlanganlarga; matn yoki media)
 *  announcement_recipients — e'lon kimga bordi va kim «👁 O'qidim» bosdi
 *  extra_days     — dam olish kuniga chaqiruv (summa; o'sha kuni Keldim → worked_at)
 *  kpi_extras     — qo'shimcha KPI qatorlari (summa × asos foizi; bir martalik yoki har oy) — CRM'dan kiritiladi
 *  task_replies   — qaytarilgan topshiriq bo'yicha hodim ↔ tekshiruvchi yozishmasi (matn yoki media)
 *  chats          — «💬 Savol-javob»: chat (boshlovchi, kimlar bilan, rejim) + chat_members + chat_messages
 */

const tables = (pk, big) => `
CREATE TABLE IF NOT EXISTS departments (
  id            ${pk},
  name          TEXT    NOT NULL UNIQUE,
  w_tasks       INTEGER NOT NULL DEFAULT 40,
  w_attendance  INTEGER NOT NULL DEFAULT 20,
  w_head        INTEGER NOT NULL DEFAULT 20,
  w_custom      INTEGER NOT NULL DEFAULT 20,
  custom_name   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL,
  remind_times  TEXT
);

CREATE TABLE IF NOT EXISTS branches (
  id            ${pk},
  name          TEXT    NOT NULL UNIQUE,
  office_lat    TEXT,
  office_lon    TEXT,
  radius_m      INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id             ${pk},
  tg_id          ${big}  NOT NULL UNIQUE,
  full_name      TEXT    NOT NULL,
  position       TEXT,
  username       TEXT,
  role           TEXT    NOT NULL DEFAULT 'employee',
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  bonus_fund     INTEGER,
  work_start     TEXT,
  work_end       TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  flexible       INTEGER NOT NULL DEFAULT 0,
  branch_id      INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  work_mode      TEXT    NOT NULL DEFAULT 'office',
  home_lat       TEXT,
  home_lon       TEXT,
  video_required INTEGER NOT NULL DEFAULT 0,
  salary         INTEGER,
  is_hr          INTEGER NOT NULL DEFAULT 0,
  remind_times   TEXT,
  remind_pending TEXT,
  can_view_att   INTEGER NOT NULL DEFAULT 0,
  notify_done    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            ${pk},
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active',
  priority      TEXT    NOT NULL DEFAULT 'normal',
  source        TEXT    NOT NULL DEFAULT 'self',
  created_by    ${big},
  created_at    TEXT    NOT NULL,
  start_date    TEXT    NOT NULL,
  due_date      TEXT    NOT NULL,
  done_at       TEXT,
  proof_type    TEXT,
  proof_file_id TEXT,
  proof_note    TEXT,
  reviewed_by   ${big},
  reviewed_at   TEXT,
  review_note   TEXT,
  returned_count INTEGER NOT NULL DEFAULT 0,
  cancelled_at  TEXT,
  cancelled_by  ${big},
  task_media_type TEXT,
  task_file_id  TEXT,
  task_file_name TEXT,
  ack_at        TEXT,
  ack_note      TEXT,
  start_time    TEXT,
  start_notified_at TEXT,
  late_forced   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_emp_status ON tasks(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);

CREATE TABLE IF NOT EXISTS attendance (
  id             ${pk},
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date      TEXT    NOT NULL,
  checked_in     TEXT,
  checked_out    TEXT,
  intent         TEXT,
  intent_at      TEXT,
  checkin_lat    TEXT,
  checkin_lon    TEXT,
  checkin_dist   TEXT,
  late_minutes   INTEGER,
  late_reason    TEXT,
  excuse_status  TEXT,
  excuse_reason  TEXT,
  excuse_by      ${big},
  excuse_at      TEXT,
  checkin_mode   TEXT,
  checkin_proof_type    TEXT,
  checkin_proof_file_id TEXT,
  checkin_note   TEXT,
  late_notice_at TEXT,
  late_proof_type       TEXT,
  late_proof_file_id    TEXT,
  excuse_proof_type     TEXT,
  excuse_proof_file_id  TEXT,
  checkout_lat   TEXT,
  checkout_lon   TEXT,
  checkout_dist  TEXT,
  checkout_note  TEXT,
  late_excused_at TEXT,
  late_excused_by ${big},
  UNIQUE (employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(work_date);

CREATE TABLE IF NOT EXISTS daily_reports (
  id             ${pk},
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date      TEXT    NOT NULL,
  text           TEXT    NOT NULL,
  photo_file_id  TEXT,
  submitted_at   TEXT    NOT NULL,
  reviewed_by    ${big},
  reviewed_at    TEXT,
  review_note    TEXT,
  UNIQUE (employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(work_date);

CREATE TABLE IF NOT EXISTS activity_log (
  id           ${pk},
  employee_id  INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  tg_id        ${big},
  work_date    TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  title        TEXT,
  detail       TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_emp_date ON activity_log(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_log(work_date);

CREATE TABLE IF NOT EXISTS kpi_monthly (
  id            ${pk},
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month         TEXT    NOT NULL,
  tasks_total   INTEGER NOT NULL DEFAULT 0,
  tasks_ontime  INTEGER NOT NULL DEFAULT 0,
  tasks_pct     INTEGER NOT NULL DEFAULT 0,
  tasks_returned INTEGER NOT NULL DEFAULT 0,
  work_days     INTEGER NOT NULL DEFAULT 0,
  ontime_days   INTEGER NOT NULL DEFAULT 0,
  late_days     INTEGER NOT NULL DEFAULT 0,
  absent_days   INTEGER NOT NULL DEFAULT 0,
  excused_days  INTEGER NOT NULL DEFAULT 0,
  att_pct       INTEGER NOT NULL DEFAULT 0,
  head_score    INTEGER,
  head_note     TEXT,
  custom_pct    INTEGER,
  w_tasks       INTEGER NOT NULL DEFAULT 40,
  w_attendance  INTEGER NOT NULL DEFAULT 20,
  w_head        INTEGER NOT NULL DEFAULT 20,
  w_custom      INTEGER NOT NULL DEFAULT 20,
  total         INTEGER NOT NULL DEFAULT 0,
  bonus_fund    INTEGER,
  bonus_amount  INTEGER,
  status        TEXT    NOT NULL DEFAULT 'draft',
  note          TEXT,
  decided_by    ${big},
  decided_at    TEXT,
  updated_at    TEXT    NOT NULL,
  kpi_eligible  INTEGER,
  kpi_fail      TEXT,
  tasks_missed  INTEGER NOT NULL DEFAULT 0,
  salary        INTEGER,
  fund_manual   INTEGER NOT NULL DEFAULT 0,
  extra_days    INTEGER NOT NULL DEFAULT 0,
  required_days INTEGER,
  tasks_gate_pct INTEGER,
  UNIQUE (employee_id, month)
);

CREATE TABLE IF NOT EXISTS month_starts (
  id            ${pk},
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month         TEXT    NOT NULL,
  confirmed_at  TEXT    NOT NULL,
  UNIQUE (employee_id, month)
);

CREATE TABLE IF NOT EXISTS visits (
  id            ${pk},
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  visit_date    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  lat           TEXT,
  lon           TEXT,
  home_dist     TEXT,
  proof_type    TEXT,
  proof_file_id TEXT,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_visits_emp_date ON visits(employee_id, visit_date);

CREATE TABLE IF NOT EXISTS directions (
  id          ${pk},
  name        TEXT    NOT NULL UNIQUE,
  icon        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS employee_directions (
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  direction_id  INTEGER NOT NULL REFERENCES directions(id) ON DELETE CASCADE,
  UNIQUE (employee_id, direction_id)
);

INSERT INTO directions (name, icon, active, created_at) VALUES ('Moliya', '💰', 1, '2026-10-02') ON CONFLICT (name) DO NOTHING;
INSERT INTO directions (name, icon, active, created_at) VALUES ('Logistika', '🚚', 1, '2026-10-02') ON CONFLICT (name) DO NOTHING;
INSERT INTO directions (name, icon, active, created_at) VALUES ('Ombor', '📦', 1, '2026-10-02') ON CONFLICT (name) DO NOTHING;
INSERT INTO directions (name, icon, active, created_at) VALUES ('Sotuv', '🛒', 1, '2026-10-02') ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS announcements (
  id            ${pk},
  created_by    ${big}  NOT NULL,
  sender_name   TEXT,
  target        TEXT    NOT NULL DEFAULT 'all',
  text          TEXT,
  media_type    TEXT,
  file_id       TEXT,
  file_name     TEXT,
  recipients    INTEGER NOT NULL DEFAULT 0,
  delivered     INTEGER NOT NULL DEFAULT 0,
  to_group      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS announcement_recipients (
  id               ${pk},
  announcement_id  INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  delivered        INTEGER NOT NULL DEFAULT 0,
  read_at          TEXT,
  UNIQUE (announcement_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_ann_rcp_emp ON announcement_recipients(employee_id);

CREATE TABLE IF NOT EXISTS join_requests (
  id          ${pk},
  tg_id       ${big}  NOT NULL,
  full_name   TEXT    NOT NULL,
  username    TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  decided_at  TEXT,
  decided_by  ${big}
);

CREATE INDEX IF NOT EXISTS idx_join_tg_status ON join_requests(tg_id, status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS reminder_log (
  id     ${pk},
  kind   TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS extra_days (
  id           ${pk},
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  work_date    TEXT    NOT NULL,
  amount       INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  created_by   ${big},
  created_at   TEXT    NOT NULL,
  worked_at    TEXT,
  cancelled_at TEXT,
  cancelled_by ${big}
);
CREATE INDEX IF NOT EXISTS idx_extra_days_emp_date ON extra_days(employee_id, work_date);

CREATE TABLE IF NOT EXISTS kpi_extras (
  id           ${pk},
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  basis        TEXT    NOT NULL DEFAULT 'total',
  amount       INTEGER NOT NULL DEFAULT 0,
  pct          INTEGER,
  month        TEXT,
  start_month  TEXT    NOT NULL,
  end_month    TEXT,
  created_by   TEXT,
  created_at   TEXT    NOT NULL,
  removed_at   TEXT,
  removed_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_kpi_extras_emp ON kpi_extras(employee_id);

CREATE TABLE IF NOT EXISTS task_replies (
  id          ${pk},
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  from_tg     ${big}  NOT NULL,
  from_name   TEXT,
  to_tg       ${big},
  body        TEXT,
  media_type  TEXT,
  file_id     TEXT,
  file_name   TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id           ${pk},
  starter_tg   ${big}  NOT NULL,
  starter_name TEXT,
  title        TEXT,
  target       TEXT,
  mode         TEXT    NOT NULL DEFAULT 'all',
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  id          ${pk},
  chat_id     INTEGER NOT NULL REFERENCES chats(id),
  tg_id       ${big}  NOT NULL,
  employee_id INTEGER REFERENCES employees(id),
  name        TEXT,
  delivered   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chat_id, tg_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          ${pk},
  chat_id     INTEGER NOT NULL REFERENCES chats(id),
  from_tg     ${big}  NOT NULL,
  from_name   TEXT,
  to_tg       ${big},
  body        TEXT,
  media_type  TEXT,
  file_id     TEXT,
  file_name   TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const POSTGRES = tables('SERIAL PRIMARY KEY', 'BIGINT');
const SQLITE = tables('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER');

/**
 * Eski (v1) bazada `employees`/`attendance` jadvallari bor bo'lishi mumkin —
 * yetishmagan ustunlar qo'shiladi. "ustun allaqachon bor" xatosi e'tiborsiz qoldiriladi.
 */
const col = (table, name, type, bigType = null) => ({
  postgres: `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${bigType || type}`,
  sqlite: `ALTER TABLE ${table} ADD COLUMN ${name} ${type}`,
});

const MIGRATIONS = [
  col('employees', 'department_id', 'INTEGER'),
  col('employees', 'bonus_fund', 'INTEGER'),
  col('employees', 'work_start', 'TEXT'),
  col('employees', 'work_end', 'TEXT'),
  col('employees', 'flexible', 'INTEGER NOT NULL DEFAULT 0'),
  col('kpi_monthly', 'tasks_returned', 'INTEGER NOT NULL DEFAULT 0'),
  col('kpi_monthly', 'fund_manual', 'INTEGER NOT NULL DEFAULT 0'),
  col('attendance', 'intent', 'TEXT'),
  col('attendance', 'intent_at', 'TEXT'),
  col('attendance', 'checkin_lat', 'TEXT'),
  col('attendance', 'checkin_lon', 'TEXT'),
  col('attendance', 'checkin_dist', 'TEXT'),
  col('attendance', 'late_minutes', 'INTEGER'),
  col('attendance', 'late_reason', 'TEXT'),
  col('attendance', 'excuse_status', 'TEXT'),
  col('attendance', 'excuse_reason', 'TEXT'),
  col('attendance', 'excuse_by', 'INTEGER', 'BIGINT'),
  col('attendance', 'excuse_at', 'TEXT'),
  // 30-sen-2026: filial, ofis/hudud rejimi, video isbot, oklad, KPI sharti
  col('employees', 'branch_id', 'INTEGER'),
  col('employees', 'work_mode', "TEXT NOT NULL DEFAULT 'office'"),
  col('employees', 'home_lat', 'TEXT'),
  col('employees', 'home_lon', 'TEXT'),
  col('employees', 'video_required', 'INTEGER NOT NULL DEFAULT 0'),
  col('employees', 'salary', 'INTEGER'),
  col('attendance', 'checkin_mode', 'TEXT'),
  col('attendance', 'checkin_proof_type', 'TEXT'),
  col('attendance', 'checkin_proof_file_id', 'TEXT'),
  col('attendance', 'checkin_note', 'TEXT'),
  col('kpi_monthly', 'kpi_eligible', 'INTEGER'),
  col('kpi_monthly', 'kpi_fail', 'TEXT'),
  col('kpi_monthly', 'salary', 'INTEGER'),
  col('kpi_monthly', 'tasks_missed', 'INTEGER NOT NULL DEFAULT 0'),
  // 30-sen-2026 (2): HR belgisi
  col('employees', 'is_hr', 'INTEGER NOT NULL DEFAULT 0'),
  col('attendance', 'late_notice_at', 'TEXT'),
  col('employees', 'remind_times', 'TEXT'),
  col('employees', 'remind_pending', 'TEXT'),
  col('employees', 'can_view_att', 'INTEGER NOT NULL DEFAULT 0'),
  col('tasks', 'cancelled_by', 'INTEGER', 'BIGINT'),
  col('attendance', 'late_proof_type', 'TEXT'),
  col('attendance', 'late_proof_file_id', 'TEXT'),
  col('attendance', 'excuse_proof_type', 'TEXT'),
  col('attendance', 'excuse_proof_file_id', 'TEXT'),
  col('tasks', 'task_media_type', 'TEXT'),
  col('tasks', 'task_file_id', 'TEXT'),
  col('tasks', 'task_file_name', 'TEXT'),
  col('tasks', 'ack_at', 'TEXT'),
  col('tasks', 'ack_note', 'TEXT'),
  col('departments', 'remind_times', 'TEXT'),
  // 2-okt-2026 (2): HR «Bajardim» xabarlari (o'zi yoqadi), e'lonlar
  col('employees', 'notify_done', 'INTEGER NOT NULL DEFAULT 0'),
  // 3-okt-2026: topshiriq boshlanish soati, «Ketdim» lokatsiya + izoh
  col('tasks', 'start_time', 'TEXT'),
  col('tasks', 'start_notified_at', 'TEXT'),
  col('attendance', 'checkout_lat', 'TEXT'),
  col('attendance', 'checkout_lon', 'TEXT'),
  col('attendance', 'checkout_dist', 'TEXT'),
  col('attendance', 'checkout_note', 'TEXT'),
  // 3-okt-2026 (audit): KPI sharti — 25 kun / 90% topshiriq, kechikishni sababli qilish, qaytarishda kechikish
  col('tasks', 'late_forced', 'INTEGER NOT NULL DEFAULT 0'),
  col('attendance', 'late_excused_at', 'TEXT'),
  col('attendance', 'late_excused_by', 'INTEGER', 'BIGINT'),
  col('kpi_monthly', 'fund_manual', 'INTEGER NOT NULL DEFAULT 0'),
  col('kpi_monthly', 'extra_days', 'INTEGER NOT NULL DEFAULT 0'),
  col('kpi_monthly', 'required_days', 'INTEGER'),
  col('kpi_monthly', 'tasks_gate_pct', 'INTEGER'),
];

/**
 * v1 «missiya bot» dagi `missions` jadvalini `tasks` ga ko'chirish.
 * Faqat `missions` bor va `tasks` bo'sh bo'lganda BIR MARTA bajariladi,
 * keyin eski jadval `missions_v1` nomiga o'zgartiriladi (o'chirilmaydi).
 *   pending/active → active · done → accepted (v1 da tekshiruv yo'q edi) · cancelled → cancelled
 *   created_by hodimning o'zi bo'lmasa → source='admin'
 */
const LEGACY_COPY = `
INSERT INTO tasks (employee_id, title, status, priority, source, created_by, created_at, start_date, due_date, done_at, reviewed_at, cancelled_at, proof_note)
SELECT m.employee_id, m.title,
       CASE m.status WHEN 'done' THEN 'accepted' WHEN 'cancelled' THEN 'cancelled' ELSE 'active' END,
       'normal',
       CASE WHEN m.created_by IS NOT NULL AND m.created_by <> e.tg_id THEN 'admin' ELSE 'self' END,
       m.created_by, m.created_at, m.start_date, m.due_date, m.done_at,
       CASE WHEN m.status = 'done' THEN m.done_at ELSE NULL END,
       m.cancelled_at, m.note
  FROM missions m JOIN employees e ON e.id = m.employee_id
 ORDER BY m.id`;

const LEGACY_RENAME = 'ALTER TABLE missions RENAME TO missions_v1';

/** Migratsiyadan KEYIN yaratiladigan indekslar (ustun eski bazada bo'lmasligi mumkin) */
const POST_MIGRATION = ['CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id)'];

module.exports = { POSTGRES, SQLITE, MIGRATIONS, POST_MIGRATION, LEGACY_COPY, LEGACY_RENAME };
