const express = require('express');
const { db, randomUUID } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function row2flight(f) {
  return {
    id: f.id,
    airlineName: f.airline_name,
    airlineCode: f.airline_code,
    flightNumber: f.flight_number,
    destination: f.destination,
    terminal: f.terminal,
    gate: f.gate,
    createdAt: f.created_at,
  };
}

router.get('/', authenticate, (req, res) => {
  const flights = db.prepare('SELECT * FROM flights ORDER BY created_at DESC').all();
  res.json(flights.map(row2flight));
});

router.get('/:id', authenticate, (req, res) => {
  const flight = db.prepare('SELECT * FROM flights WHERE id = ?').get(req.params.id);
  if (!flight) return res.status(404).json({ error: 'Flight not found' });
  res.json(row2flight(flight));
});

router.post('/', authenticate, authorize('administrator'), (req, res) => {
  const { airlineName, airlineCode, flightNumber, destination, terminal, gate } = req.body;

  if (!airlineCode || !flightNumber || !terminal || !gate) {
    return res.status(400).json({ error: 'airlineCode, flightNumber, terminal, and gate are required' });
  }

  const duplicate = db.prepare(
    'SELECT id FROM flights WHERE airline_code = ? AND flight_number = ?'
  ).get(airlineCode, flightNumber);
  if (duplicate) return res.status(409).json({ error: 'Flight already exists' });

  const gateOccupied = db.prepare(
    'SELECT id FROM flights WHERE terminal = ? AND gate = ?'
  ).get(terminal, gate);
  if (gateOccupied) return res.status(409).json({ error: 'Gate already occupied by another flight' });

  const id = randomUUID();
  db.prepare(
    'INSERT INTO flights (id, airline_name, airline_code, flight_number, destination, terminal, gate) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, airlineName || null, airlineCode, flightNumber, destination || null, terminal, gate);

  res.status(201).json(row2flight(db.prepare('SELECT * FROM flights WHERE id = ?').get(id)));
});

router.delete('/:id', authenticate, authorize('administrator'), (req, res) => {
  const result = db.prepare('DELETE FROM flights WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Flight not found' });
  res.json({ success: true });
});

router.patch('/:id/gate', authenticate, authorize('administrator', 'gate_staff', 'airline_staff'), (req, res) => {
  const { terminal, gate } = req.body;
  if (!terminal || !gate) return res.status(400).json({ error: 'terminal and gate are required' });

  const occupied = db.prepare(
    'SELECT id FROM flights WHERE terminal = ? AND gate = ? AND id != ?'
  ).get(terminal, gate, req.params.id);
  if (occupied) return res.status(409).json({ error: 'Gate already occupied by another flight' });

  const result = db.prepare(
    'UPDATE flights SET terminal = ?, gate = ? WHERE id = ?'
  ).run(terminal, gate, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Flight not found' });

  res.json(row2flight(db.prepare('SELECT * FROM flights WHERE id = ?').get(req.params.id)));
});

module.exports = router;
