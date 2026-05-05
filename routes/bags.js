const express = require('express');
const { pool, flightId, parseFlightId, normalizeStatus } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

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

router.post('/', authenticate, authorize('administrator', 'airline_staff'), async (req, res) => {
  const { bagId, passengerId, flightId: bodyFlightId, terminal, counterNumber } = req.body;
  if (!bagId || !passengerId || !bodyFlightId) {
    return res.status(400).json({ error: 'bagId, passengerId, and flightId are required' });
  }
  const parsed = parseFlightId(bodyFlightId);
  if (!parsed) return res.status(400).json({ error: 'Invalid flightId' });

  try {
    const dup = await pool.query('SELECT 1 FROM bag WHERE bag_id = $1', [bagId]);
    if (dup.rowCount) return res.status(409).json({ error: 'Bag ID already in use' });

    const passenger = await pool.query(
      'SELECT 1 FROM passenger WHERE ticket_number = $1',
      [passengerId]
    );
    if (passenger.rowCount === 0) return res.status(404).json({ error: 'Passenger not found' });

    await pool.query(
      `INSERT INTO bag (bag_id, ticket_number, airline_code, flight_number, terminal, counter_gate, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'check_in')`,
      [bagId, passengerId, parsed.airlineCode, parsed.flightNumber, terminal || null, counterNumber || null]
    );

    const changedBy = req.user.staffId || null;
    if (changedBy != null) {
      await pool.query(
        `INSERT INTO bag_location_history (bag_id, airline_code, flight_number, terminal, counter_gate, status, changed_by)
         VALUES ($1, $2, $3, $4, $5, 'check_in', $6)`,
        [bagId, parsed.airlineCode, parsed.flightNumber, terminal || null, counterNumber || null, changedBy]
      );
    }

    res.status(201).json(await fetchBag(bagId));
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

router.patch('/:id/location', authenticate, async (req, res) => {
  const allowed = ['administrator', 'airline_staff', 'gate_staff', 'ground_staff'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });

  const { location, gateNumber } = req.body;
  const valid = ['check_in', 'security', 'security_violation', 'gate', 'loaded'];
  if (!valid.includes(location)) return res.status(400).json({ error: 'Invalid location' });

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
