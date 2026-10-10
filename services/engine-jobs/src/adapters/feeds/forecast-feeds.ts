import { createHash } from 'node:crypto';
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
  if (v === undefined || v === null || v === '') return 0;
  if (
    (typeof v !== 'number' && typeof v !== 'string') ||
    (typeof v === 'string' && (v.length > 64 || !/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(v)))
  )
    throw new PublicFeedLimitError('Invalid provider numeric representation.');
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e15)
    throw new PublicFeedLimitError('Invalid provider numeric range.');
  return n;
};
const price = (v: unknown): number | null => {
  const n = number(v);
  return n > 0 && n < 1 ? n : null;
};
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const jsonArray = (v: unknown): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(text(v));
    validatePublicSchema(parsed);
    return array(parsed);
  } catch (error) {
    if (error instanceof PublicFeedLimitError) throw error;
    return [];
  }
};
/** Public data only. Fixed origins, deadlines, no credential/order/account API. */
export function createPublicForecastFeeds(
  request: PublicFetch = fetch,
  clock: () => Date = () => new Date(),
): ForecastFeeds {
  let active = 0;
  const queue: Array<() => void> = [];
  async function admitted<T>(work: () => Promise<T>): Promise<T> {
    if (active >= 4) {
      if (queue.length >= 64) throw new PublicFeedLimitError('Public work queue exhausted.');
      await new Promise<void>((resolve) => queue.push(resolve));
    } else active++;
    try {
      return await work();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  }
  async function raw(
    url: string,
    cap: number,
    ms: number,
    options: RequestInit = {},
  ): Promise<string> {
    return admitted(async () => {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), ms);
      try {
        const response = await request(url, {
          ...options,
          redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'application/json', ...options.headers },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error('Public forecast provider unavailable.');
        }
        return await boundedPublicText(response, cap, controller);
      } finally {
        clearTimeout(timer);
      }
    });
  }
  async function body(url: string, ms = 4000, options: RequestInit = {}): Promise<unknown> {
    const value: unknown = JSON.parse(await raw(url, 1_000_000, ms, options));
    validatePublicSchema(value);
    return value;
  }
  const optional = (error: unknown): null => {
    if (error instanceof PublicFeedLimitError) throw error;
    return null;
  };
  async function poly(
    asset: string,
    prefix: string,
    slot: number,
    closesAt: string,
    capturedAt: string,
  ): Promise<Quote | null> {
    const slug = prefix + '-updown-15m-' + slot;
    const event = object(
      array(
        await body('https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(slug)),
      )[0],
    );
    const market = object(array(event.markets)[0]);
    const actualClose = text(market.endDate) || text(event.endDate);
    const outcomes = jsonArray(market.outcomes).map((v) => text(v).toUpperCase());
    if (
      text(event.slug) !== slug ||
      market.acceptingOrders !== true ||
      !Number.isFinite(Date.parse(actualClose)) ||
      Math.abs(Date.parse(actualClose) - Date.parse(closesAt)) > 5000 ||
      outcomes.length !== 2 ||
      !outcomes.includes('UP') ||
      !outcomes.includes('DOWN')
    )
      return null;
    const tokens = jsonArray(market.clobTokenIds).filter((v): v is string => typeof v === 'string');
    if (tokens.length !== 2 || tokens[0] === tokens[1] || tokens.some((t) => !t || t.length > 256))
      return null;
    const books = await body('https://clob.polymarket.com/books', 4000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((token_id) => ({ token_id }))),
    }).catch(optional);
    if (
      array(books).some((b) => !tokens.includes(text(object(b).asset_id))) ||
      array(books).length > 2 ||
      new Set(array(books).map((b) => text(object(b).asset_id))).size !== array(books).length
    )
      throw new PublicFeedLimitError('Invalid book cardinality.');
    const ask = (token: string | undefined): number | null => {
      const book = array(books)
        .map(object)
        .find((b) => b.asset_id === token);
      const prices = array(book?.asks)
        .map((a) => price(object(a).price))
        .filter((p): p is number => p !== null);
      return prices.length ? prices.reduce((a, b) => Math.min(a, b)) : null;
    };
    const contractId = text(market.conditionId) || text(market.id);
    if (!contractId) return null;
    return {
      contract: {
        venue: 'polymarket',
        contractId,
        closesAt: actualClose,
        slug,
        asset,
        requestStartedAt: capturedAt,
        capturedAt: clock().toISOString(),
        ...settlementMetadata(
          [
            event.title,
            event.description,
            market.question,
            market.description,
            market.outcomes,
            event.resolutionSource,
          ]
            .map((value) => text(value).slice(0, 2000))
            .join(' \n'),
          'https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(slug),
          text(event.resolutionSource).slice(0, 2000),
        ),
      },
      probabilityUp: jsonArray(market.outcomePrices).map(number)[outcomes.indexOf('UP')] ?? 0.5,
      askUp: ask(tokens[outcomes.indexOf('UP')]),
      askDown: ask(tokens[outcomes.indexOf('DOWN')]),
    };
  }
  async function kalshi(
    asset: string,
    series: string,
    closesAt: string,
    capturedAt: string,
  ): Promise<Quote | null> {
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
          text(m.ticker).length <= 256 &&
          text(m.ticker).startsWith(series + '-') &&
          Number.isFinite(Date.parse(text(m.close_time))) &&
          Math.abs(Date.parse(text(m.close_time)) - Date.parse(closesAt)) <= 5000,
      );
    if (market === undefined || !text(market.ticker)) return null;
    const bid = price(market.yes_bid_dollars),
      ask = price(market.yes_ask_dollars);
    return {
      contract: {
        venue: 'kalshi',
        contractId: text(market.ticker),
        closesAt: text(market.close_time),
        slug: series.toLowerCase(),
        asset,
        requestStartedAt: capturedAt,
        capturedAt: clock().toISOString(),
        ...settlementMetadata(
          [text(market.rules_primary), text(market.rules_secondary)].join(' '),
          'https://api.elections.kalshi.com/trade-api/v2/markets/' +
            encodeURIComponent(text(market.ticker)),
          [
            market.floor_strike === undefined ? '' : 'Kalshi published floor strike',
            text(market.subtitle),
            text(market.rules_primary),
            text(market.rules_secondary),
          ]
            .join(' ')
            .slice(0, 2000),
        ),
        ...(market.floor_strike === undefined || market.floor_strike === null
          ? {}
          : { referenceValue: number(market.floor_strike) }),
      },
      probabilityUp:
        bid !== null && ask !== null ? (bid + ask) / 2 : number(market.last_price_dollars) || 0.5,
      askUp: ask,
      askDown: price(market.no_ask_dollars) ?? (bid === null ? null : 1 - bid),
    };
  }
  async function news(): Promise<readonly { title: string; score: number }[]> {
    const rss = await raw('https://www.coindesk.com/arc/outboundfeeds/rss', 256_000, 4000);
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
    const items: RegExpExecArray[] = [];
    const pattern = /<item>([\s\S]*?)<\/item>/g;
    for (let i = 0; i < 12; i++) {
      const match = pattern.exec(rss);
      if (match === null) break;
      items.push(match);
    }
    return items.map((m) => {
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
          body('https://api.kraken.com/0/public/Ticker?pair=' + pair).catch(optional),
          body('https://api.kraken.com/0/public/OHLC?interval=10080&pair=' + pair),
          Promise.all([
            enabled.includes('polymarket')
              ? poly(asset, prefix, slot, closesAt, now.toISOString()).catch(optional)
              : null,
            enabled.includes('kalshi')
              ? kalshi(asset, series, closesAt, now.toISOString()).catch(optional)
              : null,
          ]),
          store.readOracleHistory(asset, new Date(now.getTime() - 30 * 60_000)),
        ]);
        const completedAt = clock();
        const rows = array(krakenPair(ohlc, pair)).map(array);
        const reference = rows.find((r) => number(r[0]) === slot - 60),
          referencePrice = number(reference?.[4]);
        const latest = rows.at(-1),
          sourceTime = number(latest?.[0]) * 1000;
        // Current ticker has no source timestamp; use its matching series only after
        // a fresh current candle proves that this pair's public series is current.
        if (
          !Number.isFinite(sourceTime) ||
          sourceTime > completedAt.getTime() + 5000 ||
          completedAt.getTime() - sourceTime > 90000
        )
          return null;
        const minuteCloses = rows
          .slice(-121)
          .map((r) => number(r[4]))
          .filter((v) => v > 0);
        const tickerRow = object(krakenPair(ticker, pair));
        const currentPrice = number(array(tickerRow.c)[0]) || minuteCloses.at(-1) || 0;
        if (!(referencePrice > 0) || !(currentPrice > 0) || minuteCloses.length < 12) return null;
        const weeklyRows = array(krakenPair(weekly, pair)).map(array);
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
          requestStartedAt: now.toISOString(),
          calculatedAt: completedAt.toISOString(),
          closesAt:
            quotes.find((q) => q?.contract.venue === 'polymarket')?.contract.closesAt ??
            quotes.find((q) => q !== null)?.contract.closesAt ??
            closesAt,
          sourceObservedAt: new Date(sourceTime).toISOString(),
          referenceSource:
            'Kraken 1m series at cycle open (same-series approximation, not venue oracle equality)',
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
      if (
        !contract.contractId ||
        contract.contractId.length > 256 ||
        !contract.slug ||
        contract.slug.length > 256
      )
        return null;
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

/** Preserve unknown rules as unknown rather than inventing an oracle or window. */
export function settlementMetadata(
  value: unknown,
  rulesSource: string,
  referenceSource?: string,
): Pick<
  Contract,
  | 'referenceSource'
  | 'referenceWindowSeconds'
  | 'rulesSource'
  | 'rulesFingerprint'
  | 'rulesText'
  | 'settlementPriceMethod'
  | 'settlementWindowSeconds'
> {
  const rulesText = text(value).slice(0, 16000).replace(/\s+/g, ' ').trim();
  const parsedText = rulesText + ' ' + (referenceSource ?? '');
  const settlementPriceMethod = /time[- ]weighted|\btwap\b/i.test(parsedText)
    ? 'time-weighted-average'
    : /simple average|average of (?:the )?(?:\w+|\d+) (?:seconds|prices)|prices are collected/i.test(
          parsedText,
        )
      ? 'simple-average'
      : /closing price|last price|price at (?:the )?(?:end|beginning)/i.test(parsedText)
        ? 'point-in-time'
        : 'unknown';
  const words: Record<string, number> = {
    one: 1,
    five: 5,
    ten: 10,
    fifteen: 15,
    thirty: 30,
    sixty: 60,
  };
  const stream = parsedText.match(/twap[-_ ](\d+)[-_ ]?s(?:[-_ ]?streams?)?\b/i);
  const seconds = parsedText.match(
    /\b(one|five|ten|fifteen|thirty|sixty|\d+)\s*(?:-\s*)?seconds?\b/i,
  );
  const window = stream
    ? Number(stream[1])
    : seconds
      ? (words[seconds[1]!.toLowerCase()] ?? Number(seconds[1]))
      : /final minute|last minute/i.test(parsedText)
        ? 60
        : undefined;
  return {
    rulesSource,
    ...(referenceSource ? { referenceSource } : {}),
    rulesText,
    rulesFingerprint: createHash('sha256').update(rulesText).digest('hex'),
    settlementPriceMethod,
    ...(settlementPriceMethod !== 'unknown' &&
    settlementPriceMethod !== 'point-in-time' &&
    window !== undefined &&
    window > 0 &&
    window <= 900
      ? { settlementWindowSeconds: window, referenceWindowSeconds: window }
      : {}),
  };
}

const KRAKEN_ALIASES: Record<string, readonly string[]> = {
  XBTUSD: ['XBTUSD', 'XXBTZUSD'],
  ETHUSD: ['ETHUSD', 'XETHZUSD'],
  SOLUSD: ['SOLUSD'],
  XRPUSD: ['XRPUSD', 'XXRPZUSD'],
  DOGEUSD: ['DOGEUSD', 'XDGUSD', 'XXDGZUSD'],
  BNBUSD: ['BNBUSD'],
  HYPEUSD: ['HYPEUSD'],
};
export function krakenPair(payload: unknown, pair: string): unknown {
  const root = object(payload);
  if (array(root.error).length) return undefined;
  const result = object(root.result);
  for (const key of KRAKEN_ALIASES[pair] ?? []) if (Object.hasOwn(result, key)) return result[key];
  return undefined;
}

export class PublicFeedLimitError extends Error {}
/** Read decoded transport bytes, before text/JSON allocation. Overshoot is at most
 * one transport chunk; cancel and abort immediately, never drain the remainder. */
export async function boundedPublicText(
  response: Response,
  cap: number,
  controller: AbortController,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        controller.abort();
        throw new PublicFeedLimitError('Public response byte budget exceeded.');
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    controller.abort();
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export function validatePublicSchema(value: unknown): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 20000 || depth > 12)
      throw new PublicFeedLimitError('Public schema work budget exceeded.');
    if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > 1e15))
      throw new PublicFeedLimitError('Invalid provider numeric value.');
    if (typeof v === 'string' && v.length > 16000)
      throw new PublicFeedLimitError('Provider string too long.');
    if (Array.isArray(v)) {
      if (v.length > 1000) throw new PublicFeedLimitError('Provider list too large.');
      for (const item of v) visit(item, depth + 1);
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.length > 128) throw new PublicFeedLimitError('Provider object too large.');
      for (const [key, item] of entries) {
        if (key.length > 256) throw new PublicFeedLimitError('Provider key too long.');
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
}
