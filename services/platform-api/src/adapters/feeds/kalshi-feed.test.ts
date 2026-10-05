// The venue adapter, against synthetic listings in the venue's own shape.
//
// Written for this test, not recorded: the field names and types are the ones the
// public endpoint documents, the tickers and strikes are invented.
//
// Two groups, and both are mostly about refusal. The venue lists a series rather than
// a window, so most of this adapter's work is deciding which rows are the contract
// being asked about — and saying nothing when none of them is.

import { describe, expect, it } from 'vitest';

import { MARKET_ASSETS } from '../../domain/market-registry.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  classifyThresholdRow,
  createKalshiFeed,
  readHourlyGroup,
  readShortQuote,
  seriesUrl,
} from './kalshi-feed.js';

const bitcoin = MARKET_ASSETS[0]!;
const toncoin = MARKET_ASSETS[7]!;
const AT = new Date('2026-10-05T18:07:30.000Z');
const NEXT_CLOSE = '2026-10-05T18:15:00.000Z';

const ABOVE_RULES = 'Resolves Yes if the settlement price is above the strike.';
const BELOW_RULES = 'Resolves Yes if the settlement price is below the strike.';

const shortRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  close_time: NEXT_CLOSE,
  floor_strike: 64_000,
  last_price_dollars: '0.51',
  liquidity_dollars: '12000',
  no_ask_dollars: '0.52',
  no_bid_dollars: '0.48',
  rules_primary: ABOVE_RULES,
  status: 'active',
  ticker: 'KXBTC15M-26OCT0518',
  volume_fp: '800',
  yes_ask_dollars: '0.50',
  yes_bid_dollars: '0.48',
  ...overrides,
});

const hourlyRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  cap_strike: null,
  close_time: '2026-10-05T19:00:00.000Z',
  floor_strike: 64_000,
  market_type: 'binary',
  open_time: '2026-10-05T18:00:00.000Z',
  rules_primary: ABOVE_RULES,
  status: 'active',
  ticker: 'KXBTC-26OCT0519-T64000',
  yes_ask_dollars: '0.55',
  yes_bid_dollars: '0.53',
  ...overrides,
});

const belowRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  hourlyRow({
    cap_strike: 63_500,
    floor_strike: null,
    no_ask_dollars: '0.49',
    no_bid_dollars: '0.47',
    rules_primary: BELOW_RULES,
    ticker: 'KXBTC-26OCT0519-T63500',
    yes_ask_dollars: null,
    yes_bid_dollars: null,
    ...overrides,
  });

const listing = (markets: readonly unknown[], cursor = ''): unknown => ({ cursor, markets });

describe('readShortQuote', () => {
  it('takes the contract settling at the next quarter-hour', () => {
    const quote = readShortQuote(listing([shortRow()]), bitcoin, AT);
    expect(quote?.ticker).toBe('KXBTC15M-26OCT0518');
    expect(quote?.closesAt.toISOString()).toBe(NEXT_CLOSE);
    expect(quote?.url).toBe(seriesUrl('KXBTC15M'));
    expect(quote?.live).toBe(true);
    expect(quote?.floorStrike).toBe(64_000);
    expect(quote?.liquidityUsd).toBe(12_000);
    expect(quote?.volumeContracts).toBe(800);
    expect(quote?.probabilityUp).toBeCloseTo(0.49, 12);
  });

  it('prefers the closest alignment when the venue lists two candidates', () => {
    const quote = readShortQuote(
      listing([
        shortRow({ close_time: '2026-10-05T18:15:04.000Z', ticker: 'FAR' }),
        shortRow({ close_time: '2026-10-05T18:15:01.000Z', ticker: 'NEAR' }),
      ]),
      bitcoin,
      AT,
    );
    expect(quote?.ticker).toBe('NEAR');
  });

  it('refuses a row from another window, a settled one, or an inactive one', () => {
    expect(
      readShortQuote(listing([shortRow({ close_time: '2026-10-05T18:30:00.000Z' })]), bitcoin, AT),
    ).toBeUndefined();
    expect(
      readShortQuote(listing([shortRow({ close_time: '2026-10-05T18:00:00.000Z' })]), bitcoin, AT),
    ).toBeUndefined();
    expect(
      readShortQuote(listing([shortRow({ status: 'initialized' })]), bitcoin, AT),
    ).toBeUndefined();
    expect(readShortQuote(listing([]), bitcoin, AT)).toBeUndefined();
  });

  it('refuses a row with no close or no ticker', () => {
    expect(readShortQuote(listing([shortRow({ ticker: '' })]), bitcoin, AT)).toBeUndefined();
  });

  it('derives the unquoted side from the side that is quoted', () => {
    const quote = readShortQuote(
      listing([shortRow({ no_ask_dollars: null, no_bid_dollars: '' })]),
      bitcoin,
      AT,
    );
    // The complement of a quoted price is the other side of the same book.
    expect(quote?.bidDown).toBeCloseTo(0.5, 12);
    expect(quote?.askDown).toBeCloseTo(0.52, 12);
  });

  it('treats a zero ask as not offered, unlike v1', () => {
    const quote = readShortQuote(
      listing([shortRow({ no_ask_dollars: '0', yes_ask_dollars: '0' })]),
      bitcoin,
      AT,
    );
    expect(quote?.askUp).toBeUndefined();
    // With no ask there is no midpoint, so the last trade stands in.
    expect(quote?.probabilityUp).toBeCloseTo(0.51, 12);
  });

  it('publishes no probability when the venue is quoting nothing at all', () => {
    const quote = readShortQuote(
      listing([
        shortRow({
          last_price_dollars: null,
          no_ask_dollars: null,
          no_bid_dollars: null,
          yes_ask_dollars: null,
          yes_bid_dollars: null,
        }),
      ]),
      bitcoin,
      AT,
    );
    // v1 published one half here, which is a fabricated number for a market nobody is
    // quoting.
    expect(quote?.probabilityUp).toBeUndefined();
    expect(quote?.probabilityDown).toBeUndefined();
  });

  it('has nothing to read for an asset the venue lists no short series for', () => {
    expect(readShortQuote(listing([shortRow()]), toncoin, AT)).toBeUndefined();
  });

  it('refuses a listing that did not fit one page', () => {
    expect(() => readShortQuote(listing([shortRow()], 'next-page'), bitcoin, AT)).toThrow(
      FeedFailure,
    );
    expect(() =>
      readShortQuote(listing(Array.from({ length: 11 }, () => shortRow())), bitcoin, AT),
    ).toThrow(FeedFailure);
  });
});

describe('classifyThresholdRow', () => {
  it('needs the strike fields and the words to agree', () => {
    expect(classifyThresholdRow(hourlyRow())?.direction).toBe('ABOVE');
    expect(classifyThresholdRow(belowRow())?.direction).toBe('BELOW');
    expect(
      classifyThresholdRow(hourlyRow({ rules_primary: 'Resolves per the index.' })),
    ).toBeUndefined();
    expect(classifyThresholdRow(hourlyRow({ cap_strike: 65_000 }))).toBeUndefined();
    expect(classifyThresholdRow(belowRow({ floor_strike: 63_000 }))).toBeUndefined();
  });

  it('needs the threshold marker in the ticker', () => {
    expect(classifyThresholdRow(hourlyRow({ ticker: 'KXBTC26OCT0519' }))).toBeUndefined();
    expect(classifyThresholdRow(hourlyRow({ ticker: '' }))).toBeUndefined();
  });

  it('reads the quotes the venue is showing and omits a zero ask', () => {
    const row = classifyThresholdRow(hourlyRow({ no_ask_dollars: '0', no_bid_dollars: '0' }));
    expect(row?.bidYes).toBeCloseTo(0.53, 12);
    expect(row?.askYes).toBeCloseTo(0.55, 12);
    expect(row?.bidNo).toBe(0);
    expect(row?.askNo).toBeUndefined();
  });

  it('joins both rules fields in the order the venue states them', () => {
    const row = classifyThresholdRow(
      hourlyRow({ rules_secondary: '  The settlement price is a simple average.  ' }),
    );
    expect(row?.rulesText).toBe(`${ABOVE_RULES}\nThe settlement price is a simple average.`);
  });
});

describe('readHourlyGroup', () => {
  it('reads the hour now trading as a complete pair', () => {
    const group = readHourlyGroup(
      listing([hourlyRow(), belowRow()]),
      new Date('2026-10-05T18:30:00.000Z'),
    );
    expect(group?.openAt.toISOString()).toBe('2026-10-05T18:00:00.000Z');
    expect(group?.closesAt.toISOString()).toBe('2026-10-05T19:00:00.000Z');
    expect(group?.rows.map((row) => row.direction)).toEqual(['ABOVE', 'BELOW']);
    expect(group?.unusableSides).toEqual([]);
  });

  it('takes the group closing soonest', () => {
    const later = {
      close_time: '2026-10-05T19:30:00.000Z',
      open_time: '2026-10-05T18:30:00.000Z',
    };
    const group = readHourlyGroup(
      listing([
        hourlyRow({ ...later, ticker: 'KXBTC-26OCT051930-T64000' }),
        belowRow({ ...later, ticker: 'KXBTC-26OCT051930-T63500' }),
        hourlyRow(),
        belowRow(),
      ]),
      new Date('2026-10-05T18:40:00.000Z'),
    );
    expect(group?.closesAt.toISOString()).toBe('2026-10-05T19:00:00.000Z');
  });

  it('refuses a contract that is not an exact hour, or is not trading now', () => {
    const at = new Date('2026-10-05T18:30:00.000Z');
    const cases: readonly Record<string, unknown>[] = [
      { close_time: '2026-10-05T19:15:00.000Z' },
      { market_type: 'scalar' },
      { open_time: '2026-10-05T18:45:00.000Z', close_time: '2026-10-05T19:45:00.000Z' },
      { open_time: '2026-10-05T17:00:00.000Z', close_time: '2026-10-05T18:00:00.000Z' },
      { status: 'settled' },
      { open_time: 'not a time' },
    ];
    for (const override of cases) {
      expect(readHourlyGroup(listing([hourlyRow(override)]), at)).toBeNull();
    }
  });

  it('publishes one side and names the other when the venue listed it twice', () => {
    const group = readHourlyGroup(
      listing([
        hourlyRow(),
        belowRow(),
        belowRow({ cap_strike: 63_000, ticker: 'KXBTC-26OCT0519-T63000' }),
      ]),
      new Date('2026-10-05T18:30:00.000Z'),
    );
    // Two rows with different strikes: picking either would be arbitrary.
    expect(group?.unusableSides).toEqual(['below-ambiguous']);
    expect(group?.rows.map((row) => row.direction)).toEqual(['ABOVE']);
  });

  it('names a side the venue listed none of', () => {
    const group = readHourlyGroup(listing([hourlyRow()]), new Date('2026-10-05T18:30:00.000Z'));
    expect(group?.unusableSides).toEqual(['below-missing']);
    expect(group?.rows).toHaveLength(1);
  });

  it('refuses a second page rather than publishing the first as the listing', () => {
    expect(() =>
      readHourlyGroup(listing([hourlyRow()], 'cursor'), new Date('2026-10-05T18:30:00.000Z')),
    ).toThrow(FeedFailure);
  });
});

describe('createKalshiFeed', () => {
  const stub = (payload: unknown) => {
    const urls: string[] = [];
    const client: FeedHttpClient = {
      getJson: async (url: string) => {
        urls.push(url);
        return payload;
      },
      getText: async () => '',
      postJson: async () => undefined,
    };
    return { client, urls };
  };

  it('bounds the hourly listing to the next hour', async () => {
    const { client, urls } = stub(listing([hourlyRow(), belowRow()]));
    const at = new Date('2026-10-05T18:30:00.000Z');
    const group = await createKalshiFeed(client).loadHourlyGroup(bitcoin, at);

    const nowSeconds = Math.floor(at.getTime() / 1000);
    expect(urls[0]).toBe(
      'https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000&status=open' +
        `&series_ticker=KXBTC&min_close_ts=${nowSeconds}&max_close_ts=${nowSeconds + 3600}`,
    );
    expect(group?.rows).toHaveLength(2);
  });

  it('asks the short series for the current cycle', async () => {
    const { client, urls } = stub(listing([shortRow()]));
    const quote = await createKalshiFeed(client).loadShortQuote(bitcoin, AT);
    expect(urls[0]).toBe(
      'https://api.elections.kalshi.com/trade-api/v2/markets?limit=10&status=open&series_ticker=KXBTC15M',
    );
    expect(quote?.ticker).toBe('KXBTC15M-26OCT0518');
  });

  it('asks nothing for an asset with no short series', async () => {
    const { client, urls } = stub(listing([]));
    expect(await createKalshiFeed(client).loadShortQuote(toncoin, AT)).toBeUndefined();
    expect(urls).toEqual([]);
  });
});
