const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, flightId, parseFlightId, normalizeStatus } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  return null;
}

function row2flight(f) {
  const code = f.airline_code ? f.airline_code.trim() : '';
  return {
    id: flightId(code, f.flight_number),
    airlineName: f.airline_name || null,
    airlineCode: code,
    flightNumber: String(f.flight_number),
    destination: f.destination || null,
    terminal: f.terminal || null,
    gate: f.gate_number || null,
    status: normalizeStatus(f.status),
  };
}

const SELECT_FLIGHT = `
  SELECT f.*, a.airline_name
  FROM flight f
  LEFT JOIN airline a ON a.airline_code = f.airline_code
`;

router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(SELECT_FLIGHT + ' ORDER BY f.airline_code, f.flight_number');
    res.json(rows.map(row2flight));
  } catch (err) {
    console.error('flights GET error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  const parsed = parseFlightId(req.params.id);
  if (!parsed) return res.status(400).json({ error: 'Invalid flight id' });
  try {
    const { rows } = await pool.query(
      SELECT_FLIGHT + ' WHERE f.airline_code = $1 AND f.flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Flight not found' });
    res.json(row2flight(rows[0]));
  } catch (err) {
    console.error('flights GET/:id error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

const createFlightValidation = [
  body('airlineCode').trim().notEmpty().withMessage('airlineCode is required')
    .isLength({ min: 2, max: 3 }).withMessage('airlineCode must be 2-3 characters')
    .isAlpha().withMessage('airlineCode must contain only letters'),
  body('flightNumber').notEmpty().withMessage('flightNumber is required')
    .isInt({ min: 1, max: 32767 }).withMessage('flightNumber must be a positive integer'),
  body('destination').optional({ nullable: true }).trim()
    .isLength({ max: 100 }).withMessage('destination too long')
    .matches(/^[A-Za-z\s,.-]*$/).withMessage('destination contains invalid characters'),
  body('terminal').trim().notEmpty().withMessage('terminal is required')
    .isLength({ max: 10 }).withMessage('terminal too long'),
  body('gate').trim().notEmpty().withMessage('gate is required')
    .isLength({ max: 10 }).withMessage('gate too long'),
];

router.post('/', authenticate, authorize('administrator'), createFlightValidation, async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  const { airlineCode, flightNumber, destination, terminal, gate } = req.body;
  const code = String(airlineCode).trim().toUpperCase();
  const num = Number(flightNumber);

  try {
    const { rowCount: airlineExists } = await pool.query(
      'SELECT 1 FROM airline WHERE airline_code = $1',
      [code]
    );
    if (!airlineExists) return res.status(400).json({ error: `Unknown airline code: ${code}` });

    const dup = await pool.query(
      'SELECT 1 FROM flight WHERE airline_code = $1 AND flight_number = $2',
      [code, num]
    );
    if (dup.rowCount) return res.status(409).json({ error: 'Flight already exists' });

    const occupied = await pool.query(
      'SELECT 1 FROM flight WHERE terminal = $1 AND gate_number = $2',
      [terminal, gate]
    );
    if (occupied.rowCount) return res.status(409).json({ error: 'Gate already occupied by another flight' });

    await pool.query(
      `INSERT INTO flight (airline_code, flight_number, destination, terminal, gate_number, status)
       VALUES ($1, $2, $3, $4, $5, 'Scheduled')`,
      [code, num, destination || null, terminal, gate]
    );

    const { rows } = await pool.query(
      SELECT_FLIGHT + ' WHERE f.airline_code = $1 AND f.flight_number = $2',
      [code, num]
    );
    res.status(201).json(row2flight(rows[0]));
  } catch (err) {
    console.error('flights POST error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/:id', authenticate, authorize('administrator'), async (req, res) => {
  const parsed = parseFlightId(req.params.id);
  if (!parsed) return res.status(400).json({ error: 'Invalid flight id' });
  try {
    const { rows: flightRows } = await pool.query(
      'SELECT 1 FROM flight WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    if (flightRows.length === 0) return res.status(404).json({ error: 'Flight not found' });

    // Check all passengers are boarded or removed
    const { rows: notBoardedRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM passenger
       WHERE airline_code = $1 AND flight_number = $2
         AND status NOT IN ('boarded', 'removed')`,
      [parsed.airlineCode, parsed.flightNumber]
    );
    const notBoardedCount = notBoardedRows[0].count;
    if (notBoardedCount > 0) {
      return res.status(409).json({
        error: `Cannot depart: ${notBoardedCount} passenger(s) have not boarded yet`,
        notBoardedCount,
      });
    }

    // Check all bags belonging to non-removed passengers are loaded
    const { rows: notLoadedRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM bag b
       JOIN passenger p ON p.ticket_number = b.ticket_number
       WHERE b.airline_code = $1 AND b.flight_number = $2
         AND p.status != 'removed'
         AND b.status != 'loaded'`,
      [parsed.airlineCode, parsed.flightNumber]
    );
    const notLoadedCount = notLoadedRows[0].count;
    if (notLoadedCount > 0) {
      return res.status(409).json({
        error: `Cannot depart: ${notLoadedCount} bag(s) have not been loaded yet`,
        notLoadedCount,
      });
    }

    await pool.query(
      `DELETE FROM bag_location_history WHERE bag_id IN (
         SELECT bag_id FROM bag WHERE airline_code = $1 AND flight_number = $2
       )`,
      [parsed.airlineCode, parsed.flightNumber]
    );
    await pool.query(
      'DELETE FROM bag WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    await pool.query(
      'DELETE FROM passenger WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    await pool.query(
      'DELETE FROM flight_gate_history WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    await pool.query(
      'UPDATE staff SET flight_number = NULL WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    await pool.query(
      'DELETE FROM flight WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('flights DELETE error:', err);
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Cannot delete: flight has associated passengers, bags, or staff' });
    }
    res.status(500).json({ error: 'Internal error' });
  }
});

const updateGateValidation = [
  body('terminal').trim().notEmpty().withMessage('terminal is required')
    .isLength({ max: 10 }).withMessage('terminal too long'),
  body('gate').trim().notEmpty().withMessage('gate is required')
    .isLength({ max: 10 }).withMessage('gate too long'),
];

router.patch('/:id/gate', authenticate, authorize('administrator', 'gate_staff', 'airline_staff'), updateGateValidation, async (req, res) => {
  const parsed = parseFlightId(req.params.id);
  if (!parsed) return res.status(400).json({ error: 'Invalid flight id' });

  const err = validate(req, res);
  if (err) return;

  const { terminal, gate } = req.body;

  try {
    const conflict = await pool.query(
      `SELECT 1 FROM flight
       WHERE terminal = $1 AND gate_number = $2
         AND NOT (airline_code = $3 AND flight_number = $4)`,
      [terminal, gate, parsed.airlineCode, parsed.flightNumber]
    );
    if (conflict.rowCount) return res.status(409).json({ error: 'Gate already occupied by another flight' });

    const before = await pool.query(
      'SELECT terminal, gate_number FROM flight WHERE airline_code = $1 AND flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    if (before.rowCount === 0) return res.status(404).json({ error: 'Flight not found' });
    const prev = before.rows[0];

    await pool.query(
      `UPDATE flight SET terminal = $1, gate_number = $2
       WHERE airline_code = $3 AND flight_number = $4`,
      [terminal, gate, parsed.airlineCode, parsed.flightNumber]
    );

    if (req.user.staffId) {
      await pool.query(
        `INSERT INTO flight_gate_history (airline_code, flight_number, old_terminal, old_gate, new_terminal, new_gate, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [parsed.airlineCode, parsed.flightNumber, prev.terminal, prev.gate_number, terminal, gate, req.user.staffId]
      );
    }

    const { rows } = await pool.query(
      SELECT_FLIGHT + ' WHERE f.airline_code = $1 AND f.flight_number = $2',
      [parsed.airlineCode, parsed.flightNumber]
    );
    res.json(row2flight(rows[0]));
  } catch (err) {
    console.error('flights PATCH error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
