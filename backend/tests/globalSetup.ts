import 'dotenv/config';
import { execSync } from 'node:child_process';
import pg from 'pg';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://seating:seating_dev_password@localhost:5432/exam_seating_test?schema=public';

/**
 * One-time setup for the DB test suite:
 * 1. creates the test database if it does not exist,
 * 2. applies every committed migration with `prisma migrate deploy`
 *    (proves deploy works from scratch, exactly as the acceptance requires).
 */
export default async function globalSetup(): Promise<void> {
  // Point every forked worker at the test database (dotenv never overrides
  // an existing value, so this also beats backend/.env in child processes).
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
    throw new Error(`Unsafe test database name in TEST_DATABASE_URL: ${dbName}`);
  }

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 10000 });
  await admin.connect();
  try {
    const res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (res.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      // eslint-disable-next-line no-console
      console.log(`[globalSetup] created test database "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
