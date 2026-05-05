const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { pool, flightId } = require('../db');
const { authenticate, JWT_SECRET } = require('../middleware/auth');
const { securityLog } = require('../middleware/logger');

const router = express.Router();

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;
const STAFF_ROLES = ['airline_staff', 'gate_staff', 'ground_staff'];

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
});

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  return null;
}

function adminUser(login) {
  return {
    id: 'admin',
    username: login.username,
    role: 'administrator',
    firstName: 'System',
    lastName: 'Administrator',
    requiresPasswordChange: !!login.must_change_pwd,
  };
}

function staffUser(login, staff) {
  return {
    id: staff.staff_id,
    username: staff.username,
    role: staff.role,
    firstName: staff.firstname,
    lastName: staff.lastname,
    email: staff.email,
    phone: staff.phone,
    airlineCode: staff.airline_code ? staff.airline_code.trim() : null,
    flightId: staff.flight_number ? flightId(staff.airline_code.trim(), staff.flight_number) : null,
    requiresPasswordChange: !!login.must_change_pwd,
  };
}

function passengerUser(p) {
  return {
    id: p.ticket_number,
    role: 'passenger',
    identification: p.identification,
    ticketNumber: p.ticket_number,
    firstName: p.firstname,
    lastName: p.lastname,
    flightId: flightId(p.airline_code.trim(), p.flight_number),
  };
}

const loginValidation = [
  body('role').trim().notEmpty().withMessage('Role is required')
    .isIn(['passenger', 'administrator', 'airline_staff', 'gate_staff', 'ground_staff'])
    .withMessage('Invalid role'),
  body('username').optional().trim().isLength({ max: 50 }).withMessage('Username too long'),
  body('password').optional().isLength({ max: 128 }).withMessage('Password too long'),
  body('identification').optional().trim().isLength({ max: 100 }).withMessage('Identification too long'),
  body('ticketNumber').optional().trim().isLength({ max: 50 }).withMessage('Ticket number too long'),
];

router.post('/login', loginLimiter, loginValidation, async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  const { role, username, password, identification, ticketNumber } = req.body;
  const ip = req.ip;

  try {
    if (role === 'passenger') {
      if (!identification || !ticketNumber) {
        return res.status(400).json({ error: 'Identification and ticket number are required' });
      }
      const { rows } = await pool.query(
        'SELECT * FROM passenger WHERE identification = $1 AND ticket_number = $2',
        [identification.trim(), ticketNumber.trim()]
      );
      if (rows.length === 0) {
        securityLog('LOGIN_FAIL', { role, ip, reason: 'invalid_credentials' });
        return res.status(401).json({ error: 'Invalid identification or ticket number' });
      }
      const p = rows[0];
      const token = jwt.sign(
        { role: 'passenger', ticketNumber: p.ticket_number, identification: p.identification },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      securityLog('LOGIN_SUCCESS', { role, ticketNumber: p.ticket_number, ip });
      return res.json({ token, user: passengerUser(p) });
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const { rows: loginRows } = await pool.query(
      'SELECT username, password_hash, must_change_pwd FROM login WHERE username = $1',
      [username.trim()]
    );
    if (loginRows.length === 0 || !bcrypt.compareSync(password, loginRows[0].password_hash)) {
      securityLog('LOGIN_FAIL', { role, username: username.trim(), ip, reason: 'invalid_credentials' });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const login = loginRows[0];

    if (role === 'administrator') {
      const { rows: staffCheck } = await pool.query(
        'SELECT 1 FROM staff WHERE username = $1',
        [username.trim()]
      );
      if (staffCheck.length > 0) {
        securityLog('LOGIN_FAIL', { role, username: username.trim(), ip, reason: 'not_admin' });
        return res.status(401).json({ error: 'This account is not an administrator' });
      }
      const token = jwt.sign(
        { role: 'administrator', username: login.username },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      securityLog('LOGIN_SUCCESS', { role, username: login.username, ip });
      return res.json({ token, user: adminUser(login) });
    }

    if (STAFF_ROLES.includes(role)) {
      const { rows: staffRows } = await pool.query(
        'SELECT * FROM staff WHERE username = $1 AND role = $2',
        [username.trim(), role]
      );
      if (staffRows.length === 0) {
        securityLog('LOGIN_FAIL', { role, username: username.trim(), ip, reason: 'role_mismatch' });
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const staff = staffRows[0];
      const token = jwt.sign(
        {
          role: staff.role,
          username: staff.username,
          staffId: staff.staff_id,
          airlineCode: staff.airline_code ? staff.airline_code.trim() : null,
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      securityLog('LOGIN_SUCCESS', { role, username: login.username, ip });
      return res.json({ token, user: staffUser(login, staff) });
    }

    return res.status(400).json({ error: `Unknown role: ${role}` });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const { role } = req.user;

    if (role === 'administrator') {
      const { rows } = await pool.query(
        'SELECT username, password_hash, must_change_pwd FROM login WHERE username = $1',
        [req.user.username]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      return res.json(adminUser(rows[0]));
    }

    if (role === 'passenger') {
      const { rows } = await pool.query(
        'SELECT * FROM passenger WHERE ticket_number = $1',
        [req.user.ticketNumber]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      return res.json(passengerUser(rows[0]));
    }

    if (STAFF_ROLES.includes(role)) {
      const { rows } = await pool.query(
        `SELECT s.*, l.must_change_pwd
         FROM staff s
         JOIN login l ON l.username = s.username
         WHERE s.username = $1`,
        [req.user.username]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      return res.json(staffUser({ must_change_pwd: rows[0].must_change_pwd }, rows[0]));
    }

    return res.status(400).json({ error: 'Unknown role' });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

const changePasswordValidation = [
  body('currentPassword').notEmpty().withMessage('Current password is required')
    .isLength({ max: 128 }).withMessage('Password too long'),
  body('newPassword').notEmpty().withMessage('New password is required')
    .isLength({ max: 128 }).withMessage('Password too long'),
];

router.post('/change-password', authenticate, changePasswordValidation, async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  const { currentPassword, newPassword } = req.body;
  const { role, username } = req.user;

  if (role === 'passenger') {
    return res.status(400).json({ error: 'Passengers cannot change passwords' });
  }
  if (!PASSWORD_REGEX.test(newPassword)) {
    return res.status(400).json({
      error: 'Password must be at least 6 characters with 1 uppercase, 1 lowercase, and 1 number',
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT password_hash FROM login WHERE username = $1',
      [username]
    );
    if (rows.length === 0 || !bcrypt.compareSync(currentPassword, rows[0].password_hash)) {
      securityLog('PASSWORD_CHANGE_FAIL', { username, ip: req.ip, reason: 'wrong_current_password' });
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await pool.query(
      'UPDATE login SET password_hash = $1, must_change_pwd = false WHERE username = $2',
      [bcrypt.hashSync(newPassword, 10), username]
    );
    securityLog('PASSWORD_CHANGE_SUCCESS', { username, ip: req.ip });
    return res.json({ success: true });
  } catch (err) {
    console.error('change-password error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
