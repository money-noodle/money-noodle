import {
  forecastStoreConformance,
  eventFailureConformance,
} from '../dist/test-support/forecast-store-conformance.js';
import { createHash } from 'node:crypto';
// Remote CI only. Disposable synthetic PostgreSQL: never accepts a database URL.
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { createPostgresForecastStore } from '../dist/adapters/engine-store/postgres-forecast-store.js';
import { runForecastTick } from '../dist/application/forecast-cycle.js';
import { createPostgresCycleStore } from '../dist/adapters/engine-store/postgres-cycle-store.js';
if (process.env.GITHUB_ACTIONS !== 'true')
  throw Error('This synthetic database contract runs only in remote GitHub CI.');
const name = 'mn-forecast-test-' + process.pid;
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
let admin, writer, store, cycle, blocker;
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
      // The image init server listens on a Unix socket before it restarts.
      // Require TCP readiness so a successful probe cannot race that restart.
      docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres');
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
  console.log('Synthetic schema migration and reapply completed.');
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
  const fields = {
    venue: 'polymarket',
    contractId: 'exact-contract',
    marketUrl: 'https://polymarket.com/event/test',
    closesAt: new Date(row.closesAt).toISOString(),
    rulesSource: 'https://gamma-api.polymarket.com/events?slug=test',
    rulesText: 'Simple average of the final minute',
    settlementPriceMethod: 'simple-average',
    referenceWindowSeconds: 60,
    settlementWindowSeconds: 60,
    comparability: 'approximate',
  };
  const hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  const canonicalSeed = {
    version: 'contract-provenance-v1',
    registryId: 'polymarket:exact-contract:' + hash,
    ...fields,
    rulesFingerprint: hash,
    slug: 'test',
  };
  const seed = {
    ...row,
    id: 'seed',
    venueContracts: { polymarket: { registryId: canonicalSeed.registryId } },
  };
  await admin.unsafe(
    "insert into engine.contract_provenance(registry_id,record,restore_run_id) values($1,$2::jsonb,'synthetic-restore')",
    [canonicalSeed.registryId, admin.json(canonicalSeed)],
  );
  await admin.unsafe(
    "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) values('seed','pending',$1::jsonb,'synthetic-restore')",
    [admin.json(seed)],
  );
  // SQL JSON columns must hold objects, not JSON-encoded strings. The driver's
  // json serializer owns serialization; pre-stringifying would encode twice.
  const shapes = await admin.unsafe(
    'select jsonb_typeof(row) as kind from engine.forecast_cycle_row union all select jsonb_typeof(row) from engine.forecast_row',
  );
  assert(
    shapes.every((r) => r.kind === 'object'),
    'All synthetic forecast JSON payloads are objects.',
  );
  const [seedShape] = await admin.unsafe(
    "select forecast_id,status,row->>'closesAt' as close,jsonb_typeof(row) as kind from engine.forecast_row where forecast_id='seed'",
  );
  assert.equal(seedShape.forecast_id, 'seed');
  assert.equal(seedShape.status, 'pending');
  assert.equal(seedShape.close, row.closesAt);
  assert.equal(seedShape.kind, 'object');
  console.log('Synthetic JSON object binding and restored seed setup verified.');
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
  const missingSeed = {
    ...row,
    id: 'missing-seed',
    venueContracts: { polymarket: { registryId: 'absent-registry-record' } },
  };
  await admin.unsafe(
    "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) values('missing-seed','pending',$1::jsonb,'synthetic-restore')",
    [admin.json(missingSeed)],
  );
  const badCases = [
    [
      'wrong-venue',
      {
        version: 'contract-provenance-v1',
        registryId: 'wrong-venue',
        venue: 'kalshi',
        contractId: 'wrong',
        closesAt: row.closesAt,
      },
    ],
    [
      'wrong-id',
      {
        version: 'contract-provenance-v1',
        registryId: 'different-canonical-id',
        venue: 'polymarket',
        contractId: 'wrong',
        closesAt: row.closesAt,
      },
    ],
    [
      'bad-date',
      {
        version: 'contract-provenance-v1',
        registryId: 'bad-date',
        venue: 'polymarket',
        contractId: 'wrong',
        closesAt: 'invalid-date',
      },
    ],
  ];
  for (const [key, record] of badCases) {
    await admin.unsafe(
      "insert into engine.contract_provenance(registry_id,record,restore_run_id) values($1,$2::jsonb,'synthetic-restore')",
      [key, admin.json(record)],
    );
    await admin.unsafe(
      "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) values($1,'pending',$2::jsonb,'synthetic-restore')",
      [
        'bad-' + key,
        admin.json({
          ...row,
          id: 'bad-' + key,
          venueContracts: { polymarket: { registryId: key } },
        }),
      ],
    );
  }
  // Isolate malformed targets from the earlier unrelated synthetic legacy rows.
  await admin.unsafe(
    "update engine.forecast_cycle_row set status='resolved',row=jsonb_set(row,'{status}','\"resolved\"'::jsonb) where forecast_id like 'synthetic-observation%'",
  );
  for (const [id, reference] of [
    ['null-ref', null],
    ['full-mismatch', { ...canonicalSeed, contractId: 'wrong-contract-B' }],
  ])
    await admin.unsafe(
      "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) values($1,'pending',$2::jsonb,'synthetic-restore')",
      [id, admin.json({ ...row, id, venueContracts: { polymarket: reference } })],
    );
  const requested = [];
  await runForecastTick(
    store,
    {
      calculate: async () => [],
      resolve: async (contract) => {
        requested.push(contract.contractId);
        assert.equal(typeof contract.contractId, 'string');
        return null;
      },
    },
    grant,
    () => new Date(),
  );
  assert(
    !requested.includes(undefined),
    'Malformed registry references must never reach a provider.',
  );
  const [missingOverlay] = await admin.unsafe(
    "select row,origin_restore_run_id from engine.forecast_cycle_row where forecast_id='missing-seed'",
  );
  for (const id of ['null-ref', 'full-mismatch']) {
    const [bad] = await admin.unsafe(
      'select row,origin_restore_run_id from engine.forecast_cycle_row where forecast_id=$1',
      [id],
    );
    assert.equal(bad.row.targetIntegrity, 'missing-provenance');
    assert.equal(bad.origin_restore_run_id, 'synthetic-restore');
  }
  assert.equal(missingOverlay.row.status, 'invalid');
  assert.equal(missingOverlay.row.targetIntegrity, 'missing-provenance');
  assert.equal(missingOverlay.row.invalidReason, 'missing-provenance');
  assert.equal(missingOverlay.origin_restore_run_id, 'synthetic-restore');
  assert.deepEqual(
    (await admin.unsafe("select row from engine.forecast_row where forecast_id='missing-seed'"))[0]
      .row,
    missingSeed,
  );
  console.log(
    'Synthetic real-store missing-provenance disposition and seed immutability verified.',
  );
  // Eligibility precedes the cap; restored and runtime overlays share fairness.
  const fairNow = new Date(now.getTime() + 3600000);
  const backed = {
    ...row,
    status: 'pending',
    lastResolutionCheckAt: fairNow.toISOString(),
    resolutionAttempts: 5,
  };
  await admin.unsafe(
    "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) select 'a-backoff-'||i,'pending',jsonb_set($1::jsonb,'{id}',to_jsonb('a-backoff-'||i)),'synthetic-restore' from generate_series(1,2000) i",
    [admin.json(backed)],
  );
  for (let i = 0; i < 21; i++) {
    const id = 'z-fair-' + String(i).padStart(2, '0');
    await admin.unsafe(
      "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) values($1,'pending',$2::jsonb,'synthetic-restore')",
      [
        id,
        admin.json({
          ...row,
          id,
          symbol: 'FAIR' + String(i).padStart(2, '0'),
          status: 'pending',
          venueContracts: {},
          lastResolutionCheckAt: undefined,
        }),
      ],
    );
  }
  const fairFirst = (await store.readDueForecasts(fairNow, 2000)).filter((r) =>
    r.id.startsWith('z-fair-'),
  );
  assert.equal(fairFirst.length, 20);
  assert(!fairFirst.some((r) => r.id === 'z-fair-20'));
  assert(!(await store.readDueForecasts(fairNow, 2000)).some((r) => r.id.startsWith('a-backoff-')));
  for (const selected of fairFirst)
    await store.patchForecast(grant, selected, {
      ...selected.row,
      lastResolutionCheckAt: fairNow.toISOString(),
      resolutionAttempts: 1,
    });
  assert((await store.readDueForecasts(fairNow, 2000)).some((r) => r.id === 'z-fair-20'));
  console.log('Synthetic real-store 2000 backoff rows and 21-cycle fairness verified.');
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
  const conformRow = {
    ...row,
    id: 'shared-conformance',
    symbol: 'CONFORMANCE',
    closesAt: new Date(now.getTime() + 300000).toISOString(),
  };
  const conformSnapshot = async () => {
    const [counts] = await admin.unsafe(
      'select (select count(*) from engine.forecast_cycle)::int cycles,(select count(*) from engine.forecast_oracle_sample)::int samples,(select count(*) from engine.forecast_cycle_row)::int rows,(select count(*) from engine.forecast_cycle_event)::int events',
    );
    const [meta] = await admin.unsafe(
      'select revision::int,origin_run_id,origin_restore_run_id,last_run_id from engine.forecast_cycle_row where forecast_id=$1',
      [conformRow.id],
    );
    const events = await admin.unsafe(
      'select revision::int from engine.forecast_cycle_event where forecast_id=$1 order by revision',
      [conformRow.id],
    );
    return {
      ...counts,
      revision: meta?.revision ?? null,
      originRunId: meta?.origin_run_id ?? null,
      originRestoreRunId: meta?.origin_restore_run_id ?? null,
      lastRunId: meta?.last_run_id ?? null,
      eventRevisions: events.map((e) => e.revision),
    };
  };
  await forecastStoreConformance(
    store,
    grant,
    conformRow,
    { ...input, asset: 'CONFORMANCE' },
    conformSnapshot,
  );
  const eventFailure = createPostgresForecastStore(writerUrl, {
    beforeEvent: () => {
      throw Error('Synthetic event-stage failure');
    },
  });
  await eventFailureConformance(
    eventFailure,
    grant,
    {
      ...row,
      id: 'event-stage',
      symbol: 'EVENT-ROLLBACK',
      closesAt: new Date(now.getTime() + 600000).toISOString(),
    },
    { ...input, asset: 'EVENT-ROLLBACK' },
    conformSnapshot,
  );
  await eventFailure.close();
  console.log(
    'Shared real/fake timestamp, duplicate, FK, revision, event-key and terminal conformance plus event-stage rollback verified.',
  );
  const missingRunBefore = await conformSnapshot();
  await admin.unsafe(
    "update engine.job_lease set owner='missing-run-fk' where capability='budget:paper'",
  );
  await assert.rejects(
    store.recordObservation(
      { ...grant, owner: 'missing-run-fk' },
      {
        ...row,
        id: 'missing-run-observation',
        symbol: 'MISSING-RUN',
        closesAt: new Date(now.getTime() + 700000).toISOString(),
      },
      { ...input, asset: 'MISSING-RUN' },
    ),
    /foreign key/,
  );
  assert.deepEqual(await conformSnapshot(), missingRunBefore);
  await admin.unsafe("update engine.job_lease set owner=$1 where capability='budget:paper'", [
    grant.owner,
  ]);
  // A constraint failure after inserting the cycle must roll back every earlier mutation.
  const invalid = {
    ...row,
    id: 'invalid-price',
    symbol: 'ROLLBACK',
    closesAt: new Date(now.getTime() + 60000).toISOString(),
  };
  await assert.rejects(
    store.recordObservation(grant, invalid, { ...input, asset: 'ROLLBACK', currentPrice: -1 }),
  );
  assert.equal(
    Number(
      (await admin.unsafe("select count(*) n from engine.forecast_cycle where asset='ROLLBACK'"))[0]
        .n,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await admin.unsafe(
          "select count(*) n from engine.forecast_cycle_row where forecast_id='invalid-price'",
        )
      )[0].n,
    ),
    0,
  );
  await assert.rejects(
    store.patchForecast(grant, restored, { ...restored.row, id: 'wrong-identity' }),
    /identity mismatch/,
  );
  // Hold a conflicting unique cycle key after the writer's initial lease check.
  // Expiry must reject the resumed mutation and roll back the complete transaction.
  blocker = postgres(url, { max: 1, prepare: false });
  let unlock, announce;
  const locked = new Promise((resolve) => {
    announce = resolve;
  });
  const release = new Promise((resolve) => {
    unlock = resolve;
  });
  const expiresClose = new Date(now.getTime() + 120000).toISOString();
  await admin.unsafe(
    "update engine.job_lease set expires_at=clock_timestamp()+interval '300 milliseconds' where capability='budget:paper'",
  );
  const blocking = blocker.begin(async (tx) => {
    await tx.unsafe(
      "insert into engine.forecast_cycle(asset,closes_at,first_run_id) values('EXPIRY',$1,'synthetic-run')",
      [expiresClose],
    );
    announce();
    await release;
  });
  await locked;
  const late = store.recordObservation(
    grant,
    { ...row, id: 'late-write', symbol: 'EXPIRY', closesAt: expiresClose },
    { ...input, asset: 'EXPIRY' },
  );
  // Observe rejection immediately to avoid an unhandled promise while the blocker is held.
  const rejected = assert.rejects(late, /live lease/);
  await delay(600);
  unlock();
  await blocking;
  await rejected;
  assert.equal(
    Number(
      (
        await admin.unsafe(
          "select count(*) n from engine.forecast_cycle_row where forecast_id='late-write'",
        )
      )[0].n,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await admin.unsafe(
          "select count(*) n from engine.forecast_oracle_sample where asset='EXPIRY'",
        )
      )[0].n,
    ),
    0,
  );
  console.log('Synthetic constraint rollback and expiry-after-lock rollback verified.');
  await admin.unsafe(
    "update engine.job_lease set expires_at=acquired_at where capability='budget:paper'",
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
  if (blocker) await blocker.end({ timeout: 5 });
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
