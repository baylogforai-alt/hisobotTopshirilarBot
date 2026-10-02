'use strict';

const db = require('../db');
const time = require('../time');

/**
 * TASHRIFLAR — hudud agenti borishi kerak bo'lgan joyga yetib borganda:
 * lokatsiya → video / dumaloq video / audio / ovozli xabar → izoh (ixtiyoriy).
 */

const SELECT = `SELECT v.*, e.full_name, e.tg_id, e.department_id FROM visits v JOIN employees e ON e.id = v.employee_id`;

const byId = (id) => db.one(`${SELECT} WHERE v.id = $1`, [Number(id)]);

const create = async ({ employeeId, lat, lon, homeDist = null, proof = null, note = null }) => {
  const rows = await db.query(
    `INSERT INTO visits (employee_id, visit_date, created_at, lat, lon, home_dist, proof_type, proof_file_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      Number(employeeId), time.today(), time.stamp(), lat != null ? String(lat) : null, lon != null ? String(lon) : null,
      homeDist != null ? String(Math.round(homeDist)) : null, proof ? proof.type : null, proof ? proof.fileId : null,
      note ? String(note).slice(0, 500) : null,
    ],
  );
  return byId(rows[0].id);
};

const forEmployee = (employeeId, from, to) =>
  db.query(`${SELECT} WHERE v.employee_id = $1 AND v.visit_date BETWEEN $2 AND $3 ORDER BY v.created_at`, [Number(employeeId), from, to]);

const range = (from, to) => db.query(`${SELECT} WHERE v.visit_date BETWEEN $1 AND $2 ORDER BY v.created_at`, [from, to]);

const countFor = (employeeId, from, to) =>
  db.count('SELECT COUNT(*) AS c FROM visits WHERE employee_id = $1 AND visit_date BETWEEN $2 AND $3', [Number(employeeId), from, to]);

const PROOF_LABEL = { video: '🎥 video', video_note: '⏺ dumaloq video', audio: '🎧 audio', voice: '🎙 ovozli xabar', photo: '🖼 rasm', document: '📎 fayl' };
const proofLabel = (type) => PROOF_LABEL[type] || '—';

module.exports = { byId, create, forEmployee, range, countFor, proofLabel };
