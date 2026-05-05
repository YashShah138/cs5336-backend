// One-shot setup against the project's Supabase Postgres.
// Idempotent — safe to re-run any number of times.
//
// Steps:
//   1. apply non-destructive schema additions (issue table, extra columns on message)
//   2. ensure the admin login exists (admin / Admin123)
//   3. load the official test data from the class xlsx:
//        - update passenger statuses to match the spreadsheet
//        - insert the 43 bags
//        - create 28 staff (9 airline + 9 gate + 10 ground), assigning the 9
//          named in the "Additional Instructions" PDF to their gates and
//          marking them must_change_pwd=false (i.e. "have logged in")
//
// The full credentials list is printed at the end on first run; subsequent
// runs skip already-existing staff so passwords don't churn.

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// The xlsx is looked up in this order:
//   1. $XLSX_PATH if set
//   2. <repo-root>/Test Data.xlsx     (the recommended location)
//   3. ~/Downloads/Test Data.xlsx     (where it lands by default)
const XLSX_CANDIDATES = [
  process.env.XLSX_PATH,
  path.resolve(__dirname, '..', 'Test Data.xlsx'),
  path.join(os.homedir(), 'Downloads', 'Test Data.xlsx'),
].filter(Boolean);
const xlsxPath = XLSX_CANDIDATES.find(p => fs.existsSync(p));

const STAFF_EMAIL = process.env.STAFF_EMAIL || 'will.o.subs@gmail.com';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin123';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const AIRLINE_NAME_TO_CODE = {
  'American Airlines': 'AA',
  'Delta Airlines':    'DL',
  'United Airlines':   'UA',
  'Frontier Airlines': 'FA',
  'Southwest Airlines':'SW',
};
const STATUS_MAP = { 'Checked-in': 'checked_in', 'Not-checked-in': 'not_checked_in', 'Boarded': 'boarded' };
const LOC_MAP    = { 'Check-in counter': 'check_in', 'Security Check': 'security', 'At-the-gate': 'gate', 'Loaded': 'loaded' };

// Per the "Additional Instructions" PDF: these named staff must have logged
// in already (must_change_pwd=false) and must be assigned to a specific
// gate's flight.
const GATE_ASSIGNMENTS = {
  'Liam:Mylopolus': { gate: 'D01', flight: { airline: 'AA', number: 1476 } },
  'Scott:Louise':   { gate: 'C19', flight: { airline: 'AA', number: 1523 } },
  'Emily:Reckon':   { gate: 'C22', flight: { airline: 'AA', number: 1175 } },
  'Rudy:Guelph':    { gate: 'E17', flight: { airline: 'DL', number: 2746 } },
  'Steve:Rangers':  { gate: 'E02', flight: { airline: 'FA', number: 1270 } },
  'Galvin:Ramos':   { gate: 'D01', flight: { airline: 'AA', number: 1476 } },
  'Jacob:Weiner':   { gate: 'C19', flight: { airline: 'AA', number: 1523 } },
  'Tom:Cooper':     { gate: 'E17', flight: { airline: 'DL', number: 2746 } },
  'Yeng:Zhang':     { gate: 'E02', flight: { airline: 'FA', number: 1270 } },
};

const DDL = `
CREATE TABLE IF NOT EXISTS public.issue (
  issue_id      serial PRIMARY KEY,
  type          varchar(64) NOT NULL,
  description   text,
  reported_by   varchar(128),
  bag_id        varchar(64),
  ticket_number varchar(64),
  airline_code  char(2),
  flight_number smallint,
  created_at    timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.message
  ADD COLUMN IF NOT EXISTS board_type   varchar(32),
  ADD COLUMN IF NOT EXISTS message_type varchar(64),
  ADD COLUMN IF NOT EXISTS sender_name  varchar(128),
  ADD COLUMN IF NOT EXISTS content      text,
  ADD COLUMN IF NOT EXISTS metadata     jsonb;

ALTER TABLE public.message ALTER COLUMN airline_code DROP NOT NULL;
`;

function genUsername(lastName, taken) {
  const base = String(lastName || '').toLowerCase().replace(/[^a-z]/g, '') || 'user';
  for (let i = 0; i < 100; i++) {
    const u = base + String(Math.floor(10 + Math.random() * 90));
    if (!taken.has(u)) return u;
  }
  throw new Error('username collision after 100 attempts for ' + lastName);
}

function genPassword() {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const all = upper + lower + digits;
  let pw = upper[Math.floor(Math.random() * 26)] + lower[Math.floor(Math.random() * 26)] + digits[Math.floor(Math.random() * 10)];
  for (let i = 0; i < 5; i++) pw += all[Math.floor(Math.random() * all.length)];
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

function parseFlights(wb) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Flights'], { defval: null, raw: false });
  const out = [];
  for (const r of rows) {
    if (!r['Flight number'] || !/^[A-Z]{2}\d+$/.test(r['Flight number'])) continue;
    const m = /^([A-Z]{2})(\d+)$/.exec(r['Flight number']);
    out.push({ airlineCode: m[1], flightNumber: Number(m[2]), gate: r['__EMPTY'], terminal: (r['Gate'] || '').trim() });
  }
  return out;
}
function parsePassengers(wb) {
  return XLSX.utils.sheet_to_json(wb.Sheets['Passengers'], { defval: null, raw: false }).map(r => ({
    ticketNumber: r['Ticket number'],
    status: STATUS_MAP[r['Status']] || r['Status'],
  }));
}
function parseBags(wb) {
  return XLSX.utils.sheet_to_json(wb.Sheets['Bags'], { defval: null, raw: false }).map(r => {
    const m = /^([A-Z]{2})(\d+)$/.exec(r['Flight']);
    return {
      bagId: r['BagID'],
      ticketNumber: r['TicketNumber'],
      airlineCode: m[1],
      flightNumber: Number(m[2]),
      location: LOC_MAP[r['Location']] || r['Location'],
    };
  });
}
function parseStaff(wb) {
  const out = [];
  for (const sheet of ['AirlineStaff', 'GateStaff']) {
    XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: null, raw: false }).forEach(r => {
      out.push({
        firstName: (r['Firstname'] || '').trim(),
        lastName:  (r['Lastname']  || '').trim(),
        phone:     String(r['Phone'] || '').replace(/\D/g, ''),
        airlineCode: r['Airline'],
        role: sheet === 'AirlineStaff' ? 'airline_staff' : 'gate_staff',
      });
    });
  }
  XLSX.utils.sheet_to_json(wb.Sheets['GroundStaff'], { defval: null, raw: false }).forEach(r => {
    out.push({
      firstName: (r['Firstname'] || '').trim(),
      lastName:  (r['Lastname']  || '').trim(),
      phone:     String(r['Phone'] || '').replace(/\D/g, ''),
      airlineCode: null, // resolved below
      role: 'ground_staff',
    });
  });
  return out;
}

(async () => {
  try {
    if (!xlsxPath) {
      throw new Error('Test Data.xlsx not found. Looked in:\n  ' + XLSX_CANDIDATES.join('\n  ') + '\nSet $XLSX_PATH to override.');
    }
    const wb = XLSX.readFile(xlsxPath);

    console.log(`[1/5] applying schema additions...`);
    await pool.query(DDL);

    console.log(`[2/5] ensuring admin login exists...`);
    const adminCheck = await pool.query('SELECT 1 FROM login WHERE username = $1', [ADMIN_USERNAME]);
    if (adminCheck.rowCount === 0) {
      await pool.query(
        `INSERT INTO login (username, password_hash, must_change_pwd) VALUES ($1, $2, false)`,
        [ADMIN_USERNAME, bcrypt.hashSync(ADMIN_PASSWORD, 10)]
      );
      console.log(`      created admin / ${ADMIN_PASSWORD}`);
    } else {
      console.log(`      admin already exists (password unchanged)`);
    }

    const flights    = parseFlights(wb);
    const passengers = parsePassengers(wb);
    const bags       = parseBags(wb);
    const staffList  = parseStaff(wb);

    console.log(`[3/5] applying ${passengers.length} passenger statuses from xlsx...`);
    let statusUpdates = 0;
    for (const p of passengers) {
      const r = await pool.query(
        `UPDATE passenger SET status = $1 WHERE ticket_number = $2 AND status <> $1`,
        [p.status, p.ticketNumber]
      );
      statusUpdates += r.rowCount;
    }
    console.log(`      ${statusUpdates} status changes applied`);

    console.log(`[4/5] inserting ${bags.length} bags (skip-if-exists)...`);
    let bagInserts = 0;
    for (const b of bags) {
      const flight = flights.find(f => f.airlineCode === b.airlineCode && f.flightNumber === b.flightNumber);
      const terminal = flight ? flight.terminal : null;
      const counterGate = (b.location === 'gate' || b.location === 'loaded') && flight ? flight.gate : null;
      const r = await pool.query(
        `INSERT INTO bag (bag_id, ticket_number, airline_code, flight_number, terminal, counter_gate, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (bag_id) DO NOTHING`,
        [b.bagId, b.ticketNumber, b.airlineCode, b.flightNumber, terminal, counterGate, b.location]
      );
      bagInserts += r.rowCount;
    }
    console.log(`      ${bagInserts} bag(s) inserted`);

    console.log(`[5/5] creating ${staffList.length} staff (skip-if-exists)...`);
    const { rows: airlineRows } = await pool.query('SELECT airline_code FROM airline ORDER BY airline_code LIMIT 1');
    if (airlineRows.length === 0) throw new Error('No airlines exist; cannot create staff');
    const defaultAirline = airlineRows[0].airline_code.trim();

    const { rows: existingLogins } = await pool.query('SELECT username FROM login');
    const takenUsernames = new Set(existingLogins.map(r => r.username));

    const credentialsReport = [];
    let staffCreated = 0, staffSkipped = 0;

    for (const s of staffList) {
      const key = `${s.firstName}:${s.lastName}`;
      const assignment = GATE_ASSIGNMENTS[key];
      const airlineCode = s.airlineCode || (assignment ? assignment.flight.airline : defaultAirline);
      const flightNumber = assignment ? assignment.flight.number : null;
      const mustChangePwd = !assignment;

      const existing = await pool.query(
        `SELECT staff_id, username FROM staff WHERE firstname = $1 AND lastname = $2 AND role = $3`,
        [s.firstName, s.lastName, s.role]
      );
      if (existing.rowCount > 0) {
        staffSkipped++;
        credentialsReport.push({
          name: `${s.firstName} ${s.lastName}`, role: s.role, airline: airlineCode,
          gate: assignment ? assignment.gate : '-',
          username: existing.rows[0].username, password: '(unchanged)', mustChangePwd: '(unchanged)',
        });
        continue;
      }

      const username = genUsername(s.lastName, takenUsernames);
      takenUsernames.add(username);
      const password = genPassword();

      await pool.query(
        `INSERT INTO login (username, password_hash, must_change_pwd) VALUES ($1, $2, $3)`,
        [username, bcrypt.hashSync(password, 10), mustChangePwd]
      );
      await pool.query(
        `INSERT INTO staff (airline_code, flight_number, username, firstname, lastname, email, phone, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [airlineCode, flightNumber, username, s.firstName, s.lastName, STAFF_EMAIL, s.phone || null, s.role]
      );
      staffCreated++;
      credentialsReport.push({
        name: `${s.firstName} ${s.lastName}`, role: s.role, airline: airlineCode,
        gate: assignment ? assignment.gate : '-',
        username, password, mustChangePwd: String(mustChangePwd),
      });
    }
    console.log(`      ${staffCreated} created, ${staffSkipped} already existed`);

    console.log('\nCredentials report (capture this on first run!):\n');
    const header = `${'Name'.padEnd(22)} ${'Role'.padEnd(14)} ${'Airline'.padEnd(8)} ${'Gate'.padEnd(5)} ${'Username'.padEnd(15)} ${'Password'.padEnd(12)} mustChangePwd`;
    console.log(header);
    console.log('-'.repeat(header.length));
    credentialsReport.forEach(r => {
      console.log(`${r.name.padEnd(22)} ${r.role.padEnd(14)} ${r.airline.padEnd(8)} ${(r.gate||'-').padEnd(5)} ${r.username.padEnd(15)} ${r.password.padEnd(12)} ${r.mustChangePwd}`);
    });
    console.log(`\nadmin / ${ADMIN_PASSWORD}\n`);
    console.log('Done.');
  } catch (err) {
    console.error('FAIL:', err.code || '', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
