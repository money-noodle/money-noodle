import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { EntryDecisionSnapshot } from './types';

/**
 * `entry-decision-v2` records two things the desk already computed at decision time and threw away at the
 * order boundary: the edge spike, and the numeric cycle-regime features behind the coarse label.
 *
 * The reason they were added is that neither could be scored against realized money — the 2026-08-19
 * screen could reconstruct a volatility ratio for only 605 of 995 v17+ orders and could not reconstruct
 * `trendEfficiency` at all. The reason they are fenced is AGENTS §5.5: these fields exist to be graded
 * prospectively, and a field that a gate can read is a field that can promote a retroactive screen.
 */

const v1: EntryDecisionSnapshot = {
  version: 'entry-decision-v1',
  policyVersion: 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v17',
  calculationAt: '2026-08-14T00:55:42.393Z', side: 'UP',
  probabilityUp: 0.62, probabilityDown: 0.38, selectedSideProbability: 0.62, confidence: 0.69,
  confidenceBreakdown: { base: 0.3, dataQuality: 0.24, sampleQuality: 0.22, uncertaintyPenalty: 0.06 },
  actionableAsk: 0.38, actionableBid: 0.37, feeRate: 0.016, netEdge: 0.228, spread: 0.01,
  secondsRemaining: 257.6, qualifyingSnapshots: 3, medianNetEdge: 0.09, factors: [],
};

describe('entry-decision-v2 is additive', () => {
  it('leaves a v1 row readable, with the new fields absent rather than defaulted', () => {
    // Absence must stay absence. The long-shot hold sentinel shipped a bug of exactly this shape, where a
    // field written from one date onward was read as "did not touch" for every earlier record.
    expect(v1.edgeSpike).toBeUndefined();
    expect(v1.cycleRegime).toBeUndefined();
    expect('edgeSpike' in v1).toBe(false);
  });

  it('carries a null spike distinctly from an unrecorded one', () => {
    // `edgeSpike` returns null when there is no persistence median to compare against. That is a measured
    // "no comparison available", not a missing field, and pooling the two would score v1 rows as null.
    const v2: EntryDecisionSnapshot = { ...v1, version: 'entry-decision-v2', edgeSpike: null };
    expect(v2.edgeSpike).toBeNull();
    expect('edgeSpike' in v2).toBe(true);
  });
});

/**
 * The structural guard. `edgeSpike` is already wired into the (currently disarmed) persistence ceiling
 * through `SignalPersistenceRequirements`, which is the supported path; what must not happen is a second,
 * unversioned path where an order's recorded observation feeds a decision.
 */
describe('the recorded observations are isolated from anything that can move money', () => {
  const forbidden = [
    'prediction-policy.ts', 'entry-execution-policy.ts', 'exit-policy.ts', 'target-exit-policy.ts',
    'portfolio-policy.ts', 'live-orders.ts', 'venue-fill.ts', 'live-risk-policy.ts',
    'switch-policy.ts', 'maker-retry-policy.ts', 'strategy-budget-policy.ts',
  ];

  it('is read by no module on a pricing, sizing, gating, or execution path', () => {
    for (const file of forbidden) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      const reads = /entryDecision(\?)?\.(edgeSpike|cycleRegime)/.test(source);
      expect({ file, reads }).toEqual({ file, reads: false });
    }
  });

  it('is written by the edge policy order builder and nowhere else', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib', 'paper-execution.ts'), 'utf8');
    expect(source.match(/version: 'entry-decision-v2'/g)).toHaveLength(1);
    expect(source).toContain('edgeSpike: eligibility.edgeSpike');
    expect(source).toContain('cycleRegime: prediction.cycleRegime ? { ...prediction.cycleRegime } : undefined');
  });

  it('clones the regime features rather than aliasing the prediction it came from', () => {
    // The snapshot is immutable issuance evidence. Sharing the object would let a later cycle mutate a
    // recorded decision, which is the one thing a decision snapshot exists to prevent.
    const source = readFileSync(path.join(process.cwd(), 'lib', 'paper-execution.ts'), 'utf8');
    expect(source).not.toContain('cycleRegime: prediction.cycleRegime,');
  });
});
