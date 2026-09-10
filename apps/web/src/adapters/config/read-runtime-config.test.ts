import { describe, expect, it, vi } from 'vitest';

import { readRuntimeConfig } from './read-runtime-config';

vi.mock('server-only', () => ({}));

const production = {
  NODE_ENV: 'production',
  PLATFORM_API_ORIGIN: 'https://api.example.test',
  ARTIFACT_VERSION: 'release-1.2.3',
  MONEY_NOODLE_COMMIT: 'a'.repeat(40),
  MONEY_NOODLE_SERVICE: 'web',
  MONEY_NOODLE_ENVIRONMENT: 'production',
};

describe('readRuntimeConfig', () => {
  it('keeps source attribution internal and distinct from the public descriptor', () => {
    expect(readRuntimeConfig(production)).toEqual({
      service: { name: 'web', version: 'release-1.2.3' },
      sourceCommit: 'a'.repeat(40),
      environment: 'production',
      platformApiOrigin: 'https://api.example.test',
    });
  });
  it.each(Object.keys(production))('rejects absent and empty %s', (key) => {
    for (const value of [undefined, '']) {
      expect(() => readRuntimeConfig({ ...production, [key]: value })).toThrow();
    }
  });
  it.each([
    ['MONEY_NOODLE_SERVICE', 'platform-api'],
    ['MONEY_NOODLE_COMMIT', 'A'.repeat(40)],
    ['MONEY_NOODLE_COMMIT', 'abc123'],
    ['MONEY_NOODLE_ENVIRONMENT', 'test'],
    ['NODE_ENV', 'development'],
    ['MONEY_NOODLE_VERSION', ''],
    ['MONEY_NOODLE_API_BASE_URL', ''],
  ])('rejects contradictory, malformed or obsolete %s', (key, value) => {
    expect(() => readRuntimeConfig({ ...production, [key]: value })).toThrow();
  });
  it.each(['development', 'test'])('defaults only explicit %s with unknown source', (mode) => {
    expect(readRuntimeConfig({ NODE_ENV: mode })).toEqual({
      service: { name: 'web', version: 'development' },
      environment: mode,
      sourceCommit: undefined,
      platformApiOrigin: 'http://127.0.0.1:3001',
    });
    expect(() => readRuntimeConfig({ NODE_ENV: mode, MONEY_NOODLE_COMMIT: '' })).toThrow();
    expect(() => readRuntimeConfig({ NODE_ENV: mode, MONEY_NOODLE_SERVICE: '' })).toThrow();
    expect(() =>
      readRuntimeConfig({ NODE_ENV: mode, MONEY_NOODLE_ENVIRONMENT: 'production' }),
    ).toThrow();
  });
  it('never echoes invalid values in errors', () => {
    try {
      readRuntimeConfig({ ...production, MONEY_NOODLE_COMMIT: 'private-marker' });
    } catch (error) {
      expect(String(error)).not.toContain('private-marker');
    }
  });
});
