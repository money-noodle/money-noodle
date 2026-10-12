// Hosted disposable storage conformance ONLY, not CAS/current authority/atomic money truth.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
export async function paperEntryEventPostgresContract(
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
  const effect = (key, revision) => ({
    transition_key: key,
    order_key: 'order-entry',
    funding_id: 'root-funding',
    epoch: 1,
    budget_id: 'root-actor:paper',
    order_row_kind: 'entry',
    effect_kind: 'entry-fill',
    current_effect_config_intent_id: 'root-other-config',
    run_id: 'root-paper-run',
    recorded_at: '2026-10-12T01:00:00Z',
    order_revision_before: revision,
    order_revision_after: revision + 1,
    reservation_revision_before: revision,
    reservation_revision_after: revision + 1,
    budget_revision_before: revision,
    budget_revision_after: revision + 1,
    result_status: 'open',
    reservation_before_cents: 100,
    retained_stake_cents: 7,
    released_cents: 93,
  });
  const fill = (key) => ({
    event_key: 'event-' + key,
    transition_key: key,
    order_key: 'order-entry',
    funding_id: 'root-funding',
    epoch: 1,
    budget_id: 'root-actor:paper',
    effect_kind: 'entry-fill',
    run_id: 'root-paper-run',
    current_effect_config_intent_id: 'root-other-config',
    evidence_version: 'synthetic-maker-v1',
    venue: 'kalshi',
    liquidity_role: 'maker',
    evidence_disposition: 'observed',
    no_fill_reason: null,
    observed_quantity: '0.25',
    finalized_quantity: '0.25',
    raw_purchase_cents: '6.25',
    fee_cents: 0,
    retained_stake_cents: 7,
    potential_payout_cents: 25,
    released_cents: 93,
    recorded_at: '2026-10-12T01:00:00Z',
  });
  // Synthetic expected revisions deliberately NOT equal to live rows: schema is not CAS.
  for (const [i, [patch, code]] of [
    [{ run_id: 'missing-run' }, '23503'],
    [{ current_effect_config_intent_id: 'missing-config' }, '23503'],
    [{ order_key: 'missing-order' }, '23503'],
    [{ funding_id: 'order-second-funding' }, '23503'],
    [{ effect_kind: null }, '23502'],
    [{ order_revision_after: 99 }, '23514'],
    [{ released_cents: 92 }, '23514'],
    [{ reservation_before_cents: '1.5' }, '22P02'],
    [{ recorded_at: 'infinity' }, '23514'],
  ].entries())
    await rejects(
      insert('paper_entry_effect', { ...effect('bad-effect-' + i, 100 + i), ...patch }),
      code,
    );
  await insert('paper_entry_effect', effect('positive-fill', 10));
  for (const [i, [patch, code]] of [
    [{ transition_key: 'missing-transition' }, '23503'],
    [{ run_id: 'missing-run' }, '23503'],
    [{ effect_kind: null }, '23502'],
    [{ finalized_quantity: '0.26' }, '23514'],
    [{ raw_purchase_cents: 'NaN' }, '23514'],
    [{ recorded_at: '-infinity' }, '23514'],
  ].entries())
    await rejects(
      insert('paper_entry_fill_event', {
        ...fill('positive-fill'),
        event_key: 'bad-fill-' + i,
        ...patch,
      }),
      code,
    );
  const zero = {
    effect_kind: 'entry-no-fill',
    observed_quantity: 0,
    finalized_quantity: 0,
    raw_purchase_cents: 0,
    fee_cents: 0,
    retained_stake_cents: 0,
    potential_payout_cents: 0,
    released_cents: 100,
  };
  // Valid local zero shape but mixed effect kind must fail the actual composite transition FK.
  await rejects(
    insert('paper_entry_fill_event', {
      ...fill('positive-fill'),
      ...zero,
      event_key: 'mixed-kind',
      no_fill_reason: 'rested_no_fill',
    }),
    '23503',
  );
  await insert('paper_entry_fill_event', fill('positive-fill'));
  await rejects(insert('paper_entry_effect', effect('positive-fill', 10)), '23505');
  await rejects(
    insert('paper_entry_fill_event', {
      ...fill('positive-fill'),
      event_key: 'duplicate-transition',
    }),
    '23505',
  );
  for (const [i, [disposition, reason, status]] of [
    ['observed', 'rested_no_fill', 'unfilled'],
    ['data-unavailable', 'data_unavailable', 'rejected'],
    ['quote-refused', 'pre_submit_quote_moved', 'unfilled'],
  ].entries()) {
    const key = 'zero-' + i;
    await insert('paper_entry_effect', {
      ...effect(key, 20 + i),
      effect_kind: 'entry-no-fill',
      result_status: status,
      retained_stake_cents: 0,
      released_cents: 100,
    });
    const row = {
      ...fill(key),
      ...zero,
      evidence_disposition: disposition,
      no_fill_reason: reason,
    };
    await rejects(
      insert('paper_entry_fill_event', {
        ...row,
        event_key: 'null-reason-' + i,
        no_fill_reason: null,
      }),
      '23514',
    );
    await insert('paper_entry_fill_event', row);
  }
  const [raw] = await writer.unsafe(
    "select raw_purchase_cents,retained_stake_cents from engine.paper_entry_fill_event where transition_key='positive-fill'",
  );
  assert.equal(Number(raw.raw_purchase_cents), 6.25);
  assert.equal(Number(raw.retained_stake_cents), 7);
  const tables = ['paper_entry_effect', 'paper_entry_fill_event'];
  const snapshot = (table) =>
    admin.unsafe(
      'select * from engine.' +
        table +
        ' order by ' +
        (table === 'paper_entry_effect' ? 'transition_key' : 'event_key'),
    );
  const before = await Promise.all(tables.map(snapshot));
  assert.equal(before[0].length, 4);
  assert.equal(before[1].length, 4);
  await admin.unsafe(
    readFileSync('services/platform-api/migrations/0006-paper-cycle-overlay.sql', 'utf8'),
  );
  assert.deepEqual(await Promise.all(tables.map(snapshot)), before);
  const denied = (p, table) =>
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
    for (const [i, table] of tables.entries()) {
      if (sql === writer || sql === reader)
        assert.deepEqual(
          await sql.unsafe(
            'select * from engine.' +
              table +
              ' order by ' +
              (i === 0 ? 'transition_key' : 'event_key'),
          ),
          before[i],
        );
      else await denied(sql.unsafe('select * from engine.' + table), table);
      if (sql !== writer)
        await denied(
          insert(
            table,
            i === 0 ? effect('forbidden-' + name, 200) : fill('forbidden-' + name),
            sql,
          ),
          table,
        );
      for (const statement of [
        'update engine.' + table + ' set recorded_at=recorded_at',
        'delete from engine.' + table,
        'truncate engine.' + table,
      ])
        await denied(sql.unsafe(statement), table);
    }
  }
  assert.deepEqual(await Promise.all(tables.map(snapshot)), before);
}
