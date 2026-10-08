import 'dotenv/config';
import pg from 'pg';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://seating:seating_dev_password@localhost:5432/exam_seating_test?schema=public';

// Force every DB-touching module loaded afterwards (including Prisma) onto
// the test database — never the dev one. dotenv does not override existing
// values, so this also beats backend/.env.
process.env.DATABASE_URL = TEST_DATABASE_URL;

export function createTestPool(max = 5): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max });
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      allocation_intents,
      seating_allocations,
      seating_runs,
      exam_registrations,
      exams,
      subjects,
      seats,
      classrooms,
      students,
      users,
      departments,
      academic_years,
      settings,
      audit_logs
    RESTART IDENTITY CASCADE
  `);
}

/** SQLSTATE classes used across the constraint tests. */
export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  INSUFFICIENT_PRIVILEGE: '42501',
  INVALID_TEXT_REPRESENTATION: '22P02',
} as const;
