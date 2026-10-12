// Hosted local projection storage only; NOT source/coverage/init/current authority/CAS proof.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
export async function paperGateHeadPostgresContract(
  admin,
  writer,
  { reader, recorder, publicOnly },
) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const table = 'paper_gate_head';
  const columns = [
    'generation_key',
    'funding_id',
    'epoch',
    'budget_id',
    'generation_config_intent_id',
    'sample_policy',
    'latest_event_key',
    'revision',
    'event_kind',
    'projected_phase',
  ];
  const events = await writer.unsafe(
    'select * from engine.paper_gate_phase_event order by event_key',
  );
  const event = (key) => {
    const row = events.find((r) => r.event_key === key);
    assert.ok(row);
    return row;
  };
  const head = (r) =>
    Object.fromEntries(
      columns.map((k) => [
        k,
        k === 'latest_event_key' ? r.event_key : k === 'revision' ? r.revision_after : r[k],
      ]),
    );
  const g0 = head(event('phase-genesis')),
    d0 = head(event('phase-disabled-genesis'));
  const e2 = head(event('phase-nonempty'));
  const insert = (r, sql = writer) =>
    sql.unsafe(
      'insert into engine.' +
        table +
        '(' +
        columns.join(',') +
        ') values(' +
        columns.map((_, i) => '$' + (i + 1)).join(',') +
        ')',
      columns.map((k) => r[k]),
    );
  const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);
  const denied = (p, t = table) =>
    assert.rejects(
      p,
      (e) => e.code === '42501' && e.message.includes('permission denied for table ' + t),
    );
  // No heads yet: NULL/CHECK/FK vectors cannot be masked by occupied generation PK.
  assert.equal((await admin.unsafe('select * from engine.' + table)).length, 0);
  for (const k of columns) await rejects(insert({ ...g0, [k]: null }), '23502');
  for (const [r, patch] of [
    [g0, { event_kind: 'unknown' }],
    [g0, { projected_phase: 'unknown' }],
    [g0, { revision: 1 }],
    [e2, { revision: 0 }],
    ...['disabled', 'open', 'closed'].map((phase) => [g0, { projected_phase: phase }]),
    [g0, { event_kind: 'evaluated' }],
    [e2, { event_kind: 'genesis' }],
    [e2, { revision: -1 }],
    [e2, { revision: '9007199254740992' }],
  ])
    await rejects(insert({ ...r, ...patch }), '23514');
  const [alternate] = await writer.unsafe(
    "select * from engine.paper_gate_generation where generation_key='gate-second-generation'",
  );
  assert.ok(alternate);
  assert.equal(
    (
      await writer.unsafe('select funding_id from engine.paper_funding_root where funding_id=$1', [
        alternate.funding_id,
      ])
    ).length,
    1,
  );
  assert.equal(
    (
      await admin.unsafe('select id from engine.control_intent where id=$1', [
        alternate.generation_config_intent_id,
      ])
    ).length,
    1,
  );
  for (const patch of [
    { generation_key: d0.generation_key }, // Existing generation, wrong pointed event namespace.
    { funding_id: alternate.funding_id }, // Existing root, wrong event root.
    { generation_config_intent_id: alternate.generation_config_intent_id }, // Existing C2.
    { latest_event_key: 'phase-disabled-nonempty' }, // Existing event; joint namespace/phase mismatch.
    { revision: 3 },
    { projected_phase: 'closed' },
    { latest_event_key: 'phase-genesis' }, // Branch-valid evaluated row; joint kind AND revision mismatch.
  ])
    await rejects(insert({ ...e2, ...patch }), '23503');
  await insert(g0);
  await insert(d0);
  await rejects(insert(g0), '23505');
  const readHead = (key, sql = writer) =>
    sql.unsafe('select * from engine.' + table + ' where generation_key=$1', [key]);
  const update = async (r) => {
    const mutable = columns.slice(1);
    const result = await writer.unsafe(
      'update engine.' +
        table +
        ' set ' +
        mutable.map((k, i) => k + '=$' + (i + 1)).join(',') +
        ' where generation_key=$' +
        (mutable.length + 1) +
        ' returning *',
      [...mutable.map((k) => r[k]), r.generation_key],
    );
    assert.equal(result.length, 1);
    assert.deepEqual(result, await readHead(r.generation_key));
    assert.deepEqual(Object.fromEntries(Object.entries(result[0])), r);
  };
  for (const key of ['phase-empty', 'phase-nonempty', 'phase-open', 'phase-open-unchanged'])
    await update(head(event(key)));
  const disabled = async (key, expectedInputs) => {
    await update(head(event(key)));
    const [r] = await writer.unsafe(
      'select e.result_phase,e.input_count,e.summary_resolved_windows,e.weighted_mean_edge,e.standard_error,e.negative_return_confidence,g.enabled from engine.paper_gate_head h join engine.paper_gate_phase_event e on e.event_key=h.latest_event_key join engine.paper_gate_generation g on g.generation_key=h.generation_key where h.generation_key=$1',
      [d0.generation_key],
    );
    assert.equal(r.enabled, false);
    assert.equal(r.result_phase, 'disabled');
    assert.equal(r.input_count, expectedInputs);
    assert.equal(r.summary_resolved_windows, 0);
    for (const k of ['weighted_mean_edge', 'standard_error', 'negative_return_confidence'])
      assert.equal(r[k], null);
  };
  await disabled('phase-disabled-empty', 0);
  await disabled('phase-disabled-nonempty', 1);
  // Matching OLDER pointer SUCCESS despite later e4: local counterexample, not MAX/CAS.
  await update(head(event('phase-empty')));
  await update(head(event('phase-open-unchanged')));
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
    [table, 'generation_key'],
  ];
  const snapshot = ([t, key], sql = admin) =>
    sql.unsafe('select * from engine.' + t + ' order by ' + key);
  const all = () => Promise.all(tables.map((t) => snapshot(t)));
  const before = await all();
  await admin.unsafe(
    readFileSync('services/platform-api/migrations/0006-paper-cycle-overlay.sql', 'utf8'),
  );
  assert.deepEqual(await all(), before);
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
      assert.deepEqual(await snapshot(tables[13], sql), before[13]);
    else await denied(sql.unsafe('select * from engine.' + table));
    if (sql === writer) {
      await sql.unsafe(
        'update engine.' + table + ' set latest_event_key=latest_event_key,revision=revision',
      );
      assert.deepEqual(await snapshot(tables[13], sql), before[13]);
    } else {
      await denied(insert(g0, sql));
      await denied(sql.unsafe('update engine.' + table + ' set latest_event_key=latest_event_key'));
    }
    for (const verb of ['delete from', 'truncate'])
      await denied(sql.unsafe(verb + ' engine.' + table));
    for (const t of ['paper_gate_phase_event', 'paper_gate_phase_input']) {
      for (const q of [
        'update engine.' + t + ' set event_key=event_key',
        'delete from engine.' + t,
        'truncate engine.' + t,
      ])
        await denied(sql.unsafe(q), t);
    }
    assert.deepEqual(await all(), before);
  }
  // ALL14 full DRIVER rows/columns, not lossless SQL microsecond codec proof.
  // Manual OPEN2 != minimum4 planner parity; ordinal gaps != coverage; counts are fixtures.
  // Namespace table-UPDATE representability remains allowed; no stable-identity/live CAS proof.
}
