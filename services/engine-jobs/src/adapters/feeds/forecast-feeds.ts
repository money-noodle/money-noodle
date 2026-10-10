import type {
  Contract,
  ForecastFeeds,
  ForecastInput,
  ForecastStore,
  Outcome,
  Quote,
  Venue,
} from '../../domain/forecast.js';
const SUBJECTS = [
  ['BTC', 'bitcoin', 'btc', 'XBTUSD', 'KXBTC15M'],
  ['ETH', 'ethereum', 'eth', 'ETHUSD', 'KXETH15M'],
  ['SOL', 'solana', 'sol', 'SOLUSD', 'KXSOL15M'],
  ['XRP', 'ripple', 'xrp', 'XRPUSD', 'KXXRP15M'],
  ['DOGE', 'dogecoin', 'doge', 'DOGEUSD', 'KXDOGE15M'],
  ['BNB', 'binancecoin', 'bnb', 'BNBUSD', 'KXBNB15M'],
  ['HYPE', 'hyperliquid', 'hype', 'HYPEUSD', 'KXHYPE15M'],
] as const;
export type PublicFetch = typeof fetch;
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const number = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const price = (v: unknown): number | null => {
  const n = number(v);
  return n > 0 && n < 1 ? n : null;
};
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const jsonArray = (v: unknown): unknown[] => {
  try {
    return array(JSON.parse(text(v)));
  } catch {
    return [];
  }
};
/** Public data only. Fixed origins, deadlines, no credential/order/account API. */
export function createPublicForecastFeeds(request: PublicFetch = fetch): ForecastFeeds {
  async function body(url: string, ms = 4000, options: RequestInit = {}): Promise<unknown> {
    const response = await request(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(ms),
      headers: { Accept: 'application/json', ...options.headers },
    });
    if (!response.ok) throw new Error('Public forecast provider unavailable.');
    const raw = await response.text();
    if (raw.length > 8_000_000) throw new Error('Public provider response too large.');
    return JSON.parse(raw) as unknown;
  }
  async function poly(prefix: string, slot: number, closesAt: string): Promise<Quote | null> {
    const slug = prefix + '-updown-15m-' + slot;
    const event = object(
      array(
        await body('https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(slug)),
      )[0],
    );
    const market = object(array(event.markets)[0]);
    if (
      market.acceptingOrders !== true ||
      Math.abs(Date.parse(text(event.endDate) || closesAt) - Date.parse(closesAt)) > 5000
    )
      return null;
    const tokens = jsonArray(market.clobTokenIds).filter((v): v is string => typeof v === 'string');
    const books = await body('https://clob.polymarket.com/books', 4000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((token_id) => ({ token_id }))),
    }).catch(() => []);
    const ask = (token: string | undefined): number | null => {
      const book = array(books)
        .map(object)
        .find((b) => b.asset_id === token);
      const prices = array(book?.asks)
        .map((a) => price(object(a).price))
        .filter((p): p is number => p !== null);
      return prices.length ? Math.min(...prices) : null;
    };
    const contractId = text(market.conditionId) || text(market.id);
    if (!contractId) return null;
    return {
      contract: { venue: 'polymarket', contractId, closesAt, slug: text(event.slug) || slug },
      probabilityUp: jsonArray(market.outcomePrices).map(number)[0] ?? 0.5,
      askUp: ask(tokens[0]),
      askDown: ask(tokens[1]),
    };
  }
  async function kalshi(series: string, closesAt: string): Promise<Quote | null> {
    const result = object(
      await body(
        'https://api.elections.kalshi.com/trade-api/v2/markets?limit=10&status=open&series_ticker=' +
          encodeURIComponent(series),
      ),
    );
    const market = array(result.markets)
      .map(object)
      .find(
        (m) =>
          m.status === 'active' &&
          Math.abs(Date.parse(text(m.close_time)) - Date.parse(closesAt)) <= 5000,
      );
    if (market === undefined || !text(market.ticker)) return null;
    const bid = price(market.yes_bid_dollars),
      ask = price(market.yes_ask_dollars);
    return {
      contract: {
        venue: 'kalshi',
        contractId: text(market.ticker),
        closesAt,
        slug: series.toLowerCase(),
      },
      probabilityUp:
        bid !== null && ask !== null ? (bid + ask) / 2 : number(market.last_price_dollars) || 0.5,
      askUp: ask,
      askDown: price(market.no_ask_dollars) ?? (bid === null ? null : 1 - bid),
    };
  }
  async function news(): Promise<readonly { title: string; score: number }[]> {
    const response = await request('https://www.coindesk.com/arc/outboundfeeds/rss', {
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error('News unavailable.');
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new Error('News response too large.');
    const positive = [
      'surge',
      'rally',
      'gain',
      'approval',
      'approve',
      'bull',
      'record',
      'adoption',
      'inflow',
      'breakout',
      'upgrade',
      'growth',
    ];
    const negative = [
      'hack',
      'drop',
      'fall',
      'ban',
      'lawsuit',
      'bear',
      'outflow',
      'liquidation',
      'fraud',
      'exploit',
      'crash',
      'risk',
    ];
    return [...raw.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map((m) => {
      const title = (m[1]?.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/<[^>]*>/g, '')
        .toLowerCase();
      return {
        title,
        score: Math.max(
          -1,
          Math.min(
            1,
            (positive.filter((w) => title.includes(w)).length -
              negative.filter((w) => title.includes(w)).length) /
              2,
          ),
        ),
      };
    });
  }
  async function calculate(
    now: Date,
    enabled: readonly Venue[],
    store: ForecastStore,
  ): Promise<readonly ForecastInput[]> {
    if (!enabled.length) return [];
    const slot = Math.floor(now.getTime() / 900_000) * 900,
      closesAt = new Date((slot + 900) * 1000).toISOString();
    const [coins, headlines] = await Promise.all([
      body(
        'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=' +
          encodeURIComponent(SUBJECTS.map((s) => s[1]).join(',')) +
          '&sparkline=true&price_change_percentage=1h,24h,7d,30d,1y',
      ),
      news(),
    ]);
    const aliases: Record<string, readonly string[]> = {
      BTC: ['bitcoin', 'btc', 'crypto'],
      ETH: ['ethereum', 'ether', 'eth'],
      SOL: ['solana', 'sol'],
      XRP: ['xrp', 'ripple'],
      DOGE: ['dogecoin', 'doge'],
      BNB: ['bnb', 'binance'],
      HYPE: ['hyperliquid', 'hype'],
    };
    const results = await Promise.all(
      SUBJECTS.map(async ([asset, coinId, prefix, pair, series]) => {
        const coin = array(coins)
          .map(object)
          .find((c) => c.id === coinId);
        if (coin === undefined) return null;
        const [ohlc, ticker, weekly, quotes, oracleHistory] = await Promise.all([
          body('https://api.kraken.com/0/public/OHLC?interval=1&pair=' + pair),
          body('https://api.kraken.com/0/public/Ticker?pair=' + pair).catch(() => null),
          body('https://api.kraken.com/0/public/OHLC?interval=10080&pair=' + pair),
          Promise.all([
            enabled.includes('polymarket') ? poly(prefix, slot, closesAt).catch(() => null) : null,
            enabled.includes('kalshi') ? kalshi(series, closesAt).catch(() => null) : null,
          ]),
          store.readOracleHistory(asset, new Date(now.getTime() - 30 * 60_000)),
        ]);
        const rows = array(
          Object.entries(object(object(ohlc).result)).find(
            ([k, v]) => k !== 'last' && Array.isArray(v),
          )?.[1],
        ).map(array);
        const reference = rows.find((r) => number(r[0]) === slot - 60);
        const referencePrice = number(reference?.[4]);
        const minuteCloses = rows
          .slice(-121)
          .map((r) => number(r[4]))
          .filter((p) => p > 0);
        const tickerRow = object(Object.values(object(object(ticker).result))[0]);
        const currentPrice = number(array(tickerRow.c)[0]) || minuteCloses.at(-1) || 0;
        if (!(referencePrice > 0) || !(currentPrice > 0) || minuteCloses.length < 12) return null;
        const weeklyRows = array(
          Object.entries(object(object(weekly).result)).find(
            ([k, v]) => k !== 'last' && Array.isArray(v),
          )?.[1],
        ).map(array);
        const years = new Map<number, number[]>();
        for (const r of weeklyRows) {
          const d = new Date(number(r[0]) * 1000),
            p = number(r[4]);
          if (
            p > 0 &&
            d.getUTCMonth() === now.getUTCMonth() &&
            d.getUTCFullYear() !== now.getUTCFullYear()
          )
            years.set(d.getUTCFullYear(), [...(years.get(d.getUTCFullYear()) ?? []), p]);
        }
        const seasonalReturns = [...years.values()]
          .filter((p) => p.length >= 3)
          .map((p) => (p.at(-1)! / p[0]! - 1) * 100);
        const relevant = headlines.filter((h) => aliases[asset]?.some((a) => h.title.includes(a))),
          selected = relevant.length ? relevant : headlines.slice(0, 5);
        return {
          asset,
          calculatedAt: now.toISOString(),
          closesAt,
          referencePrice,
          currentPrice,
          coinPrice: number(coin.current_price),
          minuteCloses,
          oracleHistory,
          change1h: number(coin.price_change_percentage_1h_in_currency),
          change24h: number(
            coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h,
          ),
          change30d: number(coin.price_change_percentage_30d_in_currency),
          change1y: number(coin.price_change_percentage_1y_in_currency),
          high24h: number(coin.high_24h),
          low24h: number(coin.low_24h),
          seasonalReturns,
          newsScores: selected.map((h) => h.score),
          relevantNewsCount: relevant.length,
          quotes: quotes.filter((q): q is Quote => q !== null),
        } satisfies ForecastInput;
      }),
    );
    return results.filter((r) => r !== null);
  }
  return {
    calculate,
    async resolve(contract: Contract): Promise<Outcome | null> {
      if (contract.venue === 'kalshi') {
        const m = object(
          object(
            await body(
              'https://api.elections.kalshi.com/trade-api/v2/markets/' +
                encodeURIComponent(contract.contractId),
              3000,
            ),
          ).market,
        );
        if (m.ticker !== contract.contractId) return null;
        const result = text(m.result).toLowerCase();
        if (result === 'yes' || result === 'no')
          return {
            venue: 'kalshi',
            contractId: contract.contractId,
            outcome: result === 'yes' ? 'UP' : 'DOWN',
          };
        return ['settled', 'finalized'].includes(text(m.status)) && result
          ? {
              venue: 'kalshi',
              contractId: contract.contractId,
              invalidReason: 'unsupported-result',
            }
          : null;
      }
      const e = object(
        array(
          await body(
            'https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(contract.slug),
            3000,
          ),
        )[0],
      );
      const m = array(e.markets)
        .map(object)
        .find(
          (m) =>
            m.conditionId === contract.contractId ||
            m.id === contract.contractId ||
            contract.contractId === contract.slug,
        );
      if (m === undefined || (e.closed !== true && m.closed !== true)) return null;
      const outcomes = jsonArray(m.outcomes).map((v) => text(v).toUpperCase()),
        prices = jsonArray(m.outcomePrices).map(number),
        winner = outcomes[prices.findIndex((p) => p >= 0.999)];
      if (winner === 'UP' || winner === 'DOWN')
        return { venue: 'polymarket', contractId: contract.contractId, outcome: winner };
      return m.umaResolutionStatus === 'resolved'
        ? {
            venue: 'polymarket',
            contractId: contract.contractId,
            invalidReason: 'non-binary-outcome',
          }
        : null;
    },
  };
}
