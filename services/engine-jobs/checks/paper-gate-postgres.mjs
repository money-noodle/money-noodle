// Disposable GHA synthetic storage shapes ONLY; no candidate/authority/bootstrap/CAS truth.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
export async function paperGatePostgresContract(admin, writer, { reader, recorder, publicOnly }) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const insert = (table, row, sql = writer) => {
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
  const generation = {
    generation_key: 'gate-generation',
    funding_id: 'root-funding',
    epoch: 1,
    budget_id: 'root-actor:paper',
    actor: 'root-actor',
    generation_config_intent_id: 'root-config',
    initialization_run_id: 'root-paper-run',
    source_kind: 'prospective-engine-run',
    sample_policy:
      'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22',
    gate_formula: 'adaptive-fee-edge-window-v1',
    bundle_id: 'paper-regime-historical-warm-lineage-v1',
    profile_claim: 'synthetic-proposal-only',
    settings_descriptor: 'regime-settings-v1:true:4:2.5:0.99:0.75',
    enabled: true,
    minimum_policy_windows: 4,
    evidence_half_life_windows: '2.5',
    pause_confidence: '0.99',
    resume_confidence: '0.75',
    reset_origin: 'none',
    reset_barrier_intent_id: null,
    initialized_at: '2026-10-12T02:00:00.000Z',
  };
  const gBad = [
    [{ funding_id: null }, '23502'],
    [{ generation_config_intent_id: null }, '23502'],
    [{ reset_origin: null }, '23502'],
    [{ reset_barrier_intent_id: 'root-config' }, '23514'],
    [{ reset_origin: 'post-reset' }, '23514'],
    [{ actor: 'wrong-actor' }, '23514'],
    [{ funding_id: 'absent-root' }, '23503'],
    [{ generation_config_intent_id: 'absent-config' }, '23503'],
    [{ initialization_run_id: 'absent-run' }, '23503'],
    [{ reset_origin: 'post-reset', reset_barrier_intent_id: 'absent-reset' }, '23503'],
    [{ minimum_policy_windows: 3 }, '23514'],
    [{ minimum_policy_windows: 501 }, '23514'],
    [{ evidence_half_life_windows: '1.99' }, '23514'],
    [{ evidence_half_life_windows: 'NaN' }, '23514'],
    [{ evidence_half_life_windows: 'Infinity' }, '23514'],
    [{ pause_confidence: '0.89' }, '23514'],
    [{ resume_confidence: '0.985' }, '23514'],
    [{ resume_confidence: '0.98', pause_confidence: '0.985' }, '23514'],
    [{ initialized_at: 'infinity' }, '23514'],
    [{ bundle_id: 'unknown' }, '23514'],
  ];
  for (const [i, [patch, code]] of gBad.entries())
    await rejects(
      insert('paper_gate_generation', {
        ...generation,
        generation_key: 'gate-bad-generation-' + i,
        ...patch,
      }),
      code,
    );
  await insert('paper_gate_generation', generation);
  // Existing configure ID as reset-reference demonstrates existence ONLY, not actual RESET authority.
  const second = {
    ...generation,
    generation_key: 'gate-second-generation',
    funding_id: 'order-second-funding',
    generation_config_intent_id: 'root-other-config',
    reset_origin: 'post-reset',
    reset_barrier_intent_id: 'root-config',
  };
  await insert('paper_gate_generation', second);
  const candidate = {
    candidate_key: 'k'.repeat(120),
    candidate_id: 'd'.repeat(256),
    generation_key: generation.generation_key,
    funding_id: generation.funding_id,
    epoch: 1,
    budget_id: generation.budget_id,
    generation_config_intent_id: generation.generation_config_intent_id,
    sample_policy: generation.sample_policy,
    issuance_run_id: 'root-paper-run',
    source_kind: 'prospective-engine-run',
    symbol: 'BTC',
    venue: 'kalshi',
    contract_id: 'synthetic-exact-kalshi-contract',
    side: 'UP',
    created_at: '2026-10-12T02:00:00.000Z',
    closes_at: '2026-10-12T02:15:00.000Z',
    selected_side_probability: '0.75',
    ask_price: '0.5',
    estimated_fee_rate: '0.0175',
    fee_model_version: 'historical-kalshi-continuous-taker-0.07-v1',
    predicted_net_edge: '0.2325',
    evidence_version: 'paper-regime-explicit-evidence-v1',
    qualification_receipt_id: 'synthetic-not-qualified',
  };
  // ALL negatives precede valid candidate INSERT; fresh keys prevent PK/window masks.
  const cBad = [
    [{ generation_key: null }, '23502'],
    [{ funding_id: null }, '23502'],
    [{ sample_policy: null }, '23502'],
    [{ funding_id: 'order-second-funding' }, '23503'], // existing root, wrong generation tuple
    [{ generation_config_intent_id: 'root-other-config' }, '23503'], // existing config
    [{ generation_key: second.generation_key }, '23503'], // existing generation, wrong root/config
    [{ issuance_run_id: 'absent-run' }, '23503'],
    [{ generation_key: 'absent-generation' }, '23503'],
    [{ estimated_fee_rate: '0.0176' }, '23514'],
    [{ estimated_fee_rate: '-0.001' }, '23514'],
    [{ ask_price: '0.99', estimated_fee_rate: '0.0175' }, '23514'],
    [{ ask_price: 0 }, '23514'],
    [{ ask_price: 1 }, '23514'],
    [{ selected_side_probability: 'NaN' }, '23514'],
    [{ predicted_net_edge: 'Infinity' }, '23514'],
    [{ venue: 'polymarket' }, '23514'],
    [{ side: 'INVALID' }, '23514'],
    [{ candidate_id: 'd'.repeat(257) }, '23514'],
    [{ candidate_key: 'k'.repeat(121) }, '23514'],
    [{ closes_at: 'infinity' }, '23514'],
    [{ created_at: '-infinity' }, '23514'],
    [{ closes_at: '2026-10-12T02:15:01.000Z' }, '23514'],
    [{ created_at: '2026-10-12T02:00:00.000001Z' }, '23514'],
    [{ created_at: '2026-10-12T02:16:00.000Z' }, '23514'],
  ];
  for (const [i, [patch, code]] of cBad.entries())
    await rejects(
      insert('paper_gate_candidate', {
        ...candidate,
        candidate_key: 'gate-bad-candidate-' + i,
        ...patch,
      }),
      code,
    );
  const economicBefore = await admin.unsafe(
    'select order_key from engine.paper_order order by order_key',
  );
  const holdsBefore = await admin.unsafe(
    'select order_key from engine.paper_reservation order by order_key',
  );
  await insert('paper_gate_candidate', candidate);
  await rejects(
    insert('paper_gate_candidate', {
      ...candidate,
      candidate_key: 'same-window-other-asset',
      candidate_id: 'other',
      symbol: 'ETH',
    }),
    '23505',
  );
  await insert('paper_gate_candidate', {
    ...candidate,
    candidate_key: 'second-generation-candidate',
    candidate_id: 'second',
    generation_key: second.generation_key,
    funding_id: second.funding_id,
    generation_config_intent_id: second.generation_config_intent_id,
    symbol: 'ETH',
    side: 'DOWN',
    contract_id: 'synthetic-second-contract',
  });
  assert.deepEqual(
    await admin.unsafe('select order_key from engine.paper_order order by order_key'),
    economicBefore,
  );
  assert.deepEqual(
    await admin.unsafe('select order_key from engine.paper_reservation order by order_key'),
    holdsBefore,
  );
  const [stored] = await writer.unsafe(
    'select candidate_key,candidate_id from engine.paper_gate_candidate where candidate_key=$1',
    [candidate.candidate_key],
  );
  assert.equal(stored.candidate_key, candidate.candidate_key);
  assert.equal(stored.candidate_id, candidate.candidate_id);
  const [settings] = await writer.unsafe(
    'select evidence_half_life_windows,settings_descriptor from engine.paper_gate_generation where generation_key=$1',
    [generation.generation_key],
  );
  assert.equal(Number(settings.evidence_half_life_windows), 2.5);
  assert.equal(settings.settings_descriptor, generation.settings_descriptor);
  // Joint ALL-row/ALL-column preservation across ALL TEN paper tables, after existing helpers finish.
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
  ];
  const snapshot = ([t, key], sql = admin) =>
    sql.unsafe('select * from engine.' + t + ' order by ' + key);
  const before = await Promise.all(tables.map((t) => snapshot(t)));
  assert.equal(before[8].length, 2);
  assert.equal(before[9].length, 2);
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
    for (const [i, [t, key]] of tables.slice(8).entries()) {
      if (sql === writer || sql === reader)
        assert.deepEqual(await snapshot([t, key], sql), before[8 + i]);
      else await denied(sql.unsafe('select * from engine.' + t), t);
      if (sql !== writer)
        await denied(
          insert(
            t,
            i === 0
              ? { ...generation, generation_key: 'forbidden-' + name }
              : { ...candidate, candidate_key: 'forbidden-' + name },
            sql,
          ),
          t,
        );
      for (const q of [
        'update engine.' + t + ' set source_kind=source_kind',
        'delete from engine.' + t,
        'truncate engine.' + t,
      ])
        await denied(sql.unsafe(q), t);
    }
  }
  assert.deepEqual(await Promise.all(tables.map((t) => snapshot(t))), before);
  // Counts are synthetic fixtures, NOT passed-case counts or real candidate/economic authority.
}
