const express = require('express');
const bcrypt = require('bcryptjs');
const { db, randomUUID } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function generateUsername(lastName) {
  const namePart = lastName.toLowerCase().replace(/[^a-z]/g, '') || 'user';
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

function row2staff(s) {
  return {
    id: s.id,
    username: s.username,
    firstName: s.first_name,
    lastName: s.last_name,
    email: s.email,
    phone: s.phone,
    airlineCode: s.airline_code,
    staffType: s.staff_type,
    requiresPasswordChange: !!s.requires_password_change,
    createdAt: s.created_at,
  };
}

router.get('/', authenticate, authorize('administrator'), (req, res) => {
  const { staffType } = req.query;
  const rows = staffType
    ? db.prepare('SELECT * FROM staff WHERE staff_type = ? ORDER BY created_at DESC').all(staffType)
    : db.prepare('SELECT * FROM staff ORDER BY created_at DESC').all();
  res.json(rows.map(row2staff));
});

router.post('/', authenticate, authorize('administrator'), (req, res) => {
  const { firstName, lastName, email, phone, staffType, airlineCode } = req.body;

  if (!firstName || !lastName || !staffType) {
    return res.status(400).json({ error: 'firstName, lastName, and staffType are required' });
  }

  let username = generateUsername(lastName);
  let attempts = 0;
  while (db.prepare('SELECT id FROM staff WHERE username = ?').get(username) && attempts < 10) {
    username = generateUsername(lastName);
    attempts++;
  }

  const plainPassword = generatePassword();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO staff (id, username, password, first_name, last_name, email, phone, airline_code, staff_type, requires_password_change)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, username, bcrypt.hashSync(plainPassword, 10), firstName, lastName, email || null, phone || null, airlineCode || null, staffType);

  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  res.status(201).json({
    ...row2staff(staff),
    generatedCredentials: { username, password: plainPassword },
  });
});

router.delete('/:id', authenticate, authorize('administrator'), (req, res) => {
  const result = db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Staff member not found' });
  res.json({ success: true });
});

module.exports = router;
