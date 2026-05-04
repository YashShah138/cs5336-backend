const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const path = require('path');

const db = new Database(path.join(__dirname, 'airport.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    requires_password_change INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    airline_code TEXT,
    staff_type TEXT NOT NULL,
    requires_password_change INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flights (
    id TEXT PRIMARY KEY,
    airline_name TEXT,
    airline_code TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    destination TEXT,
    terminal TEXT NOT NULL,
    gate TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(airline_code, flight_number)
  );

  CREATE TABLE IF NOT EXISTS passengers (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    identification TEXT NOT NULL,
    ticket_number TEXT UNIQUE NOT NULL,
    flight_id TEXT NOT NULL,
    status TEXT DEFAULT 'not_checked_in',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (flight_id) REFERENCES flights(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bags (
    id TEXT PRIMARY KEY,
    bag_id TEXT UNIQUE NOT NULL,
    passenger_id TEXT NOT NULL,
    flight_id TEXT NOT NULL,
    location TEXT DEFAULT 'check_in',
    gate_number TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (passenger_id) REFERENCES passengers(id) ON DELETE CASCADE,
    FOREIGN KEY (flight_id) REFERENCES flights(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bag_location_history (
    id TEXT PRIMARY KEY,
    bag_id TEXT NOT NULL,
    location TEXT NOT NULL,
    updated_by TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bag_id) REFERENCES bags(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    board_type TEXT NOT NULL,
    staff_id TEXT,
    staff_name TEXT,
    airline_code TEXT,
    sender_role TEXT,
    message_type TEXT,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    type TEXT,
    description TEXT,
    reported_by TEXT,
    flight_id TEXT,
    bag_id TEXT,
    passenger_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default admin if not present
const existing = db.prepare('SELECT id FROM admin WHERE id = ?').get('admin-1');
if (!existing) {
  db.prepare(`
    INSERT INTO admin (id, username, password, first_name, last_name, requires_password_change)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run('admin-1', 'admin', bcrypt.hashSync('Admin123', 10), 'System', 'Administrator');
  console.log('Default admin created: admin / Admin123');
}

module.exports = { db, randomUUID };
