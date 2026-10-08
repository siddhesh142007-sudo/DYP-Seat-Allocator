# College Exam Seating Management System: 

## 0. Goal

Build a **complete, working, production-quality College Exam Seating Management Web Application** (real database, backend, frontend, authentication, working seating allocation algorithm). Not an architecture document, not pseudocode, not a mockup. Everything must run locally with `docker compose up` and a few documented commands.

The **seating allocation engine is the most important component**. It must be a constraint-aware allocation system, not a random number generator.

---

## 1. Global Rules for the AI Agent (apply to EVERY phase)

1. Build **incrementally**, phase by phase. After each phase, run the app/tests and confirm it is consistent with earlier phases. Do not rewrite working components unnecessarily.
2. **Never fake it.** No placeholder functions, no `TODO` stubs in finished phases, no hard-coded demo responses. Every endpoint reads and writes the real database.
3. After finishing a phase, **run the commands** (build, lint, typecheck, tests, migrations) and show the results. Fix failures before declaring the phase done.
4. At the end of every phase, print: (a) files created/changed, (b) commands to run it, (c) the acceptance checklist with pass/fail.
5. **Never silently create an invalid seating plan.** Any failure must be reported with a clear structured reason.
6. Keep the seating engine **pure and isolated** (no DB, no HTTP, no framework imports) so it can be improved or swapped later.
7. Use TypeScript everywhere with `strict: true`. Validate all input with Zod. Never trust the client.
8. Never commit secrets. Use `.env` + `.env.example`.
9. Keep documentation in `docs/` up to date as you go (do not leave it all for the end).
10. If a requirement is ambiguous, choose the most reasonable option, state the assumption in `docs/ASSUMPTIONS.md`, and continue. Ask me only if it is truly blocking.

---

## 2. Technology Stack (decided, do not re-debate)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **React 18 + Vite + TypeScript**, Tailwind CSS, shadcn/ui-style components, React Router, TanStack Query, Recharts | Fast dev, easy to maintain, very well documented, no SSR complexity needed for an internal admin tool |
| Backend | **Node.js 20 + Express + TypeScript**, modular folders | Same language as frontend, simple, widely known by students, easy to deploy |
| Database | **PostgreSQL 16** | Strong integrity (FKs, CHECK, partial unique indexes, triggers, transactions), scales well |
| ORM / migrations | **Prisma** (plus raw SQL migrations for triggers and CHECK constraints) | Typed queries, clean migrations |
| Auth | JWT (access token, short-lived) + refresh token in httpOnly cookie, **bcrypt/argon2** hashing, RBAC middleware | Standard and secure |
| Validation | **Zod** | Shared schemas, runtime safety |
| Import/Export | `csv-parse`, `exceljs` (Excel), `pdfkit` or `pdf-lib` (PDF) | Pure JS, no external binaries |
| Testing | **Vitest** (unit and engine), **Supertest** (API), **Playwright** (a few UI smoke tests, optional) | Fast, one toolchain |
| Infra | **Docker + docker-compose** (postgres, backend, frontend) | One-command setup |
| Logging | `pino` | Structured logs |

Include a short comparison table in `docs/ARCHITECTURE.md` explaining why alternatives (Next.js, NestJS, FastAPI/Django, Spring Boot, MySQL) were not chosen for this project.

### Target repo structure

```
exam-seating-system/
├── AGENTS.md
├── README.md
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── package.json  tsconfig.json  Dockerfile
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/            (includes custom SQL for triggers/checks)
│   │   └── seed.ts
│   └── src/
│       ├── app.ts  server.ts  config/
│       ├── common/                (errors, logger, middleware, zod helpers)
│       ├── modules/
│       │   ├── auth/  users/  students/  departments/  academic-years/
│       │   ├── classrooms/  exams/  registrations/
│       │   ├── seating/           (service, controller, routes, repository)
│       │   ├── history/  validation/  exports/  imports/  audit/  dashboard/
│       └── engine/                (PURE seating engine, no DB/HTTP imports)
│           ├── types.ts  prng.ts  scoring.ts  history.ts
│           ├── feasibility.ts  allocate.ts  improve.ts  validate.ts  index.ts
│           └── worker.ts          (worker_threads wrapper)
├── frontend/
│   └── src/ (app, pages, components, features, api, hooks, lib)
├── database/                      (ER diagram, schema docs, SQL notes)
├── docs/                          (ARCHITECTURE, ALGORITHM, API, DEPLOYMENT, ASSUMPTIONS, TESTING)
└── tests/                         (engine, api, e2e)  -- may live inside backend/ if cleaner
```

---

## 3. Domain Specification

### 3.1 Seating model (critical)
- **One bench = one seat = ONE student.** Never two students on a bench.
- Each classroom has a configurable number of benches. Each bench is a row in `seats`.
- `capacity` of a room = number of **available** seats. Individual seats can be disabled (broken bench) and a whole room can be marked unavailable.

### 3.2 Academic years, departments, divisions
- Academic years are **data, not constants** (default seed: 1st to 4th Year; admin can add/remove).
- Departments are data (seed: CSE, AI/DS, ECE, Mechanical, plus a couple more for other years).
- A student belongs to: Academic Year + Department + Division (optional).
- **One exam = one academic year.** Only students of that year (and active, registered) are eligible. Never mix years in one exam. (Leave a clearly marked extension point for multi-year exams in the future, but do not implement it.)

### 3.3 Exams
Fields: subject, paper code, academic year, semester (optional), exam date, start time, end time, status.
Exam seating status flow: `NOT_GENERATED → DRAFT → VALIDATED → PUBLISHED` (plus `FAILED` recorded on the generation attempt, not on the exam).
- Two exams scheduled in an overlapping time slot must not be allowed to use the same room if they are different years (warn or block; document the choice). Rooms already used by another exam at the same date/time slot are excluded from the available pool.

### 3.4 Eligibility
- Student status = ACTIVE, belongs to exam's academic year, has an exam registration with status REGISTERED (or auto-registered by default when the exam is created, with admin ability to mark ABSENT/WITHHELD/REMOVED).
- Students added after generation or removed after generation must be **detected** (stale-plan warning), never silently ignored (see Phase 7).

### 3.5 Hard constraints (never violated, enforced in engine AND DB)
1. One student occupies exactly one seat.
2. One seat holds at most one student.
3. Every eligible student gets exactly one seat, or generation fails entirely.
4. Only eligible students are assigned.
5. Room capacity / available benches never exceeded.
6. Only the exam's academic year is allocated.
7. No duplicate student, no duplicate seat (DB unique constraints `(exam_id, student_id)` and `(exam_id, seat_id)`).
8. Published arrangements are **immutable** (DB trigger plus service-level guard) unless a Super Admin explicitly unpublishes/regenerates with a recorded reason (audit log).
9. Unavailable rooms/seats are never used.

### 3.6 Soft constraints (optimized by penalty scoring)
1. Avoid same room as the previous paper(s).
2. Avoid same seat (room + bench) as previous paper(s).
3. Avoid same bench number even in a different room (predictable pattern).
4. Avoid having the same neighbours (left/right bench) as in the previous paper.
5. Department distribution rule (configurable per exam/college, see 3.7).
6. Balanced classroom utilization (do not fill one room to 100% and another to 20% unless needed).
7. Avoid predictable patterns (e.g. sequential roll numbers on consecutive benches).
8. History decay: older papers matter less than the most recent one.

### 3.7 Department distribution modes (configurable)
- `MIXED` (default): students from different departments are interleaved. Soft rule: avoid the **same department on adjacent benches**.
- `BLOCK`: each department is kept together in as few rooms as possible (rooms are shuffled between papers), and a department may spill across multiple rooms when it does not fit in one. Within a room, students are shuffled.
- Also support an optional per-room `max_per_department` cap or `min_departments_per_room` as a soft rule.
- Never assume a department fits in one room.

### 3.8 Allocation failure reporting (never silent)
Return a structured failure, e.g.:

```
Allocation Failed
428 students require seats. Only 400 seats are currently available.
Additional seats required: 28.
```

Failure codes (at minimum): `INSUFFICIENT_SEATS`, `NO_ELIGIBLE_STUDENTS`, `NO_AVAILABLE_ROOMS`, `ROOM_CONFLICT_WITH_OTHER_EXAM`, `DEPARTMENT_RULE_IMPOSSIBLE` (e.g. block mode where a rule cannot be met), `PUBLISHED_IMMUTABLE`, `STALE_PLAN`, `VALIDATION_FAILED`. Each failure contains `code`, `message`, `details` (numbers), `suggestion`.

---

## 4. Seating Algorithm Specification (the core)

### 4.1 Pipeline

```
Eligible students
  → Available rooms/seats (minus disabled seats, minus rooms used by clashing exams)
  → Read seating history (previous N papers for the same academic year/students)
  → Feasibility pre-check (counts, rules) → fail early with structured reason
  → Build candidate arrangement (seeded randomized constraint-aware greedy)
  → Improve with local search (swap-based, time-boxed)
  → Run validation engine (hard constraints, must be VALID)
  → Save in ONE DB transaction (all or nothing)
  → Admin review (preview / regenerate)
  → Publish (immutable)
```

### 4.2 Approaches to compare (write this in `docs/ALGORITHM.md`)
| Approach | Idea | Time | Verdict |
|---|---|---|---|
| A. Pure random shuffle + validate/retry | Shuffle students, fill seats, retry until valid | O(N) per try | Trivially satisfies hard constraints but ignores history. Soft quality is poor and unpredictable. Rejected as the main method (kept only as baseline in tests). |
| B. Optimal assignment (Hungarian / min-cost flow) | Cost matrix student × seat | O(N³) | Optimal for the pairwise cost but too slow for 5,000+ students (about 1.25×10¹¹ ops, O(N²) memory), and cannot model neighbour-based soft constraints. Rejected for scale. |
| C. **Seeded randomized constraint-aware greedy + swap-based local search (selected)** | Build a feasible plan in near-linear time using penalties, then improve by swapping pairs while the total penalty drops | Construction O(N log N), improvement O(K) swaps with O(1) delta each | **Selected.** Always feasible, handles neighbour/department rules, scales to 5,000+ students, time-boxed, reproducible by seed. |

### 4.3 Selected algorithm (Approach C), detailed
1. **PRNG**: seeded (e.g. mulberry32 or xoshiro). Store the seed with the generation record for reproducibility and debugging. Use Fisher-Yates for shuffles (never `sort(() => Math.random()-0.5)`).
2. **Room ordering**: shuffle rooms with a bias: rooms that a department/student group used in the previous paper are pushed later; ties broken randomly. In `BLOCK` mode assign each department a contiguous run of rooms/seats; in `MIXED` mode distribute students across all selected rooms proportionally (balanced utilization).
3. **Room selection**: choose the smallest sufficient set of rooms (plus a configurable slack), preferring rooms with lower recent usage, so utilization is balanced and no more rooms than necessary are used.
4. **Greedy construction**: for each student (in shuffled order, hardest-first: students with the most history-constrained options first), choose among a sampled candidate set of free seats (e.g. up to K=16 random free seats plus any seat favoured by room distribution) the seat with the lowest penalty; ties broken randomly. This keeps it near O(N·K).
5. **Local search (improvement)**: repeat for a time/iteration budget (e.g. max 2 s or 20·N iterations): pick two random assigned students (or one student and a free seat), compute the **delta penalty** of swapping in O(1) using precomputed history lookups (hash maps keyed by `studentId → {roomId, seatId, benchNo, neighbourIds}` per previous paper); accept if the delta is negative (optionally accept slightly worse moves with decreasing probability, simulated-annealing style). Hard constraints are preserved by construction because swaps only exchange seats among already valid assignments.
6. **Validate** with the independent validation engine. If INVALID, fail the whole generation (never save).
7. **Result** includes: assignments, total penalty, penalty breakdown by rule, per-student "repeated seat/room" counts, seed, timing, stats (`sameSeatAsPrev`, `sameRoomAsPrev`, `sameBenchNoAsPrev`, `sameNeighbourAsPrev`, `sameDeptAdjacent`).

### 4.4 Penalty scoring (justify in docs, make weights configurable in a `ScoringConfig`)
For each student, for each previous paper `p` back in time (distance `d = 1` is the latest), weight `decay(d) = 0.5^(d-1)`:

| Event | Base penalty | Reason |
|---|---|---|
| Same seat (same room AND same bench) as paper p | **100** | Most predictable, defeats the purpose of reshuffling |
| Same room as paper p (different seat) | **30** | Medium: the student knows the room, can plan |
| Same bench number in a different room | **10** | Detectable pattern (always "bench 17") |
| Same left or right neighbour as paper p | **20** per neighbour | Prevents seating clusters from persisting |
| Same department on an adjacent bench (MIXED mode) | **15** | Distribution rule |
| Room utilization imbalance | **λ · variance(fill%)** | Soft balance |
| Sequential roll numbers on consecutive benches | **5** | Predictable pattern |
| New room + new seat + new neighbours | **0** | Ideal |

Total penalty = Σ over students and previous papers of `decay(d) × event penalty` + global terms. Lower is better. The scoring function must be a pure, unit-tested module with documented weights. Penalties are **soft**: if no zero-penalty arrangement exists (e.g. only one room available), the engine takes the minimum-penalty arrangement and **reports** the repeats, instead of failing.

### 4.5 Complexity (document and prove in `docs/ALGORITHM.md`)
- N = students, S = seats, R = rooms, K = candidate sample size, I = local search iterations, H = history papers considered.
- Feasibility check: O(N + S). Room ordering: O(R log R). History index build: O(H·N) time, O(H·N) space.
- Greedy construction: O(N·K·H) time with O(1) penalty lookups.
- Local search: O(I·H), each delta is O(H).
- Validation: O(N + S).
- Space: O(N + S + H·N).
- Target: 5,000 students / 100+ rooms / H=3 completes in a few seconds on a laptop; benchmark it in tests and record the numbers in the docs.

### 4.6 Demonstration (required deliverable, see Phase 6)
Small example: **3 departments, 3 rooms, 20 benches per room, 60 students, 3 papers.** A script `npm run demo:algorithm` must print Paper 1, Paper 2, Paper 3 allocations as readable tables, then show per-paper stats: how many students repeated a room/seat/bench number/neighbour compared to previous papers, and how history influenced the choices. The demo must also appear (formatted) in `docs/ALGORITHM.md`.

---

## 5. Database Design Requirements

Tables (PostgreSQL, snake_case): `users`, `roles` (or enum), `academic_years`, `departments`, `students`, `classrooms`, `seats`, `exams`, `exam_registrations`, `seating_runs`, `seating_allocations`, `audit_logs`, `settings`.

Key rules:
- `students`: unique `roll_number`; FK to academic_year and department; `status` enum (ACTIVE, INACTIVE, ...); optional `division`, `email`; linked 1:1 to a `users` row for student login.
- `classrooms`: unique `room_number` (+ optional building/floor), `status` (AVAILABLE/UNAVAILABLE), `capacity` derived/validated from seats.
- `seats`: `(classroom_id, bench_number)` unique; `status` (AVAILABLE/DISABLED); optional `row_no`/`col_no` for the visual layout.
- `exams`: FK academic_year; `CHECK (end_time > start_time)`; status; seating status; optional semester.
- `exam_registrations`: `(exam_id, student_id)` unique; status (REGISTERED, ABSENT, WITHHELD, REMOVED).
- `seating_runs`: one row per generation attempt (id, exam_id, seed, status DRAFT/VALIDATED/PUBLISHED/FAILED/SUPERSEDED, algorithm_version, config JSON, total_penalty, stats JSON, validation_report JSON, failure JSON, generated_by, generated_at, published_by, published_at).
- `seating_allocations`: `(run_id, exam_id, student_id, classroom_id, seat_id, generated_at, published_at)`; `UNIQUE (run_id, student_id)`, `UNIQUE (run_id, seat_id)`; FKs everywhere; also denormalized `academic_year_id`, `department_id` for history queries and exports. Only **one active run per exam** (partial unique index).
- **Immutability**: a DB trigger that rejects UPDATE/DELETE on `seating_allocations`/`seating_runs` rows whose run is PUBLISHED, except through a controlled "unpublish" function used only by Super Admin flow.
- **Seat-belongs-to-room integrity**: composite FK or trigger ensuring `seat_id` belongs to `classroom_id`.
- Indexes: students (year, dept, status), seats (classroom), allocations (student_id), (exam_id), (classroom_id), registrations (exam_id), audit (created_at, entity).
- Provide `database/ER_DIAGRAM.md` with a **Mermaid ER diagram** and an explanation of every relationship.

---

## 6. API Surface (REST, prefix `/api/v1`, all JSON, consistent error format `{error:{code,message,details}}`)

Auth: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`
Users (Super Admin): `GET/POST /users`, `PUT /users/:id`, `DELETE /users/:id`
Academic years: `GET/POST /academic-years`, `PUT/DELETE /academic-years/:id`
Departments: `GET/POST /departments`, `PUT/DELETE /departments/:id`
Students: `GET /students` (search, filter year/dept/division/status, pagination, sort), `POST`, `PUT /:id`, `DELETE /:id` (soft deactivate), `POST /students/import` (CSV/XLSX, dry-run + commit), `GET /students/import/template`, `GET /students/:id/seating`
Classrooms: `GET/POST /classrooms`, `PUT/DELETE /classrooms/:id`, `POST /classrooms/:id/seats/generate` (create N benches), `PATCH /classrooms/:id/seats/:seatId` (enable/disable)
Exams: `GET/POST /exams`, `GET/PUT/DELETE /exams/:id`, `GET /exams/:id/eligible-students`, `GET /exams/:id/seating-preview-stats` (eligible, available seats, rooms required, departments, conflicts), `GET/POST/PATCH /exams/:id/registrations`
Seating:
- `POST /exams/:id/generate-seating` (body: options such as mode, seed optional, roomIds optional, historyDepth)
- `POST /exams/:id/regenerate-seating` (replaces the DRAFT/VALIDATED run; for PUBLISHED requires Super Admin + `reason` + confirmation flag)
- `GET /exams/:id/seating` (run info, stats, validation report, allocations with filters)
- `GET /exams/:id/seating/classroom/:classroomId`
- `GET /exams/:id/seating/validate` (re-run validation on the stored plan, detects stale plans)
- `POST /exams/:id/publish`, `POST /exams/:id/unpublish` (Super Admin, reason required)
- `GET /exams/:id/seating/history` (all runs for the exam)
- `GET /students/:id/seating-history`
Exports: `GET /exams/:id/export/classroom/:classroomId?format=pdf|csv|xlsx`, `/export/department/:deptId`, `/export/student-list`, `/export/full`, `GET /exams/:id/slip/:studentId?format=pdf`, `GET /exams/:id/slips?format=pdf` (all slips)
Student portal: `GET /me/seating` (published seatings for the logged-in student: subject, date, time, room, bench)
Dashboard: `GET /dashboard/summary`, `GET /dashboard/charts`
Audit: `GET /audit-logs` (Super Admin)
Health: `GET /health`

RBAC: **SUPER_ADMIN** (everything, users, unpublish), **EXAM_ADMIN** (students, classrooms, exams, generate/regenerate/publish), **STUDENT** (only `/auth/*` and `/me/*`, own seating, read-only).

---

## 7. Real-time / Background Processing Decision (document in `docs/ARCHITECTURE.md`)

- Use a standard **synchronous HTTP request/response** for generation. The engine runs in a **`worker_threads` worker** so the Express event loop is never blocked, with a hard time budget (e.g. 10 s default, configurable).
- Do **not** add WebSockets or SSE. They are unnecessary for a single-admin, seconds-long operation.
- Keep the service interface job-ready (`runGeneration(examId, options) → result`) so a queue (BullMQ) with polling could be added later if allocations grow to tens of thousands of students. Document this as a future option only.
- The frontend shows a loading state with elapsed time and a cancel-safe UI.

---

# PHASE PROMPTS

Paste or say **"Run Phase N"**. Each block below is the instruction OpenCode must follow for that phase.

---

## Phase 1: Project Setup

```text
Run Phase 1 of EXAM_SEATING_BUILD_GUIDE.md.

1. Create the monorepo structure from Section 2 (backend/, frontend/, database/, docs/, tests/).
2. Backend: initialize Node 20 + TypeScript (strict) + Express, with folders from Section 2. Add eslint, prettier, vitest, supertest, zod, pino, dotenv, helmet, cors, express-rate-limit, cookie-parser. Provide scripts: dev, build, start, test, lint, typecheck.
3. Frontend: Vite + React 18 + TypeScript + Tailwind CSS + React Router + TanStack Query + Recharts + lucide-react. Set up a basic layout shell (sidebar + topbar) with placeholder routes ONLY for navigation structure.
4. docker-compose.yml with postgres:16 (volume, healthcheck), backend, frontend. Dockerfiles for backend and frontend.
5. .env.example documenting every variable (DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, PORT, CORS_ORIGIN, SEATING_TIME_BUDGET_MS, etc.).
6. Backend: GET /api/v1/health that checks the DB connection. Central error handler producing {error:{code,message,details}}. Request-id + pino logging.
7. Write docs/ARCHITECTURE.md (stack comparison and rationale, architecture diagram in Mermaid, module list, the sync-vs-realtime decision from Section 7) and README.md skeleton. Also create AGENTS.md containing Section 1 (Global Rules) of this guide.
8. Run install, typecheck, lint, test, and docker compose build. Report results.

Acceptance: `docker compose up` starts postgres + backend + frontend; /api/v1/health returns ok with DB status; frontend loads the shell; lint/typecheck/tests pass.
```

---

## Phase 2: Database and Models

```text
Run Phase 2 of EXAM_SEATING_BUILD_GUIDE.md.

Implement the complete relational schema from Section 5 using Prisma (schema.prisma) plus custom raw SQL migration(s) for things Prisma cannot express:
- CHECK constraints (end_time > start_time, bench_number > 0, capacity >= 0, enum-like checks)
- Partial unique index: only one active (non-SUPERSEDED, non-FAILED) seating run per exam
- Trigger: seat must belong to the allocation's classroom
- Trigger: immutability of PUBLISHED runs/allocations (reject UPDATE/DELETE), with a controlled bypass used only by the unpublish procedure (e.g. a session variable set inside a transaction by a dedicated SQL function)
- UNIQUE (run_id, student_id) and UNIQUE (run_id, seat_id) on seating_allocations
- All required FKs (with sensible ON DELETE behaviour: RESTRICT for history-bearing rows), and all indexes listed in Section 5.

Also:
- Create database/ER_DIAGRAM.md with a Mermaid erDiagram and a written explanation of every relationship, key and constraint.
- Create database/SCHEMA.md describing each table/column.
- Write migration tests (vitest + a real test database) that PROVE the constraints work: inserting a duplicate seat in a run fails, duplicate student fails, seat from another room fails, updating a published allocation fails, end_time <= start_time fails.
- Run migrations from scratch on an empty DB and report.

Acceptance: `npx prisma migrate deploy` works on an empty database; constraint tests all pass; ER diagram documented.
```

---

## Phase 3: Authentication and Authorization

```text
Run Phase 3 of EXAM_SEATING_BUILD_GUIDE.md.

Implement the auth module:
- Users with roles SUPER_ADMIN, EXAM_ADMIN, STUDENT. Passwords hashed with argon2 or bcrypt (cost >= 12). Never log or return hashes.
- POST /auth/login (email or roll number + password), /auth/refresh (refresh token in httpOnly, SameSite cookie, rotation), /auth/logout, /auth/me, /auth/change-password.
- JWT access token (short TTL). Rate-limit login attempts; lock/slow down after repeated failures.
- Middleware: authenticate, requireRole(...roles), and a resource-level check for students (a student can only access their own data).
- Zod validation on all inputs. Generic error messages for failed login (no user enumeration).
- Audit log module: record login, failed login, and every future sensitive action via a reusable auditLog(actor, action, entity, entityId, metadata) helper. Table: audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata JSONB, ip, created_at).
- A bootstrap/seed that creates the first Super Admin from env variables.
- Frontend: Login page (accessible form, error and loading states), auth context, protected routes, role-based redirect (admins to /admin, students to /portal), automatic token refresh, logout.
- Tests (supertest): login success/failure, protected route without token = 401, student calling an admin route = 403, refresh rotation, rate limiting.

Acceptance: all auth tests pass; admin and student can log in via the UI and land on different shells; unauthenticated access to protected routes is blocked.
```

---

## Phase 4: Student, Department, Academic Year and Classroom Management

```text
Run Phase 4 of EXAM_SEATING_BUILD_GUIDE.md.

Backend modules + frontend pages for:
1. Academic years (CRUD, configurable, not hard-coded) and Departments (CRUD; cannot delete if students reference them, deactivate instead).
2. Students: CRUD, soft-deactivate, search (name/roll/email), filters (year, department, division, status), pagination and sorting, create the linked student login user (default password policy documented, force change on first login).
3. Student CSV/Excel import: template download, upload, **dry-run validation report** (row-level errors: duplicates, unknown department/year, missing fields) then commit in one transaction; clear summary (created / updated / skipped / errors).
4. Classrooms: CRUD with room number, building, floor, status. "Generate benches" tool creates N seats (bench_number 1..N) with optional rows/cols layout for visualization. Enable/disable individual seats. Capacity is computed from available seats. A room cannot be deleted if it has seating history (mark unavailable instead).
5. Frontend: sleek data tables with search/filter/sort/pagination, forms with validation and accessible labels, confirmation dialogs for destructive actions, toast notifications, loading skeletons, empty states, error states. Responsive for desktop/tablet/mobile.
6. All mutations write audit logs. RBAC: only SUPER_ADMIN/EXAM_ADMIN.
7. Tests for each module (happy path + validation + permissions + import edge cases).

Acceptance: I can manage years, departments, students (including import of a 500-row CSV) and classrooms/benches from the UI; invalid imports are reported row by row without partial commits.
```

---

## Phase 5: Exam Management and Registration

```text
Run Phase 5 of EXAM_SEATING_BUILD_GUIDE.md.

1. Exams CRUD (subject, paper code, academic year, semester optional, date, start, end, status). Validate end > start. Prevent edits that would invalidate a PUBLISHED seating (block with a clear message).
2. Exam registrations: when an exam is created, auto-register all ACTIVE students of that academic year (configurable), with endpoints to mark individual students ABSENT/WITHHELD/REMOVED or re-add them. Student added or removed after creation must be reflected correctly and flagged if a seating plan already exists (stale-plan detection flag on the exam).
3. GET /exams/:id/eligible-students (paginated, filters) and GET /exams/:id/seating-preview-stats returning: eligibleCount, availableSeats, classroomsRequired (minimum rooms needed, computed by greedy largest-first), departments breakdown (counts per department), roomsBlockedByOtherExams, and a list of detected conflicts (insufficient seats, no rooms, clashing exam slot).
4. Detect time-slot clashes: two exams overlapping in date/time cannot share the same room; the room pool for an exam excludes rooms used by clashing exams that already have a seating plan.
5. Frontend: Exams list (filters, status badges), create/edit exam form, exam detail page showing eligible students, registration management, and the preview stats cards.
6. Tests, including: exam of year 2 never includes year 1/3/4 students; inactive and absent students excluded; clash detection.

Acceptance: creating a 2nd-year exam shows the exact eligible count and available seats; changing student status updates the eligible count.
```

---

## Phase 6: Seating Allocation Engine (MOST IMPORTANT)

```text
Run Phase 6 of EXAM_SEATING_BUILD_GUIDE.md. Read Section 3 and Section 4 again before coding. This is the heart of the project; take your time and be rigorous.

Implement backend/src/engine/ as a PURE TypeScript module (no DB, no Express, no Prisma imports):
- types.ts: EngineInput { students[{id, rollNo, departmentId, divisionId?}], rooms[{id, seats[{id, benchNo, row?, col?}]}], history[{examId, order, assignments[{studentId, roomId, seatId, benchNo}]}], config {mode: 'MIXED'|'BLOCK', seed, timeBudgetMs, historyDepth, weights, maxPerDepartment?} }, EngineResult (success: assignments, penalty, breakdown, stats, seed, timing | failure: structured failure per Section 3.8).
- prng.ts: seeded PRNG (mulberry32/xoshiro) + Fisher-Yates shuffle helpers. No Math.random inside the engine.
- feasibility.ts: pre-checks with exact numbers and the failure codes in Section 3.8 (INSUFFICIENT_SEATS with "Additional seats required: X", NO_ELIGIBLE_STUDENTS, NO_AVAILABLE_ROOMS, DEPARTMENT_RULE_IMPOSSIBLE, ...).
- history.ts: builds O(1) lookup indexes from history: studentId -> list of {roomId, seatId, benchNo, leftNeighbourId, rightNeighbourId} per previous paper, with decay weights 0.5^(d-1).
- scoring.ts: the penalty model from Section 4.4 as a pure, configurable function with incremental delta computation for swaps. Weights documented in code and docs.
- allocate.ts: seeded randomized constraint-aware greedy construction as specified in 4.3 (room ordering biased away from previously used rooms, smallest sufficient room set, balanced utilization, MIXED vs BLOCK modes, department spill across multiple rooms, K-candidate sampling).
- improve.ts: time-boxed swap-based local search with O(1) delta evaluation; never breaks hard constraints.
- validate.ts: INDEPENDENT validation engine (does not reuse allocation internals) returning a structured report: students, assigned, unassigned, seatsUsed, duplicateSeats, duplicateStudents, capacityViolations, ineligibleIncluded, unavailableSeatUsed, roomPerSeatMismatch, historyConsidered (bool + depth), status VALID/INVALID, list of violations. Matches the example in the spec.
- worker.ts: wraps the engine in worker_threads so the HTTP server stays responsive; includes timeout handling.
- index.ts: generateSeating(input) = feasibility -> allocate -> improve -> validate -> result. If validation is INVALID, return a VALIDATION_FAILED failure and NEVER a plan.

Also build:
- scripts/demo-algorithm.ts (npm run demo:algorithm): 3 departments, 3 rooms, 20 benches per room, 60 students (20 each), 3 papers. Print each paper as readable room/bench tables. After Paper 2 and Paper 3, print comparison stats vs previous papers (same seat count, same room count, same bench-number count, same-neighbour count, same-department-adjacent count) and a plain-English explanation of how history influenced the allocation (e.g. "Student S07 was in Room 2 bench 5; this paper the engine penalised room 2 and bench 5 and placed them in Room 3 bench 14").
- docs/ALGORITHM.md containing: problem statement, comparison of approaches A/B/C (Section 4.2), why C was selected, pseudocode, scoring table with justification, time/space complexity and scalability, the demo output for the 60-student example, and benchmark numbers.
- Benchmarks: generate 10, 100, 1,000, 5,000 (and 10,000 as a stretch) students with 100+ rooms and report runtime and penalties.

Engine unit tests (vitest), all must pass:
- Hard constraints on every run: no duplicate students, no duplicate seats, capacity respected, all eligible assigned, only eligible assigned, unavailable seats unused.
- Sizes: 10, 100, 1,000, 5,000 students.
- Edge cases: insufficient seats (exact message and number), exactly enough seats, excess seats, unequal department sizes, one department, multiple departments, a department larger than any single room, a single room only, zero students, zero rooms.
- Determinism: same seed + same input = identical output; different seed = different output.
- History: with 3 consecutive papers, the second paper's same-seat count is significantly lower than random baseline (assert a statistical threshold against Approach A baseline), and the third paper avoids repeats against BOTH previous papers where feasible.
- If avoiding repeats is mathematically impossible (e.g. exactly 1 room with exactly N seats), the engine still succeeds with minimum penalty and REPORTS the unavoidable repeats rather than failing.
- Property-based/fuzz test (e.g. 200 random small inputs) validating hard constraints always hold.

Acceptance: `npm run test -- engine` passes; `npm run demo:algorithm` prints the 3-paper demonstration with clearly different arrangements; 5,000 students / 100+ rooms completes within the configured time budget; docs/ALGORITHM.md complete.
```

---

## Phase 7: Seating Service, Validation Integration, Draft/Validate/Publish Workflow

```text
Run Phase 7 of EXAM_SEATING_BUILD_GUIDE.md.

Connect the pure engine to the application (backend/src/modules/seating, history, validation):
1. Service flow for POST /exams/:id/generate-seating:
   authorize (EXAM_ADMIN+) -> load exam, eligible registered students, available rooms/seats (excluding rooms used by clashing exams), previous seating history for the same students (historyDepth default 3, from PUBLISHED runs primarily, and latest VALIDATED draft optionally) -> call the engine in the worker -> on failure store a FAILED seating_run (with structured failure) and return 422 with the structured failure -> on success open ONE DB TRANSACTION: mark previous DRAFT/VALIDATED run SUPERSEDED, insert the run + all allocations in bulk, store validation report/stats/seed, status VALIDATED -> commit. If anything throws, roll back; never save a partial plan.
2. Re-validate from the database after saving (read back, run the validation engine on stored data) and store the report.
3. regenerate-seating: new seed, new run, previous run SUPERSEDED. For PUBLISHED exams, only SUPER_ADMIN with `reason` + `confirm: true`; this unpublishes (audit logged) and creates a new draft.
4. publish: allowed only from VALIDATED, re-validates first, stamps published_at on run and allocations, locks the plan (DB triggers enforce immutability). unpublish: SUPER_ADMIN only, with reason, audit logged.
5. Stale-plan detection: GET /exams/:id/seating/validate recompares current eligible students against the stored plan and reports students added after generation (no seat), students removed/inactive but still holding seats, rooms/seats disabled since generation. Publishing a stale plan is blocked with a clear message and a suggestion to regenerate.
6. Concurrency: prevent two simultaneous generations for the same exam (advisory lock or row lock) -> 409.
7. Seating history endpoints: all runs for an exam, student seating history across exams.
8. All actions audit logged (generate, regenerate, publish, unpublish, failures).
9. API integration tests (supertest + real DB): success path, insufficient seats (422 with the exact "428 vs 400, additional seats required 28" style message), exact fit, publish flow, immutability (edit after publish rejected at API and DB level), regenerate blocked for EXAM_ADMIN on published, super-admin override with reason, student added after generation detected, student removed detected, unavailable room excluded, transaction rollback on injected failure (no partial rows), concurrent generate returns 409, 3 consecutive papers show history is read (assert repeats are lower than baseline).

Acceptance: the full Draft -> Validated -> Published lifecycle works via API; failures never leave partial data; all tests pass.
```

---

## Phase 8: Admin Dashboard and Seating UI

```text
Run Phase 8 of EXAM_SEATING_BUILD_GUIDE.md. Use a polished, modern admin look (not a tutorial look): consistent design tokens, good typography, a collapsible sidebar, breadcrumbs, dark/light mode if time permits. Read the frontend-design guidance if available.

1. Dashboard (/admin): cards for Total Students, Total Departments, Total Classrooms, Available Seats, Upcoming Exams, Generated Seating Plans, Allocation Conflicts; charts (students per department, seats vs students per upcoming exam, plans by status); upcoming exams table with status badges. Backed by /dashboard/summary and /dashboard/charts.
2. Seating Generation page (/admin/exams/:id/seating):
   - Select Exam (and show its Academic Year/Paper)
   - Preview stats panel: Eligible Students, Available Seats, Classrooms Required, Departments, conflicts (red alert block with the exact message and "Additional seats required: X" when impossible; the Generate button is disabled or shows the failure when infeasible)
   - Options: distribution mode (MIXED/BLOCK), history depth, optional seed, room selection
   - [Generate Seating] with a loading state (elapsed timer), then the result panel: Allocation Successful, All students assigned, No duplicate seats, Capacity constraints satisfied (driven by the real validation report, never hard-coded ticks), plus penalty stats (repeated seats/rooms vs previous paper).
   - Buttons: Preview, Regenerate (confirmation dialog), Publish (confirmation dialog, disabled unless VALIDATED and not stale), Unpublish (Super Admin, reason required).
   - Show the structured validation report and the run history list (seed, time, status, penalty).
3. Seating Visualization page: classroom selector, classroom-wise table (Bench, Roll No, Student, Department) with search, roll-number search, department filter, sort, pagination; PLUS a visual bench grid layout of the room (color-coded by department, empty/disabled benches shown, hover/tap shows student); legend; print-friendly style.
4. Comparison view: pick two papers and show how a student's/room's seating changed (nice-to-have showing history influence).
5. Responsive (desktop/tablet/mobile), accessible (keyboard, aria labels, contrast), loading/empty/error states, toast notifications, confirmation dialogs.

Acceptance: from the UI I can run the whole flow: pick exam -> see preview stats -> generate -> view room tables and the visual layout -> regenerate -> publish; failures display a clear red explanation.
```

---

## Phase 9: Student Portal

```text
Run Phase 9 of EXAM_SEATING_BUILD_GUIDE.md.

1. Student login lands on /portal (mobile-first design).
2. GET /me/seating returns ONLY PUBLISHED seatings for the logged-in student (never drafts). UI shows upcoming exams as cards: Subject, Paper code, Date (e.g. 10 September 2026), Time (10:00 AM), Room number (+ building/floor), Bench number, with a clear "Room: 103 / Bench: 17" highlight. Past exams in a separate collapsed section. Empty state when nothing is published.
3. Student can download their own seating slip (PDF).
4. Students are strictly read-only: attempts to call any modification endpoint, or to read another student's seating, return 403 (test it).
5. Tests: student sees only own published seat; draft plans invisible; cannot access admin routes; cannot access another student's data.

Acceptance: a seeded student sees their exact room/bench after the admin publishes, and nothing before.
```

---

## Phase 10: Import / Export

```text
Run Phase 10 of EXAM_SEATING_BUILD_GUIDE.md.

Imports are done for students in Phase 4; extend if needed (Excel .xlsx and CSV both supported, with template download). Also add optional import for classrooms+benches via CSV.

Exports (backend/src/modules/exports, all authorized, audit logged):
- Classroom-wise seating list (PDF, CSV, XLSX): room header, exam, date/time, table of Bench / Roll No / Name / Department, invigilator signature columns on PDF.
- Department-wise list (PDF/CSV/XLSX).
- Student-wise list (sorted by roll number: Roll No, Name, Room, Bench).
- Complete seating plan (all rooms; PDF with a page per room + cover summary page; XLSX with one sheet per room).
- Student seating slip (PDF, one student) and bulk slips (PDF with multiple slips per page, e.g. 6 per A4) for printing and cutting.
- Only PUBLISHED plans can be exported by default; admins can export DRAFT/VALIDATED with a visible "DRAFT, NOT FOR DISTRIBUTION" watermark.
Frontend: export menu/buttons on the seating pages with format selection and download progress.
Tests: file generation returns correct content-type, correct row counts, and sizes for 5,000-student exports succeed within reasonable time and memory (stream where possible).

Acceptance: I can download all five export types in PDF and CSV/XLSX where applicable; the slip PDF looks professional.
```

---

## Phase 11: Seed Data, Testing and Quality

```text
Run Phase 11 of EXAM_SEATING_BUILD_GUIDE.md.

1. Seed script (prisma/seed.ts, `npm run seed`) with realistic demo data:
   - Academic years: 1st to 4th.
   - 2nd Year: CSE 120, AI/DS 100, ECE 80, Mechanical 70 = 370 students with realistic Indian names, roll numbers like 24CSE001 / 24AIDS001 / 24ECE001 / 24MECH001, divisions, emails.
   - Smaller sets for other years (e.g. 60-100 each) with their own departments.
   - Classrooms: at least 15 rooms (e.g. 101..115, mix of 25/30/40/50 benches), a couple unavailable, a few disabled benches, buildings/floors.
   - Users: 1 Super Admin, 1 Exam Admin, student logins for all students (documented demo credentials, only in dev).
   - At least 3 exams for the 2nd Year (Data Structures, DBMS, Operating Systems) on different dates, plus a 3rd Year exam in an overlapping slot to demonstrate clash handling.
   - A script `npm run seed:demo-history` that auto-generates and publishes Paper 1 and Paper 2 so the UI shows real history and Paper 3 can be generated live to demonstrate reshuffling.
2. Complete the test suites and make sure these categories exist and pass:
   - Engine: all items from Phase 6 plus 5,000-student benchmark.
   - API/integration: everything from Phases 3 to 10.
   - Required edge cases: insufficient seats, exactly enough seats, excess seats, unequal department sizes, one department, multiple departments, unavailable classroom, absent student, student added after generation, student removed, regeneration, multiple consecutive papers.
   - Required assertions: no duplicate students, no duplicate seats, no capacity violation, all eligible assigned, invalid students excluded, history correctly considered.
   - A few Playwright smoke tests (login, generate, publish, student sees seat) if feasible.
3. Add CI config (GitHub Actions) running lint, typecheck, tests with a postgres service.
4. Write docs/TESTING.md with how to run each suite and a coverage summary.
5. Run everything and show the totals.

Acceptance: `npm run seed` then `npm run seed:demo-history` produce a fully demonstrable system; all test suites pass.
```

---

## Phase 12: Documentation and Deployment

```text
Run Phase 12 of EXAM_SEATING_BUILD_GUIDE.md.

1. API documentation: OpenAPI 3 spec (generated or hand-written, served at /api/docs via Swagger UI) AND docs/API.md with every endpoint, roles, request/response examples, and error codes (including the allocation failure format).
2. README.md: overview, features, screenshots placeholders, architecture diagram, tech stack, quick start (docker compose), local dev (without Docker), environment variable table, database migration/setup instructions, seed instructions, running tests, demo walkthrough (admin flow + student flow), default credentials (dev only), troubleshooting.
3. docs/DEPLOYMENT.md: production docker compose (or a Render/Railway/VPS guide), managed Postgres, env secrets, HTTPS reverse proxy (Caddy/Nginx), backups, migrations on deploy, health checks, logging, and a security checklist (CORS, helmet, rate limits, cookie flags, secret rotation).
4. docs/ASSUMPTIONS.md listing every assumption made during the build.
5. Final integration check: from a clean clone run `docker compose up --build`, run migrations and seeds, log in as admin, generate Paper 1/2/3, publish, log in as a student, confirm the seat. Report the result honestly, including anything incomplete or known limitations (put these in docs/KNOWN_LIMITATIONS.md).
6. Final consistency review across all phases: ensure routes, roles, schema and docs match the code. List and fix any mismatches.

Acceptance: a new developer can follow the README and have the full demo running in under 15 minutes.
```

---

## Utility Prompts (use anytime)

**Resume after a break**
```text
Read EXAM_SEATING_BUILD_GUIDE.md and AGENTS.md. Inspect the repo and tests, summarize what is complete and what is broken or missing for Phase N, then continue Phase N without rewriting working code.
```

**Fix failing tests**
```text
Run the full test suite. For each failure, find the root cause (do not weaken or delete the test unless the test itself is wrong, and explain if so), fix the code, and rerun until green. Report what changed.
```

**Audit the seating engine**
```text
Act as a strict reviewer of backend/src/engine. Check against Sections 3 and 4 of EXAM_SEATING_BUILD_GUIDE.md: any use of Math.random, any path that could save an invalid plan, any hard constraint that is only enforced in one place, any O(N^2) hot path, any missing failure code. Fix issues and add regression tests.
```

**Consistency check**
```text
Compare the guide's Section 5 (database) and Section 6 (API) against the actual code and docs. List every mismatch (missing endpoint, wrong role, missing constraint, outdated doc) and fix them.
```

**Performance check**
```text
Benchmark seating generation for 1,000 / 5,000 / 10,000 students with 100+ rooms and history depth 3. Profile hot spots, optimize without breaking hard constraints, and record before/after numbers in docs/ALGORITHM.md.
```

---

## Master Completion Checklist (all deliverables)

- [ ] Architecture + diagram (`docs/ARCHITECTURE.md`)
- [ ] Database schema + ER diagram (`database/`)
- [ ] Algorithm explanation, scoring strategy, pseudocode, complexity (`docs/ALGORITHM.md`)
- [ ] Seating engine implementation + validation engine
- [ ] Backend modules (auth, students, departments, classrooms, exams, registrations, seating, history, validation, exports, audit)
- [ ] Frontend: admin dashboard, generation page, visualization, student portal
- [ ] Authentication, RBAC, audit logs
- [ ] Import / export (CSV, Excel, PDF, slips)
- [ ] API documentation (OpenAPI + `docs/API.md`)
- [ ] Automated tests (engine, API, edge cases, benchmarks)
- [ ] Seed/demo data with 3+ papers and history
- [ ] README, setup, env vars, migrations, local dev, deployment instructions
- [ ] Final integration run from a clean clone