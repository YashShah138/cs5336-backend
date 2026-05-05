const express = require('express');
const { pool, flightId, parseFlightId, normalizeStatus } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function row2passenger(p) {
  const code = p.airline_code ? p.airline_code.trim() : '';
  return {
    id: p.ticket_number,
    firstName: p.firstname,
    lastName: p.lastname,
    identification: p.identification,
    ticketNumber: p.ticket_number,
    flightId: flightId(code, p.flight_number),
    airlineCode: code,
    flightNumber: String(p.flight_number),
    status: normalizeStatus(p.status),
  };
}

router.get('/', authenticate, async (req, res) => {
  const { flightId: queryFlightId } = req.query;
  try {
    if (queryFlightId) {
      const parsed = parseFlightId(queryFlightId);
      if (!parsed) return res.status(400).json({ error: 'Invalid flightId' });
      const { rows } = await pool.query(
        'SELECT * FROM passenger WHERE airline_code = $1 AND flight_number = $2 ORDER BY lastname, firstname',
        [parsed.airlineCode, parsed.flightNumber]
      );
      return res.json(rows.map(row2passenger));
    }
    const { rows } = await pool.query(
      'SELECT * FROM passenger ORDER BY airline_code, flight_number, lastname, firstname'
    );
    res.json(rows.map(row2passenger));
  } catch (err) {
    console.error('passengers GET error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM passenger WHERE ticket_number = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Passenger not found' });
    res.json(row2passenger(rows[0]));
  } catch (err) {
    console.error('passengers GET/:id error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/', authenticate, authorize('administrator', 'airline_staff'), async (req, res) => {
  const { firstName, lastName, identification, ticketNumber, flightId: bodyFlightId } = req.body;
  if (!firstName || !lastName || !identification || !ticketNumber || !bodyFlightId) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const parsed = parseFlightId(bodyFlightId);
  if (!parsed) return res.status(400).json({ error: 'Invalid flightId' });

  try {
    const flight = await pool.query(
      'SELECT 1 FROM flight WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    if (flight.rowCount === 0) return res.status(404).json({ error: 'Flight not found' });

    const dup = await pool.query(
      'SELECT 1 FROM passenger WHERE ticket_number = $1',
      [ticketNumber]
    );
    if (dup.rowCount) return res.status(409).json({ error: 'Ticket number already exists' });

    await pool.query(
      `INSERT INTO passenger (identification, airline_code, flight_number, ticket_number, firstname, lastname, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'not_checked_in')`,
      [identification, parsed.airlineCode, parsed.flightNumber, ticketNumber, firstName, lastName]
    );

    const { rows } = await pool.query(
      'SELECT * FROM passenger WHERE ticket_number = $1',
      [ticketNumber]
    );
    res.status(201).json(row2passenger(rows[0]));
  } catch (err) {
    console.error('passengers POST error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/:id', authenticate, authorize('administrator'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM passenger WHERE ticket_number = $1',
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Passenger not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('passengers DELETE error:', err);
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Cannot delete: passenger has associated bags' });
    }
    res.status(500).json({ error: 'Internal error' });
  }
});

router.patch('/:id/status', authenticate, authorize('administrator', 'airline_staff', 'gate_staff'), async (req, res) => {
  const { status } = req.body;
  const valid = ['not_checked_in', 'checked_in', 'boarded', 'removed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const result = await pool.query(
      'UPDATE passenger SET status = $1 WHERE ticket_number = $2',
      [status, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Passenger not found' });
    const { rows } = await pool.query(
      'SELECT * FROM passenger WHERE ticket_number = $1',
      [req.params.id]
    );
    res.json(row2passenger(rows[0]));
  } catch (err) {
    console.error('passengers PATCH error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
