const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { authenticate, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;

router.post('/login', (req, res) => {
  const { role, username, password, identification, ticketNumber } = req.body;

  if (!role) return res.status(400).json({ error: 'Role is required' });

  if (role === 'passenger') {
    if (!identification || !ticketNumber) {
      return res.status(400).json({ error: 'Identification and ticket number are required' });
    }
    const passenger = db.prepare(
      'SELECT * FROM passengers WHERE identification = ? AND ticket_number = ?'
    ).get(identification, ticketNumber);

    if (!passenger) {
      return res.status(401).json({ error: 'Invalid identification or ticket number' });
    }

    const token = jwt.sign({ id: passenger.id, role: 'passenger' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({
      token,
      user: {
        id: passenger.id,
        role: 'passenger',
        identification: passenger.identification,
        ticketNumber: passenger.ticket_number,
        firstName: passenger.first_name,
        lastName: passenger.last_name,
      },
    });
  }

  if (role === 'administrator') {
    const admin = db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: admin.id, role: 'administrator' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        role: 'administrator',
        firstName: admin.first_name,
        lastName: admin.last_name,
        requiresPasswordChange: !!admin.requires_password_change,
      },
    });
  }

  // Staff: airline_staff, gate_staff, ground_staff
  const staffMember = db.prepare(
    'SELECT * FROM staff WHERE username = ? AND staff_type = ?'
  ).get(username, role);

  if (!staffMember || !bcrypt.compareSync(password, staffMember.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { id: staffMember.id, role: staffMember.staff_type, airlineCode: staffMember.airline_code },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  return res.json({
    token,
    user: {
      id: staffMember.id,
      username: staffMember.username,
      role: staffMember.staff_type,
      firstName: staffMember.first_name,
      lastName: staffMember.last_name,
      email: staffMember.email,
      phone: staffMember.phone,
      airlineCode: staffMember.airline_code,
      requiresPasswordChange: !!staffMember.requires_password_change,
    },
  });
});

router.get('/me', authenticate, (req, res) => {
  const { id, role } = req.user;

  if (role === 'administrator') {
    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(id);
    if (!admin) return res.status(404).json({ error: 'Not found' });
    return res.json({
      id: admin.id,
      username: admin.username,
      role: 'administrator',
      firstName: admin.first_name,
      lastName: admin.last_name,
      requiresPasswordChange: !!admin.requires_password_change,
    });
  }

  if (role === 'passenger') {
    const passenger = db.prepare('SELECT * FROM passengers WHERE id = ?').get(id);
    if (!passenger) return res.status(404).json({ error: 'Not found' });
    return res.json({
      id: passenger.id,
      role: 'passenger',
      identification: passenger.identification,
      ticketNumber: passenger.ticket_number,
      firstName: passenger.first_name,
      lastName: passenger.last_name,
    });
  }

  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!staff) return res.status(404).json({ error: 'Not found' });
  return res.json({
    id: staff.id,
    username: staff.username,
    role: staff.staff_type,
    firstName: staff.first_name,
    lastName: staff.last_name,
    email: staff.email,
    phone: staff.phone,
    airlineCode: staff.airline_code,
    requiresPasswordChange: !!staff.requires_password_change,
  });
});

router.post('/change-password', authenticate, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const { id, role } = req.user;

  if (!PASSWORD_REGEX.test(newPassword)) {
    return res.status(400).json({
      error: 'Password must be at least 6 characters with 1 uppercase, 1 lowercase, and 1 number',
    });
  }

  if (role === 'administrator') {
    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(id);
    if (!bcrypt.compareSync(currentPassword, admin.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    db.prepare('UPDATE admin SET password = ?, requires_password_change = 0 WHERE id = ?')
      .run(bcrypt.hashSync(newPassword, 10), id);
  } else if (role !== 'passenger') {
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff || !bcrypt.compareSync(currentPassword, staff.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    db.prepare('UPDATE staff SET password = ?, requires_password_change = 0 WHERE id = ?')
      .run(bcrypt.hashSync(newPassword, 10), id);
  } else {
    return res.status(400).json({ error: 'Passengers cannot change passwords' });
  }

  res.json({ success: true });
});

module.exports = router;
