// The four views, against every state a reader can land on.
//
// Rendered to static markup, which is what the server actually sends: these assertions are
// on the delivered document rather than on a component's props. The states that matter are
// the unhappy ones — a stale source, an unavailable source, each of the three refusals the
// API publishes, and this site not reaching the API at all — because those are the ones
// where a wrong presentation would invent a number.

import type { MarketOverview, MarketVenueQuote } from '@money-noodle/platform-api-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  HomeView,
  HourlyThresholdsPageView,
  PaperBudgetPageView,
  PaperPerformancePageView,
} from './dashboard-views';
import type { ReadFailureKind, ReadOutcome } from './read-outcome';
import {
  API_TIME,
  SOURCE_TIME,
  syntheticHourlyThresholds,
  syntheticMarketOverview,
  syntheticPaperBudget,
  syntheticPaperPerformance,
  syntheticPaperPerformanceSummary,
} from './synthetic-records.test';

const ok = <T,>(value: T): ReadOutcome<T> => ({ ok: true, value });
const failed = <T,>(failure: ReadFailureKind): ReadOutcome<T> => ({ failure, ok: false });

const STATUS = {
  asOf: API_TIME,
  serviceVersion: 'git-synthetic',
  state: 'available' as const,
};

const home = (overrides: Partial<Parameters<typeof HomeView>[0]> = {}) =>
  renderToStaticMarkup(
    HomeView({
      budget: ok(syntheticPaperBudget()),
      market: ok(syntheticMarketOverview()),
      status: STATUS,
      summary: ok(syntheticPaperPerformanceSummary()),
      ...overrides,
    }),
  );

describe('every view', () => {
  const views = [
    ['home', home()],
    ['budget', renderToStaticMarkup(PaperBudgetPageView({ budget: ok(syntheticPaperBudget()) }))],
    [
      'record',
      renderToStaticMarkup(
        PaperPerformancePageView({
          record: ok(syntheticPaperPerformance()),
          summary: ok(syntheticPaperPerformanceSummary()),
        }),
      ),
    ],
    [
      'hourly',
      renderToStaticMarkup(HourlyThresholdsPageView({ markets: ok(syntheticHourlyThresholds()) })),
    ],
  ] as const;

  for (const [name, markup] of views) {
    it(`${name} carries the research notice, the navigation and no inline styling`, () => {
      expect(markup).toContain('Research and observation only.');
      expect(markup).toContain('aria-label="Dashboard views"');
      expect(markup).toContain('aria-current="page"');
      expect(markup).toContain('<main>');
      // Status is never carried by colour alone, so no element needs its own style.
      expect(markup).not.toContain('style=');
    });

    it(`${name} gives every table a caption and every header a scope`, () => {
      const tables = markup.match(/<table[^>]*>/gu) ?? [];
      const captions = markup.match(/<caption[^>]*>/gu) ?? [];
      expect(captions.length).toBe(tables.length);
      const headers = markup.match(/<th(?![a-z])[^>]*>/gu) ?? [];
      expect(headers.length).toBeGreaterThan(0);
      for (const header of headers) expect(header).toContain('scope=');
    });
  }
});

describe('HomeView', () => {
  it('shows the market data the API published, per asset', () => {
    const markup = home();
    expect(markup).toContain('Synthcoin');
    expect(markup).toContain('$64,100.00');
    expect(markup).toContain('+1.25%');
    expect(markup).toContain('Polymarket');
    expect(markup).toContain('Kalshi');
    // Quotes as cents of a one-dollar settlement, and the basis inputs beside the result.
    expect(markup).toContain('54.0¢');
    expect(markup).toContain('Kraken 1m series at cycle open');
    expect(markup).toContain('7 min 30 s');
    expect(markup).toContain('A synthetic headline about a synthetic asset');
    // The sparkline is a real element with an accessible name.
    expect(markup).toContain('role="img"');
  });

  it('shows an asset the venues did not list as having no quote', () => {
    const markup = home();
    expect(markup).toContain('Quietcoin');
    expect(markup).toContain('Neither venue published a quote for the cycle now trading.');
    expect(markup).toContain('No spot snapshot was published for this asset.');
  });

  it('carries no forecast, signal or expected value, and nothing standing in for one', () => {
    const markup = home();
    for (const absent of [
      'Signal',
      'Expected value',
      'Policy manifest',
      'Coming soon',
      'Forecast panel',
      'Fill estimate',
      'Net edge',
      'Edge vs',
    ]) {
      expect(markup).not.toContain(absent);
    }
    // The absences are stated where a reader would look for the figure, rather than
    // filled with a panel implying data that does not exist yet.
    expect(markup).toContain('No placeholder quote is shown.');
  });

  it('states each source freshness beside the figures it governs', () => {
    expect(home()).toContain('Fresh: obtained 30 seconds ago.');
  });

  it('marks a stale source with its age and still shows its last good value', () => {
    const overview = syntheticMarketOverview();
    const markup = home({
      market: ok({
        ...overview,
        feeds: {
          ...overview.feeds,
          spot: {
            ageSeconds: 180,
            fetchedAt: '2026-10-05T19:27:00.000Z',
            reason: 'upstream-rate-limited',
            state: 'stale',
          },
        },
      }),
    });
    expect(markup).toContain('Stale: last obtained 3 minutes ago — the source declined for rate');
    expect(markup).toContain('$64,100.00');
  });

  it('shows an unavailable source as unavailable, not as zero or blank', () => {
    const overview = syntheticMarketOverview();
    const markup = home({
      market: ok({
        ...overview,
        assets: overview.assets.map((asset) => ({
          longHistory: [],
          name: asset.name,
          symbol: asset.symbol,
        })),
        feeds: Object.fromEntries(
          Object.keys(overview.feeds).map((feed) => [
            feed,
            { ageSeconds: 0, reason: 'upstream-unavailable', state: 'unavailable' },
          ]),
        ) as typeof overview.feeds,
        headlines: [],
      }),
    });
    expect(markup).toContain('No figures from this source are shown.');
    expect(markup).toContain('No headlines were published by the source.');
    expect(markup).not.toContain('$0.00');
    expect(markup).not.toContain('0.0%');
  });

  it('names each refusal the API can publish, and shows nothing in its place', () => {
    const expectations: readonly [ReadFailureKind, string][] = [
      ['read-model-not-published', 'This is not a zero balance'],
      ['read-model-unreachable', 'could not be reached just now'],
      ['read-model-invalid', 'could not be read as this site expects'],
      ['api-problem', 'refused this read'],
      ['api-unusable', 'a record this site does not recognise'],
      ['transport', 'could not reach the platform API'],
    ];

    for (const [failure, sentence] of expectations) {
      const markup = home({ budget: failed(failure), summary: failed(failure) });
      expect(markup).toContain(sentence);
      // The bankroll figures are gone rather than zeroed.
      expect(markup).not.toContain('$737.50');
    }
  });

  it('still renders every panel as unavailable when the API cannot be reached at all', () => {
    const markup = home({
      budget: failed('transport'),
      market: failed('transport'),
      status: undefined,
      summary: failed('transport'),
    });
    expect(markup).toContain('Status unknown');
    expect(markup).toContain('could not reach the platform API');
    expect(markup).not.toContain('Synthcoin');
  });
});

describe('PaperBudgetPageView', () => {
  it('shows the source time, the state and the balances', () => {
    const markup = renderToStaticMarkup(
      PaperBudgetPageView({ budget: ok(syntheticPaperBudget()) }),
    );
    expect(markup).toContain('Recorded by the simulation at');
    expect(markup).toContain(SOURCE_TIME);
    expect(markup).toContain('Running after 2 bankroll resets');
    expect(markup).toContain('$750.00');
    expect(markup).toContain('$737.50');
    expect(markup).toContain('-$12.50');
    expect(markup).toContain(
      'Equity reconciles with the starting balance plus realized profit and loss.',
    );
  });

  it('reports a reconciliation difference as computed here', () => {
    const markup = renderToStaticMarkup(
      PaperBudgetPageView({ budget: ok(syntheticPaperBudget({ equityCents: 74_000 })) }),
    );
    expect(markup).toContain('Equity does not reconcile');
    expect(markup).toContain('$2.50');
    expect(markup).toContain('computed here from the three figures above');
  });

  it('shows depleted over running, as the source orders them', () => {
    const markup = renderToStaticMarkup(
      PaperBudgetPageView({ budget: ok(syntheticPaperBudget({ depleted: true, running: true })) }),
    );
    expect(markup).toContain('Depleted');
  });

  it('shows idle when the bankroll is neither', () => {
    const markup = renderToStaticMarkup(
      PaperBudgetPageView({
        budget: ok(syntheticPaperBudget({ bankrollResets: 0, depleted: false, running: false })),
      }),
    );
    expect(markup).toContain('Idle');
    expect(markup).not.toContain('bankroll resets');
  });

  it('labels an execution by its no-fill reason and dashes what is not yet known', () => {
    const markup = renderToStaticMarkup(
      PaperBudgetPageView({ budget: ok(syntheticPaperBudget()) }),
    );
    expect(markup).toContain('post only_race');
    expect(markup).toContain('won');
    expect(markup).toContain('—');
  });

  it('says an empty execution list is an answer', () => {
    const markup = renderToStaticMarkup(
      PaperBudgetPageView({ budget: ok(syntheticPaperBudget({ recentExecutions: [] })) }),
    );
    expect(markup).toContain('An empty list beside a present budget record is a real answer');
  });
});

describe('PaperPerformancePageView', () => {
  const markup = renderToStaticMarkup(
    PaperPerformancePageView({
      record: ok(syntheticPaperPerformance()),
      summary: ok(syntheticPaperPerformanceSummary()),
    }),
  );

  it('shows both source times prominently', () => {
    expect(markup).toContain('Computed by the simulation at');
    expect(markup).toContain('Stored record last written at');
    expect(markup).toContain(SOURCE_TIME);
  });

  it('discloses the large sections rather than unrolling them', () => {
    for (const section of [
      'Accuracy by group',
      'Benchmarks and calibration',
      'Edge and segments',
      'Forecast timeline',
      'Simulated trade record',
      'Per-venue records',
      'Bankroll fundings',
      'Forecast history',
      'Cycle path diagnostics',
    ]) {
      expect(markup).toContain(`<summary>${section}</summary>`);
    }
    // Closed by default: no `open` attribute anywhere.
    expect(markup).not.toContain('<details open');
  });

  it('says where a list is bounded', () => {
    expect(markup).toContain('most recent of');
    expect(markup).toContain('published timeline points');
  });

  it('shows a null the source published as a dash, not a zero', () => {
    expect(markup).toContain('—');
    expect(markup).toContain('58.3%');
  });

  it('omits the diagnostics section when the source stored none', () => {
    const { cyclePaths, ...recordWithoutPaths } = syntheticPaperPerformance();
    expect(cyclePaths).toBeDefined();
    const withoutPaths = renderToStaticMarkup(
      PaperPerformancePageView({
        record: ok(recordWithoutPaths),
        summary: ok(syntheticPaperPerformanceSummary()),
      }),
    );
    expect(withoutPaths).not.toContain('Cycle path diagnostics');
  });

  it('reports each read separately', () => {
    const mixed = renderToStaticMarkup(
      PaperPerformancePageView({
        record: failed('read-model-invalid'),
        summary: ok(syntheticPaperPerformanceSummary()),
      }),
    );
    expect(mixed).toContain('58.3%');
    expect(mixed).toContain('could not be read as this site expects');
  });
});

describe('HourlyThresholdsPageView', () => {
  const markup = renderToStaticMarkup(
    HourlyThresholdsPageView({ markets: ok(syntheticHourlyThresholds()) }),
  );

  it('counts the assets with a complete pair', () => {
    expect(markup).toContain('1 of 2 assets have a complete pair');
  });

  it('says the price and volatility come from completed minutes only', () => {
    expect(markup).toContain('<strong>Completed minutes only.</strong>');
    expect(markup).toContain('the minute still forming is dropped');
    expect(markup).toContain('This is an intentional difference.');
  });

  it('shows each contract against its own strike and its own asking price', () => {
    expect(markup).toContain('Above 64000');
    expect(markup).toContain('Below 63500');
    expect(markup).toContain('$64,000.00');
    expect(markup).toContain('55.0¢');
    expect(markup).toContain('56.2%');
    expect(markup).toContain('+1.2 pp');
  });

  it('says why a contract has no model probability', () => {
    expect(markup).toContain('had no usable volatility estimate');
  });

  it('publishes the settlement terms behind a disclosure', () => {
    expect(markup).toContain('<summary>Settlement terms for these contracts</summary>');
    expect(markup).toContain('a'.repeat(64));
    expect(markup).toContain('a simple average over the stated window');
    expect(markup).toContain('not determined from the published rules');
  });

  it('names an unreadable listing in words, never as a code', () => {
    expect(markup).toContain('the venue did not answer in time');
    expect(markup).not.toContain('upstream-timeout');
    expect(markup).toContain('No complete pair for this asset.');
  });

  it('states observation only, with no simulated or funded position', () => {
    expect(markup).toContain('Observation only: market data, no simulated or funded position.');
  });

  it('reports a refused read instead of an empty table', () => {
    const refused = renderToStaticMarkup(
      HourlyThresholdsPageView({ markets: failed('api-unusable') }),
    );
    expect(refused).toContain('a record this site does not recognise');
    expect(refused).not.toContain('<table');
  });

  it('says so when the API published no assets', () => {
    const empty = renderToStaticMarkup(
      HourlyThresholdsPageView({ markets: ok(syntheticHourlyThresholds({ markets: [] })) }),
    );
    expect(empty).toContain('The API published no assets for this market.');
  });
});

describe('a record whose groups found nothing', () => {
  // The source publishes an empty array for a group it found no data for, which means
  // "nothing qualified" rather than "not computed". Each one has to say so rather than
  // rendering an empty table with headers and no rows.
  const record = syntheticPaperPerformance();
  const empty = renderToStaticMarkup(
    PaperPerformancePageView({
      record: ok({
        ...record,
        cyclePaths: { ...record.cyclePaths!, latestByAsset: [] },
        forecasts: [],
        paperEpochs: [],
        paperProviderRecords: [],
        paperRecord: { ...record.paperRecord, actionCounterfactuals: [], segments: [] },
        summary: {
          ...record.summary,
          benchmarks: [],
          byAsset: [],
          byConfidenceBucket: [],
          byDirection: [],
          byLeadTime: [],
          byModelVersion: [],
          calibrationBins: [],
          edgeBuckets: [],
          segments: [],
          timeline: [],
        },
      }),
      summary: ok(syntheticPaperPerformanceSummary()),
    }),
  );

  it('says nothing qualified for each group, rather than showing an empty table', () => {
    for (const sentence of [
      'By asset: nothing qualified.',
      'By direction: nothing qualified.',
      'No benchmarks published.',
      'No calibration bins published.',
      'No edge buckets published.',
      'No lead-time slices published.',
      'No segments published.',
      'No timeline published.',
      'No action comparisons published.',
      'No per-venue records published.',
      'No fundings published.',
      'The record carries no forecasts.',
      'No per-asset paths published.',
    ]) {
      expect(empty).toContain(sentence);
    }
  });
});

describe('the overview panels that depend on what the API published', () => {
  const overview = syntheticMarketOverview();

  it('shows a contracts volume in contracts when that is how the venue counts it', () => {
    const [covered, quiet] = overview.assets;
    const { volumeUsd, ...withoutUsd } = covered!.polymarket!;
    expect(volumeUsd).toBeDefined();
    const quote: MarketVenueQuote = withoutUsd;
    const assets: MarketOverview['assets'] = [{ ...covered!, polymarket: quote }, quiet!];
    const markup = home({ market: ok({ ...overview, assets }) });
    expect(markup).toContain('800 contracts');
  });

  it('says one venue is missing from a pair rather than implying a comparison', () => {
    const [covered, quiet] = overview.assets;
    const { kalshi, ...withoutKalshi } = covered!;
    expect(kalshi).toBeDefined();
    const assets: MarketOverview['assets'] = [withoutKalshi, quiet!];
    const markup = home({ market: ok({ ...overview, assets }) });
    expect(markup).toContain('the other published no contract settling in this window');
  });

  it('says so when the API published no assets', () => {
    const markup = home({ market: ok({ ...overview, assets: [] }) });
    expect(markup).toContain('The API published no assets for this market.');
  });

  it('shows the full forecast list on the record view and a link to it on the home view', () => {
    expect(home()).toContain('<a href="/paper/performance">simulated record</a>');
    const full = renderToStaticMarkup(
      PaperPerformancePageView({
        record: ok(syntheticPaperPerformance()),
        summary: ok(syntheticPaperPerformanceSummary()),
      }),
    );
    expect(full).toContain('forecasts the record publishes, newest first');
  });

  it('says a record with no recent forecasts has none', () => {
    const summary = syntheticPaperPerformanceSummary();
    const markup = renderToStaticMarkup(
      PaperPerformancePageView({
        record: ok(syntheticPaperPerformance()),
        summary: ok({ ...summary, summary: { ...summary.summary, recent: [] } }),
      }),
    );
    expect(markup).toContain('The record carries no forecasts.');
  });
});
