// Kalshi: the fifteen-minute up/down quote, and the hourly threshold listing.
//
// Two public, keyless reads of the same endpoint with different series and bounds. No
// key, no signature, no account: this is the venue's public market data, and anything
// that would need a credential is out of scope for this capability.
//
// Both reads are defensive about which contract they are looking at, for the same
// reason: the venue lists a series, not a window, so "the current market" has to be
// established here rather than assumed. The short read takes the contract settling at
// the next quarter-hour within a five-second tolerance; the hourly read takes the
// earliest group whose open and close are exactly one hour apart and which is trading
// now. A contract from a window that has already closed is not a current quote.
//
// Differences from v1: a zero ask is "not offered" on both reads, where v1 published
// the zero on the short one; a missing bid, ask, liquidity or volume is absent rather
// than zero; and the thrown upstream message never reaches a caller — the reasons this
// can report are the four fixed codes (#211, decisions 2 and 5).

import type {
  HourlyThresholdGroup,
  HourlyThresholdRow,
  KalshiQuote,
} from '../../domain/market-feeds.js';
import {
  CLOSE_ALIGNMENT_TOLERANCE_MS,
  HOURLY_CYCLE_SECONDS,
  SHORT_CYCLE_SECONDS,
  shortCycleSlotSeconds,
  type MarketAsset,
} from '../../domain/market-registry.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  asArray,
  asRecord,
  optionalAsk,
  optionalBid,
  optionalInstant,
  optionalNumber,
  optionalPositiveNumber,
  optionalText,
  type UpstreamRecord,
} from './upstream-values.js';

const MARKETS_URL = 'https://api.elections.kalshi.com/trade-api/v2/markets';
const MARKET_PAGE_URL = 'https://kalshi.com/markets';

/** Rows read from one fifteen-minute series. Ten is more than a cycle ever lists. */
const SHORT_PAGE_LIMIT = 10;
/** Rows read from one hourly series. A second page is a shape this does not expect. */
const HOURLY_PAGE_LIMIT = 1000;
/** The exact distance between an hourly contract's open and close. */
const HOURLY_DURATION_MS = HOURLY_CYCLE_SECONDS * 1000;
/** The marker an hourly threshold contract's ticker carries. */
const THRESHOLD_TICKER_MARKER = '-T';

const ABOVE_WORDS = /\babove\b|\bgreater than\b/i;
const BELOW_WORDS = /\bbelow\b|\bless than\b/i;

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

/** The venue page for a series. The venue publishes no per-contract page. */
export function seriesUrl(series: string): string {
  return `${MARKET_PAGE_URL}/${series.toLowerCase()}`;
}

/** The rows of a markets response, refusing a listing that did not fit one page. */
function marketRows(payload: unknown, limit: number): readonly UpstreamRecord[] {
  const envelope = asRecord(payload);
  // A cursor means the venue has more rows than were read. Publishing the first page
  // as though it were the listing would silently drop contracts, so this is a shape
  // failure rather than a partial answer.
  if (optionalText(envelope.cursor) !== undefined) throw new FeedFailure('upstream-invalid');
  const rows = asArray(envelope.markets ?? []);
  if (rows.length > limit) throw new FeedFailure('upstream-invalid');
  return Object.freeze(rows.map((row) => asRecord(row)));
}

/** The rules text of one contract, as the venue states it. */
function rulesText(row: UpstreamRecord): string {
  return [optionalText(row.rules_primary), optionalText(row.rules_secondary)]
    .filter((part): part is string => part !== undefined)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n');
}

/**
 * The fifteen-minute quote for one asset, or nothing where none is aligned.
 *
 * Alignment is to the next quarter-hour on this service's clock, within five seconds.
 * The venue's own close is used as published; the tolerance exists because the two
 * clocks are not the same clock, not to admit a different window.
 */
export function readShortQuote(
  payload: unknown,
  asset: MarketAsset,
  at: Date,
): KalshiQuote | undefined {
  const series = asset.kalshiShortSeries;
  if (series === undefined) return undefined;

  const target = (shortCycleSlotSeconds(at.getTime()) + SHORT_CYCLE_SECONDS) * 1000;
  let best: { readonly distance: number; readonly row: UpstreamRecord } | undefined;

  for (const row of marketRows(payload, SHORT_PAGE_LIMIT)) {
    if (optionalText(row.status) !== 'active') continue;
    const closesAt = optionalInstant(row.close_time);
    if (closesAt === undefined || closesAt.getTime() <= at.getTime()) continue;
    const distance = Math.abs(closesAt.getTime() - target);
    if (distance > CLOSE_ALIGNMENT_TOLERANCE_MS) continue;
    if (best === undefined || distance < best.distance) best = { distance, row };
  }

  if (best === undefined) return undefined;
  const row = best.row;
  const ticker = optionalText(row.ticker);
  const closesAt = optionalInstant(row.close_time);
  if (ticker === undefined || closesAt === undefined) return undefined;

  const bidUp = optionalBid(row.yes_bid_dollars);
  const askUp = optionalAsk(row.yes_ask_dollars);
  // The venue quotes one side and leaves the other implied as often as not. The
  // complement of a quoted price is the other side of the same book, so it is used —
  // and only when the price it is derived from is itself a price.
  const bidDown = optionalBid(row.no_bid_dollars) ?? complement(askUp, 'bid');
  const askDown = optionalAsk(row.no_ask_dollars) ?? complement(bidUp, 'ask');

  return Object.freeze({
    ...optional('askDown', askDown),
    ...optional('askUp', askUp),
    ...optional('bidDown', bidDown),
    ...optional('bidUp', bidUp),
    closesAt,
    contractId: ticker,
    ...optional('floorStrike', optionalPositiveNumber(row.floor_strike)),
    ...optional('liquidityUsd', optionalNumber(row.liquidity_dollars)),
    live: true,
    ...optional('probabilityDown', shortProbability(bidDown, askDown, undefined)),
    ...optional(
      'probabilityUp',
      shortProbability(bidUp, askUp, optionalBid(row.last_price_dollars)),
    ),
    ticker,
    url: seriesUrl(series),
    ...optional('volumeContracts', optionalNumber(row.volume_fp)),
  });
}

/** One dollar minus a price, when the result is itself a price of that kind. */
function complement(price: number | undefined, kind: 'ask' | 'bid'): number | undefined {
  if (price === undefined) return undefined;
  const other = 1 - price;
  return kind === 'bid' ? optionalBid(other) : optionalAsk(other);
}

/**
 * The probability the quote implies: the midpoint, else the last trade.
 *
 * v1 fell back to one half when it had neither. That is a fabricated number for a
 * market nobody is quoting, so here the member is simply absent.
 */
function shortProbability(
  bid: number | undefined,
  ask: number | undefined,
  last: number | undefined,
): number | undefined {
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  return last;
}

/** One classified threshold row, or nothing when the row is not one. */
export function classifyThresholdRow(row: UpstreamRecord): HourlyThresholdRow | undefined {
  const ticker = optionalText(row.ticker);
  if (ticker === undefined || !ticker.includes(THRESHOLD_TICKER_MARKER)) return undefined;

  const floor = optionalPositiveNumber(row.floor_strike);
  const cap = optionalPositiveNumber(row.cap_strike);
  const text = rulesText(row);

  // Both the strike fields and the words have to agree. A one-sided strike with text
  // that does not say which side it is could be either contract, and guessing which
  // would publish a probability for the wrong question.
  const direction: HourlyThresholdRow['direction'] | undefined =
    floor !== undefined && cap === undefined && ABOVE_WORDS.test(text)
      ? 'ABOVE'
      : cap !== undefined && floor === undefined && BELOW_WORDS.test(text)
        ? 'BELOW'
        : undefined;
  if (direction === undefined) return undefined;

  const strike = direction === 'ABOVE' ? floor : cap;
  if (strike === undefined) return undefined;

  return Object.freeze({
    ...optional('askNo', optionalAsk(row.no_ask_dollars)),
    ...optional('askYes', optionalAsk(row.yes_ask_dollars)),
    ...optional('bidNo', optionalBid(row.no_bid_dollars)),
    ...optional('bidYes', optionalBid(row.yes_bid_dollars)),
    direction,
    rulesText: text,
    strike,
    ticker,
  });
}

interface HourWindow {
  readonly closesAtMs: number;
  readonly openAtMs: number;
  readonly rows: UpstreamRecord[];
}

/**
 * The hour this asset is trading, with its classified rows — or `null` for none.
 *
 * `null` is a successful read of a venue that has nothing listed for the next hour,
 * which is a different thing from a failed read and is published as such.
 */
export function readHourlyGroup(payload: unknown, at: Date): HourlyThresholdGroup | null {
  const nowMs = at.getTime();
  const windows = new Map<string, HourWindow>();

  for (const row of marketRows(payload, HOURLY_PAGE_LIMIT)) {
    if (optionalText(row.status) !== 'active') continue;
    const marketType = optionalText(row.market_type);
    if (marketType !== undefined && marketType !== 'binary') continue;
    const openAt = optionalInstant(row.open_time);
    const closesAt = optionalInstant(row.close_time);
    if (openAt === undefined || closesAt === undefined) continue;
    const openAtMs = openAt.getTime();
    const closesAtMs = closesAt.getTime();
    // Exactly one hour: the series also lists other durations, and a contract of a
    // different length is a different question with a different reference window.
    if (closesAtMs - openAtMs !== HOURLY_DURATION_MS) continue;
    if (openAtMs > nowMs || closesAtMs <= nowMs) continue;

    const key = `${openAtMs}:${closesAtMs}`;
    const existing = windows.get(key);
    if (existing === undefined) windows.set(key, { closesAtMs, openAtMs, rows: [row] });
    else existing.rows.push(row);
  }

  const soonest = [...windows.values()].reduce<HourWindow | undefined>(
    (earliest, window) =>
      earliest === undefined || window.closesAtMs < earliest.closesAtMs ? window : earliest,
    undefined,
  );
  if (soonest === undefined) return null;

  const classified = soonest.rows
    .map((row) => classifyThresholdRow(row))
    .filter((row): row is HourlyThresholdRow => row !== undefined);

  const above = classified.filter((row) => row.direction === 'ABOVE');
  const below = classified.filter((row) => row.direction === 'BELOW');
  const unusableSides: HourlyThresholdGroup['unusableSides'][number][] = [];
  if (above.length === 0) unusableSides.push('above-missing');
  else if (above.length > 1) unusableSides.push('above-ambiguous');
  if (below.length === 0) unusableSides.push('below-missing');
  else if (below.length > 1) unusableSides.push('below-ambiguous');

  // A side the venue listed twice is dropped rather than picked between: the two rows
  // have different strikes, and either choice would be arbitrary. The other side is
  // still published, with the reason beside it.
  const rows = [...(above.length === 1 ? above : []), ...(below.length === 1 ? below : [])];

  return Object.freeze({
    closesAt: new Date(soonest.closesAtMs),
    openAt: new Date(soonest.openAtMs),
    rows: Object.freeze(rows),
    unusableSides: Object.freeze(unusableSides),
  });
}

export interface KalshiFeed {
  /** The hour one asset is trading, or `null` where the venue lists none. */
  readonly loadHourlyGroup: (asset: MarketAsset, at: Date) => Promise<HourlyThresholdGroup | null>;
  /** One asset's aligned fifteen-minute quote, or nothing where none is aligned. */
  readonly loadShortQuote: (asset: MarketAsset, at: Date) => Promise<KalshiQuote | undefined>;
}

export function createKalshiFeed(client: FeedHttpClient): KalshiFeed {
  return Object.freeze({
    loadHourlyGroup: async (asset: MarketAsset, at: Date) => {
      const nowSeconds = Math.floor(at.getTime() / 1000);
      const url =
        `${MARKETS_URL}?limit=${HOURLY_PAGE_LIMIT}&status=open` +
        `&series_ticker=${encodeURIComponent(asset.kalshiHourlySeries)}` +
        `&min_close_ts=${nowSeconds}&max_close_ts=${nowSeconds + HOURLY_CYCLE_SECONDS}`;
      return readHourlyGroup(await client.getJson(url), at);
    },
    loadShortQuote: async (asset: MarketAsset, at: Date) => {
      const series = asset.kalshiShortSeries;
      if (series === undefined) return undefined;
      const url =
        `${MARKETS_URL}?limit=${SHORT_PAGE_LIMIT}&status=open` +
        `&series_ticker=${encodeURIComponent(series)}`;
      return readShortQuote(await client.getJson(url), asset, at);
    },
  });
}
