import { describe, expect, it } from 'vitest';
import { DATA_CADENCE, DATA_FRESHNESS, formatCadence, isFreshCalculationTimestamp } from './freshness';

describe('data freshness metadata', () => {
  it('derives displayed cadence from runtime constants', () => {
    expect(DATA_CADENCE.find((item) => item.id === 'polymarket')?.cadenceMs).toBe(DATA_FRESHNESS.dashboardPollMs);
    expect(DATA_CADENCE.find((item) => item.id === 'coingecko')?.cadenceLabel).toBe(formatCadence(DATA_FRESHNESS.coinGeckoCacheMs));
    expect(DATA_CADENCE.find((item) => item.id === 'kraken')?.cadenceLabel).toBe(formatCadence(DATA_FRESHNESS.seasonalCacheMs));
  });

  it('starts stateless refresh with the same lead used by server prefetch', () => {
    expect(DATA_FRESHNESS.calculationRefreshMs + DATA_FRESHNESS.calculationPrefetchLeadMs)
      .toBe(DATA_FRESHNESS.observationBucketMs);
    expect(DATA_FRESHNESS.calculationRefreshMs).toBeLessThan(DATA_FRESHNESS.observationBucketMs);
  });

  it('expires calculations after one 15-second observation window', () => {
    const calculatedAt = '2026-08-08T12:00:00.000Z';
    const start = Date.parse(calculatedAt);
    expect(isFreshCalculationTimestamp(calculatedAt, start)).toBe(true);
    expect(isFreshCalculationTimestamp(calculatedAt, start + DATA_FRESHNESS.observationBucketMs)).toBe(true);
    expect(isFreshCalculationTimestamp(calculatedAt, start + DATA_FRESHNESS.observationBucketMs + 1)).toBe(false);
    expect(isFreshCalculationTimestamp('invalid', start)).toBe(false);
  });
});
