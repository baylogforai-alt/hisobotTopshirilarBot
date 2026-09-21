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
  active         INTEGER NOT NULL DEFAULT 1,
  flexible       INTEGER NOT NULL DEFAULT 0,
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
  cancelled_at  TEXT
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
  UNIQUE (employee_id, month)
);

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
  col('employees', 'flexible', 'INTEGER NOT NULL DEFAULT 0'),
  col('kpi_monthly', 'tasks_returned', 'INTEGER NOT NULL DEFAULT 0'),
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
