import { describe, expect, it } from 'vitest';
import { summarizePerformance } from './performance';
import type { TrackedForecast } from './types';

function forecast(overrides: Partial<TrackedForecast> = {}): TrackedForecast {
  return {
    id: 'btc:1', symbol: 'BTC', marketUrl: 'https://example.com/btc', issuedAt: '2026-08-08T10:00:00Z',
    closesAt: '2026-08-08T10:15:00Z', direction: 'UP', probabilityUp: 0.7, directionalLikelihood: 0.7,
    confidence: 0.65, modelVersion: 'Blend 0.2', policyVersion: 'high-confidence-57-57-v3',
    polymarketProbabilityUp: 0.5, factors: [], status: 'pending', ...overrides,
  };
}

describe('recommendation performance summary', () => {
  it('excludes pending forecasts from accuracy and scoring', () => {
    const summary = summarizePerformance([
      forecast(),
      forecast({ id: 'eth:1', symbol: 'ETH', status: 'resolved', outcome: 'UP', correct: true, brierScore: 0.09, logLoss: 0.357, resolvedAt: '2026-08-08T10:16:00Z' }),
      forecast({ id: 'sol:1', symbol: 'SOL', direction: 'DOWN', probabilityUp: 0.3, status: 'resolved', outcome: 'UP', correct: false, brierScore: 0.49, logLoss: 1.204, resolvedAt: '2026-08-08T10:17:00Z' }),
    ]);
    expect(summary.issued).toBe(3);
    expect(summary.pending).toBe(1);
    expect(summary.resolved).toBe(2);
    expect(summary.accuracy).toBe(0.5);
    expect(summary.brierScore).toBeCloseTo(0.29);
    expect(summary.timeline).toHaveLength(2);
    expect(summary.timeline.at(-1)?.cumulativeAccuracy).toBe(0.5);
    expect(summary.timeline.at(-1)?.rollingAccuracy).toBe(0.5);
  });

  it('reports snapshot accuracy separately from cycle-balanced accuracy', () => {
    const summary = summarizePerformance([
      forecast({ id: 'a:1', cycleId: 'cycle-a', status: 'resolved', correct: true }),
      forecast({ id: 'a:2', cycleId: 'cycle-a', status: 'resolved', correct: false }),
      forecast({ id: 'b:1', cycleId: 'cycle-b', status: 'resolved', correct: true }),
    ]);
    expect(summary.accuracy).toBeCloseTo(2 / 3);
    expect(summary.cycles).toBe(2);
    expect(summary.resolvedCycles).toBe(2);
    expect(summary.cycleBalancedAccuracy).toBe(0.75);
  });

  it('reports a signed current streak and calibration remains locked below 100 windows', () => {
    const summary = summarizePerformance([
      forecast({ id: '1', cycleId: 'cycle-1', closesAt: '2026-08-08T10:15:00Z', status: 'resolved', correct: true, resolvedAt: '2026-08-08T10:16:00Z' }),
      forecast({ id: '2', cycleId: 'cycle-2', closesAt: '2026-08-08T10:30:00Z', status: 'resolved', correct: false, resolvedAt: '2026-08-08T10:31:00Z' }),
      forecast({ id: '3', cycleId: 'cycle-3', closesAt: '2026-08-08T10:45:00Z', status: 'resolved', correct: false, resolvedAt: '2026-08-08T10:46:00Z' }),
    ]);
    expect(summary.currentStreak).toBe(-2);
    expect(summary.calibrationReady).toBe(false);
    expect(summary.calibrationWindows).toBe(3);
    expect(summary.calibrationProgress).toBe(0.03);
  });

  it('counts correlated assets and repeated updates as one calibration window', () => {
    const sameWindow = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'].map((symbol, index) => forecast({
      id: `${symbol}:1`, symbol, cycleId: `cycle-${symbol}`, status: 'resolved', correct: index % 2 === 0,
      closesAt: '2026-08-08T10:15:00+00:00',
    }));
    const summary = summarizePerformance([
      ...sameWindow,
      forecast({ id: 'BTC:duplicate', symbol: 'BTC', cycleId: 'cycle-BTC', status: 'resolved', correct: true, closesAt: '2026-08-08T10:15:00Z' }),
      forecast({ id: 'BTC:next', symbol: 'BTC', cycleId: 'cycle-BTC-next', status: 'resolved', correct: true, closesAt: '2026-08-08T10:30:00Z' }),
    ]);
    expect(summary.resolved).toBe(9);
    expect(summary.resolvedCycles).toBe(8);
    expect(summary.calibrationWindows).toBe(2);
    expect(summary.calibrationProgress).toBe(0.02);
  });

  it('includes resolved non-qualifying observations in calibration-window evidence', () => {
    const summary = summarizePerformance([
      forecast({ id: 'qualified', status: 'resolved', qualified: true, closesAt: '2026-08-08T10:15:00Z' }),
      forecast({ id: 'observed', status: 'resolved', qualified: false, closesAt: '2026-08-08T10:30:00Z' }),
    ]);
    expect(summary.resolved).toBe(1);
    expect(summary.calibrationWindows).toBe(2);
  });

  it('labels the full entry-price range without folding tails into middle buckets', () => {
    const resolved = (id: string, entryAsk: number, closesAt: string) => forecast({
      id, closesAt, status: 'resolved', outcome: 'UP', correct: true,
      entryAsk, entryVenue: 'kalshi', predictedEdge: 0.1, realizedReturn: 0.1,
    });
    const summary = summarizePerformance([
      resolved('cheap', 0.08, '2026-08-08T10:15:00Z'),
      resolved('low', 0.20, '2026-08-08T10:30:00Z'),
      resolved('high', 0.80, '2026-08-08T10:45:00Z'),
    ]);
    const labels = summary.segments.find((group) => group.dimension === 'Entry price')?.segments.map((segment) => segment.label);
    expect(labels).toEqual(expect.arrayContaining(['<10¢', '10–25¢', '75¢+']));
    expect(labels).not.toContain('65–75¢');
  });
});
