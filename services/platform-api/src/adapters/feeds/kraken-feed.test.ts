// The exchange adapter, against synthetic payloads in the venue's own shape.
//
// Every payload here was written for this test, not recorded from the exchange. The
// shapes are the ones the public endpoints document; the numbers are invented, which
// is the point — a fixture with real market data in it would be evidence of a request
// this repository should not be making in a test run.
//
// The case that matters most is the last one in the first group: the forming minute
// has to be gone before anything reads the series.

import { describe, expect, it, vi } from 'vitest';

import { SHORT_REFERENCE_SOURCE, MARKET_ASSETS } from '../../domain/market-registry.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  createKrakenFeed,
  cyclePriceSeries,
  readCompletedMinuteCandles,
  readLastTrades,
  readWeeklyHistory,
} from './kraken-feed.js';

const bitcoin = MARKET_ASSETS[0]!;
const AT = new Date('2026-10-05T18:07:30.000Z');
const SLOT_SECONDS = Math.floor(Date.UTC(2026, 9, 5, 18, 0, 0) / 1000);

/** `rows` one-minute candles ending with the minute still forming. */
function ohlc(rows: readonly (readonly [number, number])[], key = 'XXBTZUSD'): unknown {
  return {
    error: [],
    result: {
      last: rows.at(-1)?.[0] ?? 0,
      [key]: rows.map(([startSeconds, close]) => [
        startSeconds,
        String(close),
        String(close + 1),
        String(close - 1),
        String(close),
        String(close),
        '1.5',
        7,
      ]),
    },
  };
}

/** A minute series ending with the forming minute, newest last. */
function minuteSeries(
  count: number,
  from = SLOT_SECONDS - count * 60 + 120,
): readonly (readonly [number, number])[] {
  return Array.from({ length: count }, (_, index) => [from + index * 60, 64_000 + index] as const);
}

const stubClient = (payload: unknown): { client: FeedHttpClient; urls: string[] } => {
  const urls: string[] = [];
  return {
    client: {
      getJson: async (url: string) => {
        urls.push(url);
        return payload;
      },
      getText: async () => '',
      postJson: async () => undefined,
    },
    urls,
  };
};

describe('readCompletedMinuteCandles', () => {
  it('drops the minute that is still forming', () => {
    const rows = minuteSeries(5);
    const candles = readCompletedMinuteCandles(ohlc(rows));
    // v1 kept this row, so its newest close moved within the minute and its newest log
    // return described part of a minute rather than one.
    expect(candles).toHaveLength(4);
    expect(candles.at(-1)?.startSeconds).toBe(rows.at(-2)?.[0]);
  });

  it('skips a row that cannot be a candle', () => {
    const payload = ohlc(minuteSeries(4));
    const rows = (payload as { result: Record<string, unknown[]> }).result.XXBTZUSD!;
    rows[1] = [rows[1] as unknown as number, 'not a number'];
    (rows[2] as unknown[])[4] = '0';
    const candles = readCompletedMinuteCandles(payload);
    expect(candles).toHaveLength(1);
  });

  it('refuses an envelope the exchange marked as an error', () => {
    expect(() =>
      readCompletedMinuteCandles({ error: ['EQuery:Unknown asset pair'], result: {} }),
    ).toThrow(FeedFailure);
  });

  it('refuses a payload with no series in it', () => {
    expect(() => readCompletedMinuteCandles({ error: [], result: { last: 1 } })).toThrow(
      FeedFailure,
    );
    expect(() => readCompletedMinuteCandles('not an envelope')).toThrow(FeedFailure);
  });
});

describe('readWeeklyHistory', () => {
  it('reads closes as a price history', () => {
    const history = readWeeklyHistory(
      ohlc([
        [1_758_412_800, 61_000],
        [1_759_017_600, 63_500],
      ]),
    );
    expect(history).toEqual([
      { price: 61_000, time: new Date(1_758_412_800_000) },
      { price: 63_500, time: new Date(1_759_017_600_000) },
    ]);
  });
});

describe('readLastTrades', () => {
  const payload = (result: Record<string, unknown>) => ({ error: [], result });

  it('reads the declared key, and the venue key that contains it', () => {
    const trades = readLastTrades(
      payload({
        SOLUSD: { c: ['150.25', '1.0'] },
        XXBTZUSD: { c: ['64100.5', '0.1'] },
      }),
      [bitcoin, MARKET_ASSETS[2]!],
    );
    expect(trades.get('BTC')).toBe(64_100.5);
    expect(trades.get('SOL')).toBe(150.25);
  });

  it('omits an asset with no usable price rather than publishing a zero', () => {
    const trades = readLastTrades(payload({ XXBTZUSD: { c: ['0', '0.1'] } }), [
      bitcoin,
      MARKET_ASSETS[1]!,
    ]);
    expect(trades.size).toBe(0);
  });
});

describe('cyclePriceSeries', () => {
  const candles = readCompletedMinuteCandles(ohlc(minuteSeries(20)));

  it('takes the reference from the minute that ended as the cycle opened', () => {
    const series = cyclePriceSeries(bitcoin, candles, 64_200, AT);
    const reference = candles.find((candle) => candle.startSeconds === SLOT_SECONDS - 60);
    expect(series?.referencePrice).toBe(reference?.close);
    expect(series?.referenceSource).toBe(SHORT_REFERENCE_SOURCE);
    expect(series?.slotSeconds).toBe(SLOT_SECONDS);
    // The exchange's last trade is more current than the last completed minute.
    expect(series?.currentPrice).toBe(64_200);
    expect(series?.closes.at(-1)).toBe(candles.at(-1)?.close);
  });

  it('falls back to the newest completed close when there is no last trade', () => {
    expect(cyclePriceSeries(bitcoin, candles, undefined, AT)?.currentPrice).toBe(
      candles.at(-1)?.close,
    );
  });

  it('contributes nothing without the reference minute', () => {
    // A nearby minute is a different number, and the contract settles on this one.
    const shifted = candles.filter((candle) => candle.startSeconds !== SLOT_SECONDS - 60);
    expect(cyclePriceSeries(bitcoin, shifted, 64_200, AT)).toBeUndefined();
    expect(cyclePriceSeries(bitcoin, [], undefined, AT)).toBeUndefined();
  });
});

describe('createKrakenFeed', () => {
  it('addresses the public endpoints with the registry pairs', async () => {
    const urls: string[] = [];
    const client: FeedHttpClient = {
      getJson: async (url: string) => {
        urls.push(url);
        return url.includes('Ticker')
          ? { error: [], result: { XXBTZUSD: { c: ['64100.5', '0.1'] } } }
          : ohlc(minuteSeries(4));
      },
      getText: async () => '',
      postJson: async () => undefined,
    };
    const feed = createKrakenFeed(client);

    await feed.loadLastTrades([bitcoin]);
    await feed.loadMinuteCandles(bitcoin);
    await feed.loadLongHistory(bitcoin);

    expect(urls).toEqual([
      'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
      'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1',
      'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=10080',
    ]);
    // No key, no signature, no account: every one of these is public.
    for (const url of urls) expect(url).not.toMatch(/key|sign|nonce|token/iu);
  });

  it('reads trades through the same reader the unit cases use', async () => {
    const { client } = stubClient({ error: [], result: { XXBTZUSD: { c: ['64100.5', '0.1'] } } });
    const trades = await createKrakenFeed(client).loadLastTrades([bitcoin]);
    expect(trades.get('BTC')).toBe(64_100.5);
  });

  it('passes an upstream refusal up as the failure it is', async () => {
    const client: FeedHttpClient = {
      getJson: vi.fn(async () => {
        throw new FeedFailure('upstream-timeout');
      }),
      getText: async () => '',
      postJson: async () => undefined,
    };
    await expect(createKrakenFeed(client).loadMinuteCandles(bitcoin)).rejects.toMatchObject({
      code: 'upstream-timeout',
    });
  });
});
