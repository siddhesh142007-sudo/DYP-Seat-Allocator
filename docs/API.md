# API Reference (OpenAPI 3.0)

This document describes the REST API for the College Exam Seating Management System.

## Base URL

```
Development:  http://localhost:3001/api/v1
Production:   https://your-domain.com/api/v1
```

## Access model

DYPIT is **administrator-only**: there are two roles, `SUPER_ADMIN` and `EXAM_ADMIN`, and no
student login or portal. Students exist as records (they are seated) but have no user accounts, and
a roll number is not a login identifier.

## Authentication

All endpoints except `/health` and `/auth/*` require a valid JWT access token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

Access tokens are 15-minute JWTs. Refresh tokens are 7-day httpOnly cookies (`/api/v1/auth/refresh`).

### Login

```http
POST /auth/login
Content-Type: application/json

{ "identifier": "admin@example.edu", "password": "secret" }
```

Response:
```json
{ "accessToken": "...", "expiresIn": 900, "user": { "id": "...", "email": "...", "role": "SUPER_ADMIN" } }
```

## Error Format

All errors follow the `{ error: { code, message, details } }` envelope:

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `VALIDATION_ERROR` | Zod schema validation failed |
| 401 | `UNAUTHORIZED` | Missing/invalid/expired token |
| 403 | `FORBIDDEN` | Role not permitted |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `CONFLICT` | Business rule violation (e.g. no published plan) |
| 422 | `UNPROCESSABLE_ENTITY` | All-or-nothing import failed (details contain row report) |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Endpoints

### Health

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/health` | — | Liveness/readiness (`{status, db}`) |

### Auth

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `POST` | `/auth/login` | — | Email/roll + password → access token + refresh cookie |
| `POST` | `/auth/refresh` | — | Rotate refresh cookie → new access token |
| `POST` | `/auth/logout` | Any | Clear refresh cookie |
| `POST` | `/auth/change-password` | Any | Change own password (requires current password) |

### Users (Super Admin only)

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/users` | SUPER_ADMIN | Paginated list |
| `POST` | `/users` | SUPER_ADMIN | Create admin user |
| `GET` | `/users/:id` | SUPER_ADMIN | Get by ID |
| `PUT` | `/users/:id` | SUPER_ADMIN | Update |
| `DELETE` | `/users/:id` | SUPER_ADMIN | Delete (self-delete blocked) |

### Academic Years

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/academic-years` | SUPER_ADMIN, EXAM_ADMIN | List |
| `POST` | `/academic-years` | SUPER_ADMIN, EXAM_ADMIN | Create |
| `GET` | `/academic-years/:id` | SUPER_ADMIN, EXAM_ADMIN | Get |
| `PUT` | `/academic-years/:id` | SUPER_ADMIN, EXAM_ADMIN | Update |
| `DELETE` | `/academic-years/:id` | SUPER_ADMIN, EXAM_ADMIN | Delete (guarded by FK) |

### Departments

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/departments` | SUPER_ADMIN, EXAM_ADMIN | List |
| `POST` | `/departments` | SUPER_ADMIN, EXAM_ADMIN | Create |
| `GET` | `/departments/:id` | SUPER_ADMIN, EXAM_ADMIN | Get |
| `PUT` | `/departments/:id` | SUPER_ADMIN, EXAM_ADMIN | Update |
| `DELETE` | `/departments/:id` | SUPER_ADMIN, EXAM_ADMIN | Delete (guarded by FK) |

### Students

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/students` | SUPER_ADMIN, EXAM_ADMIN | Search/filter/paginate (query: `search`, `departmentId`, `academicYearId`, `division`, `status`, `page`, `pageSize`, `sort`, `order`) |
| `POST` | `/students` | SUPER_ADMIN, EXAM_ADMIN | Create |
| `GET` | `/students/:id` | SUPER_ADMIN, EXAM_ADMIN | Get |
| `PUT` | `/students/:id` | SUPER_ADMIN, EXAM_ADMIN | Update |
| `DELETE` | `/students/:id` | SUPER_ADMIN, EXAM_ADMIN | Soft deactivate (status=INACTIVE) |
| `GET` | `/students/import/template` | SUPER_ADMIN, EXAM_ADMIN | Download CSV/XLSX template (`?format=csv|xlsx`) |
| `POST` | `/students/import` | SUPER_ADMIN, EXAM_ADMIN | Multipart `file` + `dryRun` → validation report or commit (all-or-nothing) |
| `GET` | `/students/:id/seating` | SUPER_ADMIN, EXAM_ADMIN | Published seat for student |

### Classrooms

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/classrooms` | SUPER_ADMIN, EXAM_ADMIN | List with filters (`search`, `status`, `page`, `pageSize`, `sort`, `order`) |
| `POST` | `/classrooms` | SUPER_ADMIN, EXAM_ADMIN | Create |
| `GET` | `/classrooms/:id` | SUPER_ADMIN, EXAM_ADMIN | Get with seats |
| `PUT` | `/classrooms/:id` | SUPER_ADMIN, EXAM_ADMIN | Update |
| `DELETE` | `/classrooms/:id` | SUPER_ADMIN, EXAM_ADMIN | Delete (409 if seating history → suggest mark unavailable) |
| `POST` | `/classrooms/:id/seats/generate` | SUPER_ADMIN, EXAM_ADMIN | Create N benches (`{count, rows?, cols?}`) |
| `PATCH` | `/classrooms/:id/seats/:seatId` | SUPER_ADMIN, EXAM_ADMIN | Toggle seat status (`{status: AVAILABLE|DISABLED}`) |
| `GET` | `/classrooms/import/template` | SUPER_ADMIN, EXAM_ADMIN | Download CSV/XLSX template (`?format=csv|xlsx`) |
| `POST` | `/classrooms/import` | SUPER_ADMIN, EXAM_ADMIN | Multipart `file` + `dryRun` → validation report or commit (existing rooms skipped, all-or-nothing) |

### Exams

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/exams` | SUPER_ADMIN, EXAM_ADMIN | List with filters |
| `POST` | `/exams` | SUPER_ADMIN, EXAM_ADMIN | Create |
| `GET` | `/exams/:id` | SUPER_ADMIN, EXAM_ADMIN | Get with registration counts |
| `PUT` | `/exams/:id` | SUPER_ADMIN, EXAM_ADMIN | Update |
| `DELETE` | `/exams/:id` | SUPER_ADMIN | Delete (only if no registrations/runs) |
| `GET` | `/exams/:id/eligible-students` | SUPER_ADMIN, EXAM_ADMIN | Eligible students for seating |
| `GET` | `/exams/:id/seating-preview-stats` | SUPER_ADMIN, EXAM_ADMIN | Feasibility + room pool + conflicts |
| `POST` | `/exams/:id/registrations/auto` | SUPER_ADMIN, EXAM_ADMIN | Auto-register all eligible |
| `POST` | `/exams/:id/registrations` | SUPER_ADMIN, EXAM_ADMIN | Manual register |
| `DELETE` | `/exams/:id/registrations/:studentId` | SUPER_ADMIN, EXAM_ADMIN | Unregister |
| `GET` | `/exams/:id/registration-status` | SUPER_ADMIN, EXAM_ADMIN | Per-department counts |

### Seating (Exam Admin + Super Admin)

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `POST` | `/seating/exams/:id/generate-seating` | EXAM_ADMIN, SUPER_ADMIN | Generate new plan (`{mode, historyDepth, seed?, roomIds?}`) → `VALIDATED` run + allocations (one transaction). Returns `{result:{run, timing}}` or 422 with `{runId, failure}`. |
| `POST` | `/seating/exams/:id/regenerate-seating` | EXAM_ADMIN, SUPER_ADMIN | Regenerate (PUBLISHED requires `reason` + `confirm=true`). Supersedes previous run. |
| `POST` | `/seating/exams/:id/publish` | EXAM_ADMIN, SUPER_ADMIN | Publish `VALIDATED` run (re-validates, blocks if stale). |
| `POST` | `/seating/exams/:id/unpublish` | EXAM_ADMIN, SUPER_ADMIN | Unpublish → run back to `VALIDATED`, `published_at` cleared. |
| `GET` | `/seating/exams/:id/seating` | EXAM_ADMIN, SUPER_ADMIN | Latest run (draft/validated/published) with allocations. |
| `GET` | `/seating/exams/:id/seating/runs` | EXAM_ADMIN, SUPER_ADMIN | History of runs (status, stats, penalty, failure). |
| `GET` | `/seating/exams/:id/seating/validate` | EXAM_ADMIN, SUPER_ADMIN | Stale report (added/removed students, disabled rooms/seats, suggestion). |
| `GET` | `/seating/students/:id/seating-history` | SUPER_ADMIN, EXAM_ADMIN | A student's seat across published exams. |

### DYPIT allocation (administrator only)

DYPIT allocates seating by declaring **roll-number ranges against classrooms** rather than by
searching the whole building. Roll numbers look like `SE-AIDS-C_07`
(`SE` = 2nd year, `AIDS` = branch, `C` = division, `07` = serial).

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/dypit/cohorts` | SUPER_ADMIN, EXAM_ADMIN | Distinct year/branch/division cohorts with counts and serial bounds |
| `POST` | `/dypit/preview-range` | SUPER_ADMIN, EXAM_ADMIN | Which students a roll range resolves to |
| `GET` | `/dypit/students` | SUPER_ADMIN, EXAM_ADMIN | Paginated cohort students |
| `GET` | `/dypit/exams/:examId/intents` | SUPER_ADMIN, EXAM_ADMIN | Allocation blocks with resolved student counts |
| `POST` | `/dypit/exams/:examId/intents` | SUPER_ADMIN, EXAM_ADMIN | Add a roll-range → room block |
| `PATCH` | `/dypit/exams/:examId/intents/:intentId` | SUPER_ADMIN, EXAM_ADMIN | Edit a block |
| `DELETE` | `/dypit/exams/:examId/intents/:intentId` | SUPER_ADMIN, EXAM_ADMIN | Remove a block |
| `GET` | `/dypit/exams/:examId/intents/plan` | SUPER_ADMIN, EXAM_ADMIN | Dry-run summary of the whole plan |
| `GET` | `/dypit/exams/:examId/intents/explain` | SUPER_ADMIN, EXAM_ADMIN | Per-block student count, required benches, whether it still fits |
| `POST` | `/dypit/exams/:examId/generate-from-intents` | SUPER_ADMIN, EXAM_ADMIN | Execute the blocks and save one plan |

**Create a block** — `POST /dypit/exams/:examId/intents`

```json
{
  "classroomId": "…uuid…",
  "yearCode": "SE",
  "branchCode": "AIDS",
  "division": "C",
  "fromSerial": 1,
  "toSerial": 45,
  "rowCount": 5,
  "colCount": 9,
  "strictRollOrder": false
}
```

- `rowCount`/`colCount` are optional but must be given **together**; they size the bench grid.
- `seatOffset` may be supplied to start part-way into a room. **Omit it** and the block is placed
  in the next free bench window automatically.
- `strictRollOrder: true` seats the block in ascending roll order with no shuffle.

**Rejections** carry a structured `error.details.code`:

| Code | Meaning |
|------|---------|
| `EMPTY_RANGE` | No students match the range — usually a typo in the division or serial |
| `ROOM_TOO_SMALL` | The room (from `seatOffset`) has fewer usable benches than the block needs |
| `RANGE_OVERLAP` | The serial range overlaps another block for the same year/branch/division |
| `BENCH_OVERLAP` | The bench window collides with another block in the same room |
| `NO_INTENTS` | Generate was called before any block was added |
| `PLAN_EXISTS` | A plan already exists; pass `{"replace": true}` to regenerate |

Editing intents is refused (409) once a plan exists, or while the exam is PUBLISHED.

**Generate** — `POST /dypit/exams/:examId/generate-from-intents`

```json
{ "seed": "paper-3", "historyDepth": 3, "replace": true }
```

Each block is an independent sub-plan — its own students, room, bench window and history — so
students avoid the seat, room, bench number and neighbours they had in previous papers. The
merged plan is validated as a whole and saved in one transaction; if any block cannot be seated,
nothing is written.

### Exports (Exam Admin + Super Admin)

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/exports/exams/:examId/classroom?format=csv|xlsx|pdf` | EXAM_ADMIN, SUPER_ADMIN | Classroom-wise (room header + bench/roll/name/dept) |
| `GET` | `/exports/exams/:examId/department?format=csv|xlsx|pdf` | EXAM_ADMIN, SUPER_ADMIN | Department-wise |
| `GET` | `/exports/exams/:examId/students?format=csv|xlsx|pdf` | EXAM_ADMIN, SUPER_ADMIN | Roll-wise (meta line + header + rows) |
| `GET` | `/exports/exams/:examId/plan?format=csv|xlsx|pdf` | EXAM_ADMIN, SUPER_ADMIN | Full plan (cover + per-room sheets/pages) |
| `GET` | `/exports/exams/:examId/slip?format=pdf&studentId?` | EXAM_ADMIN, SUPER_ADMIN | Single slip (PDF) |
| `GET` | `/exports/exams/:examId/slips?format=pdf` | EXAM_ADMIN, SUPER_ADMIN | Bulk slips (6/page PDF) |

**Published gate:** Requires a `PUBLISHED` run. If none, `?includeDraft=true` returns latest DRAFT/VALIDATED with `DRAFT, NOT FOR DISTRIBUTION` watermark. Otherwise **409 CONFLICT** with message containing `PUBLISHED` and `includeDraft=true`.

### Audit Logs

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| `GET` | `/audit-logs` | SUPER_ADMIN | Paginated, filterable (`actorId`, `action`, `entityType`, `entityId`, `from`, `to`) |

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/auth/login` | 5 req/min per identifier |
| `/auth/refresh` | 10 req/min per IP |

---

## Example: Generate Seating (MIXED)

```http
POST /api/v1/seating/exams/550e8400-e29b-41d4-a716-446655440000/generate-seating
Authorization: Bearer <token>
Content-Type: application/json

{
  "mode": "MIXED",
  "historyDepth": 3,
  "seed": "optional-seed"
}
```

**Success (200):**
```json
{
  "result": {
    "run": {
      "id": "...",
      "status": "VALIDATED",
      "seed": "...",
      "stats": { "sameSeatAsPrev": 0, "sameDeptAdjacent": 3, "timeMs": 1247, "iterations": 30000 },
      "totalPenalty": 1280,
      "generatedAt": "2025-11-15T10:30:00.000Z",
      "publishedAt": null,
      "algorithmVersion": "v1.2"
    }
  }
}
```

**Failure (422):**
```json
{
  "error": {
    "code": "UNPROCESSABLE_ENTITY",
    "message": "Seating generation failed",
    "details": {
      "runId": "...",
      "failure": { "code": "INSUFFICIENT_SEATS", "message": "Additional seats required: 28" }
    }
  }
}
```

---

## OpenAPI Spec

The full OpenAPI 3.0 spec is served at `/api/docs` (Swagger UI) in development and available as `docs/openapi.yaml` (generated from Zod schemas + JSDoc).