#!/usr/bin/env node
// Entrypoint of the `engine-cycle` job (ADR-0013 §1, #243 stage 1). One image,
// one entrypoint per job: `dist/cycle/main.js`, beside `dist/restore/main.js`.
//
// Every input is an argument or a non-secret environment variable. The
// `engine_writer` connection string arrives by reference from Secret Manager as
// ENGINE_CYCLE_WRITER_DATABASE_URL and never appears here, in a plan or in state.
//
//   cycle [--mode dry|forecast|paper] [--ticks <n>] [--run-id <id>]
//
// Exit codes say whether the **job** worked, not whether the engine ran. A
// refusal — paused intent, a held lease, a spent run id, an unported mode — is
// the job working, so it exits 0 and says why in one JSON line. Exit 1 is for an
// unexpected error, and exit 2 for an input this entrypoint will not accept.
// Anything else would make Cloud Run retry a correct refusal.

import { randomUUID } from 'node:crypto';

import { createPostgresCycleStore } from '../adapters/engine-store/postgres-cycle-store.js';
import { runCycleJob } from '../application/cycle.js';
import { createPostgresForecastStore } from '../adapters/engine-store/postgres-forecast-store.js';
import { createPublicForecastFeeds } from '../adapters/feeds/forecast-feeds.js';
import { CYCLE_MODES, DEFAULT_TICKS, isCycleMode, type CycleMode } from '../domain/cycle-store.js';

const WRITER_URL_ENV = 'ENGINE_CYCLE_WRITER_DATABASE_URL';
const CONTROL_EPOCH_ENV = 'ENGINE_CYCLE_CONTROL_EPOCH';
const EXECUTION_ENV = 'CLOUD_RUN_EXECUTION';

/** The same default the API's `PLATFORM_API_ENGINE_CONTROL_EPOCH` carries. */
export const DEFAULT_CONTROL_EPOCH = 1;

/** More than one scheduled minute of ticks is a run that outlives its trigger. */
const MAX_TICKS = 60;

function argument(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline === undefined ? undefined : inline.slice(flag.length + 1);
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.length === 0) return fallback;
  // The whole string must be digits. `parseInt` reads "1.5" as 1, and a silently
  // truncated epoch is exactly the quiet wrong answer the staleness rule cannot
  // survive — the same reasoning the API's own epoch reader records.
  const parsed = /^[0-9]{1,9}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function main(): Promise<number> {
  const rawMode = argument('mode') ?? 'dry';
  if (!isCycleMode(rawMode)) {
    console.error(`--mode must be one of: ${CYCLE_MODES.join(', ')}`);
    return 2;
  }
  const mode: CycleMode = rawMode;

  let ticks: number;
  let controlEpoch: number;
  try {
    ticks = positiveInteger(argument('ticks'), DEFAULT_TICKS, '--ticks');
    controlEpoch = positiveInteger(
      process.env[CONTROL_EPOCH_ENV],
      DEFAULT_CONTROL_EPOCH,
      CONTROL_EPOCH_ENV,
    );
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (ticks > MAX_TICKS) {
    console.error(`--ticks must be at most ${MAX_TICKS}; a longer run outlives its trigger.`);
    return 2;
  }

  // The Cloud Run execution name is the run id, so the platform's own retry of an
  // execution re-enters the same recorded run and writes nothing. `--run-id` is
  // for a run started by hand; a uuid is the last resort and means this run is
  // idempotent against nothing but itself.
  const runId = process.env[EXECUTION_ENV] ?? argument('run-id') ?? randomUUID();

  const connectionString = process.env[WRITER_URL_ENV];
  if (connectionString === undefined || connectionString.trim().length === 0) {
    console.error(
      `${WRITER_URL_ENV} is not set; the job connects only as engine_writer by reference.`,
    );
    return 2;
  }

  const store = createPostgresCycleStore(connectionString);
  const forecastStore = mode === 'forecast' ? createPostgresForecastStore(connectionString) : null;
  try {
    const result = await runCycleJob({
      ...(forecastStore === null
        ? {}
        : { forecast: { store: forecastStore, feeds: createPublicForecastFeeds() } }),
      controlEpoch,
      mode,
      now: () => new Date(),
      runId,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      store,
      ticks,
    });
    // One line, counts and codes only: no connection string, no row content, no
    // account identifier (SECURITY.md).
    console.log(
      JSON.stringify({
        capability: result.capability,
        fencingToken: result.fencingToken,
        intentId: result.intentId,
        mode: result.mode,
        outcome: result.outcome,
        reason: result.reason,
        runId: result.runId,
        ticksCompleted: result.ticksCompleted,
      }),
    );
    // A refusal is the job working.
    return 0;
  } finally {
    await store.close();
    if (forecastStore !== null) await forecastStore.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
