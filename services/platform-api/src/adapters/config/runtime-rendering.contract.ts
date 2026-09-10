/* v8 ignore file -- @preserve -- Test-only bridge, executed by the dedicated runtime-contract Vitest config. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createConfiguredServer } from './create-configured-server.js';

interface Rendering {
  env: Record<string, string>;
  image: string;
  port: number;
  livePath: string;
  readyPath: string;
  expected: { version: string; sourceCommit: string; digest: string };
}
const path = process.env.RUNTIME_CONTRACT_RENDERING;
if (!path) throw new Error('Evaluated runtime configuration is required; no fixture fallback.');
const { api }: { api: Rendering[] } = JSON.parse(readFileSync(path, 'utf8'));

describe.each(api)('evaluated production API', (rendering) => {
  it('uses the main composition path without listening and preserves schema v1', async () => {
    const { config, server } = createConfiguredServer(rendering.env);
    try {
      expect(config.sourceCommit).toBe(rendering.expected.sourceCommit);
      expect(config.port).toBe(rendering.port);
      expect(config.service).toEqual({ name: 'platform-api', version: rendering.expected.version });
      expect(rendering.image.endsWith(`@${rendering.expected.digest}`)).toBe(true);
      for (const url of [rendering.livePath, rendering.readyPath, '/v1/platform/status']) {
        const response = await server.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        if (url === '/v1/platform/status') {
          expect(body.schemaVersion).toBe('1');
          expect(body.service).toEqual(config.service);
          expect(Object.keys(body).sort()).toEqual([
            'asOf',
            'requestId',
            'schemaVersion',
            'service',
            'state',
          ]);
        } else {
          expect(body).toEqual({
            service: 'platform-api',
            version: rendering.expected.version,
            status: url === rendering.livePath ? 'live' : 'ready',
          });
        }
        for (const value of [config.sourceCommit, rendering.image, 'MONEY_NOODLE_', 'OTEL_']) {
          expect(response.body).not.toContain(value);
        }
      }
    } finally {
      await server.close();
    }
  });
  it.each([
    'NODE_ENV',
    'ARTIFACT_VERSION',
    'MONEY_NOODLE_COMMIT',
    'MONEY_NOODLE_SERVICE',
    'MONEY_NOODLE_ENVIRONMENT',
  ])('refuses absent or empty evaluated %s before startup', (name) => {
    for (const value of [undefined, '']) {
      expect(() => createConfiguredServer({ ...rendering.env, [name]: value })).toThrow(name);
    }
  });
});
