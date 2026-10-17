import { describe, expect, it } from 'vitest';
import {
  PAPER_GATE_RETENTION_CONTRACT,
  selectPaperGateRetainedHistory,
  type PaperGateDeclaredCoverage,
} from './domain/paper-gate-history.js';
import type { PaperGateRowScope } from './domain/paper-gate-row-codec.js';
import { PAPER_REGIME_SAMPLE_BUY_POLICY as policy } from './domain/paper-regime.js';

const scope: PaperGateRowScope = {
  generation_key: 'g',
  funding_id: 'f',
  epoch: 1,
  budget_id: 'actor:paper',
  generation_config_intent_id: 'C1',
  sample_policy: policy,
};
// Independent literal vectors: 900000000us is 00:15:00.000Z, 1800000000us is 00:30:00.000Z.
const WINDOW_A = '1970-01-01T00:15:00.000Z';
const WINDOW_B = '1970-01-01T00:30:00.000Z';
const candidate = (key: string, display: string, closes: string) => ({
  ...scope,
  candidate_key: key,
  candidate_id: display,
  issuance_run_id: 'issuance',
  source_kind: 'prospective-engine-run',
  symbol: 'BTC',
  venue: 'kalshi',
  contract_id: 'exact-ticker',
  side: 'UP',
  created_at_us: '0',
  closes_at_us: closes,
  selected_side_probability: '0.75',
  ask_price: '0.5',
  estimated_fee_rate: '0.0175',
  fee_model_version: 'historical-kalshi-continuous-taker-0.07-v1',
  predicted_net_edge: '0.2325',
  evidence_version: 'paper-regime-explicit-evidence-v1',
  qualification_receipt_id: 'qualification',
});
const outcome = (
  key: string,
  candidateKey: string,
  closes: string,
  resolved: string,
  recorded: string,
) => ({
  ...scope,
  outcome_key: key,
  candidate_key: candidateKey,
  closes_at_us: closes,
  contract_id: 'exact-ticker',
  side: 'UP',
  resolution_run_id: 'resolution',
  current_effect_config_intent_id: 'C2',
  source_kind: 'prospective-engine-run',
  evidence_version: 'paper-regime-explicit-evidence-v1',
  resolution_receipt_id: 'resolution-receipt',
  winner: 'UP',
  // 1 - ask(0.5) - fee(0.0175); exact source binary64 spelling, not recomputed here.
  realized_edge: '0.4825',
  resolved_at_us: resolved,
  recorded_at_us: recorded,
});
const candA = candidate('cand-a', 'disp-a', '900000000');
const outA = outcome('out-a', 'cand-a', '900000000', '900001000', '900001001');
const candB = candidate('cand-b', 'disp-b', '1800000000');
const outB = outcome('out-b', 'cand-b', '1800000000', '1800001000', '1800001002');
const CUTOFF = '1800002000';
const OBSERVED = '1970-01-01T00:30:01.000Z';
const cover = (...windows: string[]): PaperGateDeclaredCoverage => ({
  retention: PAPER_GATE_RETENTION_CONTRACT,
  resolvedWindows: windows,
});
const select = (
  entries: unknown,
  coverage: unknown = cover(WINDOW_A, WINDOW_B),
  observed: unknown = OBSERVED,
  cutoff: unknown = CUTOFF,
) => selectPaperGateRetainedHistory(entries, scope, cutoff, observed, coverage);
const pair = (c: unknown, o: unknown) => ({ candidate: c, outcome: o });
const observationA = {
  id: 'disp-a',
  policyVersion: policy,
  closesAt: WINDOW_A,
  resolvedAt: '1970-01-01T00:15:00.001Z',
  realizedEdge: 0.4825,
};
const observationB = {
  id: 'disp-b',
  policyVersion: policy,
  closesAt: WINDOW_B,
  resolvedAt: '1970-01-01T00:30:00.001Z',
  realizedEdge: 0.4825,
};

describe('persisted gate retained-history selection, chronology and declared coverage', () => {
  it('orders by original source chronology rather than the given read order', () => {
    // Deliberately reverse-chronological input: the adapter, not the caller, orders.
    expect(select([pair(candB, outB), pair(candA, outA)])).toEqual({
      kind: 'selected',
      retention: PAPER_GATE_RETENTION_CONTRACT,
      completeness: 'declared-not-proved',
      observations: [observationA, observationB],
      selectedCandidateKeys: ['cand-a', 'cand-b'],
      supersededCandidateKeys: [],
      unresolvedCandidateKeys: [],
      unresolvedCause: 'unknown',
      selectedMaxRecordedAtMicroseconds: 1800001002n,
    });
  });

  it('refuses two distinct candidates for one window instead of ranking them', () => {
    // 0006 declares UNIQUE (generation_key, sample_policy, closes_at) and the scope pins
    // both columns, so this input cannot come from a scoped read of that table.
    const second = candidate('cand-a2', 'disp-a2', '900000000');
    const secondOutcome = outcome('out-a2', 'cand-a2', '900000000', '900001000', '900001003');
    const refusal = { kind: 'malformed', reason: 'duplicate-window-candidate', rowIndex: 1 };
    // Both permutations refuse at the second row: no caller read order picks a winner.
    expect(select([pair(candA, outA), pair(second, secondOutcome)], cover(WINDOW_A))).toEqual(
      refusal,
    );
    expect(select([pair(second, secondOutcome), pair(candA, outA)], cover(WINDOW_A))).toEqual(
      refusal,
    );
    // Every resolved/unresolved combination for one window refuses the same way, so a
    // missing outcome cannot hide a schema-impossible second candidate.
    expect(select([pair(candA, outA), pair(second, null)], cover(WINDOW_A))).toEqual(refusal);
    expect(select([pair(candA, null), pair(second, secondOutcome)], cover(WINDOW_A))).toEqual(
      refusal,
    );
    expect(select([pair(candA, null), pair(second, null)], cover())).toEqual(refusal);
    // A legitimate single unresolved candidate in its own window is still accepted.
    const open = select([pair(candA, null), pair(candB, outB)], cover(WINDOW_B));
    expect(open.kind).toBe('selected');
    if (open.kind === 'selected') {
      expect(open.unresolvedCandidateKeys).toEqual(['cand-a']);
      expect(open.selectedCandidateKeys).toEqual(['cand-b']);
      expect(open.supersededCandidateKeys).toEqual([]);
    }
  });

  it('reports a repeated primary key as a duplicate row, not a window contest', () => {
    // Precedence: the identical row is a caller duplicate; only DISTINCT keys in one
    // window are the schema contradiction.
    expect(select([pair(candA, outA), pair(candA, outA)], cover(WINDOW_A))).toEqual({
      kind: 'malformed',
      reason: 'duplicate-candidate-key',
      rowIndex: 1,
    });
    expect(select([pair(candA, null), pair(candA, null)], cover())).toEqual({
      kind: 'malformed',
      reason: 'duplicate-candidate-key',
      rowIndex: 1,
    });
    // A row from another generation is the decoder's scope refusal, never a window
    // contest: cross-scope rows never reach the uniqueness check.
    const foreign = { ...candidate('cand-x', 'disp-x', '900000000'), generation_key: 'other' };
    expect(select([pair(candA, outA), pair(foreign, null)], cover(WINDOW_A))).toEqual({
      kind: 'malformed',
      reason: 'row',
      rowIndex: 1,
    });
  });

  it('applies the observed guard and display-id check to every resolved row', () => {
    // There is no superseded branch left that could skip either guard.
    // Resolved 1ms after the declared source instant while its recorded clock stays at
    // or before a DB cutoff that admits it: the source guard fires on its own, proving
    // the two clocks are independent rather than one standing in for the other.
    const lateWindowB = outcome('out-b-late', 'cand-b', '1800000000', '1801001000', '1801002000');
    expect(
      select(
        [pair(candA, outA), pair(candB, lateWindowB)],
        cover(WINDOW_A, WINDOW_B),
        OBSERVED,
        '1801002000',
      ),
    ).toEqual({ kind: 'malformed', reason: 'observed-time-bound', rowIndex: 1 });
    const clash = candidate('cand-b2', 'disp-a', '1800000000');
    const clashOutcome = outcome('out-b2', 'cand-b2', '1800000000', '1800001000', '1800001002');
    expect(select([pair(candA, outA), pair(clash, clashOutcome)])).toEqual({
      kind: 'malformed',
      reason: 'duplicate-display-id',
      rowIndex: 1,
    });
  });

  it('retains an absent outcome as unknown cause, never zero-neutral or pending', () => {
    const open = select([pair(candA, null)], cover());
    expect(open).toEqual({
      kind: 'selected',
      retention: PAPER_GATE_RETENTION_CONTRACT,
      completeness: 'declared-not-proved',
      observations: [],
      selectedCandidateKeys: [],
      supersededCandidateKeys: [],
      unresolvedCandidateKeys: ['cand-a'],
      unresolvedCause: 'unknown',
      selectedMaxRecordedAtMicroseconds: null,
    });
    // Declaring that same window resolved is a gap with unknown cause, not a 0 edge.
    expect(select([pair(candA, null)], cover(WINDOW_A))).toEqual({
      kind: 'unavailable',
      reason: 'declared-resolved-window-missing',
      missingWindows: [WINDOW_A],
    });
    // A declared window with no row at all is equally a gap, never an empty success.
    expect(select([pair(candA, outA)], cover(WINDOW_A, WINDOW_B))).toEqual({
      kind: 'unavailable',
      reason: 'declared-resolved-window-missing',
      missingWindows: [WINDOW_B],
    });
  });

  it('never emits a completeness boolean or regime evidence', () => {
    const result = select([pair(candA, outA), pair(candB, outB)]);
    expect(result.kind).toBe('selected');
    if (result.kind !== 'selected') return;
    expect(Object.hasOwn(result, 'complete')).toBe(false);
    expect(Object.hasOwn(result, 'observedAtMs')).toBe(false);
    expect(Object.hasOwn(result, 'sourceId')).toBe(false);
    expect(result.completeness).toBe('declared-not-proved');
    // Shape is directly acceptable to the regime observation rules: unique ids and
    // unique aligned windows, resolved at or before the declared source instant.
    expect(new Set(result.observations.map((o) => o.id)).size).toBe(result.observations.length);
    expect(new Set(result.observations.map((o) => o.closesAt)).size).toBe(
      result.observations.length,
    );
    for (const o of result.observations) {
      expect(Date.parse(o.closesAt) % 900000).toBe(0);
      expect(Date.parse(o.resolvedAt)).toBeLessThanOrEqual(Date.parse(OBSERVED));
      expect(o.policyVersion).toBe(policy);
    }
  });

  it('refuses missing, contradictory or unaligned declared coverage', () => {
    const rows = [pair(candA, outA), pair(candB, outB)];
    // Called directly: a default parameter would mask an `undefined` argument.
    const withCoverage = (coverage: unknown) =>
      selectPaperGateRetainedHistory(rows, scope, CUTOFF, OBSERVED, coverage);
    for (const bad of [
      undefined,
      null,
      {},
      [],
      { retention: 'other', resolvedWindows: [] },
      { retention: PAPER_GATE_RETENTION_CONTRACT },
      { retention: PAPER_GATE_RETENTION_CONTRACT, resolvedWindows: {} },
      { retention: PAPER_GATE_RETENTION_CONTRACT, resolvedWindows: [WINDOW_A, WINDOW_A] },
      { retention: PAPER_GATE_RETENTION_CONTRACT, resolvedWindows: ['1970-01-01T00:16:00.000Z'] },
      { retention: PAPER_GATE_RETENTION_CONTRACT, resolvedWindows: ['1970-01-01T00:15:00Z'] },
      { retention: PAPER_GATE_RETENTION_CONTRACT, resolvedWindows: [900000000] },
      { retention: PAPER_GATE_RETENTION_CONTRACT, resolvedWindows: [], extra: true },
    ])
      expect(withCoverage(bad)).toEqual({ kind: 'malformed', reason: 'coverage', rowIndex: null });
    // A selected window the declaration omits is a wrong declaration, not a gap.
    expect(select(rows, cover(WINDOW_A))).toEqual({
      kind: 'malformed',
      reason: 'coverage-mismatch',
      rowIndex: null,
    });
  });

  it('keeps the source observed guard separate from the database cutoff', () => {
    // Called directly: a default parameter would mask an `undefined` argument.
    const withObserved = (observed: unknown) =>
      selectPaperGateRetainedHistory([pair(candA, outA)], scope, CUTOFF, observed, cover(WINDOW_A));
    const withCutoff = (cutoff: unknown) =>
      selectPaperGateRetainedHistory([pair(candA, outA)], scope, cutoff, OBSERVED, cover(WINDOW_A));
    for (const bad of [undefined, null, '', 'not-a-time', '1970-01-01T00:30:01Z', 1800001000])
      expect(withObserved(bad)).toEqual({
        kind: 'malformed',
        reason: 'observed-time',
        rowIndex: null,
      });
    // Source resolution after the declared source instant contradicts the snapshot.
    expect(
      select([pair(candA, outA), pair(candB, outB)], cover(WINDOW_A, WINDOW_B), WINDOW_B),
    ).toEqual({ kind: 'malformed', reason: 'observed-time-bound', rowIndex: 1 });
    // The DB cutoff is a different clock: an exceeded record clock is the decoder's row refusal.
    expect(select([pair(candA, outA)], cover(WINDOW_A), OBSERVED, '900001000')).toEqual({
      kind: 'malformed',
      reason: 'row',
      rowIndex: 0,
    });
    for (const bad of [undefined, null, '', '900001001.0', 900001001])
      expect(withCutoff(bad)).toEqual({ kind: 'malformed', reason: 'cutoff', rowIndex: null });
  });

  it('validates cutoff and scope before any row, including for an empty list', () => {
    const emptyCutoff = (cutoff: unknown) =>
      selectPaperGateRetainedHistory([], scope, cutoff, OBSERVED, cover());
    const emptyScope = (badScope: unknown) =>
      selectPaperGateRetainedHistory([], badScope as PaperGateRowScope, CUTOFF, OBSERVED, cover());
    // An empty list previously reported an invalid cutoff or scope as a success.
    for (const bad of [
      undefined,
      null,
      '',
      ' 900001001',
      '900001001 ',
      '+900001001',
      '0900001001',
      '1.5',
      '1e3',
      900001001,
      900001001n,
      '8640000000000000001',
      '-8640000000000000001',
      '99999999999999999999',
    ])
      expect(emptyCutoff(bad)).toEqual({ kind: 'malformed', reason: 'cutoff', rowIndex: null });
    for (const bad of [
      undefined,
      null,
      {},
      [],
      'scope',
      { ...scope, extra: true },
      { ...scope, epoch: 0 },
      { ...scope, epoch: 1.5 },
      { ...scope, epoch: 2147483648 },
      { ...scope, epoch: '1' },
      { ...scope, sample_policy: 'other' },
      { ...scope, funding_id: '' },
      { ...scope, funding_id: ' f ' },
      { ...scope, budget_id: 'b'.repeat(121) },
      { ...scope, generation_key: 42 },
    ])
      expect(emptyScope(bad)).toEqual({ kind: 'malformed', reason: 'scope', rowIndex: null });
    // Non-empty lists refuse identically, before the first row is decoded.
    expect(
      selectPaperGateRetainedHistory(
        [pair(candA, outA)],
        { ...scope, epoch: 0 } as unknown as PaperGateRowScope,
        CUTOFF,
        OBSERVED,
        cover(WINDOW_A),
      ),
    ).toEqual({ kind: 'malformed', reason: 'scope', rowIndex: null });
    // The decoder's existing legal cutoff domain is unchanged: canonical signed integer
    // TEXT including zero, negatives and both exact bigint boundaries stays accepted.
    for (const good of ['0', '-1', '-8640000000000000000', '8640000000000000000'])
      expect(emptyCutoff(good)).toEqual({
        kind: 'selected',
        retention: PAPER_GATE_RETENTION_CONTRACT,
        completeness: 'declared-not-proved',
        observations: [],
        selectedCandidateKeys: [],
        supersededCandidateKeys: [],
        unresolvedCandidateKeys: [],
        unresolvedCause: 'unknown',
        selectedMaxRecordedAtMicroseconds: null,
      });
    // A valid scope and cutoff with nothing to read is an empty selection, which is NOT
    // warming, an initialized generation or proof that no history exists.
    expect(emptyScope(scope).kind).toBe('selected');
  });

  it('refuses malformed entry lists and undecodable rows', () => {
    for (const bad of [undefined, null, {}, 'rows', 0])
      expect(select(bad)).toEqual({ kind: 'malformed', reason: 'entries', rowIndex: null });
    for (const bad of [
      null,
      [],
      'row',
      { candidate: candA },
      { candidate: candA, outcome: outA, extra: 1 },
    ])
      expect(select([bad], cover(WINDOW_A))).toEqual({
        kind: 'malformed',
        reason: 'entries',
        rowIndex: 0,
      });
    expect(select([pair(candA, outA), pair({ ...candB, venue: 'polymarket' }, outB)])).toEqual({
      kind: 'malformed',
      reason: 'row',
      rowIndex: 1,
    });
    // `undefined` outcome is the decoder's error, distinct from a valid-only absent row.
    expect(select([pair(candA, undefined)], cover(WINDOW_A))).toEqual({
      kind: 'malformed',
      reason: 'row',
      rowIndex: 0,
    });
  });

  it('refuses more rows or declared windows than the regime contract accepts', () => {
    const many = Array.from({ length: 5001 }, () => pair(candA, outA));
    expect(select(many, cover(WINDOW_A))).toEqual({
      kind: 'malformed',
      reason: 'entries',
      rowIndex: null,
    });
    const windows = Array.from({ length: 5001 }, (_unused, index) =>
      new Date(900000 * (index + 1)).toISOString(),
    );
    expect(select([pair(candA, outA)], cover(...windows))).toEqual({
      kind: 'malformed',
      reason: 'coverage',
      rowIndex: null,
    });
  });
});
