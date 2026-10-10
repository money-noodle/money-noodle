// The cycle job's store port, and the pure parts of its lease.
//
// ADR-0013 §1: "The cycle job holds its lease in the store, not on disk. v1's
// lease was a file, which is exactly the kind of state that makes a second runner
// unsafe and a crash leave a stale lock. The lease is a store row with an owner,
// an expiry and a fencing token; one authoritative execution owner is then a
// property the store enforces rather than a convention."
//
// So every write below carries the grant it was made under, and an
// implementation must refuse a write whose fencing token is no longer the current
// one. A run that lost its lease to an expiry — a long GC pause, a stalled
// network — must not be able to finish writing as though it still held it.

import type { IntentRefusal, IntentRow } from './intent.js';

/** v1 ticked every 15 seconds; a scheduled minute is four ticks (ADR-0013 §1). */
export const TICK_INTERVAL_MS = 15_000;

/** Head-room beyond the last tick, so a slow final write does not race an expiry. */
export const LEASE_GRACE_MS = 60_000;

export const DEFAULT_TICKS = 4;

/** The lane this run executes. Only `dry` is implemented in stage 1 (#243). */
export const CYCLE_MODES = ['dry', 'forecast', 'paper'] as const;
export type CycleMode = (typeof CYCLE_MODES)[number];

export const isCycleMode = (value: string): value is CycleMode =>
  (CYCLE_MODES as readonly string[]).includes(value);

export type CycleOutcome = 'applied' | 'refused';

/**
 * Every reason a run can record. A fixed code, never a sentence: an outcome row
 * is read by a job-health view and by a human comparing two runs, and both need
 * the same string for the same situation (ADR-0013 §3).
 */
export const CYCLE_REASONS = [
  /** The run executed. Stage 1's only success: bookkeeping ticks and no effect. */
  'dry-run',
  'forecast-run',
  /** No intent row exists for the capability at all. */
  'intent-missing',
  /** The latest row carries an epoch that is not the store's current one. */
  'intent-stale-epoch',
  /** The latest row was recorded further in the future than the allowed skew. */
  'intent-future',
  /** The latest row is a `pause`, a `reset`, or any other non-running action. */
  'intent-paused',
  /** Another owner holds a live lease on this capability. */
  'lease-held',
  /** A mode later stages implement was requested. Nothing ran. */
  'mode-not-implemented',
  /** This run id already has a record, so the run is a retry of a recorded run. */
  'run-already-recorded',
] as const;

export type CycleReason = (typeof CYCLE_REASONS)[number];

/** Compile-time proof that every intent refusal is also a recordable reason. */
const _intentReasonsAreCycleReasons: readonly CycleReason[] = [
  'intent-missing',
  'intent-stale-epoch',
  'intent-future',
  'intent-paused',
] satisfies readonly IntentRefusal[];
void _intentReasonsAreCycleReasons;

/** The lease this run holds. Every write is made under it. */
export interface LeaseGrant {
  readonly capability: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

/** Who holds the lease, when acquisition failed. Never a credential or a path. */
export interface LeaseHolder {
  readonly owner: string;
  readonly fencingToken: number;
  readonly expiresAt: Date;
}

export type LeaseAcquisition =
  | { readonly acquired: true; readonly grant: LeaseGrant }
  | { readonly acquired: false; readonly holder: LeaseHolder };

export interface CycleRunRecord {
  readonly runId: string;
  readonly capability: string;
  readonly mode: CycleMode;
  readonly outcome: CycleOutcome;
  readonly reason: string;
}

export class FencingTokenRejectedError extends Error {
  override readonly name = 'FencingTokenRejectedError';
}

/**
 * How long the lease is taken for: every tick, plus grace. Deliberately derived
 * from the tick budget rather than configured, so a run cannot hold a lease for
 * longer than it could possibly need it.
 */
export const leaseWindowMs = (ticks: number): number =>
  Math.max(1, ticks) * TICK_INTERVAL_MS + LEASE_GRACE_MS;

export const leaseExpiry = (acquiredAt: Date, ticks: number): Date =>
  new Date(acquiredAt.getTime() + leaseWindowMs(ticks));

/** Whether a lease row is still live at `now`. Expiry is exclusive of `now`. */
export const leaseIsLive = (expiresAt: Date, now: Date): boolean =>
  expiresAt.getTime() > now.getTime();

/**
 * The store as the cycle job sees it: `engine_writer` only, no DDL. Keyed and
 * granted by `services/platform-api/migrations/0004-engine-cycle-lease-and-runs.sql`.
 */
export interface CycleStore {
  /**
   * Take the lease for `capability`, or report who holds it. One atomic
   * statement: an insert that, on conflict, updates only when the existing row
   * has expired. The fencing token increments on every acquisition.
   */
  acquireLease(request: {
    readonly capability: string;
    readonly owner: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<LeaseAcquisition>;

  /** Push the lease's heartbeat and expiry forward. Fenced. */
  heartbeat(grant: LeaseGrant, at: Date, expiresAt: Date): Promise<void>;

  /** Expire the lease now, so the next scheduled run does not wait it out. Fenced. */
  releaseLease(grant: LeaseGrant, at: Date): Promise<void>;

  /** The record for `runId`, or null when this run id has never been recorded. */
  readRunRecord(runId: string): Promise<CycleRunRecord | null>;

  /** Open this run's record. Fenced. Fails when the run id already has one. */
  openRunRecord(
    grant: LeaseGrant,
    record: {
      readonly runId: string;
      readonly capability: string;
      readonly mode: CycleMode;
      readonly startedAt: Date;
    },
  ): Promise<void>;

  /** Close this run's record with what it did. Fenced. */
  closeRunRecord(
    grant: LeaseGrant,
    record: {
      readonly runId: string;
      readonly finishedAt: Date;
      readonly ticks: number;
      readonly outcome: CycleOutcome;
      readonly reason: CycleReason;
    },
  ): Promise<void>;

  /** Intent rows for `capability`, newest first by `(epoch, recorded_at, id)`. */
  readIntents(capability: string, limit: number): Promise<readonly IntentRow[]>;

  /** Append one outcome row against the intent this run evaluated. Fenced. */
  appendOutcome(
    grant: LeaseGrant,
    outcome: {
      readonly intentId: string;
      readonly appliedRunId: string;
      readonly appliedAt: Date;
      readonly outcome: CycleOutcome;
      readonly reason: CycleReason;
    },
  ): Promise<void>;

  /** Upsert the job-health row the signed-in view reads. Fenced. */
  upsertJobRun(
    grant: LeaseGrant,
    row: {
      readonly capability: string;
      readonly runId: string;
      readonly at: Date;
      readonly outcome: CycleOutcome;
    },
  ): Promise<void>;

  close(): Promise<void>;
}
