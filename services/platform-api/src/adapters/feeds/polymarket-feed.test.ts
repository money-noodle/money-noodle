// The prediction-venue adapter, against synthetic events and books.
//
// Invented ids and prices in the venue's documented shape. The two things worth
// testing here are the venue's own oddities: prices and token ids arrive as JSON
// encoded inside the JSON, and the book read is a POST that writes nothing.

import { describe, expect, it } from 'vitest';

import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  createPolymarketFeed,
  eventSlug,
  readBookTops,
  readEventQuote,
  withBookTops,
} from './polymarket-feed.js';

const SLOT = 1_791_309_600;

const event = (overrides: Record<string, unknown> = {}, market: Record<string, unknown> = {}) => [
  {
    endDate: '2026-10-05T18:15:00.000Z',
    id: 'event-1',
    markets: [
      {
        acceptingOrders: true,
        clobTokenIds: '["token-up","token-down"]',
        conditionId: '0xcondition',
        id: 'market-1',
        liquidityNum: 90_000,
        outcomePrices: '["0.53","0.47"]',
        volumeNum: 450_000,
        ...market,
      },
    ],
    slug: `btc-updown-15m-${SLOT}`,
    ...overrides,
  },
];

describe('eventSlug', () => {
  it('addresses one asset and one quarter-hour slot', () => {
    expect(eventSlug('btc', SLOT)).toBe(`btc-updown-15m-${SLOT}`);
  });
});

describe('readEventQuote', () => {
  it('reads the quote, including the fields encoded as JSON strings', () => {
    const entry = readEventQuote(event(), 'btc', SLOT);
    expect(entry?.quote.probabilityUp).toBeCloseTo(0.53, 12);
    expect(entry?.quote.probabilityDown).toBeCloseTo(0.47, 12);
    expect(entry?.quote.contractId).toBe('0xcondition');
    expect(entry?.quote.liquidityUsd).toBe(90_000);
    expect(entry?.quote.volumeUsd).toBe(450_000);
    expect(entry?.quote.live).toBe(true);
    expect(entry?.quote.url).toBe(`https://polymarket.com/event/btc-updown-15m-${SLOT}`);
    expect(entry?.quote.closesAt.toISOString()).toBe('2026-10-05T18:15:00.000Z');
    expect(entry?.tokenIds).toEqual(['token-up', 'token-down']);
  });

  it('accepts the same fields already decoded', () => {
    const entry = readEventQuote(
      event({}, { clobTokenIds: ['token-up'], outcomePrices: [0.6, 0.4] }),
      'btc',
      SLOT,
    );
    expect(entry?.quote.probabilityUp).toBeCloseTo(0.6, 12);
    expect(entry?.tokenIds).toEqual(['token-up']);
  });

  it('falls back through the venue identifiers in order', () => {
    expect(readEventQuote(event({}, { conditionId: null }), 'btc', SLOT)?.quote.contractId).toBe(
      'market-1',
    );
    expect(
      readEventQuote(event({}, { conditionId: null, id: null }), 'btc', SLOT)?.quote.contractId,
    ).toBe('event-1');
    expect(
      readEventQuote(event({ id: null }, { conditionId: null, id: null }), 'btc', SLOT)?.quote
        .contractId,
    ).toBe(`btc-updown-15m-${SLOT}`);
  });

  it('closes at the end of the slot it asked about when the venue states no end', () => {
    const entry = readEventQuote(event({ endDate: null, slug: null }), 'btc', SLOT);
    expect(entry?.quote.closesAt.getTime()).toBe((SLOT + 900) * 1000);
    expect(entry?.quote.url).toBe(`https://polymarket.com/event/btc-updown-15m-${SLOT}`);
  });

  it('publishes no probability the venue did not state', () => {
    const entry = readEventQuote(event({}, { outcomePrices: '[]' }), 'btc', SLOT);
    // v1 defaulted both sides to one half here.
    expect(entry?.quote.probabilityUp).toBeUndefined();
    expect(entry?.quote.probabilityDown).toBeUndefined();
    const outOfRange = readEventQuote(event({}, { outcomePrices: '["1.4","-0.4"]' }), 'btc', SLOT);
    expect(outOfRange?.quote.probabilityUp).toBeUndefined();
  });

  it('has no quote where the venue opened no market for the slot', () => {
    // Not a failure: these markets are created per cycle.
    expect(readEventQuote([], 'btc', SLOT)).toBeUndefined();
    expect(readEventQuote([{ markets: [] }], 'btc', SLOT)).toBeUndefined();
    expect(readEventQuote([null], 'btc', SLOT)).toBeUndefined();
  });

  it('refuses a payload that is not a list of events', () => {
    expect(() => readEventQuote({ events: [] }, 'btc', SLOT)).toThrow(FeedFailure);
    expect(() => readEventQuote(event({}, { clobTokenIds: 'not json' }), 'btc', SLOT)).toThrow(
      FeedFailure,
    );
  });
});

describe('readBookTops', () => {
  it('takes the highest bid and the lowest ask that are tradeable', () => {
    const tops = readBookTops([
      {
        asks: [{ price: '0.58' }, { price: '0.55' }, { price: '1' }],
        asset_id: 'token-up',
        bids: [{ price: '0.51' }, { price: '0.53' }, { price: '0' }],
      },
    ]);
    expect(tops.get('token-up')).toEqual({ ask: 0.55, bid: 0.53 });
  });

  it('skips what is not a level and a book with no id', () => {
    const tops = readBookTops([
      { asks: 'nope', asset_id: 'token-up', bids: [null, 'x', { price: 'n/a' }] },
      { asks: [], bids: [] },
      'not a book',
    ]);
    expect(tops.get('token-up')).toEqual({});
    expect(tops.size).toBe(1);
  });

  it('refuses a payload that is not a list of books', () => {
    expect(() => readBookTops({ books: [] })).toThrow(FeedFailure);
  });
});

describe('withBookTops', () => {
  const entry = readEventQuote(event(), 'btc', SLOT)!;

  it('fills the four prices from the tokens in venue order', () => {
    const quote = withBookTops(
      entry,
      new Map([
        ['token-up', { ask: 0.55, bid: 0.53 }],
        ['token-down', { ask: 0.48, bid: 0.45 }],
      ]),
    );
    expect(quote.askUp).toBe(0.55);
    expect(quote.bidUp).toBe(0.53);
    expect(quote.askDown).toBe(0.48);
    expect(quote.bidDown).toBe(0.45);
  });

  it('keeps the probabilities when the book read gave nothing', () => {
    const quote = withBookTops(entry, new Map());
    expect(quote.askUp).toBeUndefined();
    expect(quote.probabilityUp).toBeCloseTo(0.53, 12);
  });
});

describe('createPolymarketFeed', () => {
  it('asks for one slot by slug and batches the books in one read', async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const client: FeedHttpClient = {
      getJson: async (url: string) => {
        urls.push(url);
        return event();
      },
      getText: async () => '',
      postJson: async (url: string, body: unknown) => {
        urls.push(url);
        bodies.push(body);
        return [{ asks: [{ price: '0.55' }], asset_id: 'token-up', bids: [{ price: '0.53' }] }];
      },
    };
    const feed = createPolymarketFeed(client);

    const entry = await feed.loadEventQuote('btc', SLOT);
    const tops = await feed.loadBookTops(entry?.tokenIds ?? []);

    expect(urls).toEqual([
      `https://gamma-api.polymarket.com/events?slug=btc-updown-15m-${SLOT}`,
      'https://clob.polymarket.com/books',
    ]);
    expect(bodies).toEqual([[{ token_id: 'token-up' }, { token_id: 'token-down' }]]);
    expect(tops.get('token-up')).toEqual({ ask: 0.55, bid: 0.53 });
  });

  it('does not call the book endpoint with nothing to ask about', async () => {
    let called = false;
    const client: FeedHttpClient = {
      getJson: async () => [],
      getText: async () => '',
      postJson: async () => {
        called = true;
        return [];
      },
    };
    expect((await createPolymarketFeed(client).loadBookTops([])).size).toBe(0);
    expect(called).toBe(false);
  });
});
