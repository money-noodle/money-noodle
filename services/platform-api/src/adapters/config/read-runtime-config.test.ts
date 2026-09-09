import { describe, expect, it } from 'vitest';

import { createConfiguredServer } from './create-configured-server.js';
import { readRuntimeConfig } from './read-runtime-config.js';

const production = {
  NODE_ENV: 'production',
  ARTIFACT_VERSION: 'release-1.2.3',
  MONEY_NOODLE_COMMIT: 'a'.repeat(40),
  MONEY_NOODLE_SERVICE: 'platform-api',
  MONEY_NOODLE_ENVIRONMENT: 'production',
};

describe('readRuntimeConfig and createConfiguredServer', () => {
  it('retains source metadata internally and preserves port/contract path overrides', () => {
    expect(
      readRuntimeConfig({
        ...production,
        PORT: '8080',
        PLATFORM_API_CONTRACT_PATH: 'packaged.yaml',
      }),
    ).toEqual({
      service: { name: 'platform-api', version: 'release-1.2.3' },
      sourceCommit: 'a'.repeat(40),
      environment: 'production',
      port: 8080,
      contractPath: 'packaged.yaml',
    });
  });
  it.each(Object.keys(production))(
    'refuses missing and empty %s before reading files or constructing a server',
    (key) => {
      for (const value of [undefined, '']) {
        expect(() =>
          createConfiguredServer({
            ...production,
            [key]: value,
            PLATFORM_API_CONTRACT_PATH: 'nonexistent.yaml',
          }),
        ).toThrow(key);
      }
    },
  );
  it.each([
    ['MONEY_NOODLE_SERVICE', 'web'],
    ['MONEY_NOODLE_COMMIT', 'A'.repeat(40)],
    ['MONEY_NOODLE_COMMIT', 'abc123'],
    ['MONEY_NOODLE_ENVIRONMENT', 'test'],
    ['NODE_ENV', 'development'],
    ['MONEY_NOODLE_VERSION', ''],
    ['MONEY_NOODLE_API_BASE_URL', ''],
  ])('rejects malformed, contradictory or obsolete %s', (key, value) => {
    expect(() => readRuntimeConfig({ ...production, [key]: value })).toThrow();
  });
  it.each(['development', 'test'])('defaults only explicit %s with unknown source', (mode) => {
    const config = readRuntimeConfig({ NODE_ENV: mode });
    expect(config.sourceCommit).toBeUndefined();
    expect(config.environment).toBe(mode);
    expect(config.service).toEqual({ name: 'platform-api', version: 'development' });
    expect(config.port).toBe(3001);
    expect(() => readRuntimeConfig({ NODE_ENV: mode, MONEY_NOODLE_COMMIT: '' })).toThrow();
    expect(() => readRuntimeConfig({ NODE_ENV: mode, MONEY_NOODLE_SERVICE: '' })).toThrow();
    expect(() =>
      readRuntimeConfig({ NODE_ENV: mode, MONEY_NOODLE_ENVIRONMENT: 'production' }),
    ).toThrow();
  });
  it('composes actual HTTP probes and the unchanged schema without listening or leaking source', async () => {
    const { server } = createConfiguredServer(production);
    try {
      for (const path of ['/health/live', '/health/ready', '/v1/platform/status']) {
        const response = await server.inject({ method: 'GET', url: path });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('release-1.2.3');
        expect(response.body).not.toContain('a'.repeat(40));
        if (path.includes('/v1/')) expect(response.json().schemaVersion).toBe('1');
      }
    } finally {
      await server.close();
    }
  });
  it('emits safe errors without invalid values', () => {
    expect(() =>
      readRuntimeConfig({ ...production, MONEY_NOODLE_COMMIT: 'private-marker' }),
    ).toThrow('MONEY_NOODLE_COMMIT is invalid.');
  });
});
