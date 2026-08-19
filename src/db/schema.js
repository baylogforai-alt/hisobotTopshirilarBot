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
`;

module.exports = { POSTGRES, SQLITE };
