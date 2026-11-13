// Hosted disposable examples only, NOT paper CAS/authority/atomic transaction truth.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
export async function paperSaleSettlementPostgresContract(
  admin,
  writer,
  { reader, recorder, publicOnly },
) {
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
  const [original] = await writer.unsafe(
    "select * from engine.paper_order where order_key='order-entry'",
  );
  const template = Object.fromEntries(
    Object.entries(original).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
  );
  const [oldHold] = await writer.unsafe(
    "select * from engine.paper_reservation where order_key='order-entry'",
  );
  const holdTemplate = Object.fromEntries(
    Object.entries(oldHold).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
  );
  const parent = async (key, q = 4, stake = 207, rawPurchase = 200, rawFee = 7) => {
    const row = {
      ...template,
      order_key: key,
      logical_order_id: key,
      entry_episode_key: key,
      status: 'open',
      completed_at: null,
      issued_quantity: q,
      issued_reservation_cents: stake,
      issued_fee_cents: 0,
      filled_quantity: q,
      remaining_quantity: q,
      raw_purchase_cents: rawPurchase,
      raw_fee_cents: rawFee,
      raw_remaining_cost_cents: Number(rawPurchase) + Number(rawFee),
      retained_stake_cents: stake,
    };
    await insert('paper_order', row);
    await insert('paper_reservation', {
      ...holdTemplate,
      order_key: key,
      original_cents: stake,
      held_cents: stake,
      returned_cents: 0,
      status: 'held',
      released_at: null,
    });
    return row;
  };
  const partialParent = await parent('sale-partial-parent');
  await insert('paper_order', {
    ...partialParent,
    order_key: 'sale-partial-child',
    logical_order_id: 'sale-partial-child',
    row_kind: 'sale-child',
    parent_order_key: partialParent.order_key,
    parent_row_kind: 'entry',
    entry_episode_key: null,
    entry_attempt: null,
    issued_reservation_cents: 0,
    issued_quantity: 1,
    filled_quantity: 1,
    remaining_quantity: 0,
    status: 'sold',
    completed_at: template.completed_at,
    raw_purchase_cents: 50,
    raw_fee_cents: '1.75',
    raw_remaining_cost_cents: 0,
    retained_stake_cents: 0,
  });
  await parent('sale-full-parent');
  await parent('sale-tiny-parent', '0.01', 2, 1, 1);
  await parent('sale-no-fill-parent');
  const sale = {
    event_key: 'sale-partial',
    transition_key: 'sale-partial',
    parent_order_key: 'sale-partial-parent',
    funding_id: 'root-funding',
    epoch: 1,
    budget_id: 'root-actor:paper',
    parent_row_kind: 'entry',
    child_order_key: 'sale-partial-child',
    child_row_kind: 'sale-child',
    sale_kind: 'partial',
    evidence_disposition: 'observed',
    venue: 'kalshi',
    run_id: 'root-paper-run',
    current_effect_config_intent_id: 'root-other-config',
    recorded_at: '2026-10-12T01:43:00Z',
    order_revision_before: 100,
    order_revision_after: 101,
    budget_revision_before: 100,
    budget_revision_after: 101,
    quantity_before: 4,
    sold_quantity: 1,
    remaining_quantity: 3,
    reserved_before_cents: 207,
    remaining_reserved_cents: 156,
    released_stake_cents: 51,
    raw_cost_before_cents: 207,
    raw_sold_cost_cents: '51.75',
    raw_remaining_cost_cents: '155.25',
    raw_gross_proceeds_cents: 60,
    exit_fee_cents: 2,
    raw_net_proceeds_cents: 58,
    raw_actual_pnl_cents: '6.25',
    integer_credit_cents: 58,
    integer_realized_delta_cents: 7,
    disable_automatic_retry: true,
    clear_entry_persistence: false,
    counts_for_reentry_generation: false,
  };
  for (const [i, [patch, code]] of [
    [{ child_order_key: null }, '23514'],
    [{ child_row_kind: null }, '23514'],
    [{ child_order_key: 'order-entry' }, '23503'],
    [{ funding_id: 'order-second-funding' }, '23503'],
    [{ parent_order_key: 'restored-first' }, '23503'],
    [{ evidence_disposition: 'unavailable' }, '23514'],
  ].entries())
    await rejects(
      insert('paper_sale_event', {
        ...sale,
        event_key: 'sale-negative-' + i,
        transition_key: 'sale-negative-' + i,
        order_revision_before: 200 + i,
        order_revision_after: 201 + i,
        budget_revision_before: 200 + i,
        budget_revision_after: 201 + i,
        ...patch,
      }),
      code,
    );
  await insert('paper_sale_event', sale);
  await insert('paper_sale_event', {
    ...sale,
    event_key: 'sale-full',
    transition_key: 'sale-full',
    parent_order_key: 'sale-full-parent',
    child_order_key: null,
    child_row_kind: null,
    sale_kind: 'full',
    order_revision_before: 110,
    order_revision_after: 111,
    budget_revision_before: 110,
    budget_revision_after: 111,
    sold_quantity: 4,
    remaining_quantity: 0,
    remaining_reserved_cents: 0,
    released_stake_cents: 207,
    raw_sold_cost_cents: 207,
    raw_remaining_cost_cents: 0,
    raw_gross_proceeds_cents: 240,
    exit_fee_cents: 7,
    raw_net_proceeds_cents: 233,
    raw_actual_pnl_cents: 26,
    integer_credit_cents: 233,
    integer_realized_delta_cents: 26,
    clear_entry_persistence: true,
    counts_for_reentry_generation: true,
  });
  await insert('paper_sale_event', {
    ...sale,
    event_key: 'sale-tiny',
    transition_key: 'sale-tiny',
    parent_order_key: 'sale-tiny-parent',
    child_order_key: null,
    child_row_kind: null,
    sale_kind: 'full',
    order_revision_before: 120,
    order_revision_after: 121,
    budget_revision_before: 120,
    budget_revision_after: 121,
    quantity_before: '0.01',
    sold_quantity: '0.01',
    remaining_quantity: 0,
    reserved_before_cents: 2,
    remaining_reserved_cents: 0,
    released_stake_cents: 2,
    raw_cost_before_cents: 2,
    raw_sold_cost_cents: 2,
    raw_remaining_cost_cents: 0,
    raw_gross_proceeds_cents: '0.01',
    exit_fee_cents: 1,
    raw_net_proceeds_cents: '-0.99',
    raw_actual_pnl_cents: '-2.99',
    integer_credit_cents: 0,
    integer_realized_delta_cents: -2,
    clear_entry_persistence: true,
    counts_for_reentry_generation: true,
  });
  await insert('paper_sale_event', {
    ...sale,
    event_key: 'sale-no-fill',
    transition_key: 'sale-no-fill',
    parent_order_key: 'sale-no-fill-parent',
    child_order_key: null,
    child_row_kind: null,
    sale_kind: 'no-fill',
    order_revision_before: 130,
    order_revision_after: 131,
    budget_revision_before: 130,
    budget_revision_after: 131,
    sold_quantity: 0,
    remaining_quantity: 4,
    remaining_reserved_cents: 207,
    released_stake_cents: 0,
    raw_sold_cost_cents: 0,
    raw_remaining_cost_cents: 207,
    raw_gross_proceeds_cents: 0,
    exit_fee_cents: 0,
    raw_net_proceeds_cents: 0,
    raw_actual_pnl_cents: 0,
    integer_credit_cents: 0,
    integer_realized_delta_cents: 0,
  });
  const [hold] = await writer.unsafe(
    "select held_cents from engine.paper_reservation where order_key='sale-no-fill-parent'",
  );
  assert.equal(Number(hold.held_cents), 207);
  const [partial] = await writer.unsafe(
    "select * from engine.paper_sale_event where event_key='sale-partial'",
  );
  assert.equal(Number(partial.raw_actual_pnl_cents), 6.25);
  assert.equal(Number(partial.integer_realized_delta_cents), 7);
  assert.equal(Number(partial.remaining_reserved_cents), 156);
  const [tiny] = await writer.unsafe(
    "select * from engine.paper_sale_event where event_key='sale-tiny'",
  );
  assert.equal(Number(tiny.raw_net_proceeds_cents), -0.99);
  assert.equal(Number(tiny.integer_credit_cents), 0);
  assert.equal(Number(tiny.raw_actual_pnl_cents), -2.99);
  const settlement = {
    event_key: 'settle-win',
    transition_key: 'settle-win',
    order_key: 'settle-win-parent',
    funding_id: 'root-funding',
    epoch: 1,
    budget_id: 'root-actor:paper',
    order_row_kind: 'entry',
    side: 'UP',
    outcome: 'UP',
    result_status: 'won',
    run_id: 'root-paper-run',
    current_effect_config_intent_id: 'root-other-config',
    recorded_at: '2026-10-12T01:43:00Z',
    order_revision_before: 400,
    order_revision_after: 401,
    budget_revision_before: 400,
    budget_revision_after: 401,
    released_stake_cents: 156,
    potential_payout_cents: 300,
    payout_cents: 300,
    integer_realized_delta_cents: 144,
  };
  for (const [i, [name, outcome, status, payout, delta]] of [
    ['win', 'UP', 'won', 300, 144],
    ['loss', 'DOWN', 'lost', 0, -156],
    ['invalid', 'INVALID', 'invalid', 156, 0],
    ['rounded', 'INVALID', 'invalid', 7, 0],
  ].entries()) {
    const key = 'settle-' + name + '-parent';
    await parent(
      key,
      i === 3 ? '0.25' : 3,
      i === 3 ? 7 : 156,
      i === 3 ? '6.25' : 150,
      i === 3 ? 0 : '5.25',
    );
    await insert('paper_settlement_event', {
      ...settlement,
      event_key: 'settle-' + name,
      transition_key: 'settle-' + name,
      order_key: key,
      outcome,
      result_status: status,
      payout_cents: payout,
      integer_realized_delta_cents: delta,
      released_stake_cents: i === 3 ? 7 : 156,
      potential_payout_cents: i === 3 ? 25 : 300,
      order_revision_before: 400 + i,
      order_revision_after: 401 + i,
      budget_revision_before: 400 + i,
      budget_revision_after: 401 + i,
    });
  }
  // Only concrete-order UNIQUE collides: fresh keys, revisions and conflicting valid loss outcome.
  await rejects(
    insert('paper_settlement_event', {
      ...settlement,
      event_key: 'conflicting-terminal',
      transition_key: 'conflicting-terminal',
      outcome: 'DOWN',
      result_status: 'lost',
      payout_cents: 0,
      integer_realized_delta_cents: -156,
      order_revision_before: 500,
      order_revision_after: 501,
      budget_revision_before: 500,
      budget_revision_after: 501,
    }),
    '23505',
  );
  const [refund] = await writer.unsafe(
    "select payout_cents from engine.paper_settlement_event where event_key='settle-rounded'",
  );
  assert.equal(Number(refund.payout_cents), 7);

  const tinyPartialParent = await parent('tiny-partial-parent', 1, 1, '0.25', 0);
  await insert('paper_order', {
    ...tinyPartialParent,
    order_key: 'tiny-partial-child',
    logical_order_id: 'tiny-partial-child',
    row_kind: 'sale-child',
    parent_order_key: tinyPartialParent.order_key,
    parent_row_kind: 'entry',
    entry_episode_key: null,
    entry_attempt: null,
    issued_reservation_cents: 0,
    issued_quantity: '0.01',
    filled_quantity: '0.01',
    remaining_quantity: 0,
    status: 'sold',
    completed_at: template.completed_at,
    raw_purchase_cents: '0.0025',
    raw_fee_cents: 0,
    raw_remaining_cost_cents: 0,
    retained_stake_cents: 0,
  });
  await insert('paper_sale_event', {
    ...sale,
    event_key: 'tiny-partial',
    transition_key: 'tiny-partial',
    parent_order_key: tinyPartialParent.order_key,
    child_order_key: 'tiny-partial-child',
    order_revision_before: 600,
    order_revision_after: 601,
    budget_revision_before: 600,
    budget_revision_after: 601,
    quantity_before: 1,
    sold_quantity: '0.01',
    remaining_quantity: '0.99',
    reserved_before_cents: 1,
    remaining_reserved_cents: 1,
    released_stake_cents: 0,
    raw_cost_before_cents: '0.25',
    raw_sold_cost_cents: '0.0025',
    raw_remaining_cost_cents: '0.2475',
    raw_gross_proceeds_cents: '0.01',
    exit_fee_cents: 1,
    raw_net_proceeds_cents: '-0.99',
    raw_actual_pnl_cents: '-0.9925',
    integer_credit_cents: 0,
    integer_realized_delta_cents: 0,
  });
  const [tinyPartial] = await writer.unsafe(
    "select * from engine.paper_sale_event where event_key='tiny-partial'",
  );
  assert.equal(Number(tinyPartial.released_stake_cents), 0);
  assert.equal(Number(tinyPartial.remaining_reserved_cents), 1);
  assert.equal(Number(tinyPartial.raw_actual_pnl_cents), -0.9925);
  assert.equal(Number(tinyPartial.integer_realized_delta_cents), 0);
  // Existing explicit two-record legacy fixture: no new/fabricated historical positions.
  const legacyParents = await writer.unsafe(
    "select order_key,logical_order_id,legacy_ledger_position,issuance_config_intent_id from engine.paper_order where order_key in ('restored-first','restored-second') order by legacy_ledger_position",
  );
  assert.deepEqual(
    legacyParents.map((x) => [
      x.logical_order_id,
      x.legacy_ledger_position,
      x.issuance_config_intent_id,
    ]),
    [
      ['synthetic-duplicate', 0, null],
      ['synthetic-duplicate', 1, null],
    ],
  );
  for (const [i, row] of legacyParents.entries()) {
    // Only synthetic held-state fixture changes, genuine origin/issued fields untouched.
    await writer.unsafe(
      "update engine.paper_order set status='open',completed_at=null,filled_quantity=1,remaining_quantity=1,raw_purchase_cents=50,raw_fee_cents=0,raw_remaining_cost_cents=50,retained_stake_cents=50 where order_key=$1",
      [row.order_key],
    );
    await insert('paper_reservation', {
      ...holdTemplate,
      order_key: row.order_key,
      issuance_config_intent_id: null,
      original_cents: 100,
      held_cents: 50,
      returned_cents: 50,
      status: 'held',
      released_at: null,
    });
    await insert('paper_settlement_event', {
      ...settlement,
      event_key: 'legacy-terminal-' + i,
      transition_key: 'legacy-terminal-' + i,
      order_key: row.order_key,
      outcome: 'INVALID',
      result_status: 'invalid',
      released_stake_cents: 50,
      potential_payout_cents: 100,
      payout_cents: 50,
      integer_realized_delta_cents: 0,
      order_revision_before: 620 + i,
      order_revision_after: 621 + i,
      budget_revision_before: 620 + i,
      budget_revision_after: 621 + i,
    });
    await rejects(
      insert('paper_settlement_event', {
        ...settlement,
        event_key: 'legacy-repeat-' + i,
        transition_key: 'legacy-repeat-' + i,
        order_key: row.order_key,
        released_stake_cents: 50,
        potential_payout_cents: 100,
        payout_cents: 100,
        integer_realized_delta_cents: 50,
        order_revision_before: 650 + i,
        order_revision_after: 651 + i,
        budget_revision_before: 650 + i,
        budget_revision_after: 651 + i,
      }),
      '23505',
    );
  }
  const legacySettlements = await writer.unsafe(
    "select order_key from engine.paper_settlement_event where event_key like 'legacy-terminal-%' order by order_key",
  );
  assert.deepEqual(
    legacySettlements.map((x) => x.order_key),
    ['restored-first', 'restored-second'],
  );
  // Each sale uniqueness case has only ONE occupied revision domain, not event/transition PK.
  await rejects(
    insert('paper_sale_event', {
      ...sale,
      event_key: 'isolated-sale-order',
      transition_key: 'isolated-sale-order',
      order_revision_before: 100,
      order_revision_after: 101,
      budget_revision_before: 700,
      budget_revision_after: 701,
    }),
    '23505',
  );
  await rejects(
    insert('paper_sale_event', {
      ...sale,
      event_key: 'isolated-sale-budget',
      transition_key: 'isolated-sale-budget',
      order_revision_before: 710,
      order_revision_after: 711,
      budget_revision_before: 100,
      budget_revision_after: 101,
    }),
    '23505',
  );
  // Literal exact decimals only: NOT a proof of the production JavaScript proportional codec.
  await insert('paper_sale_event', {
    ...sale,
    event_key: 'literal-decimal',
    transition_key: 'literal-decimal',
    order_revision_before: 800,
    order_revision_after: 801,
    budget_revision_before: 800,
    budget_revision_after: 801,
    raw_gross_proceeds_cents: '60.1',
    raw_net_proceeds_cents: '58.1',
    raw_actual_pnl_cents: '6.35',
  });
  const [decimal] = await writer.unsafe(
    "select raw_gross_proceeds_cents,raw_net_proceeds_cents,raw_actual_pnl_cents from engine.paper_sale_event where event_key='literal-decimal'",
  );
  assert.deepEqual(Object.values(decimal).map(Number), [60.1, 58.1, 6.35]);

  const tables = ['paper_sale_event', 'paper_settlement_event'];
  const snapshot = (t) => admin.unsafe('select * from engine.' + t + ' order by event_key');
  const before = await Promise.all(tables.map(snapshot));
  assert.equal(before[0].length, 6);
  assert.equal(before[1].length, 6);
  await admin.unsafe(
    readFileSync('services/platform-api/migrations/0006-paper-cycle-overlay.sql', 'utf8'),
  );
  assert.deepEqual(await Promise.all(tables.map(snapshot)), before);
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
    for (const [i, t] of tables.entries()) {
      if (sql === writer || sql === reader)
        assert.deepEqual(
          await sql.unsafe('select * from engine.' + t + ' order by event_key'),
          before[i],
        );
      else await denied(sql.unsafe('select * from engine.' + t), t);
      if (sql !== writer)
        await denied(
          insert(
            t,
            i === 0
              ? { ...sale, event_key: 'forbidden-' + name, transition_key: 'forbidden-' + name }
              : {
                  ...settlement,
                  event_key: 'forbidden-' + name,
                  transition_key: 'forbidden-' + name,
                },
            sql,
          ),
          t,
        );
      for (const q of [
        'update engine.' + t + ' set recorded_at=recorded_at',
        'delete from engine.' + t,
        'truncate engine.' + t,
      ])
        await denied(sql.unsafe(q), t);
    }
  }
  assert.deepEqual(await Promise.all(tables.map(snapshot)), before);
  // No runtime applies these plans; no unavailable attempt is fabricated or genuine CAS proven.
}
