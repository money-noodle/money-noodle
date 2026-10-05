// The four routes, end to end, against a fetch the test provides.
//
// These exercise the real route modules — the same functions the server runs — so the
// composition, the configuration read and the rendering are all covered together. The
// unhappy paths matter most: a route that throws is a five hundred, and the container check
// in CI renders the home page with no API behind it at all.

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  syntheticHourlyThresholds,
  syntheticMarketOverview,
  syntheticPaperBudget,
  syntheticPaperPerformance,
  syntheticPaperPerformanceSummary,
} from '../presentation/synthetic-records.test';
import RootLayout, { metadata } from './layout';
import HourlyThresholdsPage from './market/hourly/page';
import PaperBudgetPage from './paper/budget/page';
import PaperPerformancePage from './paper/performance/page';
import HomePage from './page';

vi.mock('server-only', () => ({}));

const status = {
  asOf: '2026-10-05T19:30:00.000Z',
  requestId: 'synthetic-request',
  schemaVersion: '1',
  service: { name: 'platform-api', version: 'git-synthetic' },
  state: 'available',
};

function jsonResponse(body: unknown, httpStatus = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': httpStatus === 200 ? 'application/json' : 'application/problem+json',
    },
    status: httpStatus,
  });
}

/** Answers every operation these routes use, or refuses the ones the test names. */
function installFetch(refusals: Readonly<Record<string, Response>> = {}) {
  const implementation = vi.fn<typeof fetch>(async (input) => {
    const { url } = input as Request;
    for (const [path, response] of Object.entries(refusals)) {
      if (url.endsWith(path)) return response.clone();
    }
    if (url.endsWith('/v1/platform/status')) return jsonResponse(status);
    if (url.endsWith('/v1/market/overview')) return jsonResponse(syntheticMarketOverview());
    if (url.endsWith('/v1/market/hourly-thresholds')) {
      return jsonResponse(syntheticHourlyThresholds());
    }
    if (url.endsWith('/v1/paper/budget')) return jsonResponse(syntheticPaperBudget());
    if (url.endsWith('/v1/paper/performance/summary')) {
      return jsonResponse(syntheticPaperPerformanceSummary());
    }
    if (url.endsWith('/v1/paper/performance')) return jsonResponse(syntheticPaperPerformance());
    throw new Error(`unexpected read of ${url}`);
  });
  vi.stubGlobal('fetch', implementation);
  return implementation;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the home route', () => {
  it('renders the market data, the bankroll headline and the simulated record', async () => {
    const fetchImplementation = installFetch();

    const markup = renderToStaticMarkup(await HomePage());

    expect(markup).toContain('<h1>Money Noodle</h1>');
    expect(markup).toContain('Available');
    expect(markup).toContain('Synthcoin');
    expect(markup).toContain('$64,100.00');
    expect(markup).toContain('Recorded by the simulation at');
    expect(markup).toContain('2026-09-07T04:05:06.000Z');
    expect(markup).toContain('Research and observation only.');
    // Four independent reads, each exactly once.
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    const urls = fetchImplementation.mock.calls.map((call) => (call[0] as Request).url).sort();
    expect(urls).toEqual([
      'http://127.0.0.1:3001/v1/market/overview',
      'http://127.0.0.1:3001/v1/paper/budget',
      'http://127.0.0.1:3001/v1/paper/performance/summary',
      'http://127.0.0.1:3001/v1/platform/status',
    ]);
    for (const request of fetchImplementation.mock.calls) {
      expect((request[0] as Request).cache).toBe('no-store');
    }
  });

  it('renders every panel as unavailable when nothing answers, and does not throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => Promise.reject(new Error('private-transport-marker'))),
    );

    const markup = renderToStaticMarkup(await HomePage());

    expect(markup).toContain('Status unknown');
    expect(markup).toContain('could not reach the platform API');
    expect(markup).not.toContain('private-');
    expect(markup).not.toContain('Synthcoin');
    // Nothing is zeroed in place of the figures it could not read.
    expect(markup).not.toContain('$0.00');
  });

  it('keeps each read separate when only one is refused', async () => {
    installFetch({
      '/v1/paper/budget': jsonResponse(
        {
          errorCode: 'MN-READ-MODEL-NOT-PUBLISHED',
          requestId: 'api-request',
          status: 503,
          title: 'Service Unavailable',
          type: 'https://errors.noodle.money/mn-read-model-not-published',
        },
        503,
      ),
    });

    const markup = renderToStaticMarkup(await HomePage());

    expect(markup).toContain('This is not a zero balance');
    expect(markup).toContain('Synthcoin');
    expect(markup).toContain('58.3%');
  });

  it('reads nothing and renders unavailable when the revision is misconfigured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLATFORM_API_ORIGIN', 'not-an-origin');
    vi.stubEnv('ARTIFACT_VERSION', 'release-1.2.3');
    vi.stubEnv('MONEY_NOODLE_COMMIT', 'a'.repeat(40));
    vi.stubEnv('MONEY_NOODLE_SERVICE', 'web');
    vi.stubEnv('MONEY_NOODLE_ENVIRONMENT', 'production');
    const fetchImplementation = installFetch();

    const markup = renderToStaticMarkup(await HomePage());

    expect(markup).toContain('Status unknown');
    expect(markup).toContain('could not reach the platform API');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe('the paper budget route', () => {
  it('renders the record and its executions', async () => {
    installFetch();
    const markup = renderToStaticMarkup(await PaperBudgetPage());
    expect(markup).toContain('<h1>Simulated budget</h1>');
    expect(markup).toContain('Running after 2 bankroll resets');
    expect(markup).toContain('post only_race');
  });

  it('renders the refusal the API published', async () => {
    installFetch({
      '/v1/paper/budget': jsonResponse(
        {
          errorCode: 'MN-READ-MODEL-INVALID',
          requestId: 'api-request',
          status: 503,
          title: 'Service Unavailable',
          type: 'https://errors.noodle.money/mn-read-model-invalid',
        },
        503,
      ),
    });
    const markup = renderToStaticMarkup(await PaperBudgetPage());
    expect(markup).toContain('could not be read as this site expects');
    expect(markup).not.toContain('<table');
  });
});

describe('the paper performance route', () => {
  it('renders the summary and the full record server-side', async () => {
    const fetchImplementation = installFetch();
    const markup = renderToStaticMarkup(await PaperPerformancePage());
    expect(markup).toContain('<h1>Simulated record</h1>');
    expect(markup).toContain('<summary>Bankroll fundings</summary>');
    expect(markup).toContain('synthetic-epoch-2');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});

describe('the hourly thresholds route', () => {
  it('renders the contracts and the completed-minutes note', async () => {
    installFetch();
    const markup = renderToStaticMarkup(await HourlyThresholdsPage());
    expect(markup).toContain('<h1>Hourly thresholds</h1>');
    expect(markup).toContain('Completed minutes only.');
    expect(markup).toContain('Above 64000');
  });

  it('renders unavailable when the API answers with something else', async () => {
    installFetch({
      '/v1/market/hourly-thresholds': jsonResponse({
        ...syntheticHourlyThresholds(),
        marketId: 'crypto-15m',
      }),
    });
    const markup = renderToStaticMarkup(await HourlyThresholdsPage());
    expect(markup).toContain('a record this site does not recognise');
  });
});

describe('the document shell', () => {
  it('wraps content in the accessible English document', async () => {
    installFetch();
    const markup = renderToStaticMarkup(<RootLayout>{await HomePage()}</RootLayout>);
    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain('<body><main>');
    expect(metadata.title).toBe('Money Noodle');
  });
});
