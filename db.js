const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in .env (Supabase Session pooler URI)');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const flightId = (airlineCode, flightNumber) => `${String(airlineCode).trim()}-${flightNumber}`;

function parseFlightId(id) {
  const m = /^([A-Za-z0-9]{1,3})-(\d+)$/.exec(String(id || '').trim());
  if (!m) return null;
  return { airlineCode: m[1].toUpperCase(), flightNumber: Number(m[2]) };
}

// Existing rows have status values like "Checked-In" / "Check-In"; the frontend
// uses "checked_in" / "check_in". Normalize when reading so both work.
const normalizeStatus = (s) => (s == null ? s : String(s).toLowerCase().replace(/[\s-]+/g, '_'));

module.exports = { pool, flightId, parseFlightId, normalizeStatus };
