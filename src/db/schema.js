'use strict';

/**
 * Bir xil mantiq, ikki dialekt.
 * Umumiy qoidalar (ikkala bazada ham bir xil ishlashi uchun):
 *  - vaqtlar TEXT (ISO satr) sifatida saqlanadi
 *  - active/boolean maydonlar INTEGER 0/1
 *  - placeholderlar $1, $2 ... ko'rinishida yoziladi
 */

const POSTGRES = `
CREATE TABLE IF NOT EXISTS employees (
  id          SERIAL PRIMARY KEY,
  tg_id       BIGINT      NOT NULL UNIQUE,
  full_name   TEXT        NOT NULL,
  position    TEXT,
  username    TEXT,
  role        TEXT        NOT NULL DEFAULT 'employee',
  active      INTEGER     NOT NULL DEFAULT 1,
  flexible    INTEGER     NOT NULL DEFAULT 0,
  work_end    INTEGER,
  created_at  TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS missions (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  start_date   TEXT    NOT NULL,
  due_date     TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  created_by   BIGINT,
  done_at      TEXT,
  cancelled_at TEXT,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_missions_emp_status ON missions(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);

CREATE TABLE IF NOT EXISTS attendance (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date    TEXT    NOT NULL,
  checked_in   TEXT,
  checked_out  TEXT,
  intent       TEXT,
  intent_at    TEXT,
  checkin_lat  TEXT,
  checkin_lon  TEXT,
  checkin_dist TEXT,
  UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS reminder_log (
  id     SERIAL PRIMARY KEY,
  kind   TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  tg_id        BIGINT,
  work_date    TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  title        TEXT,
  detail       TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_emp_date ON activity_log(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_log(work_date);
`;

const SQLITE = `
CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL UNIQUE,
  full_name   TEXT    NOT NULL,
  position    TEXT,
  username    TEXT,
  role        TEXT    NOT NULL DEFAULT 'employee',
  active      INTEGER NOT NULL DEFAULT 1,
  flexible    INTEGER NOT NULL DEFAULT 0,
  work_end    INTEGER,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS missions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  start_date   TEXT    NOT NULL,
  due_date     TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  created_by   INTEGER,
  done_at      TEXT,
  cancelled_at TEXT,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_missions_emp_status ON missions(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);

CREATE TABLE IF NOT EXISTS attendance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date    TEXT    NOT NULL,
  checked_in   TEXT,
  checked_out  TEXT,
  intent       TEXT,
  intent_at    TEXT,
  checkin_lat  TEXT,
  checkin_lon  TEXT,
  checkin_dist TEXT,
  UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS reminder_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind   TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  tg_id        INTEGER,
  work_date    TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  title        TEXT,
  detail       TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_emp_date ON activity_log(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_log(work_date);
`;

/**
 * Eski (allaqachon yaratilgan) bazalarga qo'shimcha ustun qo'shish uchun.
 * Har ikkala dialektda ham xato "ustun allaqachon bor" bo'lsa e'tiborsiz qoldiriladi
 * (bu funksiyani chaqiruvchi joyda amalga oshiriladi — bu yerda faqat SQL matni).
 */
const MIGRATIONS = [
  { postgres: 'ALTER TABLE attendance ADD COLUMN IF NOT EXISTS intent TEXT', sqlite: 'ALTER TABLE attendance ADD COLUMN intent TEXT' },
  { postgres: 'ALTER TABLE attendance ADD COLUMN IF NOT EXISTS intent_at TEXT', sqlite: 'ALTER TABLE attendance ADD COLUMN intent_at TEXT' },
  { postgres: 'ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkin_lat TEXT', sqlite: 'ALTER TABLE attendance ADD COLUMN checkin_lat TEXT' },
  { postgres: 'ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkin_lon TEXT', sqlite: 'ALTER TABLE attendance ADD COLUMN checkin_lon TEXT' },
  { postgres: 'ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkin_dist TEXT', sqlite: 'ALTER TABLE attendance ADD COLUMN checkin_dist TEXT' },
  { postgres: 'ALTER TABLE employees ADD COLUMN IF NOT EXISTS flexible INTEGER NOT NULL DEFAULT 0', sqlite: 'ALTER TABLE employees ADD COLUMN flexible INTEGER NOT NULL DEFAULT 0' },
  { postgres: 'ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_end INTEGER', sqlite: 'ALTER TABLE employees ADD COLUMN work_end INTEGER' },
];

module.exports = { POSTGRES, SQLITE, MIGRATIONS };
