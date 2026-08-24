import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { replayExitPolicySentinelEvents } from './exit-policy-sentinel-store';
import { replayMakerRestrictionSentinelEvents } from './maker-restriction-sentinel-store';
import { EDGE_BINARY_BUY } from './strategy-registry';
import type { ExitPolicySentinel } from './exit-policy-sentinel';
import type { MakerRestrictionSentinel } from './maker-restriction-sentinel';

const maker = (): MakerRestrictionSentinel => ({
  id: 'maker:1', sentinelVersion: 'maker-restriction-sentinel-v1', recordedAt: '2026-08-20T00:00:00Z',
  calculationAt: '2026-08-20T00:00:00Z', strategyId: EDGE_BINARY_BUY, executionMode: 'live', symbol: 'BTC',
  contractId: 'BTC-TEST', side: 'UP', closesAt: '2026-08-20T00:15:00Z', logicalSequence: 'logical',
  orderId: 'order', buyPolicyVersion: 'v21', executionPolicyVersion: 'v3', issuanceAsk: 0.6,
  issuanceBid: 0.58, spread: 0.02, netEdge: 0.1, medianNetEdge: 0.08, edgeSpike: 0.02,
  candidates: [
    { candidateId: 'maker-spread-max2c-v1', decision: 'admit', reason: 'fixed' },
    { candidateId: 'maker-spike-max2pp-v1', decision: 'refuse', reason: 'fixed' },
  ],
});

const exit = (): ExitPolicySentinel => ({
  id: 'exit:1', sentinelVersion: 'exit-policy-sentinel-v2', recordedAt: '2026-08-20T00:00:10Z',
  orderCreatedAt: '2026-08-20T00:00:00Z', positionOpenedAt: '2026-08-20T00:00:00Z',
  orderId: 'order', strategyId: EDGE_BINARY_BUY, executionMode: 'live',
  symbol: 'BTC', contractId: 'BTC-TEST', side: 'UP', closesAt: '2026-08-20T00:01:00Z', quantity: 1,
  exactCostCents: 60, buyPolicyVersion: 'v21', executionPolicyVersion: 'v3',
  evaluationCycles: [],
  observations: [{
    at: '2026-08-20T00:00:10Z', source: 'production', selectedBid: 0.7, selectedAsk: 0.71, spread: 0.01,
    netLiquidationCents: 69, exitFeeCents: 1, exactCostCents: 60, unrealizedPnlCents: 9,
    ownedSideProbability: 0.6, confidence: 0.8, optimisticHoldValueCents: 65, secondsRemaining: 50,
  }],
  candidateStates: {
    'strict-value-margin3c-v1': { candidateId: 'strict-value-margin3c-v1', trigger: {
      at: '2026-08-20T00:00:10Z', netLiquidationCents: 69, unrealizedPnlCents: 9,
      optimisticHoldValueCents: 65, source: 'production',
    } },
    'strict-value-margin5c-v1': { candidateId: 'strict-value-margin5c-v1' },
    'strict-value-confirm2-v1': { candidateId: 'strict-value-confirm2-v1', confirmationAt: '2026-08-20T00:00:10Z' },
    'trailing-50-35-v1': { candidateId: 'trailing-50-35-v1' },
  },
  production: { status: 'open' },
});

describe('append-only sentinel event replay', () => {
  it('keeps the first maker decision immutable and patches settlement once', () => {
    const first = maker();
    const maliciousDuplicate = { ...first, netEdge: 0.9 };
    const resolved = { ...first, netEdge: 0.7, outcome: 'UP' as const, resolvedAt: '2026-08-20T00:16:00Z' };
    const replayed = replayMakerRestrictionSentinelEvents([], [
      { op: 'decision', value: first }, { op: 'decision', value: maliciousDuplicate },
      { op: 'resolution', value: resolved },
      { op: 'resolution', value: { ...resolved, outcome: 'DOWN' } },
    ]);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ netEdge: 0.1, outcome: 'UP' });
  });

  it('deduplicates exit observations and retains first-to-fire state through resolution', () => {
    const first = exit();
    const second = {
      ...first.observations[0], at: '2026-08-20T00:00:12Z', netLiquidationCents: 70,
      unrealizedPnlCents: 10, secondsRemaining: 48,
    };
    const state = { ...first, production: { status: 'strict-exit' as const, policy: 'strict-value-v1' } };
    const resolution = { ...state, outcome: 'UP' as const, holdPnlCents: 40, resolvedAt: '2026-08-20T00:01:01Z' };
    const replayed = replayExitPolicySentinelEvents([], [
      { op: 'position', value: first },
      { op: 'observation', id: first.id, value: second },
      { op: 'observation', id: first.id, value: second },
      { op: 'evaluation-cycle', id: first.id, value: { at: second.at, classification: 'observed' } },
      { op: 'evaluation-cycle', id: first.id, value: { at: second.at, classification: 'observed' } },
      { op: 'state', value: state },
      { op: 'resolution', value: resolution },
    ]);
    expect(replayed[0].observations).toHaveLength(2);
    expect(replayed[0].evaluationCycles).toEqual([{ at: second.at, classification: 'observed' }]);
    expect(replayed[0].candidateStates['strict-value-margin3c-v1'].trigger?.at).toBe('2026-08-20T00:00:10Z');
    expect(replayed[0]).toMatchObject({ production: { status: 'strict-exit' }, outcome: 'UP', holdPnlCents: 40 });
  });
});

describe('sentinel results cannot reach a money-moving module', () => {
  it('has no import from a rule, sizing, budget, or signed-order module', () => {
    const forbidden = [
      'prediction-policy.ts', 'entry-execution-policy.ts', 'exit-policy.ts', 'portfolio-policy.ts',
      'venue-fill.ts', 'live-risk-policy.ts', 'live-orders.ts', 'trading-control.ts',
    ];
    for (const file of forbidden) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      expect({ file, importsSentinel: /from ['"].*(maker-restriction|exit-policy-sentinel)/.test(source) })
        .toEqual({ file, importsSentinel: false });
    }
  });

  it('queues current exit observations before detached cycle classification and resolution', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib', 'paper-execution.ts'), 'utf8');
    const observation = source.indexOf('changed = await observeAndExecuteStandaloneExits');
    const maintenance = source.indexOf('void getExitPolicyContinuationOrderIds(dashboard.generatedAt)', observation);
    expect(observation).toBeGreaterThan(-1);
    expect(maintenance).toBeGreaterThan(observation);
  });

  it('keeps both stores append-journaled and owned by their compactor', () => {
    for (const file of ['maker-restriction-sentinel-store.ts', 'exit-policy-sentinel-store.ts']) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      expect(source).toContain('appendFile(JOURNAL_FILE');
      expect(source).toContain('JOURNAL_COMPACTION_BYTES');
      expect(source).toContain("await atomicWrite(JOURNAL_FILE, '')");
    }
  });
});
