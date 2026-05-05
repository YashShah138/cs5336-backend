const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool, flightId } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { securityLog } = require('../middleware/logger');

const router = express.Router();

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  return null;
}

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

const createStaffValidation = [
  body('firstName').trim().notEmpty().withMessage('firstName is required')
    .isLength({ max: 50 }).withMessage('firstName too long')
    .matches(/^[A-Za-z\s'-]+$/).withMessage('firstName contains invalid characters'),
  body('lastName').trim().notEmpty().withMessage('lastName is required')
    .isLength({ max: 50 }).withMessage('lastName too long')
    .matches(/^[A-Za-z\s'-]+$/).withMessage('lastName contains invalid characters'),
  body('email').trim().notEmpty().withMessage('email is required')
    .isEmail().withMessage('Invalid email address')
    .isLength({ max: 100 }).withMessage('email too long'),
  body('phone').optional({ nullable: true }).trim()
    .matches(/^[0-9]{10}$/).withMessage('Phone must be exactly 10 digits'),
  body('staffType').notEmpty().withMessage('staffType is required')
    .isIn(['airline_staff', 'gate_staff', 'ground_staff']).withMessage('Invalid staffType'),
  body('airlineCode').optional({ nullable: true }).trim()
    .isLength({ max: 3 }).withMessage('airlineCode too long'),
];

router.post('/', authenticate, authorize('administrator'), createStaffValidation, async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  const { firstName, lastName, email, phone, staffType, airlineCode } = req.body;

  let code = airlineCode ? String(airlineCode).trim().toUpperCase() : null;

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
      [code, username, firstName.trim(), lastName.trim(), email.trim(), phone || null, staffType]
    );

    securityLog('STAFF_CREATED', { username, staffType, createdBy: req.user.username, ip: req.ip });

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

    securityLog('STAFF_DELETED', { username, deletedBy: req.user.username, ip: req.ip });

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
