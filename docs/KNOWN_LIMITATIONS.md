# Known Limitations

This document records trade-offs, known issues, and areas for future improvement.
Each entry includes the rationale and suggested mitigation.

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