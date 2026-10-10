// The `engine-cycle` job, end to end, over one port (#243 stage 1).
//
// Stage 1 is the skeleton: the lease, the run record, the intent evaluation, the
// tick loop and the outcome rows. It performs no cycle, calls no feed, reads no
// market and writes nothing beyond those four things. Stages 2 and 3 port the
// forecast lane and the paper engine into the tick body; this file is the frame
// they land in, and the frame is the part that has to be right first — a cadence
// that can run twice, or run while paused, is not made safe by what it does
// inside a tick.
//
// The order is deliberate:
//
//   1. take the lease, so two executions cannot both get past this line;
//   2. check the run id, so a Scheduler retry of a recorded run writes nothing;
//   3. open this run's record, so a crash still leaves the run id spent;
//   4. evaluate intent, and refuse if the engine is paused or the row is stale;
//   5. refuse a mode later stages implement, before any tick body exists;
//   6. tick, with a heartbeat each time;
//   7. append exactly one outcome row against the intent that was evaluated;
//   8. update the job-health row;
//   9. release the lease.
//
// Intent is evaluated before the mode check on purpose. A paused engine reports
// `intent-paused`, not a mode problem, because paused is the stronger statement;
// and the mode gate still sits before every tick, so a premature `cycle.tfvars`
// change cannot execute an unported lane.
//
// A refusal is the job working. Every refusal path closes the run record,
// updates job health and releases the lease, and the entrypoint exits 0.

import {
  leaseExpiry,
  TICK_INTERVAL_MS,
  type CycleMode,
  type CycleOutcome,
  type CycleReason,
  type CycleStore,
  type LeaseGrant,
} from '../domain/cycle-store.js';
import { evaluateIntent, type IntentRow } from '../domain/intent.js';
import { runForecastTick } from './forecast-cycle.js';
import type { ForecastFeeds, ForecastStore } from '../domain/forecast.js';

/** How many intent rows to read. The decision needs the latest; this is head-room. */
export const INTENT_READ_LIMIT = 50;

/** The capability the cycle job is governed by: the one the API records paper controls under. */
export const CYCLE_CAPABILITY = 'budget:paper';

/**
 * The key the cycle job's job-health row carries. `engine.job_run` is keyed by
 * capability and the signed-in view lists every row, so the job gets its own key
 * rather than overwriting the paper budget's (supervisor decision 2026-10-09).
 */
export const CYCLE_JOB_RUN_CAPABILITY = 'engine-cycle';

export interface CycleJobInput {
  readonly store: CycleStore;
  readonly mode: CycleMode;
  readonly ticks: number;
  readonly runId: string;
  readonly controlEpoch: number;
  readonly now: () => Date;
  /** Injected so a test does not wait 15 seconds a tick. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly forecast?: { readonly store: ForecastStore; readonly feeds: ForecastFeeds };
  readonly capability?: string;
  readonly jobRunCapability?: string;
}

export interface CycleJobResult {
  readonly outcome: CycleOutcome;
  readonly reason: CycleReason;
  readonly runId: string;
  readonly capability: string;
  readonly mode: CycleMode;
  /** Null when the lease could not be taken, because every write is fenced by it. */
  readonly fencingToken: number | null;
  readonly ticksCompleted: number;
  /** The intent row this run evaluated, when there was one. */
  readonly intentId: string | null;
}

export async function runCycleJob(input: CycleJobInput): Promise<CycleJobResult> {
  const capability = input.capability ?? CYCLE_CAPABILITY;
  const jobRunCapability = input.jobRunCapability ?? CYCLE_JOB_RUN_CAPABILITY;
  const ticks = Math.max(1, Math.trunc(input.ticks));
  const startedAt = input.now();

  const base = { capability, mode: input.mode, runId: input.runId } as const;

  // 1. The lease. One authoritative execution owner per capability is the store's
  //    property, not this job's convention (ADR-0013 §1).
  const acquisition = await input.store.acquireLease({
    capability,
    expiresAt: leaseExpiry(startedAt, ticks),
    now: startedAt,
    owner: input.runId,
  });
  if (!acquisition.acquired) {
    // Nothing is written. Every write below is fenced by a token this run does
    // not hold, so a run that lost the race has nothing it may legitimately say
    // in the store — the owner that holds the lease is the one writing.
    return {
      ...base,
      fencingToken: null,
      intentId: null,
      outcome: 'refused',
      reason: 'lease-held',
      ticksCompleted: 0,
    };
  }
  const grant: LeaseGrant = acquisition.grant;

  const finish = async (
    outcome: CycleOutcome,
    reason: CycleReason,
    details: { readonly ticksCompleted: number; readonly intent: IntentRow | undefined },
  ): Promise<CycleJobResult> => {
    const at = input.now();
    // One outcome row per run, against the intent that was evaluated. With no
    // intent there is no row to reference — `engine.control_outcome.intent_id` is
    // a foreign key — so the job-health row below carries the refusal instead.
    if (details.intent !== undefined) {
      await input.store.appendOutcome(grant, {
        appliedAt: at,
        appliedRunId: input.runId,
        intentId: details.intent.id,
        outcome,
        reason,
      });
    }
    await input.store.upsertJobRun(grant, {
      at,
      capability: jobRunCapability,
      outcome,
      runId: input.runId,
    });
    await input.store.closeRunRecord(grant, {
      finishedAt: at,
      outcome,
      reason,
      runId: input.runId,
      ticks: details.ticksCompleted,
    });
    await input.store.releaseLease(grant, input.now());
    return {
      ...base,
      fencingToken: grant.fencingToken,
      intentId: details.intent?.id ?? null,
      outcome,
      reason,
      ticksCompleted: details.ticksCompleted,
    };
  };

  // 2. Idempotency per run id (ADR-0013 §1). A Scheduler retry of a run that was
  //    already recorded writes nothing: it releases the lease it just took and
  //    exits. The per-cycle key — (asset, cycle close time) — is stage 2's table.
  const existing = await input.store.readRunRecord(input.runId);
  if (existing !== null) {
    await input.store.releaseLease(grant, input.now());
    return {
      ...base,
      fencingToken: grant.fencingToken,
      intentId: null,
      outcome: 'refused',
      reason: 'run-already-recorded',
      ticksCompleted: 0,
    };
  }

  // 3. Open the record before anything can fail, so a crashed run still spends
  //    its run id rather than inviting a retry to do the work twice.
  await input.store.openRunRecord(grant, {
    capability,
    mode: input.mode,
    runId: input.runId,
    startedAt,
  });

  // 4. Intent.
  const decision = evaluateIntent(await input.store.readIntents(capability, INTENT_READ_LIMIT), {
    capability,
    epoch: input.controlEpoch,
    now: input.now(),
  });
  if (!decision.run) {
    return finish('refused', decision.reason, { intent: decision.intent, ticksCompleted: 0 });
  }

  // 5. The lanes stage 1 does not implement. Accepted by the parser so the
  //    argument shape is settled, refused here so a tfvars change cannot run one.
  if (input.mode === 'paper' || (input.mode === 'forecast' && input.forecast === undefined)) {
    return finish('refused', 'mode-not-implemented', {
      intent: decision.intent,
      ticksCompleted: 0,
    });
  }

  // 6. The ticks. v1's cadence, inside one short run: `ticks` ticks at 15-second
  //    spacing, then exit, so one scheduled minute is one run. Stage 1's tick
  //    body is the heartbeat and nothing else.
  let ticksCompleted = 0;
  const firstTickAt = input.now().getTime();
  for (let tick = 1; tick <= ticks; tick += 1) {
    const at = input.now();
    await input.store.heartbeat(grant, at, leaseExpiry(at, ticks - tick + 1));
    if (input.mode === 'forecast' && input.forecast !== undefined) {
      await runForecastTick(input.forecast.store, input.forecast.feeds, grant, input.now);
    }
    ticksCompleted += 1;
    if (tick < ticks)
      await input.sleep(
        input.mode === 'forecast'
          ? Math.max(0, firstTickAt + tick * TICK_INTERVAL_MS - input.now().getTime())
          : TICK_INTERVAL_MS,
      );
  }

  return finish('applied', input.mode === 'forecast' ? 'forecast-run' : 'dry-run', {
    intent: decision.intent,
    ticksCompleted,
  });
}
