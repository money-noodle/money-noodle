// Remote CI only. Disposable synthetic PostgreSQL: never accepts a database URL.
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { createPostgresForecastStore } from '../dist/adapters/engine-store/postgres-forecast-store.js';
import { createPostgresCycleStore } from '../dist/adapters/engine-store/postgres-cycle-store.js';
if (process.env.GITHUB_ACTIONS !== 'true')
  throw Error('This synthetic database contract runs only in remote GitHub CI.');
const name = 'mn-forecast-test-' + process.pid;
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
let admin, writer, store, cycle;
try {
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16-alpine',
  );
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', name, 'pg_isready', '-U', 'postgres');
      ready = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  assert(ready, 'Synthetic database readiness');
  const port = docker('port', name, '5432/tcp').trim().split(':').at(-1);
  // Loopback only; credentials are not used. Container deleted in finally.
  const url = 'postgres://postgres@127.0.0.1:' + port + '/postgres';
  admin = postgres(url, { max: 1, prepare: false });
  for (const file of [
    '0001-identity-budgets-and-control.sql',
    '0002-engine-restore-tables.sql',
    '0003-ledger-order-position.sql',
    '0004-engine-cycle-lease-and-runs.sql',
    '0005-forecast-cycle-overlay.sql',
  ]) {
    const sql = readFileSync('services/platform-api/migrations/' + file, 'utf8').replaceAll(
      ":'account_id'",
      "'synthetic-test-account'",
    );
    await admin.unsafe(sql);
  }
  await admin.unsafe(
    readFileSync('services/platform-api/migrations/0005-forecast-cycle-overlay.sql', 'utf8'),
  );
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';
  writer = postgres(writerUrl, { max: 1, prepare: false });
  store = createPostgresForecastStore(writerUrl);
  cycle = createPostgresCycleStore(writerUrl);
  const now = new Date(),
    acquired = await cycle.acquireLease({
      capability: 'budget:paper',
      owner: 'synthetic-run',
      now,
      expiresAt: new Date(now.getTime() + 120000),
    });
  assert(acquired.acquired);
  const grant = acquired.grant;
  await cycle.openRunRecord(grant, {
    runId: grant.owner,
    capability: grant.capability,
    mode: 'forecast',
    startedAt: now,
  });
  await admin.unsafe(
    "insert into engine.restore_run(run_id,manifest_digest,manifest_key,schema_version,started_at) values('synthetic-restore','synthetic-digest','synthetic-key','test',now())",
  );
  const row = {
    id: 'synthetic-observation',
    symbol: 'BTC',
    closesAt: new Date(now.getTime() - 60000).toISOString(),
    issuedAt: new Date(now.getTime() - 120000).toISOString(),
    probabilityUp: 0.6,
    confidence: 0.7,
    qualified: true,
    direction: 'UP',
    status: 'pending',
    marketUrl: 'https://example.invalid/test',
    venueContracts: {},
    candidateEvaluation: [],
    basisProbabilityUp: 0.6,
    slowTiltLogOdds: 0,
    modelVersion: 'test',
  };
  const input = { asset: 'BTC', calculatedAt: now.toISOString(), currentPrice: 100 };
  assert.equal(await store.recordObservation(grant, row, input), true);
  assert.equal(await store.recordObservation(grant, row, input), false);
  for (let i = 1; i < 4; i++)
    assert.equal(
      await store.recordObservation(
        grant,
        {
          ...row,
          id: row.id + '-' + i,
          issuedAt: new Date(now.getTime() + i * 15000).toISOString(),
        },
        { ...input, calculatedAt: new Date(now.getTime() + i * 15000).toISOString() },
      ),
      true,
    );
  assert.equal(
    Number((await admin.unsafe('select count(*) n from engine.forecast_cycle'))[0].n),
    1,
  );
  assert.equal(
    Number((await admin.unsafe('select count(*) n from engine.forecast_cycle_row'))[0].n),
    4,
  );
  await assert.rejects(
    store.recordObservation(
      { ...grant, fencingToken: grant.fencingToken + 1 },
      { ...row, id: 'stale-token' },
      input,
    ),
  );
  assert.equal(
    Number((await admin.unsafe('select count(*) n from engine.forecast_cycle_row'))[0].n),
    4,
  );
  const seed = {
    ...row,
    id: 'seed',
    venueContracts: { polymarket: { registryId: 'synthetic-ref' } },
  };
  await admin.unsafe(
    "insert into engine.contract_provenance(registry_id,record,restore_run_id) values('synthetic-ref',$1::jsonb,'synthetic-restore')",
    [
      JSON.stringify({
        venue: 'polymarket',
        contractId: 'exact-contract',
        closesAt: row.closesAt,
        slug: 'test',
      }),
    ],
  );
  await admin.unsafe(
    "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) values('seed','pending',$1::jsonb,'synthetic-restore')",
    [JSON.stringify(seed)],
  );
  const restored = (await store.readDueForecasts(now, 2000)).find((r) => r.id === 'seed');
  assert(restored);
  assert.equal(restored.row.venueContracts.polymarket.contractId, 'exact-contract');
  assert.equal(await store.recordObservation(grant, { ...row, id: 'seed' }, input), false);
  await store.patchForecast(grant, restored, {
    ...restored.row,
    status: 'resolved',
    outcome: 'UP',
  });
  await store.patchForecast(grant, restored, {
    ...restored.row,
    status: 'resolved',
    outcome: 'DOWN',
  });
  const overlay = (
    await admin.unsafe(
      "select row,origin_restore_run_id,origin_run_id from engine.forecast_cycle_row where forecast_id='seed'",
    )
  )[0];
  assert.equal(overlay.row.outcome, 'UP');
  assert.equal(overlay.origin_restore_run_id, 'synthetic-restore');
  assert.equal(overlay.origin_run_id, null);
  assert.deepEqual(
    (await admin.unsafe("select row from engine.forecast_row where forecast_id='seed'"))[0].row,
    seed,
  );
  for (const table of [
    'forecast_cycle',
    'forecast_cycle_row',
    'forecast_cycle_event',
    'forecast_oracle_sample',
  ]) {
    const [rights] = await admin.unsafe(
      "select has_table_privilege('engine_reader',$1,'INSERT') reader_write,has_table_privilege('engine_control_recorder',$1,'SELECT') recorder_read,has_table_privilege('engine_writer',$1,'DELETE') writer_delete",
      ['engine.' + table],
    );
    assert.equal(rights.reader_write, false);
    assert.equal(rights.recorder_read, false);
    assert.equal(rights.writer_delete, false);
  }
  await assert.rejects(writer.unsafe("update engine.forecast_cycle_event set event='{}'::jsonb"));
  await admin.unsafe(
    "update engine.job_lease set expires_at=clock_timestamp()-interval '1 second' where capability='budget:paper'",
  );
  await assert.rejects(store.recordObservation(grant, { ...row, id: 'expired' }, input));
  await assert.rejects(cycle.heartbeat(grant, new Date(), new Date(Date.now() + 10000)));
  const [absent] = await admin.unsafe(
    "select count(*) n from engine.forecast_cycle_row where forecast_id in ('expired','stale-token')",
  );
  assert.equal(Number(absent.n), 0);
  console.log(
    'Synthetic PostgreSQL migration/reapply/lease-expiry/provenance/overlay/uniqueness/role contract passed.',
  );
} finally {
  if (store) await store.close();
  if (cycle) await cycle.close();
  if (writer) await writer.end({ timeout: 5 });
  if (admin) await admin.end({ timeout: 5 });
  try {
    docker('stop', '--time', '1', name);
  } catch {
    /* Preserve the original test failure. */
  }
}
