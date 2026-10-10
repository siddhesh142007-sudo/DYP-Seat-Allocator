import { execSync } from 'node:child_process';
import pg from 'pg';
import { adminUrl, assertSafeDbName, BASE_DB, TEMPLATE_DB, urlForDb } from './helpers/dbConfig.js';

async function connectAdmin(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: adminUrl(), connectionTimeoutMillis: 10000 });
  await client.connect();
  return client;
}

/**
 * One-time setup for the DB test suite:
 *   1. drop databases left behind by a previous, interrupted run;
 *   2. create the template database;
 *   3. apply every committed migration to it with `prisma migrate deploy`
 *      (which also proves deploy works from scratch).
 *
 * Each test file then clones the template — see tests/setup.ts — so no two files
 * share state and a failure in one can never corrupt another.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  assertSafeDbName(BASE_DB);
  assertSafeDbName(TEMPLATE_DB);

  const admin = await connectAdmin();
  try {
    // Leftovers from a killed run hold nothing we need, and letting them pile up
    // would eventually exhaust connection or namespace limits.
    const strays = await admin.query(
      'SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname = $2',
      [`${BASE_DB}_p%`, TEMPLATE_DB],
    );
    for (const row of strays.rows) {
      const name = row.datname as string;
      assertSafeDbName(name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    if (strays.rowCount) {
      // eslint-disable-next-line no-console
      console.log(`[globalSetup] dropped ${strays.rowCount} leftover test database(s)`);
    }

    // Prisma applies migrations but never creates the database itself, so the
    // template must exist before `migrate deploy` can target it.
    await admin.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  } finally {
    await admin.end();
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: urlForDb(TEMPLATE_DB) },
  });

  // Vitest calls a default export's return value after the run. Named
  // `teardown` exports are only honoured alongside a named `setup` export, so
  // returning the cleaner is what actually registers it.
  return teardown;
}

/** Drop every per-worker database so a run leaves Postgres as it found it. */
export async function teardown(): Promise<void> {
  const admin = await connectAdmin();
  try {
    const strays = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `${BASE_DB}_p%`,
    ]);
    for (const row of strays.rows) {
      const name = row.datname as string;
      assertSafeDbName(name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    if (strays.rowCount) {
      // eslint-disable-next-line no-console
      console.log(`[globalSetup] dropped ${strays.rowCount} test database(s)`);
    }
  } finally {
    await admin.end();
  }
}