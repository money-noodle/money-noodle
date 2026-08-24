import { describe, expect, it } from 'vitest';
import {
  buildMakerRestrictionSentinelReport, holmSignificantMakerRestrictions,
  makerRestrictionCandidateDecisions, makerRestrictionSentinelFromOrder,
  type MakerRestrictionArmReport, type MakerRestrictionCandidateId,
} from './maker-restriction-sentinel';
import { EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import type { PaperOrder } from './types';

function order(patch: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: 'live:BTC:UP:2026-08-20T00:15:00Z', logicalOrderId: 'BTC-UP', executionMode: 'live',
    marketId: 'crypto-15m', strategyId: EDGE_BINARY_BUY, symbol: 'BTC', venue: 'kalshi', contractId: 'BTC-TEST',
    side: 'UP', status: 'unfilled', createdAt: '2026-08-20T00:01:00Z', calculationAt: '2026-08-20T00:01:00Z',
    closesAt: '2026-08-20T00:15:00Z', modelProbabilityUp: 0.7, confidence: 0.7,
    askPrice: 0.6, bidPrice: 0.58, spread: 0.02, issuanceAskPrice: 0.6, issuanceBidPrice: 0.58, issuanceSpread: 0.02,
    quantity: 1, requestedQuantity: 1, stakeCents: 60, feeCents: 0, potentialPayoutCents: 100,
    entryDecision: {
      version: 'entry-decision-v2', policyVersion: 'v21', executionPolicyVersion: 'v3',
      calculationAt: '2026-08-20T00:01:00Z', side: 'UP', probabilityUp: 0.7, probabilityDown: 0.3,
      selectedSideProbability: 0.7, confidence: 0.7,
      confidenceBreakdown: { base: 0.3, dataQuality: 0.2, sampleQuality: 0.2, uncertaintyPenalty: 0 },
      actionableAsk: 0.6, actionableBid: 0.58, feeRate: 0, netEdge: 0.1, spread: 0.02,
      secondsRemaining: 840, qualifyingSnapshots: 2, medianNetEdge: 0.09, edgeSpike: 0.01, factors: [],
    },
    entryExecutionDecision: {
      policyVersion: 'v3', configuredMode: 'adaptive', executedStyle: 'maker', recommendedStyle: 'maker',
      reason: 'maker', takerNetEdge: 0.1, medianNetEdge: 0.09, makerNetEdge: 0.12,
      makerExpectedCapturedEdge: 0.06, takerAdvantage: 0.04, makerCohort: '50c+', makerSamples: 30, makerFillRate: 0.5,
    },
    ...patch,
  };
}

describe('maker restriction review lock', () => {
  it('applies Holm correction across the frozen two-candidate family', () => {
    const report = (
      candidateId: MakerRestrictionCandidateId, mean: number, standardError: number,
    ): MakerRestrictionArmReport => ({
      candidateId, attempts: 60, divergentAttempts: 20, windows: 60, divergentWindows: 20,
      filledAttempts: 10, deployedCents: 100, pnlCents: 1, meanReturnAcrossAttempts: mean,
      incrementalMeanReturn: mean, incrementalStandardError: standardError, reviewUnlocked: false,
    });
    expect(holmSignificantMakerRestrictions([
      report('maker-spread-max2c-v1', 3, 1), report('maker-spike-max2pp-v1', 1.5, 1),
    ])).toEqual(new Set<MakerRestrictionCandidateId>(['maker-spread-max2c-v1']));
  });
});

describe('maker restriction candidates', () => {
  it('fails toward refusal at invalid inputs and pins both candidate boundaries', () => {
    expect(makerRestrictionCandidateDecisions({ spread: 0.02, edgeSpike: 0.019999999998 })
      .map((item) => item.decision)).toEqual(['admit', 'admit']);
    expect(makerRestrictionCandidateDecisions({ spread: 0.0200000011, edgeSpike: 0.02 })
      .map((item) => item.decision)).toEqual(['refuse', 'refuse']);
    expect(makerRestrictionCandidateDecisions({ spread: Number.NaN, edgeSpike: null })
      .map((item) => item.decision)).toEqual(['refuse', 'refuse']);
  });

  it('classifies a grid of issuance snapshots identically on live and paper', () => {
    for (const spread of [0.019999998, 0.02, 0.020000002, Number.NaN]) {
      for (const edgeSpike of [0.019999999998, 0.02, 0.020000000002, null]) {
        const entryDecision = { ...order().entryDecision!, spread, edgeSpike };
        const live = makerRestrictionSentinelFromOrder(order({ issuanceSpread: spread, entryDecision }));
        const paper = makerRestrictionSentinelFromOrder(order({
          id: `paper:${spread}:${edgeSpike}`, executionMode: 'paper', liquidityRole: 'maker',
          issuanceSpread: spread, entryDecision, entryExecutionDecision: undefined,
        }));
        expect(paper?.candidates ?? null).toEqual(live?.candidates ?? null);
      }
    }
  });

  it('does not reinterpret legacy, taker, or another strategy as prospective maker evidence', () => {
    expect(makerRestrictionSentinelFromOrder(order({
      entryDecision: { ...order().entryDecision!, version: 'entry-decision-v1', edgeSpike: undefined },
    }))).toBeNull();
    expect(makerRestrictionSentinelFromOrder(order({
      entryExecutionDecision: { ...order().entryExecutionDecision!, executedStyle: 'taker' },
    }))).toBeNull();
    expect(makerRestrictionSentinelFromOrder(order({ strategyId: LONG_SHOT_ROUND_TRIP }))).toBeNull();
  });

  it('scores every attempt and assigns refusals and no-fills zero deployment', () => {
    const losingFill = order({
      id: 'loss', status: 'lost', venueOrderId: 'venue-loss', filledCount: 1,
      actualStakeCents: 60.0000000001, actualPnlCents: -60.0000000001,
      issuanceSpread: 0.03, entryDecision: { ...order().entryDecision!, spread: 0.03 },
    });
    const noFill = order({ id: 'miss', closesAt: '2026-08-20T00:30:00Z' });
    const lossSentinel = { ...makerRestrictionSentinelFromOrder(losingFill)!, resolvedAt: '2026-08-20T00:16:00Z', outcome: 'DOWN' as const };
    const missSentinel = { ...makerRestrictionSentinelFromOrder(noFill)!, resolvedAt: '2026-08-20T00:31:00Z', outcome: 'UP' as const };
    const report = buildMakerRestrictionSentinelReport({
      startedAt: '2026-08-20T00:00:00Z', buyPolicyVersion: 'v21',
      executionPolicyVersions: { live: 'v3', paper: 'paper-managed-maker-trade-queue-v2' },
      sentinels: [lossSentinel, missSentinel], orders: [losingFill, noFill],
    });
    expect(report.tracks.live.production.attempts).toBe(2);
    expect(report.tracks.live.production.deployedCents).toBeCloseTo(60.0000000001, 9);
    expect(report.tracks.live.production.pnlCents).toBeCloseTo(-60.0000000001, 9);
    expect(report.tracks.paper.records).toBe(0);
    const spread = report.tracks.live.candidates.find((candidate) => candidate.candidateId === 'maker-spread-max2c-v1')!;
    expect(spread.divergentAttempts).toBe(1);
    expect(spread.deployedCents).toBe(0);
    expect(spread.pnlCents).toBe(0);
    expect(spread.incrementalMeanReturn).toBe(0.5);
    expect(spread.reviewUnlocked).toBe(false);
  });
});
