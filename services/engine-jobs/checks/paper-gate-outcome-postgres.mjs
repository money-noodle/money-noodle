// Hosted synthetic storage ONLY; no resolver/codec/current authority/atomic proof.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
export async function paperGateOutcomePostgresContract(
  admin,
  writer,
  { reader, recorder, publicOnly },
) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const table = 'paper_gate_outcome';
  const insert = (row, sql = writer) => {
    const keys = Object.keys(row);
    return sql.unsafe(
      'insert into engine.' +
        table +
        '(' +
        keys.join(',') +
        ') values(' +
        keys
          .map((k, i) => '$' + (i + 1) + (k.endsWith('_at') ? '::text::timestamptz' : ''))
          .join(',') +
        ')',
      Object.values(row),
    );
  };
  const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);
  const candidates = await writer.unsafe(
    'select * from engine.paper_gate_candidate order by candidate_key',
  );
  assert.equal(candidates.length, 2);
  const first = candidates.find((c) => c.side === 'UP');
  const second = candidates.find((c) => c.side === 'DOWN');
  assert.ok(first);
  assert.ok(second);
  const tuple = [
    'candidate_key',
    'generation_key',
    'funding_id',
    'epoch',
    'budget_id',
    'generation_config_intent_id',
    'sample_policy',
    'closes_at',
    'contract_id',
    'side',
  ];
  const row = (c, key, edge) => ({
    ...Object.fromEntries(tuple.map((k) => [k, c[k] instanceof Date ? c[k].toISOString() : c[k]])),
    outcome_key: key,
    resolution_run_id: 'root-paper-run',
    current_effect_config_intent_id: 'root-other-config',
    source_kind: 'prospective-engine-run',
    evidence_version: 'paper-regime-explicit-evidence-v1',
    resolution_receipt_id: 'r'.repeat(120),
    winner: 'UP',
    realized_edge: edge,
    resolved_at: '2026-10-12T02:15:01.000Z',
    recorded_at: '2026-10-12T02:15:02.000Z',
  });
  const win = row(first, 'o'.repeat(120), '0.4825');
  for (const c of candidates) {
    assert.equal(Number(c.ask_price), 0.5);
    assert.equal(Number(c.estimated_fee_rate), 0.0175);
  }
  // Before any valid INSERT: fresh keys, no occupied candidate UNIQUE masking other failures.
  for (const [i, k] of tuple.entries())
    await rejects(insert({ ...win, outcome_key: 'null-tuple-' + i, [k]: null }), '23502');
  const bad = [
    [{ generation_key: second.generation_key }, '23503'],
    [{ funding_id: second.funding_id }, '23503'],
    [{ generation_config_intent_id: second.generation_config_intent_id }, '23503'],
    [{ candidate_key: second.candidate_key }, '23503'],
    [{ closes_at: '2026-10-12T02:00:00.000Z' }, '23503'],
    [{ contract_id: second.contract_id }, '23503'],
    [{ side: 'DOWN' }, '23503'],
    [{ sample_policy: 'other-policy' }, '23503'],
    [{ resolution_run_id: 'absent-run' }, '23503'],
    [{ current_effect_config_intent_id: 'absent-config' }, '23503'],
    [{ winner: 'INVALID' }, '23514'],
    [{ winner: null }, '23502'],
    [{ realized_edge: null }, '23502'],
    ...['NaN', 'Infinity', '-Infinity', '1.0001', '-1.0001'].map((x) => [
      { realized_edge: x },
      '23514',
    ]),
    [{ source_kind: 'ordinary-trade' }, '23514'],
    [{ source_kind: 'research' }, '23514'],
    [{ resolved_at: '2026-10-12T02:14:59.000Z' }, '23514'],
    [{ recorded_at: '2026-10-12T02:15:00.000Z' }, '23514'],
    [{ resolved_at: '2026-10-12T02:15:01.000001Z' }, '23514'],
    [{ resolved_at: 'infinity' }, '23514'],
    [{ resolved_at: '-infinity' }, '23514'],
    [{ recorded_at: 'infinity' }, '23514'],
    [{ recorded_at: '-infinity' }, '23514'],
    [{ resolution_receipt_id: 'r'.repeat(121) }, '23514'],
    [{ outcome_key: 'o'.repeat(121) }, '23514'],
  ];
  for (const [i, [patch, code]] of bad.entries())
    await rejects(insert({ ...win, outcome_key: 'bad-outcome-' + i, ...patch }), code);
  await insert(win);
  const loss = row(second, 'gate-loss', '-0.5175');
  await insert(loss);
  // Only candidate UNIQUE occupied: fresh outcome/receipt, valid opposite winner and signed edge.
  await rejects(
    insert({
      ...win,
      outcome_key: 'conflicting-candidate',
      resolution_receipt_id: 'conflicting-valid-receipt',
      winner: 'DOWN',
      realized_edge: '-0.5175',
    }),
    '23505',
  );
  const actual = await writer.unsafe(
    'select * from engine.paper_gate_outcome order by outcome_key',
  );
  assert.equal(actual.length, 2);
  const storedWin = actual.find((x) => x.outcome_key === win.outcome_key);
  const storedLoss = actual.find((x) => x.outcome_key === loss.outcome_key);
  assert.equal(Number(storedWin.realized_edge), 0.4825);
  assert.equal(Number(storedLoss.realized_edge), -0.5175);
  assert.equal(storedWin.generation_config_intent_id, 'root-config');
  assert.equal(storedWin.current_effect_config_intent_id, 'root-other-config');
  assert.equal(storedWin.outcome_key, win.outcome_key);
  assert.equal(storedWin.resolution_receipt_id, win.resolution_receipt_id);
  for (const [c, o] of [
    [first, storedWin],
    [second, storedLoss],
  ])
    for (const k of tuple) assert.deepEqual(o[k], c[k]);
  // No unavailable/pending/invalid neutral sample producer exists here. Zero is not generically invalid.
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
    [table, 'outcome_key'],
  ];
  const snapshot = ([t, key], sql = admin) =>
    sql.unsafe('select * from engine.' + t + ' order by ' + key);
  const before = await Promise.all(tables.map((t) => snapshot(t)));
  assert.equal(before[10].length, 2);
  await admin.unsafe(
    readFileSync('services/platform-api/migrations/0006-paper-cycle-overlay.sql', 'utf8'),
  );
  assert.deepEqual(await Promise.all(tables.map((t) => snapshot(t))), before);
  const denied = (p) =>
    assert.rejects(
      p,
      (e) => e.code === '42501' && e.message.includes('permission denied for table ' + table),
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
    if (sql === writer || sql === reader)
      assert.deepEqual(await snapshot([table, 'outcome_key'], sql), before[10]);
    else await denied(sql.unsafe('select * from engine.' + table));
    if (sql !== writer) await denied(insert({ ...win, outcome_key: 'forbidden-' + name }, sql));
    for (const q of [
      'update engine.' + table + ' set winner=winner',
      'delete from engine.' + table,
      'truncate engine.' + table,
    ])
      await denied(sql.unsafe(q));
  }
  assert.deepEqual(await Promise.all(tables.map((t) => snapshot(t))), before);
  // Two outcomes and ALL11 snapshots are synthetic fixtures, NOT passed-case counts/coverage truth.
}
