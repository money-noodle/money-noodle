import 'server-only';
import { kalshiBaseUrl } from './kalshi-api';
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

async function publicKalshiJson<T>(path: string, timeoutMs = 2_500): Promise<T> {
  const response = await fetch(`${kalshiBaseUrl().replace(/\/$/, '')}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.2 local-research' },
    signal: AbortSignal.timeout(timeoutMs), cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Kalshi public ${path.split('?')[0]} returned ${response.status}.`);
  return response.json() as Promise<T>;
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
