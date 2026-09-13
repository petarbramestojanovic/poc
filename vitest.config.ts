import { defineConfig } from 'vitest/config'

// No passWithNoTests: a glob that stops matching must fail the run, not pass it with zero tests.
export default defineConfig({
  test: {
    // A test that asserts nothing fails.
    expect: { requireAssertions: true },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        // Runs against the local Supabase Postgres (DATABASE_URL from `npx supabase status`).
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
