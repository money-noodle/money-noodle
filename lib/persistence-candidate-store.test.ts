import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { applyMakerPostObservations, buildPersistenceCandidateReport, PERSISTENCE_CANDIDATE_MINIMUM_REVIEW_WINDOWS } from './persistence-candidate-store';
import type { PersistenceCandidateIntent } from './types';

const intent = (patch: Partial<PersistenceCandidateIntent> = {}): PersistenceCandidateIntent => ({
  id: 'candidate:BTC:UP:close', candidateVersion: 'persistence-two-consecutive-v1',
  productionPolicyVersion: 'production-v1', symbol: 'BTC', contractId: 'KXBTC', side: 'UP',
  closesAt: '2026-01-01T00:15:00Z', createdAt: '2026-01-01T00:02:00Z', calculationAt: '2026-01-01T00:02:00Z',
  selectedSideProbability: 0.65, confidence: 0.7, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
  estimatedAskFeeRate: 0.0168, estimatedMakerFeeRate: 0.0167, predictedNetEdge: 0.2332,
  qualifyingSnapshots: 2, observationSpanMs: 15_000, productionEligibleAtCandidate: false,
  makerFillProbability: 0.5, makerFillModel: 'maker-fill-empirical-v2', ...patch,
});

const store = (intents: PersistenceCandidateIntent[]) => ({
  candidateVersion: 'persistence-two-consecutive-v1', productionPolicyVersion: 'production-v1',
  startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z', intents,
});

describe('two-snapshot persistence candidate report', () => {
  it('keeps incremental evidence separate and can never report a production change', () => {
    const report = buildPersistenceCandidateReport(store([
      intent({ resolvedAt: '2026-01-01T00:16:00Z', outcome: 'UP', askProfitPerContract: 0.5832, makerExpectedProfitPerContract: 0.3 }),
      intent({ id: 'candidate:ETH:UP:close', symbol: 'ETH', productionEligibleAtCandidate: true,
        resolvedAt: '2026-01-01T00:16:00Z', outcome: 'DOWN', askProfitPerContract: -0.4168, makerExpectedProfitPerContract: -0.2 }),
    ]));
    expect(report).toMatchObject({
      candidateIntents: 2, incrementalIntents: 1, resolvedIntents: 2,
      resolvedIncrementalIntents: 1, resolvedIncrementalWindows: 1, productionChanged: false,
    });
    expect(report.meanIncrementalAskProfitPerContract).toBeCloseTo(0.5832);
  });

  it('never blends evidence across production policy versions', () => {
    const report = buildPersistenceCandidateReport(store([
      intent({ resolvedAt: '2026-01-01T00:16:00Z', askProfitPerContract: 0.5, makerExpectedProfitPerContract: 0.4 }),
      intent({ id: 'old-policy', productionPolicyVersion: 'production-v0', resolvedAt: '2026-01-01T00:16:00Z', askProfitPerContract: -0.9, makerExpectedProfitPerContract: -0.8 }),
    ]));
    expect(report.candidateIntents).toBe(1);
    expect(report.meanAskProfitPerContract).toBe(0.5);
  });

  it('reports production catch-up delay and empirical maker-model coverage', () => {
    const report = buildPersistenceCandidateReport(store([
      intent({ productionEligibleAt: '2026-01-01T00:02:30Z', productionDelayMs: 30_000 }),
      intent({ id: 'candidate:ETH:UP:close', symbol: 'ETH', makerFillProbability: null, makerFillModel: undefined }),
    ]));
    expect(report.productionCaughtUp).toBe(1);
    expect(report.meanProductionDelayMs).toBe(30_000);
    expect(report.modelledMakerIntents).toBe(1);
  });

  it('requires a substantial independent prospective sample before review', () => {
    const intents = Array.from({ length: PERSISTENCE_CANDIDATE_MINIMUM_REVIEW_WINDOWS }, (_, index) => intent({
      id: `candidate:${index}`, closesAt: new Date(Date.parse('2026-01-01T00:15:00Z') + index * 900_000).toISOString(),
      resolvedAt: '2026-02-01T00:00:00Z', askProfitPerContract: 0.1, makerExpectedProfitPerContract: 0.05,
    }));
    expect(buildPersistenceCandidateReport(store(intents)).reviewReady).toBe(true);
    expect(buildPersistenceCandidateReport(store(intents.slice(1))).reviewReady).toBe(false);
  });
});

describe('observed maker-post evidence', () => {
  const observed = (patch: Partial<PersistenceCandidateIntent> = {}) => intent({
    makerObservationModel: 'maker-post-observed-v1', makerObservationSource: 'live-2s',
    makerPostCents: 39, makerQueueAheadCents: 12,
    makerLadderFill: 'filled', makerLadderFillCents: 40, makerStaticFill: 'unfilled',
    resolvedAt: '2026-01-01T00:16:00Z', outcome: 'UP', askProfitPerContract: 0.5832,
    makerRealizedProfitPerContract: 0.5832, ...patch,
  });

  it('reports the conditional return only over intents with an observed fill', () => {
    const report = buildPersistenceCandidateReport(store([
      observed({ id: 'a', makerRealizedProfitPerContract: 0.5 }),
      observed({ id: 'b', symbol: 'ETH', closesAt: '2026-01-01T00:30:00Z', makerLadderFill: 'unfilled', makerLadderFillCents: undefined, makerRealizedProfitPerContract: undefined }),
    ]));
    expect(report.observedFill).toMatchObject({ source: 'live-2s', ladderFilled: 1, ladderUnfilled: 1, realizedWindows: 1 });
    expect(report.observedFill.meanRealizedProfitPerContract).toBeCloseTo(0.5, 9);
  });

  it('never pools the 60-second backfill with live observation', () => {
    const report = buildPersistenceCandidateReport(store([
      observed({ id: 'a', makerRealizedProfitPerContract: 0.5 }),
      observed({ id: 'b', symbol: 'ETH', closesAt: '2026-01-01T00:30:00Z',
        makerObservationSource: 'depth-experiment-60s', makerLadderFill: 'unobserved',
        makerStaticFill: 'filled', makerRealizedProfitPerContract: -0.4 }),
    ]));
    expect(report.observedFill.ladderFilled).toBe(1);
    expect(report.observedFill.meanRealizedProfitPerContract).toBeCloseTo(0.5, 9);
    expect(report.backfilledFill).toMatchObject({ source: 'depth-experiment-60s', staticFilled: 1, ladderFilled: 0 });
  });

  it('reports the bid-priced return without applying any fill assumption to it', () => {
    // A losing settlement: the price effect must stay negative rather than being shrunk toward zero the
    // way multiplying by a 0.5 fill probability would.
    const report = buildPersistenceCandidateReport(store([
      intent({ resolvedAt: '2026-01-01T00:16:00Z', outcome: 'DOWN', askProfitPerContract: -0.4168,
        makerExpectedProfitPerContract: -(0.39 + 0.0167) * 0.5 }),
    ]));
    expect(report.meanIncrementalBidPricedProfitPerContract).toBeCloseTo(-(0.39 + 0.0167), 9);
    expect(report.meanIncrementalBidPricedProfitPerContract).toBeLessThan(report.meanIncrementalMakerExpectedProfitPerContract!);
  });

  it('counts an intent with no observation as neither filled nor unfilled', () => {
    const report = buildPersistenceCandidateReport(store([
      intent({ resolvedAt: '2026-01-01T00:16:00Z', outcome: 'UP', askProfitPerContract: 0.5832 }),
    ]));
    expect(report.observedFill).toMatchObject({ observedIntents: 0, ladderFilled: 0, ladderUnfilled: 0, meanRealizedProfitPerContract: null });
  });
});

describe('applyMakerPostObservations', () => {
  it('is write-once, so a coarse backfill cannot overwrite a live observation', () => {
    const intents = [intent({ id: 'a', makerObservationModel: 'maker-post-observed-v1', makerObservationSource: 'live-2s', makerLadderFill: 'unfilled' })];
    const applied = applyMakerPostObservations(intents, [{
      id: 'a', makerObservationModel: 'maker-post-observed-v1', makerObservationSource: 'depth-experiment-60s',
      makerPostCents: 39, makerLadderFill: 'unobserved', makerStaticFill: 'filled',
    }]);
    expect(applied).toBe(0);
    expect(intents[0]).toMatchObject({ makerObservationSource: 'live-2s', makerLadderFill: 'unfilled' });
  });

  it('computes the conditional return for an intent that settled before its observation landed', () => {
    const intents = [intent({ id: 'a', resolvedAt: '2026-01-01T00:16:00Z', outcome: 'UP', askProfitPerContract: 0.5832 })];
    applyMakerPostObservations(intents, [{
      id: 'a', makerObservationModel: 'maker-post-observed-v1', makerObservationSource: 'live-2s',
      makerPostCents: 39, makerLadderFill: 'filled', makerLadderFillCents: 40, makerStaticFill: 'unfilled',
    }]);
    // Won at a 40c fill, less the fee charged at the price actually paid.
    expect(intents[0].makerRealizedProfitPerContract).toBeCloseTo(1 - 0.4 - 0.07 * 0.4 * 0.6, 9);
  });

  it('leaves the conditional return unset when the post never filled', () => {
    const intents = [intent({ id: 'a', resolvedAt: '2026-01-01T00:16:00Z', outcome: 'UP', askProfitPerContract: 0.5832 })];
    applyMakerPostObservations(intents, [{
      id: 'a', makerObservationModel: 'maker-post-observed-v1', makerObservationSource: 'live-2s',
      makerPostCents: 39, makerLadderFill: 'unfilled', makerStaticFill: 'unfilled',
    }]);
    expect(intents[0].makerRealizedProfitPerContract).toBeUndefined();
  });

  it('ignores an observation for an intent the store does not hold', () => {
    const intents = [intent({ id: 'a' })];
    expect(applyMakerPostObservations(intents, [{
      id: 'missing', makerObservationModel: 'maker-post-observed-v1', makerObservationSource: 'live-2s',
      makerPostCents: 39, makerLadderFill: 'filled', makerLadderFillCents: 40, makerStaticFill: 'filled',
    }])).toBe(0);
  });
});
