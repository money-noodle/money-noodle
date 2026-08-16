import { describe, expect, it } from 'vitest';
import { LONG_SHOT_REVIEW_ATTEMPTS, buildLongShotReport } from './long-shot-report';
import type { PaperOrder } from './types';

let counter = 0;
const order = (patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: `long-shot-${counter += 1}`,
  executionMode: 'live', strategyId: 'long-shot-round-trip',
  symbol: 'BTC', venue: 'kalshi', contractId: 'KXBTC15M-TEST', side: 'UP', status: 'lost',
  createdAt: '2026-08-15T00:01:00Z', calculationAt: '2026-08-15T00:01:00Z', closesAt: '2026-08-15T00:15:00Z',
  modelProbabilityUp: 0.5, confidence: 0.5, askPrice: 0.10, bidPrice: 0.09, spread: 0.01,
  quantity: 1.8, stakeCents: 20, feeCents: 2, potentialPayoutCents: 180,
  actualStakeCents: 20, actualPnlCents: -20, filledCount: 1.8, entryGeneration: 1,
  ...patch,
});

/** A round trip that reached the mark: 20c staked returns 140c. */
const wonRoundTrip = (patch: Partial<PaperOrder> = {}) =>
  order({ status: 'sold', actualPnlCents: 140, peakOwnedSideBidCents: 92, ...patch });

describe('long-shot report', () => {
  it('never blends execution tracks', () => {
    // Blending live with paper produces a number that describes neither.
    const report = buildLongShotReport({
      orders: [order({ executionMode: 'live' }), order({ executionMode: 'paper' })], mode: 'live',
    });
    expect(report.submitted).toBe(1);
    expect(report.overall.attempts).toBe(1);
  });

  it('excludes exit legs so one round trip is counted once', () => {
    const report = buildLongShotReport({
      orders: [order(), order({ id: 'long-shot-1:exit:1', status: 'sold', actualPnlCents: 140 })], mode: 'live',
    });
    expect(report.submitted).toBe(1);
  });

  it('reports the funnel from submission through settlement', () => {
    const report = buildLongShotReport({
      orders: [
        order({ status: 'unfilled', filledCount: 0 }),
        order({ status: 'open' }),
        wonRoundTrip(),
        order({ status: 'lost' }),
      ],
      mode: 'live',
    });
    expect(report).toMatchObject({ submitted: 4, unfilled: 1, open: 1, resolved: 2 });
    expect(report.overall).toMatchObject({ exitedAtMark: 1, settledUnexited: 1 });
  });

  it('clusters by settlement window so one busy window cannot outvote a quiet one', () => {
    const busy = ['BTC', 'ETH', 'SOL'].map((symbol) => order({ symbol, closesAt: '2026-08-15T00:15:00Z' }));
    const quiet = [wonRoundTrip({ closesAt: '2026-08-15T00:30:00Z' })];
    const report = buildLongShotReport({ orders: [...busy, ...quiet], mode: 'live' });
    expect(report.overall.attempts).toBe(4);
    expect(report.overall.windows).toBe(2);
    // Three losses in one window and one 7x win in another: (-1 + 7) / 2, not (3x-1 + 7) / 4.
    expect(report.overall.clusteredMeanReturn).toBeCloseTo(3, 6);
  });

  it('keeps re-entries separable so the whipsaw hypothesis stays testable', () => {
    // A re-entry can only follow a profitable exit, so it carries direct evidence the window whipsaws.
    const report = buildLongShotReport({
      orders: [order({ entryGeneration: 1 }), wonRoundTrip({ entryGeneration: 2, closesAt: '2026-08-15T00:30:00Z' })],
      mode: 'live',
    });
    const labels = report.byEntryGeneration.map((item) => item.label);
    expect(labels).toContain('generation 1');
    expect(labels).toContain('generation 2');
    const second = report.byEntryGeneration.find((item) => item.label === 'generation 2')!;
    expect(second.clusteredMeanReturn).toBeCloseTo(7, 6);
  });

  it('splits by regime, asset and side without losing anything', () => {
    const orders = [
      order({ entryCycleRegime: 'mean-reverting', symbol: 'BTC', side: 'UP' }),
      order({ entryCycleRegime: 'trending', symbol: 'DOGE', side: 'DOWN', closesAt: '2026-08-15T00:30:00Z' }),
    ];
    const report = buildLongShotReport({ orders, mode: 'live' });
    expect(report.byRegime.map((item) => item.label).sort()).toEqual(['mean-reverting', 'trending']);
    expect(report.byAsset.reduce((sum, item) => sum + item.attempts, 0)).toBe(2);
    expect(report.bySide.reduce((sum, item) => sum + item.attempts, 0)).toBe(2);
  });

  it('labels a missing regime rather than dropping the attempt', () => {
    const report = buildLongShotReport({ orders: [order({ entryCycleRegime: undefined })], mode: 'live' });
    expect(report.byRegime[0].label).toBe('unlabelled');
    expect(report.byRegime[0].attempts).toBe(1);
  });

  it('shows how close the unsold positions came, which is what prices a different mark', () => {
    // Without this the only recoverable fact is whether the one mark in force was reached, and choosing a
    // different one would need another month of collection.
    const report = buildLongShotReport({
      orders: [
        order({ peakOwnedSideBidCents: 85 }),
        order({ peakOwnedSideBidCents: 72 }),
        order({ peakOwnedSideBidCents: 20 }),
        wonRoundTrip({ peakOwnedSideBidCents: 95 }),
      ],
      mode: 'live',
    });
    // The sold position is excluded: it says nothing about whether a higher mark would also have been hit.
    expect(report.peakBidBuckets).toEqual([
      { atLeastCents: 50, count: 2 },
      { atLeastCents: 60, count: 2 },
      { atLeastCents: 70, count: 2 },
      { atLeastCents: 80, count: 1 },
      { atLeastCents: 90, count: 0 },
    ]);
  });

  it('locks review until enough resolved attempts exist and offers no promotion path', () => {
    const report = buildLongShotReport({ orders: [order()], mode: 'live' });
    expect(report.reviewAttemptsRequired).toBe(LONG_SHOT_REVIEW_ATTEMPTS);
    expect(report.reviewUnlocked).toBe(false);
    expect(buildLongShotReport({
      orders: Array.from({ length: 60 }, (_, index) => order({ closesAt: `2026-08-15T${String(index % 24).padStart(2, '0')}:15:00Z` })),
      mode: 'live',
    }).reviewUnlocked).toBe(true);
  });

  it('reports an empty policy honestly rather than as a zero return', () => {
    const report = buildLongShotReport({ orders: [], mode: 'live' });
    expect(report.overall.attempts).toBe(0);
    expect(report.overall.clusteredMeanReturn).toBeNull();
    expect(report.overall.standardError).toBeNull();
  });
});
