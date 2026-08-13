import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  activeModel, appendPromotion, evaluatePromotionEligibility, promotionEntry,
  PROMOTION_MIN_TEST_TRADES,
} from './model-promotion';
import type { WalkForwardEvaluationRun, WalkForwardParameters } from './types';

const parameters: WalkForwardParameters = {
  temperature: 1, basisWeight: 0.65, volatilityScale: 0.8, slowTiltScale: 1,
  probabilityCap: 0.03, minimumEdge: 0.05, minimumQuality: 0.5,
};

const run = (over: Partial<WalkForwardEvaluationRun> = {}): WalkForwardEvaluationRun => ({
  id: 'run-1', policyVersion: 'p', generatedAt: '2026-08-13T00:00:00Z', checkpointWindows: 425,
  datasetFingerprint: 'fnv', datasetStartsAt: 'a', datasetEndsAt: 'b',
  exactReplayObservations: 900, reconstructedReplayObservations: 0, maximumBaselineReplayError: 0.001,
  folds: [], baseline: { windows: 100, observations: 900, trades: 70, winningTrades: 20, meanWindowReturn: 0.02, brierScore: 0.2, logLoss: 0.6, maximumDrawdown: 0.2 },
  candidate: { windows: 100, observations: 900, trades: 80, winningTrades: 30, meanWindowReturn: 0.06, brierScore: 0.19, logLoss: 0.58, maximumDrawdown: 0.18 },
  recommendedParameters: parameters, parameterSelectionCounts: [],
  positiveCandidateFolds: 5, candidateBeatBaselineFolds: 5,
  decision: 'candidate_passed_review_thresholds', reason: 'ok', productionChanged: false, ...over,
});

const failing = (e: ReturnType<typeof evaluatePromotionEligibility>) => e.criteria.filter((c) => !c.met).map((c) => c.id);

describe('promotion eligibility', () => {
  it('is stricter than the evaluator: passing review is necessary but not sufficient', () => {
    const thin = run({ candidate: { ...run().candidate, trades: PROMOTION_MIN_TEST_TRADES - 1 } });
    expect(thin.decision).toBe('candidate_passed_review_thresholds');
    expect(evaluatePromotionEligibility(thin).eligible).toBe(false);
    expect(failing(evaluatePromotionEligibility(thin))).toContain('test-trades');
  });

  it('requires fold-level consistency, not just a good average', () => {
    expect(failing(evaluatePromotionEligibility(run({ positiveCandidateFolds: 2 })))).toContain('positive-folds');
    expect(failing(evaluatePromotionEligibility(run({ candidateBeatBaselineFolds: 2 })))).toContain('beats-baseline-folds');
  });

  it('requires a material return gap, so a hair-thin win cannot promote', () => {
    const marginal = run({ candidate: { ...run().candidate, meanWindowReturn: 0.021 } });
    expect(failing(evaluatePromotionEligibility(marginal))).toContain('return-gap');
  });

  it('refuses a candidate scored on inexact replay', () => {
    expect(failing(evaluatePromotionEligibility(run({ maximumBaselineReplayError: 0.05 })))).toContain('replay-exact');
  });

  it('refuses when the evaluator itself did not pass the candidate', () => {
    expect(failing(evaluatePromotionEligibility(run({ decision: 'baseline_retained' })))).toContain('evaluator-decision');
  });

  it('refuses when no run exists at all rather than defaulting to eligible', () => {
    expect(evaluatePromotionEligibility(undefined).eligible).toBe(false);
  });

  it('allows promotion only when every criterion holds', () => {
    const eligibility = evaluatePromotionEligibility(run());
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.runId).toBe('run-1');
  });
});

describe('promotion ledger', () => {
  it('requires a written reason', () => {
    expect(() => promotionEntry({ action: 'promoted', modelVersion: 'Blend 0.5', parameters, reason: '  ' })).toThrow(/written reason/);
  });

  it('captures the cited evidence so it cannot drift from the decision', () => {
    const entry = promotionEntry({ action: 'promoted', modelVersion: 'Blend 0.5', parameters, reason: 'cleared every gate', run: run() });
    expect(entry.evidenceRunId).toBe('run-1');
    expect(entry.evidence).toMatchObject({ candidateTrades: 80, checkpointWindows: 425 });
  });

  it('is append-only and refuses to rewrite an existing entry', () => {
    const first = promotionEntry({ action: 'promoted', modelVersion: 'Blend 0.5', parameters, reason: 'a', id: 'x', at: '2026-08-13T01:00:00Z' });
    const ledger = appendPromotion([], first);
    expect(() => appendPromotion(ledger, first)).toThrow(/immutable/);
  });

  it('records a rollback as a new entry naming what it supersedes, never a deletion', () => {
    const promoted = promotionEntry({ action: 'promoted', modelVersion: 'Blend 0.5', parameters, reason: 'a', id: 'p1', at: '2026-08-13T01:00:00Z' });
    const rolledBack = promotionEntry({ action: 'rolled-back', modelVersion: 'Blend 0.4', parameters, reason: 'live return degraded', id: 'r1', at: '2026-08-13T02:00:00Z', supersedesId: 'p1' });
    const ledger = appendPromotion(appendPromotion([], promoted), rolledBack);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toEqual(promoted);
    expect(activeModel(ledger)).toMatchObject({ modelVersion: 'Blend 0.4', action: 'rolled-back', supersedesId: 'p1' });
  });

  it('reports the active model as whatever the latest entry left in force', () => {
    expect(activeModel([])).toBeUndefined();
    const only = promotionEntry({ action: 'promoted', modelVersion: 'Blend 0.5', parameters, reason: 'a', at: '2026-08-13T01:00:00Z' });
    expect(activeModel([only])!.modelVersion).toBe('Blend 0.5');
  });
});
