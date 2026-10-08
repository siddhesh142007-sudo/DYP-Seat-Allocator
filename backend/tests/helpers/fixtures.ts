import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface Fixture {
  yearId: string;
  deptId: string;
  otherDeptId: string;
  students: string[];
  classroomId: string;
  otherClassroomId: string;
  seats: string[];
  otherSeats: string[];
  examId: string;
  runId: string;
}

async function insert(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string> {
  const res = await pool.query(sql, params);
  return res.rows[0].id as string;
}

/**
 * Creates a small self-contained world: 1 academic year, 2 departments,
 * 3 students, 2 classrooms with 2 seats each, 1 exam, 1 DRAFT run.
 * Unique suffixes keep repeated calls collision-free.
 */
export async function createFixture(pool: pg.Pool): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);

  const yearId = await insert(
    pool,
    `INSERT INTO academic_years (id, name, code, order_index, status)
     VALUES ($1, $2, $3, 1, 'ACTIVE') RETURNING id`,
    [randomUUID(), `Year ${suffix}`, `Y${suffix}`],
  );

  const deptId = await insert(
    pool,
    `INSERT INTO departments (id, name, code, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [randomUUID(), `Dept A ${suffix}`, `DA${suffix}`],
  );

  const otherDeptId = await insert(
    pool,
    `INSERT INTO departments (id, name, code, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [randomUUID(), `Dept B ${suffix}`, `DB${suffix}`],
  );

  const students: string[] = [];
  for (let i = 0; i < 3; i++) {
    students.push(
      await insert(
        pool,
        `INSERT INTO students (id, roll_number, name, status, academic_year_id, department_id)
         VALUES ($1, $2, $3, 'ACTIVE', $4, $5) RETURNING id`,
        [randomUUID(), `R${suffix}${i}`, `Student ${i} ${suffix}`, yearId, i === 2 ? otherDeptId : deptId],
      ),
    );
  }

  const classroomId = await insert(
    pool,
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity)
     VALUES ($1, $2, 'A', '1', 'AVAILABLE', 0) RETURNING id`,
    [randomUUID(), `R-${suffix}`],
  );

  const otherClassroomId = await insert(
    pool,
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity)
     VALUES ($1, $2, 'B', '2', 'AVAILABLE', 0) RETURNING id`,
    [randomUUID(), `S-${suffix}`],
  );

  const seats: string[] = [];
  const otherSeats: string[] = [];
  for (let bench = 1; bench <= 2; bench++) {
    seats.push(
      await insert(
        pool,
        `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no)
         VALUES ($1, $2, $3, 'AVAILABLE', $3, 1) RETURNING id`,
        [randomUUID(), classroomId, bench],
      ),
    );
    otherSeats.push(
      await insert(
        pool,
        `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no)
         VALUES ($1, $2, $3, 'AVAILABLE', $3, 1) RETURNING id`,
        [randomUUID(), otherClassroomId, bench],
      ),
    );
  }

  const examId = await insert(
    pool,
    `INSERT INTO exams (id, subject, paper_code, exam_date, start_time, end_time,
                        status, seating_status, is_stale, academic_year_id)
     VALUES ($1, $2, $3, '2026-10-20', '09:00', '12:00',
             'PLANNED', 'NOT_GENERATED', false, $4) RETURNING id`,
    [randomUUID(), `Subject ${suffix}`, `P${suffix}`, yearId],
  );

  const runId = await insert(
    pool,
    `INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
     VALUES ($1, $2, '12345', 'DRAFT', 'v1', '{}') RETURNING id`,
    [randomUUID(), examId],
  );

  return {
    yearId,
    deptId,
    otherDeptId,
    students,
    classroomId,
    otherClassroomId,
    seats,
    otherSeats,
    examId,
    runId,
  };
}

/** Inserts an allocation row for the given fixture positions. */
export async function insertAllocation(
  pool: pg.Pool,
  f: Fixture,
  opts: {
    studentId?: string;
    seatId?: string;
    classroomId?: string;
    runId?: string;
    examId?: string;
  } = {},
): Promise<string> {
  return insert(
    pool,
    `INSERT INTO seating_allocations
       (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      randomUUID(),
      opts.runId ?? f.runId,
      opts.examId ?? f.examId,
      opts.studentId ?? f.students[0],
      opts.classroomId ?? f.classroomId,
      opts.seatId ?? f.seats[0],
      f.yearId,
      f.deptId,
    ],
  );
}
