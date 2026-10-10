import pg from 'pg';
import { assertSafeDbName, BASE_DB, dbNameForPid, TEMPLATE_DB, adminUrl, urlForDb } from './helpers/dbConfig.js';

/**
 * Runs once per test file, in that file's worker process, BEFORE the test module
 * (and therefore `src/db/prisma.ts`) is imported.
 *
 * Every suite used to share one database and TRUNCATE it in `beforeAll`, so any
 * overlap wiped another file's fixtures mid-test. Those failures looked like
 * product bugs — sporadic 401/404s and FK violations — but were pure harness
 * contention.
 *
 * Each file now gets its own database, cloned from a template that globalSetup
 * has already migrated. Cloning is what makes this affordable: it costs a
 * fraction of a second instead of replaying every migration.
 */

async function connectAdmin(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: adminUrl(), connectionTimeoutMillis: 10000 });
  await client.connect();
  return client;
}

/**
 * Give this worker its own database and point DATABASE_URL at it.
 *
 * SETUP_ASSIGNED_DATABASE_URL keeps this idempotent: Vitest may evaluate a
 * setup file more than once per worker, and re-cloning mid-file would discard
 * fixtures the tests already created.
 */
export async function provisionIsolatedDatabase(): Promise<string> {
  const already = process.env.SETUP_ASSIGNED_DATABASE_URL;
  if (already) {
    process.env.DATABASE_URL = already;
    return already;
  }

  const dbName = dbNameForPid(BASE_DB);
  assertSafeDbName(dbName);

  const admin = await connectAdmin();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
    }
  } finally {
    await admin.end();
  }

  const assigned = urlForDb(dbName);
  process.env.SETUP_ASSIGNED_DATABASE_URL = assigned;
  process.env.DATABASE_URL = assigned;
  return assigned;
}

// Vitest treats every module in setupFiles as a setup file, so this top-level
// await is what actually provisions the database for this worker.
await provisionIsolatedDatabase();