// Hosted synthetic local shapes only; NO planner/coverage/authority/head/CAS proof.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
export async function paperGatePhasePostgresContract(
  admin,
  writer,
  { reader, recorder, publicOnly },
) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const insert = (t, r, sql = writer) => {
    const keys = Object.keys(r);
    return sql.unsafe(
      'insert into engine.' +
        t +
        '(' +
        keys.join(',') +
        ') values(' +
        keys
          .map((k, i) => '$' + (i + 1) + (k.endsWith('_at') ? '::text::timestamptz' : ''))
          .join(',') +
        ')',
      Object.values(r),
    );
  };
  const rejects = (p, c) => assert.rejects(p, (e) => e.code === c);
  const plain = (r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
    );
  const [g] = await writer.unsafe(
    "select * from engine.paper_gate_generation where generation_key='gate-generation'",
  );
  const [c] = await writer.unsafe("select * from engine.paper_gate_candidate where side='UP'");
  const [o] = await writer.unsafe(
    'select * from engine.paper_gate_outcome where candidate_key=$1',
    [c.candidate_key],
  );
  const dg = {
    ...plain(g),
    generation_key: 'phase-disabled-generation',
    enabled: false,
    settings_descriptor: 'regime-settings-v1:false:4:2.5:0.99:0.75',
  };
  await insert('paper_gate_generation', dg); // New synthetic generation, never UPDATE append identity.
  const c2 = {
    ...plain(c),
    candidate_key: 'phase-second-candidate',
    candidate_id: 'phase-second',
    closes_at: '2026-10-12T02:30:00.000Z',
  };
  const pending = {
    ...plain(c),
    candidate_key: 'phase-pending-candidate',
    candidate_id: 'phase-pending',
    closes_at: '2030-01-01T00:00:00.000Z',
  };
  const dc = {
    ...plain(c),
    candidate_key: 'phase-disabled-candidate',
    candidate_id: 'phase-disabled',
    generation_key: dg.generation_key,
  };
  for (const r of [c2, pending, dc]) await insert('paper_gate_candidate', r);
  const outcome = (candidate, key) => ({
    ...plain(o),
    outcome_key: key,
    candidate_key: candidate.candidate_key,
    generation_key: candidate.generation_key,
    closes_at: candidate.closes_at,
    resolved_at: '2026-10-12T02:30:01.000Z',
    recorded_at: '2026-10-12T02:30:02.000Z',
  });
  await insert('paper_gate_outcome', outcome(c2, 'phase-second-outcome'));
  await insert('paper_gate_outcome', outcome(dc, 'phase-disabled-outcome'));
  const ns = [
    'generation_key',
    'funding_id',
    'epoch',
    'budget_id',
    'generation_config_intent_id',
    'sample_policy',
  ];
  const genesis = (generation, key) => ({
    event_key: key,
    ...Object.fromEntries(ns.map((k) => [k, generation[k]])),
    event_kind: 'genesis',
    revision_after: 0,
    prior_event_key: null,
    revision_before: null,
    previous_phase: null,
    result_phase: null,
    projected_phase: 'warming',
    current_effect_config_intent_id: 'root-other-config',
    latest_intent_id: 'root-other-config',
    run_id: 'root-paper-run',
    source_kind: 'prospective-engine-run',
    evidence_version: 'paper-regime-explicit-evidence-v1',
    coverage_receipt_id: 'synthetic-not-coverage-proof',
    evidence_observed_at: '2026-10-12T03:00:00.000Z',
    coverage_cutoff_at: '2026-10-12T03:00:00.000001Z',
    recorded_at: '2026-10-12T03:00:00.000002Z',
    captured_candidate_count: 0,
    captured_resolved_count: 0,
    captured_unresolved_count: 0,
    input_count: 0,
    universe_first_closes_at: null,
    universe_last_closes_at: null,
    summary_resolved_windows: 0,
    effective_windows: 0,
    weighted_mean_edge: null,
    standard_error: null,
    negative_return_confidence: null,
  });
  const g0 = genesis(g, 'phase-genesis'),
    d0 = genesis(dg, 'phase-disabled-genesis');
  for (const [i, patch] of [
    { prior_event_key: 'absent' },
    { result_phase: 'warming' },
    { revision_before: 0 },
  ].entries())
    await rejects(
      insert('paper_gate_phase_event', { ...g0, event_key: 'bad-genesis-' + i, ...patch }),
      '23514',
    );
  await insert('paper_gate_phase_event', g0);
  await insert('paper_gate_phase_event', d0);
  const evalRow = (prior, key, phase) => ({
    ...prior,
    event_key: key,
    event_kind: 'evaluated',
    revision_before: prior.revision_after,
    revision_after: Number(prior.revision_after) + 1,
    prior_event_key: prior.event_key,
    previous_phase: prior.projected_phase,
    result_phase: phase,
    projected_phase: phase,
  });
  // Future unresolved UNIVERSE bounds, zero resolved inputs, local shape ONLY.
  const e1 = {
    ...evalRow(g0, 'phase-empty', 'warming'),
    captured_candidate_count: 1,
    captured_unresolved_count: 1,
    universe_first_closes_at: pending.closes_at,
    universe_last_closes_at: pending.closes_at,
  };
  const d1 = evalRow(d0, 'phase-disabled-empty', 'disabled');
  await insert('paper_gate_phase_event', e1);
  await insert('paper_gate_phase_event', d1);
  const e2 = {
    ...evalRow(e1, 'phase-nonempty', 'warming'),
    captured_candidate_count: 2,
    captured_resolved_count: 2,
    captured_unresolved_count: 0,
    input_count: 2,
    universe_first_closes_at: plain(c).closes_at,
    universe_last_closes_at: c2.closes_at,
    summary_resolved_windows: 2,
    effective_windows: '1.5',
    weighted_mean_edge: '0.4825',
    standard_error: '0.1',
    negative_return_confidence: '0.2',
  };
  const bad = [
    ...['prior_event_key', 'revision_before', 'previous_phase', 'result_phase'].map((k) => [
      { [k]: null },
      '23514',
    ]),
    [{ generation_key: null }, '23502'],
    [{ prior_event_key: d0.event_key }, '23503'],
    [{ previous_phase: 'closed' }, '23503'],
    [{ revision_before: 9, revision_after: 10 }, '23503'],
    [{ weighted_mean_edge: null }, '23514'],
    [
      {
        result_phase: 'closed',
        projected_phase: 'closed',
        input_count: 0,
        captured_candidate_count: 0,
        captured_resolved_count: 0,
        summary_resolved_windows: 0,
        effective_windows: 0,
        weighted_mean_edge: null,
        standard_error: null,
        negative_return_confidence: null,
        universe_first_closes_at: null,
        universe_last_closes_at: null,
      },
      '23514',
    ],
    [{ standard_error: 'NaN' }, '23514'],
    [{ effective_windows: 'Infinity' }, '23514'],
    [{ weighted_mean_edge: '-Infinity' }, '23514'],
    [{ revision_before: '9007199254740992', revision_after: '9007199254740993' }, '23514'],
    [{ captured_candidate_count: 3 }, '23514'],
    [{ universe_last_closes_at: null }, '23514'],
    [{ evidence_observed_at: 'infinity' }, '23514'],
    [{ evidence_observed_at: '2026-10-12T03:00:00.000001Z' }, '23514'],
  ];
  for (const [i, [patch, code]] of bad.entries())
    await rejects(
      insert('paper_gate_phase_event', { ...e2, event_key: 'bad-evaluated-' + i, ...patch }),
      code,
    );
  await insert('paper_gate_phase_event', e2);
  await rejects(
    insert('paper_gate_phase_event', { ...e2, event_key: 'same-generation-revision' }),
    '23505',
  );
  const e3 = { ...evalRow(e2, 'phase-open', 'open') };
  await insert('paper_gate_phase_event', e3);
  const e4 = { ...evalRow(e3, 'phase-open-unchanged', 'open') };
  await insert('paper_gate_phase_event', e4);
  const d2 = {
    ...evalRow(d1, 'phase-disabled-nonempty', 'disabled'),
    captured_candidate_count: 1,
    captured_resolved_count: 1,
    input_count: 1,
    universe_first_closes_at: dc.closes_at,
    universe_last_closes_at: dc.closes_at,
  };
  await insert('paper_gate_phase_event', d2);
  const input = (event, candidate, ordinal) => ({
    event_key: event.event_key,
    ordinal,
    ...Object.fromEntries(ns.map((k) => [k, event[k]])),
    revision_after: event.revision_after,
    event_kind: 'evaluated',
    projected_phase: event.projected_phase,
    candidate_key: candidate.candidate_key,
    closes_at: plain(candidate).closes_at,
    contract_id: candidate.contract_id,
    side: candidate.side,
  });
  const base = input(e2, c, 0);
  const iBad = [
    [{ event_key: g0.event_key, revision_after: 0 }, '23503'],
    [{ event_kind: 'genesis' }, '23514'],
    [
      { event_key: d2.event_key, revision_after: d2.revision_after, projected_phase: 'disabled' },
      '23503',
    ],
    [{ revision_after: 99 }, '23503'],
    [{ projected_phase: 'closed' }, '23503'],
    [{ candidate_key: dc.candidate_key }, '23503'],
    [{ side: 'DOWN' }, '23503'],
    [{ candidate_key: pending.candidate_key, closes_at: pending.closes_at }, '23503'],
    [{ ordinal: 5000 }, '23514'],
    ...['generation_key', 'candidate_key', 'revision_after', 'contract_id'].map((k) => [
      { [k]: null },
      '23502',
    ]),
  ];
  for (const [patch, code] of iBad)
    await rejects(insert('paper_gate_phase_input', { ...base, ...patch }), code);
  await insert('paper_gate_phase_input', base);
  // Ordinal alone collides: other candidate/window valid and unoccupied.
  await rejects(insert('paper_gate_phase_input', input(e2, c2, 0)), '23505');
  await insert('paper_gate_phase_input', input(e2, c2, 1));
  // Candidate AND window duplicate together; no independent window-isolation claim.
  await rejects(insert('paper_gate_phase_input', input(e2, c, 2)), '23505');
  await insert('paper_gate_phase_input', input(e3, c, 0));
  await insert('paper_gate_phase_input', input(e3, c2, 4999));
  // Gapped 0/4999 is valid local shape, NOT complete/order-valid adapter input.
  await insert('paper_gate_phase_input', input(e4, c, 0));
  await insert('paper_gate_phase_input', input(e4, c2, 1));
  await insert('paper_gate_phase_input', input(d2, dc, 0));
  const [disabled] = await writer.unsafe(
    "select * from engine.paper_gate_phase_event where event_key='phase-disabled-nonempty'",
  );
  assert.equal(disabled.result_phase, 'disabled');
  assert.equal(disabled.input_count, 1);
  assert.equal(disabled.summary_resolved_windows, 0);
  assert.equal(disabled.weighted_mean_edge, null);
  const tables = [
    ['paper_funding_root', 'funding_id,epoch,budget_id'],
    ['paper_budget_root', 'funding_id,epoch,budget_id'],
    ['paper_order', 'order_key'],
    ['paper_reservation', 'order_key'],
    ['paper_entry_effect', 'transition_key'],
    ['paper_entry_fill_event', 'event_key'],
    ['paper_sale_event', 'event_key'],
    ['paper_settlement_event', 'event_key'],
    ['paper_gate_generation', 'generation_key'],
    ['paper_gate_candidate', 'candidate_key'],
    ['paper_gate_outcome', 'outcome_key'],
    ['paper_gate_phase_event', 'event_key'],
    ['paper_gate_phase_input', 'event_key,ordinal'],
  ];
  const snapshot = ([t, key], sql = admin) =>
    sql.unsafe('select * from engine.' + t + ' order by ' + key);
  const before = await Promise.all(tables.map((t) => snapshot(t)));
  assert.equal(before[11].length, 8);
  assert.equal(before[12].length, 7);
  await admin.unsafe(
    readFileSync('services/platform-api/migrations/0006-paper-cycle-overlay.sql', 'utf8'),
  );
  assert.deepEqual(await Promise.all(tables.map((t) => snapshot(t))), before);
  const denied = (p, t) =>
    assert.rejects(
      p,
      (e) => e.code === '42501' && e.message.includes('permission denied for table ' + t),
    );
  for (const [sql, name] of [
    [writer, 'engine_writer'],
    [reader, 'engine_reader'],
    [recorder, 'engine_control_recorder'],
    [publicOnly, 'synthetic_public_probe'],
  ]) {
    const [id] = await sql.unsafe(
      "select current_user as role,has_schema_privilege(current_user,'engine','USAGE') as usable",
    );
    assert.equal(id.role, name);
    assert.equal(id.usable, true);
    for (const [i, [t, key]] of tables.slice(11).entries()) {
      if (sql === writer || sql === reader)
        assert.deepEqual(await snapshot([t, key], sql), before[11 + i]);
      else await denied(sql.unsafe('select * from engine.' + t), t);
      if (sql !== writer)
        await denied(
          insert(
            t,
            i === 0 ? { ...e2, event_key: 'forbidden-' + name } : { ...base, ordinal: 50 },
            sql,
          ),
          t,
        );
      for (const q of [
        'update engine.' + t + ' set event_key=event_key',
        'delete from engine.' + t,
        'truncate engine.' + t,
      ])
        await denied(sql.unsafe(q), t);
    }
  }
  assert.deepEqual(await Promise.all(tables.map((t) => snapshot(t))), before);
  // Manual diagnostic fixtures, counts and ALL13 snapshots are NOT pure planner/source/coverage proof.
}
