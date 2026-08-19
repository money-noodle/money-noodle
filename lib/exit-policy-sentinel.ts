import { clusterByWindow } from './action-counterfactual';
import { PAPER_MANAGED_MAKER_EXECUTION_VERSION } from './paper-maker-simulation';
import { EDGE_BINARY_BUY } from './strategy-registry';
import type { ExecutionMode, PaperOrder, PositionLifecycleObservation, PositionSide, StrategyId } from './types';

export const EXIT_POLICY_SENTINEL_VERSION = 'exit-policy-sentinel-v1';
export const EXIT_POLICY_REVIEW_WINDOWS = 60;
export const EXIT_POLICY_MINIMUM_DIVERGENT_WINDOWS = 20;
export const EXIT_POLICY_MINIMUM_COVERAGE = 0.9;
export const EXIT_SENTINEL_MAXIMUM_OBSERVATION_GAP_MS = 20_000;

export type ExitCandidateId =
  | 'strict-value-margin3c-v1'
  | 'strict-value-margin5c-v1'
  | 'strict-value-confirm2-v1'
  | 'trailing-50-35-v1';

export interface ExitCandidateTrigger {
  at: string;
  netLiquidationCents: number;
  unrealizedPnlCents: number;
  optimisticHoldValueCents: number;
  source: 'production' | 'continuation';
}

export interface ExitCandidateState {
  candidateId: ExitCandidateId;
  trigger?: ExitCandidateTrigger;
  confirmationAt?: string;
  trailingArmedAt?: string;
  peakNetLiquidationCents?: number;
}

export interface ExitSentinelObservation {
  at: string;
  source: 'production' | 'continuation';
  selectedBid: number;
  selectedAsk: number;
  spread: number;
  netLiquidationCents: number;
  exitFeeCents: number;
  exactCostCents: number;
  unrealizedPnlCents: number;
  ownedSideProbability: number;
  confidence: number;
  optimisticHoldValueCents: number;
  secondsRemaining: number;
}

export interface ExitProductionAction {
  status: 'open' | 'held' | 'strict-exit-no-fill' | 'strict-exit' | 'other-exit';
  policy?: string;
  attemptedAt?: string;
  proceedsCents?: number;
  actualPnlCents?: number;
}

export interface ExitPolicySentinel {
  id: string;
  sentinelVersion: typeof EXIT_POLICY_SENTINEL_VERSION;
  recordedAt: string;
  orderCreatedAt: string;
  positionOpenedAt: string;
  orderId: string;
  strategyId: StrategyId;
  executionMode: ExecutionMode;
  symbol: string;
  contractId: string;
  side: PositionSide;
  closesAt: string;
  quantity: number;
  exactCostCents: number;
  buyPolicyVersion: string;
  executionPolicyVersion: string;
  observations: ExitSentinelObservation[];
  candidateStates: Record<ExitCandidateId, ExitCandidateState>;
  production: ExitProductionAction;
  outcome?: PositionSide;
  holdPnlCents?: number;
  resolvedAt?: string;
  invalidReason?: string;
}

export interface ExitCandidateReport {
  candidateId: ExitCandidateId | 'production' | 'hold';
  positions: number;
  windows: number;
  triggers: number;
  divergentWindows: number;
  pnlCents: number;
  incrementalCents: number;
  incrementalMeanReturn: number | null;
  incrementalStandardError: number | null;
  reviewUnlocked: boolean;
}

export interface ExitPolicySentinelTrackReport {
  fillAssumption: 'exact simulated execution' | 'optimistic executable-bid fill replay';
  positions: number;
  resolvedPositions: number;
  completePositions: number;
  coverage: number;
  production: ExitCandidateReport;
  hold: ExitCandidateReport;
  candidates: ExitCandidateReport[];
}

export interface ExitPolicySentinelReport {
  sentinelVersion: typeof EXIT_POLICY_SENTINEL_VERSION;
  startedAt: string;
  buyPolicyVersion: string;
  executionPolicyVersions: Record<ExecutionMode, string>;
  tracks: Record<ExecutionMode, ExitPolicySentinelTrackReport>;
}

export const EXIT_CANDIDATE_IDS: ExitCandidateId[] = [
  'strict-value-margin3c-v1',
  'strict-value-margin5c-v1',
  'strict-value-confirm2-v1',
  'trailing-50-35-v1',
];

const initialStates = (): Record<ExitCandidateId, ExitCandidateState> => Object.fromEntries(
  EXIT_CANDIDATE_IDS.map((candidateId) => [candidateId, { candidateId }]),
) as Record<ExitCandidateId, ExitCandidateState>;

function uncertainty(confidence: number): number {
  return Math.max(0.03, Math.min(0.15, (1 - confidence) * 0.25));
}

export function exitSentinelObservation(
  observation: PositionLifecycleObservation,
  source: ExitSentinelObservation['source'],
): ExitSentinelObservation | null {
  const numeric = [
    observation.selectedBid, observation.selectedAsk, observation.spread, observation.netLiquidationCents,
    observation.exitFeeCents, observation.exactCostCents, observation.unrealizedPnlCents,
    observation.ownedSideProbability, observation.confidence, observation.secondsRemaining,
  ];
  if (!Number.isFinite(Date.parse(observation.at)) || !numeric.every(Number.isFinite)
    || observation.selectedBid <= 0 || observation.selectedBid >= 1
    || observation.selectedAsk <= 0 || observation.selectedAsk > 1 || observation.selectedBid > observation.selectedAsk
    || observation.exactCostCents <= 0 || observation.exitFeeCents < 0
    || observation.ownedSideProbability < 0 || observation.ownedSideProbability > 1
    || observation.confidence < 0 || observation.confidence > 1) return null;
  const quantity = observation.netLiquidationCents + observation.exitFeeCents;
  const payoutAtOne = quantity / observation.selectedBid;
  if (!Number.isFinite(payoutAtOne) || payoutAtOne <= 0) return null;
  return {
    at: observation.at,
    source,
    selectedBid: observation.selectedBid,
    selectedAsk: observation.selectedAsk,
    spread: observation.spread,
    netLiquidationCents: observation.netLiquidationCents,
    exitFeeCents: observation.exitFeeCents,
    exactCostCents: observation.exactCostCents,
    unrealizedPnlCents: observation.unrealizedPnlCents,
    ownedSideProbability: observation.ownedSideProbability,
    confidence: observation.confidence,
    optimisticHoldValueCents: payoutAtOne * Math.min(1, observation.ownedSideProbability + uncertainty(observation.confidence)),
    secondsRemaining: observation.secondsRemaining,
  };
}

function trigger(observation: ExitSentinelObservation): ExitCandidateTrigger {
  return {
    at: observation.at,
    netLiquidationCents: observation.netLiquidationCents,
    unrealizedPnlCents: observation.unrealizedPnlCents,
    optimisticHoldValueCents: observation.optimisticHoldValueCents,
    source: observation.source,
  };
}

/** Pure first-to-fire reducer. Candidate state can never affect the production exit evaluator. */
export function advanceExitCandidateStates(
  previous: Record<ExitCandidateId, ExitCandidateState>, observation: ExitSentinelObservation,
): Record<ExitCandidateId, ExitCandidateState> {
  const next = Object.fromEntries(EXIT_CANDIDATE_IDS.map((candidateId) => [candidateId, { ...previous[candidateId] }])) as Record<ExitCandidateId, ExitCandidateState>;
  if (!next['strict-value-margin3c-v1'].trigger
    && observation.netLiquidationCents + 1e-9 >= observation.optimisticHoldValueCents + 3) {
    next['strict-value-margin3c-v1'].trigger = trigger(observation);
  }
  if (!next['strict-value-margin5c-v1'].trigger
    && observation.netLiquidationCents + 1e-9 >= observation.optimisticHoldValueCents + 5) {
    next['strict-value-margin5c-v1'].trigger = trigger(observation);
  }
  const confirmation = next['strict-value-confirm2-v1'];
  if (!confirmation.trigger) {
    const qualifies = observation.netLiquidationCents + 1e-9 >= observation.optimisticHoldValueCents + 1;
    if (!qualifies) confirmation.confirmationAt = undefined;
    else if (confirmation.confirmationAt
      && Date.parse(observation.at) - Date.parse(confirmation.confirmationAt) >= 2_000) {
      confirmation.trigger = trigger(observation);
    } else if (!confirmation.confirmationAt) confirmation.confirmationAt = observation.at;
  }
  const trailing = next['trailing-50-35-v1'];
  if (!trailing.trigger) {
    if (!trailing.trailingArmedAt && observation.unrealizedPnlCents + 1e-9 >= observation.exactCostCents * 0.5) {
      trailing.trailingArmedAt = observation.at;
      trailing.peakNetLiquidationCents = observation.netLiquidationCents;
    } else if (trailing.trailingArmedAt) {
      const priorPeak = trailing.peakNetLiquidationCents ?? observation.netLiquidationCents;
      if (observation.netLiquidationCents > priorPeak + 1e-9) trailing.peakNetLiquidationCents = observation.netLiquidationCents;
      else if (observation.netLiquidationCents <= priorPeak * 0.65 + 1e-9) trailing.trigger = trigger(observation);
    }
  }
  return next;
}

export function exitPolicySentinelFromOrder(
  order: PaperOrder, observation: ExitSentinelObservation,
): ExitPolicySentinel | null {
  if (order.strategyId !== EDGE_BINARY_BUY || order.id.includes(':exit:') || order.entryDecision?.version !== 'entry-decision-v2') return null;
  if (![order.createdAt, order.closesAt, observation.at].every((value) => Number.isFinite(Date.parse(value)))) return null;
  if (!(order.quantity > 0) || !((order.filledCount ?? order.quantity) > 0)) return null;
  const exactCostCents = order.actualStakeCents ?? order.stakeCents;
  if (!(exactCostCents > 0) || Math.abs(exactCostCents - observation.exactCostCents) > 1e-9) return null;
  const states = advanceExitCandidateStates(initialStates(), observation);
  return {
    id: `${EXIT_POLICY_SENTINEL_VERSION}:${order.executionMode}:${order.id}`,
    sentinelVersion: EXIT_POLICY_SENTINEL_VERSION,
    recordedAt: observation.at,
    orderCreatedAt: order.createdAt,
    positionOpenedAt: order.makerCompletedAt ?? order.entryExecutionObservations?.at(-1)?.at ?? order.createdAt,
    orderId: order.id,
    strategyId: order.strategyId,
    executionMode: order.executionMode,
    symbol: order.symbol,
    contractId: order.contractId,
    side: order.side,
    closesAt: order.closesAt,
    quantity: order.quantity,
    exactCostCents,
    buyPolicyVersion: order.entryDecision.policyVersion,
    executionPolicyVersion: order.entryExecutionDecision?.policyVersion
      ?? order.entryDecision.executionPolicyVersion ?? PAPER_MANAGED_MAKER_EXECUTION_VERSION,
    observations: [observation],
    candidateStates: states,
    production: { status: 'open' },
  };
}

export function appendExitSentinelObservation(
  sentinel: ExitPolicySentinel, observation: ExitSentinelObservation,
): ExitPolicySentinel {
  if (sentinel.resolvedAt || sentinel.invalidReason || sentinel.observations.some((item) => item.at === observation.at)) return sentinel;
  const last = sentinel.observations.at(-1);
  if (last && Date.parse(observation.at) < Date.parse(last.at)) return sentinel;
  return {
    ...sentinel,
    observations: [...sentinel.observations, observation],
    candidateStates: advanceExitCandidateStates(sentinel.candidateStates, observation),
  };
}

export function exitSentinelPathComplete(sentinel: ExitPolicySentinel): boolean {
  if (!sentinel.resolvedAt || sentinel.invalidReason || !sentinel.observations.length) return false;
  const observations = [...sentinel.observations].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const firstDelay = Date.parse(observations[0].at) - Date.parse(sentinel.positionOpenedAt);
  if (!Number.isFinite(firstDelay) || firstDelay < -1e-9 || firstDelay > EXIT_SENTINEL_MAXIMUM_OBSERVATION_GAP_MS) return false;
  for (let index = 1; index < observations.length; index += 1) {
    if (Date.parse(observations[index].at) - Date.parse(observations[index - 1].at) > EXIT_SENTINEL_MAXIMUM_OBSERVATION_GAP_MS) return false;
  }
  return observations.at(-1)!.secondsRemaining <= EXIT_SENTINEL_MAXIMUM_OBSERVATION_GAP_MS / 1_000;
}

function actualPnl(order: PaperOrder): number {
  return order.actualPnlCents ?? order.pnlCents ?? 0;
}

export function buildExitPolicySentinelReport(input: {
  startedAt: string;
  buyPolicyVersion: string;
  executionPolicyVersions: Record<ExecutionMode, string>;
  sentinels: ExitPolicySentinel[];
  orders: PaperOrder[];
}): ExitPolicySentinelReport {
  const orders = new Map(input.orders.map((order) => [order.id, order]));
  const track = (mode: ExecutionMode): ExitPolicySentinelTrackReport => {
    const trackSentinels = input.sentinels.filter((sentinel) => sentinel.executionMode === mode
      && sentinel.buyPolicyVersion === input.buyPolicyVersion
      && sentinel.executionPolicyVersion === input.executionPolicyVersions[mode]);
    const resolved = trackSentinels.filter((sentinel) => sentinel.resolvedAt && sentinel.holdPnlCents !== undefined
      && !sentinel.invalidReason && orders.has(sentinel.orderId));
    const complete = resolved.filter(exitSentinelPathComplete);
    const scored = complete.map((sentinel) => ({ sentinel, actual: actualPnl(orders.get(sentinel.orderId)!) }));
    const arm = (candidateId: ExitCandidateId | 'production' | 'hold'): ExitCandidateReport => {
      const rows = scored.map(({ sentinel, actual }) => {
        const triggerValue = candidateId === 'production' || candidateId === 'hold'
          ? undefined : sentinel.candidateStates[candidateId].trigger;
        const pnl = candidateId === 'production' ? actual
          : candidateId === 'hold' ? sentinel.holdPnlCents!
            : triggerValue ? triggerValue.netLiquidationCents - sentinel.exactCostCents : sentinel.holdPnlCents!;
        const incremental = pnl - actual;
        const productionSold = sentinel.production.status === 'strict-exit' || sentinel.production.status === 'other-exit';
        const triggerMatchesProduction = Boolean(triggerValue && sentinel.production.attemptedAt
          && Math.abs(Date.parse(triggerValue.at) - Date.parse(sentinel.production.attemptedAt)) <= EXIT_SENTINEL_MAXIMUM_OBSERVATION_GAP_MS);
        const diverged = candidateId === 'hold'
          ? productionSold
          : candidateId === 'production' ? false
            : productionSold ? !triggerMatchesProduction : Boolean(triggerValue);
        return { closesAt: sentinel.closesAt, pnl, incremental, triggered: Boolean(triggerValue), diverged, cost: sentinel.exactCostCents };
      });
      const incremental = clusterByWindow(rows, (row) => row.closesAt, (row) => row.incremental / row.cost);
      const divergentWindows = new Set(rows.filter((row) => row.diverged).map((row) => row.closesAt)).size;
      return {
        candidateId,
        positions: rows.length,
        windows: new Set(rows.map((row) => row.closesAt)).size,
        triggers: rows.filter((row) => row.triggered).length,
        divergentWindows,
        pnlCents: rows.reduce((sum, row) => sum + row.pnl, 0),
        incrementalCents: rows.reduce((sum, row) => sum + row.incremental, 0),
        incrementalMeanReturn: incremental.mean,
        incrementalStandardError: incremental.standardError,
        reviewUnlocked: candidateId !== 'production' && candidateId !== 'hold'
          && new Set(rows.map((row) => row.closesAt)).size >= EXIT_POLICY_REVIEW_WINDOWS
          && divergentWindows >= EXIT_POLICY_MINIMUM_DIVERGENT_WINDOWS
          && (resolved.length ? complete.length / resolved.length : 0) >= EXIT_POLICY_MINIMUM_COVERAGE,
      };
    };
    const coverage = resolved.length ? complete.length / resolved.length : 0;
    return {
      fillAssumption: mode === 'paper' ? 'exact simulated execution' : 'optimistic executable-bid fill replay',
      positions: trackSentinels.length,
      resolvedPositions: resolved.length,
      completePositions: complete.length,
      coverage,
      production: arm('production'),
      hold: arm('hold'),
      candidates: EXIT_CANDIDATE_IDS.map(arm),
    };
  };
  return {
    sentinelVersion: EXIT_POLICY_SENTINEL_VERSION,
    startedAt: input.startedAt,
    buyPolicyVersion: input.buyPolicyVersion,
    executionPolicyVersions: input.executionPolicyVersions,
    tracks: { live: track('live'), paper: track('paper') },
  };
}
