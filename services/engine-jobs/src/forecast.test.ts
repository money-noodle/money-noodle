import { describe, expect, it, vi } from 'vitest';
import {
  forecast,
  basisProbability,
  volatility,
  combinedProbability,
  normalProbability,
  bestEntry,
  observationIdentity,
  resolutionDue,
  resolveForecast,
  settlementProbability,
  type ForecastInput,
  type ForecastFeeds,
  type Contract,
} from './domain/forecast.js';
import { runCycleJob } from './application/cycle.js';
import { FakeCycleStore } from './adapters/engine-store/fake-cycle-store.js';
import { FakeForecastStore } from './adapters/engine-store/fake-forecast-store.js';
import { createPublicForecastFeeds } from './adapters/feeds/forecast-feeds.js';
const NOW = new Date('2026-10-10T12:01:00Z');
const closes = Array.from({ length: 121 }, (_, i) => 100 * Math.exp(0.001 * Math.sin(i)));
function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    asset: 'BTC',
    calculatedAt: NOW.toISOString(),
    closesAt: '2026-10-10T12:15:00Z',
    referencePrice: 100,
    currentPrice: 101,
    minuteCloses: closes,
    oracleHistory: [],
    change1h: 0.8,
    change24h: 1,
    change30d: 2,
    change1y: 10,
    high24h: 105,
    low24h: 95,
    seasonalReturns: [2, 3],
    newsScores: [0.5],
    relevantNewsCount: 1,
    quotes: [
      {
        contract: {
          venue: 'polymarket',
          contractId: 'synthetic-btc',
          closesAt: '2026-10-10T12:15:00Z',
          slug: 'btc-updown-15m-1791633600',
        },
        probabilityUp: 0.6,
        askUp: 0.5,
        askDown: 0.52,
      },
    ],
    ...overrides,
  };
}
const enabled = ['polymarket', 'kalshi'] as const;
function harness() {
  let time = new Date(NOW);
  const now = () => time;
  const cycle = new FakeCycleStore([
    { id: 'intent', action: 'resume', epoch: 1, capability: 'budget:paper', recordedAt: NOW },
  ]);
  const store = new FakeForecastStore(cycle, now);
  const feeds: ForecastFeeds = {
    calculate: vi.fn(async () => [input({ calculatedAt: now().toISOString() })]),
    resolve: vi.fn(async (c: Contract) => ({
      venue: c.venue,
      contractId: c.contractId,
      outcome: 'UP' as const,
    })),
  };
  return {
    cycle,
    store,
    feeds,
    now,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
    job: (id = 'run') =>
      runCycleJob({
        store: cycle,
        forecast: { store, feeds },
        mode: 'forecast',
        ticks: 4,
        runId: id,
        controlEpoch: 1,
        now,
        sleep: async (ms) => {
          time = new Date(time.getTime() + ms);
        },
      }),
  };
}
/** Independent transcription of historical equations. No archive import, data or private fixture. */
function historical(i: ForecastInput) {
  const clamp = (v: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));
  const log = (p: number) => Math.log(p / (1 - p));
  const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
  const returns = i.minuteCloses.slice(1).map((p, n) => Math.log(p / i.minuteCloses[n]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sigma =
    Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)) /
    Math.sqrt(60);
  const seconds = (Date.parse(i.closesAt) - Date.parse(i.calculatedAt)) / 1000,
    z =
      Math.log(i.currentPrice / i.referencePrice) / (sigma * Math.sqrt(Math.max(2, seconds - 30))),
    t = 1 / (1 + 0.2316419 * Math.abs(z)),
    tail =
      0.3989422804014327 *
      Math.exp((-z * z) / 2) *
      t *
      (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const basis = clamp(z >= 0 ? 1 - tail : tail, 0.05, 0.95);
  const avg = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const terms = [
    clamp((i.change1h * 0.7 + i.change24h * 0.3) / 2.5) *
      0.34 *
      clamp(0.5 + Math.abs(i.change1h) / 10, 0, 0.9),
    clamp(i.change30d / 20) * 0.06 * 0.5,
    clamp(i.change1y / 80) * 0.03 * 0.4,
    i.seasonalReturns.length >= 2
      ? clamp(avg(i.seasonalReturns) / 18) * 0.12 * clamp(i.seasonalReturns.length / 5, 0.35, 1)
      : 0,
    clamp(avg(i.newsScores)) *
      0.09 *
      (i.relevantNewsCount ? clamp(i.relevantNewsCount / 4, 0.25, 1) : 0.2),
  ].map((v) => v * 0.8);
  const slow = clamp(
    terms.reduce((a, b) => a + b, 0),
    -0.4,
    0.4,
  );
  return {
    basis,
    slow,
    p: clamp(sigmoid(log(basis) * 0.55 + slow), 0.03, 0.97),
    confidence: clamp(
      0.3 +
        0.2 +
        0.04 +
        Math.min(1, returns.length / 60) * 0.22 -
        Math.min(0.12, (seconds / 900) * 0.12) -
        Math.min(0.04, (((i.high24h - i.low24h) / i.currentPrice) * 100) / 60),
      0.25,
      0.86,
    ),
  };
}
describe('synthetic historical equation differential', () => {
  it('matches basis, blend, confidence, policy and candidate variants across a deterministic matrix', () => {
    for (const currentPrice of [98, 99.8, 100, 100.2, 102])
      for (const change1h of [-4, 0, 3])
        for (const seconds of [31, 60, 300, 840]) {
          const i = input({
            currentPrice,
            change1h,
            closesAt: new Date(NOW.getTime() + seconds * 1000).toISOString(),
            quotes: input().quotes.map((q) => ({
              ...q,
              contract: {
                ...q.contract,
                closesAt: new Date(NOW.getTime() + seconds * 1000).toISOString(),
              },
            })),
          });
          const expected = historical(i),
            row = forecast(i, NOW, enabled)!;
          expect(row.basisProbabilityUp).toBeCloseTo(expected.basis, 13);
          expect(row.slowTiltLogOdds).toBeCloseTo(expected.slow, 13);
          expect(row.probabilityUp).toBeCloseTo(expected.p, 13);
          expect(row.confidence).toBeCloseTo(expected.confidence, 13);
          expect(row.candidateEvaluation[0]?.probabilityUp).toBe(row.probabilityUp);
          expect(row.candidateEvaluation[1]?.probabilityUp).toBeCloseTo(
            combinedProbability(expected.basis, expected.slow, 0.65, 0.5),
            13,
          );
          // The final-minute distribution requires actual observed prices.
          // These synthetic matrix inputs deliberately have no such observations.
          if (seconds < 60) expect(row.candidateEvaluation[2]?.probabilityUp).toBeNull();
          else expect(row.candidateEvaluation[2]?.probabilityUp).not.toBeNull();
          expect(row.candidateEvaluation[3]?.probabilityUp).toBeCloseTo(
            combinedProbability(expected.basis, 0),
            13,
          );
          const selected = bestEntry(row.probabilityUp, i.quotes);
          expect(row.qualified).toBe(
            row.confidence >= 0.5 && selected !== undefined && selected.netEdge >= 0.05,
          );
        }
  });
  it('cannot feed venue prices or candidates back into production probability', () => {
    const i = input(),
      a = forecast(i, NOW, enabled)!,
      b = forecast(
        { ...i, quotes: i.quotes.map((q) => ({ ...q, probabilityUp: 0.01, askUp: 0.7 })) },
        NOW,
        enabled,
      )!;
    expect(a.probabilityUp).toBe(b.probabilityUp);
    a.candidateEvaluation[0]!.probabilityUp = 0.01;
    expect(forecast(i, NOW, enabled)!.probabilityUp).toBe(a.probabilityUp);
  });
  it('bounds probabilities and fails closed for unavailable volatility, stale and misaligned sources', () => {
    expect(normalProbability(Infinity)).toBe(1);
    expect(normalProbability(-Infinity)).toBe(0);
    expect(volatility([], 60)).toBeNull();
    expect(volatility(Array(12).fill(100), 60)).toBeNull();
    expect(basisProbability(0, 100, 60, 1)).toBeNull();
    expect(
      forecast(
        input({ calculatedAt: new Date(NOW.getTime() - 15001).toISOString() }),
        NOW,
        enabled,
      ),
    ).toBeNull();
    expect(
      forecast(input({ calculatedAt: new Date(NOW.getTime() + 1).toISOString() }), NOW, enabled),
    ).toBeNull();
    expect(forecast(input(), NOW, [])).toBeNull();
    expect(forecast(input({ quotes: [] }), NOW, enabled)).toBeNull();
    expect(forecast(input({ change1h: NaN }), NOW, enabled)).toBeNull();
    expect(forecast(input({ minuteCloses: [] }), NOW, enabled)?.qualified).toBe(false);
  });
  it('models future and partially observed settlement without replacing production', () => {
    const i = input({ closesAt: new Date(NOW.getTime() + 30_000).toISOString() });
    expect(settlementProbability(i, NOW.getTime(), 0.001)).toBeNull();
    const observed = {
      ...i,
      oracleHistory: [
        { time: NOW.getTime() - 31_000, price: 100 },
        { time: NOW.getTime() - 10_000, price: 101 },
      ],
    };
    expect(settlementProbability(observed, NOW.getTime(), 0.001)).toBeGreaterThan(0.5);
    expect(settlementProbability({ ...i, referencePrice: 0 }, NOW.getTime(), 1)).toBeNull();
  });
  it('uses independent asks and exact taker fees, not complement of UP ask', () => {
    const q = input().quotes[0]!;
    expect(bestEntry(0.2, [{ ...q, askUp: 0.9, askDown: 0.1 }])).toMatchObject({
      side: 'DOWN',
      price: 0.1,
      feeRate: 0.001,
    });
    expect(
      bestEntry(0.9, [{ ...q, contract: { ...q.contract, venue: 'kalshi' }, askUp: 0.5 }])?.feeRate,
    ).toBeCloseTo(0.0175);
    expect(bestEntry(0.5, [{ ...q, askUp: null, askDown: null }])).toBeUndefined();
  });
});
describe('durable ownership and observation identity', () => {
  it('records four qualified 15-second observations within one asset/close cycle and retries no run', async () => {
    const h = harness();
    expect((await h.job()).reason).toBe('forecast-run');
    expect(h.store.rows.size).toBe(4);
    expect(h.store.cycles.size).toBe(1);
    const before = h.store.events.length;
    expect((await h.job()).reason).toBe('run-already-recorded');
    expect(h.store.events).toHaveLength(before);
  });
  it('drops a duplicate observation across distinct run ids while retaining minute calculations', async () => {
    const h = harness();
    await h.job();
    await runCycleJob({
      store: h.cycle,
      forecast: { store: h.store, feeds: h.feeds },
      mode: 'forecast',
      ticks: 1,
      runId: 'other-run',
      controlEpoch: 1,
      now: h.now,
      sleep: async () => {},
    });
    expect(h.store.rows.size).toBe(4);
    expect(observationIdentity('c', NOW.getTime(), false)).toBe(
      observationIdentity('c', NOW.getTime() + 15000, false),
    );
    expect(observationIdentity('c', NOW.getTime(), true)).not.toBe(
      observationIdentity('c', NOW.getTime() + 15000, true),
    );
  });
  it.each(['missing', 'pause', 'epoch'] as const)(
    'does not call providers or mutate forecasts when %s',
    async (kind) => {
      const h = harness();
      if (kind === 'missing') h.cycle.intents.length = 0;
      else if (kind === 'pause') h.cycle.intents[0] = { ...h.cycle.intents[0]!, action: 'pause' };
      else h.cycle.intents[0] = { ...h.cycle.intents[0]!, epoch: 2 };
      expect((await h.job()).outcome).toBe('refused');
      expect(h.feeds.calculate).not.toHaveBeenCalled();
      expect(h.store.events).toHaveLength(0);
    },
  );
  it('dry lane never reaches providers and paper remains refused', async () => {
    for (const mode of ['dry', 'paper'] as const) {
      const h = harness();
      const r = await runCycleJob({
        store: h.cycle,
        forecast: { store: h.store, feeds: h.feeds },
        mode,
        ticks: 1,
        runId: 'r',
        controlEpoch: 1,
        now: h.now,
        sleep: async () => {},
      });
      expect(r.reason).toBe(mode === 'dry' ? 'dry-run' : 'mode-not-implemented');
      expect(h.feeds.calculate).not.toHaveBeenCalled();
    }
  });
  it('refuses lease expiry after network work and token takeover before mutation', async () => {
    const h = harness();
    h.feeds.calculate = async () => {
      h.advance(120_000);
      return [input({ calculatedAt: h.now().toISOString() })];
    };
    await expect(h.job()).rejects.toThrow('fence');
    expect(h.store.rows.size).toBe(0);
    const b = harness();
    b.feeds.calculate = async () => {
      b.cycle.leases.get('budget:paper')!.fencingToken += 1;
      return [input()];
    };
    await expect(b.job()).rejects.toThrow('fence');
    expect(b.store.events.length).toBe(0);
  });
  it('preserves restored seed and restore origin while writing a terminal overlay', async () => {
    const h = harness(),
      row = forecast(
        input({
          closesAt: new Date(NOW.getTime() + 1000).toISOString(),
          quotes: input().quotes.map((q) => ({
            ...q,
            contract: { ...q.contract, closesAt: new Date(NOW.getTime() + 1000).toISOString() },
          })),
        }),
        NOW,
        enabled,
      )!;
    h.store.seed.set(row.id, { id: row.id, row, restoreRunId: 'synthetic-restore' });
    h.advance(2000);
    h.feeds.calculate = async () => [];
    await h.job();
    expect(h.store.seed.get(row.id)?.row.status).toBe('pending');
    expect(h.store.rows.get(row.id)).toMatchObject({
      restoreRunId: 'synthetic-restore',
      row: { status: 'resolved', outcome: 'UP' },
    });
    const original = h.store.seed.get(row.id)!;
    const grant = { ...h.cycle.leases.get('budget:paper')! };
    await expect(h.store.patchForecast(grant, original, row)).rejects.toThrow('fence');
  });
});
describe('venue-specific resolution', () => {
  it('scores exact contract outcomes and forbids cross-venue or contract substitution', () => {
    const row = forecast(input(), NOW, enabled)!;
    const now = new Date('2026-10-10T12:16:00Z');
    const resolved = resolveForecast(
      row,
      { venue: 'polymarket', contractId: 'synthetic-btc', outcome: 'UP' },
      now,
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.brierScore).toBeCloseTo((row.probabilityUp - 1) ** 2);
    expect(resolved.realizedReturn).toBeCloseTo(1 - row.entryAsk! - row.entryFeeRate!);
    expect(
      resolveForecast(row, { venue: 'kalshi', contractId: 'synthetic-btc', outcome: 'UP' }, now)
        .status,
    ).toBe('invalid');
    expect(
      resolveForecast(row, { venue: 'polymarket', contractId: 'other', outcome: 'UP' }, now)
        .targetIntegrity,
    ).toBe('mismatched-outcome');
    expect(resolveForecast({ ...row, entryVenue: 'kalshi' }, null, now).targetIntegrity).toBe(
      'missing-provenance',
    );
    expect(resolveForecast({ ...row, venueContracts: {} }, null, now).targetIntegrity).toBe(
      'legacy-polymarket',
    );
  });
  it('backs off pending outcomes, invalidates abandoned/unsupported outcomes without fabricated scores', () => {
    const row = forecast(input(), NOW, enabled)!,
      now = new Date('2026-10-10T12:16:00Z'),
      pending = resolveForecast(row, null, now);
    expect(pending.resolutionAttempts).toBe(1);
    expect(resolutionDue(pending, now)).toBe(false);
    expect(resolutionDue(pending, new Date(now.getTime() + 60000))).toBe(true);
    expect(resolveForecast(row, null, new Date('2026-10-10T18:15:00Z')).status).toBe('invalid');
    expect(
      resolveForecast(
        row,
        { venue: 'polymarket', contractId: 'synthetic-btc', invalidReason: 'non-binary' },
        now,
      ).status,
    ).toBe('invalid');
    expect(resolutionDue({ ...row, status: 'resolved' }, now)).toBe(false);
    expect(row.status).toBe('pending');
  });
  it('deduplicates contract requests over all four observations and awaits completion', async () => {
    const h = harness();
    await h.job();
    h.advance(15 * 60_000);
    h.feeds.calculate = async () => [];
    await h.job('resolution');
    expect(h.feeds.resolve).toHaveBeenCalledTimes(1);
    expect([...h.store.rows.values()].every((r) => r.row.status === 'resolved')).toBe(true);
  });
});
describe('public provider adapter fixed-origin isolation', () => {
  it('returns no feed calls when every persisted provider is disabled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await createPublicForecastFeeds(fetcher).calculate(NOW, [], harness().store)).toEqual(
      [],
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('resolves only the issuance contract and encodes identifiers', async () => {
    const urls: string[] = [];
    const request: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify([
          {
            closed: true,
            markets: [
              { conditionId: 'other', outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' },
            ],
          },
        ]),
      );
    };
    const c: Contract = {
      venue: 'polymarket',
      contractId: 'selected',
      closesAt: NOW.toISOString(),
      slug: '../example?token=synthetic',
    };
    expect(await createPublicForecastFeeds(request).resolve(c)).toBeNull();
    expect(urls[0]).toContain(encodeURIComponent(c.slug));
  });
  it.each(['yes', 'no', 'invalid', ''])('uses Kalshi exact result %s', async (result) => {
    const request: typeof fetch = async () =>
      new Response(JSON.stringify({ market: { ticker: 'test', status: 'finalized', result } }));
    const outcome = await createPublicForecastFeeds(request).resolve({
      venue: 'kalshi',
      contractId: 'test',
      slug: 'test',
      closesAt: NOW.toISOString(),
    });
    expect(outcome?.outcome).toBe(result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : undefined);
    if (result === 'invalid') expect(outcome?.invalidReason).toBeDefined();
    if (!result) expect(outcome).toBeNull();
  });
});

describe('synthetic public calculation response matrix', () => {
  const slot = Math.floor(NOW.getTime() / 900000) * 900;
  function request(
    options: {
      badReference?: boolean;
      missingBook?: boolean;
      nonBinary?: boolean;
      kalshi?: boolean;
      weekly?: boolean;
    } = {},
  ): typeof fetch {
    return async (url) => {
      const u = String(url);
      let value: unknown;
      if (u.includes('coindesk'))
        return new Response(
          '<rss><item><title><![CDATA[Bitcoin rally &amp; growth]]></title></item><item><title>Bitcoin risk</title></item></rss>',
        );
      if (u.includes('coingecko'))
        value = [
          {
            id: 'bitcoin',
            price_change_percentage_1h_in_currency: 1,
            price_change_percentage_24h_in_currency: 2,
            price_change_percentage_30d_in_currency: 3,
            price_change_percentage_1y_in_currency: 4,
            high_24h: 104,
            low_24h: 96,
          },
        ];
      else if (u.includes('Ticker')) value = { result: { XBTUSD: { c: ['101'] } } };
      else if (u.includes('interval=10080'))
        value = {
          result: {
            XBTUSD: options.weekly
              ? Array.from({ length: 6 }, (_, i) => [
                  Date.parse(
                    (i < 3 ? '2024' : '2025') +
                      '-10-' +
                      String((i % 3) * 7 + 1).padStart(2, '0') +
                      'T00:00:00Z',
                  ) / 1000,
                  0,
                  0,
                  0,
                  100 + i,
                ])
              : [],
          },
        };
      else if (u.includes('OHLC'))
        value = {
          result: {
            last: 1,
            XBTUSD: Array.from({ length: 121 }, (_, i) => [
              slot - (121 - i) * 60,
              0,
              0,
              0,
              options.badReference ? 0 : closes[i],
            ]),
          },
        };
      else if (u.includes('gamma-api'))
        value = [
          {
            slug: 'btc-updown-15m-' + slot,
            endDate: '2026-10-10T12:15:00Z',
            markets: [
              {
                conditionId: 'synthetic-btc',
                acceptingOrders: true,
                clobTokenIds: '["up","down"]',
                outcomePrices: '["0.6","0.4"]',
              },
            ],
          },
        ];
      else if (u.includes('/books'))
        value = options.missingBook
          ? []
          : [
              { asset_id: 'up', asks: [{ price: '0.5' }, { price: '0.6' }] },
              { asset_id: 'down', asks: [{ price: '0.51' }] },
            ];
      else if (u.includes('kalshi'))
        value = {
          markets: options.kalshi
            ? [
                {
                  ticker: 'KXBTC-test',
                  status: 'active',
                  close_time: '2026-10-10T12:15:00Z',
                  yes_bid_dollars: '0.49',
                  yes_ask_dollars: '0.5',
                  no_ask_dollars: '0.52',
                },
              ]
            : [],
        };
      return new Response(JSON.stringify(value));
    };
  }
  it('combines bounded public spot, candles, news, annual seasonality and aligned two-venue asks', async () => {
    const result = await createPublicForecastFeeds(
      request({ kalshi: true, weekly: true }),
    ).calculate(NOW, enabled, harness().store);
    expect(result).toHaveLength(1);
    expect(result[0]?.asset).toBe('BTC');
    expect(result[0]?.quotes).toHaveLength(2);
    expect(result[0]?.seasonalReturns).toHaveLength(2);
    expect(result[0]?.newsScores).toEqual([1, -0.5]);
    expect(forecast(result[0]!, NOW, enabled)?.candidateEvaluation).toHaveLength(6);
  });
  it('does not manufacture reference or asks when provider evidence is missing', async () => {
    expect(
      await createPublicForecastFeeds(request({ badReference: true })).calculate(
        NOW,
        enabled,
        harness().store,
      ),
    ).toEqual([]);
    const result = await createPublicForecastFeeds(request({ missingBook: true })).calculate(
      NOW,
      ['polymarket'],
      harness().store,
    );
    expect(result[0]?.quotes[0]?.askUp).toBeNull();
    expect(result[0]?.quotes[0]?.askDown).toBeNull();
  });
  it('retains unavailable-provider failures and non-binary outcomes without substitution', async () => {
    const error: typeof fetch = async () => new Response('', { status: 503 });
    await expect(
      createPublicForecastFeeds(error).calculate(NOW, enabled, harness().store),
    ).rejects.toThrow();
    await expect(
      createPublicForecastFeeds(error).resolve({
        venue: 'polymarket',
        contractId: 'test',
        slug: 'test',
        closesAt: NOW.toISOString(),
      }),
    ).rejects.toThrow();
    const poly: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            closed: true,
            markets: [
              {
                conditionId: 'test',
                umaResolutionStatus: 'resolved',
                outcomes: '["Up","Down"]',
                outcomePrices: '["0.5","0.5"]',
              },
            ],
          },
        ]),
      );
    expect(
      await createPublicForecastFeeds(poly).resolve({
        venue: 'polymarket',
        contractId: 'test',
        slug: 'test',
        closesAt: NOW.toISOString(),
      }),
    ).toMatchObject({ invalidReason: 'non-binary-outcome' });
  });
});
