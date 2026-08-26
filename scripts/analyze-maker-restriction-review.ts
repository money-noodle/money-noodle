/**
 * Measure: prospective maker-restriction v1 review locks, exact cash, intent-level clustered return, and
 * winner/loser-conditional production fill rates for the current live and paper execution generations.
 * Deciding correction: attempts remain in the denominator with zero return for refusal/no-fill, returns are
 * clustered by UTC settlement window, and one-sided Holm correction controls the frozen two-arm family per track.
 * Main biases: a refusal receives no credit for capital reuse or a replacement trade; paper fill mechanics differ
 * materially from live; live and paper share signals and are not independent replications; review is read-only.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { normalCdf } from '../src/lib/basis-model';
import {
  MAKER_RESTRICTION_MINIMUM_COVERAGE,
  MAKER_RESTRICTION_MINIMUM_DIVERGENT_WINDOWS,
  MAKER_RESTRICTION_REVIEW_WINDOWS,
  holmSignificantMakerRestrictions,
  type MakerRestrictionArmReport,
  type MakerRestrictionCandidateId,
  type MakerRestrictionSentinel,
  type MakerRestrictionTrackReport,
} from '../src/lib/maker-restriction-sentinel';
import {
  getMakerRestrictionSentinelReport,
  getMakerRestrictionSentinels,
} from '../src/lib/maker-restriction-sentinel-store';
import { getExecutionOrders } from '../src/lib/paper-execution';
import type { ExecutionMode, PaperOrder } from '../src/lib/types';

const ONE_SIDED_95_Z = 1.6448536269514722;
const TRACKS: ExecutionMode[] = ['live', 'paper'];

function candidatePValue(candidate: MakerRestrictionArmReport): number {
  const mean = candidate.incrementalMeanReturn;
  const standardError = candidate.incrementalStandardError;
  if (mean === null || standardError === null || mean <= 1e-12) return 1;
  return standardError <= 1e-15 ? 0 : 1 - normalCdf(mean / standardError);
}

function trackCandidateReview(track: MakerRestrictionTrackReport) {
  const coverage = track.resolvedRecords
    ? (track.resolvedRecords - track.unscorableRecords) / track.resolvedRecords
    : 0;
  const significant = holmSignificantMakerRestrictions(track.candidates);
  let earlierRejected = false;
  const holm = [...track.candidates]
    .map((candidate) => ({ candidate, pValue: candidatePValue(candidate) }))
    .sort((left, right) => left.pValue - right.pValue)
    .map(({ candidate, pValue }, index, ordered) => {
      const threshold = 0.05 / (ordered.length - index);
      const passedAtRank = !earlierRejected && pValue <= threshold;
      if (!passedAtRank) earlierRejected = true;
      const exactCashDifferenceCents = candidate.pnlCents - track.production.pnlCents;
      const standardError = candidate.incrementalStandardError;
      const lowerBound = candidate.incrementalMeanReturn === null || standardError === null
        ? null
        : candidate.incrementalMeanReturn - ONE_SIDED_95_Z * standardError;
      return {
        candidateId: candidate.candidateId,
        attempts: candidate.attempts,
        zeroDeploymentAttempts: candidate.attempts - candidate.filledAttempts,
        filledAttempts: candidate.filledAttempts,
        windows: candidate.windows,
        divergentAttempts: candidate.divergentAttempts,
        divergentWindows: candidate.divergentWindows,
        deployedCents: candidate.deployedCents,
        pnlCents: candidate.pnlCents,
        returnOnDeployedStake: candidate.deployedCents ? candidate.pnlCents / candidate.deployedCents : null,
        exactCashDifferenceCents,
        incrementalMeanReturn: candidate.incrementalMeanReturn,
        incrementalStandardError: standardError,
        oneSided95LowerBound: lowerBound,
        oneSidedPValue: pValue,
        holmThreshold: threshold,
        holmPassedAtRank: passedAtRank,
        gates: {
          resolvedWindows: candidate.windows >= MAKER_RESTRICTION_REVIEW_WINDOWS,
          divergentWindows: candidate.divergentWindows >= MAKER_RESTRICTION_MINIMUM_DIVERGENT_WINDOWS,
          scoreableCoverage: coverage + 1e-12 >= MAKER_RESTRICTION_MINIMUM_COVERAGE,
          positiveExactCashDifference: exactCashDifferenceCents > 1e-9,
          positiveClusteredMean: (candidate.incrementalMeanReturn ?? 0) > 1e-12,
          holmSignificant: significant.has(candidate.candidateId as MakerRestrictionCandidateId),
        },
      };
    });
  return {
    records: track.records,
    resolvedRecords: track.resolvedRecords,
    unscorableRecords: track.unscorableRecords,
    scoreableCoverage: coverage,
    production: {
      ...track.production,
      zeroDeploymentAttempts: track.production.attempts - track.production.filledAttempts,
      returnOnDeployedStake: track.production.deployedCents
        ? track.production.pnlCents / track.production.deployedCents
        : null,
    },
    candidatesInHolmOrder: holm,
  };
}

function fillSelection(
  mode: ExecutionMode,
  sentinels: MakerRestrictionSentinel[],
  orders: Map<string, PaperOrder>,
  buyPolicyVersion: string,
  executionPolicyVersion: string,
) {
  const scoped = sentinels.filter((sentinel) => sentinel.executionMode === mode
    && sentinel.buyPolicyVersion === buyPolicyVersion
    && sentinel.executionPolicyVersion === executionPolicyVersion
    && sentinel.resolvedAt && !sentinel.invalidReason);
  const rows = scoped.flatMap((sentinel) => {
    const order = orders.get(sentinel.orderId);
    return order ? [{ sentinel, filled: (order.filledCount ?? 0) > 0 }] : [];
  });
  const summarize = (values: typeof rows) => {
    const fills = values.filter((row) => row.filled).length;
    return { attempts: values.length, fills, fillRate: values.length ? fills / values.length : null };
  };
  return {
    scoreableRows: rows.length,
    missingOrderLinks: scoped.length - rows.length,
    winnerConditional: summarize(rows.filter((row) => row.sentinel.outcome === row.sentinel.side)),
    loserConditional: summarize(rows.filter((row) => row.sentinel.outcome !== row.sentinel.side)),
  };
}

const orders = await getExecutionOrders();
const orderMap = new Map(orders.map((order) => [order.id, order]));
const [store, report] = await Promise.all([
  getMakerRestrictionSentinels(),
  getMakerRestrictionSentinelReport(orders),
]);
const tracks = Object.fromEntries(TRACKS.map((mode) => [mode, {
  ...trackCandidateReview(report.tracks[mode]),
  productionFillSelection: fillSelection(
    mode, store.sentinels, orderMap, report.buyPolicyVersion, report.executionPolicyVersions[mode],
  ),
}])) as Record<ExecutionMode, ReturnType<typeof trackCandidateReview> & {
  productionFillSelection: ReturnType<typeof fillSelection>;
}>;
const candidateIds: MakerRestrictionCandidateId[] = ['maker-spread-max2c-v1', 'maker-spike-max2pp-v1'];
const jointReviewUnlocked = Object.fromEntries(candidateIds.map((candidateId) => [candidateId,
  TRACKS.every((mode) => report.tracks[mode].candidates
    .find((candidate) => candidate.candidateId === candidateId)?.reviewUnlocked === true),
]));
const auditInput = JSON.stringify({
  report,
  sentinels: store.sentinels,
  orders: orders.map((order) => ({
    id: order.id,
    filledCount: order.filledCount,
    actualStakeCents: order.actualStakeCents,
    stakeCents: order.stakeCents,
    actualPnlCents: order.actualPnlCents,
    pnlCents: order.pnlCents,
  })),
});

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  auditInputSha256: createHash('sha256').update(auditInput).digest('hex'),
  sentinelVersion: report.sentinelVersion,
  startedAt: report.startedAt,
  buyPolicyVersion: report.buyPolicyVersion,
  executionPolicyVersions: report.executionPolicyVersions,
  reviewThresholds: {
    resolvedWindows: MAKER_RESTRICTION_REVIEW_WINDOWS,
    divergentWindows: MAKER_RESTRICTION_MINIMUM_DIVERGENT_WINDOWS,
    minimumScoreableCoverage: MAKER_RESTRICTION_MINIMUM_COVERAGE,
    familyWiseAlpha: 0.05,
    candidates: candidateIds.length,
  },
  tracks,
  jointReviewUnlocked,
  authority: 'read-only fixed review; no execution, policy, capital, budget, reconciliation, or promotion authority',
}, null, 2));
