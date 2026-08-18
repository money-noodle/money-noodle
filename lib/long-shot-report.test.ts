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

/**
 * The exit rule scored against holding, paired on identical orders. See docs/long-shot-policy-design.md §10a.
 *
 * The load-bearing property is that an order which never sold contributes *exactly* zero, because its
 * realized P&L is the hold outcome. That is asserted over a grid rather than on one fixture: the claim is
 * "no settled unsold order reaches a different answer", not "this one does not".
 */
describe('exit versus hold', () => {
  it('scores an unsold order at exactly zero, for every outcome, side and size', () => {
    for (const side of ['UP', 'DOWN'] as const) {
      for (const outcome of ['UP', 'DOWN'] as const) {
        for (const quantity of [0.01, 1.8, 3.46, 12.5]) {
          for (const stakeCents of [1, 13, 20, 250]) {
            const payoutCents = Math.round(quantity * 100);
            const won = outcome === side;
            const report = buildLongShotReport({
              orders: [order({
                side, outcome, status: won ? 'won' : 'lost', quantity, potentialPayoutCents: payoutCents,
                stakeCents, actualStakeCents: stakeCents,
                actualPnlCents: (won ? payoutCents : 0) - stakeCents,
              })],
              mode: 'live',
            });
            expect(report.exitVersusHold.perDollar).toBe(0);
            expect(report.exitVersusHold.totalCents).toBe(0);
            expect(report.exitVersusHold.whenExercisedAttempts).toBe(0);
          }
        }
      }
    }
  });

  it('prices the difference as sale proceeds minus settlement payout, with the stake cancelling', () => {
    // The only real sold long-shot to date: 13c staked bought 1.2 contracts, sold at the 90c mark for
    // 107c, where settlement would have paid 120c. Selling cost 13c — one whole stake.
    const report = buildLongShotReport({
      orders: [order({
        status: 'sold', side: 'UP', counterfactualHoldOutcome: 'UP',
        quantity: 1.2, potentialPayoutCents: 120, stakeCents: 13, actualStakeCents: 13,
        saleProceedsCents: 107, actualPnlCents: 94,
      })],
      mode: 'live',
    });
    expect(report.exitVersusHold.totalCents).toBe(-13);
    expect(report.exitVersusHold.perDollar).toBeCloseTo(-1, 9);
    expect(report.exitVersusHold.whenExercisedPerDollar).toBeCloseTo(-1, 9);
    expect(report.exitVersusHold.whenExercisedAttempts).toBe(1);
  });

  it('credits the exit when the position would have settled worthless', () => {
    const report = buildLongShotReport({
      orders: [order({
        status: 'sold', side: 'UP', counterfactualHoldOutcome: 'DOWN',
        quantity: 1.8, potentialPayoutCents: 180, stakeCents: 20, actualStakeCents: 20, actualPnlCents: 140,
      })],
      mode: 'live',
    });
    // Sold for +140c against a hold that would have lost the 20c stake.
    expect(report.exitVersusHold.totalCents).toBe(160);
    expect(report.exitVersusHold.perDollar).toBeCloseTo(8, 9);
  });

  it('clusters on the settlement window rather than on the order', () => {
    const window = '2026-08-15T00:15:00Z';
    const other = '2026-08-15T00:30:00Z';
    const sold = { status: 'sold' as const, side: 'UP' as const, counterfactualHoldOutcome: 'UP' as const,
      quantity: 1.2, potentialPayoutCents: 120, stakeCents: 13, actualStakeCents: 13, actualPnlCents: 94 };
    const report = buildLongShotReport({
      orders: [
        order({ ...sold, closesAt: window }),
        order({ ...sold, closesAt: window }),
        order({ outcome: 'DOWN', status: 'lost', closesAt: other }),
      ],
      mode: 'live',
    });
    // Two correlated sales in one window average to -1 before meeting the other window's 0, giving -0.5.
    expect(report.exitVersusHold.windows).toBe(2);
    expect(report.exitVersusHold.perDollar).toBeCloseTo(-0.5, 9);
  });

  it('counts an unresolved counterfactual instead of reading it as zero', () => {
    const report = buildLongShotReport({
      orders: [order({ status: 'sold', outcome: undefined, counterfactualHoldOutcome: undefined, actualPnlCents: 94 })],
      mode: 'live',
    });
    expect(report.exitVersusHold.unresolvedCounterfactual).toBe(1);
    expect(report.exitVersusHold.attempts).toBe(0);
    expect(report.exitVersusHold.perDollar).toBeNull();
  });

  it('drops a settled order that carries an accepted venue exit, since a partial keeps no proceeds', () => {
    const report = buildLongShotReport({
      orders: [order({ status: 'lost', outcome: 'DOWN', exitVenueOrderId: 'venue-1' })],
      mode: 'live',
    });
    expect(report.exitVersusHold.exitAttemptedUnsold).toBe(1);
    expect(report.exitVersusHold.attempts).toBe(0);
  });
});
