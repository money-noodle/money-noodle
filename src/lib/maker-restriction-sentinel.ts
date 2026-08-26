import { clusterByWindow } from './action-counterfactual';
import { normalCdf } from './basis-model';
import { PAPER_MANAGED_MAKER_EXECUTION_VERSION } from './paper-maker-simulation';
import { EDGE_BINARY_BUY } from './strategy-registry';
import type { ExecutionMode, PaperOrder, PositionSide, StrategyId } from './types';

/** Observation-only generation approved in docs/positive-edge-execution-exit-sentinel-design.md. */
export const MAKER_RESTRICTION_SENTINEL_VERSION = 'maker-restriction-sentinel-v1';
export const MAKER_RESTRICTION_REVIEW_WINDOWS = 60;
export const MAKER_RESTRICTION_MINIMUM_DIVERGENT_WINDOWS = 20;
export const MAKER_RESTRICTION_MINIMUM_COVERAGE = 0.9;
export const MAKER_SPREAD_MAXIMUM = 0.02;
export const MAKER_SPIKE_MAXIMUM = 0.02;

export type MakerRestrictionCandidateId = 'maker-spread-max2c-v1' | 'maker-spike-max2pp-v1';

export interface MakerRestrictionCandidateDecision {
  candidateId: MakerRestrictionCandidateId;
  decision: 'admit' | 'refuse';
  reason: string;
}

export interface MakerRestrictionSentinel {
  id: string;
  sentinelVersion: typeof MAKER_RESTRICTION_SENTINEL_VERSION;
  recordedAt: string;
  calculationAt: string;
  strategyId: StrategyId;
  executionMode: ExecutionMode;
  symbol: string;
  contractId: string;
  side: PositionSide;
  closesAt: string;
  logicalSequence: string;
  orderId: string;
  buyPolicyVersion: string;
  executionPolicyVersion: string;
  issuanceAsk: number;
  issuanceBid: number;
  spread: number;
  netEdge: number;
  medianNetEdge: number | null;
  edgeSpike: number | null;
  cycleRegime?: PaperOrder['entryDecision'] extends infer _T ? NonNullable<PaperOrder['entryDecision']>['cycleRegime'] : never;
  candidates: MakerRestrictionCandidateDecision[];
  outcome?: PositionSide;
  resolvedAt?: string;
  invalidReason?: string;
}

export interface MakerRestrictionArmReport {
  candidateId: MakerRestrictionCandidateId | 'production';
  attempts: number;
  divergentAttempts: number;
  windows: number;
  divergentWindows: number;
  filledAttempts: number;
  deployedCents: number;
  pnlCents: number;
  meanReturnAcrossAttempts: number | null;
  incrementalMeanReturn: number | null;
  incrementalStandardError: number | null;
  reviewUnlocked: boolean;
}

export interface MakerRestrictionTrackReport {
  records: number;
  resolvedRecords: number;
  unscorableRecords: number;
  production: MakerRestrictionArmReport;
  candidates: MakerRestrictionArmReport[];
}

export interface MakerRestrictionSentinelReport {
  sentinelVersion: typeof MAKER_RESTRICTION_SENTINEL_VERSION;
  startedAt: string;
  buyPolicyVersion: string;
  executionPolicyVersions: Record<ExecutionMode, string>;
  tracks: Record<ExecutionMode, MakerRestrictionTrackReport>;
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

export function makerRestrictionCandidateDecisions(input: {
  spread: number;
  edgeSpike: number | null | undefined;
}): MakerRestrictionCandidateDecision[] {
  const spreadAdmits = finite(input.spread) && input.spread <= MAKER_SPREAD_MAXIMUM + 1e-9;
  const spikeAdmits = finite(input.edgeSpike) && input.edgeSpike + 1e-12 < MAKER_SPIKE_MAXIMUM;
  return [
    {
      candidateId: 'maker-spread-max2c-v1', decision: spreadAdmits ? 'admit' : 'refuse',
      reason: spreadAdmits
        ? `Issuance spread is at or below ${(MAKER_SPREAD_MAXIMUM * 100).toFixed(0)}c.`
        : finite(input.spread) ? `Issuance spread exceeds ${(MAKER_SPREAD_MAXIMUM * 100).toFixed(0)}c.` : 'Issuance spread is invalid.',
    },
    {
      candidateId: 'maker-spike-max2pp-v1', decision: spikeAdmits ? 'admit' : 'refuse',
      reason: spikeAdmits
        ? `Edge spike is below ${(MAKER_SPIKE_MAXIMUM * 100).toFixed(0)}pp.`
        : finite(input.edgeSpike) ? `Edge spike is at or above ${(MAKER_SPIKE_MAXIMUM * 100).toFixed(0)}pp.` : 'Edge spike is unavailable.',
    },
  ];
}

/**
 * Builds a decision-time record only for an issued edge-policy maker attempt. Production never reads it.
 * Legacy entry-decision-v1 rows are deliberately ineligible because their missing feature is not zero.
 */
export function makerRestrictionSentinelFromOrder(order: PaperOrder): MakerRestrictionSentinel | null {
  if (order.strategyId !== EDGE_BINARY_BUY || order.id.includes(':exit:') || order.entryDecision?.version !== 'entry-decision-v2') return null;
  const maker = order.executionMode === 'live'
    ? order.entryExecutionDecision?.executedStyle === 'maker'
    : order.liquidityRole === 'maker';
  if (!maker) return null;
  if (![order.createdAt, order.calculationAt, order.closesAt].every((value) => Number.isFinite(Date.parse(value)))) return null;
  const decision = order.entryDecision;
  const spread = order.issuanceSpread ?? decision.spread;
  const issuanceAsk = order.issuanceAskPrice ?? decision.actionableAsk;
  const issuanceBid = order.issuanceBidPrice ?? decision.actionableBid;
  if (![spread, issuanceAsk, issuanceBid, decision.netEdge].every(Number.isFinite)) return null;
  const executionPolicyVersion = order.executionMode === 'live'
    ? order.entryExecutionDecision?.policyVersion ?? decision.executionPolicyVersion ?? 'unknown'
    : decision.executionPolicyVersion ?? PAPER_MANAGED_MAKER_EXECUTION_VERSION;
  return {
    id: `${MAKER_RESTRICTION_SENTINEL_VERSION}:${order.executionMode}:${order.id}`,
    sentinelVersion: MAKER_RESTRICTION_SENTINEL_VERSION,
    recordedAt: order.createdAt,
    calculationAt: order.calculationAt,
    strategyId: order.strategyId,
    executionMode: order.executionMode,
    symbol: order.symbol,
    contractId: order.contractId,
    side: order.side,
    closesAt: order.closesAt,
    logicalSequence: order.logicalOrderId ?? order.id,
    orderId: order.id,
    buyPolicyVersion: decision.policyVersion,
    executionPolicyVersion,
    issuanceAsk,
    issuanceBid,
    spread,
    netEdge: decision.netEdge,
    medianNetEdge: decision.medianNetEdge,
    edgeSpike: decision.edgeSpike ?? null,
    cycleRegime: decision.cycleRegime ? { ...decision.cycleRegime } : undefined,
    candidates: makerRestrictionCandidateDecisions({ spread, edgeSpike: decision.edgeSpike }),
  };
}

function orderStake(order: PaperOrder): number {
  return order.actualStakeCents ?? order.stakeCents;
}

function orderPnl(order: PaperOrder): number {
  return order.actualPnlCents ?? order.pnlCents ?? 0;
}

/** One-sided clustered normal tests with Holm correction across the frozen two-arm family. */
export function holmSignificantMakerRestrictions(candidates: MakerRestrictionArmReport[]): Set<MakerRestrictionCandidateId> {
  const tests = candidates.map((candidate) => {
    const mean = candidate.incrementalMeanReturn;
    const standardError = candidate.incrementalStandardError;
    const pValue = mean === null || standardError === null || mean <= 1e-12 ? 1
      : standardError <= 1e-15 ? 0 : 1 - normalCdf(mean / standardError);
    return { candidateId: candidate.candidateId as MakerRestrictionCandidateId, pValue };
  }).sort((left, right) => left.pValue - right.pValue);
  const significant = new Set<MakerRestrictionCandidateId>();
  let earlierRejected = false;
  for (let rank = 0; rank < tests.length; rank += 1) {
    const test = tests[rank];
    if (earlierRejected || test.pValue > 0.05 / (tests.length - rank)) earlierRejected = true;
    else significant.add(test.candidateId);
  }
  return significant;
}

/** Exact restrictive comparison: a refusal earns zero; an admission inherits production's actual result. */
export function buildMakerRestrictionSentinelReport(input: {
  startedAt: string;
  buyPolicyVersion: string;
  executionPolicyVersions: Record<ExecutionMode, string>;
  sentinels: MakerRestrictionSentinel[];
  orders: PaperOrder[];
}): MakerRestrictionSentinelReport {
  const orders = new Map(input.orders.map((order) => [order.id, order]));
  const rows = input.sentinels.flatMap((sentinel) => {
    const order = orders.get(sentinel.orderId);
    if (!order || sentinel.invalidReason || !sentinel.resolvedAt) return [];
    const stake = (order.filledCount ?? 0) > 0 ? orderStake(order) : 0;
    if (!Number.isFinite(stake) || stake < 0) return [];
    const pnl = stake > 0 ? orderPnl(order) : 0;
    const productionReturn = stake > 0 ? pnl / stake : 0;
    return [{ sentinel, order, stake, pnl, productionReturn }];
  });
  const candidateIds: MakerRestrictionCandidateId[] = ['maker-spread-max2c-v1', 'maker-spike-max2pp-v1'];
  const track = (mode: ExecutionMode): MakerRestrictionTrackReport => {
    const trackSentinels = input.sentinels.filter((sentinel) => sentinel.executionMode === mode
      && sentinel.buyPolicyVersion === input.buyPolicyVersion
      && sentinel.executionPolicyVersion === input.executionPolicyVersions[mode]);
    const trackIds = new Set(trackSentinels.map((sentinel) => sentinel.id));
    const trackRows = rows.filter((row) => trackIds.has(row.sentinel.id));
    const arm = (candidateId: MakerRestrictionCandidateId | 'production'): MakerRestrictionArmReport => {
      const values = trackRows.map((row) => {
        const admitted = candidateId === 'production'
          || row.sentinel.candidates.find((candidate) => candidate.candidateId === candidateId)?.decision === 'admit';
        const candidateReturn = admitted ? row.productionReturn : 0;
        return {
          closesAt: row.sentinel.closesAt,
          incremental: candidateReturn - row.productionReturn,
          candidateReturn,
          admitted,
          stake: admitted ? row.stake : 0,
          pnl: admitted ? row.pnl : 0,
          filled: admitted && (row.order.filledCount ?? 0) > 0,
        };
      });
      const clusteredReturn = clusterByWindow(values, (value) => value.closesAt, (value) => value.candidateReturn);
      const incremental = clusterByWindow(values, (value) => value.closesAt, (value) => value.incremental);
      const divergentWindows = new Set(values.filter((value) => !value.admitted).map((value) => value.closesAt)).size;
      return {
        candidateId,
        attempts: values.length,
        divergentAttempts: values.filter((value) => !value.admitted).length,
        windows: clusteredReturn.windows,
        divergentWindows,
        filledAttempts: values.filter((value) => value.filled).length,
        deployedCents: values.reduce((sum, value) => sum + value.stake, 0),
        pnlCents: values.reduce((sum, value) => sum + value.pnl, 0),
        meanReturnAcrossAttempts: clusteredReturn.mean,
        incrementalMeanReturn: incremental.mean,
        incrementalStandardError: incremental.standardError,
        reviewUnlocked: false,
      };
    };
    const resolvedRecords = trackSentinels.filter((sentinel) => sentinel.resolvedAt && !sentinel.invalidReason).length;
    const production = arm('production');
    const candidates = candidateIds.map(arm);
    const significant = holmSignificantMakerRestrictions(candidates);
    const coverage = resolvedRecords ? trackRows.length / resolvedRecords : 0;
    for (const candidate of candidates) {
      candidate.reviewUnlocked = candidate.windows >= MAKER_RESTRICTION_REVIEW_WINDOWS
        && candidate.divergentWindows >= MAKER_RESTRICTION_MINIMUM_DIVERGENT_WINDOWS
        && coverage + 1e-12 >= MAKER_RESTRICTION_MINIMUM_COVERAGE
        && candidate.pnlCents - production.pnlCents > 1e-9
        && (candidate.incrementalMeanReturn ?? 0) > 1e-12
        && significant.has(candidate.candidateId as MakerRestrictionCandidateId);
    }
    return {
      records: trackSentinels.length,
      resolvedRecords,
      unscorableRecords: trackSentinels.length - trackRows.length,
      production,
      candidates,
    };
  };
  const tracks = { live: track('live'), paper: track('paper') };
  for (const candidateId of candidateIds) {
    const live = tracks.live.candidates.find((candidate) => candidate.candidateId === candidateId)!;
    const paper = tracks.paper.candidates.find((candidate) => candidate.candidateId === candidateId)!;
    const jointlyUnlocked = live.reviewUnlocked && paper.reviewUnlocked
      && (live.incrementalMeanReturn ?? 0) > 1e-12 && (paper.incrementalMeanReturn ?? 0) > 1e-12;
    live.reviewUnlocked = jointlyUnlocked;
    paper.reviewUnlocked = jointlyUnlocked;
  }
  return {
    sentinelVersion: MAKER_RESTRICTION_SENTINEL_VERSION,
    startedAt: input.startedAt,
    buyPolicyVersion: input.buyPolicyVersion,
    executionPolicyVersions: input.executionPolicyVersions,
    tracks,
  };
}
