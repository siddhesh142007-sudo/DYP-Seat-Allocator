import 'dotenv/config';
import pg from 'pg';

/**
 * The database for the CURRENT test file.
 *
 * tests/setup.ts (a Vitest setupFile) has already cloned this worker's own
 * database from the template and pointed DATABASE_URL at it. Reading the env
 * rather than recomputing keeps every DB-touching module — Prisma included —
 * on the same isolated database.
 *
 * Never fall back to a shared name here: that is what made the suite
 * nondeterministic.
 */
export const TEST_DATABASE_URL = process.env.DATABASE_URL as string;

if (!TEST_DATABASE_URL) {
  throw new Error('DATABASE_URL is unset — tests/setup.ts must run before any test module');
}

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
