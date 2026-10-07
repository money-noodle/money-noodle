/* v8 ignore file -- @preserve -- Test-only bridge, executed by the dedicated runtime-contract Vitest config. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createConfiguredServer } from './create-configured-server.js';

interface Rendering {
  env: Record<string, string>;
  secretEnv: Record<string, { secret: string; version: string }>;
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
    const { config, server, telemetry } = await createConfiguredServer(rendering.env);
    // The evaluated fixture renders a synthetic, unapproved telemetry origin, so
    // the adapter refuses it and export stays off. That is what makes this
    // composition provable without any possibility of reaching a provider.
    expect(telemetry.enabled).toBe(false);
    try {
      expect(config.sourceCommit).toBe(rendering.expected.sourceCommit);
      expect(config.port).toBe(rendering.port);
      expect(config.service).toEqual({ name: 'platform-api', version: rendering.expected.version });
      expect(rendering.image.endsWith(`@${rendering.expected.digest}`)).toBe(true);
      for (const url of [rendering.livePath, rendering.readyPath, '/v1/platform/status']) {
        const response = await server.inject({ method: 'GET', url });
        const body = response.json();
        if (url === rendering.readyPath) {
          // The evaluated rendering carries the projection connection string only
          // as a secret reference, so this composition is handed no read model, and
          // since #210 readiness refuses without one (ADR-0012). The refusal is the
          // evidence here; a ready answer would mean a value had been rendered into
          // the plain environment or the gate had been removed.
          expect(response.statusCode).toBe(503);
          expect(body.errorCode).toBe('MN-NOT-READY');
        } else if (url === '/v1/platform/status') {
          expect(response.statusCode).toBe(200);
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
          expect(response.statusCode).toBe(200);
          expect(body).toEqual({
            service: 'platform-api',
            version: rendering.expected.version,
            status: 'live',
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
  it('holds every credential only as a reference, never as a value', () => {
    // The evaluated rendering is the evidence: the projection connection string
    // (#219) and the six signed-in references (#250, rendered since #253) all
    // arrive by reference at `latest`, and the plain environment the composition
    // above was handed carries none of them. A regression here would mean a
    // value had been rendered into configuration, or a reference had been
    // dropped or added without the stack saying so.
    const references = [
      'PLATFORM_API_ACCOUNT_DATABASE_URL',
      'PLATFORM_API_ENGINE_READER_DATABASE_URL',
      'PLATFORM_API_ENGINE_RECORDER_DATABASE_URL',
      'PLATFORM_API_IDENTITY_ACCOUNT_ID',
      'PLATFORM_API_IDENTITY_AUDIENCE',
      'PLATFORM_API_IDENTITY_ISSUER',
      'PLATFORM_API_PROJECTION_DATABASE_URL',
    ];
    expect(Object.keys(rendering.secretEnv).sort()).toEqual(references);
    for (const name of references) {
      expect(rendering.secretEnv[name]?.version).toBe('latest');
      expect(Object.keys(rendering.env)).not.toContain(name);
    }
  });

  it.each([
    'NODE_ENV',
    'ARTIFACT_VERSION',
    'MONEY_NOODLE_COMMIT',
    'MONEY_NOODLE_SERVICE',
    'MONEY_NOODLE_ENVIRONMENT',
  ])('refuses absent or empty evaluated %s before startup', async (name) => {
    // The composition is async since telemetry joined it, so a refusal is a
    // rejection, never a synchronous throw.
    for (const value of [undefined, '']) {
      await expect(createConfiguredServer({ ...rendering.env, [name]: value })).rejects.toThrow(
        name,
      );
    }
  });
});
