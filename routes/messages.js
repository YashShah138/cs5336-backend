const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const METADATA_FIELDS = ['bagId', 'passengerId', 'passengerName', 'flightInfo', 'flightId'];

function row2message(m) {
  const meta = m.metadata || {};
  return {
    id: m.message_id,
    boardType: m.board_type,
    staffId: m.sender_id,
    staffName: m.sender_name,
    senderRole: m.sender_type,
    airlineCode: m.airline_code ? m.airline_code.trim() : null,
    messageType: m.message_type,
    content: m.content || m.body || '',
    bagId: meta.bagId || null,
    passengerId: meta.passengerId || null,
    passengerName: meta.passengerName || null,
    flightInfo: meta.flightInfo || null,
    flightId: meta.flightId || null,
    createdAt: m.created_at,
  };
}

router.get('/', authenticate, async (req, res) => {
  const { boardType } = req.query;
  try {
    const sql = boardType
      ? 'SELECT * FROM message WHERE board_type = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM message ORDER BY created_at DESC';
    const { rows } = await pool.query(sql, boardType ? [boardType] : []);
    res.json(rows.map(row2message));
  } catch (err) {
    console.error('messages GET error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/', authenticate, async (req, res) => {
  const { boardType, senderName, senderRole, airlineCode, messageType, content } = req.body;
  if (!boardType || !content) {
    return res.status(400).json({ error: 'boardType and content are required' });
  }
  if (String(content).length > 500) {
    return res.status(400).json({ error: 'Message content cannot exceed 500 characters' });
  }
  if (!req.user.staffId) {
    return res.status(403).json({ error: 'Only staff members can post messages' });
  }

  const metadata = {};
  for (const k of METADATA_FIELDS) if (req.body[k] != null) metadata[k] = req.body[k];

  try {
    const { rows } = await pool.query(
      `INSERT INTO message
         (sender_id, sender_type, sender_name, airline_code, board_type, message_type, content, body, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
       RETURNING *`,
      [
        req.user.staffId,
        senderRole || req.user.role,
        senderName || null,
        airlineCode || null,
        boardType,
        messageType || null,
        content,
        Object.keys(metadata).length ? metadata : null,
      ]
    );
    res.status(201).json(row2message(rows[0]));
  } catch (err) {
    console.error('messages POST error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
