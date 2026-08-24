import { createHash } from 'node:crypto';
import { clusterByWindow } from './action-counterfactual';
import { HIGH_EDGE_TAKER_THRESHOLD, type EntryExecutionDecision } from './entry-execution-policy';
import { EDGE_BINARY_BUY, normalizeStrategyId } from './strategy-registry';
import type { BoundedTakerExperimentStamp, ExecutionMode, PaperOrder, PositionSide } from './types';

export const BOUNDED_TAKER_EXPERIMENT_VERSION = 'bounded-taker-pilot-v1' as const;
export const BOUNDED_TAKER_CONFIRMATION = 'CONFIRM_300_CENT_BOUNDED_TAKER_V1';
export const BOUNDED_TAKER_BUCKETS = 10_000;
export const BOUNDED_TAKER_TREATMENT_BUCKETS = 2_500;
export const BOUNDED_TAKER_PER_ORDER_CAP_CENTS = 30;
export const BOUNDED_TAKER_TOTAL_CAP_CENTS = 300;
export const BOUNDED_TAKER_MAX_AUTHORIZATIONS = 10;
export const BOUNDED_TAKER_MAX_ASSIGNMENTS = 80;
export const BOUNDED_TAKER_MAX_AUTHORIZATIONS_PER_HOUR = 2;
export const BOUNDED_TAKER_MAX_AUTHORIZATIONS_PER_WINDOW = 1;
export const BOUNDED_TAKER_MAX_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;
export const BOUNDED_TAKER_GROSS_LOSS_STOP_CENTS = 150;

export type BoundedTakerExperimentState = {
  status: 'collecting' | 'inactive' | 'completed' | 'safety-stopped';
  reason: string;
  firstAssignedAt?: string;
  assignments: number;
  treatmentAuthorizations: number;
  authorizedCents: number;
  grossRealizedLossCents: number;
};

export interface BoundedTakerAssignmentIdentity {
  marketId: string;
  strategyId: string;
  symbol: string;
  side: PositionSide;
  closesAt: string;
}

export interface BoundedTakerPlanInput {
  enabled: boolean;
  mode: ExecutionMode;
  nowMs: number;
  identity: BoundedTakerAssignmentIdentity;
  order: PaperOrder;
  baseline: EntryExecutionDecision;
  treatmentFeasible: boolean;
  authorizationCapCents: number;
  orders: PaperOrder[];
}

export interface BoundedTakerPlan {
  participates: boolean;
  executeTreatment: boolean;
  stamp?: BoundedTakerExperimentStamp;
  state: BoundedTakerExperimentState;
}

export function boundedTakerExperimentEnabled(value = process.env.MONEY_NOODLE_BOUNDED_TAKER_EXPERIMENT): boolean {
  return value === BOUNDED_TAKER_CONFIRMATION;
}

export function boundedTakerAssignmentKey(identity: BoundedTakerAssignmentIdentity): string {
  return [
    BOUNDED_TAKER_EXPERIMENT_VERSION, identity.marketId, identity.strategyId,
    identity.symbol, identity.side, identity.closesAt,
  ].join('|');
}

export function boundedTakerHashBucket(assignmentKey: string): number {
  if (!assignmentKey) return BOUNDED_TAKER_BUCKETS;
  return Number.parseInt(createHash('sha256').update(assignmentKey).digest('hex').slice(0, 8), 16) % BOUNDED_TAKER_BUCKETS;
}

export function boundedTakerArm(identity: BoundedTakerAssignmentIdentity): {
  assignmentKey: string; hashBucket: number; arm: BoundedTakerExperimentStamp['arm'];
} {
  const assignmentKey = boundedTakerAssignmentKey(identity);
  const hashBucket = boundedTakerHashBucket(assignmentKey);
  return {
    assignmentKey,
    hashBucket,
    arm: hashBucket < BOUNDED_TAKER_TREATMENT_BUCKETS ? 'treatment-taker' : 'control-maker',
  };
}

function validStamp(stamp: BoundedTakerExperimentStamp | undefined): stamp is BoundedTakerExperimentStamp {
  if (!stamp || stamp.version !== BOUNDED_TAKER_EXPERIMENT_VERSION || !stamp.assignmentKey
    || !Number.isSafeInteger(stamp.hashBucket) || stamp.hashBucket < 0 || stamp.hashBucket >= BOUNDED_TAKER_BUCKETS
    || stamp.hashBucket !== boundedTakerHashBucket(stamp.assignmentKey)
    || !Number.isFinite(Date.parse(stamp.assignedAt))
    || !Number.isSafeInteger(stamp.authorizationCapCents) || stamp.authorizationCapCents <= 0
    || stamp.authorizationCapCents > BOUNDED_TAKER_PER_ORDER_CAP_CENTS
    || stamp.baselineRoute !== 'ordinary-maker'
    || (stamp.safetyStoppedAt !== undefined && (!Number.isFinite(Date.parse(stamp.safetyStoppedAt))
      || !stamp.safetyStopReason?.trim()))) return false;
  const expectedArm = stamp.hashBucket < BOUNDED_TAKER_TREATMENT_BUCKETS ? 'treatment-taker' : 'control-maker';
  if (stamp.arm !== expectedArm) return false;
  if (stamp.arm === 'control-maker') return stamp.execution === 'control-maker' && stamp.withheldReason === undefined;
  if (!['treatment-taker', 'paper-treatment-simulation', 'treatment-withheld'].includes(stamp.execution)) return false;
  return stamp.execution === 'treatment-withheld'
    ? stamp.withheldReason === 'hourly-cap' || stamp.withheldReason === 'settlement-window-cap'
    : stamp.withheldReason === undefined;
}

function validOrderStamp(order: PaperOrder): order is PaperOrder & { boundedTakerExperiment: BoundedTakerExperimentStamp } {
  const stamp = order.boundedTakerExperiment;
  return validStamp(stamp)
    && stamp.assignmentKey === boundedTakerAssignmentKey({
      marketId: order.marketId ?? 'crypto-15m', strategyId: normalizeStrategyId(order.strategyId),
      symbol: order.symbol, side: order.side, closesAt: order.closesAt,
    })
    && (order.executionMode === 'paper'
      ? stamp.execution !== 'treatment-taker'
      : stamp.execution !== 'paper-treatment-simulation');
}

const pilotLiveOrders = (orders: PaperOrder[]) => orders.filter((order) => order.executionMode === 'live'
  && normalizeStrategyId(order.strategyId) === EDGE_BINARY_BUY
  && order.boundedTakerExperiment?.version === BOUNDED_TAKER_EXPERIMENT_VERSION);

export function boundedTakerExperimentState(
  orders: PaperOrder[], nowMs = Date.now(), enabled = true,
): BoundedTakerExperimentState {
  const pilot = pilotLiveOrders(orders);
  if (pilot.some((order) => !validOrderStamp(order))) return {
    status: 'safety-stopped', reason: 'A durable bounded-taker stamp is malformed; no experimental taker is authorized.',
    assignments: pilot.length, treatmentAuthorizations: 0, authorizedCents: 0, grossRealizedLossCents: 0,
  };
  const stamped = pilot as Array<PaperOrder & { boundedTakerExperiment: BoundedTakerExperimentStamp }>;
  const authorizations = stamped.filter((order) => order.boundedTakerExperiment.execution === 'treatment-taker');
  const authorizedCents = authorizations.reduce((sum, order) => sum + order.boundedTakerExperiment.authorizationCapCents, 0);
  const invalidMoney = !Number.isSafeInteger(authorizedCents) || authorizedCents < 0;
  const invalidPnl = authorizations.some((order) => order.pnlCents !== undefined && !Number.isSafeInteger(order.pnlCents));
  const grossRealizedLossCents = authorizations.reduce((sum, order) => {
    const pnl = order.pnlCents;
    return typeof pnl === 'number' && Number.isSafeInteger(pnl) && pnl < 0 ? sum - pnl : sum;
  }, 0);
  const firstAssignedAt = stamped.map((order) => order.boundedTakerExperiment.assignedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const safetyStop = stamped.find((order) => order.boundedTakerExperiment.safetyStoppedAt);
  const base = {
    firstAssignedAt, assignments: stamped.length, treatmentAuthorizations: authorizations.length,
    authorizedCents, grossRealizedLossCents,
  };
  if (invalidMoney || invalidPnl || !Number.isSafeInteger(grossRealizedLossCents)) return {
    ...base, status: 'safety-stopped', reason: 'Bounded-taker control money is malformed.',
  };
  if (safetyStop) return {
    ...base, status: 'safety-stopped',
    reason: safetyStop.boundedTakerExperiment.safetyStopReason ?? 'A treatment-specific ambiguity ended v1.',
  };
  if (!enabled) return {
    ...base, status: 'inactive', reason: 'The exact bounded-taker confirmation is not armed.',
  };
  if (grossRealizedLossCents >= BOUNDED_TAKER_GROSS_LOSS_STOP_CENTS) return {
    ...base, status: 'completed', reason: `Gross realized treatment losses reached ${grossRealizedLossCents}c.`,
  };
  if (authorizedCents >= BOUNDED_TAKER_TOTAL_CAP_CENTS
    || authorizations.length >= BOUNDED_TAKER_MAX_AUTHORIZATIONS) return {
    ...base, status: 'completed', reason: 'The treatment authorization ceiling was reached.',
  };
  if (stamped.length >= BOUNDED_TAKER_MAX_ASSIGNMENTS) return {
    ...base, status: 'completed', reason: 'The live assignment ceiling was reached.',
  };
  if (firstAssignedAt && nowMs >= Date.parse(firstAssignedAt) + BOUNDED_TAKER_MAX_DURATION_MS) return {
    ...base, status: 'completed', reason: 'The fourteen-day collection ceiling was reached.',
  };
  return { ...base, status: 'collecting', reason: 'Bounded taker pilot is collecting.' };
}

export function boundedTakerEligible(input: Pick<BoundedTakerPlanInput,
  'enabled' | 'identity' | 'order' | 'baseline' | 'treatmentFeasible' | 'authorizationCapCents'>): boolean {
  return input.enabled
    && normalizeStrategyId(input.order.strategyId) === EDGE_BINARY_BUY
    && input.order.venue === 'kalshi'
    && (input.order.entryEpisode ?? input.order.attemptNumber ?? 1) === 1
    && !input.order.id.includes(':reentry:')
    && input.baseline.configuredMode === 'adaptive'
    && input.baseline.executedStyle === 'maker'
    && input.baseline.route === 'ordinary-maker'
    && Number.isFinite(input.order.entrySizingDecision?.netEdge)
    && (input.order.entrySizingDecision?.netEdge ?? Number.POSITIVE_INFINITY) < HIGH_EDGE_TAKER_THRESHOLD - 1e-12
    && input.treatmentFeasible
    && Number.isSafeInteger(input.order.entrySizingDecision?.stakeLimitCents)
    && (input.order.entrySizingDecision?.stakeLimitCents ?? Number.POSITIVE_INFINITY) <= BOUNDED_TAKER_PER_ORDER_CAP_CENTS
    && Number.isSafeInteger(input.authorizationCapCents)
    && input.authorizationCapCents > 0
    && input.authorizationCapCents <= BOUNDED_TAKER_PER_ORDER_CAP_CENTS
    && input.identity.strategyId === EDGE_BINARY_BUY;
}

export function planBoundedTakerExperiment(input: BoundedTakerPlanInput): BoundedTakerPlan {
  const state = boundedTakerExperimentState(input.orders, input.nowMs, input.enabled);
  if (state.status !== 'collecting' || !boundedTakerEligible(input)) {
    return { participates: false, executeTreatment: false, state };
  }
  const assignment = boundedTakerArm(input.identity);
  const baseStamp: BoundedTakerExperimentStamp = {
    version: BOUNDED_TAKER_EXPERIMENT_VERSION,
    ...assignment,
    assignedAt: new Date(input.nowMs).toISOString(),
    baselinePolicyVersion: input.baseline.policyVersion,
    baselineRoute: 'ordinary-maker',
    authorizationCapCents: input.authorizationCapCents,
    execution: 'control-maker',
  };
  if (assignment.arm === 'control-maker') return {
    participates: true, executeTreatment: false, stamp: baseStamp, state,
  };
  if (input.mode === 'paper') return {
    participates: true, executeTreatment: true,
    stamp: { ...baseStamp, execution: 'paper-treatment-simulation' }, state,
  };
  const authorized = pilotLiveOrders(input.orders).filter((order) => validOrderStamp(order)
    && order.boundedTakerExperiment.execution === 'treatment-taker') as Array<PaperOrder & { boundedTakerExperiment: BoundedTakerExperimentStamp }>;
  const inHour = authorized.filter((order) => Date.parse(order.boundedTakerExperiment.assignedAt) > input.nowMs - 3_600_000).length;
  if (inHour >= BOUNDED_TAKER_MAX_AUTHORIZATIONS_PER_HOUR) return {
    participates: true, executeTreatment: false,
    stamp: { ...baseStamp, execution: 'treatment-withheld', withheldReason: 'hourly-cap' }, state,
  };
  const inWindow = authorized.filter((order) => order.closesAt === input.identity.closesAt).length;
  if (inWindow >= BOUNDED_TAKER_MAX_AUTHORIZATIONS_PER_WINDOW) return {
    participates: true, executeTreatment: false,
    stamp: { ...baseStamp, execution: 'treatment-withheld', withheldReason: 'settlement-window-cap' }, state,
  };
  if (state.authorizedCents + input.authorizationCapCents > BOUNDED_TAKER_TOTAL_CAP_CENTS
    || state.treatmentAuthorizations >= BOUNDED_TAKER_MAX_AUTHORIZATIONS) {
    return { participates: false, executeTreatment: false, state: { ...state, status: 'completed', reason: 'The treatment authorization ceiling cannot admit another order.' } };
  }
  return {
    participates: true, executeTreatment: true,
    stamp: { ...baseStamp, execution: 'treatment-taker' }, state,
  };
}

export function applyBoundedTakerPlan(
  baseline: EntryExecutionDecision, plan: BoundedTakerPlan,
): EntryExecutionDecision {
  if (!plan.executeTreatment) return baseline;
  return {
    ...baseline,
    executedStyle: 'taker',
    route: 'bounded-taker-experiment',
    reason: 'Bounded taker pilot treatment: submit one fresh production-rule-qualified, price-capped IOC.',
  };
}

export interface BoundedTakerArmReport {
  arm: BoundedTakerExperimentStamp['arm'];
  assignments: number;
  resolved: number;
  treatmentExecuted: number;
  treatmentWithheld: number;
  submissionAttempts: number;
  venueAcceptances: number;
  preSubmitRefusals: number;
  iocNoFills: number;
  partialFills: number;
  safetyStops: number;
  filledSequences: number;
  profitableSequences: number;
  authorizationCents: number;
  exactPnlCents: number;
  holdPnlCents: number;
  returnOnAuthorization: number | null;
  clusteredMeanReturn: number | null;
  clusteredStandardError: number | null;
}

export interface BoundedTakerTrackReport {
  mode: ExecutionMode;
  control: BoundedTakerArmReport;
  treatment: BoundedTakerArmReport;
  treatmentMinusControlMeanReturn: number | null;
  treatmentMinusControlStandardError: number | null;
}

function exactOrderPnl(order: PaperOrder): number {
  return order.actualPnlCents ?? order.pnlCents ?? 0;
}

function sequenceHoldPnl(orders: PaperOrder[]): number {
  return orders.reduce((sum, order) => {
    if ((order.filledCount ?? 0) <= 0) return sum;
    if (order.status === 'sold') return sum + (order.counterfactualHoldPnlCents ?? 0);
    return sum + exactOrderPnl(order);
  }, 0);
}

export function buildBoundedTakerExperimentReport(
  orders: PaperOrder[], nowMs = Date.now(), enabled = boundedTakerExperimentEnabled(),
): { version: typeof BOUNDED_TAKER_EXPERIMENT_VERSION; state: BoundedTakerExperimentState; tracks: Record<ExecutionMode, BoundedTakerTrackReport>; reviewUnlocked: false } {
  const assignments = orders.filter(validOrderStamp) as Array<PaperOrder & { boundedTakerExperiment: BoundedTakerExperimentStamp }>;
  const track = (mode: ExecutionMode): BoundedTakerTrackReport => {
    const trackAssignments = assignments.filter((order) => order.executionMode === mode
      && normalizeStrategyId(order.strategyId) === EDGE_BINARY_BUY);
    const rows = trackAssignments.map((assignment) => {
      const sequence = orders.filter((order) => order.executionMode === mode
        && normalizeStrategyId(order.strategyId) === EDGE_BINARY_BUY
        && (order.logicalOrderId ?? order.id) === (assignment.logicalOrderId ?? assignment.id)
        && !order.id.includes(':exit:'));
      const unresolved = sequence.some((order) => ['open', 'pending_reservation', 'uncertain'].includes(order.status));
      const resolved = !unresolved && nowMs >= Date.parse(assignment.closesAt);
      const exactPnlCents = resolved ? sequence.reduce((sum, order) => sum + exactOrderPnl(order), 0) : 0;
      const holdPnlCents = resolved ? sequenceHoldPnl(sequence) : 0;
      return {
        arm: assignment.boundedTakerExperiment.arm,
        closesAt: assignment.closesAt,
        resolved,
        exactPnlCents,
        holdPnlCents,
        authorizationCents: assignment.boundedTakerExperiment.authorizationCapCents,
        treatmentExecuted: ['treatment-taker', 'paper-treatment-simulation'].includes(assignment.boundedTakerExperiment.execution),
        treatmentWithheld: assignment.boundedTakerExperiment.execution === 'treatment-withheld',
        submissionAttempted: assignment.entryExecutionObservations?.some((observation) => observation.event === 'create_quote') ?? false,
        venueAccepted: Boolean(assignment.venueOrderId),
        preSubmitRefusal: assignment.noFillReason === 'pre_submit_quote_moved',
        iocNoFill: assignment.noFillReason === 'ioc_no_fill',
        partialFill: (assignment.filledCount ?? 0) > 0
          && (assignment.filledCount ?? 0) + 1e-8 < (assignment.requestedQuantity ?? assignment.quantity),
        safetyStop: Boolean(assignment.boundedTakerExperiment.safetyStoppedAt),
        filled: sequence.some((order) => (order.filledCount ?? 0) > 0),
      };
    });
    const arm = (armId: BoundedTakerExperimentStamp['arm']): BoundedTakerArmReport => {
      const selected = rows.filter((row) => row.arm === armId);
      const resolved = selected.filter((row) => row.resolved);
      const clustered = clusterByWindow(resolved, (row) => row.closesAt, (row) => row.exactPnlCents / row.authorizationCents);
      const authorizationCents = resolved.reduce((sum, row) => sum + row.authorizationCents, 0);
      const exactPnlCents = resolved.reduce((sum, row) => sum + row.exactPnlCents, 0);
      return {
        arm: armId,
        assignments: selected.length,
        resolved: resolved.length,
        treatmentExecuted: selected.filter((row) => row.treatmentExecuted).length,
        treatmentWithheld: selected.filter((row) => row.treatmentWithheld).length,
        submissionAttempts: selected.filter((row) => row.submissionAttempted).length,
        venueAcceptances: selected.filter((row) => row.venueAccepted).length,
        preSubmitRefusals: selected.filter((row) => row.preSubmitRefusal).length,
        iocNoFills: selected.filter((row) => row.iocNoFill).length,
        partialFills: selected.filter((row) => row.partialFill).length,
        safetyStops: selected.filter((row) => row.safetyStop).length,
        filledSequences: resolved.filter((row) => row.filled).length,
        profitableSequences: resolved.filter((row) => row.exactPnlCents > 1e-9).length,
        authorizationCents,
        exactPnlCents,
        holdPnlCents: resolved.reduce((sum, row) => sum + row.holdPnlCents, 0),
        returnOnAuthorization: authorizationCents ? exactPnlCents / authorizationCents : null,
        clusteredMeanReturn: clustered.mean,
        clusteredStandardError: clustered.standardError,
      };
    };
    const control = arm('control-maker');
    const treatment = arm('treatment-taker');
    const difference = control.clusteredMeanReturn === null || treatment.clusteredMeanReturn === null
      ? null : treatment.clusteredMeanReturn - control.clusteredMeanReturn;
    const differenceSe = control.clusteredStandardError === null || treatment.clusteredStandardError === null
      ? null : Math.sqrt(control.clusteredStandardError ** 2 + treatment.clusteredStandardError ** 2);
    return {
      mode, control, treatment,
      treatmentMinusControlMeanReturn: difference,
      treatmentMinusControlStandardError: differenceSe,
    };
  };
  return {
    version: BOUNDED_TAKER_EXPERIMENT_VERSION,
    state: boundedTakerExperimentState(orders, nowMs, enabled),
    tracks: { live: track('live'), paper: track('paper') },
    reviewUnlocked: false,
  };
}
