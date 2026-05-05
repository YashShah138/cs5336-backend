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

function row2bag(b, history = []) {
  const code = b.airline_code ? b.airline_code.trim() : '';
  return {
    id: b.bag_id,
    bagId: b.bag_id,
    passengerId: b.ticket_number,
    flightId: flightId(code, b.flight_number),
    airlineCode: code,
    flightNumber: String(b.flight_number),
    location: normalizeStatus(b.status),
    gateNumber: b.counter_gate || null,
    counterNumber: b.counter_gate || null,
    terminal: b.terminal || null,
    locationHistory: history.map(h => ({
      location: normalizeStatus(h.status),
      gateNumber: h.counter_gate || null,
      terminal: h.terminal || null,
      updatedBy: h.changed_by_name || (h.changed_by != null ? String(h.changed_by) : null),
      timestamp: h.changed_at,
    })),
  };
}

const HISTORY_SELECT = `
  SELECT h.*, TRIM(s.firstname || ' ' || s.lastname) AS changed_by_name
  FROM bag_location_history h
  LEFT JOIN staff s ON s.staff_id = h.changed_by
`;

async function fetchBag(bagId) {
  const { rows: bagRows } = await pool.query('SELECT * FROM bag WHERE bag_id = $1', [bagId]);
  if (bagRows.length === 0) return null;
  const { rows: hist } = await pool.query(
    HISTORY_SELECT + ' WHERE h.bag_id = $1 ORDER BY h.changed_at ASC',
    [bagId]
  );
  return row2bag(bagRows[0], hist);
}

router.get('/', authenticate, async (req, res) => {
  const { passengerId, flightId: queryFlightId, location } = req.query;
  const where = [];
  const params = [];
  if (passengerId) { params.push(passengerId); where.push(`b.ticket_number = $${params.length}`); }
  if (queryFlightId) {
    const parsed = parseFlightId(queryFlightId);
    if (!parsed) return res.status(400).json({ error: 'Invalid flightId' });
    params.push(parsed.airlineCode); where.push(`b.airline_code = $${params.length}`);
    params.push(parsed.flightNumber); where.push(`b.flight_number = $${params.length}`);
  }
  if (location) { params.push(location); where.push(`b.status = $${params.length}`); }
  const sql = `SELECT * FROM bag b ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.bag_id`;

  try {
    const { rows } = await pool.query(sql, params);
    const bagIds = rows.map(r => r.bag_id);
    let historyByBag = new Map();
    if (bagIds.length > 0) {
      const { rows: hist } = await pool.query(
        HISTORY_SELECT + ' WHERE h.bag_id = ANY($1) ORDER BY h.changed_at ASC',
        [bagIds]
      );
      for (const h of hist) {
        if (!historyByBag.has(h.bag_id)) historyByBag.set(h.bag_id, []);
        historyByBag.get(h.bag_id).push(h);
      }
    }
    res.json(rows.map(b => row2bag(b, historyByBag.get(b.bag_id) || [])));
  } catch (err) {
    console.error('bags GET error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const bag = await fetchBag(req.params.id);
    if (!bag) return res.status(404).json({ error: 'Bag not found' });
    res.json(bag);
  } catch (err) {
    console.error('bags GET/:id error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

const createBagValidation = [
  body('bagId').trim().notEmpty().withMessage('bagId is required')
    .isLength({ max: 50 }).withMessage('bagId too long')
    .isAlphanumeric().withMessage('bagId must be alphanumeric'),
  body('passengerId').trim().notEmpty().withMessage('passengerId is required')
    .isLength({ max: 50 }).withMessage('passengerId too long'),
  body('flightId').trim().notEmpty().withMessage('flightId is required'),
  body('terminal').optional({ nullable: true }).trim().isLength({ max: 10 }).withMessage('terminal too long'),
  body('counterNumber').optional({ nullable: true }).trim().isLength({ max: 10 }).withMessage('counterNumber too long'),
];

router.post('/', authenticate, authorize('administrator', 'airline_staff'), createBagValidation, async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  const { bagId, passengerId, flightId: bodyFlightId, terminal, counterNumber } = req.body;
  const parsed = parseFlightId(bodyFlightId.trim());
  if (!parsed) return res.status(400).json({ error: 'Invalid flightId' });

  try {
    const dup = await pool.query('SELECT 1 FROM bag WHERE bag_id = $1', [bagId.trim()]);
    if (dup.rowCount) return res.status(409).json({ error: 'Bag ID already in use' });

    const passenger = await pool.query(
      'SELECT 1 FROM passenger WHERE ticket_number = $1',
      [passengerId.trim()]
    );
    if (passenger.rowCount === 0) return res.status(404).json({ error: 'Passenger not found' });

    await pool.query(
      `INSERT INTO bag (bag_id, ticket_number, airline_code, flight_number, terminal, counter_gate, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'check_in')`,
      [bagId.trim(), passengerId.trim(), parsed.airlineCode, parsed.flightNumber, terminal || null, counterNumber || null]
    );

    const changedBy = req.user.staffId || null;
    if (changedBy != null) {
      await pool.query(
        `INSERT INTO bag_location_history (bag_id, airline_code, flight_number, terminal, counter_gate, status, changed_by)
         VALUES ($1, $2, $3, $4, $5, 'check_in', $6)`,
        [bagId.trim(), parsed.airlineCode, parsed.flightNumber, terminal || null, counterNumber || null, changedBy]
      );
    }

    res.status(201).json(await fetchBag(bagId.trim()));
  } catch (err) {
    console.error('bags POST error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/:id', authenticate, authorize('administrator', 'airline_staff'), async (req, res) => {
  try {
    await pool.query('DELETE FROM bag_location_history WHERE bag_id = $1', [req.params.id]);
    const result = await pool.query('DELETE FROM bag WHERE bag_id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Bag not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('bags DELETE error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

const updateLocationValidation = [
  body('location').notEmpty().withMessage('location is required')
    .isIn(['check_in', 'security', 'security_violation', 'gate', 'loaded']).withMessage('Invalid location'),
  body('gateNumber').optional({ nullable: true }).trim().isLength({ max: 10 }).withMessage('gateNumber too long'),
];

router.patch('/:id/location', authenticate, updateLocationValidation, async (req, res) => {
  const allowed = ['administrator', 'airline_staff', 'gate_staff', 'ground_staff'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });

  const err = validate(req, res);
  if (err) return;

  const { location, gateNumber } = req.body;

  try {
    const before = await pool.query(
      'SELECT bag_id, airline_code, flight_number, terminal, counter_gate FROM bag WHERE bag_id = $1',
      [req.params.id]
    );
    if (before.rowCount === 0) return res.status(404).json({ error: 'Bag not found' });
    const b = before.rows[0];

    await pool.query(
      `UPDATE bag SET status = $1, counter_gate = COALESCE($2, counter_gate)
       WHERE bag_id = $3`,
      [location, gateNumber || null, req.params.id]
    );

    const changedBy = req.user.staffId || null;
    if (changedBy != null) {
      await pool.query(
        `INSERT INTO bag_location_history (bag_id, airline_code, flight_number, terminal, counter_gate, status, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.params.id, b.airline_code, b.flight_number, b.terminal, gateNumber || b.counter_gate, location, changedBy]
      );
    }

    res.json(await fetchBag(req.params.id));
  } catch (err) {
    console.error('bags PATCH error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
