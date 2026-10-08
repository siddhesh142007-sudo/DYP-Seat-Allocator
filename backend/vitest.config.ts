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
    // The DB test suites truncate shared tables — files must not run in
    // parallel against the same test database.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
    },
  },
});
