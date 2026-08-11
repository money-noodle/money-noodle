import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { 'server-only': fileURLToPath(new URL('./lib/server-only-stub.ts', import.meta.url)) },
  },
});
