// Hosted disposable schema shape only; NOT atomic release/current-authority proof.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
export async function paperOrderPostgresContract(admin, writer) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const base = {
    order_key: 'order-entry',
    logical_order_id: 'order-logical',
    funding_id: 'root-funding',
    epoch: 1,
    budget_id: 'root-actor:paper',
    root_birth_config_intent_id: 'root-config',
    issuance_config_intent_id: 'root-other-config',
    current_effect_config_intent_id: 'root-other-config',
    latest_intent_id: 'root-other-config',
    source_kind: 'new',
    origin_run_id: 'root-paper-run',
    origin_restore_run_id: null,
    legacy_order_id: null,
    legacy_ledger_position: null,
    row_kind: 'entry',
    parent_order_key: null,
    parent_row_kind: null,
    entry_episode_key: 'order-episode',
    entry_attempt: 1,
    execution_mode: 'paper',
    symbol: 'BTC',
    contract_id: 'synthetic-contract',
    venue: 'kalshi',
    side: 'UP',
    execution_policy_version: 'synthetic-v1',
    liquidity_role: 'taker',
    status: 'unfilled',
    issued_at: '2026-10-11T23:00:00Z',
    closes_at: '2026-10-11T23:15:00Z',
    completed_at: '2026-10-11T23:00:01Z',
    issued_quantity: 1,
    issued_limit_price: '0.5',
    issued_reservation_cents: 100,
    issued_fee_cents: 1,
    filled_quantity: 0,
    remaining_quantity: 0,
    raw_purchase_cents: 0,
    raw_fee_cents: 0,
    raw_remaining_cost_cents: 0,
    retained_stake_cents: 0,
    revision: 1,
    last_run_id: 'root-paper-run',
    recorded_at: '2026-10-11T23:00:01Z',
  };
  const insert = (table, row) => {
    const keys = Object.keys(row);
    // Only fixed harness-owned keys; bind time as TEXT then server cast, including negative fixtures.
    const placeholders = keys.map(
      (key, i) => '$' + (i + 1) + (key.endsWith('_at') ? '::text::timestamptz' : ''),
    );
    return writer.unsafe(
      'insert into engine.' +
        table +
        '(' +
        keys.join(',') +
        ') values(' +
        placeholders.join(',') +
        ')',
      Object.values(row),
    );
  };
  const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);
  await insert('paper_order', base); // Entry NULL parent fields remain valid.
  const child = {
    ...base,
    order_key: 'order-child',
    logical_order_id: 'sale-logical',
    row_kind: 'sale-child',
    parent_order_key: base.order_key,
    parent_row_kind: 'entry',
    entry_episode_key: null,
    entry_attempt: null,
    issued_reservation_cents: 0,
  };
  await insert('paper_order', child);
  for (const parent of ['missing-entry', base.order_key, child.order_key])
    await rejects(
      insert('paper_order', {
        ...child,
        order_key: 'null-parent-' + parent,
        parent_order_key: parent,
        parent_row_kind: null,
      }),
      '23514',
    );
  await rejects(
    insert('paper_order', {
      ...child,
      order_key: 'missing-parent',
      parent_order_key: 'missing-entry',
    }),
    '23503',
  );
  await rejects(insert('paper_order', { ...child, order_key: 'wrong-root', epoch: 2 }), '23503');
  await rejects(
    insert('paper_order', {
      ...child,
      order_key: 'child-parent',
      parent_order_key: child.order_key,
    }),
    '23503',
  );
  const hold = {
    order_key: base.order_key,
    funding_id: base.funding_id,
    epoch: 1,
    budget_id: base.budget_id,
    order_row_kind: 'entry',
    issuance_config_intent_id: 'root-other-config',
    current_effect_config_intent_id: 'root-other-config',
    latest_intent_id: 'root-other-config',
    original_cents: 100,
    held_cents: 0,
    returned_cents: 100,
    status: 'released',
    released_at: '2026-10-11T23:00:01Z',
    revision: 1,
    last_run_id: 'root-paper-run',
    recorded_at: '2026-10-11T23:00:01Z',
  };
  await rejects(insert('paper_reservation', { ...hold, order_key: child.order_key }), '23503');
  await insert('paper_reservation', hold);
  const [saved] = await writer.unsafe(
    "select issued_quantity,issued_reservation_cents,issued_fee_cents,filled_quantity from engine.paper_order where order_key='order-entry'",
  );
  assert.equal(Number(saved.issued_quantity), 1);
  assert.equal(Number(saved.issued_reservation_cents), 100);
  assert.equal(Number(saved.issued_fee_cents), 1);
  assert.equal(Number(saved.filled_quantity), 0);
  const [released] = await writer.unsafe(
    "select original_cents,held_cents,returned_cents from engine.paper_reservation where order_key='order-entry'",
  );
  assert.equal(Number(released.original_cents), 100);
  assert.equal(Number(released.held_cents), 0);
  assert.equal(Number(released.returned_cents), 100);
  // A second REAL synthetic tuple at the SAME epoch: no missing-root FK mask.
  await writer.unsafe(
    "insert into engine.paper_funding_root select 'order-second-funding',epoch,budget_id,actor,birth_config_intent_id,origin_run_id,origin_restore_run_id,restored_source_state_key,materialized_run_id,recorded_at from engine.paper_funding_root where funding_id='root-funding'",
  );
  await writer.unsafe(
    "insert into engine.paper_budget_root select 'order-second-funding',epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at from engine.paper_budget_root where funding_id='root-funding'",
  );
  const second = { ...base, funding_id: 'order-second-funding', order_key: 'second-entry' };
  await insert('paper_order', second);
  const secondChild = {
    ...child,
    funding_id: second.funding_id,
    order_key: 'second-child',
    parent_order_key: second.order_key,
  };
  await insert('paper_order', secondChild); // All root/config/shape facts independently valid.
  await rejects(
    insert('paper_order', {
      ...secondChild,
      order_key: 'cross-valid-root-child',
      parent_order_key: base.order_key,
    }),
    '23503',
  );
  // Positions come from this explicit synthetic ledger array, never invented for a missing source.
  const legacyRows = [
    { id: 'synthetic-duplicate', marker: 'first' },
    { id: 'synthetic-duplicate', marker: 'second' },
  ];
  for (const [position, row] of legacyRows.entries())
    await writer.unsafe(
      "insert into engine.ledger_order(order_id,ledger_position,execution_mode,status,stake_cents,row,restore_run_id) values($1,$2,'paper','unfilled',100,$3::jsonb,'root-restore')",
      [row.id, position, JSON.stringify(row)],
    );
  const restored = {
    ...base,
    order_key: 'restored-first',
    logical_order_id: legacyRows[0].id,
    source_kind: 'restored',
    origin_run_id: null,
    origin_restore_run_id: 'root-restore',
    issuance_config_intent_id: null,
    legacy_order_id: legacyRows[0].id,
    legacy_ledger_position: 0,
    entry_episode_key: null,
    entry_attempt: null,
  };
  await insert('paper_order', restored);
  await insert('paper_order', {
    ...restored,
    order_key: 'restored-second',
    legacy_ledger_position: 1,
  });
  await rejects(
    insert('paper_order', {
      ...restored,
      order_key: 'duplicate-pair-other-root',
      funding_id: second.funding_id,
    }),
    '23505',
  );
  const legacy = await writer.unsafe(
    "select logical_order_id,legacy_ledger_position,issuance_config_intent_id from engine.paper_order where source_kind='restored' order by legacy_ledger_position",
  );
  assert.deepEqual(
    legacy.map((row) => [
      row.logical_order_id,
      row.legacy_ledger_position,
      row.issuance_config_intent_id,
    ]),
    [
      ['synthetic-duplicate', 0, null],
      ['synthetic-duplicate', 1, null],
    ],
  );
  for (const patch of [
    { origin_restore_run_id: null },
    { legacy_order_id: null },
    { legacy_ledger_position: null },
    { origin_run_id: 'root-paper-run' },
  ])
    await rejects(
      insert('paper_order', { ...restored, order_key: 'partial-origin', ...patch }),
      '23514',
    );
  await insert('paper_order', {
    ...base,
    order_key: 'uncertain-entry',
    entry_episode_key: 'uncertain-episode',
    status: 'uncertain',
    completed_at: null,
  });
  await insert('paper_reservation', {
    ...hold,
    order_key: 'uncertain-entry',
    status: 'held',
    held_cents: 100,
    returned_cents: 0,
    released_at: null,
  });
  const snapshot = (table) =>
    admin.unsafe(
      'select * from engine.' +
        table +
        ' order by ' +
        (table === 'paper_order' || table === 'paper_reservation'
          ? 'order_key'
          : 'funding_id,epoch,budget_id'),
    );
  const tables = ['paper_order', 'paper_reservation', 'paper_funding_root', 'paper_budget_root'];
  const before = await Promise.all(tables.map(snapshot));
  await admin.unsafe(
    readFileSync('services/platform-api/migrations/0006-paper-cycle-overlay.sql', 'utf8'),
  );
  assert.deepEqual(await Promise.all(tables.map(snapshot)), before);
  const [uncertain] = await writer.unsafe(
    "select o.status,r.held_cents,r.returned_cents,r.released_at from engine.paper_order o join engine.paper_reservation r using(order_key) where order_key='uncertain-entry'",
  );
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(Number(uncertain.held_cents), 100);
  assert.equal(Number(uncertain.returned_cents), 0);
  assert.equal(uncertain.released_at, null);
  // Stored unchanged hold is NOT atomic aggregate conservation or release-once proof.
}
