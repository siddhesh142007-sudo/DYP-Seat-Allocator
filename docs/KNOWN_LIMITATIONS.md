# Known Limitations

This document records trade-offs, known issues, and areas for future improvement.
Each entry includes the rationale and suggested mitigation.

> **DYPIT fork:** items 17+ below are specific to the DYPIT deployment
> (Dr. D. Y. Patil Institute of Technology, Pimpri) — intent-driven allocation,
> an administrator-only access model, and the SPPU curriculum import.

---

## 1. Seat Capacity Trigger Performance

**Issue:** `trg_refresh_classroom_capacity` is a `FOR EACH ROW` trigger on `seats`. Bulk seat inserts (e.g., 5,000 seats) take 18–24 s in Docker because each row recounts all seats in the room (`SELECT count(*) FROM seats WHERE classroom_id = NEW.classroom_id`).

**Impact:**
- `npm run seed:demo` (610 students + benches) runs in ~10 s (acceptable)
- Classroom import of 500 rooms × many benches could be slow without batching
- Test fixtures use `ALTER TABLE seats DISABLE TRIGGER trg_refresh_classroom_capacity` (owner-level) to bypass

**Rationale:** Trigger enforces the capacity invariant for *every* writer (raw SQL, Prisma, future tools). The guide requires capacity to be "derived/validated from seats" — the trigger makes this a hard guarantee.

**Mitigation:**
- Batch seat inserts using `createMany` (already done in `import.service.ts` and seed)
- For bulk operations, temporarily disable trigger (`ALTER TABLE ... DISABLE TRIGGER`) and manually set `capacity` after
- Consider a statement-level trigger with `TRANSITION TABLE` (PostgreSQL 14+) for bulk performance

**Future:** Migrate to statement-level trigger or maintain capacity in application layer with advisory lock.

---

## 2. Worker Threads Fallback (Threading Not Default)

**Issue:** `runInWorker` spawns a real `worker_threads` worker in production builds (`dist/`) but falls back to **inline execution** in development (`tsx`) and if the worker fails to start.

**Impact:**
- Express event loop **can block** during long generations in dev/CI
- Production Docker image uses real worker (isolates event loop)
- The fallback means a threading bug never produces a fake failure (Rule 5) but also means the event loop protection is only active in built images

**Rationale:** `tsx` worker loading is flaky (`--import tsx` not always reliable). The fallback guarantees correctness over isolation in non-production.

**Mitigation:**
- Always run `npm run build` before production deploy (CI does this)
- Monitor generation latency; if event loop stalls, investigate worker spawn failures

**Future:** Fix `tsx` worker loading or use a dedicated worker process (BullMQ, separate service) for full isolation.

---

## 3. FK Overhead on Allocation Inserts

**Issue:** `seating_allocations` has 7 foreign keys. Inserting 5,000 rows takes ~14 s in Docker (FK checks per row). Test fixtures use `SET LOCAL session_replication_role = replica` (requires superuser) to bypass.

**Impact:**
- Generation of 5,000 students persists allocations in ~15 s (in addition to engine time)
- Test fixtures need superuser to run fast

**Rationale:** FKs enforce referential integrity at the database level — the guide requires "strong integrity (FKs, CHECK constraints, partial unique indexes, triggers)".

**Mitigation:**
- In application: `createMany` batches the insert but FK checks still fire per row
- For test fixtures only: `session_replication_role = replica` (documented in `TESTING.md`)

**Future:** Consider deferred FK checks (`SET CONSTRAINTS ALL DEFERRED`) inside the generation transaction — requires all FKs to be `DEFERRABLE INITIALLY IMMEDIATE`.

---

## 4. No Real-Time Updates (Synchronous HTTP Only)

**Issue:** Generation is a synchronous HTTP request. No WebSockets/SSE for progress updates. Client polls or waits for response.

**Impact:**
- Admin sees spinner for up to 10 s (engine budget)
- No cancellation support (once started, runs to completion or timeout)

**Rationale:** Guide decision (§7): "synchronous HTTP request/response … WebSockets/SSE would add connection state … for one loading spinner — unjustified". The `runInWorker` seam allows future queue/worker migration.

**Mitigation:** Client shows elapsed timer. Generation is fast (< 2 s for typical loads; 5k students ≈ 5–8 s).

**Future:** Add `worker_threads` + progress channel, or introduce a job queue (BullMQ) with polling/SSE.

---

## 5. Single-Admin Generation Concurrency

**Issue:** Only one generation per exam at a time (advisory lock on `examId`). Different exams don't contend. If two admins try to generate for the same exam, the second gets **409 immediately**.

**Impact:** No queue; admins must coordinate manually.

**Rationale:** Guide allows "advisory lock or row lock → 409". Serialisation is correct for a single-admin internal tool.

**Mitigation:** Clear error message; admins communicate.

---

## 6. Partial Unique Index: One Active Run Per Exam

**Issue:** `seating_runs_one_active_per_exam` allows only one run with status NOT IN (`SUPERSEDED`, `FAILED`) per exam. A `DRAFT` run blocks a new generation.

**Impact:** Failed/DRAFT runs must be cleaned up or superseded before new generation.

**Rationale:** Prevents ambiguous "which run is current?" state. The guide's lifecycle (DRAFT → VALIDATED → PUBLISHED → SUPERSEDED/FAILED) maps cleanly.

**Mitigation:** Generate endpoint supersedes automatically (updates old run to `SUPERSEDED` in same transaction). Manual cleanup via unpublish/delete.

---

## 7. Slip PDF Only for Published Exams (Student Portal)

**Issue:** `GET /me/seating/slip/:examId` returns **404** for draft/unpublished exams, other students, or unknown IDs — never 403. Existence of unpublished plans never leaks.

**Impact:** Students cannot preview slips before publish. Admins must use export endpoints for draft slips.

**Rationale:** Guide item 2/5: "draft exams … never leaks". 404 is the correct semantic (resource not found).

---

## 8. CSV/XLSX Export: Memory for Large Exports

**Issue:** `exceljs` loads the entire workbook in memory before streaming. 5,000-student XLSX ≈ 137 KB but intermediate memory ~50–100 MB. PDF/CSV stream incrementally.

**Impact:** Concurrent large exports could pressure memory.

**Rationale:** `exceljs` API requires full workbook in memory for `.writeBuffer()`. Streaming writer exists but is more complex.

**Mitigation:** Limit concurrent exports (rate limit or queue). Current load (single admin) is fine.

**Future:** Implement streaming XLSX writer or use `xlsx` (SheetJS) streaming mode.

---

## 9. Classroom Import: No Update on Existing Room

**Issue:** `POST /classrooms/import` **skips** existing rooms (by `room_number`). Does not update building/floor/bench_count.

**Impact:** To change a room's capacity, must edit via CRUD or delete + re-import.

**Rationale:** Mirrors student import "skip unchanged" behaviour. Prevents accidental capacity changes that would break existing seating plans.

**Mitigation:** Document clearly. Admins use Edit button for changes.

---

## 10. No Playwright E2E Tests

**Issue:** Only unit + API + DB tests exist. No browser E2E (Playwright) for critical flows (login → generate → publish → student sees seat).

**Impact:** Regression risk for UI integration.

**Rationale:** Time-boxed; guide listed Playwright as "if feasible". Unit + API coverage is high (223 backend + 29 frontend tests).

**Future:** Add Playwright smoke tests for:
- Admin login → generate → publish
- Student login → portal → slip download

---

## 11. Seat Layout (row/col) Not Used in Engine

**Issue:** Seats have `row_no`, `col_no` for visualization. The engine treats benches as 1D (`bench_number`). Adjacency is bench ±1 in the same room.

**Impact:** 2D layout (rows × cols) is visual only; engine doesn't penalize row/col neighbours differently.

**Rationale:** Guide §4.4 defines adjacency as "same room, bench numbers differ by 1". 2D coordinates are for the visual grid only.

**Future:** If 2D adjacency needed, extend engine with `roomGrid` topology.

---

## 12. Student Import: Division Not Validated Against Department/Year

**Issue:** `division` field is free text; no constraint linking divisions to departments/years.

**Impact:** Typos create new divisions silently.

**Rationale:** Division is a simple string attribute per guide. Adding a `divisions` table would be over-engineering for current scope.

---

## 13. Password Reset / Email Verification Not Implemented

**Issue:** No "forgot password" flow or email verification. Password change requires current password.

**Impact:** Locked-out admins need DB access to reset.

**Rationale:** Out of scope for the guide (internal tool, admin-managed). Super Admin can reset via DB if needed.

**Future:** Add email-based reset (requires SMTP + token table).

---

## 14. Audit Log Growth

**Issue:** `audit_logs` table grows unbounded. No retention policy or partitioning.

**Impact:** Long-running production instance may see slow audit queries.

**Rationale:** Internal tool with moderate write volume (hundreds/day). Not yet a problem.

**Future:** Add partitioned table by month + `pg_cron` job to drop old partitions (retain 2 years).

---

## 15. Time Zone Handling

**Issue:** `exam_date` is `DATE`, `start_time`/`end_time` are `TIME` (no TZ). `past` calculation uses `date + endTime <= now()` in server TZ.

**Impact:** If server TZ differs from campus TZ, "past" boundary shifts.

**Rationale:** Guide doesn't specify TZ. Simplest correct approach: store exam date/time in campus local time, run server in same TZ.

**Mitigation:** Set `TZ=Asia/Kolkata` (or campus TZ) in Docker/host. Document in DEPLOYMENT.md.

---

## 16. No Multi-Tenancy

**Issue:** Single database, single organisation. No support for multiple colleges/institutions.

**Impact:** Not suitable for SaaS.

**Rationale:** Guide specifies "College Exam Seating Management System" (single college).

---

## Summary Table

| # | Area | Severity | Status |
|---|------|----------|--------|
| 1 | Capacity trigger bulk perf | Medium | Documented, workaround in tests/seed |
| 2 | Worker threads fallback | Low | Dev only; production uses real worker |
| 3 | FK overhead on allocations | Medium | Documented; test workaround |
| 4 | No real-time/progress | Low | By design (sync HTTP) |
| 5 | Single-admin concurrency | Low | By design (advisory lock → 409) |
| 6 | One active run per exam | Low | By design (partial unique index) |
| 7 | Slip 404 for draft | Low | By design (no leak) |
| 8 | XLSX memory | Low | Acceptable for current scale |
| 9 | Classroom import skip | Low | Documented behaviour |
| 10 | No Playwright E2E | Medium | Future work |
| 11 | 1D bench adjacency | Low | By design (guide) |
| 12 | Division free text | Low | Acceptable |
| 13 | No password reset | Medium | Future work |
| 14 | Audit log growth | Low | Future partitioning |
| 15 | TZ handling | Medium | Documented; set server TZ |
| 16 | No multi-tenancy | N/A | Out of scope |
---

## DYPIT-specific (items 17+)

### 17. Allocation is per-block, not globally optimised

**Issue:** Each allocation intent is an independent sub-plan (its own students, room, bench window and history). The engine never moves a student *between* the rooms an administrator assigned, so a global optimum across rooms is not reached.

**Why:** The college asks the administrator to choose which room a roll range sits in. Honouring that instruction is the requirement; silently relocating students would defeat it.

**Mitigation:** The administrator sets `seatOffset` and an optional `rows × cols` grid per block, so room utilisation is controlled explicitly. The local search still optimises *within* each block.

---

### 18. Strict roll order does not avoid previous seats

**Issue:** A block marked `strictRollOrder` seats students in ascending roll number and skips local search entirely, so its arrangement is identical on every paper.

**Why:** That is the point of the option — an invigilator-friendly, readable order. Any swap would break the ordering.

**Mitigation:** Use the shuffled default for normal papers; use strict order deliberately when readability matters more than variety.

---

### 19. No admission-cohort field on students

**Issue:** Roll numbers carry no admission year (`SE-AIDS-C_07` means "2nd-year AIDS division C serial 07"). This is unique only because students are promoted `SE → TE → BE`, so one cohort occupies each year code at a time.

**Impact:** Historical data spanning more than one full four-year cycle would collide. Anyone adding an `admissionYear` column later must migrate the unique constraint from `roll_number` to `(roll_number, admission_year)`.

**Why:** Confirmed with the college; adding the field would mean threading it through every student query for no present benefit.

---

### 20. SPPU curriculum is reference-only

**Issue:** The `subjects` table is populated from the SPPU spreadsheets but never drives seating, scheduling or clash detection. Room clashes are still time-slot based, not subject based.

**Why:** Seating is driven by an exam plus the administrator's intents. Curriculum data exists for display and future scheduling work.

**Note:** The parsers degrade gracefully rather than failing on an odd source row — a curriculum typo must never block running an exam. Multi-semester source headers are anchored to each year's first semester (assumption 101), and a test asserts no subject is ever filed under a semester its year does not have.

---

### 21. Range resolution loads a whole cohort into memory

**Issue:** Resolving a roll range fetches the cohort by roll-number prefix, then filters on the numeric serial in memory. Cohorts are at most a few hundred students so this is cheap, but it is not a pure SQL `WHERE serial BETWEEN …`.

**Why:** Serials are zero-padded to a *minimum* of two digits, so `01..09` and `100..105` have different string widths. A SQL suffix match cannot express the numeric range correctly; `gen_random_uuid()`-style parsing in SQL would be slower and less readable.

**Mitigation:** If cohorts ever reach thousands, add a generated `serial` column with a numeric index.

---

### 22. Bench windows are validated per block, not globally optimised

**Issue:** When an intent omits `seatOffset`, it is placed at the first free bench window *after* the existing blocks in that room. This is deterministic and safe, but it does not compact or re-order blocks.

**Why:** An administrator who places blocks out of order gets gaps. Re-packing silently would move students between bench windows they may have already published.

---

### 23. No automatic room/clash inference for DYPIT

**Issue:** DYPIT generation uses only the rooms named in the intents. It does not consult the clash-detection or available-rooms logic the exam-wide generator uses.

**Impact:** Two DYPIT exams overlapping in time will happily be assigned the same room unless the administrator notices.

**Mitigation:** The classroom picker shows each room's free capacity, and the Allocation Builder shows planned block counts before generating. A future enhancement would warn when two active exams claim the same room.
