import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  activeModel, appendPromotion, evaluatePromotionEligibility, promotionEntry, promotionRefusal,
  PROMOTION_CONFIRMATION, PROMOTION_MIN_TEST_TRADES, ROLLBACK_CONFIRMATION,
  type PromotionContext, type PromotionRequest,
} from './model-promotion';
import type { WalkForwardEvaluationRun, WalkForwardParameters } from './types';

const parameters: WalkForwardParameters = {
  temperature: 1, basisWeight: 0.65, volatilityScale: 0.8, slowTiltScale: 1,
  probabilityCap: 0.03, minimumEdge: 0.05, maximumEdge: 0.35, minimumSelectedProbability: 0.55, minimumQuality: 0.5,
};

const run = (over: Partial<WalkForwardEvaluationRun> = {}): WalkForwardEvaluationRun => ({
  id: 'run-1', policyVersion: 'p', generatedAt: '2026-08-13T00:00:00Z', checkpointWindows: 425,
  datasetFingerprint: 'fnv', datasetStartsAt: 'a', datasetEndsAt: 'b',
  exactReplayObservations: 900, reconstructedReplayObservations: 0, maximumBaselineReplayError: 0.001,
  exactConfidenceReplayObservations: 900, absentConfidenceReplayObservations: 0, maximumConfidenceReplayError: 0,
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

describe('promotion request refusal', () => {
  const running = { modelVersion: 'Blend 0.4', parameters };
  const context = (over: Partial<PromotionContext> = {}): PromotionContext => ({
    running, eligibility: evaluatePromotionEligibility(run()), latestRunId: 'run-1', ledger: [], ...over,
  });
  const promote = (over: Partial<PromotionRequest> = {}): PromotionRequest => ({
    action: 'promoted', modelVersion: 'Blend 0.4', parameters, reason: 'held-out evidence cleared every gate',
    confirmation: PROMOTION_CONFIRMATION, evidenceRunId: 'run-1', ...over,
  });

  it('accepts a promotion that cites the newest run and matches the running model', () => {
    expect(promotionRefusal(promote(), context())).toBeNull();
  });

  it('refuses a version the running code is not forecasting with', () => {
    expect(promotionRefusal(promote({ modelVersion: 'Blend 0.5' }), context()))
      .toMatch(/Production is running Blend 0.4/);
  });

  it('refuses parameters that differ from the running model even when the version matches', () => {
    const drifted = { ...parameters, basisWeight: parameters.basisWeight + 0.1 };
    expect(promotionRefusal(promote({ parameters: drifted }), context())).toMatch(/basisWeight/);
  });

  it('refuses a promotion whose evidence is not the newest run', () => {
    expect(promotionRefusal(promote({ evidenceRunId: 'run-0' }), context())).toMatch(/stale/);
    expect(promotionRefusal(promote({ evidenceRunId: undefined }), context())).toMatch(/must cite/);
  });

  it('refuses a promotion whose evidence does not clear the criteria', () => {
    const ineligible = evaluatePromotionEligibility(run({ decision: 'baseline_retained' }));
    expect(promotionRefusal(promote(), context({ eligibility: ineligible }))).toMatch(/criteria not met/);
  });

  it('requires the exact typed confirmation and a written reason', () => {
    expect(promotionRefusal(promote({ confirmation: 'promote' }), context())).toMatch(/PROMOTE PRODUCTION MODEL/);
    expect(promotionRefusal(promote({ reason: '  ' }), context())).toMatch(/written reason/);
  });

  it('lets a rollback proceed on failed evidence, which is exactly when one is needed', () => {
    const entry = promotionEntry({ action: 'promoted', modelVersion: 'Blend 0.4', parameters, reason: 'a', id: 'p1' });
    const rollback: PromotionRequest = {
      action: 'rolled-back', modelVersion: 'Blend 0.4', parameters, reason: 'live return degraded',
      confirmation: ROLLBACK_CONFIRMATION, supersedesId: 'p1',
    };
    const ineligible = evaluatePromotionEligibility(undefined);
    expect(promotionRefusal(rollback, context({ eligibility: ineligible, ledger: [entry] }))).toBeNull();
    expect(promotionRefusal({ ...rollback, supersedesId: undefined }, context({ ledger: [entry] }))).toMatch(/must name/);
    expect(promotionRefusal({ ...rollback, supersedesId: 'missing' }, context({ ledger: [entry] }))).toMatch(/not in the ledger/);
  });

  it('refuses a rollback confirmed with the promotion phrase', () => {
    const entry = promotionEntry({ action: 'promoted', modelVersion: 'Blend 0.4', parameters, reason: 'a', id: 'p1' });
    const rollback: PromotionRequest = {
      action: 'rolled-back', modelVersion: 'Blend 0.4', parameters, reason: 'reverting',
      confirmation: PROMOTION_CONFIRMATION, supersedesId: 'p1',
    };
    expect(promotionRefusal(rollback, context({ ledger: [entry] }))).toMatch(/ROLL BACK PRODUCTION MODEL/);
  });

  it('refuses a malformed action or missing parameters rather than throwing', () => {
    expect(promotionRefusal({ ...promote(), action: 'deleted' as PromotionRequest['action'] }, context())).toMatch(/promoted or rolled-back/);
    expect(promotionRefusal({ ...promote(), parameters: undefined as unknown as PromotionRequest['parameters'] }, context())).toMatch(/Parameters are required/);
  });
});
