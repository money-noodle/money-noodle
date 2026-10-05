// CoinGecko: the spot snapshot and the seven-day sparkline.
//
// One public, keyless call for every asset at once. That tier's rate limit is the real
// constraint on how often this may be asked, which is why its time to live is the
// longest of the short feeds.
//
// The sparkline's times are synthesized, and the published contract says so. The
// provider sends an unlabelled array of prices covering roughly seven days, with no
// timestamps at all; spacing them evenly backwards from the fetch is the only thing
// that can be done with them, and calling the result a provider time would be a lie.
// Every other number here is the provider's own, unrounded.

import type { SpotSnapshot } from '../../domain/market-feeds.js';
import type { MarketAsset } from '../../domain/market-registry.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  asArray,
  asRecord,
  asText,
  optionalNumber,
  optionalText,
  type UpstreamRecord,
} from './upstream-values.js';

const MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** The most sparkline points published, so an oversized array cannot be served. */
export const MAX_CHART_POINTS = 400;

function sparkline(row: UpstreamRecord, fetchedAt: Date): SpotSnapshot['chart'] {
  const container = row.sparkline_in_7d;
  if (container === undefined || container === null) return Object.freeze([]);
  const prices = asArray(asRecord(container).price ?? [])
    .map((value) => optionalNumber(value))
    .filter((value): value is number => value !== undefined)
    .slice(-MAX_CHART_POINTS);
  if (prices.length === 0) return Object.freeze([]);

  const spacing = prices.length > 1 ? SEVEN_DAYS_MS / (prices.length - 1) : 0;
  return Object.freeze(
    prices.map((price, index) =>
      Object.freeze({
        price,
        time: new Date(fetchedAt.getTime() - (prices.length - 1 - index) * spacing),
      }),
    ),
  );
}

/** Snapshots keyed by symbol, for the assets the response carried. */
export function readSpotSnapshots(
  payload: unknown,
  assets: readonly MarketAsset[],
  fetchedAt: Date,
): ReadonlyMap<string, SpotSnapshot> {
  const rows = asArray(payload).map((row) => asRecord(row));
  const byId = new Map(rows.map((row) => [asText(row.id), row]));
  const snapshots = new Map<string, SpotSnapshot>();

  for (const asset of assets) {
    const row = byId.get(asset.coinGeckoId);
    if (row === undefined) continue;
    snapshots.set(
      asset.symbol,
      Object.freeze({
        // Absent rather than zero: the provider omits a percentage it has not computed,
        // and a published zero would read as "unchanged".
        ...optional('change1hPercent', optionalNumber(row.price_change_percentage_1h_in_currency)),
        ...optional('change7dPercent', optionalNumber(row.price_change_percentage_7d_in_currency)),
        ...optional(
          'change24hPercent',
          optionalNumber(row.price_change_percentage_24h_in_currency) ??
            optionalNumber(row.price_change_percentage_24h),
        ),
        ...optional(
          'change30dPercent',
          optionalNumber(row.price_change_percentage_30d_in_currency),
        ),
        ...optional('change1yPercent', optionalNumber(row.price_change_percentage_1y_in_currency)),
        chart: sparkline(row, fetchedAt),
        ...optional('high24h', optionalNumber(row.high_24h)),
        ...optional('iconUrl', httpsIcon(optionalText(row.image))),
        ...optional('low24h', optionalNumber(row.low_24h)),
        ...optional('price', optionalNumber(row.current_price)),
        symbol: asset.symbol,
        ...optional('volume24h', optionalNumber(row.total_volume)),
      }),
    );
  }

  // The feed has nothing to publish only when it carried none of the assets asked for;
  // one missing asset is one missing asset, not an outage.
  if (snapshots.size === 0) throw new FeedFailure('upstream-invalid');
  return snapshots;
}

/** An icon a browser may load: http(s) only, never a data or javascript URL. */
function httpsIcon(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

export interface CoinGeckoFeed {
  readonly loadSpotSnapshots: (
    assets: readonly MarketAsset[],
    fetchedAt: Date,
  ) => Promise<ReadonlyMap<string, SpotSnapshot>>;
}

export function createCoinGeckoFeed(client: FeedHttpClient): CoinGeckoFeed {
  return Object.freeze({
    loadSpotSnapshots: async (assets: readonly MarketAsset[], fetchedAt: Date) => {
      const ids = assets.map((asset) => asset.coinGeckoId).join(',');
      const url =
        `${MARKETS_URL}?vs_currency=usd&ids=${ids}&sparkline=true` +
        '&price_change_percentage=1h,24h,7d,30d,1y';
      return readSpotSnapshots(await client.getJson(url), assets, fetchedAt);
    },
  });
}
