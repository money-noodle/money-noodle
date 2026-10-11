// Hosted disposable schema shape only; NOT atomic release/current-authority proof.
import assert from 'node:assert/strict';
import process from 'node:process';
export async function paperOrderPostgresContract(writer) {
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
}
