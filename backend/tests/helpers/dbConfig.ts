/**
 * Shared, side-effect-free test database configuration.
 *
 * Deliberately separate from tests/setup.ts: globalSetup needs these constants
 * but must NOT import that module, because setup.ts provisions a database as an
 * import side effect and the template does not exist yet at globalSetup time.
 */

export const TEMPLATE_DB = 'exam_seating_test_tpl';

export const BASE_TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://seating:seating_dev_password@localhost:5432/exam_seating_test?schema=public';

export const BASE_DB = new URL(BASE_TEST_URL).pathname.replace(/^\//, '');

/** Database name for this worker. The pid is unique per forked test file. */
export function dbNameForPid(baseDb: string, pid: number = process.pid): string {
  const name = `${baseDb}_p${pid}`;
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`Unsafe test database name derived for this worker: ${name}`);
  }
  return name;
}

/**
 * `CREATE DATABASE`/`DROP DATABASE` cannot be parameterised, so every name that
 * reaches them must be validated first.
 */
export function assertSafeDbName(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`Unsafe test database name: ${name}`);
  }
}

export function adminUrl(): string {
  const u = new URL(BASE_TEST_URL);
  u.pathname = '/postgres';
  return u.toString();
}

export function urlForDb(dbName: string): string {
  const u = new URL(BASE_TEST_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}