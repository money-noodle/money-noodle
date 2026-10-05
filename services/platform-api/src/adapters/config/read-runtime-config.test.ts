import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECTION_TABLES,
  type PaperProjectionPort,
} from '../../domain/paper-projection.js';
import { syntheticBudgetRow } from '../../domain/read-paper-budget.test.js';
import { syntheticPerformanceRow } from '../../domain/read-paper-performance.test.js';
import { createConfiguredServer } from './create-configured-server.js';
import { readRuntimeConfig } from './read-runtime-config.js';

/** A projection that is reachable and SELECT-only, which is what readiness wants. */
const healthyProjection = (): PaperProjectionPort => ({
  close: async () => undefined,
  probePrivileges: async () => ({
    attributes: {
      bypassRowLevelSecurity: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      superuser: false,
    },
    grants: Object.values(DEFAULT_PROJECTION_TABLES).map((table) => ({
      privilege: 'SELECT',
      table,
    })),
  }),
  readBudget: async () => syntheticBudgetRow,
  readExecutions: async () => [],
  readLongShot: async () => null,
  readPerformance: async () => syntheticPerformanceRow(),
});

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
    async (key) => {
      for (const value of [undefined, '']) {
        // The composition is async now that telemetry is initialized before the
        // server exists, so configuration refusal surfaces as a rejection. It is
        // still refused before the contract file is read: the deliberately
        // nonexistent path below would throw a different error if it were.
        await expect(
          createConfiguredServer({
            ...production,
            [key]: value,
            PLATFORM_API_CONTRACT_PATH: 'nonexistent.yaml',
          }),
        ).rejects.toThrow(key);
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
    const { server } = await createConfiguredServer(production, {
      projection: healthyProjection(),
    });
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

  // #210: three read endpoints now depend on the projection, so a revision without a
  // working one cannot serve its declared contract. Cloud Run's startup probe is
  // `/health/ready`, which makes this the gate on a deployment: the revision never
  // receives traffic and the one already serving keeps it (ADR-0012).
  it('refuses readiness when no projection is configured, and still answers liveness', async () => {
    const { server } = await createConfiguredServer(production, { projection: null });
    try {
      const live = await server.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);

      const ready = await server.inject({ method: 'GET', url: '/health/ready' });
      const problem = ready.json() as Record<string, unknown>;
      expect(ready.statusCode).toBe(503);
      expect(problem.errorCode).toBe('MN-NOT-READY');
      expect(String(problem.detail)).toContain('No read model is configured');
    } finally {
      await server.close();
    }
  });

  it('serves the paper reads from the composed projection', async () => {
    const { server } = await createConfiguredServer(production, {
      projection: healthyProjection(),
    });
    try {
      const budget = await server.inject({ method: 'GET', url: '/v1/paper/budget' });
      const summary = await server.inject({
        method: 'GET',
        url: '/v1/paper/performance/summary',
      });
      const record = await server.inject({ method: 'GET', url: '/v1/paper/performance' });

      for (const response of [budget, summary, record]) {
        expect(response.statusCode).toBe(200);
        expect(response.json().schemaVersion).toBe('1');
        // The commit is internal to this service: it reaches the status operation's
        // telemetry identity and no public record.
        expect(response.body).not.toContain('a'.repeat(40));
      }
      expect(budget.json().availableCents).toBe(85);
      expect(record.json().paperRecord.mode).toBe('paper');
    } finally {
      await server.close();
    }
  });

  it('answers a paper read with a problem when the projection is absent', async () => {
    const { server } = await createConfiguredServer(production, { projection: null });
    try {
      const response = await server.inject({ method: 'GET', url: '/v1/paper/budget' });
      expect(response.statusCode).toBe(503);
      expect((response.json() as Record<string, unknown>).errorCode).toBe(
        'MN-READ-MODEL-UNREACHABLE',
      );
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
