const express = require('express');
const { db, randomUUID } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function row2message(m) {
  return {
    id: m.id,
    boardType: m.board_type,
    staffId: m.staff_id,
    staffName: m.staff_name,
    airlineCode: m.airline_code,
    senderRole: m.sender_role,
    messageType: m.message_type,
    content: m.content,
    createdAt: m.created_at,
  };
}

router.get('/', authenticate, (req, res) => {
  const { boardType } = req.query;
  const rows = boardType
    ? db.prepare('SELECT * FROM messages WHERE board_type = ? ORDER BY created_at DESC').all(boardType)
    : db.prepare('SELECT * FROM messages ORDER BY created_at DESC').all();
  res.json(rows.map(row2message));
});

router.post('/', authenticate, (req, res) => {
  const { boardType, staffId, staffName, airlineCode, senderRole, messageType, content } = req.body;

  if (!boardType || !content) {
    return res.status(400).json({ error: 'boardType and content are required' });
  }
  if (content.length > 500) {
    return res.status(400).json({ error: 'Message content cannot exceed 500 characters' });
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO messages (id, board_type, staff_id, staff_name, airline_code, sender_role, message_type, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, boardType, staffId || null, staffName || null, airlineCode || null, senderRole || null, messageType || null, content);

  res.status(201).json(row2message(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)));
});

module.exports = router;
