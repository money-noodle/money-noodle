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
import {
  krakenPair,
  settlementMetadata,
  createPublicForecastFeeds,
} from './adapters/feeds/forecast-feeds.js';
const NOW = new Date('2026-10-10T12:01:00Z');
const closes = Array.from({ length: 121 }, (_, i) => 100 * Math.exp(0.001 * Math.sin(i)));
function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    asset: 'BTC',
    calculatedAt: NOW.toISOString(),
    closesAt: '2026-10-10T12:15:00Z',
    referencePrice: 100,
    currentPrice: 101,
    coinPrice: 100,
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
  const cycle = new FakeCycleStore(
    [{ id: 'intent', action: 'resume', epoch: 1, capability: 'budget:paper', recordedAt: NOW }],
    now,
  );
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
        Math.min(0.04, (((i.high24h - i.low24h) / i.coinPrice) * 100) / 60),
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
      wrongAsset?: boolean;
      swapped?: boolean;
      invalidDate?: boolean;
      missingDate?: boolean;
      wrongPair?: boolean;
      stale?: boolean;
      actualClose?: string;
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
            [options.wrongPair ? 'ETHUSD' : 'XBTUSD']: Array.from({ length: 121 }, (_, i) => [
              slot - (options.stale ? 121 : 119 - i) * 60,
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
            slug: (options.wrongAsset ? 'eth' : 'btc') + '-updown-15m-' + slot,
            endDate: options.missingDate
              ? undefined
              : options.invalidDate
                ? 'invalid-date'
                : (options.actualClose ?? '2026-10-10T12:15:00Z'),
            markets: [
              {
                conditionId: 'synthetic-btc',
                acceptingOrders: true,
                outcomes: options.swapped ? '["Down","Up"]' : '["Up","Down"]',
                clobTokenIds: options.swapped ? '["down","up"]' : '["up","down"]',
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
                  ticker: 'KXBTC15M-test',
                  status: 'active',
                  close_time: options.actualClose ?? '2026-10-10T12:15:00Z',
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
  it.each([{ wrongPair: true }, { stale: true }])(
    'rejects wrong-pair or stale public series %j',
    async (options) => {
      expect(
        await createPublicForecastFeeds(request(options)).calculate(NOW, enabled, harness().store),
      ).toEqual([]);
    },
  );
  it('maps binary labels to token IDs instead of positional UP assumptions', async () => {
    const result = await createPublicForecastFeeds(request({ swapped: true })).calculate(
      NOW,
      ['polymarket'],
      harness().store,
    );
    expect(result[0]?.quotes[0]?.askUp).toBe(0.5);
    expect(result[0]?.quotes[0]?.askDown).toBe(0.51);
  });
  it.each([{ wrongAsset: true }, { invalidDate: true }, { missingDate: true }])(
    'rejects wrong or unproven venue targets %j',
    async (options) => {
      const result = await createPublicForecastFeeds(request(options)).calculate(
        NOW,
        ['polymarket'],
        harness().store,
      );
      expect(result[0]?.quotes).toEqual([]);
    },
  );
  it('retains an aligned Kalshi actual close four seconds before requested close', async () => {
    const result = await createPublicForecastFeeds(
      request({ kalshi: true, actualClose: '2026-10-10T12:14:56Z' }),
    ).calculate(NOW, ['kalshi'], harness().store);
    expect(result[0]?.closesAt).toBe('2026-10-10T12:14:56Z');
    expect(result[0]?.quotes[0]?.contract.closesAt).toBe('2026-10-10T12:14:56Z');
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

describe('independent review regression vectors F1/F5', () => {
  it('uses the qualified no-slash RSS origin and refuses input failure rather than manufacture data', async () => {
    const urls: string[] = [];
    const request: typeof fetch = async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('coindesk')) {
        expect(u).toBe('https://www.coindesk.com/arc/outboundfeeds/rss');
        throw Error('Synthetic unavailable news');
      }
      return new Response('[]');
    };
    await expect(
      createPublicForecastFeeds(request).calculate(NOW, enabled, harness().store),
    ).rejects.toThrow('Synthetic unavailable news');
    expect(urls).toContain('https://www.coindesk.com/arc/outboundfeeds/rss');
    const h = harness();
    h.feeds.calculate = async () => {
      throw Error('Synthetic acquisition failure');
    };
    await expect(h.job()).rejects.toThrow('Synthetic acquisition failure');
    expect(h.store.events).toHaveLength(0);
    expect(h.cycle.outcomes).toHaveLength(0);
  });
  it('uses CoinGecko price for confidence while retaining Kraken current for basis at the identity boundary', () => {
    const close = new Date(NOW.getTime() + 512000).toISOString();
    const i = input({
      coinPrice: 100,
      currentPrice: 99,
      high24h: 100.36,
      low24h: 99.64,
      minuteCloses: closes.slice(0, 12),
      closesAt: close,
      quotes: input().quotes.map((q) => ({
        ...q,
        askDown: 0.5,
        contract: { ...q.contract, closesAt: close },
      })),
    });
    const row = forecast(i, NOW, enabled)!;
    expect(row.confidence).toBeCloseTo(0.5000666666666667, 12);
    expect(row.qualified).toBe(true);
    expect(row.id.startsWith('calc:')).toBe(false);
    const counterfactual = forecast({ ...i, coinPrice: 99 }, NOW, enabled)!;
    expect(counterfactual.confidence).toBeCloseTo(0.4999454545454545, 12);
    expect(counterfactual.qualified).toBe(false);
    expect(counterfactual.id.startsWith('calc:')).toBe(true);
    expect(counterfactual.probabilityUp).toBe(row.probabilityUp);
  });
});

describe('independent review F3 malformed provenance', () => {
  it.each([
    { registryId: 'missing' },
    { venue: 'kalshi', contractId: 'wrong', closesAt: '2026-10-10T12:15:00Z' },
    { venue: 'polymarket', contractId: 'bad-date', closesAt: 'not-a-date' },
  ])(
    'invalidates local reference without a provider call and preserves restore origin',
    async (reference) => {
      const h = harness(),
        row = forecast(input(), NOW, enabled)!;
      row.venueContracts = { polymarket: reference as unknown as Contract };
      h.store.seed.set(row.id, { id: row.id, row, restoreRunId: 'synthetic-restore' });
      h.advance(15 * 60_000);
      h.feeds.calculate = async () => [];
      await h.job();
      expect(h.feeds.resolve).not.toHaveBeenCalled();
      expect(h.store.rows.get(row.id)).toMatchObject({
        restoreRunId: 'synthetic-restore',
        row: {
          status: 'invalid',
          targetIntegrity: 'missing-provenance',
          invalidReason: 'missing-provenance',
        },
      });
      expect(h.store.seed.get(row.id)?.row.status).toBe('pending');
    },
  );
});

describe('F2 issuance boundary rejection', () => {
  it('cannot issue after actual now passes close even when calculation start remains 15-second fresh', () => {
    const start = new Date(NOW.getTime() - 10000),
      close = new Date(NOW.getTime() - 1000).toISOString();
    const i = input({
      calculatedAt: start.toISOString(),
      closesAt: close,
      quotes: input().quotes.map((q) => ({ ...q, contract: { ...q.contract, closesAt: close } })),
    });
    expect(forecast(i, NOW, enabled)).toBeNull();
  });
});

describe('review F6/F7 rollback and effect-phase expiry', () => {
  it.each(['after-cycle', 'after-sample'] as const)(
    'publishes no fake transaction effects on %s failure',
    async (stage) => {
      const h = harness();
      h.store.failureAt = stage;
      await expect(h.job()).rejects.toThrow('Synthetic transaction failure');
      expect(h.store.cycles.size).toBe(0);
      expect(h.store.samples.size).toBe(0);
      expect(h.store.rows.size).toBe(0);
      expect(h.store.events).toHaveLength(0);
    },
  );
  it('rejects invalid sample before publishing any transaction state', async () => {
    const h = harness();
    h.feeds.calculate = async () => [input({ currentPrice: Infinity })];
    await expect(h.job()).rejects.toThrow('Oracle sample constraint');
    expect(h.store.cycles.size).toBe(0);
    expect(h.store.samples.size).toBe(0);
  });
  it('does not resolve after stalled empty calculation expires its owner', async () => {
    const h = harness(),
      row = forecast(input(), NOW, enabled)!;
    h.store.seed.set(row.id, { id: row.id, row, restoreRunId: 'synthetic-restore' });
    h.feeds.calculate = async () => {
      h.advance(120000);
      return [];
    };
    await expect(h.job()).rejects.toThrow('fence');
    expect(h.feeds.resolve).not.toHaveBeenCalled();
    expect(h.store.events).toHaveLength(0);
  });
  it('cannot revive an expired fake lease with heartbeat', async () => {
    const h = harness();
    const held = await h.cycle.acquireLease({
      capability: 'budget:paper',
      owner: 'expiry',
      now: h.now(),
      expiresAt: new Date(h.now().getTime() + 1000),
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) throw Error('acquisition failed');
    h.advance(1001);
    await expect(
      h.cycle.heartbeat(held.grant, h.now(), new Date(h.now().getTime() + 1000)),
    ).rejects.toThrow('lease');
  });
});

describe('F2 source pair and metadata boundaries', () => {
  it('ignores wrong first pair, rejects missing expected pair and error payload', () => {
    expect(krakenPair({ result: { ETHUSD: ['wrong'], XXBTZUSD: ['correct'] } }, 'XBTUSD')).toEqual([
      'correct',
    ]);
    expect(krakenPair({ result: { ETHUSD: ['wrong'] } }, 'XBTUSD')).toBeUndefined();
    expect(krakenPair({ error: ['bad'], result: { XBTUSD: [] } }, 'XBTUSD')).toBeUndefined();
  });
  it('keeps unknown oracle/window unknown and parses explicitly stated settlement metadata', () => {
    const unknown = settlementMetadata('Unspecified rules', 'https://example.invalid/rules');
    expect(unknown.settlementPriceMethod).toBe('unknown');
    expect(unknown.settlementWindowSeconds).toBeUndefined();
    expect(unknown.rulesFingerprint).toHaveLength(64);
    expect(
      settlementMetadata('Simple average of the final minute', 'https://example.invalid/rules'),
    ).toMatchObject({ settlementPriceMethod: 'simple-average', settlementWindowSeconds: 60 });
  });
  it('rejects stale, invalid and future source timestamps', () => {
    for (const sourceObservedAt of [
      'bad',
      new Date(NOW.getTime() - 90001).toISOString(),
      new Date(NOW.getTime() + 5001).toISOString(),
    ])
      expect(forecast(input({ sourceObservedAt }), NOW, enabled)).toBeNull();
  });
});
