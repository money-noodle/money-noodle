import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

describe('hourly threshold public service', () => {
  it('publishes ten planned subjects with research-only capability and exact BTC candidates', async () => {
    const now = Date.now();
    const openAt = new Date(now - 1_000).toISOString();
    const closesAt = new Date(now - 1_000 + 3_600_000).toISOString();
    const rows = (direction: 'ABOVE' | 'BELOW') => ({
      ticker: `KXBTC-TEST-T${direction === 'ABOVE' ? 120 : 80}`,
      status: 'active', market_type: 'binary', open_time: openAt, close_time: closesAt,
      floor_strike: direction === 'ABOVE' ? 120 : null,
      cap_strike: direction === 'BELOW' ? 80 : null,
      yes_bid_dollars: '0.01', yes_ask_dollars: '0.02', no_bid_dollars: '0.98', no_ask_dollars: '0.99',
      rules_primary: `The sixty-second average is ${direction === 'ABOVE' ? 'above 120' : 'below 80'}.`,
      rules_secondary: 'CF Benchmarks simple average of sixty prices.',
    });
    const closes = Array.from({ length: 30 }, (_, index) => [index, 0, 0, 0, 100 + Math.sin(index) * 0.2]);
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('series_ticker=KXBTC')) return json({ markets: [rows('ABOVE'), rows('BELOW')], cursor: '' });
      if (url.includes('api.elections.kalshi.com')) return json({ markets: [], cursor: '' });
      if (url.includes('api.kraken.com')) return json({ error: [], result: { XXBTZUSD: closes, last: 1 } });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;

    const { getHourlyThresholdMarkets } = await import('./hourly-threshold-market-service');
    const response = await getHourlyThresholdMarkets(true);
    expect(response.capability).toEqual({ marketData: true, paper: false, live: false });
    expect(response.markets).toHaveLength(10);
    const btc = response.markets.find((market) => market.symbol === 'BTC')!;
    expect(btc.marketDataAvailable).toBe(true);
    expect(btc.candidates).toEqual([
      expect.objectContaining({ direction: 'ABOVE', ticker: 'KXBTC-TEST-T120', yesAsk: 0.02 }),
      expect.objectContaining({ direction: 'BELOW', ticker: 'KXBTC-TEST-T80', yesAsk: 0.02 }),
    ]);
    expect(btc.candidates.every((candidate) => candidate.rulesFingerprint.length === 64)).toBe(true);
    expect(response.markets.find((market) => market.symbol === 'TON')).toMatchObject({
      marketDataAvailable: false, candidates: [], unavailableReason: expect.stringContaining('No active'),
    });
  });
});
