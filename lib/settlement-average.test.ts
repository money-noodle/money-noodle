import { describe, expect, it } from 'vitest';
import { estimateSettlementAverage } from './settlement-average';

const close = Date.UTC(2026, 0, 1, 0, 15);

describe('final-minute settlement-average uncertainty', () => {
  it('uses the Brownian average variance before the settlement window', () => {
    const result = estimateSettlementAverage({ referencePrice: 100, currentPrice: 101, closesAtMs: close, nowMs: close - 900_000, volatilityPerSecond: 0.001 })!;
    expect(result.method).toBe('future-window');
    expect(result.effectiveVarianceSeconds).toBeCloseTo(860);
    expect(result.observedSettlementSeconds).toBe(0);
    expect(result.probabilityUp).toBeGreaterThan(0.5);
  });

  it('uses T minus forty seconds rather than a midpoint shortcut', () => {
    const result = estimateSettlementAverage({ referencePrice: 100, currentPrice: 100, closesAtMs: close, nowMs: close - 60_000, volatilityPerSecond: 0.001 })!;
    expect(result.effectiveVarianceSeconds).toBeCloseTo(20);
    expect(result.probabilityUp).toBeCloseTo(0.5, 5);
  });

  it('conditions on the observed part of the final minute', () => {
    const start = close - 60_000;
    const result = estimateSettlementAverage({
      referencePrice: 101, currentPrice: 102, closesAtMs: close, nowMs: close - 30_000, volatilityPerSecond: 0.001,
      observations: [{ time: start - 1_000, price: 100 }, { time: start + 15_000, price: 101 }],
    })!;
    expect(result.method).toBe('partially-observed-window');
    expect(result.observedSettlementSeconds).toBe(30);
    expect(result.effectiveVarianceSeconds).toBeCloseTo(2.5);
    expect(result.expectedAveragePrice).toBeGreaterThan(100);
    expect(result.expectedAveragePrice).toBeLessThan(102);
  });

  it('fails closed inside the averaging window without an observed anchor', () => {
    expect(estimateSettlementAverage({ referencePrice: 100, currentPrice: 101, closesAtMs: close, nowMs: close - 20_000, volatilityPerSecond: 0.001, observations: [] })).toBeNull();
  });
});
