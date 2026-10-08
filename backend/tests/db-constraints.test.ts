import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll, SQLSTATE } from './helpers/db.js';
import { createFixture, insertAllocation } from './helpers/fixtures.js';

let pool: pg.Pool;

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
}, 60000);

afterAll(async () => {
  await pool.end();
});

/** Runs a query expected to fail; returns the pg error. */
async function expectFailure(sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
  try {
    await pool.query(sql, params);
  } catch (err) {
    return err as pg.DatabaseError;
  }
  throw new Error(`Expected query to fail, but it succeeded:\n${sql}`);
}

describe('CHECK constraints', () => {
  it('rejects exams with end_time <= start_time', async () => {
    const f = await createFixture(pool);
    const err = await expectFailure(
      `INSERT INTO exams (id, subject, exam_date, start_time, end_time, academic_year_id)
       VALUES ($1, 'Bad Exam', '2026-10-21', '12:00', '09:00', $2)`,
      [randomUUID(), f.yearId],
    );
    expect(err.code).toBe(SQLSTATE.CHECK_VIOLATION);
    expect(err.message).toContain('exams_end_time_after_start_time');
  });

  it('rejects seats with bench_number <= 0', async () => {
    const f = await createFixture(pool);
    const err = await expectFailure(
      `INSERT INTO seats (id, classroom_id, bench_number) VALUES ($1, $2, 0)`,
      [randomUUID(), f.classroomId],
    );
    expect(err.code).toBe(SQLSTATE.CHECK_VIOLATION);
    expect(err.message).toContain('seats_bench_number_positive');
  });

  it('rejects classrooms with capacity < 0', async () => {
    const err = await expectFailure(
      `INSERT INTO classrooms (id, room_number, capacity) VALUES ($1, 'NEG-CAP', -1)`,
      [randomUUID()],
    );
    expect(err.code).toBe(SQLSTATE.CHECK_VIOLATION);
    expect(err.message).toContain('classrooms_capacity_non_negative');
  });

  it('rejects invalid enum values (enum-like checks)', async () => {
    const err = await expectFailure(
      `INSERT INTO users (id, name, role, password_hash) VALUES ($1, 'X', 'HACKER', 'x')`,
      [randomUUID()],
    );
    expect(err.code).toBe(SQLSTATE.INVALID_TEXT_REPRESENTATION);
  });
});

describe('seating_allocations uniqueness (hard constraint 7)', () => {
  it('rejects the same seat twice in one run', async () => {
    const f = await createFixture(pool);
    await insertAllocation(pool, f, { studentId: f.students[0], seatId: f.seats[0] });
    const err = await expectFailure(
      `INSERT INTO seating_allocations
         (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), f.runId, f.examId, f.students[1], f.classroomId, f.seats[0], f.yearId, f.deptId],
    );
    expect(err.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    expect(err.message).toContain('seating_allocations_run_id_seat_id_key');
  });

  it('rejects the same student twice in one run', async () => {
    const f = await createFixture(pool);
    await insertAllocation(pool, f, { studentId: f.students[0], seatId: f.seats[0] });
    const err = await expectFailure(
      `INSERT INTO seating_allocations
         (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), f.runId, f.examId, f.students[0], f.classroomId, f.seats[1], f.yearId, f.deptId],
    );
    expect(err.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    expect(err.message).toContain('seating_allocations_run_id_student_id_key');
  });

  it('rejects the same (classroom, bench_number) twice', async () => {
    const f = await createFixture(pool);
    const err = await expectFailure(
      `INSERT INTO seats (id, classroom_id, bench_number) VALUES ($1, $2, 1)`,
      [randomUUID(), f.classroomId],
    );
    expect(err.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    expect(err.message).toContain('seats_classroom_id_bench_number_key');
  });

  it('rejects duplicate (exam_id, student_id) registrations', async () => {
    const f = await createFixture(pool);
    await pool.query(
      `INSERT INTO exam_registrations (id, exam_id, student_id) VALUES ($1, $2, $3)`,
      [randomUUID(), f.examId, f.students[0]],
    );
    const err = await expectFailure(
      `INSERT INTO exam_registrations (id, exam_id, student_id) VALUES ($1, $2, $3)`,
      [randomUUID(), f.examId, f.students[0]],
    );
    expect(err.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
  });
});

describe('trigger: seat must belong to the allocation classroom', () => {
  it('rejects an allocation whose seat belongs to another classroom (INSERT)', async () => {
    const f = await createFixture(pool);
    const err = await expectFailure(
      `INSERT INTO seating_allocations
         (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        f.runId,
        f.examId,
        f.students[0],
        f.classroomId,
        f.otherSeats[0],
        f.yearId,
        f.deptId,
      ],
    );
    expect(err.code).toBe(SQLSTATE.CHECK_VIOLATION);
    expect(err.message).toContain('does not belong to classroom');
  });

  it('rejects re-pointing an allocation to a foreign classroom (UPDATE)', async () => {
    const f = await createFixture(pool);
    await insertAllocation(pool, f, { studentId: f.students[0], seatId: f.seats[0] });
    const err = await expectFailure(
      `UPDATE seating_allocations SET classroom_id = $1 WHERE run_id = $2`,
      [f.otherClassroomId, f.runId],
    );
    expect(err.code).toBe(SQLSTATE.CHECK_VIOLATION);
    expect(err.message).toContain('does not belong to classroom');
  });
});

describe('trigger: published runs and allocations are immutable', () => {
  it('rejects UPDATE and DELETE on a PUBLISHED run', async () => {
    const f = await createFixture(pool);
    await pool.query(`UPDATE seating_runs SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
      f.runId,
    ]);

    const upd = await expectFailure(`UPDATE seating_runs SET seed = '999' WHERE id = $1`, [f.runId]);
    expect(upd.code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
    expect(upd.message).toContain('immutable');

    const del = await expectFailure(`DELETE FROM seating_runs WHERE id = $1`, [f.runId]);
    expect(del.code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
    expect(del.message).toContain('immutable');
  });

  it('rejects UPDATE/DELETE and INSERT on allocations of a PUBLISHED run', async () => {
    const f = await createFixture(pool);
    await insertAllocation(pool, f, { studentId: f.students[0], seatId: f.seats[0] });
    await pool.query(`UPDATE seating_runs SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
      f.runId,
    ]);

    const upd = await expectFailure(
      `UPDATE seating_allocations SET seat_id = $1 WHERE run_id = $2`,
      [f.seats[1], f.runId],
    );
    expect(upd.code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
    expect(upd.message).toContain('immutable');

    const del = await expectFailure(`DELETE FROM seating_allocations WHERE run_id = $1`, [f.runId]);
    expect(del.code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);

    const ins = await expectFailure(
      `INSERT INTO seating_allocations
         (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), f.runId, f.examId, f.students[1], f.classroomId, f.seats[1], f.yearId, f.deptId],
    );
    expect(ins.code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
    expect(ins.message).toContain('published seating run');
  });

  it('allows the controlled unpublish bypass only inside its transaction', async () => {
    const f = await createFixture(pool);
    await pool.query(`UPDATE seating_runs SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
      f.runId,
    ]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT allow_published_mutation()');
      await client.query(`UPDATE seating_runs SET status = 'SUPERSEDED' WHERE id = $1`, [f.runId]);
      await client.query(
        `UPDATE seating_allocations SET published_at = NULL WHERE run_id = $1`,
        [f.runId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // The run is now SUPERSEDED (not published) — direct updates work again...
    await pool.query(`UPDATE seating_runs SET seed = 'after-unpublish' WHERE id = $1`, [f.runId]);

    // ...and the bypass flag must not leak into a later transaction.
    const other = await createFixture(pool);
    await pool.query(`UPDATE seating_runs SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
      other.runId,
    ]);
    const err = await expectFailure(`UPDATE seating_runs SET seed = 'leak' WHERE id = $1`, [
      other.runId,
    ]);
    expect(err.code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
  });
});

describe('partial unique index: one active run per exam', () => {
  async function secondRun(examId: string, status = 'VALIDATED'): Promise<pg.DatabaseError | null> {
    try {
      await pool.query(
        `INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
         VALUES ($1, $2, '555', $3, 'v1', '{}')`,
        [randomUUID(), examId, status],
      );
      return null;
    } catch (err) {
      return err as pg.DatabaseError;
    }
  }

  it('rejects a second active run for the same exam', async () => {
    const f = await createFixture(pool);
    const err = await secondRun(f.examId);
    expect(err).not.toBeNull();
    expect(err!.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    expect(err!.message).toContain('seating_runs_one_active_per_exam');
  });

  it('allows a new run once the previous one is SUPERSEDED or FAILED', async () => {
    const f = await createFixture(pool);

    await pool.query(`UPDATE seating_runs SET status = 'SUPERSEDED' WHERE id = $1`, [f.runId]);
    expect(await secondRun(f.examId)).toBeNull();

    await pool.query(`UPDATE seating_runs SET status = 'FAILED' WHERE id = $1`, [f.runId]);
    expect(await secondRun(f.examId, 'FAILED')).toBeNull();

    // Supersede every active run so exactly one DRAFT can exist again...
    await pool.query(
      `UPDATE seating_runs SET status = 'SUPERSEDED'
       WHERE exam_id = $1 AND status NOT IN ('SUPERSEDED', 'FAILED')`,
      [f.examId],
    );
    await pool.query(`UPDATE seating_runs SET status = 'DRAFT' WHERE id = $1`, [f.runId]);

    // ...and still only ONE non-failed/non-superseded run may exist.
    const err = await secondRun(f.examId);
    expect(err).not.toBeNull();
    expect(err!.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
  });
});

describe('referential integrity (RESTRICT for history-bearing rows)', () => {
  it('blocks deleting an academic year / department that students reference', async () => {
    const f = await createFixture(pool);

    const yearErr = await expectFailure(`DELETE FROM academic_years WHERE id = $1`, [f.yearId]);
    expect(yearErr.code).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);

    const deptErr = await expectFailure(`DELETE FROM departments WHERE id = $1`, [f.deptId]);
    expect(deptErr.code).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
  });

  it('blocks deleting a classroom that has allocations', async () => {
    const f = await createFixture(pool);
    await insertAllocation(pool, f, { studentId: f.students[0], seatId: f.seats[0] });
    const err = await expectFailure(`DELETE FROM classrooms WHERE id = $1`, [f.classroomId]);
    expect(err.code).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
  });
});

describe('capacity is derived from available seats (trigger)', () => {
  it('recomputes capacity when seats are added or disabled', async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO classrooms (id, room_number, capacity) VALUES ($1, 'CAP-${id.slice(0, 6)}', 0)`,
      [id],
    );

    await pool.query(
      `INSERT INTO seats (id, classroom_id, bench_number) VALUES ($1, $2, 1)`,
      [randomUUID(), id],
    );
    await pool.query(
      `INSERT INTO seats (id, classroom_id, bench_number) VALUES ($1, $2, 2)`,
      [randomUUID(), id],
    );

    let res = await pool.query(`SELECT capacity FROM classrooms WHERE id = $1`, [id]);
    expect(res.rows[0].capacity).toBe(2);

    await pool.query(
      `UPDATE seats SET status = 'DISABLED' WHERE classroom_id = $1 AND bench_number = 2`,
      [id],
    );
    res = await pool.query(`SELECT capacity FROM classrooms WHERE id = $1`, [id]);
    expect(res.rows[0].capacity).toBe(1);

    await pool.query(`DELETE FROM seats WHERE classroom_id = $1`, [id]);
    res = await pool.query(`SELECT capacity FROM classrooms WHERE id = $1`, [id]);
    expect(res.rows[0].capacity).toBe(0);
  });
});
