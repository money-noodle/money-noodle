import 'server-only';
import { kalshiBaseUrl } from './kalshi-api';
import {
  KalshiRateLimitError, initialRateLimitState, isRateLimited, rateLimitPaused, recordRateLimitSuccess,
  recordRateLimited, type RateLimitState,
} from './kalshi-rate-limit';
import { fetchKalshiOrderBookNow } from './kalshi-depth';
import { selectedManagedMakerQuote, type KalshiPriceRange, type ManagedMakerQuote } from './managed-maker';
import type { PositionSide } from './types';

interface KalshiMarketResponse {
  market?: {
    yes_bid_dollars?: string;
    yes_ask_dollars?: string;
    price_ranges?: KalshiPriceRange[];
  };
}

interface RawKalshiTrade {
  trade_id?: string;
  ticker?: string;
  created_time?: string;
  count_fp?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  taker_side?: string;
  taker_outcome_side?: string;
}

interface KalshiTradesResponse { trades?: RawKalshiTrade[]; cursor?: string }

export interface KalshiTradePrint {
  id: string;
  ticker: string;
  at: string;
  count: number;
  yesPrice: number;
  noPrice: number;
  takerSide: 'yes' | 'no';
}

let readRateLimit = initialRateLimitState();

/** Current read backoff, for reporting. A paused reader is a fact worth surfacing, not a silent skip. */
export function kalshiReadRateLimitState(): RateLimitState {
  return readRateLimit;
}

/**
 * A 429 is raised as its own error type rather than folded into the generic non-OK path.
 *
 * Kalshi sends no `Retry-After` and no `X-RateLimit-*` headers, so without this a rate-limit breach is
 * indistinguishable from a flaky venue: every poller here catches and skips, and price updates would just
 * stop with nothing explaining why. Requests are refused outright while paused, so backing off actually
 * reduces load instead of merely delaying the same burst.
 */
async function publicKalshiJson<T>(path: string, timeoutMs = 2_500): Promise<T> {
  if (rateLimitPaused(readRateLimit)) throw new KalshiRateLimitError(path.split('?')[0]);
  const response = await fetch(`${kalshiBaseUrl().replace(/\/$/, '')}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.2 local-research' },
    signal: AbortSignal.timeout(timeoutMs), cache: 'no-store',
  });
  if (isRateLimited(response.status)) {
    readRateLimit = recordRateLimited(readRateLimit);
    console.error(`Kalshi read rate limit hit on ${path.split('?')[0]}; pausing reads for ${readRateLimit.pausedUntilMs - Date.now()}ms.`);
    throw new KalshiRateLimitError(path.split('?')[0]);
  }
  if (!response.ok) throw new Error(`Kalshi public ${path.split('?')[0]} returned ${response.status}.`);
  readRateLimit = recordRateLimitSuccess(readRateLimit);
  return response.json() as Promise<T>;
}

/** Both sides' asks for one contract. One request, where a managed-maker quote costs two. */
export async function fetchKalshiQuote(ticker: string): Promise<{ yesBid: number; yesAsk: number } | undefined> {
  const response = await publicKalshiJson<KalshiMarketResponse>(`/markets/${encodeURIComponent(ticker)}`);
  const market = response.market;
  const yesBid = Number(market?.yes_bid_dollars);
  const yesAsk = Number(market?.yes_ask_dollars);
  // Fail closed on a malformed or crossed book rather than returning a price nothing should act on.
  if (!market || !Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid <= 0 || yesAsk <= yesBid) return undefined;
  return { yesBid, yesAsk };
}

export function parseKalshiTradePrints(value: unknown): KalshiTradePrint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as RawKalshiTrade;
    const id = row.trade_id, ticker = row.ticker, at = row.created_time;
    const count = Number(row.count_fp), yesPrice = Number(row.yes_price_dollars), noPrice = Number(row.no_price_dollars);
    const rawSide = (row.taker_outcome_side ?? row.taker_side)?.toLowerCase();
    if (!id || !ticker || !at || !Number.isFinite(Date.parse(at)) || !(count > 0)
      || !(yesPrice > 0 && yesPrice < 1) || !(noPrice > 0 && noPrice < 1)
      || (rawSide !== 'yes' && rawSide !== 'no')) return [];
    return [{ id, ticker, at, count, yesPrice, noPrice, takerSide: rawSide }];
  });
}

/** One-request exact-contract maker quote for detached timing evidence; intentionally omits depth. */
export async function fetchKalshiManagedMakerPriceQuote(ticker: string, side: PositionSide): Promise<ManagedMakerQuote> {
  const response = await publicKalshiJson<KalshiMarketResponse>(`/markets/${encodeURIComponent(ticker)}`);
  const market = response.market;
  const yesBid = Number(market?.yes_bid_dollars), yesAsk = Number(market?.yes_ask_dollars);
  if (!market || !Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid <= 0 || yesAsk <= yesBid) {
    throw new Error('Kalshi did not return a usable exact-contract bid/ask for timing observation.');
  }
  return selectedManagedMakerQuote({ yesBid, yesAsk, side, ranges: market.price_ranges });
}

/** Fresh exact-contract quote plus awaited depth for the independent paper manager. */
export async function fetchKalshiManagedMakerQuote(ticker: string, side: PositionSide): Promise<ManagedMakerQuote> {
  const [response, orderBook] = await Promise.all([
    publicKalshiJson<KalshiMarketResponse>(`/markets/${encodeURIComponent(ticker)}`),
    fetchKalshiOrderBookNow(ticker).catch(() => undefined),
  ]);
  const market = response.market;
  const yesBid = Number(market?.yes_bid_dollars), yesAsk = Number(market?.yes_ask_dollars);
  if (!market || !Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid <= 0 || yesAsk <= yesBid) {
    throw new Error('Kalshi did not return a usable exact-contract bid/ask for paper execution.');
  }
  return selectedManagedMakerQuote({ yesBid, yesAsk, side, ranges: market.price_ranges, orderBook });
}

/**
 * Reads every public trade print newer than `sinceMs`, paging backward when a high-volume contract
 * produced more than one 1,000-row page. A truncated response throws instead of manufacturing a miss.
 */
export async function fetchKalshiTradePrintsSince(ticker: string, sinceMs: number, maximumPages = 5): Promise<KalshiTradePrint[]> {
  const found = new Map<string, KalshiTradePrint>();
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < maximumPages; page += 1) {
    const query = new URLSearchParams({
      limit: '1000', ticker, min_ts: String(Math.max(0, Math.floor(sinceMs / 1_000))),
      ...(cursor ? { cursor } : {}),
    });
    const response = await publicKalshiJson<KalshiTradesResponse>(`/markets/trades?${query.toString()}`, 4_000);
    const parsed = parseKalshiTradePrints(response.trades);
    for (const trade of parsed) if (trade.ticker === ticker && Date.parse(trade.at) + 1e-6 >= sinceMs) found.set(trade.id, trade);
    const oldest = parsed.reduce((minimum, trade) => Math.min(minimum, Date.parse(trade.at)), Number.POSITIVE_INFINITY);
    cursor = response.cursor || undefined;
    if (!cursor || !parsed.length || oldest <= sinceMs) { complete = true; break; }
  }
  if (!complete) throw new Error(`Kalshi trade history exceeded ${maximumPages * 1_000} prints since the last paper observation.`);
  return [...found.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
