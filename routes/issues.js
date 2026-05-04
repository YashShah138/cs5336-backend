const express = require('express');
const { db, randomUUID } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function row2issue(i) {
  return {
    id: i.id,
    type: i.type,
    description: i.description,
    reportedBy: i.reported_by,
    flightId: i.flight_id,
    bagId: i.bag_id,
    passengerId: i.passenger_id,
    createdAt: i.created_at,
  };
}

router.get('/', authenticate, authorize('administrator'), (req, res) => {
  res.json(db.prepare('SELECT * FROM issues ORDER BY created_at DESC').all().map(row2issue));
});

router.post('/', authenticate, (req, res) => {
  const { type, description, reportedBy, flightId, bagId, passengerId } = req.body;

  const id = randomUUID();
  db.prepare(`
    INSERT INTO issues (id, type, description, reported_by, flight_id, bag_id, passenger_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, type || null, description || null, reportedBy || null, flightId || null, bagId || null, passengerId || null);

  res.status(201).json(row2issue(db.prepare('SELECT * FROM issues WHERE id = ?').get(id)));
});

module.exports = router;
