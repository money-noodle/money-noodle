import type { WalkForwardEvaluationRun, WalkForwardParameters } from './types';

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

export type ModelPromotionAction = 'promoted' | 'rolled-back';

export interface ModelPromotionEntry {
  id: string;
  at: string;
  action: ModelPromotionAction;
  modelVersion: string;
  parameters: WalkForwardParameters;
  /** Operator-supplied justification. Required: an unexplained promotion is not auditable. */
  reason: string;
  /** Walk-forward run the decision cited, retained so the evidence cannot drift from the decision. */
  evidenceRunId?: string;
  evidence?: {
    checkpointWindows: number;
    candidateMeanWindowReturn: number;
    baselineMeanWindowReturn: number;
    candidateTrades: number;
    positiveCandidateFolds: number;
    candidateBeatBaselineFolds: number;
    maximumBaselineReplayError: number;
  };
  /** Entry this one supersedes, set on a rollback so the chain is explicit. */
  supersedesId?: string;
}

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

/** Append-only: an existing entry is never edited, so the ledger stays a record rather than a state. */
export function appendPromotion(ledger: ModelPromotionEntry[], entry: ModelPromotionEntry): ModelPromotionEntry[] {
  if (ledger.some((item) => item.id === entry.id)) throw new Error('Promotion entries are immutable and may not be rewritten.');
  return [...ledger, entry];
}

/** Whatever the latest entry left in force. A rollback names its predecessor but still appends. */
export function activeModel(ledger: ModelPromotionEntry[]): ModelPromotionEntry | undefined {
  return [...ledger].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}
