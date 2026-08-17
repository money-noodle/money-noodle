import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  EDGE_SPIKE_REVIEW_WINDOWS, EDGE_SPIKE_SENTINEL_VERSION, buildEdgeSpikeSentinelReport,
  edgeSpikeSentinelId, type EdgeSpikeSentinel,
} from './edge-spike-sentinel';

const POLICY = 'buy-binary-edge-net5to35-quality50-owned55-price5to97-fresh2pp-v18';

const sentinel = (over: Partial<EdgeSpikeSentinel> & Pick<EdgeSpikeSentinel, 'closesAt' | 'admitted'>): EdgeSpikeSentinel => ({
  id: over.id ?? edgeSpikeSentinelId({ policyVersion: POLICY, symbol: over.symbol ?? 'BTC', side: over.side ?? 'UP', closesAt: over.closesAt }),
  sentinelVersion: EDGE_SPIKE_SENTINEL_VERSION,
  policyVersion: POLICY,
  symbol: 'BTC', contractId: 'KXBTC15M-X', side: 'UP',
  createdAt: '2026-08-17T08:00:00.000Z',
  edgeSpike: over.admitted ? 0.001 : 0.05,
  netEdge: 0.12, medianNetEdge: 0.11,
  selectedSideProbability: 0.62, confidence: 0.7,
  askPrice: 0.5, estimatedFeeRate: 0.0175, qualifyingSnapshots: 3,
  ...over,
});

const resolved = (item: EdgeSpikeSentinel, won: boolean): EdgeSpikeSentinel => ({
  ...item,
  outcome: won ? item.side : item.side === 'UP' ? 'DOWN' : 'UP',
  resolvedAt: '2026-08-17T08:15:00.000Z',
  realizedEdge: (won ? 1 : 0) - item.askPrice - item.estimatedFeeRate,
});

describe('edge spike sentinel identity', () => {
  it('is stable per policy, asset, side and window, so re-observing cannot manufacture a sample', () => {
    const input = { policyVersion: POLICY, symbol: 'BTC', side: 'UP' as const, closesAt: '2026-08-17T08:15:00Z' };
    expect(edgeSpikeSentinelId(input)).toBe(edgeSpikeSentinelId(input));
    expect(edgeSpikeSentinelId({ ...input, side: 'DOWN' })).not.toBe(edgeSpikeSentinelId(input));
    expect(edgeSpikeSentinelId({ ...input, policyVersion: 'other' })).not.toBe(edgeSpikeSentinelId(input));
  });
});

describe('edge spike sentinel report', () => {
  it('scores the two arms separately and reports the gate advantage', () => {
    const rows = [
      resolved(sentinel({ closesAt: '2026-08-17T08:15:00Z', admitted: true }), true),
      resolved(sentinel({ closesAt: '2026-08-17T08:30:00Z', admitted: true }), true),
      resolved(sentinel({ closesAt: '2026-08-17T08:45:00Z', admitted: false }), false),
      resolved(sentinel({ closesAt: '2026-08-17T09:00:00Z', admitted: false }), false),
    ];
    const report = buildEdgeSpikeSentinelReport(rows, POLICY);
    expect(report.admitted.windows).toBe(2);
    expect(report.declined.windows).toBe(2);
    expect(report.admitted.winRate).toBe(1);
    expect(report.declined.winRate).toBe(0);
    // Per $1 of payout: a win at a 50c ask plus 1.75c fee returns 1 - 0.5175, a loss returns -0.5175.
    expect(report.admitted.clusteredMeanEdge).toBeCloseTo(0.4825, 10);
    expect(report.declined.clusteredMeanEdge).toBeCloseTo(-0.5175, 10);
    expect(report.advantage).toBeCloseTo(1, 10);
  });

  it('counts one settlement window once however many sides it contributed', () => {
    // Both sides of one asset in one window share a single coin flip; scoring them independently would
    // shrink the interval for no reason.
    const rows = [
      resolved(sentinel({ closesAt: '2026-08-17T08:15:00Z', admitted: false, side: 'UP' }), false),
      resolved(sentinel({ closesAt: '2026-08-17T08:15:00Z', admitted: false, side: 'DOWN' }), true),
    ];
    const report = buildEdgeSpikeSentinelReport(rows, POLICY);
    expect(report.declined.windows).toBe(1);
    expect(report.declined.samples).toBe(2);
  });

  it('ignores unresolved and invalidated samples in the arms but still counts them as observed', () => {
    const rows = [
      resolved(sentinel({ closesAt: '2026-08-17T08:15:00Z', admitted: true }), true),
      sentinel({ closesAt: '2026-08-17T08:30:00Z', admitted: true }),
      { ...resolved(sentinel({ closesAt: '2026-08-17T08:45:00Z', admitted: true }), true), invalidReason: 'no settled result' },
    ];
    const report = buildEdgeSpikeSentinelReport(rows, POLICY);
    expect(report.samples).toBe(3);
    expect(report.admitted.windows).toBe(1);
    expect(report.admitted.winRate).toBe(1);
  });

  it('scopes evidence to one policy version, so a policy change starts a fresh cohort', () => {
    const rows = [
      resolved(sentinel({ closesAt: '2026-08-17T08:15:00Z', admitted: true }), true),
      { ...resolved(sentinel({ closesAt: '2026-08-17T08:30:00Z', admitted: true }), false), policyVersion: 'older-v17' },
    ];
    const report = buildEdgeSpikeSentinelReport(rows, POLICY);
    expect(report.samples).toBe(1);
    expect(report.admitted.winRate).toBe(1);
  });

  it('unlocks review on the declined arm only, and not before the stated bar', () => {
    const declined = Array.from({ length: EDGE_SPIKE_REVIEW_WINDOWS - 1 }, (_, index) =>
      resolved(sentinel({ closesAt: `2026-08-17T${String(index).padStart(2, '0')}:15:00Z`, admitted: false }), false));
    expect(buildEdgeSpikeSentinelReport(declined, POLICY).reviewUnlocked).toBe(false);
    // A flood of admitted samples must not unlock a review of the arm the gate is suppressing.
    const admitted = Array.from({ length: 500 }, (_, index) =>
      resolved(sentinel({ closesAt: `2026-08-18T${String(index).padStart(3, '0')}:15:00Z`, admitted: true }), true));
    expect(buildEdgeSpikeSentinelReport([...declined, ...admitted], POLICY).reviewUnlocked).toBe(false);
    const enough = [...declined, resolved(sentinel({ closesAt: '2026-08-19T00:15:00Z', admitted: false }), false)];
    expect(buildEdgeSpikeSentinelReport(enough, POLICY).reviewUnlocked).toBe(true);
  });

  it('reports empty arms as unknown rather than zero', () => {
    const report = buildEdgeSpikeSentinelReport([], POLICY);
    expect(report.admitted.clusteredMeanEdge).toBeNull();
    expect(report.declined.winRate).toBeNull();
    expect(report.advantage).toBeNull();
    expect(report.reviewUnlocked).toBe(false);
  });
});
