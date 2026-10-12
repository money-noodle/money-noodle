// Isolated schema constraints/privileges ONLY, not paper transaction/authority proof.
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { paperOrderPostgresContract } from './paper-order-postgres.mjs';
import { paperEntryEventPostgresContract } from './paper-entry-event-postgres.mjs';
import { paperSaleSettlementPostgresContract } from './paper-sale-settlement-postgres.mjs';
import { paperGatePostgresContract } from './paper-gate-postgres.mjs';
export async function paperRootPostgresContract(admin, writer, port) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !/^\d+$/.test(port))
    throw Error('Hosted disposable loopback test only.');
  const connections = [];
  const role = (name) => {
    const sql = postgres('postgres://' + name + '@127.0.0.1:' + port + '/postgres', {
      max: 1,
      prepare: false,
    });
    connections.push(sql);
    return sql;
  };
  const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);
  try {
    await admin.unsafe(
      "insert into engine.job_run_record(run_id,capability,mode,started_at,outcome,reason) values('root-paper-run','budget:paper','paper',now(),'applied','synthetic-root-test')",
    );
    await admin.unsafe(
      "insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id) values('root-config','budget:paper','configure','root-actor',1,now(),'root-paper-run'),('root-other-config','budget:paper','configure','root-actor',1,now(),'root-paper-run')",
    );
    await admin.unsafe(
      "insert into engine.restore_run(run_id,manifest_digest,manifest_key,schema_version,started_at) values('root-restore','root-digest','root-key','synthetic',now())",
    );
    await admin.unsafe(
      "insert into engine.ledger_state(key,value,restore_run_id) values('root-source','{}','root-restore')",
    );
    const base = {
      id: 'root-funding',
      epoch: 1,
      budget: 'root-actor:paper',
      actor: 'root-actor',
      birthConfig: 'root-config',
      run: 'root-paper-run',
      restore: null,
      source: null,
      last: 'root-paper-run',
    };
    // Bind text before the server timestamp cast: driver Date serializer cannot encode infinity.
    const funding = (sql, r) =>
      sql.unsafe(
        'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,origin_restore_run_id,restored_source_state_key,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::timestamptz)',
        [
          r.id,
          r.epoch,
          r.budget,
          r.actor,
          r.birthConfig,
          r.run,
          r.restore,
          r.source,
          r.last,
          r.recordedAt ?? '2026-10-11T23:00:00Z',
        ],
      );
    await funding(writer, base);
    await funding(writer, {
      ...base,
      id: 'root-restored',
      run: null,
      restore: 'root-restore',
      source: 'root-source',
    });
    // Separate restore/source FKs prove existence only, NOT that association or current authority.
    const invalidFunding = [
      [{ run: null }, '23514'],
      [{ restore: 'root-restore', source: 'root-source' }, '23514'],
      [{ run: null, restore: 'root-restore' }, '23514'],
      [{ source: 'root-source' }, '23514'],
      [{ budget: 'wrong:paper' }, '23514'],
      [{ epoch: 0 }, '23514'],
      [{ birthConfig: 'absent-config' }, '23503'],
      [{ run: 'absent-run' }, '23503'],
      [{ last: 'absent-run' }, '23503'],
      [{ run: null, restore: 'absent-restore', source: 'root-source' }, '23503'],
      [{ run: null, restore: 'root-restore', source: 'absent-state' }, '23503'],
    ];
    for (const [i, [patch, code]] of invalidFunding.entries())
      await rejects(funding(writer, { ...base, id: 'root-invalid-' + i, ...patch }), code);
    // Raw identity rejects, no silent trimming. SQL chars != JS UTF16/Unicode decoder domain.
    for (const value of [
      ' f',
      'f ',
      '\tf',
      'f\t',
      '\nf',
      'f\n',
      ' ',
      '\t',
      '\n',
      'f'.repeat(121),
      ' '.repeat(121) + 'f',
    ])
      await rejects(funding(writer, { ...base, id: value }), '23514');
    for (const actor of [' a', 'a ', '\ta', 'a\n', 'a'.repeat(115)])
      await rejects(
        funding(writer, {
          ...base,
          id: 'bad-actor-' + actor.length,
          actor,
          budget: actor + ':paper',
        }),
        '23514',
      );
    for (const budget of [
      ' ' + base.budget,
      base.budget + '\t',
      '\n' + base.budget,
      'b'.repeat(121),
    ])
      await rejects(
        funding(writer, { ...base, id: 'bad-budget-' + budget.length, budget }),
        '23514',
      );
    const boundaryActor = 'a'.repeat(114);
    await funding(writer, {
      ...base,
      id: 'boundary-root',
      actor: boundaryActor,
      budget: boundaryActor + ':paper',
    });
    for (const recordedAt of ['infinity', '-infinity'])
      await rejects(
        funding(writer, { ...base, id: 'infinite-funding-' + recordedAt, recordedAt }),
        '23514',
      );
    const balance = {
      id: base.id,
      epoch: 1,
      budget: base.budget,
      birthConfig: base.birthConfig,
      latest: base.birthConfig,
      start: 100,
      available: 105,
      reserved: 0,
      realized: 7,
      correction: -2,
      revision: 1,
      last: base.last,
    };
    const budget = (sql, r) =>
      sql.unsafe(
        'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::timestamptz)',
        [
          r.id,
          r.epoch,
          r.budget,
          r.birthConfig,
          r.latest,
          r.start,
          r.available,
          r.reserved,
          r.realized,
          r.correction,
          r.revision,
          r.last,
          r.recordedAt ?? '2026-10-11T23:00:00Z',
        ],
      );
    const snapshot = () =>
      admin.unsafe('select * from engine.paper_budget_root order by funding_id,epoch,budget_id');
    const before = await snapshot();
    for (const [patch, code] of [
      [{ id: 'absent-funding' }, '23503'],
      [{ epoch: 2 }, '23503'],
      [{ budget: 'other:paper' }, '23503'],
      [{ birthConfig: 'root-other-config' }, '23503'],
      [{ latest: 'absent-intent' }, '23503'],
      [{ last: 'absent-run' }, '23503'],
      [{ available: 104 }, '23514'],
      [{ available: -1 }, '23514'],
      [{ start: 1000000000001 }, '23514'],
      [{ revision: 0 }, '23514'],
      [{ realized: 1000000000001 }, '23514'],
      [{ correction: -1000000000001 }, '23514'],
      [{ reserved: -1 }, '23514'],
      [{ start: '1.5' }, '22P02'],
    ])
      await rejects(budget(writer, { ...balance, ...patch }), code);
    assert.deepEqual(await snapshot(), before);
    // No existing balance PK: finite-time CHECK failure cannot be masked by uniqueness.
    for (const recordedAt of ['infinity', '-infinity'])
      await rejects(budget(writer, { ...balance, recordedAt }), '23514');
    await budget(writer, balance);
    const duplicateBefore = await snapshot();
    await rejects(funding(writer, base), '23505');
    await rejects(budget(writer, balance), '23505');
    assert.deepEqual(await snapshot(), duplicateBefore);
    assert.equal((await writer.unsafe('select current_user as role'))[0].role, 'engine_writer');
    await writer.unsafe(
      "update engine.paper_budget_root set available_cents=100,reserved_cents=5,revision=2 where funding_id='root-funding'",
    );
    const [updated] = await snapshot();
    assert.equal(Number(updated.available_cents), 100);
    assert.equal(Number(updated.reserved_cents), 5);
    assert.equal(Number(updated.revision), 2);
    // C2 exists, same funding/epoch: retain birth C1 while advancing latest intent.
    // Storage shape only, NOT a valid current configure/resume snapshot proof.
    await writer.unsafe(
      "update engine.paper_budget_root set latest_intent_id='root-other-config',revision=3 where funding_id='root-funding'",
    );
    const [reconfigured] = await snapshot();
    assert.equal(reconfigured.birth_config_intent_id, 'root-config');
    assert.equal(reconfigured.latest_intent_id, 'root-other-config');
    const fundingSnapshot = () =>
      admin.unsafe('select * from engine.paper_funding_root order by funding_id,epoch,budget_id');
    const populatedFunding = await fundingSnapshot(),
      populatedBudget = await snapshot();
    await admin.unsafe(
      readFileSync('services/platform-api/migrations/0006-paper-cycle-overlay.sql', 'utf8'),
    );
    assert.deepEqual(await fundingSnapshot(), populatedFunding);
    assert.deepEqual(await snapshot(), populatedBudget);
    // Real writer UPDATE remains allowed after populated reapply, without changing data.
    await writer.unsafe('update engine.paper_budget_root set available_cents=available_cents');
    assert.deepEqual(await snapshot(), populatedBudget);
    // Subsequent real-role allowed SELECT and forbidden operations run AFTER reapply.
    for (const table of ['paper_funding_root', 'paper_budget_root']) {
      await rejects(writer.unsafe('delete from engine.' + table), '42501');
      await rejects(writer.unsafe('truncate engine.' + table), '42501');
    }
    await rejects(writer.unsafe('update engine.paper_funding_root set actor=actor'), '42501');
    const reader = role('engine_reader'),
      recorder = role('engine_control_recorder');
    // Probe PUBLIC-inherited table privileges with schema USAGE only: not owner/catalog-only proof.
    await admin.unsafe('create role synthetic_public_probe login');
    await admin.unsafe('grant usage on schema engine to synthetic_public_probe');
    const publicOnly = role('synthetic_public_probe');
    for (const sql of [reader, recorder, publicOnly]) {
      const [identity] = await sql.unsafe('select current_user as role');
      assert.notEqual(identity.role, 'postgres');
      if (sql === reader) {
        assert.equal((await sql.unsafe('select * from engine.paper_funding_root')).length, 3);
        assert.equal((await sql.unsafe('select * from engine.paper_budget_root')).length, 1);
      } else
        for (const table of ['paper_funding_root', 'paper_budget_root'])
          await rejects(sql.unsafe('select * from engine.' + table), '42501');
      await rejects(funding(sql, { ...base, id: 'forbidden' }), '42501');
      await rejects(budget(sql, balance), '42501');
      for (const table of ['paper_funding_root', 'paper_budget_root']) {
        await rejects(
          sql.unsafe('update engine.' + table + ' set recorded_at=recorded_at'),
          '42501',
        );
        await rejects(sql.unsafe('delete from engine.' + table), '42501');
        await rejects(sql.unsafe('truncate engine.' + table), '42501');
      }
    }
    // Extend fixtures only AFTER unchanged root cardinality/role assertions.
    await paperOrderPostgresContract(admin, writer, { reader, recorder, publicOnly });
    await paperEntryEventPostgresContract(admin, writer, { reader, recorder, publicOnly });
    await paperSaleSettlementPostgresContract(admin, writer, { reader, recorder, publicOnly });
    await paperGatePostgresContract(admin, writer, { reader, recorder, publicOnly });
    console.log(
      'Paper root ONLY: reapply/fixture FK/XOR/binding/bounds/correction-conservation/duplicate and actual low-role privilege assertions passed; NOT paper adapter/transaction/current-authority proof.',
    );
  } finally {
    await Promise.all(connections.map((sql) => sql.end({ timeout: 5 })));
  }
}
