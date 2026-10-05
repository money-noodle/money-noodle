import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GetPlatformStatus } from '../../application/get-platform-status.js';
import type { PaperReadFailure } from '../../application/read-paper-dashboard.js';
import { syntheticHourlyThresholds } from '../../domain/hourly-thresholds.test.js';
import { syntheticOverview } from '../../domain/market-overview.test.js';
import { readPaperBudget } from '../../domain/read-paper-budget.js';
import { syntheticBudgetRow, syntheticOpenExecution } from '../../domain/read-paper-budget.test.js';
import {
  readPaperPerformance,
  readPaperPerformanceSummary,
} from '../../domain/read-paper-performance.js';
import { syntheticPerformanceRow } from '../../domain/read-paper-performance.test.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import { createHttpServer } from './create-http-server.js';

const contract = createPlatformApiContract(
  readFileSync('services/platform-api/openapi/platform-api.v1.yaml', 'utf8'),
);
const service = { name: 'platform-api' as const, version: 'git-abc1234' };
const observedAt = new Date('2026-08-29T20:00:00.000Z');
const servers: ReturnType<typeof createHttpServer>[] = [];

// The published views, built by the real readers from the synthetic records the
// domain tests own. Going through the readers is deliberate: these tests then also
// prove that what the readers produce satisfies the published contract, which is
// the one property neither layer can check alone.
const publishedBudget = readPaperBudget(syntheticBudgetRow, [syntheticOpenExecution]);
const publishedSummary = readPaperPerformanceSummary(syntheticPerformanceRow());
const publishedPerformance = readPaperPerformance(syntheticPerformanceRow());

// The market views, built by the real assemblies from the synthetic feed readings the
// domain tests own. Same reason as above: this is where "what the assembly produces"
// and "what the contract publishes" are checked against each other.
const publishedOverview = syntheticOverview();
const publishedHourly = syntheticHourlyThresholds();

const read =
  <T>(value: T) =>
  async () => ({ ok: true as const, value });
const refused = (failure: PaperReadFailure, detail?: string) => async () => ({
  ...(detail === undefined ? {} : { detail }),
  failure,
  ok: false as const,
});

function createServer(
  overrides: Partial<Parameters<typeof createHttpServer>[0]> = {},
): ReturnType<typeof createHttpServer> {
  const server = createHttpServer({
    contract,
    generateRequestId: () => 'request-123',
    getHourlyThresholdMarkets: async () => publishedHourly,
    getMarketOverview: async () => publishedOverview,
    getPaperBudget: read(publishedBudget),
    getPaperPerformance: read(publishedPerformance),
    getPaperPerformanceSummary: read(publishedSummary),
    getPlatformStatus: () => ({ asOf: observedAt, service, state: 'available' }),
    service,
    ...overrides,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('createHttpServer', () => {
  it('serves the contract-valid public platform observation with correlation', async () => {
    const response = await createServer().inject({
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'x-request-id': 'web-request-123',
      },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('web-request-123');
    expect(response.json()).toEqual({
      asOf: observedAt.toISOString(),
      requestId: 'web-request-123',
      schemaVersion: '1',
      service,
      state: 'available',
    });
  });

  it.each([
    ['/health/live', 'live'],
    ['/health/ready', 'ready'],
  ])('serves minimal %s health without topology', async (url, status) => {
    const response = await createServer().inject({ method: 'GET', url });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({ service: 'platform-api', status, version: 'git-abc1234' });
    expect(JSON.stringify(body)).not.toMatch(/host|region|project|secret|dependency/i);
  });

  // Readiness now depends on the read-only projection (#209, ADR-0012). Liveness
  // deliberately does not: a database outage must not make the platform restart a
  // process that is answering perfectly well.
  it('serves ready when the readiness check passes', async () => {
    const response = await createServer({
      checkReadiness: async () => ({ ready: true }),
    }).inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'platform-api',
      status: 'ready',
      version: 'git-abc1234',
    });
  });

  it.each([
    ['reports not ready', async () => ({ ready: false })],
    [
      'throws',
      async () => {
        throw new Error('connect ECONNREFUSED db.example.invalid:5432 as role reader');
      },
    ],
  ])('fails readiness closed when the check %s', async (_label, checkReadiness) => {
    const response = await createServer({
      checkReadiness: checkReadiness as () => Promise<{ ready: boolean }>,
    }).inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json() as Record<string, unknown>;
    expect(body.errorCode).toBe('MN-NOT-READY');
    expect(body.title).toBe('Service Unavailable');

    // Nothing about the dependency, the host, the port or the role may travel.
    const serialised = JSON.stringify(body);
    for (const forbidden of ['ECONNREFUSED', 'db.example.invalid', '5432', 'reader']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(serialised).not.toMatch(/host|region|project|secret|postgres|role/i);
  });

  it('leaves liveness unaffected while readiness is failing', async () => {
    const server = createServer({ checkReadiness: async () => ({ ready: false }) });

    const live = await server.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({
      service: 'platform-api',
      status: 'live',
      version: 'git-abc1234',
    });
  });

  it('consults the readiness check only for readiness', async () => {
    const checkReadiness = vi.fn(async () => ({ ready: true }));
    const server = createServer({ checkReadiness });

    await server.inject({ method: 'GET', url: '/health/live' });
    await server.inject({ method: 'GET', url: '/v1/platform/status' });
    expect(checkReadiness).not.toHaveBeenCalled();

    await server.inject({ method: 'GET', url: '/health/ready' });
    expect(checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('turns an invalid application result into safe RFC 9457 details', async () => {
    const invalidQuery = (() => ({
      asOf: observedAt,
      service,
      state: 'unknown',
    })) as unknown as GetPlatformStatus;
    const response = await createServer({ getPlatformStatus: invalidQuery }).inject({
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      errorCode: 'MN-INTERNAL-ERROR',
      instance: '/v1/platform/status',
      requestId: 'request-123',
      status: 500,
      title: 'Internal Server Error',
      type: 'https://errors.noodle.money/mn-internal-error',
    });
    expect(response.body).not.toContain('unknown');
  });

  // The paper reads (#210). Each serves the published view enveloped, or a problem
  // that says which of the three failures it was — and in no case a zero balance,
  // an empty record or a fabricated number.
  it.each([
    ['/v1/paper/budget', 'getPaperBudget'],
    ['/v1/paper/performance/summary', 'getPaperPerformanceSummary'],
    ['/v1/paper/performance', 'getPaperPerformance'],
  ])('serves %s as a contract-valid record with correlation', async (url) => {
    const response = await createServer().inject({
      headers: { 'x-request-id': 'web-request-123' },
      method: 'GET',
      url,
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('web-request-123');
    expect(body.schemaVersion).toBe('1');
    expect(body.requestId).toBe('web-request-123');
    expect(body.durable).toBe(true);
  });

  it('publishes the source times the records carry, never the server clock', async () => {
    const budget = await createServer().inject({ method: 'GET', url: '/v1/paper/budget' });
    const summary = await createServer().inject({
      method: 'GET',
      url: '/v1/paper/performance/summary',
    });
    const record = await createServer().inject({ method: 'GET', url: '/v1/paper/performance' });

    expect((budget.json() as Record<string, unknown>).sourceUpdatedAt).toBe(
      publishedBudget.sourceUpdatedAt,
    );
    expect((summary.json() as Record<string, unknown>).generatedAt).toBe(
      publishedSummary.generatedAt,
    );
    // The full record's own stamp, which is older than the row's write time.
    expect((record.json() as Record<string, unknown>).generatedAt).toBe(
      publishedPerformance.generatedAt,
    );
    expect(publishedPerformance.generatedAt).not.toBe(publishedPerformance.sourceUpdatedAt);
  });

  it.each([
    ['unreachable', 'MN-READ-MODEL-UNREACHABLE', undefined],
    ['not-published', 'MN-READ-MODEL-NOT-PUBLISHED', undefined],
    ['invalid', 'MN-READ-MODEL-INVALID', 'payload.summary.benchmarks[0].accuracy'],
  ])('answers a %s read with its own code and a safe detail', async (failure, code, detail) => {
    const response = await createServer({
      getPaperBudget: refused(failure as PaperReadFailure, detail),
    }).inject({ method: 'GET', url: '/v1/paper/budget' });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(body.errorCode).toBe(code);
    expect(body.type).toBe(`https://errors.noodle.money/${code.toLowerCase()}`);
    expect(body.detail).toBeTypeOf('string');
    // A field path is this API's own vocabulary and may travel; nothing about the
    // infrastructure behind the read may.
    expect(JSON.stringify(body)).not.toMatch(/host|region|project|secret|postgres|password/i);
    if (detail !== undefined) expect(String(body.detail)).toContain(detail);
  });

  it('never infers an empty record when nothing has been published', async () => {
    const response = await createServer({
      getPaperBudget: refused('not-published'),
    }).inject({ method: 'GET', url: '/v1/paper/budget' });

    expect(response.statusCode).toBe(503);
    expect(String((response.json() as Record<string, unknown>).detail)).toContain(
      'No empty record was inferred',
    );
    expect(response.body).not.toContain('availableCents');
  });

  it.each([
    ['/v1/paper/performance/summary', 'getPaperPerformanceSummary'],
    ['/v1/paper/performance', 'getPaperPerformance'],
  ])('answers a failed read of %s the same way', async (url, dependency) => {
    const response = await createServer({
      [dependency]: refused('unreachable'),
    }).inject({ method: 'GET', url });

    expect(response.statusCode).toBe(503);
    expect((response.json() as Record<string, unknown>).errorCode).toBe(
      'MN-READ-MODEL-UNREACHABLE',
    );
  });

  it('turns a record that does not satisfy the contract into a safe internal error', async () => {
    // The last line of defence: a reader that drifted from the published schema
    // fails here rather than in a client, and the response says nothing about what
    // was wrong with it.
    const response = await createServer({
      getPaperBudget: read({ ...publishedBudget, availableCents: 'eighty-five' }) as never,
    }).inject({ method: 'GET', url: '/v1/paper/budget' });

    expect(response.statusCode).toBe(500);
    expect((response.json() as Record<string, unknown>).errorCode).toBe('MN-INTERNAL-ERROR');
    expect(response.body).not.toContain('eighty-five');
  });

  it.each([
    ['unreachable', 'could not be reached'],
    ['over-privileged', 'more than SELECT'],
    ['unexpected-shape', 'does not understand'],
    ['not-configured', 'No read model is configured'],
  ])('says which readiness failure it was for %s', async (state, expected) => {
    const response = await createServer({
      checkReadiness: async () => ({ ready: false, state }),
    }).inject({ method: 'GET', url: '/health/ready' });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(503);
    expect(body.errorCode).toBe('MN-NOT-READY');
    expect(String(body.detail)).toContain(expected);
    // Legible without being revealing: no host, no credential, no engine, no identity.
    expect(JSON.stringify(body)).not.toMatch(/host|region|project|secret|postgres|role|password/i);
  });

  it('says nothing about a readiness check that threw', async () => {
    const response = await createServer({
      checkReadiness: async () => {
        throw new Error('connect ECONNREFUSED db.example.invalid:5432');
      },
    }).inject({ method: 'GET', url: '/health/ready' });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(503);
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('db.example.invalid');
  });

  it('uses safe RFC 9457 details for unknown routes', async () => {
    const response = await createServer().inject({ method: 'GET', url: '/private/topology' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      errorCode: 'MN-ROUTE-NOT-FOUND',
      requestId: 'request-123',
      status: 404,
    });
  });

  it('replaces unsafe incoming request correlation with a bounded generated value', async () => {
    const response = await createServer().inject({
      headers: { 'x-request-id': 'unsafe request identifier' },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.headers['x-request-id']).toBe('request-123');
    expect(response.json()).toMatchObject({ requestId: 'request-123' });
  });

  it('accepts only valid non-zero W3C trace context at the adapter boundary', async () => {
    const onTraceContext = vi.fn();
    const server = createServer({ onTraceContext });

    await server.inject({
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      method: 'GET',
      url: '/v1/platform/status',
    });
    await server.inject({
      headers: { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' },
      method: 'GET',
      url: '/v1/platform/status',
    });
    await server.inject({
      headers: { traceparent: 'attacker-controlled' },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(onTraceContext).toHaveBeenCalledOnce();
    expect(onTraceContext).toHaveBeenCalledWith(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'request-123',
    );
  });
  it('serves the contract-valid market overview with its per-feed states', async () => {
    const response = await createServer().inject({ method: 'GET', url: '/v1/market/overview' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('request-123');
    const body = response.json() as Record<string, unknown>;
    expect(body.schemaVersion).toBe('1');
    expect(body.requestId).toBe('request-123');
    expect(body.marketId).toBe('crypto-15m');
    expect(body.feeds).toMatchObject({ spot: { state: 'fresh' } });
    // The envelope is added here and nowhere else; the view itself is published whole.
    expect(body).toEqual({
      ...publishedOverview,
      requestId: 'request-123',
      schemaVersion: '1',
    });
  });

  it('serves the contract-valid hourly threshold view', async () => {
    const response = await createServer().inject({
      method: 'GET',
      url: '/v1/market/hourly-thresholds',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.marketId).toBe('crypto-1h');
    expect(body.capability).toEqual({ live: false, marketData: true, paper: false });
    expect(body).toEqual({
      ...publishedHourly,
      requestId: 'request-123',
      schemaVersion: '1',
    });
  });

  it('answers the market reads even when every feed is unavailable', async () => {
    // A total upstream outage is a two hundred that says so. These routes have no
    // failure branch at all, which is the point: a status code cannot carry "the
    // headline feed is stale but the quotes are current".
    const emptyOverview = {
      ...publishedOverview,
      assets: publishedOverview.assets.map((asset) => ({
        longHistory: [],
        name: asset.name,
        symbol: asset.symbol,
      })),
      feeds: Object.fromEntries(
        Object.keys(publishedOverview.feeds).map((name) => [
          name,
          { ageSeconds: 0, reason: 'upstream-unavailable', state: 'unavailable' },
        ]),
      ),
      headlines: [],
    };

    const response = await createServer({
      getMarketOverview: async () =>
        emptyOverview as unknown as ReturnType<typeof syntheticOverview>,
    }).inject({ method: 'GET', url: '/v1/market/overview' });

    expect(response.statusCode).toBe(200);
    expect((response.json() as Record<string, unknown>).feeds).toMatchObject({
      news: { state: 'unavailable' },
    });
  });

  it('refuses to publish a market view that does not satisfy the contract', async () => {
    // The guard that stops a drifted response reaching a client: it fails here, in
    // this service, as a 500 rather than as a silently wrong field.
    const response = await createServer({
      getHourlyThresholdMarkets: async () =>
        ({ ...publishedHourly, providerId: 'somewhere-else' }) as unknown as ReturnType<
          typeof syntheticHourlyThresholds
        >,
    }).inject({ method: 'GET', url: '/v1/market/hourly-thresholds' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ errorCode: 'MN-INTERNAL-ERROR' });
  });

  it('keeps readiness independent of the market feeds', async () => {
    // A provider outage must not stop this revision serving or make the platform
    // restart it: readiness answers for this service's own dependencies only.
    const response = await createServer({
      checkReadiness: async () => ({ ready: true }),
      getMarketOverview: async () => {
        throw new Error('every provider is down');
      },
    }).inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready' });
  });
});
