import { describe, expect, it } from 'vitest';
import { summarizeCyclePath } from './cycle-regime';

const point = (seconds: number, price: number) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), price });

describe('observation-only cycle regime features', () => {
  it('identifies an efficient one-direction path as trending', () => {
    const result = summarizeCyclePath([point(0, 100), point(15, 101), point(30, 102), point(45, 103), point(60, 104)]);
    expect(result.observationCount).toBe(5);
    expect(result.coverageSeconds).toBe(60);
    expect(result.signFlipRate).toBe(0);
    expect(result.trendEfficiency).toBeCloseTo(1);
    expect(result.signedTrendEfficiency).toBeCloseTo(1);
    expect(result.netChangePercent).toBeCloseTo(4);
    expect(result.rangePercent).toBeCloseTo(4);
    expect(result.localVolatility15mPercent).toBeGreaterThan(0);
    expect(result.regime).toBe('trending');
  });

  it('identifies alternating movement without treating it as directional confidence', () => {
    const result = summarizeCyclePath([point(0, 100), point(15, 101), point(30, 100), point(45, 101), point(60, 100)]);
    expect(result.signFlipRate).toBe(1);
    expect(result.lagOneAutocorrelation).toBeLessThan(-0.99);
    expect(result.trendEfficiency).toBe(0);
    expect(result.signedTrendEfficiency).toBe(0);
    expect(result.netChangePercent).toBe(0);
    expect(result.regime).toBe('mean-reverting');
  });

  it('reports insufficient evidence for a short or flat prefix', () => {
    const short = summarizeCyclePath([point(0, 100), point(15, 100)]);
    expect(short.regime).toBe('insufficient');
    expect(short.signFlipRate).toBeNull();
    expect(short.trendEfficiency).toBeNull();
    expect(short.signedTrendEfficiency).toBeNull();
    expect(short.netChangePercent).toBe(0);
    expect(short.rangePercent).toBe(0);
  });

  it('sorts observations and ignores invalid prices', () => {
    const result = summarizeCyclePath([point(30, 102), point(0, 100), point(15, -1), point(15, 101)]);
    expect(result.observationCount).toBe(3);
    expect(result.coverageSeconds).toBe(30);
    expect(result.trendEfficiency).toBeCloseTo(1);
  });

  it('retains downward direction separately from absolute trend efficiency', () => {
    const result = summarizeCyclePath([point(0, 104), point(15, 103), point(30, 102), point(45, 101)]);
    expect(result.trendEfficiency).toBe(1);
    expect(result.signedTrendEfficiency).toBe(-1);
    expect(result.netChangePercent).toBeCloseTo(-3 / 104 * 100);
  });
});
