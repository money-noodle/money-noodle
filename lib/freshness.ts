export const DATA_FRESHNESS = {
  dashboardPollMs: 15_000,
  observationBucketMs: 15_000,
  polymarketCacheMs: 12_000,
  kalshiCacheMs: 12_000,
  contractReferenceCacheMs: 10_000,
  minuteHistoryCacheMs: 60_000,
  coinGeckoCacheMs: 60_000,
  newsCacheMs: 10 * 60_000,
  seasonalCacheMs: 24 * 60 * 60_000,
  localPriceSnapshotMs: 60 * 60_000,
  venueHistoryMinimumSpacingMs: 10_000,
  oracleSampleMinimumSpacingMs: 10_000,
  oracleHistoryWindowMs: 30 * 60_000,
  venueSmoothingWindowMs: 3 * 60_000,
  resolutionRetryMs: 60_000,
} as const;

export function isFreshCalculationTimestamp(timestamp: string, now = Date.now()): boolean {
  const calculatedAt = Date.parse(timestamp);
  if (!Number.isFinite(calculatedAt)) return false;
  const age = now - calculatedAt;
  return age >= 0 && age <= DATA_FRESHNESS.observationBucketMs;
}

export function formatCadence(milliseconds: number): string {
  if (milliseconds % (24 * 60 * 60_000) === 0) return `Every ${milliseconds / (24 * 60 * 60_000)} ${milliseconds === 24 * 60 * 60_000 ? 'day' : 'days'}`;
  if (milliseconds % (60 * 60_000) === 0) return `Every ${milliseconds / (60 * 60_000)} ${milliseconds === 60 * 60_000 ? 'hour' : 'hours'}`;
  if (milliseconds % 60_000 === 0) return `Every ${milliseconds / 60_000} ${milliseconds === 60_000 ? 'minute' : 'minutes'}`;
  return `Every ${milliseconds / 1000} seconds`;
}

export interface DataCadenceItem {
  id: string;
  source: string;
  cadenceMs: number | null;
  cadenceLabel: string;
  purpose: string;
  mode: 'poll' | 'cache' | 'snapshot' | 'on-demand';
}

export const DATA_CADENCE: DataCadenceItem[] = [
  { id: 'model', source: 'Money Noodle model', cadenceMs: DATA_FRESHNESS.dashboardPollMs, cadenceLabel: formatCadence(DATA_FRESHNESS.dashboardPollMs), purpose: 'Recalculates probabilities and edge gates from the latest available inputs.', mode: 'poll' },
  { id: 'polymarket', source: 'Polymarket', cadenceMs: DATA_FRESHNESS.dashboardPollMs, cadenceLabel: formatCadence(DATA_FRESHNESS.dashboardPollMs), purpose: 'Current 15-minute market probability, liquidity, volume, and close time.', mode: 'poll' },
  { id: 'contract-reference', source: 'Contract oracle reference', cadenceMs: DATA_FRESHNESS.contractReferenceCacheMs, cadenceLabel: formatCadence(DATA_FRESHNESS.contractReferenceCacheMs), purpose: 'Cycle open reference price and live oracle price that decide contract settlement.', mode: 'poll' },
  { id: 'volatility', source: 'Kraken 1m realized volatility', cadenceMs: DATA_FRESHNESS.minuteHistoryCacheMs, cadenceLabel: formatCadence(DATA_FRESHNESS.minuteHistoryCacheMs), purpose: 'Recent one-minute returns that scale the expected move over the remaining contract time.', mode: 'cache' },
  { id: 'kalshi', source: 'Kalshi', cadenceMs: DATA_FRESHNESS.dashboardPollMs, cadenceLabel: formatCadence(DATA_FRESHNESS.dashboardPollMs), purpose: 'Current approximately comparable YES/NO market quotes.', mode: 'poll' },
  { id: 'recommendations', source: 'Positive-edge tracker', cadenceMs: DATA_FRESHNESS.observationBucketMs, cadenceLabel: `One record per ${DATA_FRESHNESS.observationBucketMs / 1000}-second bucket`, purpose: 'Persists every qualifying update without duplicate requests in the same bucket.', mode: 'snapshot' },
  { id: 'cycle-paths', source: 'Aligned cycle regime recorder', cadenceMs: DATA_FRESHNESS.observationBucketMs, cadenceLabel: `One point per ${DATA_FRESHNESS.observationBucketMs / 1000}-second bucket`, purpose: 'Observation-only sign flips, autocorrelation, trend efficiency, range, and local volatility; never changes the live gate.', mode: 'snapshot' },
  { id: 'paper-execution', source: 'Paper execution engine', cadenceMs: DATA_FRESHNESS.dashboardPollMs, cadenceLabel: formatCadence(DATA_FRESHNESS.dashboardPollMs), purpose: 'Settles due paper positions, enforces risk controls, and evaluates at most one new idempotent buy order per contract cycle.', mode: 'poll' },
  { id: 'coingecko', source: 'CoinGecko', cadenceMs: DATA_FRESHNESS.coinGeckoCacheMs, cadenceLabel: formatCadence(DATA_FRESHNESS.coinGeckoCacheMs), purpose: 'Spot prices, returns, and seven-day chart history.', mode: 'cache' },
  { id: 'news', source: 'CoinDesk RSS', cadenceMs: DATA_FRESHNESS.newsCacheMs, cadenceLabel: formatCadence(DATA_FRESHNESS.newsCacheMs), purpose: 'Recent headlines and rule-based news sentiment.', mode: 'cache' },
  { id: 'kraken', source: 'Kraken OHLC', cadenceMs: DATA_FRESHNESS.seasonalCacheMs, cadenceLabel: formatCadence(DATA_FRESHNESS.seasonalCacheMs), purpose: 'Multi-year weekly history used for seasonal factors.', mode: 'cache' },
  { id: 'local-history', source: 'Local price history', cadenceMs: DATA_FRESHNESS.localPriceSnapshotMs, cadenceLabel: `${formatCadence(DATA_FRESHNESS.localPriceSnapshotMs)} snapshot`, purpose: 'Accumulates a durable supplemental local seasonal baseline.', mode: 'snapshot' },
  { id: 'accounts', source: 'Venue accounts', cadenceMs: null, cadenceLabel: 'On demand', purpose: 'Refreshes when Portfolio opens or its refresh button is pressed.', mode: 'on-demand' },
] as const;
