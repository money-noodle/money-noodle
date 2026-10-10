// In-memory cycle store with the same contract, for tests only.
//
// It models the three properties the real one enforces in SQL, because a double
// that does not is a double that cannot stand in for the checks this job exists
// to make: one owner per capability with an expiry, a fencing token that
// increments on every acquisition and gates every write, and a run id that can
// be spent exactly once. The restore job learned that lesson the expensive way
// (#269), where a fake that accepted any row let a key violation reach a real
// execution.

import type {
  CycleMode,
  CycleOutcome,
  CycleReason,
  CycleRunRecord,
  CycleStore,
  LeaseAcquisition,
  LeaseGrant,
} from '../../domain/cycle-store.js';

import { FencingTokenRejectedError, leaseIsLive } from '../../domain/cycle-store.js';
import type { IntentRow } from '../../domain/intent.js';

export interface FakeLease {
  capability: string;
  owner: string;
  fencingToken: number;
  acquiredAt: Date;
  expiresAt: Date;
  heartbeatAt: Date;
}

export interface FakeRunRecord {
  runId: string;
  capability: string;
  mode: CycleMode;
  outcome: CycleOutcome;
  reason: string;
  startedAt: Date;
  finishedAt: Date | null;
  ticks: number;
  fencingToken: number;
}

export interface FakeOutcomeRow {
  intentId: string;
  appliedRunId: string;
  appliedAt: Date;
  outcome: CycleOutcome;
  reason: CycleReason;
}

export interface FakeJobRunRow {
  capability: string;
  lastRunId: string;
  lastRunAt: Date;
  lastOutcome: CycleOutcome;
}

export class FakeCycleStore implements CycleStore {
  readonly leases = new Map<string, FakeLease>();
  readonly runRecords = new Map<string, FakeRunRecord>();
  readonly outcomes: FakeOutcomeRow[] = [];
  readonly jobRuns = new Map<string, FakeJobRunRow>();
  readonly intents: IntentRow[] = [];
  readonly heartbeats: Date[] = [];
  closed = false;

  private logicalNow = new Date(0);
  constructor(
    intents: readonly IntentRow[] = [],
    readonly clock: (() => Date) | null = null,
  ) {
    this.intents.push(...intents);
  }

  /** Put a lease in place as another owner, for the contention tests. */
  seedLease(lease: FakeLease): void {
    this.leases.set(lease.capability, { ...lease });
  }

  private fence(grant: LeaseGrant, what: string): FakeLease {
    const held = this.leases.get(grant.capability);
    if (
      held === undefined ||
      held.owner !== grant.owner ||
      held.fencingToken !== grant.fencingToken ||
      held.expiresAt <= (this.clock?.() ?? this.logicalNow)
    ) {
      throw new FencingTokenRejectedError(
        `Refusing ${what}: this run no longer holds the lease it was granted.`,
      );
    }
    return held;
  }

  async acquireLease(request: {
    capability: string;
    owner: string;
    now: Date;
    expiresAt: Date;
  }): Promise<LeaseAcquisition> {
    this.logicalNow = request.now;
    const held = this.leases.get(request.capability);
    if (held !== undefined && leaseIsLive(held.expiresAt, request.now)) {
      return {
        acquired: false,
        holder: {
          expiresAt: held.expiresAt,
          fencingToken: held.fencingToken,
          owner: held.owner,
        },
      };
    }
    const lease: FakeLease = {
      acquiredAt: request.now,
      capability: request.capability,
      expiresAt: request.expiresAt,
      // Monotonic across acquisitions, including a takeover of an expired lease,
      // which is what makes the previous owner's writes refusable.
      fencingToken: (held?.fencingToken ?? 0) + 1,
      heartbeatAt: request.now,
      owner: request.owner,
    };
    this.leases.set(request.capability, lease);
    return {
      acquired: true,
      grant: {
        acquiredAt: lease.acquiredAt,
        capability: lease.capability,
        expiresAt: lease.expiresAt,
        fencingToken: lease.fencingToken,
        owner: lease.owner,
      },
    };
  }

  async heartbeat(grant: LeaseGrant, at: Date, expiresAt: Date): Promise<void> {
    this.logicalNow = at;
    const lease = this.fence(grant, 'a heartbeat');
    lease.heartbeatAt = at;
    lease.expiresAt = expiresAt;
    this.heartbeats.push(at);
  }

  async releaseLease(grant: LeaseGrant, at: Date): Promise<void> {
    this.logicalNow = at;
    const lease = this.fence(grant, 'a lease release');
    lease.expiresAt = at;
    lease.heartbeatAt = at;
  }

  async readRunRecord(runId: string): Promise<CycleRunRecord | null> {
    return this.runRecords.get(runId) ?? null;
  }

  async openRunRecord(
    grant: LeaseGrant,
    record: { runId: string; capability: string; mode: CycleMode; startedAt: Date },
  ): Promise<void> {
    this.fence(grant, 'opening a run record');
    if (this.runRecords.has(record.runId)) {
      throw new Error(`duplicate key value violates unique constraint "job_run_record_pkey"`);
    }
    this.runRecords.set(record.runId, {
      capability: record.capability,
      fencingToken: grant.fencingToken,
      finishedAt: null,
      mode: record.mode,
      outcome: 'refused',
      reason: 'run-incomplete',
      runId: record.runId,
      startedAt: record.startedAt,
      ticks: 0,
    });
  }

  async closeRunRecord(
    grant: LeaseGrant,
    record: {
      runId: string;
      finishedAt: Date;
      ticks: number;
      outcome: CycleOutcome;
      reason: CycleReason;
    },
  ): Promise<void> {
    this.fence(grant, 'closing a run record');
    const existing = this.runRecords.get(record.runId);
    if (existing === undefined) throw new Error(`no run record for ${record.runId}`);
    existing.finishedAt = record.finishedAt;
    existing.ticks = record.ticks;
    existing.outcome = record.outcome;
    existing.reason = record.reason;
  }

  async readIntents(capability: string, limit: number): Promise<readonly IntentRow[]> {
    return this.intents.filter((row) => row.capability === capability).slice(0, limit);
  }

  async appendOutcome(
    grant: LeaseGrant,
    outcome: {
      intentId: string;
      appliedRunId: string;
      appliedAt: Date;
      outcome: CycleOutcome;
      reason: CycleReason;
    },
  ): Promise<void> {
    this.fence(grant, 'appending an outcome row');
    if (!this.intents.some((row) => row.id === outcome.intentId)) {
      // The real table has a foreign key to `engine.control_intent`.
      throw new Error(
        `insert or update on table "control_outcome" violates foreign key constraint`,
      );
    }
    this.outcomes.push({ ...outcome });
  }

  async upsertJobRun(
    grant: LeaseGrant,
    row: { capability: string; runId: string; at: Date; outcome: CycleOutcome },
  ): Promise<void> {
    this.fence(grant, 'updating the job-health row');
    this.jobRuns.set(row.capability, {
      capability: row.capability,
      lastOutcome: row.outcome,
      lastRunAt: row.at,
      lastRunId: row.runId,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
