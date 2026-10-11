# JobConnect Backend

This repository contains the backend API for JobConnect, a learning project that shows students how to build a role-based job marketplace with Node.js, Express, JWT authentication, bcrypt password hashing, MariaDB/MySQL, and Multer file uploads.

The frontend lives in a separate repository named `jobconnect-frontend`.

## What This Backend Teaches

- How to structure an Express project with routes, controllers, middleware, and config files.
- How JWT authentication works in a real API.
- How role-based access control protects admin, employer, and job seeker routes.
- How to use bcrypt so plain text passwords are never stored.
- How to query MariaDB/MySQL with `mysql2/promise`.
- How to upload CV files with Multer.
- How to enforce ownership, for example employers can edit only their own jobs.

## Folder Structure

```text
jobconnect-backend/
  config/
    db.js                  # MySQL connection pool
  controllers/             # Request handlers and database logic
  middleware/              # Auth, role checks, and upload handling
  routes/                  # URL definitions that call controllers
  uploads/                 # CV files are stored here
  database/
    schema.sql             # Tables and relationships
    seed.sql               # Sample learning data
  server.js                # Express app entry point
  package.json
  .env.example
```

## Request Flow

1. A browser sends a request to an endpoint such as `POST /api/jobs`.
2. The route in `routes/jobRoutes.js` decides which middleware and controller should run.
3. `protect` in `middleware/authMiddleware.js` verifies the JWT and loads `req.user`.
4. `authorize` in `middleware/roleMiddleware.js` checks the user's role.
5. The controller validates input, runs SQL queries, and returns JSON.

## Requirements

- Node.js 20.19+ or 22.12+ (the frontend's Vite 8 requires it; the backend alone needs 18+). Tests were run on Node 24.19 with npm 11.
- MariaDB 10.2+ or MySQL 8.0.16+. The new features were verified on **MariaDB 11.4.5 only**; MySQL has not been tested.
- npm

## Setup

Install dependencies:

```bash
npm install
```

Create your environment file:

```bash
cp .env.example .env
```

Update `.env` for your machine (`DB_PASSWORD` and `DB_PORT` must match your database server; `.env` is git-ignored and must never be committed):

```env
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=jobconnect
DB_PORT=3306
JWT_SECRET=replace_this_with_a_long_random_secret
JWT_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:5173
```

CORS: the API accepts requests from `http://localhost:5173` and `http://127.0.0.1:5173` by default. To allow other origins set `FRONTEND_URLS=http://a.example,http://b.example` (comma separated).

Create and seed the database:

```bash
mysql -u root -p < database/schema.sql
mysql -u root -p < database/seed.sql
```

Start the backend:

```bash
npm run dev
```

The API runs at:

```text
http://localhost:5000
```

Health check:

```text
GET http://localhost:5000/api/health
```

## Default Seed Accounts

Use these accounts after loading `database/seed.sql`:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@jobconnect.com` | `password123` |
| Employer | `employer1@jobconnect.com` | `password123` |
| Employer | `employer2@jobconnect.com` | `password123` |
| Job Seeker | `seeker1@jobconnect.com` | `password123` |
| Job Seeker | `seeker2@jobconnect.com` | `password123` |

## Main Endpoints

Auth:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

Profiles:

- `GET /api/profile`
- `PUT /api/profile/employer`
- `PUT /api/profile/job-seeker`

Jobs:

- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/employer/my-jobs`
- `POST /api/jobs`
- `PUT /api/jobs/:id`
- `DELETE /api/jobs/:id`

Applications:

- `POST /api/applications/apply/:jobId`
- `GET /api/applications/my-applications`
- `GET /api/applications/job/:jobId`
- `PUT /api/applications/:id/status`

Admin:

- `GET /api/admin/stats`
- `GET /api/admin/users`
- `GET /api/admin/jobs`
- `GET /api/admin/applications`
- `PUT /api/admin/users/:id/status`

## New Features (assignment extension)

Three features were added on top of the original app. The original `schema.sql` and `seed.sql` are unchanged.

1. **Smart Job Alerts** (job seeker) - saved alerts (max 10) and an explainable match score.
2. **Interview Scheduler** - employers propose 1-3 slots for a shortlisted applicant; the candidate confirms or declines.
3. **Candidate Scorecards** (employer-only) - 1-5 ratings, recommendation, private notes, overall computed in SQL.

### Database setup for the new features

Run these AFTER `schema.sql` and `seed.sql`. Both are safe to re-run.

```bash
npm run migrate          # creates job_alerts, interviews, interview_slots, scorecards
npm run seed:features    # sample alerts, an interview, scorecards, extra applicants
```

`npm run` uses the credentials in `.env` (no `mysql` command needed). Equivalent with the CLI:

```bash
mysql -u root -p jobconnect < database/migrations/001_new_features.sql
mysql -u root -p jobconnect < database/seed_features.sql
```

If your database is not called `jobconnect`, set `DB_NAME` in `.env`; the npm scripts honour it.
Requires MariaDB 10.2+ or MySQL 8.0.16+ (generated columns and CHECK constraints).

### New endpoints

All need `Authorization: Bearer <token>`. Errors: 400 validation, 401 no/invalid token, 403 wrong role or not the owner, 404 not found, 409 conflict.

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /api/alerts` | job seeker | My alerts with live match counts |
| `POST /api/alerts` | job seeker | Create (max 10, else 409) |
| `PUT /api/alerts/:id` | owner | Edit |
| `PATCH /api/alerts/:id/status` | owner | Pause or resume `{ "is_active": false }` |
| `DELETE /api/alerts/:id` | owner | Delete |
| `GET /api/alerts/:id/matches` | owner | Jobs ranked by match score, at or above the alert's minimum |
| `GET /api/alerts/match/jobs/:jobId` | job seeker | Score and matched/missing skills for one job |
| `GET /api/alerts/match/recommendations` | job seeker | Top open jobs for my profile (excludes jobs I applied to) |
| `POST /api/interviews` | employer (owner of the job) | Propose interview + 1-3 slots; applicant must be Shortlisted |
| `GET /api/interviews[?job_id=]` | seeker (own), employer (own jobs), admin (all) | List with slots |
| `POST /api/interviews/:id/confirm` | invited candidate | `{ "slot_id": 5 }` |
| `POST /api/interviews/:id/decline` | invited candidate | `{ "reason": "..." }` (required) |
| `POST /api/interviews/:id/cancel` | employer (owner) | Cancel a Proposed or Confirmed interview |
| `GET /api/scorecards/application/:id` | employer (owner), admin | One scorecard or `null` |
| `PUT /api/scorecards/application/:id` | employer (owner) only | Create or update (upsert) |
| `GET /api/scorecards/job/:jobId[?rank=1]` | employer (owner), admin | All scorecards for a job, optionally best first |

Job seekers always get 403 on `/api/scorecards/*`; admins are read-only there.

### How the match score works

`score = round(70% x skills coverage + 30% x location fit)` (see `services/matchScore.js`).

- The job's `requirements` text is split into requirements (commas, new lines, "and").
- A requirement counts as covered only if MORE than half of its meaningful words (filler such as "experience" or "strong" removed, plurals and Node.js/NodeJS normalised) appear in the seeker's profile skills.
- Location: remote job = 100, same city = 100, same country = 50, otherwise 0.
- Only open jobs are scored. Matches are computed live on every request; nothing is stored.

### Tests

```bash
npm test                    # unit tests (no database needed)
npm run test:integration    # live API + database; starts its own server on a free port
```

The integration tests use the seed accounts, create their own jobs/applications and delete them afterwards. Run them only against your local learning database. Set `API_URL=http://localhost:5000` to test a server you already started.

## Student Exercises

- Add validation for stronger passwords during registration.
- Add pagination to job browsing.
- Add an endpoint for admins to create another admin account.
- Store uploaded CVs in cloud storage instead of local disk.
- Add automated API tests for auth and job ownership rules.

## Useful Checks

```bash
node --check server.js
npm audit --omit=dev
```
