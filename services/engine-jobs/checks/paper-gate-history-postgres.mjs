// Read actual disposable persisted fixtures; no source collection, coverage truth or receipt truth.
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  PAPER_GATE_RETENTION_CONTRACT,
  selectPaperGateRetainedHistory,
} from '../dist/domain/paper-gate-history.js';
export async function paperGateHistoryPostgresContract(admin) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const generation = 'gate-generation';
  // Deliberately DESC by key, the reverse of source chronology for the resolved pair:
  // the adapter must order, and SQL ORDER BY/LIMIT must not be doing the selection.
  const rows = await admin.unsafe(
    "select (to_jsonb(c)-'created_at'-'closes_at') || jsonb_build_object('created_at_us',(extract(epoch from c.created_at)*1000000)::numeric(30,0)::text,'closes_at_us',(extract(epoch from c.closes_at)*1000000)::numeric(30,0)::text,'selected_side_probability',c.selected_side_probability::text,'ask_price',c.ask_price::text,'estimated_fee_rate',c.estimated_fee_rate::text,'predicted_net_edge',c.predicted_net_edge::text) as candidate, case when o.outcome_key is null then null else (to_jsonb(o)-'closes_at'-'resolved_at'-'recorded_at') || jsonb_build_object('closes_at_us',(extract(epoch from o.closes_at)*1000000)::numeric(30,0)::text,'resolved_at_us',(extract(epoch from o.resolved_at)*1000000)::numeric(30,0)::text,'recorded_at_us',(extract(epoch from o.recorded_at)*1000000)::numeric(30,0)::text,'realized_edge',o.realized_edge::text) end as outcome from engine.paper_gate_candidate c left join engine.paper_gate_outcome o on o.candidate_key=c.candidate_key where c.generation_key=$1::text order by c.candidate_key desc",
    [generation],
  );
  // Exact persisted set, so a future fixture candidate fails loudly instead of
  // silently changing what this declared coverage means.
  assert.deepEqual(
    rows.map((r) => r.candidate.candidate_key),
    ['phase-second-candidate', 'phase-pending-candidate', 'k'.repeat(120)],
  );
  const [bound] = await admin.unsafe(
    'select (extract(epoch from max(o.recorded_at))*1000000)::numeric(30,0)::text as cutoff from engine.paper_gate_outcome o join engine.paper_gate_candidate c on c.candidate_key=o.candidate_key where c.generation_key=$1::text',
    [generation],
  );
  // Independent literal fixture expectations, not a value derived from the same read:
  // the recorded bound and the sample policy are pinned here and the persisted rows must
  // match them, so a changed fixture cannot quietly redefine what is being asserted.
  const EXPECTED_CUTOFF = '1791772202000000';
  const EXPECTED_POLICY =
    'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
  const cutoff = bound.cutoff;
  assert.equal(cutoff, EXPECTED_CUTOFF);
  assert.equal(EXPECTED_CUTOFF, String(Date.parse('2026-10-12T02:30:02.000Z') * 1000));
  const scope = Object.fromEntries(
    [
      'generation_key',
      'funding_id',
      'epoch',
      'budget_id',
      'generation_config_intent_id',
      'sample_policy',
    ].map((k) => [k, rows[0].candidate[k]]),
  );
  assert.equal(scope.sample_policy, EXPECTED_POLICY);
  assert.equal(scope.generation_key, generation);
  const entries = rows.map((r) => ({ candidate: r.candidate, outcome: r.outcome }));
  const WINDOW_A = '2026-10-12T02:15:00.000Z';
  const WINDOW_B = '2026-10-12T02:30:00.000Z';
  const PENDING_WINDOW = '2030-01-01T00:00:00.000Z';
  const observed = '2026-10-12T02:30:01.000Z';
  const cover = (...resolvedWindows) => ({
    retention: PAPER_GATE_RETENTION_CONTRACT,
    resolvedWindows,
  });
  const select = (coverage, at = observed, entryList = entries) =>
    selectPaperGateRetainedHistory(entryList, scope, cutoff, at, coverage);
  const history = select(cover(WINDOW_A, WINDOW_B));
  // Literal independent expected vector against the real persisted rows.
  assert.deepEqual(history, {
    kind: 'selected',
    retention: PAPER_GATE_RETENTION_CONTRACT,
    completeness: 'declared-not-proved',
    observations: [
      {
        id: 'd'.repeat(256),
        policyVersion: EXPECTED_POLICY,
        closesAt: WINDOW_A,
        resolvedAt: '2026-10-12T02:15:01.000Z',
        realizedEdge: 0.4825,
      },
      {
        id: 'phase-second',
        policyVersion: EXPECTED_POLICY,
        closesAt: WINDOW_B,
        resolvedAt: '2026-10-12T02:30:01.000Z',
        realizedEdge: 0.4825,
      },
    ],
    selectedCandidateKeys: ['k'.repeat(120), 'phase-second-candidate'],
    supersededCandidateKeys: [],
    unresolvedCandidateKeys: ['phase-pending-candidate'],
    unresolvedCause: 'unknown',
    selectedMaxRecordedAtMicroseconds: 1791772202000000n,
  });
  // Persisted candidate with no valid outcome row stays unknown-cause, never a 0 edge.
  assert.deepEqual(select(cover(WINDOW_A, WINDOW_B, PENDING_WINDOW)), {
    kind: 'unavailable',
    reason: 'declared-resolved-window-missing',
    missingWindows: [PENDING_WINDOW],
  });
  // Declaration that omits a real selected window is a wrong declaration, not a gap.
  assert.deepEqual(select(cover(WINDOW_A)), {
    kind: 'malformed',
    reason: 'coverage-mismatch',
    rowIndex: null,
  });
  // Source observed guard: the later sample resolved after the declared source instant.
  assert.deepEqual(select(cover(WINDOW_A, WINDOW_B), WINDOW_B), {
    kind: 'malformed',
    reason: 'observed-time-bound',
    rowIndex: 0,
  });
  // The same persisted row twice is the caller's duplicate, not two samples.
  assert.deepEqual(select(cover(WINDOW_A, WINDOW_B), observed, [...entries, entries[0]]), {
    kind: 'malformed',
    reason: 'duplicate-candidate-key',
    rowIndex: 3,
  });
  // Exactly one microsecond below the real recorded bound: the DESC read puts the row
  // carrying that recorded clock first, so the decoder refuses it at row index 0. This
  // pins the exact-microsecond boundary against real rows rather than a rounded second.
  assert.equal(String(BigInt(EXPECTED_CUTOFF) - 1n), '1791772201999999');
  assert.deepEqual(
    selectPaperGateRetainedHistory(
      entries,
      scope,
      String(BigInt(EXPECTED_CUTOFF) - 1n),
      observed,
      cover(WINDOW_A, WINDOW_B),
    ),
    { kind: 'malformed', reason: 'row', rowIndex: 0 },
  );
  // One microsecond above it still reads cleanly, so the refusal above is the boundary
  // itself and not an unrelated malformation of these fixtures.
  assert.equal(
    selectPaperGateRetainedHistory(
      entries,
      scope,
      String(BigInt(EXPECTED_CUTOFF) + 1n),
      observed,
      cover(WINDOW_A, WINDOW_B),
    ).kind,
    'selected',
  );
  // An invalid cutoff or scope is refused up front, not reported as an empty success.
  assert.deepEqual(selectPaperGateRetainedHistory([], scope, undefined, observed, cover()), {
    kind: 'malformed',
    reason: 'cutoff',
    rowIndex: null,
  });
  assert.deepEqual(
    selectPaperGateRetainedHistory([], { ...scope, epoch: 0 }, cutoff, observed, cover()),
    { kind: 'malformed', reason: 'scope', rowIndex: null },
  );
  // Declared coverage is reconciled, never established: no completeness/evidence is
  // produced here, and FK/read/selection still cannot prove source qualification,
  // whole retained history, generation authority or current admission.
  assert.equal(Object.hasOwn(history, 'complete'), false);
}
