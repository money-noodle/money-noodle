// The cycle job's one database connection, as `engine_writer` (ADR-0013 §2):
// SELECT, INSERT, UPDATE on `engine` tables, no DDL. The tables are created by
// the schema owner from `services/platform-api/migrations/0001-…` and
// `0004-engine-cycle-lease-and-runs.sql`, never here.
//
// Two properties are implemented in SQL rather than in the application, because
// a convention is not what ADR-0013 §1 asks for:
//
//   * **One owner.** The lease is taken by a single statement — an insert that,
//     on conflict, updates only when the stored row has already expired — so two
//     executions racing cannot both succeed, whatever either of them believes.
//   * **Fencing.** Every write names the grant it is made under and is guarded by
//     `exists (… owner = … and fencing_token = …)`. A run that lost its lease to
//     an expiry finds its own writes refused instead of overwriting the owner's.
//
// The expiry comparison uses the **database's** clock, not the job's: it is the
// one clock both runners share, and a lease decided on a skewed runner clock is
// the stale-lock problem moved rather than solved.

import postgres from 'postgres';

import type {
  CycleMode,
  CycleOutcome,
  CycleReason,
  CycleRunRecord,
  CycleStore,
  LeaseAcquisition,
  LeaseGrant,
} from '../../domain/cycle-store.js';
import { FencingTokenRejectedError, isCycleMode } from '../../domain/cycle-store.js';
import type { ControlAction, IntentRow } from '../../domain/intent.js';
import { CONTROL_ACTIONS } from '../../domain/intent.js';

interface LeaseRow {
  capability: string;
  owner: string;
  fencing_token: string;
  acquired_at: Date;
  expires_at: Date;
}

const grantOf = (row: LeaseRow): LeaseGrant => ({
  acquiredAt: row.acquired_at,
  capability: row.capability,
  expiresAt: row.expires_at,
  fencingToken: Number(row.fencing_token),
  owner: row.owner,
});

export function createPostgresCycleStore(connectionString: string): CycleStore {
  const sql = postgres(connectionString, { max: 1, prepare: false });

  /** Throws unless exactly the rows a fenced write should have touched were touched. */
  const fenced = (count: number, what: string): void => {
    if (count === 0) {
      throw new FencingTokenRejectedError(
        `Refusing ${what}: this run no longer holds the lease it was granted.`,
      );
    }
  };

  return {
    async acquireLease(request) {
      const taken = await sql<LeaseRow[]>`
        insert into engine.job_lease
          (capability, owner, fencing_token, acquired_at, expires_at, heartbeat_at)
        values (${request.capability}, ${request.owner}, 1, now(), ${request.expiresAt}, now())
        on conflict (capability) do update
          set owner         = excluded.owner,
              fencing_token = engine.job_lease.fencing_token + 1,
              acquired_at   = now(),
              expires_at    = excluded.expires_at,
              heartbeat_at  = now()
          where engine.job_lease.expires_at <= now()
        returning capability, owner, fencing_token, acquired_at, expires_at`;
      const row = taken.at(0);
      if (row !== undefined) return { acquired: true, grant: grantOf(row) };

      const [held] = await sql<LeaseRow[]>`
        select capability, owner, fencing_token, acquired_at, expires_at
          from engine.job_lease
         where capability = ${request.capability}`;
      // Absent only if the row vanished between the two statements, which no role
      // here can do: there is no delete grant on the engine schema.
      const holder = held ?? {
        acquired_at: request.now,
        capability: request.capability,
        expires_at: request.expiresAt,
        fencing_token: '0',
        owner: 'unknown',
      };
      return {
        acquired: false,
        holder: {
          expiresAt: holder.expires_at,
          fencingToken: Number(holder.fencing_token),
          owner: holder.owner,
        },
      } satisfies LeaseAcquisition;
    },

    async heartbeat(grant: LeaseGrant, at: Date, expiresAt: Date) {
      const updated = await sql`
        update engine.job_lease
           set heartbeat_at = ${at}, expires_at = ${expiresAt}
         where capability = ${grant.capability}
           and owner = ${grant.owner}
           and fencing_token = ${grant.fencingToken}`;
      fenced(updated.count, 'a heartbeat');
    },

    async releaseLease(grant: LeaseGrant, at: Date) {
      // Expire it rather than delete it: the row carries the fencing token the
      // next acquisition increments, and no role here holds `delete` anyway.
      const updated = await sql`
        update engine.job_lease
           set expires_at = ${at}, heartbeat_at = ${at}
         where capability = ${grant.capability}
           and owner = ${grant.owner}
           and fencing_token = ${grant.fencingToken}`;
      fenced(updated.count, 'a lease release');
    },

    async readRunRecord(runId: string): Promise<CycleRunRecord | null> {
      const [row] = await sql<
        { run_id: string; capability: string; mode: string; outcome: string; reason: string }[]
      >`
        select run_id, capability, mode, outcome, reason
          from engine.job_run_record
         where run_id = ${runId}`;
      if (row === undefined) return null;
      return {
        capability: row.capability,
        mode: isCycleMode(row.mode) ? row.mode : ('dry' satisfies CycleMode),
        outcome: row.outcome === 'applied' ? 'applied' : 'refused',
        reason: row.reason,
        runId: row.run_id,
      };
    },

    async openRunRecord(grant: LeaseGrant, record) {
      const inserted = await sql`
        insert into engine.job_run_record
          (run_id, capability, mode, started_at, ticks, outcome, reason, fencing_token)
        select ${record.runId}, ${record.capability}, ${record.mode}, ${record.startedAt},
               0, 'refused', 'run-incomplete', ${grant.fencingToken}
         where exists (
           select 1 from engine.job_lease
            where capability = ${grant.capability}
              and owner = ${grant.owner}
              and fencing_token = ${grant.fencingToken})`;
      fenced(inserted.count, 'opening a run record');
    },

    async closeRunRecord(grant: LeaseGrant, record) {
      const updated = await sql`
        update engine.job_run_record
           set finished_at = ${record.finishedAt},
               ticks = ${record.ticks},
               outcome = ${record.outcome satisfies CycleOutcome},
               reason = ${record.reason satisfies CycleReason}
         where run_id = ${record.runId}
           and exists (
             select 1 from engine.job_lease
              where capability = ${grant.capability}
                and owner = ${grant.owner}
                and fencing_token = ${grant.fencingToken})`;
      fenced(updated.count, 'closing a run record');
    },

    async readIntents(capability: string, limit: number): Promise<readonly IntentRow[]> {
      const rows = await sql<
        { id: string; capability: string; action: string; epoch: number; recorded_at: Date }[]
      >`
        select id, capability, action, epoch, recorded_at
          from engine.control_intent
         where capability = ${capability}
         order by epoch desc, recorded_at desc, id desc
         limit ${limit}`;
      return rows
        .filter((row): row is typeof row & { action: ControlAction } =>
          (CONTROL_ACTIONS as readonly string[]).includes(row.action),
        )
        .map((row) => ({
          action: row.action,
          capability: row.capability,
          epoch: Number(row.epoch),
          id: row.id,
          recordedAt: row.recorded_at,
        }));
    },

    async appendOutcome(grant: LeaseGrant, outcome) {
      const inserted = await sql`
        insert into engine.control_outcome
          (intent_id, applied_run_id, applied_at, outcome, reason)
        select ${outcome.intentId}, ${outcome.appliedRunId}, ${outcome.appliedAt},
               ${outcome.outcome satisfies CycleOutcome}, ${outcome.reason satisfies CycleReason}
         where exists (
           select 1 from engine.job_lease
            where capability = ${grant.capability}
              and owner = ${grant.owner}
              and fencing_token = ${grant.fencingToken})`;
      fenced(inserted.count, 'appending an outcome row');
    },

    async upsertJobRun(grant: LeaseGrant, row) {
      const written = await sql`
        insert into engine.job_run (capability, last_run_id, last_run_at, last_outcome)
        select ${row.capability}, ${row.runId}, ${row.at}, ${row.outcome satisfies CycleOutcome}
         where exists (
           select 1 from engine.job_lease
            where capability = ${grant.capability}
              and owner = ${grant.owner}
              and fencing_token = ${grant.fencingToken})
        on conflict (capability) do update
          set last_run_id  = excluded.last_run_id,
              last_run_at  = excluded.last_run_at,
              last_outcome = excluded.last_outcome`;
      fenced(written.count, 'updating the job-health row');
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
