// The feed port end to end, over a fetch the test owns.
//
// This is the only test that exercises the whole path — URL, HTTP client, reader,
// cache, reading — and it is where the states a caller can observe are pinned down:
// fresh, stale inside the limit, dropped past it, and the three refusals. Every
// payload is synthetic and every call is routed to this fake: a test run reaches no
// provider, which is also why none of these fixtures contains real market data.

import { describe, expect, it, vi } from 'vitest';

import { FEED_MAX_STALE_MS, OVERVIEW_ASSETS, MARKET_ASSETS } from '../../domain/market-registry.js';
import { createMarketFeeds } from './create-market-feeds.js';
import { createFeedCache } from './feed-cache.js';
import { createFeedHttpClient } from './feed-http-client.js';

const bitcoin = MARKET_ASSETS[0]!;
const ethereum = MARKET_ASSETS[1]!;
const AT_MS = Date.UTC(2026, 9, 5, 18, 7, 30);
const SLOT_SECONDS = Math.floor(Date.UTC(2026, 9, 5, 18, 0, 0) / 1000);

type Mode = 'down' | 'malformed' | 'ok' | 'rate-limited' | 'timeout';

/** One-minute candles ending with the minute still forming, newest last. */
const minuteCandles = (): unknown[] =>
  Array.from({ length: 40 }, (_, index) => {
    const startSeconds = SLOT_SECONDS - 60 * (38 - index);
    const close = 64_000 + (index % 2 === 0 ? 0 : 25);
    return [startSeconds, '1', '1', '1', String(close), '1', '1.5', 7];
  });

const payloadFor = (url: string): unknown => {
  if (url.includes('api.kraken.com') && url.includes('Ticker')) {
    return { error: [], result: { XXBTZUSD: { c: ['64120.5', '0.1'] } } };
  }
  if (url.includes('api.kraken.com') && url.includes('interval=10080')) {
    return {
      error: [],
      result: { XXBTZUSD: [[1_758_412_800, '1', '1', '1', '61000', '1', '1', 1]], last: 1 },
    };
  }
  if (url.includes('api.kraken.com')) {
    return { error: [], result: { XXBTZUSD: minuteCandles(), last: SLOT_SECONDS } };
  }
  if (url.includes('api.coingecko.com')) {
    return [
      {
        current_price: 64_100,
        id: 'bitcoin',
        price_change_percentage_24h_in_currency: 1.25,
        sparkline_in_7d: { price: [63_000, 64_000] },
      },
    ];
  }
  if (url.includes('gamma-api.polymarket.com')) {
    return url.includes(`btc-updown-15m-${SLOT_SECONDS}`)
      ? [
          {
            endDate: '2026-10-05T18:15:00.000Z',
            id: 'event-1',
            markets: [
              {
                acceptingOrders: true,
                clobTokenIds: '["token-up","token-down"]',
                conditionId: '0xcondition',
                liquidityNum: 90_000,
                outcomePrices: '["0.53","0.47"]',
                volumeNum: 450_000,
              },
            ],
            slug: `btc-updown-15m-${SLOT_SECONDS}`,
          },
        ]
      : [];
  }
  if (url.includes('series_ticker=KXBTC15M')) {
    return {
      cursor: '',
      markets: [
        {
          close_time: '2026-10-05T18:15:00.000Z',
          floor_strike: 64_000,
          rules_primary: 'Resolves Yes if the settlement price is above the strike.',
          status: 'active',
          ticker: 'KXBTC15M-26OCT0518',
          yes_ask_dollars: '0.50',
          yes_bid_dollars: '0.48',
        },
      ],
    };
  }
  if (url.includes('series_ticker=KXBTC&')) {
    return {
      cursor: '',
      markets: [
        {
          close_time: '2026-10-05T19:00:00.000Z',
          floor_strike: 64_000,
          market_type: 'binary',
          open_time: '2026-10-05T18:00:00.000Z',
          rules_primary: 'Resolves Yes if the settlement price is above the strike.',
          status: 'active',
          ticker: 'KXBTC-26OCT0519-T64000',
          yes_ask_dollars: '0.55',
        },
        {
          cap_strike: 63_500,
          close_time: '2026-10-05T19:00:00.000Z',
          market_type: 'binary',
          open_time: '2026-10-05T18:00:00.000Z',
          rules_primary: 'Resolves Yes if the settlement price is below the strike.',
          status: 'active',
          ticker: 'KXBTC-26OCT0519-T63500',
        },
      ],
    };
  }
  if (url.includes('api.elections.kalshi.com')) return { cursor: '', markets: [] };
  if (url.includes('clob.polymarket.com')) {
    return [{ asks: [{ price: '0.55' }], asset_id: 'token-up', bids: [{ price: '0.53' }] }];
  }
  return undefined;
};

const RSS =
  '<rss><channel><item><title>A story</title>' +
  '<link>https://news.example.com/a</link>' +
  '<pubDate>Sun, 05 Oct 2026 17:00:00 GMT</pubDate></item></channel></rss>';

/** A fetch that answers every URL this port uses, in whichever mode it is set to. */
function router() {
  const state = { mode: 'ok' as Mode, only: undefined as string | undefined };
  const calls: string[] = [];

  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const failing = state.only === undefined || url.includes(state.only);
    if (failing && state.mode !== 'ok') {
      if (state.mode === 'rate-limited') return new Response('slow down', { status: 429 });
      if (state.mode === 'down') return new Response('nope', { status: 503 });
      if (state.mode === 'malformed') return new Response('<html>not json</html>');
      const timeout = new Error('socket hang up to a host nobody should see');
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    if (url.includes('coindesk.com')) return new Response(RSS);
    return new Response(JSON.stringify(payloadFor(url)));
  });

  return {
    calls,
    fetch: fetch as unknown as typeof globalThis.fetch,
    set: (mode: Mode, only?: string) => {
      state.mode = mode;
      state.only = only;
    },
  };
}

function harness() {
  const route = router();
  let nowMs = AT_MS;
  const clock = { now: () => new Date(nowMs) };
  const feeds = createMarketFeeds({
    cache: createFeedCache({ clock }),
    clock,
    http: createFeedHttpClient({ fetch: route.fetch }),
  });
  return {
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
    feeds,
    route,
  };
}

describe('createMarketFeeds', () => {
  it('reads every feed fresh from the public endpoints', async () => {
    const { feeds, route } = harness();

    const spot = await feeds.readSpotSnapshots();
    const polymarket = await feeds.readPolymarketQuotes();
    const kalshi = await feeds.readKalshiQuotes();
    const prices = await feeds.readCyclePrices();
    const history = await feeds.readLongHistory();
    const headlines = await feeds.readHeadlines();
    const hourly = await feeds.readHourlyThresholds(bitcoin);
    const closes = await feeds.readMinuteCloses(bitcoin);

    expect(spot.state).toBe('fresh');
    expect(spot.value?.get('BTC')?.price).toBe(64_100);
    expect(polymarket.value?.get('BTC')?.probabilityUp).toBeCloseTo(0.53, 12);
    // The book batch filled the prices the event call cannot carry.
    expect(polymarket.value?.get('BTC')?.bidUp).toBe(0.53);
    expect(kalshi.value?.get('BTC')?.ticker).toBe('KXBTC15M-26OCT0518');
    expect(prices.value?.get('BTC')?.referencePrice).toBeGreaterThan(0);
    expect(prices.value?.get('BTC')?.currentPrice).toBe(64_120.5);
    expect(history.value?.get('BTC')).toHaveLength(1);
    expect(headlines.value?.[0]?.title).toBe('A story');
    expect(hourly.value?.rows).toHaveLength(2);
    expect(closes.value?.length).toBe(39);

    // Everything above is public and keyless.
    for (const url of route.calls) expect(url).not.toMatch(/key=|token=|signature|nonce/iu);
  });

  it('reads the minute series once for both the reference and the volatility', async () => {
    const { feeds, route } = harness();
    await feeds.readCyclePrices();
    const before = route.calls.filter((url) => url.includes('interval=1')).length;
    await feeds.readMinuteCloses(bitcoin);
    expect(route.calls.filter((url) => url.includes('interval=1'))).toHaveLength(before);
  });

  it('serves the stored value inside its lifetime and joins concurrent readers', async () => {
    const { feeds, route } = harness();
    await feeds.readSpotSnapshots();
    await feeds.readSpotSnapshots();
    await Promise.all([feeds.readSpotSnapshots(), feeds.readSpotSnapshots()]);
    expect(route.calls.filter((url) => url.includes('coingecko'))).toHaveLength(1);
  });

  const refusals: readonly [Mode, string][] = [
    ['rate-limited', 'upstream-rate-limited'],
    ['timeout', 'upstream-timeout'],
    ['malformed', 'upstream-invalid'],
    ['down', 'upstream-unavailable'],
  ];

  for (const [mode, reason] of refusals) {
    it(`publishes ${reason} with no value when the upstream is ${mode} on a cold cache`, async () => {
      const { feeds, route } = harness();
      route.set(mode);

      const spot = await feeds.readSpotSnapshots();
      const hourly = await feeds.readHourlyThresholds(bitcoin);

      expect(spot).toEqual({
        ageSeconds: 0,
        fetchedAt: new Date(AT_MS),
        reason,
        state: 'unavailable',
      });
      expect(spot.value).toBeUndefined();
      expect(hourly.reason).toBe(reason);
      // Nothing the upstream said travels: not its message, not its host, not a status.
      expect(JSON.stringify([spot, hourly])).not.toMatch(/socket hang up|503|html|coingecko/u);
    });
  }

  it('serves the last good value marked stale, with its age', async () => {
    const { advance, feeds, route } = harness();
    await feeds.readSpotSnapshots();

    route.set('timeout');
    advance(120_000);
    const stale = await feeds.readSpotSnapshots();

    expect(stale.state).toBe('stale');
    expect(stale.ageSeconds).toBe(120);
    expect(stale.reason).toBe('upstream-timeout');
    expect(stale.value?.get('BTC')?.price).toBe(64_100);
  });

  it('drops the value once it is older than the limit', async () => {
    const { advance, feeds, route } = harness();
    await feeds.readSpotSnapshots();

    route.set('down');
    advance(FEED_MAX_STALE_MS + 1_000);
    const expired = await feeds.readSpotSnapshots();

    expect(expired.state).toBe('unavailable');
    expect(expired.value).toBeUndefined();
  });

  it('loses one asset rather than the feed when one call fails', async () => {
    const { feeds, route } = harness();
    route.set('down', ethereum.krakenPair);

    const prices = await feeds.readCyclePrices();

    // The asset that answered is published; the feed says it is not fully fresh.
    expect(prices.value?.has('BTC')).toBe(true);
    expect(prices.value?.has('ETH')).toBe(false);
    expect(prices.state).toBe('stale');
    expect(prices.reason).toBe('upstream-unavailable');
  });

  it('keeps the venue probabilities when only the book batch fails', async () => {
    const { feeds, route } = harness();
    route.set('down', 'clob.polymarket.com');

    const quotes = await feeds.readPolymarketQuotes();
    const bitcoinQuote = quotes.value?.get('BTC');

    expect(bitcoinQuote?.probabilityUp).toBeCloseTo(0.53, 12);
    expect(bitcoinQuote?.bidUp).toBeUndefined();
    expect(quotes.state).toBe('stale');
  });

  it('is fresh and empty when the venues answered and listed nothing', async () => {
    const { feeds } = harness();
    // Only Bitcoin is listed in these fixtures; the rest answered with no market.
    const quotes = await feeds.readPolymarketQuotes();
    expect(quotes.state).toBe('fresh');
    expect(quotes.value?.size).toBe(1);
    expect(OVERVIEW_ASSETS.length).toBeGreaterThan(1);
  });

  it('never serves a quote across a settlement boundary', async () => {
    const { advance, feeds, route } = harness();
    await feeds.readKalshiQuotes();
    const before = route.calls.filter((url) => url.includes('KXBTC15M')).length;

    // The next quarter-hour is a different contract, so the stored one is not reused
    // even though it is well inside the last-good window.
    advance(15 * 60 * 1000);
    route.set('down');
    const next = await feeds.readKalshiQuotes();

    expect(route.calls.filter((url) => url.includes('KXBTC15M')).length).toBeGreaterThan(before);
    expect(next.state).toBe('unavailable');
  });

  it('has no closes to publish when the minute series is unavailable', async () => {
    const { feeds, route } = harness();
    route.set('timeout', 'interval=1');

    const closes = await feeds.readMinuteCloses(bitcoin);
    expect(closes.state).toBe('unavailable');
    expect(closes.value).toBeUndefined();
    expect(closes.reason).toBe('upstream-timeout');
  });

  it('constructs its own client and cache when given none', async () => {
    // Reaches no provider: constructing the port opens nothing.
    expect(() => createMarketFeeds()).not.toThrow();
  });
});
