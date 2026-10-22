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
//   5. decide the lane: a mode later stages implement is refused before any tick body
//      exists, and the paper lane asks the persisted authority and refuses with what it
//      said;
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
// ## The paper lane, wired 2026-10-19 — FAIL-CLOSED, NOT ACTIVATED
//
// The paper lane no longer answers `mode-not-implemented` on sight when an authority
// reader is wired. It reads the persisted authority under THIS run's own lease fence and
// records what that read said. What it still does not do is run: no candidate is read, no
// evidence is produced, no generation is advanced, no order is placed and no gate row is
// written by this job on any path.
//
// Why that is safe rather than one flag away from unsafe:
//
//   * The decision it records is `decisionUnderProductionBundle`, which the adapter
//     computes with the build's own `COMPILED_PAPER_BUNDLE_AVAILABLE`. That constant is
//     `false`, so an otherwise perfectly valid configure and resume refuses
//     `bundle-unavailable`. Nothing here takes an availability argument, reads an
//     environment flag or accepts a token, so there is no input to this job that can turn
//     the refusal into an admission.
//   * The ALLOWED branch is reachable only if that constant changes, and it still does not
//     run a tick: it records `paper-admission-unimplemented`, because the producers a tick
//     would need do not exist. An allowed decision must never be mistaken for a performed
//     run, so it is spelled out rather than left to a TODO.
//   * A historical read is not a write permission. This job never hands the evidence to a
//     writer; the production gate writer re-derives current authority inside its own
//     transaction if it is ever called, and it is not called from here.
//
// The lane is wired only when the caller supplies the reader, so the default — and every
// `dry` and `forecast` run — is byte-for-byte what it was.
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
import type {
  PaperAuthorityFence,
  PaperAuthorityReadResult,
  PaperAuthorityScope,
} from '../domain/paper-authority-evidence.js';
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

/**
 * The read side of the persisted paper authority, as THIS job needs it: one call, and no
 * way to ask for an availability override. The adapter satisfies it structurally, so the
 * application keeps its own narrow port and does not depend on the adapter module.
 */
export interface PaperAuthorityReader {
  readAuthority(
    scope: PaperAuthorityScope,
    fence: PaperAuthorityFence,
  ): Promise<PaperAuthorityReadResult>;
}

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
  /**
   * Supplied only for the paper lane. Absent means the lane answers exactly what it
   * answered before this was added, so nothing about `dry` or `forecast` — or about a
   * caller that does not wire it — changes.
   */
  readonly paper?: { readonly authority: PaperAuthorityReader };
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

  // 5. The lane.
  //
  // 5a. A mode this build cannot run at all: the forecast lane without its store and
  //     feeds, and the paper lane with no authority reader wired. Accepted by the parser
  //     so the argument shape is settled, refused here so a tfvars change cannot run one.
  if (
    (input.mode === 'forecast' && input.forecast === undefined) ||
    (input.mode === 'paper' && input.paper === undefined)
  ) {
    return finish('refused', 'mode-not-implemented', {
      intent: decision.intent,
      ticksCompleted: 0,
    });
  }

  // 5b. The paper lane, wired. One read, under this run's OWN fence — the owner and the
  //     fencing token the lease granted a moment ago, never a token from a caller — and
  //     the scope this job is governed by. No heartbeat is in flight while it runs, and
  //     no write transaction is open: this is a read between transactions, which is the
  //     order the tick loop below already keeps.
  if (input.mode === 'paper' && input.paper !== undefined) {
    const read = await input.paper.authority.readAuthority(
      { capability, epoch: input.controlEpoch },
      { capability, owner: grant.owner, fencingToken: BigInt(grant.fencingToken) },
    );
    // The read itself refused: a malformed scope, or this run's lease not held at the
    // read's own fence. Nothing was decided, so nothing is claimed about admission.
    if (read.kind !== 'read') {
      return finish('refused', 'paper-authority-unreadable', {
        intent: decision.intent,
        ticksCompleted: 0,
      });
    }
    // The decision the build itself makes. `decisionUnderProductionBundle` is the pure
    // reducer run with `COMPILED_PAPER_BUNDLE_AVAILABLE`, which is `false`, so this job
    // cannot be handed an availability it does not compile with.
    const admission = read.evidence.decisionUnderProductionBundle;
    if (!admission.allowed) {
      return finish(
        'refused',
        admission.reason === 'bundle-unavailable'
          ? 'paper-bundle-unavailable'
          : 'paper-authority-refused',
        { intent: decision.intent, ticksCompleted: 0 },
      );
    }
    // Admission granted, and still nothing runs: the candidate, evidence and generation
    // producers a paper tick needs are not implemented, and inventing them from
    // placeholder values would be a pretend pipeline. Unreachable today, and recorded as
    // its own reason so it can never read as a performed run.
    return finish('refused', 'paper-admission-unimplemented', {
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
