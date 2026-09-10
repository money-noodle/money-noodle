import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: [
      'apps/web/src/adapters/config/runtime-rendering.contract.ts',
      'services/platform-api/src/adapters/config/runtime-rendering.contract.ts',
    ],
  },
});
