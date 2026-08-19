import { describe, expect, it } from 'vitest';
import {
  EXIT_CANDIDATE_IDS, advanceExitCandidateStates, appendExitSentinelObservation,
  buildExitPolicySentinelReport, exitPolicySentinelFromOrder, exitSentinelObservation,
  exitSentinelPathComplete, type ExitCandidateId, type ExitCandidateState, type ExitSentinelObservation,
} from './exit-policy-sentinel';
import { EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import type { PaperOrder, PositionLifecycleObservation } from './types';

const states = (): Record<ExitCandidateId, ExitCandidateState> => Object.fromEntries(
  EXIT_CANDIDATE_IDS.map((candidateId) => [candidateId, { candidateId }]),
) as Record<ExitCandidateId, ExitCandidateState>;

function observation(patch: Partial<ExitSentinelObservation> = {}): ExitSentinelObservation {
  return {
    at: '2026-08-20T00:00:10Z', source: 'production', selectedBid: 0.7, selectedAsk: 0.71, spread: 0.01,
    netLiquidationCents: 69, exitFeeCents: 1, exactCostCents: 60, unrealizedPnlCents: 9,
    ownedSideProbability: 0.6, confidence: 0.8, optimisticHoldValueCents: 65, secondsRemaining: 50,
    ...patch,
  };
}

function order(patch: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: 'live-order', executionMode: 'live', marketId: 'crypto-15m', strategyId: EDGE_BINARY_BUY,
    symbol: 'BTC', venue: 'kalshi', contractId: 'BTC-TEST', side: 'UP', status: 'open',
    createdAt: '2026-08-20T00:00:00Z', calculationAt: '2026-08-20T00:00:00Z', closesAt: '2026-08-20T00:01:00Z',
    modelProbabilityUp: 0.7, confidence: 0.8, askPrice: 0.6, bidPrice: 0.59, spread: 0.01,
    quantity: 1, requestedQuantity: 1, filledCount: 1, stakeCents: 60, actualStakeCents: 60,
    feeCents: 0, potentialPayoutCents: 100,
    entryDecision: {
      version: 'entry-decision-v2', policyVersion: 'v21', executionPolicyVersion: 'v3',
      calculationAt: '2026-08-20T00:00:00Z', side: 'UP', probabilityUp: 0.7, probabilityDown: 0.3,
      selectedSideProbability: 0.7, confidence: 0.8,
      confidenceBreakdown: { base: 0.3, dataQuality: 0.2, sampleQuality: 0.2, uncertaintyPenalty: 0 },
      actionableAsk: 0.6, actionableBid: 0.59, feeRate: 0, netEdge: 0.1, spread: 0.01,
      secondsRemaining: 60, qualifyingSnapshots: 2, medianNetEdge: 0.08, edgeSpike: 0.02, factors: [],
    },
    ...patch,
  };
}

describe('exit candidate first-to-fire reducers', () => {
  it('pins strict-value margins on the refusing side of cent boundaries', () => {
    const exact3 = observation({ netLiquidationCents: 68, optimisticHoldValueCents: 65 });
    const exact5 = observation({ netLiquidationCents: 70, optimisticHoldValueCents: 65 });
    const after3 = advanceExitCandidateStates(states(), exact3);
    expect(after3['strict-value-margin3c-v1'].trigger?.at).toBe(exact3.at);
    expect(after3['strict-value-margin5c-v1'].trigger).toBeUndefined();
    const after5 = advanceExitCandidateStates(after3, { ...exact5, at: '2026-08-20T00:00:12Z' });
    expect(after5['strict-value-margin5c-v1'].trigger?.at).toBe('2026-08-20T00:00:12Z');
    expect(after5['strict-value-margin3c-v1'].trigger?.at).toBe(exact3.at);
  });

  it('requires consecutive confirmation and resets it on an intervening valid failure', () => {
    let current = advanceExitCandidateStates(states(), observation({ at: '2026-08-20T00:00:10Z' }));
    expect(current['strict-value-confirm2-v1'].confirmationAt).toBe('2026-08-20T00:00:10Z');
    current = advanceExitCandidateStates(current, observation({
      at: '2026-08-20T00:00:11Z', netLiquidationCents: 65.5,
    }));
    expect(current['strict-value-confirm2-v1'].confirmationAt).toBeUndefined();
    current = advanceExitCandidateStates(current, observation({ at: '2026-08-20T00:00:12Z' }));
    current = advanceExitCandidateStates(current, observation({ at: '2026-08-20T00:00:14Z' }));
    expect(current['strict-value-confirm2-v1'].trigger?.at).toBe('2026-08-20T00:00:14Z');
  });

  it('arms trailing at +50%, updates its peak, and triggers on a 35% giveback', () => {
    let current = advanceExitCandidateStates(states(), observation({
      at: '2026-08-20T00:00:10Z', exactCostCents: 60, netLiquidationCents: 90, unrealizedPnlCents: 30,
    }));
    expect(current['trailing-50-35-v1'].trailingArmedAt).toBe('2026-08-20T00:00:10Z');
    current = advanceExitCandidateStates(current, observation({
      at: '2026-08-20T00:00:12Z', exactCostCents: 60, netLiquidationCents: 100, unrealizedPnlCents: 40,
    }));
    current = advanceExitCandidateStates(current, observation({
      at: '2026-08-20T00:00:14Z', exactCostCents: 60, netLiquidationCents: 65, unrealizedPnlCents: 5,
    }));
    expect(current['trailing-50-35-v1'].trigger?.at).toBe('2026-08-20T00:00:14Z');
  });
});

describe('exit sentinel evidence', () => {
  it('derives optimistic hold value from exact net liquidation terms', () => {
    const lifecycle: PositionLifecycleObservation = {
      at: '2026-08-20T00:00:10Z', selectedBid: 0.7, selectedAsk: 0.71, spread: 0.01,
      netLiquidationCents: 69, exitFeeCents: 1, exactCostCents: 60, unrealizedPnlCents: 9,
      unrealizedReturn: 0.15, ownedSideProbability: 0.6, confidence: 0.8, secondsRemaining: 50,
    };
    expect(exitSentinelObservation(lifecycle, 'production')?.optimisticHoldValueCents).toBeCloseTo(65, 12);
    expect(exitSentinelObservation({ ...lifecycle, selectedBid: Number.NaN }, 'production')).toBeNull();
  });

  it('rejects legacy and other-strategy positions rather than backfilling them', () => {
    expect(exitPolicySentinelFromOrder(order({
      entryDecision: { ...order().entryDecision!, version: 'entry-decision-v1', edgeSpike: undefined },
    }), observation())).toBeNull();
    expect(exitPolicySentinelFromOrder(order({ strategyId: LONG_SHOT_ROUND_TRIP }), observation())).toBeNull();
  });

  it('marks a complete path only when decision-to-settlement gaps stay bounded', () => {
    let sentinel = exitPolicySentinelFromOrder(order(), observation({ secondsRemaining: 50 }))!;
    sentinel = appendExitSentinelObservation(sentinel, observation({ at: '2026-08-20T00:00:30Z', secondsRemaining: 30 }));
    sentinel = appendExitSentinelObservation(sentinel, observation({ at: '2026-08-20T00:00:50Z', secondsRemaining: 10 }));
    sentinel.resolvedAt = '2026-08-20T00:01:01Z';
    sentinel.outcome = 'UP';
    sentinel.holdPnlCents = 40;
    expect(exitSentinelPathComplete(sentinel)).toBe(true);
    const gapped = { ...sentinel, observations: [sentinel.observations[0], sentinel.observations[2]] };
    expect(exitSentinelPathComplete(gapped)).toBe(false);
  });

  it('scores sold and held production positions in every candidate arm', () => {
    const complete = (base: PaperOrder, actualPnlCents: number, production: 'strict-exit' | 'held') => {
      let sentinel = exitPolicySentinelFromOrder(base, observation({ secondsRemaining: 50 }))!;
      sentinel = appendExitSentinelObservation(sentinel, observation({ at: '2026-08-20T00:00:30Z', secondsRemaining: 30 }));
      sentinel = appendExitSentinelObservation(sentinel, observation({ at: '2026-08-20T00:00:50Z', secondsRemaining: 10 }));
      sentinel.production = production === 'strict-exit'
        ? { status: 'strict-exit', policy: 'strict-value-v1', attemptedAt: '2026-08-20T00:00:10Z', actualPnlCents }
        : { status: 'held', actualPnlCents };
      sentinel.resolvedAt = '2026-08-20T00:01:01Z';
      sentinel.outcome = 'UP';
      sentinel.holdPnlCents = 40;
      return sentinel;
    };
    const soldOrder = order({ id: 'sold', status: 'sold', actualPnlCents: 9 });
    const heldOrder = order({ id: 'held', status: 'won', actualPnlCents: 40 });
    const report = buildExitPolicySentinelReport({
      startedAt: '2026-08-20T00:00:00Z', buyPolicyVersion: 'v21',
      executionPolicyVersions: { live: 'v3', paper: 'paper-managed-maker-trade-queue-v2' },
      sentinels: [complete(soldOrder, 9, 'strict-exit'), complete(heldOrder, 40, 'held')],
      orders: [soldOrder, heldOrder],
    });
    expect(report.tracks.live.production.positions).toBe(2);
    expect(report.tracks.live.hold.positions).toBe(2);
    expect(report.tracks.live.candidates.every((candidate) => candidate.positions === 2)).toBe(true);
    expect(report.tracks.live.production.pnlCents).toBe(49);
    expect(report.tracks.live.hold.pnlCents).toBe(80);
    expect(report.tracks.paper.positions).toBe(0);
  });
});
