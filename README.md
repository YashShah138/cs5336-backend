# cs5336-backend

Express + Supabase Postgres backend for the airport luggage tracking system. Provides a JSON HTTP API consumed by [cs5336-project](https://github.com/YashShah138/cs5336-project) (the React frontend).

Authentication is handled in-house with bcrypt-hashed passwords stored in Supabase plus locally-signed JWTs — Supabase Auth is **not** used.

## Tech stack

- Node.js 18+ (tested on 24)
- Express 4
- `pg` (PostgreSQL driver) → Supabase Postgres
- `bcryptjs` for password hashing
- `jsonwebtoken` for session tokens
- `cors`, `dotenv`

## Prerequisites

- Node.js 18 or newer
- A Supabase project that already contains the `airline`, `flight`, `passenger`, `bag`, `staff`, `login`, `bag_location_history`, and `flight_gate_history` tables. This backend does **not** create those — they belong to the schema your group designed in Supabase. The seed script will create one missing table (`issue`) and add a few columns to `message`, but everything else is assumed to exist.
- The `Test Data.xlsx` file from the course materials (drop it next to the repo or in `~/Downloads/`).

## Setup

### 1. Install dependencies

```sh
cd cs5336-backend
npm install
```

### 2. Create `.env`

`.env` is gitignored — create it locally with these four variables. Do not commit it.

```
PORT=3001
FRONTEND_URL=http://localhost:5173
JWT_SECRET=<a long random string — generate with `openssl rand -hex 32`>
DATABASE_URL=<your Supabase Postgres connection string — see below>
```

#### Where to get `DATABASE_URL`

In your Supabase dashboard:

1. Click the green **Connect** button at the top of the project page (or *Project Settings → Database*).
2. Pick the **Session pooler** tab. **Do not use the Transaction pooler** — that one is for serverless and won't work correctly with a long-running Express process.
3. Choose the **URI** format. Copy the whole string. It looks like:

   ```
   postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```

4. Replace `[YOUR-PASSWORD]` with your **database password** — the one you set when you created the Supabase project, *not* your Supabase login password. If you've lost it, reset it in *Project Settings → Database → Reset database password*.

### 3. Apply schema additions and load the test data

```sh
npm run seed
```

This is **idempotent** — safe to run any number of times. It:

1. Creates the `issue` table (`CREATE TABLE IF NOT EXISTS`).
2. Adds `board_type`, `message_type`, `sender_name`, `content`, and `metadata` columns to `message` (`ADD COLUMN IF NOT EXISTS`); makes `message.airline_code` nullable.
3. Ensures the `admin` login exists (`admin / Admin123`).
4. Reads `Test Data.xlsx` (looked up at `../Test Data.xlsx` relative to this folder, then `~/Downloads/Test Data.xlsx`).
5. Updates passenger statuses to match the spreadsheet.
6. Inserts the 43 bags from the spreadsheet (skip-if-exists).
7. Creates the 28 real staff (9 airline + 9 gate + 10 ground) with auto-generated `lastname + 2-digit` usernames and random passwords. The 9 staff named in the *Test Data – Additional Instructions* PDF are assigned to their gates and marked as having logged in (`must_change_pwd = false`).

**Capture the credentials list** the script prints on first run — re-runs skip already-existing staff, so passwords don't churn but the plaintext is only echoed once. You'll need it for the final demo.

The seed script does **not** create any data outside the official xlsx test data (per the PDF's "no additional data" rule).

#### Pointing seed at a different xlsx

By default the script looks for `Test Data.xlsx` first at the parent of this directory (i.e., dropped next to `cs5336-backend/`), then at `~/Downloads/Test Data.xlsx`. To use a different path, set `XLSX_PATH=/full/path/Test\ Data.xlsx` when running.

#### Using a different staff email

By default every staff member gets `will.o.subs@gmail.com` (the project owner's email — the PDF requires using a real address you can receive mail at). Override per run with `STAFF_EMAIL=you@example.com npm run seed`.

### 4. Start the server

```sh
npm run dev   # auto-restarts on file change (uses node --watch)
# or
npm start
```

Listens at `http://localhost:3001`. Health check: `GET /api/health` returns `{"status":"ok"}`.

## Test credentials

| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `Admin123` |
| Airline / Gate / Ground staff | (auto-generated) | (auto-generated) |

After `npm run seed` runs for the first time, the script prints a table of all 28 staff members with their assigned usernames and plaintext passwords. **Save that table** — passwords are randomly generated per the course requirements and aren't stored anywhere outside the bcrypt'd `login` table. Re-runs of `npm run seed` skip already-existing staff so passwords stay stable, but they're only printed in plaintext on the run that creates them.

The 9 staff members named in the *Test Data – Additional Instructions* PDF are seeded as already-logged-in (`must_change_pwd = false`) and assigned to their gates. The other 19 are seeded with `must_change_pwd = true` and will be prompted to change their password on first login.

For passenger logins, use any of the 120 seeded passengers — pick any `(identification, ticket_number)` pair via the Supabase dashboard's Table Editor or `GET /api/passengers` as admin.

## API surface

All endpoints are mounted under `/api`. Auth tokens travel as `Authorization: Bearer <jwt>`. All field names in responses are **camelCase** (the backend translates from Supabase's snake_case). Synthetic IDs:

- `flight.id` = `"<airlineCode>-<flightNumber>"`, e.g. `"AA-1175"`
- `passenger.id` = `ticket_number`
- `bag.id` = `bag_id`
- `staff.id` = integer `staff_id`

### Auth (`/api/auth`)

| Method | Path | Body | Auth | Returns |
|---|---|---|---|---|
| `POST` | `/login` | `{role, username?, password?, identification?, ticketNumber?}` | none | `{token, user}` |
| `GET` | `/me` | — | required | `user` |
| `POST` | `/change-password` | `{currentPassword, newPassword}` | required (not passenger) | `{success: true}` |

Roles: `administrator`, `airline_staff`, `gate_staff`, `ground_staff`, `passenger`. Passenger logins use `(identification, ticketNumber)` — passengers have no password. New-password regex: ≥6 chars with at least one uppercase, one lowercase, and one digit.

### Flights (`/api/flights`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | any | All flights |
| `GET` | `/:id` | any | `:id` is `"AA-1175"` |
| `POST` | `/` | administrator | `{airlineCode, flightNumber, destination?, terminal, gate}` |
| `DELETE` | `/:id` | administrator | 409 if passengers/bags/staff reference the flight |
| `PATCH` | `/:id/gate` | administrator, gate_staff, airline_staff | `{terminal, gate}`. Logged to `flight_gate_history` for staff users. |

### Passengers (`/api/passengers`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | any | `?flightId=AA-1175` filters |
| `GET` | `/:id` | any | `:id` is the ticket number |
| `POST` | `/` | administrator, airline_staff | `{firstName, lastName, identification, ticketNumber, flightId}` |
| `DELETE` | `/:id` | administrator | 409 if the passenger has bags |
| `PATCH` | `/:id/status` | administrator, airline_staff, gate_staff | `{status}` ∈ `{not_checked_in, checked_in, boarded, removed}` |

### Bags (`/api/bags`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | any | `?passengerId=...&flightId=...&location=...` |
| `GET` | `/:id` | any | Returns `locationHistory[]` populated from `bag_location_history` |
| `POST` | `/` | administrator, airline_staff | `{bagId, passengerId, flightId, terminal?, counterNumber?}` |
| `DELETE` | `/:id` | administrator, airline_staff | Cascade-deletes location history rows |
| `PATCH` | `/:id/location` | any staff role | `{location, gateNumber?}` where `location` ∈ `{check_in, security, security_violation, gate, loaded}`. Inserts a `bag_location_history` row when the caller is a staff user. |

`updatedBy` in `locationHistory[]` resolves the staff name (`firstname || ' ' || lastname`) when available, falling back to the integer `staff_id` if the staff member has been deleted.

### Staff (`/api/staff`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | administrator | `?staffType=...` filters |
| `POST` | `/` | administrator | `{firstName, lastName, email, phone?, staffType, airlineCode?}`. `airlineCode` defaults to the first available airline when `staffType === 'ground_staff'` (because `staff.airline_code` is `NOT NULL`). Returns `{...staff, generatedCredentials: {username, password}}` — a random password is generated and bcrypt'd; the plaintext is returned **once** so the admin can hand it off (the frontend opens a `mailto:` link). |
| `DELETE` | `/:id` | administrator | Also deletes the matching `login` row |

### Messages (`/api/messages`)

Board-style communication between roles. Each message belongs to a `board_type` (`airline`, `gate`, `ground`, `admin`). Stored in the existing Supabase `message` table plus the columns added by `npm run seed`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | any | `?boardType=...` filters |
| `POST` | `/` | any staff | `{boardType, content, senderName?, senderRole?, airlineCode?, messageType?, bagId?, passengerId?, passengerName?, flightInfo?, flightId?}`. The loose context fields (`bagId`, `passengerId`, etc.) are stored in a `metadata jsonb` column. |

Passengers cannot post messages. The 500-character limit is enforced server-side.

### Issues (`/api/issues`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | administrator | Most-recent first |
| `POST` | `/` | any | `{type, description?, reportedBy?, bagId?, passengerId?, flightId?}` |

The `issue` table is created by `npm run seed`; it's specific to this backend.

## Project layout

```
cs5336-backend/
├── server.js                # Express bootstrap + route mounting
├── db.js                    # pg Pool, ID encode/decode helpers, status normalizer
├── middleware/auth.js       # JWT verify + role authorization
├── routes/
│   ├── auth.js              # /login, /me, /change-password
│   ├── flights.js
│   ├── passengers.js
│   ├── bags.js
│   ├── staff.js
│   ├── messages.js
│   └── issues.js
├── seed.js                  # one-shot setup: schema additions + admin + load xlsx
├── package.json
└── .env                     # gitignored — never commit
```

## How auth works

The backend signs its own JWTs using `JWT_SECRET` (24-hour expiry). It does NOT use Supabase Auth. The `login` table holds bcrypt-hashed credentials; `staff.username` foreign-keys into `login`.

**Admin users have a `login` row but no `staff` row** — that absence is what marks them as administrators. This is intentional, since `staff.airline_code` is `NOT NULL` and an admin doesn't conceptually belong to one airline.

JWT payloads:
- Admin: `{role: "administrator", username: "admin"}`
- Staff: `{role, username, staffId, airlineCode}`
- Passenger: `{role: "passenger", ticketNumber, identification}`

The frontend stores the token in `sessionStorage` (tab-isolated) and sends it as a `Bearer` header.

## Things to know / current limitations

In the spirit of being honest about what works and what doesn't:

- **Status values aren't normalized at rest.** Existing seeded data uses values like `Checked-In`. The backend lowercases and underscore-normalizes statuses on read, so the frontend always sees `checked_in`. New writes use the underscore form. A direct `SELECT status FROM passenger` will show mixed case.
- **`gate_staff` and `ground_staff` are pinned to a single airline** in the `staff` table because `staff.airline_code` is `NOT NULL`. The seed assigns all three test staff members to `AA`. Conceptually gate/ground staff are not airline-scoped, and the airline_staff side of the frontend filters by airline — so `gate01` will only see AA flights in "My Flights". A clean fix would require a `staff.airline_code` nullable migration, which we have not made.
- **`PATCH /flights/:id/gate` only writes `flight_gate_history` when called by staff.** Admins lack a `staffId` (no `staff` row), and the audit table requires one (`changed_by integer NOT NULL`). Admin-driven gate changes succeed but leave no history row.
- **`bag.counter_gate` is a single column** that serves both the check-in counter (set on creation) and the destination gate (set when ground staff clears security). The frontend reads `counterNumber` and `gateNumber` from the same underlying column — they will overwrite each other across stages.
- **No rate limiting, no brute-force protection, no HTTPS** — class-project quality. Don't deploy as-is.
- **Generated staff credentials go via `mailto:`** in the frontend — the plaintext password is in the URL the admin's mail client opens. This is in the user's browser history. Acceptable for class demos, not for production.
- **Token expiry is silent.** After 24 hours the user is redirected to `/login` mid-action with no toast. The frontend's `api.js` handles 401 by clearing the token and navigating.
- **Race conditions on the frontend side.** Several frontend mutations don't `await` their promises, so the UI may briefly show stale state before the 30-second auto-refresh corrects it. See the frontend README for details.

## Development notes

- `npm run dev` uses `node --watch` to restart on file changes.
- The Supabase **Session pooler** is correct for long-running Express servers. Don't use the Transaction pooler — it doesn't support all PostgreSQL features and will break under load.
- The `pg` Pool is created at module load and held for the process lifetime.
- All routes are async; errors propagate through `try/catch` blocks that return a generic `{error: "Internal error"}` 500. Stack traces go to `console.error` for the backend operator only.
