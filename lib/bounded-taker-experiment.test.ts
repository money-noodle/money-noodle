import { describe, expect, it } from 'vitest';
import {
  BOUNDED_TAKER_CONFIRMATION, BOUNDED_TAKER_EXPERIMENT_VERSION,
  applyBoundedTakerPlan, boundedTakerArm, boundedTakerAssignmentKey,
  boundedTakerExperimentEnabled, boundedTakerExperimentState,
  buildBoundedTakerExperimentReport, planBoundedTakerExperiment,
  type BoundedTakerAssignmentIdentity,
} from './bounded-taker-experiment';
import { ENTRY_EXECUTION_POLICY_VERSION, type EntryExecutionDecision } from './entry-execution-policy';
import { EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import type { BoundedTakerExperimentStamp, PaperOrder } from './types';

const closesAt = '2026-08-25T00:15:00.000Z';
const identity = (symbol = 'ETH'): BoundedTakerAssignmentIdentity => ({
  marketId: 'crypto-15m', strategyId: EDGE_BINARY_BUY, symbol, side: 'UP', closesAt,
});

const baseline: EntryExecutionDecision = {
  policyVersion: ENTRY_EXECUTION_POLICY_VERSION,
  configuredMode: 'adaptive', executedStyle: 'maker', recommendedStyle: 'maker', route: 'ordinary-maker',
  reason: 'baseline maker', takerNetEdge: 0.15, medianNetEdge: 0.1, makerNetEdge: 0.17,
  makerExpectedCapturedEdge: 0.05, takerAdvantage: 0.1, makerCohort: 'test', makerSamples: 10,
  makerFillRate: 0.5, makerMissFallback: false,
};

function stamp(
  patch: Partial<BoundedTakerExperimentStamp> = {}, assignmentIdentity = identity(),
): BoundedTakerExperimentStamp {
  const assigned = boundedTakerArm(assignmentIdentity);
  return {
    version: BOUNDED_TAKER_EXPERIMENT_VERSION,
    ...assigned,
    assignedAt: '2026-08-25T00:00:00.000Z',
    baselinePolicyVersion: ENTRY_EXECUTION_POLICY_VERSION,
    baselineRoute: 'ordinary-maker', authorizationCapCents: 30,
    execution: assigned.arm === 'treatment-taker' ? 'treatment-taker' : 'control-maker',
    ...patch,
  };
}

function order(id: string, patch: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id, logicalOrderId: id, executionMode: 'live', marketId: 'crypto-15m', strategyId: EDGE_BINARY_BUY,
    symbol: 'ETH', venue: 'kalshi', contractId: 'ETH-TEST', side: 'UP', status: 'unfilled',
    createdAt: '2026-08-25T00:00:00.000Z', calculationAt: '2026-08-25T00:00:00.000Z', closesAt,
    modelProbabilityUp: 0.7, confidence: 0.7, askPrice: 0.5, bidPrice: 0.48, spread: 0.02,
    quantity: 0.5, stakeCents: 26, feeCents: 1, potentialPayoutCents: 50,
    attemptNumber: 1, entryEpisode: 1,
    entrySizingDecision: {
      policyVersion: 'entry-sizing-reduce30-below-edge30-v1', baseStakeLimitCents: 100,
      netEdge: 0.15, multiplier: 0.3, stakeLimitCents: 30, reason: 'reduced',
    },
    ...patch,
  };
}

function planInput(patch: Partial<Parameters<typeof planBoundedTakerExperiment>[0]> = {}) {
  const candidate = order('live:ETH:UP:test');
  return {
    enabled: true, mode: 'live' as const, nowMs: Date.parse(candidate.createdAt),
    identity: identity(), order: candidate, baseline, treatmentFeasible: true,
    authorizationCapCents: 30, orders: [] as PaperOrder[], ...patch,
  };
}

describe('bounded taker assignment', () => {
  it('requires the exact typed confirmation', () => {
    expect(boundedTakerExperimentEnabled(BOUNDED_TAKER_CONFIRMATION)).toBe(true);
    expect(boundedTakerExperimentEnabled('true')).toBe(false);
    expect(boundedTakerExperimentEnabled(undefined)).toBe(false);
  });

  it('pins deterministic 25/75 buckets without an execution-mode input', () => {
    expect(boundedTakerAssignmentKey(identity('ETH'))).toBe(
      'bounded-taker-pilot-v1|crypto-15m|edge-binary-buy|ETH|UP|2026-08-25T00:15:00.000Z',
    );
    expect(boundedTakerArm(identity('ETH'))).toMatchObject({ hashBucket: 2183, arm: 'treatment-taker' });
    expect(boundedTakerArm(identity('BTC'))).toMatchObject({ hashBucket: 7250, arm: 'control-maker' });
  });

  it('authorizes the treatment only for a feasible first-episode sub-30pp baseline maker', () => {
    const treatment = planBoundedTakerExperiment(planInput());
    expect(treatment).toMatchObject({ participates: true, executeTreatment: true });
    expect(treatment.stamp).toMatchObject({ arm: 'treatment-taker', execution: 'treatment-taker', authorizationCapCents: 30 });
    expect(applyBoundedTakerPlan(baseline, treatment)).toMatchObject({
      executedStyle: 'taker', route: 'bounded-taker-experiment',
    });
    // Median and 2c are incumbent style gates, not production admission gates. A baseline maker that
    // failed either remains eligible for the randomized treatment.
    expect(planBoundedTakerExperiment(planInput({ baseline: {
      ...baseline, medianNetEdge: Number.NEGATIVE_INFINITY, takerNetEdge: 0.15,
    } })).executeTreatment).toBe(true);

    for (const patch of [
      { treatmentFeasible: false },
      { order: order('episode-2', { attemptNumber: 2, entryEpisode: 2 }) },
      { order: order('reentry', { id: 'live:ETH:UP:test:reentry:2' }) },
      { order: order('high-edge', { entrySizingDecision: { ...order('x').entrySizingDecision!, netEdge: 0.30, multiplier: 1 } }) },
      { order: order('oversized-control', { entrySizingDecision: { ...order('x').entrySizingDecision!, stakeLimitCents: 31 } }) },
      { order: order('other', { strategyId: LONG_SHOT_ROUND_TRIP }) },
      { baseline: { ...baseline, executedStyle: 'taker' as const, recommendedStyle: 'taker' as const, route: 'high-edge-taker' as const } },
    ]) expect(planBoundedTakerExperiment(planInput(patch)).participates).toBe(false);
  });

  it('keeps a deterministic control on incumbent maker execution', () => {
    const btc = order('live:BTC:UP:test', { symbol: 'BTC' });
    const plan = planBoundedTakerExperiment(planInput({ identity: identity('BTC'), order: btc }));
    expect(plan).toMatchObject({ participates: true, executeTreatment: false });
    expect(plan.stamp).toMatchObject({ arm: 'control-maker', execution: 'control-maker' });
    expect(applyBoundedTakerPlan(baseline, plan)).toBe(baseline);
  });
});

describe('bounded taker safety ceilings', () => {
  const authorized = (id: string, at: string, patch: Partial<PaperOrder> = {}) => order(id, {
    createdAt: at,
    boundedTakerExperiment: stamp({ assignedAt: at, arm: 'treatment-taker', execution: 'treatment-taker' }),
    ...patch,
  });

  it('retains durable counts when the typed gate is later inactive', () => {
    const existing = [authorized('t-0', '2026-08-25T00:00:00.000Z')];
    expect(boundedTakerExperimentState(existing, Date.parse('2026-08-25T01:00:00Z'), false)).toMatchObject({
      status: 'inactive', assignments: 1, treatmentAuthorizations: 1, authorizedCents: 30,
    });
  });

  it('stops exactly at ten authorizations and 300 integer cents', () => {
    const orders = Array.from({ length: 10 }, (_, index) => authorized(`t-${index}`, `2026-08-25T00:${String(index).padStart(2, '0')}:00.000Z`));
    expect(boundedTakerExperimentState(orders, Date.parse('2026-08-25T01:00:00Z'))).toMatchObject({
      status: 'completed', treatmentAuthorizations: 10, authorizedCents: 300,
    });
  });

  it('withholds rather than taking when the hourly or settlement-window sub-cap binds', () => {
    const nowMs = Date.parse('2026-08-25T01:00:00Z');
    const recent = [
      authorized('t-1', '2026-08-25T00:30:01.000Z'),
      authorized('t-2', '2026-08-25T00:45:01.000Z'),
    ];
    expect(planBoundedTakerExperiment(planInput({ nowMs, orders: recent })).stamp).toMatchObject({
      execution: 'treatment-withheld', withheldReason: 'hourly-cap',
    });
    expect(planBoundedTakerExperiment(planInput({
      nowMs: Date.parse('2026-08-25T02:00:00Z'), orders: [authorized('old-window', '2026-08-25T00:00:00.000Z')],
    })).stamp).toMatchObject({ execution: 'treatment-withheld', withheldReason: 'settlement-window-cap' });
  });

  it('stops on 150c gross losses, elapsed duration, a sticky ambiguity, or malformed money', () => {
    const losses = Array.from({ length: 5 }, (_, index) => authorized(`loss-${index}`, `2026-08-25T0${index}:00:00.000Z`, {
      status: 'lost', pnlCents: -30,
    }));
    expect(boundedTakerExperimentState(losses, Date.parse('2026-08-25T06:00:00Z'))).toMatchObject({
      status: 'completed', grossRealizedLossCents: 150,
    });
    expect(boundedTakerExperimentState([authorized('old', '2026-08-01T00:00:00.000Z')], Date.parse('2026-08-15T00:00:00Z')).status).toBe('completed');
    expect(boundedTakerExperimentState([authorized('unsafe', '2026-08-25T00:00:00.000Z', {
      boundedTakerExperiment: stamp({ safetyStoppedAt: '2026-08-25T00:01:00.000Z', safetyStopReason: 'ambiguous fill' }),
    })], Date.parse('2026-08-25T01:00:00Z'))).toMatchObject({ status: 'safety-stopped', reason: 'ambiguous fill' });
    expect(boundedTakerExperimentState([order('malformed', {
      boundedTakerExperiment: { ...stamp(), authorizationCapCents: 31 } as BoundedTakerExperimentStamp,
    })]).status).toBe('safety-stopped');
  });

  it('does not let another strategy consume the experiment allowance', () => {
    const unrelated = Array.from({ length: 10 }, (_, index) => authorized(`other-${index}`, `2026-08-25T00:${index}0:00.000Z`, {
      strategyId: LONG_SHOT_ROUND_TRIP,
    }));
    expect(boundedTakerExperimentState(unrelated)).toMatchObject({ status: 'collecting', assignments: 0, authorizedCents: 0 });
  });
});

describe('bounded taker reporting', () => {
  it('scores the whole control sequence and never unlocks a promotion', () => {
    const controlIdentity = { ...identity('BTC'), closesAt: '2026-08-24T00:15:00Z' };
    const controlStamp = stamp({}, controlIdentity);
    const control = order('control-1', {
      symbol: 'BTC', logicalOrderId: 'control-sequence', closesAt: controlIdentity.closesAt,
      boundedTakerExperiment: controlStamp,
    });
    const controlEpisode2 = order('control-2', {
      symbol: 'BTC', logicalOrderId: 'control-sequence', attemptNumber: 2, entryEpisode: 2,
      closesAt: controlIdentity.closesAt, status: 'won', filledCount: 0.5, pnlCents: 20, actualPnlCents: 20,
    });
    const treatmentIdentity = { ...identity(), closesAt: '2026-08-24T00:30:00Z' };
    const treatmentAssignment = boundedTakerArm(treatmentIdentity);
    expect(treatmentAssignment.arm).toBe('treatment-taker');
    const treatment = order('treatment', {
      logicalOrderId: 'treatment', closesAt: treatmentIdentity.closesAt, status: 'lost', filledCount: 0.25,
      requestedQuantity: 0.5, venueOrderId: 'venue-treatment',
      entryExecutionObservations: [{ at: '2026-08-24T00:00:01Z', event: 'create_quote' }],
      pnlCents: -30, actualPnlCents: -30,
      boundedTakerExperiment: stamp({ execution: 'treatment-taker' }, treatmentIdentity),
    });
    const report = buildBoundedTakerExperimentReport([control, controlEpisode2, treatment], Date.parse('2026-08-25T00:00:00Z'), true);
    expect(report.reviewUnlocked).toBe(false);
    expect(report.tracks.live.control).toMatchObject({ assignments: 1, resolved: 1, filledSequences: 1, exactPnlCents: 20 });
    expect(report.tracks.live.treatment).toMatchObject({
      assignments: 1, resolved: 1, treatmentExecuted: 1, submissionAttempts: 1,
      venueAcceptances: 1, partialFills: 1, filledSequences: 1, exactPnlCents: -30,
    });
    expect(report.tracks.live.treatmentMinusControlMeanReturn).toBeCloseTo(-50 / 30, 12);
  });
});
