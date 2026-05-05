const express = require('express');
const { pool, flightId, parseFlightId } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function row2issue(i) {
  const code = i.airline_code ? i.airline_code.trim() : null;
  return {
    id: i.issue_id,
    type: i.type,
    description: i.description,
    reportedBy: i.reported_by,
    bagId: i.bag_id,
    passengerId: i.ticket_number,
    flightId: code && i.flight_number ? flightId(code, i.flight_number) : null,
    createdAt: i.created_at,
  };
}

router.get('/', authenticate, authorize('administrator'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM issue ORDER BY created_at DESC');
    res.json(rows.map(row2issue));
  } catch (err) {
    console.error('issues GET error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/', authenticate, async (req, res) => {
  const { type, description, reportedBy, flightId: bodyFlightId, bagId, passengerId } = req.body;
  if (!type) return res.status(400).json({ error: 'type is required' });

  const parsed = bodyFlightId ? parseFlightId(bodyFlightId) : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO issue (type, description, reported_by, bag_id, ticket_number, airline_code, flight_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        type,
        description || null,
        reportedBy || null,
        bagId || null,
        passengerId || null,
        parsed ? parsed.airlineCode : null,
        parsed ? parsed.flightNumber : null,
      ]
    );
    res.status(201).json(row2issue(rows[0]));
  } catch (err) {
    console.error('issues POST error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
