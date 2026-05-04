const express = require('express');
const { db, randomUUID } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function row2passenger(p) {
  return {
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    identification: p.identification,
    ticketNumber: p.ticket_number,
    flightId: p.flight_id,
    status: p.status,
    createdAt: p.created_at,
  };
}

router.get('/', authenticate, (req, res) => {
  const { flightId } = req.query;
  const rows = flightId
    ? db.prepare('SELECT * FROM passengers WHERE flight_id = ? ORDER BY created_at').all(flightId)
    : db.prepare('SELECT * FROM passengers ORDER BY created_at DESC').all();
  res.json(rows.map(row2passenger));
});

router.get('/:id', authenticate, (req, res) => {
  const passenger = db.prepare('SELECT * FROM passengers WHERE id = ?').get(req.params.id);
  if (!passenger) return res.status(404).json({ error: 'Passenger not found' });
  res.json(row2passenger(passenger));
});

router.post('/', authenticate, authorize('administrator', 'airline_staff'), (req, res) => {
  const { firstName, lastName, identification, ticketNumber, flightId } = req.body;

  if (!firstName || !lastName || !identification || !ticketNumber || !flightId) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const existing = db.prepare('SELECT id FROM passengers WHERE ticket_number = ?').get(ticketNumber);
  if (existing) return res.status(409).json({ error: 'Ticket number already exists' });

  const flight = db.prepare('SELECT id FROM flights WHERE id = ?').get(flightId);
  if (!flight) return res.status(404).json({ error: 'Flight not found' });

  const id = randomUUID();
  db.prepare(
    "INSERT INTO passengers (id, first_name, last_name, identification, ticket_number, flight_id, status) VALUES (?, ?, ?, ?, ?, ?, 'not_checked_in')"
  ).run(id, firstName, lastName, identification, ticketNumber, flightId);

  res.status(201).json(row2passenger(db.prepare('SELECT * FROM passengers WHERE id = ?').get(id)));
});

router.delete('/:id', authenticate, authorize('administrator'), (req, res) => {
  const result = db.prepare('DELETE FROM passengers WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Passenger not found' });
  res.json({ success: true });
});

router.patch('/:id/status', authenticate, authorize('administrator', 'airline_staff', 'gate_staff'), (req, res) => {
  const { status } = req.body;
  const valid = ['not_checked_in', 'checked_in', 'boarded'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const result = db.prepare('UPDATE passengers SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Passenger not found' });

  res.json(row2passenger(db.prepare('SELECT * FROM passengers WHERE id = ?').get(req.params.id)));
});

module.exports = router;
