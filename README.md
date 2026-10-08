# College Exam Seating Management System

A complete, working exam seating management web application: real database, backend, frontend,
authentication, and a **constraint-aware seating allocation engine** that reshuffles students
across papers (minimising repeated rooms/seats/benches/neighbours) while enforcing hard
constraints at both the engine and database level.

> **Status:** built phase by phase per `EXAM_SEATING_BUILD_GUIDE.md` (Sections 0–7 are the
> permanent spec). All 12 phases complete. See `docs/` and the Master Completion Checklist in the guide.

## Features

- Role-based access: `SUPER_ADMIN`, `EXAM_ADMIN`, `STUDENT` (JWT + refresh cookie)
- Master data: academic years, departments, students (CSV/Excel import), classrooms/benches
- Exams with eligibility rules, auto-registration and time-slot clash detection
- Seating generation: seeded greedy + swap-based local search, history-aware penalties,
  MIXED/BLOCK department modes, structured failure reasons — never a silent invalid plan
- Draft → Validated → Published lifecycle, stale-plan detection, immutable published plans
- Admin dashboard, classroom seat-map visualization, student portal, PDF/CSV/XLSX exports
- Docker Compose one-command setup

## Quick start

```bash
cp .env.example .env            # adjust secrets for anything beyond local dev
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend (Vite dev server) | http://localhost:5173 |
| Backend API | http://localhost:3001/api/v1 |
| Health check | http://localhost:3001/api/v1/health |
| PostgreSQL | localhost:5432 |

### Database migrations (from `backend/`)

```bash
npx prisma migrate deploy   # apply all committed migrations to DATABASE_URL (backend/.env)
npx prisma migrate status   # show applied/pending migrations
```

Schema docs: [`database/ER_DIAGRAM.md`](database/ER_DIAGRAM.md) · [`database/SCHEMA.md`](database/SCHEMA.md).
The test suite provisions its own database (`exam_seating_test`) and runs the same
`prisma migrate deploy` automatically on startup.

### Seed / first super admin (from `backend/`)

```bash
npm run seed                # idempotent: creates SUPER_ADMIN from SUPER_ADMIN_* env vars
npm run seed:demo           # creates full demo dataset (610 students, 15 rooms, 4 exams, 20 demo accounts)
npm run seed:demo-history   # generates & publishes Paper 1 + Paper 2 for demo (requires running backend)
```

Set `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` (min 8 chars) and `SUPER_ADMIN_NAME` in
`backend/.env` (see `.env.example`). Re-running never duplicates or overwrites the account.

### Demo credentials (after `seed:demo`)

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@demo.local` | `Demo123!` |
| Exam Admin | `examadmin@demo.local` | `Demo123!` |
| Student | `<roll>@student.demo` (e.g. `24cse001@student.demo`) | `Demo123!` |

Admins land on `/admin`, students on `/portal`. Access token: 15 min JWT (in memory);
refresh token: 7-day httpOnly cookie scoped to `/api/v1/auth`, rotated on every refresh and
revoked by logout/password change. Failed logins are rate-limited per identifier and every
login/failure is recorded in `audit_logs`.

## Repository structure

```
├── AGENTS.md              # permanent AI-agent rules (Section 1 of the guide)
├── EXAM_SEATING_BUILD_GUIDE.md
├── docker-compose.yml
├── .env.example
├── backend/               # Node 20 + Express + TypeScript API
│   ├── prisma/            # schema + migrations (Phase 2+)
│   ├── src/
│   │   ├── config/        # env validation (Zod)
│   │   ├── common/        # errors, logger, middleware
│   │   ├── db/            # pg pool
│   │   ├── modules/       # feature modules (health, auth, seating, ...)
│   │   ├── engine/        # PURE seating engine (Phase 6) — no DB/HTTP imports
│   │   ├── app.ts  server.ts
│   └── scripts/           # demo-seed.ts, demo-history.ts
├── frontend/              # React 18 + Vite + TS + Tailwind
│   └── src/ app/ pages/ components/ api/ hooks/ lib/
├── database/              # ER diagram + schema docs (Phase 2+)
├── docs/                  # ARCHITECTURE, ALGORITHM, API, DEPLOYMENT, ASSUMPTIONS, TESTING
└── .github/workflows/     # CI (GitHub Actions)
```

## Development commands

```bash
# Backend (from backend/)
npm install
npm run dev            # API on :3001
npm run typecheck
npm run lint
npm run test           # unit + API + DB constraint tests (needs `docker compose up -d db`)

# Frontend (from frontend/)
npm install
npm run dev            # UI on :5173, /api proxied to :3001
npm run typecheck
npm run lint
npm run test
npm run build
```

## Environment variables

All variables are documented in [`.env.example`](.env.example) (`DATABASE_URL`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `PORT`, `CORS_ORIGIN`,
`SEATING_TIME_BUDGET_MS`, …). Never commit `.env`.

## Documentation

| Document | Content |
|---|---|
| `docs/ARCHITECTURE.md` | Stack rationale, diagrams, module map, sync-vs-realtime decision |
| `docs/ALGORITHM.md` | Seating algorithm, scoring, complexity, demo output (Phase 6) |
| `docs/API.md` + OpenAPI | Endpoint reference (Phase 12) |
| `docs/ASSUMPTIONS.md` | Every assumption made during the build |
| `docs/TESTING.md` | How to run each test suite (Phase 11) |
| `docs/DEPLOYMENT.md` | Production deployment guide (Phase 12) |
| `docs/KNOWN_LIMITATIONS.md` | Known issues and trade-offs (Phase 12) |
| `database/ER_DIAGRAM.md` | Mermaid ER diagram (Phase 2) |

## CI / GitHub Actions

```yaml
# .github/workflows/ci.yml runs on every push/PR
- Backend: lint → typecheck → prisma migrate deploy → test (postgres service)
- Frontend: lint → typecheck → test → build
```

## Known limitations

See `docs/KNOWN_LIMITATIONS.md` for trade-offs (capacity trigger performance, worker threading fallback, etc.).
