import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { venueFeeCents } from './paper-execution';
import {
  HOLD_SENTINEL_MINIMUM_REVIEW_WINDOWS, HOLD_SENTINEL_VERSION, buildHoldSentinelReport, holdReturn,
  reachedExitMark, roundTripReturn, type HoldSentinel,
} from './hold-sentinel';

let counter = 0;
const sentinel = (patch: Partial<HoldSentinel> = {}): HoldSentinel => ({
  id: `s-${counter += 1}`,
  sentinelVersion: HOLD_SENTINEL_VERSION,
  policyVersion: 'long-shot-round-trip-buy10-sell90-v1',
  observedAt: '2026-08-15T00:01:00Z',
  symbol: 'BTC', side: 'UP', closesAt: '2026-08-15T00:15:00Z', contractId: 'KXBTC15M-TEST',
  entryAskCents: 10, oppositeAskCents: 91, secondsRemaining: 840,
  entryMarkCents: 10, exitMarkCents: 90,
  quantity: 1.8, stakeCents: 20, estimatedFeeCents: 2,
  entryGeneration: 1, executed: true,
  resolvedAt: '2026-08-15T00:15:05Z', settledSide: 'DOWN',
  ...patch,
});

const exitFee = (item: HoldSentinel) => venueFeeCents('kalshi', item.exitMarkCents, item.quantity, 'taker');

describe('hold and round-trip returns on one trigger', () => {
  it('prices holding a loser as the whole stake and a winner as the payout', () => {
    expect(holdReturn(sentinel({ settledSide: 'DOWN' }))).toBeCloseTo(-1, 6);
    // 1.8 contracts settle at 180c against a 20c stake.
    expect(holdReturn(sentinel({ settledSide: 'UP' }))).toBeCloseTo(8, 6);
  });

  it('treats a missed exit mark as a settlement, not a total loss', () => {
    // The design doc's break-even touch rates assume a worthless miss and are therefore conservative.
    // With no fallback exit, a position that never reaches the mark simply settles like the hold arm.
    const missedButWon = sentinel({ settledSide: 'UP', peakOwnedSideBidCents: 40 });
    expect(reachedExitMark(missedButWon)).toBe(false);
    expect(roundTripReturn(missedButWon, exitFee(missedButWon))).toBeCloseTo(holdReturn(missedButWon)!, 6);
  });

  it('books the round trip at the mark when it was reached', () => {
    const touched = sentinel({ settledSide: 'DOWN', peakOwnedSideBidCents: 92 });
    expect(reachedExitMark(touched)).toBe(true);
    // 1.8 x 90c less a 2c fee = 160c on a 20c stake.
    expect(roundTripReturn(touched, exitFee(touched))).toBeCloseTo(7, 6);
  });

  it('shows the real cost of selling early: a winner capped at the mark', () => {
    // Selling at 90c forgoes settlement at 100c, and contracts that reach 90c are exactly the ones most
    // likely to settle in the money. This is the trade-off the sentinel exists to measure.
    const touchedAndWon = sentinel({ settledSide: 'UP', peakOwnedSideBidCents: 95 });
    expect(roundTripReturn(touchedAndWon, exitFee(touchedAndWon))!).toBeLessThan(holdReturn(touchedAndWon)!);
  });

  it('scores nothing before the venue resolves', () => {
    const pending = sentinel({ resolvedAt: undefined, settledSide: undefined });
    expect(holdReturn(pending)).toBeNull();
    expect(roundTripReturn(pending, 2)).toBeNull();
  });
});

describe('hold sentinel report', () => {
  it('keeps unexecuted triggers in the sample, which is the point of trigger-time capture', () => {
    const report = buildHoldSentinelReport({
      sentinels: [
        sentinel({ executed: true, settledSide: 'UP' }),
        sentinel({ executed: false, skipReason: 'Daily loss cap reached', settledSide: 'UP', closesAt: '2026-08-15T00:30:00Z' }),
      ],
      policyVersion: 'long-shot-round-trip-buy10-sell90-v1',
      exitFeeCents: exitFee,
    });
    expect(report.samples).toBe(2);
    expect(report.unexecutedSamples).toBe(1);
    expect(report.hold.samples).toBe(2);
  });

  it('clusters by settlement window so one busy window cannot outvote a quiet one', () => {
    // Correlated crypto contracts sharing a close are not independent observations.
    const busy = ['BTC', 'ETH', 'SOL', 'DOGE'].map((symbol) => sentinel({ symbol, settledSide: 'DOWN', closesAt: '2026-08-15T00:15:00Z' }));
    const quiet = [sentinel({ symbol: 'BTC', settledSide: 'UP', closesAt: '2026-08-15T00:30:00Z' })];
    const report = buildHoldSentinelReport({
      sentinels: [...busy, ...quiet], policyVersion: 'long-shot-round-trip-buy10-sell90-v1', exitFeeCents: exitFee,
    });
    expect(report.hold.samples).toBe(5);
    expect(report.hold.windows).toBe(2);
    // Four losses in one window and one win in another average to (-1 + 8) / 2, not (4x-1 + 8) / 5.
    expect(report.hold.clusteredMeanReturn).toBeCloseTo(3.5, 6);
  });

  it('reports the advantage of selling early over holding on identical triggers', () => {
    const sentinels = [
      sentinel({ settledSide: 'DOWN', peakOwnedSideBidCents: 95, closesAt: '2026-08-15T00:15:00Z' }),
      sentinel({ settledSide: 'DOWN', peakOwnedSideBidCents: 20, closesAt: '2026-08-15T00:30:00Z' }),
    ];
    const report = buildHoldSentinelReport({ sentinels, policyVersion: 'long-shot-round-trip-buy10-sell90-v1', exitFeeCents: exitFee });
    // One trigger reached the mark and one did not; holding both would have lost everything.
    expect(report.hold.clusteredMeanReturn).toBeCloseTo(-1, 6);
    expect(report.roundTrip.clusteredMeanReturn).toBeCloseTo(3, 6);
    expect(report.advantage).toBeCloseTo(4, 6);
    expect(report.roundTrip.rate).toBeCloseTo(0.5, 6);
    expect(report.peakObservedSamples).toBe(2);
  });

  /**
   * The defect of 2026-08-15 to 2026-08-17: `collectLongShotEvidence` returned no `peakBids`, so no
   * sentinel ever carried a peak. Every existing test above supplies one in its fixture, which is exactly
   * why they all passed while production reported "selling early beats holding by +0.0%" — a difference
   * that is zero by construction whenever the peak is absent. See docs/long-shot-policy-design.md §10a.
   */
  it('reports the round trip as unmeasured, not as zero, when no sentinel carries a peak', () => {
    const sentinels = [
      sentinel({ settledSide: 'DOWN', closesAt: '2026-08-15T00:15:00Z' }),
      sentinel({ settledSide: 'DOWN', closesAt: '2026-08-15T00:30:00Z' }),
    ];
    const report = buildHoldSentinelReport({ sentinels, policyVersion: 'long-shot-round-trip-buy10-sell90-v1', exitFeeCents: exitFee });

    expect(report.peakObservedSamples).toBe(0);
    // The arms are identical by construction here, so the difference between them measures nothing.
    expect(report.roundTrip.clusteredMeanReturn).toBe(report.hold.clusteredMeanReturn);
    expect(report.advantage).toBeNull();
  });

  it('measures the advantage as soon as any resolved sentinel carries a peak', () => {
    const sentinels = [
      sentinel({ settledSide: 'DOWN', peakOwnedSideBidCents: 95, closesAt: '2026-08-15T00:15:00Z' }),
      sentinel({ settledSide: 'DOWN', closesAt: '2026-08-15T00:30:00Z' }),
    ];
    const report = buildHoldSentinelReport({ sentinels, policyVersion: 'long-shot-round-trip-buy10-sell90-v1', exitFeeCents: exitFee });

    // A sentinel with no peak is scored as not having reached the mark, which is the honest reading for a
    // position nobody observed; it must not suppress the arm for the ones that were observed.
    expect(report.peakObservedSamples).toBe(1);
    expect(report.advantage).not.toBeNull();
  });

  it('starts a fresh cohort when the policy version changes', () => {
    const report = buildHoldSentinelReport({
      sentinels: [sentinel({ policyVersion: 'superseded-v0' }), sentinel({})],
      policyVersion: 'long-shot-round-trip-buy10-sell90-v1', exitFeeCents: exitFee,
    });
    expect(report.samples).toBe(1);
  });

  it('keeps re-entries separable so the whipsaw hypothesis stays testable', () => {
    // A second entry carries direct evidence that this window whipsaws, a fresher version of what the
    // rejected prior-cycle filter was reaching for.
    const report = buildHoldSentinelReport({
      sentinels: [
        sentinel({ entryGeneration: 1, settledSide: 'DOWN', peakOwnedSideBidCents: 10, closesAt: '2026-08-15T00:15:00Z' }),
        sentinel({ entryGeneration: 2, settledSide: 'DOWN', peakOwnedSideBidCents: 95, closesAt: '2026-08-15T00:30:00Z' }),
      ],
      policyVersion: 'long-shot-round-trip-buy10-sell90-v1', exitFeeCents: exitFee,
    });
    expect(report.firstEntry.samples).toBe(1);
    expect(report.reEntry.samples).toBe(1);
    expect(report.reEntry.clusteredMeanReturn!).toBeGreaterThan(report.firstEntry.clusteredMeanReturn!);
  });

  it('locks review until enough independent windows exist, and cannot promote anything', () => {
    const report = buildHoldSentinelReport({
      sentinels: [sentinel({ peakOwnedSideBidCents: 95 })], policyVersion: 'long-shot-round-trip-buy10-sell90-v1', exitFeeCents: exitFee,
    });
    expect(report.reviewWindowsRequired).toBe(HOLD_SENTINEL_MINIMUM_REVIEW_WINDOWS);
    expect(report.reviewUnlocked).toBe(false);
    expect(Object.keys(report)).not.toContain('promote');
  });
});
