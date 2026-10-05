// The reads, against a fetch the test provides.
//
// What is checked here is the classification: which answer becomes which outcome, and that
// nothing from an answer this site refused travels into one. The three read-model codes are
// each exercised separately, because the whole reason they exist is that they mean different
// things.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  syntheticHourlyThresholds,
  syntheticMarketOverview,
  syntheticPaperBudget,
  syntheticPaperPerformance,
  syntheticPaperPerformanceSummary,
} from '../../presentation/synthetic-records.test';
import {
  loadBudgetPageRead,
  loadHomeReads,
  loadHourlyPageRead,
  loadHourlyThresholds,
  loadMarketOverview,
  loadPaperBudget,
  loadPaperPerformance,
  loadPaperPerformanceSummary,
  loadPerformancePageReads,
  platformApiOrigin,
} from './load-dashboard-reads';

vi.mock('server-only', () => ({}));

const correlation = {
  requestId: 'web-request-123',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};

const BASE = 'https://api.example.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    status,
  });
}

function problem(errorCode: string): Response {
  return jsonResponse(
    {
      detail: 'The read model could not be reached.',
      errorCode,
      instance: '/v1/paper/budget',
      requestId: 'api-request',
      status: 503,
      title: 'Service Unavailable',
      type: `https://errors.noodle.money/${errorCode.toLowerCase()}`,
    },
    503,
  );
}

const reads = [
  ['market overview', loadMarketOverview, '/v1/market/overview', syntheticMarketOverview()],
  [
    'hourly thresholds',
    loadHourlyThresholds,
    '/v1/market/hourly-thresholds',
    syntheticHourlyThresholds(),
  ],
  ['paper budget', loadPaperBudget, '/v1/paper/budget', syntheticPaperBudget()],
  [
    'paper summary',
    loadPaperPerformanceSummary,
    '/v1/paper/performance/summary',
    syntheticPaperPerformanceSummary(),
  ],
  ['paper record', loadPaperPerformance, '/v1/paper/performance', syntheticPaperPerformance()],
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('each read', () => {
  for (const [name, load, path, record] of reads) {
    it(`reads ${name} once, uncached, with correlation`, async () => {
      const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse(record));

      const outcome = await load({ baseUrl: BASE, correlation, fetch: fetchImplementation });

      expect(outcome).toEqual({ ok: true, value: record });
      expect(fetchImplementation).toHaveBeenCalledOnce();
      const request = fetchImplementation.mock.calls[0]?.[0] as Request;
      expect(request.url).toBe(`${BASE}${path}`);
      expect(request.cache).toBe('no-store');
      expect(request.headers.get('traceparent')).toBe(correlation.traceparent);
      expect(request.headers.get('x-request-id')).toBe(correlation.requestId);
    });

    it(`reports ${name} as unusable when the answer is not this contract`, async () => {
      const fetchImplementation = vi.fn<typeof fetch>(async () =>
        jsonResponse({ ...record, schemaVersion: '2' }),
      );
      await expect(load({ baseUrl: BASE, fetch: fetchImplementation })).resolves.toEqual({
        failure: 'api-unusable',
        ok: false,
      });
    });

    it(`reports ${name} as unreachable when the request fails`, async () => {
      const fetchImplementation = vi.fn<typeof fetch>(async () =>
        Promise.reject(new Error('private-transport-marker')),
      );
      const outcome = await load({ baseUrl: BASE, fetch: fetchImplementation });
      expect(outcome).toEqual({ failure: 'transport', ok: false });
      // Nothing from the failure travels into the outcome.
      expect(JSON.stringify(outcome)).not.toContain('private-');
    });
  }
});

describe('a refusal the API published', () => {
  it.each([
    ['MN-READ-MODEL-NOT-PUBLISHED', 'read-model-not-published'],
    ['MN-READ-MODEL-UNREACHABLE', 'read-model-unreachable'],
    ['MN-READ-MODEL-INVALID', 'read-model-invalid'],
    ['MN-INTERNAL-ERROR', 'api-problem'],
  ])('maps %s to %s', async (errorCode, failure) => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => problem(errorCode));
    const outcome = await loadPaperBudget({ baseUrl: BASE, fetch: fetchImplementation });
    expect(outcome).toEqual({ failure, ok: false });
    // The problem document's own prose is not repeated to a reader.
    expect(JSON.stringify(outcome)).not.toContain('read model');
  });
});

describe('a bounded wait', () => {
  it('is unreachable rather than left open', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (input) =>
        new Promise<Response>((_resolve, reject) => {
          (input as Request).signal.addEventListener(
            'abort',
            () => reject(new Error('private-timeout-marker')),
            { once: true },
          );
        }),
    );

    const outcome = await loadMarketOverview({
      baseUrl: BASE,
      fetch: fetchImplementation,
      timeoutMs: 5,
    });
    expect(outcome).toEqual({ failure: 'transport', ok: false });
  });
});

describe('platformApiOrigin', () => {
  it('reads the configured origin', () => {
    expect(platformApiOrigin({ NODE_ENV: 'test' })).toBe('http://127.0.0.1:3001');
  });

  it('has no origin when this revision is misconfigured', () => {
    expect(
      platformApiOrigin({ NODE_ENV: 'production', PLATFORM_API_ORIGIN: 'not-an-origin' }),
    ).toBeUndefined();
  });
});

describe('the page compositions', () => {
  const env = { NODE_ENV: 'test' } as const;

  it('read the home page concurrently and keep each outcome separate', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const { url } = input as Request;
      if (url.endsWith('/v1/market/overview')) return jsonResponse(syntheticMarketOverview());
      if (url.endsWith('/v1/paper/budget')) return problem('MN-READ-MODEL-NOT-PUBLISHED');
      return jsonResponse(syntheticPaperPerformanceSummary());
    });

    const reads = await loadHomeReads({ env, fetch: fetchImplementation });

    expect(reads.market.ok).toBe(true);
    expect(reads.summary.ok).toBe(true);
    expect(reads.budget).toEqual({ failure: 'read-model-not-published', ok: false });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('read the performance page as a summary and a record', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) =>
      (input as Request).url.endsWith('/summary')
        ? jsonResponse(syntheticPaperPerformanceSummary())
        : jsonResponse(syntheticPaperPerformance()),
    );

    const reads = await loadPerformancePageReads({ env, fetch: fetchImplementation });

    expect(reads.summary.ok).toBe(true);
    expect(reads.record.ok).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('read one operation each for the budget and hourly pages', async () => {
    const budgetFetch = vi.fn<typeof fetch>(async () => jsonResponse(syntheticPaperBudget()));
    const hourlyFetch = vi.fn<typeof fetch>(async () => jsonResponse(syntheticHourlyThresholds()));

    await expect(loadBudgetPageRead({ env, fetch: budgetFetch })).resolves.toMatchObject({
      ok: true,
    });
    await expect(loadHourlyPageRead({ env, fetch: hourlyFetch })).resolves.toMatchObject({
      ok: true,
    });
    expect(budgetFetch).toHaveBeenCalledOnce();
    expect(hourlyFetch).toHaveBeenCalledOnce();
  });

  it('ask nothing at all when this revision has no usable configuration', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const misconfigured = { NODE_ENV: 'production', PLATFORM_API_ORIGIN: 'not-an-origin' };

    const home = await loadHomeReads({ env: misconfigured, fetch: fetchImplementation });
    const performance = await loadPerformancePageReads({
      env: misconfigured,
      fetch: fetchImplementation,
    });

    for (const outcome of [
      home.budget,
      home.market,
      home.summary,
      performance.record,
      performance.summary,
      await loadBudgetPageRead({ env: misconfigured, fetch: fetchImplementation }),
      await loadHourlyPageRead({ env: misconfigured, fetch: fetchImplementation }),
    ]) {
      expect(outcome).toEqual({ failure: 'transport', ok: false });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
