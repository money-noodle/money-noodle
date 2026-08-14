import { createContractProvenance } from './contract-provenance';
import type { ChartPoint, MarketQuote, NewsItem, VenueQuote } from './types';

export const ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin', coinGeckoId: 'bitcoin', poly: 'btc' },
  { symbol: 'ETH', name: 'Ethereum', coinGeckoId: 'ethereum', poly: 'eth' },
  { symbol: 'SOL', name: 'Solana', coinGeckoId: 'solana', poly: 'sol' },
  { symbol: 'XRP', name: 'XRP', coinGeckoId: 'ripple', poly: 'xrp' },
  { symbol: 'DOGE', name: 'Dogecoin', coinGeckoId: 'dogecoin', poly: 'doge' },
  { symbol: 'BNB', name: 'BNB', coinGeckoId: 'binancecoin', poly: 'bnb' },
  { symbol: 'HYPE', name: 'Hyperliquid', coinGeckoId: 'hyperliquid', poly: 'hype' },
] as const;

export interface CoinSnapshot {
  symbol: string;
  name: string;
  iconUrl?: string;
  price: number;
  high24h: number;
  low24h: number;
  volume: number;
  change1h: number;
  change24h: number;
  change7d: number;
  change30d: number;
  change1y: number;
  chart: ChartPoint[];
}

/**
 * Bounded well inside the 15-second calculation cadence.
 *
 * A feed that answers more slowly than this cannot be used by the cycle that asked: `cached` falls back
 * to the previous value and the next cycle asks again. Waiting the old ten seconds bought nothing and
 * cost the whole window — one stalling feed made every calculation late, because the six run together
 * and the build takes as long as the slowest.
 */
const FEED_TIMEOUT_MS = 4_000;

function timeoutSignal(ms = FEED_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.1 local-research' },
    signal: timeoutSignal(),
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).hostname}`);
  return response.json() as Promise<T>;
}

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'DOGEUSD', BNB: 'BNBUSD', HYPE: 'HYPEUSD',
};

export const CONTRACT_SLOT_SECONDS = 900;

export function contractSlot(now = Date.now()): number {
  return Math.floor(now / (CONTRACT_SLOT_SECONDS * 1000)) * CONTRACT_SLOT_SECONDS;
}

export interface ContractReference {
  symbol: string;
  slot: number;
  referencePrice: number;
  currentPrice: number;
  referenceSource: string;
}

export interface PriceSeries extends ContractReference {
  closes: number[];
}

const KRAKEN_TICKER_KEYS: Record<string, string> = {
  BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD', DOGE: 'XDGUSD', BNB: 'BNBUSD', HYPE: 'HYPEUSD',
};

async function fetchKrakenLastTrades(): Promise<Record<string, number>> {
  const pairs = ASSETS.map((asset) => KRAKEN_PAIRS[asset.symbol]).join(',');
  const payload = await fetchJson<{ error: string[]; result: Record<string, { c?: string[] }> }>(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`);
  if (payload.error.length) throw new Error(`Kraken ticker: ${payload.error.join(', ')}`);
  const prices: Record<string, number> = {};
  for (const asset of ASSETS) {
    const key = KRAKEN_TICKER_KEYS[asset.symbol];
    const row = payload.result[key] ?? Object.entries(payload.result).find(([name]) => name.includes(asset.symbol === 'BTC' ? 'XBT' : asset.symbol === 'DOGE' ? 'XDG' : asset.symbol))?.[1];
    const last = Number(row?.c?.[0]);
    if (Number.isFinite(last) && last > 0) prices[asset.symbol] = last;
  }
  return prices;
}

/**
 * Reference and live prices for the active cycle, both taken from one exchange series.
 *
 * The contract settles on a venue oracle, but the reference and the live price must come from the
 * same series: the signal is a fraction of a percent, so a cross-source basis offset would swamp it
 * entirely. Venue oracle levels are still compared against this reference to detect series drift.
 */
export async function fetchPriceSeries(): Promise<Record<string, PriceSeries>> {
  const slot = contractSlot();
  const lastTrades = await fetchKrakenLastTrades().catch(() => ({} as Record<string, number>));
  const entries = await Promise.all(ASSETS.map(async (asset) => {
    try {
      const payload = await fetchJson<{ error: string[]; result: Record<string, Array<Array<number | string>> | number> }>(
        `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIRS[asset.symbol]}&interval=1`,
      );
      if (payload.error.length) return null;
      const rows = Object.entries(payload.result).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1];
      if (!Array.isArray(rows)) return null;
      const closes = rows.slice(-121).map((row) => Number(row[4])).filter((price) => Number.isFinite(price) && price > 0);
      // The candle covering the final minute before the cycle opened closes exactly at the open, so
      // its close approximates the settlement reference the venues fix at that instant.
      const referenceRow = rows.find((row) => Number(row[0]) === slot - 60);
      const referencePrice = Number(referenceRow?.[4]);
      const currentPrice = lastTrades[asset.symbol] ?? closes.at(-1);
      if (closes.length < 12 || !Number.isFinite(referencePrice) || referencePrice <= 0 || !currentPrice) return null;
      return [asset.symbol, {
        symbol: asset.symbol, slot, referencePrice, currentPrice, closes,
        referenceSource: 'Kraken 1m series at cycle open',
      } satisfies PriceSeries] as const;
    } catch { return null; }
  }));
  const valid = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (!valid.length) throw new Error('No usable price series for contract basis');
  return Object.fromEntries(valid);
}

export async function fetchSeasonalHistory(): Promise<Record<string, ChartPoint[]>> {
  const krakenPairs = KRAKEN_PAIRS;
  const entries = await Promise.all(ASSETS.map(async (asset) => {
    const payload = await fetchJson<{ error: string[]; result: Record<string, Array<Array<number | string>> | number> }>(
      `https://api.kraken.com/0/public/OHLC?pair=${krakenPairs[asset.symbol]}&interval=10080`,
    );
    if (payload.error.length) throw new Error(`Kraken: ${payload.error.join(', ')}`);
    const rows = Object.entries(payload.result).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1];
    if (!Array.isArray(rows)) throw new Error(`Kraken omitted history for ${asset.symbol}`);
    const chart = rows.map((row) => ({ time: Number(row[0]) * 1000, price: Number(row[4]) })).filter((point) => point.time && point.price);
    return [asset.symbol, chart] as const;
  }));
  return Object.fromEntries(entries);
}

export async function fetchCoinSnapshots(): Promise<CoinSnapshot[]> {
  const ids = ASSETS.map((asset) => asset.coinGeckoId).join(',');
  const url = new URL('https://api.coingecko.com/api/v3/coins/markets');
  url.searchParams.set('vs_currency', 'usd');
  url.searchParams.set('ids', ids);
  url.searchParams.set('sparkline', 'true');
  url.searchParams.set('price_change_percentage', '1h,24h,7d,30d,1y');

  const rows = await fetchJson<Array<Record<string, unknown>>>(url.toString());
  return ASSETS.map((asset) => {
    const row = rows.find((item) => item.id === asset.coinGeckoId);
    if (!row) throw new Error(`CoinGecko omitted ${asset.symbol}`);
    const prices = ((row.sparkline_in_7d as { price?: number[] } | undefined)?.price ?? []).filter(Number.isFinite);
    const now = Date.now();
    const spacing = prices.length > 1 ? (7 * 24 * 60 * 60 * 1000) / (prices.length - 1) : 1;
    return {
      symbol: asset.symbol,
      name: asset.name,
      iconUrl: String(row.image ?? ''),
      price: Number(row.current_price ?? 0),
      high24h: Number(row.high_24h ?? 0),
      low24h: Number(row.low_24h ?? 0),
      volume: Number(row.total_volume ?? 0),
      change1h: Number(row.price_change_percentage_1h_in_currency ?? 0),
      change24h: Number(row.price_change_percentage_24h_in_currency ?? row.price_change_percentage_24h ?? 0),
      change7d: Number(row.price_change_percentage_7d_in_currency ?? 0),
      change30d: Number(row.price_change_percentage_30d_in_currency ?? 0),
      change1y: Number(row.price_change_percentage_1y_in_currency ?? 0),
      chart: prices.map((price, index) => ({ time: now - (prices.length - 1 - index) * spacing, price })),
    };
  });
}

type GammaMarket = {
  id?: string;
  conditionId?: string;
  question?: string;
  description?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  liquidityNum?: number;
  volumeNum?: number;
  acceptingOrders?: boolean;
};
type GammaEvent = {
  id?: string;
  title?: string;
  description?: string;
  resolutionSource?: string;
  markets?: GammaMarket[];
  endDate?: string;
  slug?: string;
};
type ClobBook = { asset_id: string; bids?: Array<{ price: string }>; asks?: Array<{ price: string }> };

async function fetchPolymarketBooks(tokenIds: string[]): Promise<Map<string, ClobBook>> {
  if (!tokenIds.length) return new Map();
  const response = await fetch('https://clob.polymarket.com/books', {
    method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': 'MoneyNoodle/0.2 local-research' },
    body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))), signal: timeoutSignal(),
  });
  if (!response.ok) throw new Error(`Polymarket CLOB books returned ${response.status}`);
  const books = await response.json() as ClobBook[];
  return new Map(books.map((book) => [book.asset_id, book]));
}

function bestPrice(orders: Array<{ price: string }> | undefined, side: 'bid' | 'ask'): number | undefined {
  const prices = (orders ?? []).map((order) => Number(order.price)).filter((price) => Number.isFinite(price) && price > 0 && price < 1);
  if (!prices.length) return undefined;
  return side === 'ask' ? Math.min(...prices) : Math.max(...prices);
}

export async function fetchPolymarketQuotes(): Promise<Record<string, MarketQuote>> {
  const slot = Math.floor(Date.now() / 900_000) * 900;
  const entries = await Promise.all(ASSETS.map(async (asset) => {
    try {
      const slug = `${asset.poly}-updown-15m-${slot}`;
      const events = await fetchJson<GammaEvent[]>(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const event = events[0];
      const market = event?.markets?.[0];
      if (!event || !market) throw new Error(`No active market for ${asset.symbol}`);
      const prices = JSON.parse(market.outcomePrices ?? '[0.5,0.5]').map(Number) as number[];
      const tokenIds = JSON.parse(market.clobTokenIds ?? '[]') as string[];
      const marketUrl = `https://polymarket.com/event/${event.slug ?? slug}`;
      const closesAt = event.endDate ?? new Date((slot + 900) * 1000).toISOString();
      const contractId = market.conditionId ?? market.id ?? event.id ?? event.slug ?? slug;
      const rulesText = [event.title, event.description, market.question, market.description, market.outcomes, event.resolutionSource]
        .filter(Boolean).join('\n');
      return {
        symbol: asset.symbol, tokenIds,
        quote: {
          probabilityUp: prices[0] ?? 0.5, probabilityDown: prices[1] ?? 0.5,
          liquidity: Number(market.liquidityNum ?? 0), volume: Number(market.volumeNum ?? 0),
          url: marketUrl,
          closesAt,
          live: Boolean(market.acceptingOrders),
          contract: createContractProvenance({
            venue: 'polymarket', contractId, marketUrl, closesAt,
            rulesSource: `https://gamma-api.polymarket.com/events?slug=${event.slug ?? slug}`,
            rulesText: rulesText || `${asset.symbol} 15-minute UP/DOWN contract ${event.slug ?? slug}`,
            referenceSource: event.resolutionSource,
            comparability: 'approximate',
          }),
        } as MarketQuote,
      };
    } catch { return null; }
  }));
  const valid = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (!valid.length) throw new Error('No active Polymarket 15-minute markets found');
  try {
    const books = await fetchPolymarketBooks(valid.flatMap((entry) => entry.tokenIds));
    for (const entry of valid) {
      const upBook = books.get(entry.tokenIds[0]);
      const downBook = books.get(entry.tokenIds[1]);
      entry.quote.bidUp = bestPrice(upBook?.bids, 'bid');
      entry.quote.askUp = bestPrice(upBook?.asks, 'ask');
      entry.quote.bidDown = bestPrice(downBook?.bids, 'bid');
      entry.quote.askDown = bestPrice(downBook?.asks, 'ask');
    }
  } catch {
    // Probability research remains available, but the actionable price gate fails closed without asks.
  }
  return Object.fromEntries(valid.map((entry) => [entry.symbol, entry.quote]));
}

export function kalshiSeriesTicker(symbol: string): string {
  return `KX${symbol.toUpperCase()}15M`;
}

export type KalshiMarket = {
  ticker: string;
  status: string;
  close_time: string;
  floor_strike?: number;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  liquidity_dollars: string;
  volume_fp: string;
  rules_primary?: string;
  rules_secondary?: string;
};

export function selectAlignedKalshiMarket(markets: KalshiMarket[], nowMs = Date.now()): KalshiMarket | undefined {
  const expectedCloseMs = (Math.floor(nowMs / (CONTRACT_SLOT_SECONDS * 1000)) + 1) * CONTRACT_SLOT_SECONDS * 1000;
  return markets
    .filter((market) => market.status === 'active' && Date.parse(market.close_time) > nowMs)
    .map((market) => ({ market, distance: Math.abs(Date.parse(market.close_time) - expectedCloseMs) }))
    .filter(({ distance }) => Number.isFinite(distance) && distance <= 5_000)
    .sort((a, b) => a.distance - b.distance)[0]?.market;
}

export async function fetchKalshiQuotes(): Promise<Record<string, VenueQuote>> {
  const entries = await Promise.all(ASSETS.map(async (asset) => {
    try {
      const series = kalshiSeriesTicker(asset.symbol);
      const payload = await fetchJson<{ markets: KalshiMarket[] }>(
        `https://api.elections.kalshi.com/trade-api/v2/markets?limit=10&status=open&series_ticker=${series}`,
      );
      const row = selectAlignedKalshiMarket(payload.markets);
      if (!row) throw new Error(`No active time-aligned Kalshi market for ${asset.symbol}`);
      const bid = Number(row.yes_bid_dollars || 0);
      const ask = Number(row.yes_ask_dollars || 0);
      const bidDown = Number(row.no_bid_dollars || (ask ? 1 - ask : 0));
      const askDown = Number(row.no_ask_dollars || (bid ? 1 - bid : 0));
      const last = Number(row.last_price_dollars || 0.5);
      const midpoint = bid && ask ? (bid + ask) / 2 : last;
      const marketUrl = `https://kalshi.com/markets/${series.toLowerCase()}`;
      const floorStrike = Number.isFinite(Number(row.floor_strike)) ? Number(row.floor_strike) : undefined;
      return [asset.symbol, {
        venue: 'kalshi', probabilityUp: midpoint, bidUp: bid, askUp: ask, bidDown, askDown,
        liquidity: Number(row.liquidity_dollars || 0), volume: Number(row.volume_fp || 0),
        url: marketUrl, closesAt: row.close_time,
        ticker: row.ticker, live: row.status === 'active', comparability: 'approximate',
        floorStrike,
        contract: createContractProvenance({
          venue: 'kalshi', contractId: row.ticker, marketUrl, closesAt: row.close_time,
          rulesSource: `https://api.elections.kalshi.com/trade-api/v2/markets/${row.ticker}`,
          rulesText: [row.rules_primary, row.rules_secondary].filter(Boolean).join('\n')
            || `${asset.symbol} 15-minute YES/NO contract ${row.ticker}`,
          referenceSource: 'Kalshi contract floor_strike and published market rules',
          referenceValue: floorStrike,
          comparability: 'approximate',
        }),
      } satisfies VenueQuote] as const;
    } catch {
      return null;
    }
  }));
  const valid = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (!valid.length) throw new Error('No active Kalshi 15-minute crypto markets found');
  return Object.fromEntries(valid);
}

const POSITIVE = ['surge', 'rally', 'gain', 'approval', 'approve', 'bull', 'record', 'adoption', 'inflow', 'breakout', 'upgrade', 'growth'];
const NEGATIVE = ['hack', 'drop', 'fall', 'ban', 'lawsuit', 'bear', 'outflow', 'liquidation', 'fraud', 'exploit', 'crash', 'risk'];

function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
}

export async function fetchCryptoNews(): Promise<NewsItem[]> {
  const response = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/', {
    headers: { 'User-Agent': 'MoneyNoodle/0.1 local-research' },
    signal: timeoutSignal(),
  });
  if (!response.ok) throw new Error(`News feed returned ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map((match) => {
    const item = match[1];
    const pick = (tag: string) => decodeXml(item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? '');
    const title = pick('title');
    const lower = title.toLowerCase();
    const raw = POSITIVE.filter((word) => lower.includes(word)).length - NEGATIVE.filter((word) => lower.includes(word)).length;
    const score = Math.max(-1, Math.min(1, raw / 2));
    return {
      title,
      link: pick('link'),
      publishedAt: pick('pubDate'),
      sentiment: score > 0.1 ? 'bullish' : score < -0.1 ? 'bearish' : 'neutral',
      score,
    };
  });
}
