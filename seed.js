// Run with: node seed.js
// Seeds test data: 3 staff members, 1 flight, 1 passenger
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, randomUUID } = require('./db');

const TEST_PASSWORD = 'Test1234';
const hash = bcrypt.hashSync(TEST_PASSWORD, 10);

// Seed staff
const seedStaff = [
  { id: randomUUID(), username: 'airline01', password: hash, firstName: 'Alice', lastName: 'Johnson', email: 'alice@test.com', phone: '1234567890', staffType: 'airline_staff', airlineCode: 'AA' },
  { id: randomUUID(), username: 'gate01', password: hash, firstName: 'Bob', lastName: 'Smith', email: 'bob@test.com', phone: '2345678901', staffType: 'gate_staff', airlineCode: 'AA' },
  { id: randomUUID(), username: 'ground01', password: hash, firstName: 'Carol', lastName: 'Williams', email: 'carol@test.com', phone: '3456789012', staffType: 'ground_staff', airlineCode: null },
];

for (const s of seedStaff) {
  db.prepare('DELETE FROM staff WHERE username = ?').run(s.username);
  db.prepare(`
    INSERT INTO staff (id, username, password, first_name, last_name, email, phone, airline_code, staff_type, requires_password_change)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(s.id, s.username, s.password, s.firstName, s.lastName, s.email, s.phone, s.airlineCode, s.staffType);
}

// Seed flight
const flightId = 'test-flight-001';
db.prepare('DELETE FROM flights WHERE id = ?').run(flightId);
db.prepare(`
  INSERT INTO flights (id, airline_name, airline_code, flight_number, destination, terminal, gate)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(flightId, 'American Airlines', 'AA', '1234', 'Los Angeles (LAX)', 'T1', 'A1');

// Seed passenger
const passengerId = 'test-passenger-001';
db.prepare('DELETE FROM passengers WHERE id = ?').run(passengerId);
db.prepare(`
  INSERT INTO passengers (id, first_name, last_name, identification, ticket_number, flight_id, status)
  VALUES (?, ?, ?, ?, ?, ?, 'not_checked_in')
`).run(passengerId, 'Dave', 'Passenger', '123456', '1234567890', flightId);

console.log('\nTest data seeded successfully!\n');
console.log('Login credentials:');
console.log('  Admin:        admin / Admin123');
console.log('  Airline Staff: airline01 / Test1234');
console.log('  Gate Staff:   gate01 / Test1234');
console.log('  Ground Staff: ground01 / Test1234');
console.log('  Passenger:    ID=123456, Ticket=1234567890');
