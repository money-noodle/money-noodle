import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    // Telemetry correlation runs in its own file because it registers process
    // global tracer providers; `fileParallelism: false` keeps it from racing the
    // rendering contracts for that global.
    fileParallelism: false,
    include: [
      'apps/web/src/adapters/config/runtime-rendering.contract.ts',
      'services/platform-api/src/adapters/config/runtime-rendering.contract.ts',
      'infra/modules/cloud-run-service/tests/telemetry-correlation.contract.ts',
    ],
  },
});
