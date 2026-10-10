import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// Workers must hit the test database, never the dev one. dotenv does not
// override existing variables, so setting this here wins over backend/.env.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://seating:seating_dev_password@localhost:5432/exam_seating_test?schema=public';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 120000,
    pool: 'forks',
    globalSetup: ['tests/globalSetup.ts'],
    // Every DB suite truncates the SAME test database in beforeAll, so files
    // must be fully serialized or one file's TRUNCATE wipes another file's
    // fixtures mid-test (symptom: sporadic FK violations and 404s).
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      // bcryptjs is pure JS; cost 12 takes ~1.5-3s per hash on typical
      // hardware, which pushed the auth suites past the per-test timeout.
      // Production still requires >= 12 (see src/config/env.ts).
      PASSWORD_HASH_COST: '4',
    },
  },
});
