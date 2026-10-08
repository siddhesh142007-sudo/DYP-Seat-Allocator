# Schema Reference

PostgreSQL 16 · snake_case · 13 tables. Created by `backend/prisma/migrations/`
(`init`, `constraints_and_triggers`, `updated_at_db_defaults`). Relationships & constraints:
[`ER_DIAGRAM.md`](./ER_DIAGRAM.md). Types below use Postgres notation as rendered by `\d`.

**Conventions**
- All PKs: `id uuid PRIMARY KEY` (client default `uuid()`, DB `gen_random_uuid()` available).
- `created_at timestamptz NOT NULL DEFAULT now()` on every table.
- `updated_at timestamptz NOT NULL DEFAULT now()` on tables with an `updated_at` column —
  kept current by the Prisma client (`@updatedAt`) and by the DB default for raw-SQL inserts.
- All FKs use `ON DELETE` as documented in the ER diagram; history-bearing references RESTRICT.

## Enum types

| Enum | Values | Used by |
|---|---|---|
| `user_role` | `SUPER_ADMIN`, `EXAM_ADMIN`, `STUDENT` | users.role |
| `entity_status` | `ACTIVE`, `INACTIVE` | users.status, academic_years.status, departments.status |
| `student_status` | `ACTIVE`, `INACTIVE` | students.status |
| `classroom_status` | `AVAILABLE`, `UNAVAILABLE` | classrooms.status |
| `seat_status` | `AVAILABLE`, `DISABLED` | seats.status |
| `exam_status` | `PLANNED`, `COMPLETED`, `CANCELLED` | exams.status |
| `seating_status` | `NOT_GENERATED`, `DRAFT`, `VALIDATED`, `PUBLISHED` | exams.seating_status (exam-level flow, guide §3.3) |
| `registration_status` | `REGISTERED`, `ABSENT`, `WITHHELD`, `REMOVED` | exam_registrations.status |
| `run_status` | `DRAFT`, `VALIDATED`, `PUBLISHED`, `FAILED`, `SUPERSEDED` | seating_runs.status (FAILED is recorded on the *run*, not the exam) |

---

## users
Staff and student login accounts. Passwords are hashes (bcrypt ≥ cost 12) — never returned or logged.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| email | varchar(255) | yes | — | **UNIQUE**; nullable — student logins may authenticate by roll number |
| name | varchar(255) | no | — | |
| role | user_role | no | `'STUDENT'` | RBAC: SUPER_ADMIN / EXAM_ADMIN / STUDENT |
| password_hash | varchar(255) | no | — | bcrypt/argon2; never exposed |
| status | entity_status | no | `'ACTIVE'` | Disabled users cannot log in |
| student_id | uuid | yes | — | **UNIQUE** FK → students (CASCADE): the 1:1 student-login link |
| created_at / updated_at | timestamptz | no | now() | |

## academic_years
Data, not constants (guide §3.2): default seed 1st–4th Year; admins add/remove.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| name | varchar(100) | no | — | **UNIQUE** e.g. "2nd Year" |
| code | varchar(20) | yes | — | **UNIQUE** e.g. "Y2" |
| order_index | int | no | 0 | Display ordering |
| status | entity_status | no | `'ACTIVE'` | Deactivate instead of delete when referenced |
| created_at / updated_at | timestamptz | no | now() | |

## departments
Data: CSE, AI/DS, ECE, Mechanical, … Cannot be deleted while students reference them (RESTRICT) — deactivate instead.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| name | varchar(150) | no | — | e.g. "Artificial Intelligence & Data Science" |
| code | varchar(50) | no | — | **UNIQUE** e.g. "AIDS" |
| status | entity_status | no | `'ACTIVE'` | |
| created_at / updated_at | timestamptz | no | now() | |

## students
One row per student. Eligible = `status='ACTIVE'` + exam's academic year + `exam_registrations.status='REGISTERED'` (guide §3.4).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| roll_number | varchar(50) | no | — | **UNIQUE**, `CHECK btrim(roll_number) <> ''` (e.g. `24CSE001`) |
| name | varchar(255) | no | — | |
| email | varchar(255) | yes | — | |
| division | varchar(50) | yes | — | Optional (guide §3.2) |
| status | student_status | no | `'ACTIVE'` | DELETE = soft deactivate (Phase 4) |
| academic_year_id | uuid | no | — | FK → academic_years **RESTRICT** |
| department_id | uuid | no | — | FK → departments **RESTRICT** |
| created_at / updated_at | timestamptz | no | now() | |

Indexes: `(academic_year_id, department_id, status)`, `(department_id)`, `(status)`.

## classrooms
`capacity` = number of **AVAILABLE** seats (broken benches reduce it) — kept in sync by
`trg_refresh_classroom_capacity`. A room with seating history cannot be deleted (RESTRICT via allocations) — mark `UNAVAILABLE`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| room_number | varchar(50) | no | — | **UNIQUE**, not blank (`CHECK`) |
| building | varchar(100) | yes | — | e.g. "A" |
| floor | varchar(20) | yes | — | e.g. "1" |
| status | classroom_status | no | `'AVAILABLE'` | Whole-room unavailable flag (guide §3.1) |
| capacity | int | no | 0 | `CHECK capacity >= 0`; DB-maintained from available seats |
| notes | text | yes | — | |
| created_at / updated_at | timestamptz | no | now() | |

## seats
**One bench = one seat = ONE student** (guide §3.1). Each bench is one row.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| classroom_id | uuid | no | — | FK → classrooms **CASCADE** |
| bench_number | int | no | — | `CHECK bench_number > 0`; **UNIQUE (classroom_id, bench_number)** |
| status | seat_status | no | `'AVAILABLE'` | `DISABLED` = broken bench, never allocated |
| row_no | int | yes | — | Optional visual layout (guide §5) |
| col_no | int | yes | — | Optional visual layout |
| created_at / updated_at | timestamptz | no | now() | |

## exams
**One exam = one academic year** (guide §3.2). Never mix years.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| subject | varchar(255) | no | — | e.g. "Data Structures" |
| paper_code | varchar(50) | yes | — | e.g. "CS-201" |
| semester | int | yes | — | Optional (guide §3.3) |
| exam_date | date | no | — | |
| start_time | time | no | — | `CHECK end_time > start_time` |
| end_time | time | no | — | |
| status | exam_status | no | `'PLANNED'` | Lifecycle of the exam itself |
| seating_status | seating_status | no | `'NOT_GENERATED'` | `NOT_GENERATED → DRAFT → VALIDATED → PUBLISHED` (guide §3.3) |
| is_stale | bool | no | false | Stale-plan flag: students/rooms changed after generation (Phases 5/7) |
| academic_year_id | uuid | no | — | FK → academic_years **RESTRICT** |
| created_at / updated_at | timestamptz | no | now() | |

Indexes: `(academic_year_id)`, `(exam_date)`.

## exam_registrations
Auto-created for all ACTIVE students of the exam's year when the exam is created (Phase 5).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| exam_id | uuid | no | — | FK → exams **CASCADE** |
| student_id | uuid | no | — | FK → students **RESTRICT** |
| status | registration_status | no | `'REGISTERED'` | ABSENT / WITHHELD / REMOVED excluded from allocation |
| registered_at | timestamptz | no | now() | |

Constraints: **UNIQUE (exam_id, student_id)** (hard constraint 7), index `(student_id)`.

## seating_runs
One row per generation attempt (guide §5) — success or failure.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| exam_id | uuid | no | — | FK → exams **RESTRICT** |
| seed | varchar(64) | no | — | PRNG seed (stored as text: safe for 64-bit values, reproducible) |
| status | run_status | no | `'DRAFT'` | FAILED holds the structured failure; SUPERSEDED = replaced by a newer run |
| algorithm_version | varchar(50) | no | — | e.g. `greedy-swap-v1` |
| config | json | no | `{}` | Engine config: mode, historyDepth, weights, roomIds… |
| total_penalty | double precision | yes | — | Lower is better (decay-weighted) |
| stats | json | yes | — | `sameSeatAsPrev`, `sameRoomAsPrev`, `sameBenchNoAsPrev`, `sameNeighbourAsPrev`, `sameDeptAdjacent` |
| validation_report | json | yes | — | Output of the independent validation engine |
| failure | json | yes | — | `{code, message, details, suggestion}` when status = FAILED (guide §3.8) |
| generated_by | uuid | yes | — | FK → users **SET NULL** |
| generated_at | timestamptz | no | now() | |
| published_by | uuid | yes | — | FK → users **SET NULL** |
| published_at | timestamptz | yes | — | Stamped on publish; null otherwise |

Indexes: `(exam_id)`, `(status)`; **partial unique** `seating_runs_one_active_per_exam`
`(exam_id) WHERE status NOT IN ('SUPERSEDED','FAILED')`.
Immutability trigger rejects UPDATE/DELETE while `status='PUBLISHED'` (bypass: `allow_published_mutation()`).

## seating_allocations
The seating plan itself: one row per student per run. All FKs RESTRICT (history), except `run_id` CASCADE.
Denormalized `academic_year_id` / `department_id` for history queries and exports (guide §5).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| run_id | uuid | no | — | FK → seating_runs **CASCADE** |
| exam_id | uuid | no | — | FK → exams **RESTRICT** |
| student_id | uuid | no | — | FK → students **RESTRICT** |
| classroom_id | uuid | no | — | FK → classrooms **RESTRICT** |
| seat_id | uuid | no | — | FK → seats **RESTRICT** |
| academic_year_id | uuid | no | — | Denormalized FK → academic_years **RESTRICT** |
| department_id | uuid | no | — | Denormalized FK → departments **RESTRICT** |
| generated_at | timestamptz | no | now() | |
| published_at | timestamptz | yes | — | Stamped on publish |

Constraints: **UNIQUE (run_id, student_id)**, **UNIQUE (run_id, seat_id)** (hard constraint 7);
indexes `(student_id)`, `(exam_id)`, `(classroom_id)`.
Triggers: `trg_seat_belongs_to_classroom` (seat must belong to the room, guide §5) and
`trg_allocations_published_immutable` (published plans are frozen, hard constraint 8).

## audit_logs
Every sensitive action (login, generate, publish, unpublish, failures…). Inserted via the
`auditLog(actor, action, entity, entityId, metadata)` helper (Phase 3).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| actor_user_id | uuid | yes | — | FK → users **SET NULL** (trail survives user deletion) |
| action | varchar(100) | no | — | e.g. `seating.publish` |
| entity_type | varchar(100) | no | — | e.g. `exam` |
| entity_id | varchar(100) | yes | — | String: works for uuids and non-uuid keys |
| metadata | json | yes | — | Free-form context (reason, counts, seed…) |
| ip | varchar(45) | yes | — | IPv4/IPv6 |
| created_at | timestamptz | no | now() | |

Indexes: `(created_at)`, `(entity_type, entity_id)` (guide §5).

## settings
College-configurable key/value settings (department distribution defaults, auto-register flag…).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid() | PK |
| key | varchar(100) | no | — | **UNIQUE** |
| value | json | no | — | |
| updated_by | uuid | yes | — | FK → users **SET NULL** |
| updated_at | timestamptz | no | now() | |
