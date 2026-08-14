import type { ModelPromotionAction, ModelPromotionEntry, WalkForwardEvaluationRun, WalkForwardParameters } from './types';

/**
 * Manual, immutable model promotion.
 *
 * The evaluator already refuses to change production on its own. What was missing is the other half: a
 * durable record of what is in production, why, and on what evidence — so a promotion can be audited and
 * a rollback is a first-class act rather than an undocumented edit.
 *
 * Entries are append-only. A rollback appends a new entry naming the one it supersedes; it never deletes
 * or rewrites history, because the evidence a past decision was made on is exactly what a later review
 * needs to judge whether the decision was sound.
 */

/** A candidate must clear every one of these before it may be promoted at all. */
export const PROMOTION_MIN_TEST_TRADES = 60;
export const PROMOTION_MIN_POSITIVE_FOLDS = 4;
export const PROMOTION_MIN_BEAT_BASELINE_FOLDS = 4;
export const PROMOTION_MIN_MEAN_WINDOW_RETURN_GAP = 0.02;
/** Replay must be near-exact, or the candidate was scored on reconstructed inputs it never saw. */
export const PROMOTION_MAX_REPLAY_ERROR = 0.005;

// The record shape lives in types.ts so the published policy manifest and this module cannot
// describe a promotion differently.
export type { ModelPromotionAction, ModelPromotionEntry, ModelPromotionEvidence } from './types';

export interface PromotionEligibility {
  eligible: boolean;
  runId?: string;
  criteria: Array<{ id: string; met: boolean; detail: string }>;
}

/**
 * Whether a walk-forward run may be cited to promote its candidate. Deliberately stricter than the
 * evaluator's own `candidate_passed_review_thresholds`, which marks a candidate worth reviewing rather
 * than worth deploying: promotion additionally requires fold-level consistency, a material return gap,
 * and near-exact replay.
 */
export function evaluatePromotionEligibility(run: WalkForwardEvaluationRun | undefined): PromotionEligibility {
  if (!run) return { eligible: false, criteria: [{ id: 'run-present', met: false, detail: 'No walk-forward run has been recorded.' }] };
  const gap = run.candidate.meanWindowReturn - run.baseline.meanWindowReturn;
  const criteria = [
    {
      id: 'evaluator-decision', met: run.decision === 'candidate_passed_review_thresholds',
      detail: `Evaluator decision ${run.decision}.`,
    },
    {
      id: 'test-trades', met: run.candidate.trades >= PROMOTION_MIN_TEST_TRADES,
      detail: `${run.candidate.trades}/${PROMOTION_MIN_TEST_TRADES} held-out candidate trades.`,
    },
    {
      id: 'positive-folds', met: run.positiveCandidateFolds >= PROMOTION_MIN_POSITIVE_FOLDS,
      detail: `${run.positiveCandidateFolds}/${PROMOTION_MIN_POSITIVE_FOLDS} folds with positive candidate return.`,
    },
    {
      id: 'beats-baseline-folds', met: run.candidateBeatBaselineFolds >= PROMOTION_MIN_BEAT_BASELINE_FOLDS,
      detail: `${run.candidateBeatBaselineFolds}/${PROMOTION_MIN_BEAT_BASELINE_FOLDS} folds beating the baseline.`,
    },
    {
      id: 'return-gap', met: gap >= PROMOTION_MIN_MEAN_WINDOW_RETURN_GAP,
      detail: `Candidate mean window return exceeds baseline by ${(gap * 100).toFixed(2)}pp; ${(PROMOTION_MIN_MEAN_WINDOW_RETURN_GAP * 100).toFixed(2)}pp required.`,
    },
    {
      id: 'replay-exact', met: run.maximumBaselineReplayError <= PROMOTION_MAX_REPLAY_ERROR,
      detail: `Maximum baseline replay error ${run.maximumBaselineReplayError.toFixed(4)}; ${PROMOTION_MAX_REPLAY_ERROR} allowed.`,
    },
  ];
  return { eligible: criteria.every((item) => item.met), runId: run.id, criteria };
}

export function promotionEntry(input: {
  action: ModelPromotionAction;
  modelVersion: string;
  parameters: WalkForwardParameters;
  reason: string;
  run?: WalkForwardEvaluationRun;
  supersedesId?: string;
  at?: string;
  id?: string;
}): ModelPromotionEntry {
  if (!input.reason.trim()) throw new Error('A promotion or rollback requires a written reason.');
  return {
    id: input.id ?? crypto.randomUUID(),
    at: input.at ?? new Date().toISOString(),
    action: input.action,
    modelVersion: input.modelVersion,
    parameters: { ...input.parameters },
    reason: input.reason.trim(),
    evidenceRunId: input.run?.id,
    evidence: input.run ? {
      checkpointWindows: input.run.checkpointWindows,
      candidateMeanWindowReturn: input.run.candidate.meanWindowReturn,
      baselineMeanWindowReturn: input.run.baseline.meanWindowReturn,
      candidateTrades: input.run.candidate.trades,
      positiveCandidateFolds: input.run.positiveCandidateFolds,
      candidateBeatBaselineFolds: input.run.candidateBeatBaselineFolds,
      maximumBaselineReplayError: input.run.maximumBaselineReplayError,
    } : undefined,
    supersedesId: input.supersedesId,
  };
}

/** Typed exactly by the operator, so a promotion cannot be a mis-click or a replayed request. */
export const PROMOTION_CONFIRMATION = 'PROMOTE PRODUCTION MODEL';
export const ROLLBACK_CONFIRMATION = 'ROLL BACK PRODUCTION MODEL';

export interface PromotionRequest {
  action: ModelPromotionAction;
  modelVersion: string;
  parameters: WalkForwardParameters;
  reason: string;
  confirmation: string;
  evidenceRunId?: string;
  supersedesId?: string;
}

export interface PromotionContext {
  /** What the running code actually forecasts with, not what the request claims. */
  running: { modelVersion: string; parameters: WalkForwardParameters };
  eligibility: PromotionEligibility;
  latestRunId?: string;
  ledger: ModelPromotionEntry[];
}

const parameterKeys: Array<keyof WalkForwardParameters> = [
  'temperature', 'basisWeight', 'volatilityScale', 'slowTiltScale', 'probabilityCap', 'minimumEdge', 'minimumQuality',
];

function divergentParameters(claimed: WalkForwardParameters, running: WalkForwardParameters): string[] {
  return parameterKeys.filter((key) => claimed[key] !== running[key])
    .map((key) => `${key} ${claimed[key]} vs running ${running[key]}`);
}

/**
 * Why a promotion or rollback must be refused, or `null` when it may be recorded.
 *
 * The integrity rule is the load-bearing one: the ledger may only ever describe the model the running
 * code is actually forecasting with. Production parameters are compile-time constants, so promotion is
 * a deploy-then-record act — recording a version or parameter set production is not running would make
 * `unrecorded: false` a lie, which is worse than the honest empty ledger it replaced.
 */
export function promotionRefusal(request: PromotionRequest, context: PromotionContext): string | null {
  if (request.action !== 'promoted' && request.action !== 'rolled-back') return 'Action must be promoted or rolled-back.';
  if (!request.reason?.trim()) return 'A promotion or rollback requires a written reason.';

  const expected = request.action === 'promoted' ? PROMOTION_CONFIRMATION : ROLLBACK_CONFIRMATION;
  if (request.confirmation !== expected) return `Type ${expected} exactly to record this decision.`;

  if (request.modelVersion !== context.running.modelVersion) {
    return `Production is running ${context.running.modelVersion}, not ${request.modelVersion}. Deploy the model first, then record it.`;
  }
  if (!request.parameters || typeof request.parameters !== 'object') return 'Parameters are required and must match the running model.';
  const divergent = divergentParameters(request.parameters, context.running.parameters);
  if (divergent.length) return `Parameters do not match the running model: ${divergent.join('; ')}.`;

  if (request.action === 'rolled-back') {
    if (!request.supersedesId) return 'A rollback must name the entry it supersedes.';
    if (!context.ledger.some((entry) => entry.id === request.supersedesId)) return 'The superseded entry is not in the ledger.';
    // Rollback is deliberately not eligibility-gated. Reverting must stay available precisely when the
    // evidence for the current model has fallen apart, which is when eligibility would fail.
    return null;
  }

  if (!request.evidenceRunId) return 'A promotion must cite the walk-forward run it relies on.';
  if (context.latestRunId && request.evidenceRunId !== context.latestRunId) {
    return `Evidence run ${request.evidenceRunId} is stale; the newest run is ${context.latestRunId}.`;
  }
  if (!context.eligibility.eligible) {
    const failed = context.eligibility.criteria.filter((item) => !item.met).map((item) => item.detail);
    return `Promotion criteria not met: ${failed.join(' ')}`;
  }
  return null;
}

/** Append-only: an existing entry is never edited, so the ledger stays a record rather than a state. */
export function appendPromotion(ledger: ModelPromotionEntry[], entry: ModelPromotionEntry): ModelPromotionEntry[] {
  if (ledger.some((item) => item.id === entry.id)) throw new Error('Promotion entries are immutable and may not be rewritten.');
  return [...ledger, entry];
}

/** Whatever the latest entry left in force. A rollback names its predecessor but still appends. */
export function activeModel(ledger: ModelPromotionEntry[]): ModelPromotionEntry | undefined {
  return [...ledger].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}
