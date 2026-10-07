import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'services/engine-jobs/src/restore/main.ts',
        // The PostgreSQL adapter needs a database; no test here may have one. Its
        // SQL is exercised by the maintainer's out-of-band run and recorded as
        // dated evidence, not by this suite.
        'services/engine-jobs/src/adapters/engine-store/postgres-engine-store.ts',
        'services/engine-jobs/src/test-support/**',
      ],
      include: ['services/engine-jobs/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/services/engine-jobs',
      thresholds: {
        branches: 75,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    environment: 'node',
    include: ['services/engine-jobs/src/**/*.test.ts'],
  },
});
