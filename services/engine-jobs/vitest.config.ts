import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'services/engine-jobs/src/restore/main.ts',
        'services/engine-jobs/src/cycle/main.ts',
        // The PostgreSQL adapters need a database; no test here may have one.
        // Their SQL is exercised out of band against a throwaway cluster and
        // recorded as dated evidence, not by this suite. Everything they decide
        // rather than execute lives in `src/domain`, which is covered.
        'services/engine-jobs/src/adapters/engine-store/postgres-engine-store.ts',
        'services/engine-jobs/src/adapters/engine-store/postgres-cycle-store.ts',
        // Exercised by the remote-only disposable PostgreSQL contract target.
        'services/engine-jobs/src/adapters/engine-store/postgres-forecast-store.ts',
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
