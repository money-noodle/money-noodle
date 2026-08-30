import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@hey-api/openapi-ts';

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  input: path.resolve(packageDirectory, '../../services/platform-api/openapi/platform-api.v1.yaml'),
  output: path.resolve(packageDirectory, 'src/generated'),
  plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/sdk'],
});
