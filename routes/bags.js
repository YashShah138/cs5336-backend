const express = require('express');
const { db, randomUUID } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function row2bag(b) {
  const history = db.prepare(
    'SELECT location, updated_by, timestamp FROM bag_location_history WHERE bag_id = ? ORDER BY timestamp ASC'
  ).all(b.id);

  return {
    id: b.id,
    bagId: b.bag_id,
    passengerId: b.passenger_id,
    flightId: b.flight_id,
    location: b.location,
    gateNumber: b.gate_number,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    locationHistory: history.map(h => ({
      location: h.location,
      updatedBy: h.updated_by,
      timestamp: h.timestamp,
    })),
  };
}

router.get('/', authenticate, (req, res) => {
  const { passengerId, flightId, location } = req.query;
  let query = 'SELECT * FROM bags WHERE 1=1';
  const params = [];

  if (passengerId) { query += ' AND passenger_id = ?'; params.push(passengerId); }
  if (flightId) { query += ' AND flight_id = ?'; params.push(flightId); }
  if (location) { query += ' AND location = ?'; params.push(location); }
  query += ' ORDER BY created_at DESC';

  res.json(db.prepare(query).all(...params).map(row2bag));
});

router.get('/:id', authenticate, (req, res) => {
  const bag = db.prepare('SELECT * FROM bags WHERE id = ?').get(req.params.id);
  if (!bag) return res.status(404).json({ error: 'Bag not found' });
  res.json(row2bag(bag));
});

router.post('/', authenticate, authorize('administrator', 'airline_staff'), (req, res) => {
  const { bagId, passengerId, flightId } = req.body;

  if (!bagId || !passengerId || !flightId) {
    return res.status(400).json({ error: 'bagId, passengerId, and flightId are required' });
  }

  const existing = db.prepare('SELECT id FROM bags WHERE bag_id = ?').get(bagId);
  if (existing) return res.status(409).json({ error: 'Bag ID already in use' });

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO bags (id, bag_id, passenger_id, flight_id, location, created_at, updated_at) VALUES (?, ?, ?, ?, 'check_in', ?, ?)"
  ).run(id, bagId, passengerId, flightId, now, now);

  db.prepare(
    'INSERT INTO bag_location_history (id, bag_id, location, timestamp) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), id, 'check_in', now);

  res.status(201).json(row2bag(db.prepare('SELECT * FROM bags WHERE id = ?').get(id)));
});

router.delete('/:id', authenticate, authorize('administrator', 'airline_staff'), (req, res) => {
  const result = db.prepare('DELETE FROM bags WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Bag not found' });
  res.json({ success: true });
});

router.patch('/:id/location', authenticate, (req, res) => {
  const { role } = req.user;
  const allowed = ['administrator', 'airline_staff', 'gate_staff', 'ground_staff'];
  if (!allowed.includes(role)) return res.status(403).json({ error: 'Forbidden' });

  const { location, gateNumber, updatedBy } = req.body;
  const valid = ['check_in', 'security', 'security_violation', 'gate', 'loaded'];
  if (!valid.includes(location)) return res.status(400).json({ error: 'Invalid location' });

  const now = new Date().toISOString();
  const result = db.prepare(
    'UPDATE bags SET location = ?, gate_number = COALESCE(?, gate_number), updated_at = ? WHERE id = ?'
  ).run(location, gateNumber || null, now, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Bag not found' });

  db.prepare(
    'INSERT INTO bag_location_history (id, bag_id, location, updated_by, timestamp) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), req.params.id, location, updatedBy || null, now);

  res.json(row2bag(db.prepare('SELECT * FROM bags WHERE id = ?').get(req.params.id)));
});

module.exports = router;
