import { describe, expect, it } from 'vitest';
import {
  PAPER_GATE_COVERAGE_PROTOCOL,
  PAPER_GATE_UNIVERSE_LIMIT,
  verifyPaperGateCoverage,
  type PaperGateCoverageFence,
  type PaperGateCoverageSnapshot,
} from './domain/paper-gate-coverage.js';
import type { PaperGateRowScope } from './domain/paper-gate-row-codec.js';
import {
  PAPER_HISTORICAL_REGIME_CONTRACT,
  PAPER_REGIME_SAMPLE_BUY_POLICY as policy,
  REGIME_GATE_POLICY_VERSION,
} from './domain/paper-regime.js';

const scope: PaperGateRowScope = {
  generation_key: 'gen',
  funding_id: 'fund',
  epoch: 1,
  budget_id: 'actor:paper',
  generation_config_intent_id: 'C1',
  sample_policy: policy,
};
const fence: PaperGateCoverageFence = {
  capability: 'budget:paper',
  owner: 'run-now',
  fencingToken: 4n,
};
// Independent literal microsecond vectors: 02:00:00Z, 02:15:00Z, 02:15:02Z,
// 02:30:00Z, 02:30:01Z, 02:30:02Z on 2026-10-12, then 2030-01-01T00:00:00Z.
const CREATED = '1791770400000000';
const WINDOW_A = '1791771300000000';
const RESOLVED_A = '1791771302000000';
const WINDOW_B = '1791772200000000';
const OBSERVED = '1791772201000000';
const CUTOFF = '1791772202000000';
const WINDOW_PENDING = '1893456000000000';
const WINDOW_A_ISO = '2026-10-12T02:15:00.000Z';
const WINDOW_PENDING_ISO = '2030-01-01T00:00:00.000Z';

const generation = () => ({
  ...scope,
  actor: 'actor',
  source_kind: 'prospective-engine-run',
  gate_formula: REGIME_GATE_POLICY_VERSION,
  bundle_id: PAPER_HISTORICAL_REGIME_CONTRACT,
  settings_descriptor: 'regime-settings-v1:true:4:2.5:0.99:0.75',
  enabled: true,
  initialization_run_id: 'run-genesis',
});
const head = () => ({
  ...scope,
  latest_event_key: 'event-7',
  revision: '7',
  event_kind: 'evaluated',
  projected_phase: 'open',
});
const event = () => ({
  ...scope,
  event_key: 'event-7',
  event_kind: 'evaluated',
  revision_after: '7',
  prior_event_key: 'event-6',
  revision_before: '6',
  previous_phase: 'warming',
  result_phase: 'open',
  projected_phase: 'open',
  current_effect_config_intent_id: 'C2',
  latest_intent_id: 'I9',
  run_id: 'run-7',
  source_kind: 'prospective-engine-run',
  evidence_version: 'paper-regime-explicit-evidence-v1',
  coverage_receipt_id: 'receipt-7',
  evidence_observed_at_us: OBSERVED,
  coverage_cutoff_at_us: CUTOFF,
  recorded_at_us: CUTOFF,
  captured_candidate_count: '3',
  captured_resolved_count: '2',
  captured_unresolved_count: '1',
  input_count: '2',
  universe_first_closes_at_us: WINDOW_A,
  universe_last_closes_at_us: WINDOW_PENDING,
});
const universeRow = (key: string, window: string, recorded: string | null) => ({
  candidate_key: key,
  closes_at_us: window,
  created_at_us: CREATED,
  outcome_recorded_at_us: recorded,
});
const universe = () => [
  universeRow('cand-a', WINDOW_A, RESOLVED_A),
  universeRow('cand-b', WINDOW_B, CUTOFF),
  universeRow('cand-pending', WINDOW_PENDING, null),
];
const inputRow = (ordinal: string, key: string) => ({
  ...scope,
  event_key: 'event-7',
  ordinal,
  candidate_key: key,
});
const inputs = () => [inputRow('0', 'cand-a'), inputRow('1', 'cand-b')];

const snapshot = (patch: Partial<PaperGateCoverageSnapshot> = {}): PaperGateCoverageSnapshot => ({
  leaseHeld: true,
  leaseStillHeld: true,
  generation: generation(),
  rootsPresent: { funding: true, budget: true },
  head: head(),
  event: event(),
  inputs: inputs(),
  universe: universe(),
  newestControlIntentId: 'I9',
  newestControlIntentValid: true,
  ...patch,
});
const verify = (patch: Partial<PaperGateCoverageSnapshot> = {}) =>
  verifyPaperGateCoverage(snapshot(patch), scope, fence);
const refusal = (reason: string, detail: string | null) => ({
  kind: 'refused',
  reason,
  detail,
});

describe('persisted gate coverage receipt verification', () => {
  it('verifies a non-empty receipt against the independently enumerated universe', () => {
    const result = verify();
    expect(result.kind).toBe('verified');
    if (result.kind !== 'verified') return;
    expect(result.receipt).toEqual({
      protocol: PAPER_GATE_COVERAGE_PROTOCOL,
      scope,
      headEventKey: 'event-7',
      headRevision: 7n,
      eventKind: 'evaluated',
      projectedPhase: 'open',
      coverageReceiptId: 'receipt-7',
      coverageCutoffMicroseconds: 1791772202000000n,
      recordedAtMicroseconds: 1791772202000000n,
      evidenceObservedAtIso: '2026-10-12T02:30:01.000Z',
      lineage: { kind: 'persisted', stateRunId: 'run-7', revision: 7 },
      universeCandidateKeys: ['cand-a', 'cand-b', 'cand-pending'],
      resolvedCandidateKeys: ['cand-a', 'cand-b'],
      unresolvedCandidateKeys: ['cand-pending'],
      unresolvedCause: 'unknown',
      universeFirstWindowIso: WINDOW_A_ISO,
      universeLastWindowIso: WINDOW_PENDING_ISO,
      recordedLatestIntentStillNewest: true,
      fence,
      validity: 'single-transaction-snapshot-only',
      completeness: 'persisted-universe-in-this-snapshot-only',
      replayCompareAndSet: 'not-proved',
    });
  });

  it('keeps a valid-only missing outcome unresolved with unknown cause', () => {
    // An outcome recorded AFTER the receipt cutoff is not resolved for this receipt,
    // and is never a zero, pending or invalid sample.
    const late = [
      universeRow('cand-a', WINDOW_A, RESOLVED_A),
      universeRow('cand-b', WINDOW_B, '1791772203000000'),
      universeRow('cand-pending', WINDOW_PENDING, null),
    ];
    expect(
      verify({
        universe: late,
        event: {
          ...event(),
          captured_resolved_count: '1',
          captured_unresolved_count: '2',
          input_count: '1',
        },
        inputs: [inputRow('0', 'cand-a')],
      }),
    ).toMatchObject({ kind: 'verified' });
    const result = verify({
      universe: late,
      event: {
        ...event(),
        captured_resolved_count: '1',
        captured_unresolved_count: '2',
        input_count: '1',
      },
      inputs: [inputRow('0', 'cand-a')],
    });
    if (result.kind !== 'verified') return;
    expect(result.receipt.unresolvedCandidateKeys).toEqual(['cand-b', 'cand-pending']);
    expect(result.receipt.unresolvedCause).toBe('unknown');
  });

  it('derives an empty initialized lineage only from a constrained genesis row', () => {
    const genesis = {
      ...event(),
      event_key: 'event-0',
      event_kind: 'genesis',
      revision_after: '0',
      prior_event_key: null,
      revision_before: null,
      previous_phase: null,
      result_phase: null,
      projected_phase: 'warming',
      run_id: 'run-genesis',
      captured_candidate_count: '0',
      captured_resolved_count: '0',
      captured_unresolved_count: '0',
      input_count: '0',
      universe_first_closes_at_us: null,
      universe_last_closes_at_us: null,
    };
    const result = verify({
      head: {
        ...head(),
        latest_event_key: 'event-0',
        revision: '0',
        event_kind: 'genesis',
        projected_phase: 'warming',
      },
      event: genesis,
      inputs: [],
      universe: [],
    });
    expect(result.kind).toBe('verified');
    if (result.kind !== 'verified') return;
    expect(result.receipt.lineage).toEqual({
      kind: 'initialized',
      initializationRunId: 'run-genesis',
      priorGenerationState: 'none',
      revision: 0,
    });
    expect(result.receipt.universeFirstWindowIso).toBeNull();
    expect(result.receipt.universeLastWindowIso).toBeNull();
    expect(result.receipt.headRevision).toBe(0n);
    // An empty universe with NO head or event is refused, never a fabricated genesis.
    expect(verify({ head: null, event: null, inputs: [], universe: [] })).toEqual(
      refusal('head', 'missing'),
    );
    expect(verify({ event: null, inputs: [], universe: [] })).toEqual(refusal('event', 'missing'));
    // A genesis row that contradicts its own protocol is refused.
    for (const patch of [
      { revision_after: '1' },
      { projected_phase: 'open' },
      { prior_event_key: 'event-x' },
      { revision_before: '0' },
      { previous_phase: 'warming' },
      { result_phase: 'warming' },
    ])
      expect(
        verify({
          head: {
            ...head(),
            latest_event_key: 'event-0',
            revision: '0',
            event_kind: 'genesis',
            projected_phase: 'warming',
          },
          event: { ...genesis, ...patch },
          inputs: [],
          universe: [],
        }).kind,
      ).toBe('refused');
  });

  it('refuses when the lease is not held at the start or lost at the final boundary', () => {
    expect(verify({ leaseHeld: false })).toEqual(refusal('lease-not-held', null));
    expect(verify({ leaseStillHeld: false })).toEqual(refusal('lease-lost', 'final-boundary'));
    // The fence identity itself must be well formed and a real token.
    for (const bad of [
      { ...fence, capability: '' },
      { ...fence, owner: ' padded ' },
      { ...fence, fencingToken: 0n },
      { ...fence, fencingToken: 4 as unknown as bigint },
    ])
      expect(verifyPaperGateCoverage(snapshot(), scope, bad)).toEqual(refusal('scope', 'fence'));
  });

  it('refuses a wrong generation, config, epoch, budget, funding or policy', () => {
    for (const key of [
      'generation_key',
      'funding_id',
      'budget_id',
      'generation_config_intent_id',
    ] as const)
      expect(verify({ generation: { ...generation(), [key]: 'other' } })).toEqual(
        refusal('generation', 'namespace'),
      );
    expect(verify({ generation: { ...generation(), epoch: 2 } })).toEqual(
      refusal('generation', 'namespace'),
    );
    expect(verify({ generation: { ...generation(), sample_policy: 'other' } })).toEqual(
      refusal('generation', 'namespace'),
    );
    for (const patch of [
      { gate_formula: 'other' },
      { bundle_id: 'other' },
      { source_kind: 'restored' },
      { actor: '' },
      { budget_id: 'actor:paper', actor: 'different' },
      { settings_descriptor: '' },
    ])
      expect(verify({ generation: { ...generation(), ...patch } }).kind).toBe('refused');
    expect(verify({ generation: null })).toEqual(refusal('generation', 'missing'));
    // Scope identity is also required of the head, the event and every input row.
    expect(verify({ head: { ...head(), epoch: 2 } })).toEqual(refusal('head', 'namespace'));
    expect(verify({ event: { ...event(), epoch: 2 } })).toEqual(refusal('event', 'namespace'));
    expect(
      verify({ inputs: [{ ...inputRow('0', 'cand-a'), epoch: 2 }, inputRow('1', 'cand-b')] }),
    ).toEqual(refusal('input-mismatch', 'binding'));
  });

  it('refuses a missing funding or budget root', () => {
    expect(verify({ rootsPresent: { funding: false, budget: true } })).toEqual(
      refusal('root', 'funding-or-budget-root-absent'),
    );
    expect(verify({ rootsPresent: { funding: true, budget: false } })).toEqual(
      refusal('root', 'funding-or-budget-root-absent'),
    );
    expect(verify({ rootsPresent: null })).toEqual(
      refusal('root', 'funding-or-budget-root-absent'),
    );
  });

  it('refuses a head and event that disagree', () => {
    for (const patch of [
      { event_key: 'event-other' },
      { revision_after: '6' },
      { event_kind: 'genesis' },
      { projected_phase: 'closed' },
    ])
      expect(verify({ event: { ...event(), ...patch } })).toEqual(
        refusal('event', 'head-pointer-disagreement'),
      );
    expect(verify({ head: { ...head(), revision: 'x' } })).toEqual(refusal('head', 'pointer'));
    expect(verify({ head: { ...head(), latest_event_key: '' } })).toEqual(
      refusal('head', 'pointer'),
    );
  });

  it('refuses malformed event clocks and keeps full microsecond precision', () => {
    for (const patch of [
      { coverage_cutoff_at_us: undefined },
      { coverage_cutoff_at_us: '1.5' },
      { recorded_at_us: null },
      { evidence_observed_at_us: '1791772201000001' },
    ])
      expect(verify({ event: { ...event(), ...patch } })).toEqual(
        refusal('event-clock', 'undecodable'),
      );
    // recorded_at must not precede either the observed instant or the cutoff.
    expect(verify({ event: { ...event(), recorded_at_us: OBSERVED } })).toEqual(
      refusal('event-clock', 'ordering'),
    );
    // One microsecond below the resolved clock moves that candidate out of resolved.
    const boundary = verify({
      event: {
        ...event(),
        coverage_cutoff_at_us: '1791772201999999',
        recorded_at_us: '1791772201999999',
        captured_resolved_count: '1',
        captured_unresolved_count: '2',
        input_count: '1',
      },
      inputs: [inputRow('0', 'cand-a')],
    });
    expect(boundary.kind).toBe('verified');
    if (boundary.kind === 'verified')
      expect(boundary.receipt.coverageCutoffMicroseconds).toBe(1791772201999999n);
    // One microsecond above keeps it resolved, so the boundary is exact. `recorded_at`
    // moves with it because the schema forbids recorded_at < coverage_cutoff_at.
    expect(
      verify({
        event: {
          ...event(),
          coverage_cutoff_at_us: '1791772202000001',
          recorded_at_us: '1791772202000001',
        },
      }).kind,
    ).toBe('verified');
  });

  it('refuses when the persisted counts disagree with the enumerated universe', () => {
    for (const patch of [
      { captured_candidate_count: '2', captured_unresolved_count: '0', input_count: '2' },
      { captured_resolved_count: '3', captured_unresolved_count: '0', input_count: '3' },
    ])
      expect(verify({ event: { ...event(), ...patch } }).kind).toBe('refused');
    // A candidate the receipt never captured is drift, not a silently larger universe.
    expect(
      verify({ universe: [...universe(), universeRow('cand-extra', WINDOW_B, null)] }),
    ).toEqual(refusal('universe-drift', 'captured-counts-disagree'));
    // Internally inconsistent captured counts are refused before enumeration.
    expect(verify({ event: { ...event(), captured_resolved_count: '1' } })).toEqual(
      refusal('event', 'captured-counts'),
    );
    // Claimed universe bounds must equal the enumerated first and last windows.
    expect(verify({ event: { ...event(), universe_first_closes_at_us: WINDOW_B } })).toEqual(
      refusal('universe-drift', 'universe-bounds-disagree'),
    );
    expect(
      verify({
        event: {
          ...event(),
          captured_candidate_count: '0',
          captured_resolved_count: '0',
          captured_unresolved_count: '0',
          input_count: '0',
        },
        inputs: [],
        universe: [],
      }),
    ).toEqual(refusal('universe-drift', 'empty-universe-bounds'));
  });

  it('refuses duplicate, malformed or over-bound universe rows', () => {
    expect(
      verify({
        universe: [
          universeRow('cand-a', WINDOW_A, RESOLVED_A),
          universeRow('cand-a', WINDOW_B, null),
        ],
      }),
    ).toEqual(refusal('universe-drift', 'duplicate-candidate-key'));
    expect(verify({ universe: [{ candidate_key: 'x' }] })).toEqual(
      refusal('universe-drift', 'row-values'),
    );
    expect(verify({ universe: ['row'] })).toEqual(refusal('universe-drift', 'row-shape'));
    expect(verify({ universe: [{ ...universeRow('cand-a', WINDOW_A, '1.5') }] })).toEqual(
      refusal('universe-drift', 'outcome-clock'),
    );
    // One row past the schema ceiling fails closed rather than truncating.
    const over = Array.from({ length: PAPER_GATE_UNIVERSE_LIMIT + 1 }, (_u, i) =>
      universeRow('cand-' + i, WINDOW_A, null),
    );
    expect(verify({ universe: over })).toEqual(
      refusal('universe-overflow', 'above-schema-ceiling'),
    );
    expect(verify({ universe: 'rows' as unknown as readonly unknown[] })).toEqual(
      refusal('universe-overflow', 'not-enumerated'),
    );
  });

  it('refuses an input set that is not exactly the resolved universe', () => {
    expect(verify({ inputs: [inputRow('0', 'cand-a')] })).toEqual(
      refusal('input-mismatch', 'count'),
    );
    expect(verify({ inputs: [inputRow('0', 'cand-a'), inputRow('0', 'cand-b')] })).toEqual(
      refusal('input-mismatch', 'duplicate'),
    );
    expect(verify({ inputs: [inputRow('0', 'cand-a'), inputRow('2', 'cand-b')] })).toEqual(
      refusal('input-mismatch', 'row-values'),
    );
    // Citing an unresolved candidate instead of a resolved one is refused.
    expect(verify({ inputs: [inputRow('0', 'cand-a'), inputRow('1', 'cand-pending')] })).toEqual(
      refusal('input-mismatch', 'resolved-set-disagree'),
    );
    expect(
      verify({
        inputs: [inputRow('0', 'cand-a'), { ...inputRow('1', 'cand-b'), event_key: 'other' }],
      }),
    ).toEqual(refusal('input-mismatch', 'binding'));
    expect(verify({ inputs: 'rows' as unknown as readonly unknown[] })).toEqual(
      refusal('input-mismatch', 'not-enumerated'),
    );
  });

  it('refuses a malformed or absent newest control row and never claims authority', () => {
    expect(verify({ newestControlIntentValid: false })).toEqual(refusal('control-malformed', null));
    expect(verify({ newestControlIntentId: null })).toEqual(
      refusal('control-malformed', 'newest-id'),
    );
    // A newer intent than the one the event recorded is reported as a snapshot fact,
    // never as current admission or control authority.
    const moved = verify({ newestControlIntentId: 'I10' });
    expect(moved.kind).toBe('verified');
    if (moved.kind === 'verified') {
      expect(moved.receipt.recordedLatestIntentStillNewest).toBe(false);
      expect(moved.receipt.completeness).toBe('persisted-universe-in-this-snapshot-only');
      expect(moved.receipt.replayCompareAndSet).toBe('not-proved');
    }
  });

  it('binds a genesis lineage to the generation own initialization run', () => {
    const genesisHead = {
      ...head(),
      latest_event_key: 'event-0',
      revision: '0',
      event_kind: 'genesis',
      projected_phase: 'warming',
    };
    const genesisEvent = {
      ...event(),
      event_key: 'event-0',
      event_kind: 'genesis',
      revision_after: '0',
      prior_event_key: null,
      revision_before: null,
      previous_phase: null,
      result_phase: null,
      projected_phase: 'warming',
      run_id: 'run-genesis',
      captured_candidate_count: '0',
      captured_resolved_count: '0',
      captured_unresolved_count: '0',
      input_count: '0',
      universe_first_closes_at_us: null,
      universe_last_closes_at_us: null,
    };
    const base = { head: genesisHead, event: genesisEvent, inputs: [], universe: [] };
    expect(verify(base).kind).toBe('verified');
    // A genesis-shaped row written by some OTHER run is refused.
    expect(verify({ ...base, event: { ...genesisEvent, run_id: 'run-other' } })).toEqual(
      refusal('lineage', 'genesis-run-binding'),
    );
    expect(
      verify({ ...base, generation: { ...generation(), initialization_run_id: 'run-other' } }),
    ).toEqual(refusal('lineage', 'genesis-run-binding'));
    expect(verify({ ...base, generation: { ...generation(), initialization_run_id: '' } })).toEqual(
      refusal('lineage', 'genesis-run-binding'),
    );
    // An EVALUATED event may legitimately carry a different write run.
    const evaluated = verify({ event: { ...event(), run_id: 'run-later-writer' } });
    expect(evaluated.kind).toBe('verified');
    if (evaluated.kind === 'verified')
      expect(evaluated.receipt.lineage).toEqual({
        kind: 'persisted',
        stateRunId: 'run-later-writer',
        revision: 7,
      });
  });

  it('scopes the universe by created_at against the receipt cutoff', () => {
    // POSITIVE: a candidate created AFTER the cutoff is outside this receipt's universe,
    // so an older attestation stays verified with its own appropriately scoped universe.
    const later = universeRow('cand-later', WINDOW_B, null);
    later.created_at_us = '1791772202000001';
    const scoped = verify({ universe: [...universe(), later] });
    expect(scoped.kind).toBe('verified');
    if (scoped.kind === 'verified') {
      expect(scoped.receipt.universeCandidateKeys).toEqual(['cand-a', 'cand-b', 'cand-pending']);
      expect(scoped.receipt.universeCandidateKeys).not.toContain('cand-later');
    }
    // NEGATIVE: a candidate created AT the cutoff that the receipt never captured is
    // inside the universe and therefore drift.
    const backdated = universeRow('cand-backdated', WINDOW_B, null);
    backdated.created_at_us = '1791772202000000';
    expect(verify({ universe: [...universe(), backdated] })).toEqual(
      refusal('universe-drift', 'captured-counts-disagree'),
    );
    // An outcome recorded after the cutoff leaves its candidate unresolved, not absent.
    const postCutoff = universeRow('cand-post', WINDOW_B, '1791772202000001');
    postCutoff.created_at_us = CREATED;
    const mixed = verify({
      universe: [universe()[0], postCutoff],
      event: {
        ...event(),
        captured_candidate_count: '2',
        captured_resolved_count: '1',
        captured_unresolved_count: '1',
        input_count: '1',
        universe_last_closes_at_us: WINDOW_B,
      },
      inputs: [inputRow('0', 'cand-a')],
    });
    expect(mixed.kind).toBe('verified');
    if (mixed.kind === 'verified') {
      expect(mixed.receipt.resolvedCandidateKeys).toEqual(['cand-a']);
      expect(mixed.receipt.unresolvedCandidateKeys).toEqual(['cand-post']);
    }
  });

  it('refuses a malformed scope before reading anything', () => {
    for (const bad of [{}, null, { ...scope, epoch: 0 }, { ...scope, sample_policy: 'other' }])
      expect(
        verifyPaperGateCoverage(snapshot(), bad as unknown as PaperGateRowScope, fence),
      ).toEqual(refusal('scope', 'namespace'));
  });
});
