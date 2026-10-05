// Polymarket: the fifteen-minute up/down market, and the top of its order book.
//
// Two public, keyless reads per cycle. The event lookup is addressed by a slug built
// from the asset and the quarter-hour slot, so the market this asks about is the one
// trading now rather than whatever the venue considers current; the book read is one
// batch for every outcome token the events named.
//
// The book call is a POST that writes nothing — the venue takes a list of token ids in
// a body because a URL would not hold them. It carries no credential and cannot place
// an order.
//
// Two differences from v1, both decision 1 and both about not inventing numbers:
// a missing outcome price is absent rather than 0.5, and absent liquidity or volume is
// absent rather than zero. An asset the venue has not listed for this slot produces no
// quote at all, where v1 published a fabricated fifty-fifty market with no liquidity.

import type { PolymarketQuote } from '../../domain/market-feeds.js';
import { SHORT_CYCLE_SECONDS } from '../../domain/market-registry.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  asArray,
  asEncodedArray,
  asRecord,
  optionalInstant,
  optionalNumber,
  optionalText,
} from './upstream-values.js';

const EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const BOOKS_URL = 'https://clob.polymarket.com/books';
const EVENT_PAGE_URL = 'https://polymarket.com/event';

/** The best bid and ask on one outcome token. */
export interface BookTop {
  readonly ask?: number;
  readonly bid?: number;
}

/** One asset's quote, plus the outcome tokens whose books complete it. */
export interface PolymarketEventQuote {
  readonly quote: PolymarketQuote;
  /** Outcome tokens in venue order: index zero is up, index one is down. */
  readonly tokenIds: readonly string[];
}

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

/** The slug of the market for one asset and one quarter-hour slot. */
export function eventSlug(slug: string, slotSeconds: number): string {
  return `${slug}-updown-15m-${slotSeconds}`;
}

/** A probability the venue reported. Outside zero to one it is not one. */
const probability = (value: number | undefined): number | undefined =>
  value !== undefined && value >= 0 && value <= 1 ? value : undefined;

/** A tradeable price: strictly inside zero and one, as the venue's book quotes are. */
const tradeablePrice = (value: unknown): number | undefined => {
  const parsed = optionalNumber(value);
  return parsed !== undefined && parsed > 0 && parsed < 1 ? parsed : undefined;
};

/**
 * The quote for one asset's current cycle, or nothing where the venue lists none.
 *
 * An empty event list is not a failure: these markets are created per cycle and a slot
 * the venue has not opened yet simply has no market. A payload that is not a list of
 * events, or an event whose market cannot be read, is `upstream-invalid`.
 */
export function readEventQuote(
  payload: unknown,
  slug: string,
  slotSeconds: number,
): PolymarketEventQuote | undefined {
  const events = asArray(payload);
  const firstEvent = events[0];
  if (firstEvent === undefined || firstEvent === null) return undefined;

  const event = asRecord(firstEvent);
  const firstMarket = asArray(event.markets ?? [])[0];
  if (firstMarket === undefined || firstMarket === null) return undefined;
  const market = asRecord(firstMarket);

  // Both of these arrive as JSON encoded inside the JSON, which is the venue's own
  // shape rather than a mistake, so they are decoded rather than refused.
  const prices = asEncodedArray(market.outcomePrices ?? []).map((value) => optionalNumber(value));
  const tokenIds = asEncodedArray(market.clobTokenIds ?? [])
    .map((value) => optionalText(value))
    .filter((value): value is string => value !== undefined);

  const eventSlugUsed = optionalText(event.slug) ?? eventSlug(slug, slotSeconds);
  const contractId =
    optionalText(market.conditionId) ??
    optionalText(market.id) ??
    optionalText(event.id) ??
    eventSlugUsed;

  return Object.freeze({
    quote: Object.freeze({
      // The venue's own close where it states one; the slot's end otherwise, which is
      // what the slug asked about and therefore the only defensible fallback.
      closesAt:
        optionalInstant(event.endDate) ?? new Date((slotSeconds + SHORT_CYCLE_SECONDS) * 1000),
      contractId,
      ...optional('liquidityUsd', optionalNumber(market.liquidityNum)),
      live: market.acceptingOrders === true,
      ...optional('probabilityDown', probability(prices[1])),
      ...optional('probabilityUp', probability(prices[0])),
      url: `${EVENT_PAGE_URL}/${eventSlugUsed}`,
      ...optional('volumeUsd', optionalNumber(market.volumeNum)),
    }),
    tokenIds: Object.freeze(tokenIds),
  });
}

/** Best bid and ask per token: the highest bid and the lowest ask that are tradeable. */
export function readBookTops(payload: unknown): ReadonlyMap<string, BookTop> {
  const tops = new Map<string, BookTop>();

  for (const row of asArray(payload)) {
    if (typeof row !== 'object' || row === null) continue;
    const book = row as Readonly<Record<string, unknown>>;
    const tokenId = optionalText(book.asset_id);
    if (tokenId === undefined) continue;
    tops.set(
      tokenId,
      Object.freeze({
        ...optional('ask', bestPrice(book.asks, 'lowest')),
        ...optional('bid', bestPrice(book.bids, 'highest')),
      }),
    );
  }

  return tops;
}

function bestPrice(level: unknown, pick: 'highest' | 'lowest'): number | undefined {
  if (!Array.isArray(level)) return undefined;
  let best: number | undefined;
  for (const entry of level) {
    if (typeof entry !== 'object' || entry === null) continue;
    const price = tradeablePrice((entry as Readonly<Record<string, unknown>>).price);
    if (price === undefined) continue;
    if (best === undefined) best = price;
    else best = pick === 'highest' ? Math.max(best, price) : Math.min(best, price);
  }
  return best;
}

/**
 * The quote with its book prices filled in, where the batch returned them.
 *
 * A book the batch did not answer for leaves the four price members absent and the
 * probabilities intact, which is what a caller can still use.
 */
export function withBookTops(
  entry: PolymarketEventQuote,
  tops: ReadonlyMap<string, BookTop>,
): PolymarketQuote {
  const up = entry.tokenIds[0] === undefined ? undefined : tops.get(entry.tokenIds[0]);
  const down = entry.tokenIds[1] === undefined ? undefined : tops.get(entry.tokenIds[1]);

  return Object.freeze({
    ...entry.quote,
    ...optional('askDown', down?.ask),
    ...optional('askUp', up?.ask),
    ...optional('bidDown', down?.bid),
    ...optional('bidUp', up?.bid),
  });
}

export interface PolymarketFeed {
  /** The batch of books for every token the events named. */
  readonly loadBookTops: (tokenIds: readonly string[]) => Promise<ReadonlyMap<string, BookTop>>;
  /** One asset's cycle market, or nothing where the venue lists none. */
  readonly loadEventQuote: (
    slug: string,
    slotSeconds: number,
  ) => Promise<PolymarketEventQuote | undefined>;
}

export function createPolymarketFeed(client: FeedHttpClient): PolymarketFeed {
  return Object.freeze({
    loadBookTops: async (tokenIds: readonly string[]) => {
      // Nothing to ask about is not a request: an empty batch would be one more call
      // for a provider to answer with an empty list.
      if (tokenIds.length === 0) return new Map<string, BookTop>();
      const body = tokenIds.map((tokenId) => ({ token_id: tokenId }));
      return readBookTops(await client.postJson(BOOKS_URL, body));
    },
    loadEventQuote: async (slug: string, slotSeconds: number) => {
      const requested = eventSlug(slug, slotSeconds);
      const payload = await client.getJson(`${EVENTS_URL}?slug=${encodeURIComponent(requested)}`);
      return readEventQuote(payload, slug, slotSeconds);
    },
  });
}
