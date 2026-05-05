const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, flightId } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function generateUsername(lastName) {
  const namePart = String(lastName || '').toLowerCase().replace(/[^a-z]/g, '') || 'user';
  const digits = String(Math.floor(10 + Math.random() * 90));
  return namePart + digits;
}

function generatePassword() {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const all = upper + lower + digits;
  let pw = upper[Math.floor(Math.random() * upper.length)]
         + lower[Math.floor(Math.random() * lower.length)]
         + digits[Math.floor(Math.random() * digits.length)];
  for (let i = 0; i < 3; i++) pw += all[Math.floor(Math.random() * all.length)];
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

function row2staff(s, mustChangePwd = false) {
  const code = s.airline_code ? s.airline_code.trim() : null;
  return {
    id: s.staff_id,
    username: s.username,
    firstName: s.firstname,
    lastName: s.lastname,
    email: s.email,
    phone: s.phone,
    airlineCode: code,
    staffType: s.role,
    flightId: s.flight_number ? flightId(code, s.flight_number) : null,
    requiresPasswordChange: !!mustChangePwd,
  };
}

router.get('/', authenticate, authorize('administrator'), async (req, res) => {
  const { staffType } = req.query;
  try {
    const sql = `
      SELECT s.*, l.must_change_pwd
      FROM staff s
      LEFT JOIN login l ON l.username = s.username
      ${staffType ? 'WHERE s.role = $1' : ''}
      ORDER BY s.staff_id DESC
    `;
    const { rows } = await pool.query(sql, staffType ? [staffType] : []);
    res.json(rows.map(r => row2staff(r, r.must_change_pwd)));
  } catch (err) {
    console.error('staff GET error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/', authenticate, authorize('administrator'), async (req, res) => {
  const { firstName, lastName, email, phone, staffType, airlineCode } = req.body;
  if (!firstName || !lastName || !staffType || !email) {
    return res.status(400).json({ error: 'firstName, lastName, email, and staffType are required' });
  }

  let code = airlineCode ? String(airlineCode).trim().toUpperCase() : null;

  // Ground staff aren't conceptually tied to an airline, but Supabase's
  // staff.airline_code is NOT NULL — fall back to the first available airline
  // so the admin form can omit it for ground_staff.
  if (!code && staffType === 'ground_staff') {
    const { rows } = await pool.query('SELECT airline_code FROM airline ORDER BY airline_code LIMIT 1');
    if (rows.length === 0) return res.status(500).json({ error: 'No airlines exist; cannot create staff' });
    code = rows[0].airline_code.trim();
  }
  if (!code) {
    return res.status(400).json({ error: 'airlineCode is required for this staff type' });
  }

  try {
    const airline = await pool.query('SELECT 1 FROM airline WHERE airline_code = $1', [code]);
    if (airline.rowCount === 0) return res.status(400).json({ error: `Unknown airline code: ${code}` });

    let username = generateUsername(lastName);
    for (let i = 0; i < 10; i++) {
      const taken = await pool.query('SELECT 1 FROM login WHERE username = $1', [username]);
      if (taken.rowCount === 0) break;
      username = generateUsername(lastName);
    }

    const plainPassword = generatePassword();

    await pool.query(
      `INSERT INTO login (username, password_hash, must_change_pwd) VALUES ($1, $2, true)`,
      [username, bcrypt.hashSync(plainPassword, 10)]
    );

    const { rows: inserted } = await pool.query(
      `INSERT INTO staff (airline_code, username, firstname, lastname, email, phone, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [code, username, firstName, lastName, email, phone || null, staffType]
    );

    res.status(201).json({
      ...row2staff(inserted[0], true),
      generatedCredentials: { username, password: plainPassword },
    });
  } catch (err) {
    console.error('staff POST error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/:id', authenticate, authorize('administrator'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid staff id' });
  try {
    const { rows } = await pool.query('SELECT username FROM staff WHERE staff_id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    const username = rows[0].username;

    await pool.query('DELETE FROM staff WHERE staff_id = $1', [id]);
    await pool.query('DELETE FROM login WHERE username = $1', [username]);

    res.json({ success: true });
  } catch (err) {
    console.error('staff DELETE error:', err);
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Cannot delete: staff member has associated history records' });
    }
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
