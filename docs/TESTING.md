# Testing Guide

This document explains how to run the test suites, what each suite covers, and common debugging tips.

## Quick Start

```bash
# Backend (from /backend)
npm run test        # Full suite (~8 min, 223 tests)
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit

# Frontend (from /frontend)
npm run test        # Full suite (~12 s, 29 tests)
npm run lint
npm run typecheck
npm run build       # Vite production build
```

## Backend Test Structure

```
backend/tests/
├── helpers/
│   ├── auth.ts        # createTestUser, createTestStudent
│   ├── db.ts          # createTestPool, truncateAll
│   └── fixtures.ts    # mkExam, mkRoom, mkStudents
├── engine/engine.test.ts              # 27 tests (Phase 6)
├── auth.test.ts                       # 15 tests (Phase 3)
├── import.test.ts                     # 14 tests (Phase 4 student import)
├── students.test.ts                   # CRUD + pagination
├── classrooms.test.ts                 # CRUD + bench generation
├── classrooms-import.test.ts          # 10 tests (Phase 10 classroom import)
├── exams.test.ts                      # CRUD + preview stats
├── seating.test.ts                    # 18 tests (Phase 7 generate/publish/history)
├── exports.test.ts                    # 18 tests (Phase 10 exports + 5k perf)
├── dypit-roll.test.ts                 # 15 tests (DYPIT roll parsing + ranges)
├── dypit-curriculum.test.ts           # 25 tests (SPPU curriculum parsers, real CSVs)
├── dypit-intents.test.ts              # 31 tests (allocation intent API + validation)
├── dypit-generation.test.ts           # 17 tests (generate from intents)
├── engine/strict-roll-order.test.ts   # 12 tests (strict roll ordering)
└── db-constraints.test.ts             # Trigger/immutability tests
```

### Running a Single Test File

```bash
# From /backend
npx vitest run tests/engine/engine.test.ts
npx vitest run tests/exports.test.ts -t "performance"
```

### Test Configuration (vitest.config.ts)

```ts
export default defineConfig({
  test: {
    fileParallelism: false,   // serial (DB truncates between files)
    testTimeout: 20_000,      // default
    hookTimeout: 120_000,     // for truncate/seed
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
```

### Timeouts

| Test | Timeout | Reason |
|------|---------|--------|
| Default | 20 s | API/integration |
| Perf export (5k students) | 90 s | Overridden in test |
| Bulk classroom import (500) | 60 s | Overridden in test |

## Frontend Test Structure

```
frontend/src/
├── lib/*.test.ts            # utils, compare
├── features/auth/RequireAuth.test.tsx
├── pages/LoginPage.test.tsx
└── (no component tests yet; Playwright smoke optional)
```

```bash
# From /frontend
npx vitest run src/pages/admin/AllocationBuilderPage.test.tsx
```

## Database Fixtures (tests/helpers/)

- **`createTestPool(max = 5)`**: pg Pool to `exam_seating_test` (docker superuser `seating`)
- **`truncateAll(pool)`**: `TRUNCATE ... CASCADE` between files; resets sequences
- **`createTestUser(pool, {role, password, email, studentId?})`**: creates user + hash
- **`mkExam(name)`**: creates exam with current date + time
- **`mkRoom(number, benches)`**: classroom + seats (capacity trigger disabled for speed)
- **`mkStudents(dept, count)`**: creates students + optional logins

## Common Debugging

### Slow Fixtures (Docker disk I/O)

- **Seat capacity trigger** (`trg_refresh_classroom_capacity`): `FOR EACH ROW` recounts all seats in room. Bulk 5k inserts ≈ 18–24 s.
  - **Fix**: `ALTER TABLE seats DISABLE TRIGGER trg_refresh_classroom_capacity` (owner-level, works in CI).
  - See `exports.test.ts` perf test for pattern.

- **Allocation immutability trigger** (`trg_allocations_published_immutable`): blocks writes when parent run is PUBLISHED.
  - For fixtures: create run as `VALIDATED`, insert allocations, then `UPDATE ... SET status='PUBLISHED'`.

- **FK overhead** (7 FKs on `seating_allocations`): ~2.8 ms/row in Docker.
  - **Opt**: `SET LOCAL session_replication_role = replica` inside fixture transaction (requires superuser — CI uses `postgres` superuser).
  - See `exports.test.ts` perf test: saved ~11 s for 5k allocations.

### Inspect Test DB

```bash
# From host
docker exec -i exam-seating-db psql -U seating -d exam_seating_test
```

### Psql Variables

```sql
-- Inside psql heredoc
SELECT id AS rid FROM seating_runs WHERE seed = 'perf-export' \gset
INSERT ... WHERE r.id = :'rid';
```

### DYPIT: proving a CHECK constraint really fires

A `CHECK` constraint only rejects an explicit `FALSE`. An expression like
`(a IS NULL AND b IS NULL) OR (a >= 1 AND b >= 1)` evaluates to `NULL` when only
one side is set, so a half-specified grid would silently pass. The seat-grid
constraint therefore uses `CASE` to force a real boolean. Verify such constraints
with a PL/pgSQL harness that asserts BLOCKED vs ACCEPTED per case (see the
11-case pattern used during the DYPIT migration).

### Trigger Names

```sql
trg_refresh_classroom_capacity        -- on seats (FOR EACH ROW)
trg_allocations_published_immutable   -- on seating_allocations (BEFORE INSERT/UPDATE/DELETE)
trg_runs_published_immutable          -- on seating_runs (BEFORE UPDATE/DELETE)
```

## Coverage Summary

| Area | Tests | Key Assertions |
|------|-------|----------------|
| Engine (pure) | 27 | feasibility, greedy, local search, validate, edge cases |
| Auth | 15 | login, refresh, logout, RBAC, rate limit |
| Students CRUD | 11 | pagination, search, soft delete |
| Student Import | 14 | dry-run, duplicates, unknown dept/year, 500-row |
| Classrooms CRUD | 12 | bench gen, enable/disable, delete guard |
| Classroom Import | 10 | dry-run, bad rows, 422 all-or-nothing, 500-row |
| Exams | 13 | preview stats, clash detection, registration |
| Seating Generate | 18 | 422 on failure, FAILED run, history, regen |
| Publish/Unpublish | 8 | stale block, re-validate, history |
| Exports | 18 | formats, watermark, 5k perf (csv<15s, xlsx<30s) |
| DYPIT rolls | 15 | roll parsing, numeric ranges past serial 99, overlap |
| DYPIT curriculum | 25 | intake 1,170, per-branch subjects, FE group swap |
| DYPIT intents | 31 | create/update/delete, EMPTY_RANGE, ROOM_TOO_SMALL, RANGE_OVERLAP, BENCH_OVERLAP, auto bench offset |
| DYPIT generation | 17 | seats exactly the range, seatOffset, grid, strict order, reproducible seed, atomic failure |
| Strict roll order | 12 | ascending roll order, numeric past 99, deterministic, skips search |
| DB Constraints | 6 | immutability triggers, partial unique index |

**Total: 20 files, 311 backend tests + 5 files, 34 frontend tests.**

## DYPIT Fixtures

`tests/dypit-*.test.ts` build their own world: an academic year, the `AIDS`/`CE`
departments, rooms with generated benches, and cohorts of students whose roll
numbers follow `SE-AIDS-C_07`. They do **not** depend on `npm run seed:dypit`.

The curriculum tests read the real spreadsheets from `backend/seed-data/`, so a
corrupted source file fails the suite rather than silently changing behaviour.

## Adding a Test

1. Create `backend/tests/<module>.test.ts`
2. Import `createTestPool`, `truncateAll`, `createTestUser` from helpers
3. Use `beforeAll` for pool + truncate + app + tokens; `afterAll` for pool.end + disconnectPrisma
4. Follow existing patterns for `api.get/post/put/delete` and `binaryGet` for file downloads
5. Run with `npx vitest run tests/<module>.test.ts`

## CI Notes

- GitHub Actions uses `postgres:16-alpine` service (superuser `postgres`).
- `session_replication_role = replica` works in CI because the service user is superuser.
- `ALTER TABLE ... DISABLE TRIGGER` works because test user owns the tables.
- Tests run serially (`fileParallelism: false`) to avoid DB contention.
- Total CI time ~12 min (backend 8 min, frontend 2 min, install/overhead).