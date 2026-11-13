// Reads the persisted paper-authority record — the standing control intent, the
// configure intent it binds, the reset barrier and the funding/budget root pair —
// inside ONE coherent transaction, as `engine_writer` (ADR-0013 §2).
//
// SELECT only. No DDL, no migration, and no INSERT, UPDATE or DELETE statement exists
// in this file. No new grant is required, verified against the migrations rather than
// assumed: 0001 grants `engine_writer` select on `engine.control_intent`, 0004 grants
// select/update on `engine.job_lease`, and 0006 grants select on
// `engine.paper_funding_root` and `engine.paper_budget_root`.
//
// The snapshot and locking protocol is the one the coverage reader already proves:
//
//   * **One snapshot.** REPEATABLE READ, so every statement sees the same state. A
//     concurrent control insert or balance update is invisible to this read, and no
//     pair of statements can be mixed across two states.
//   * **Two fences.** The lease is proved at the start against the DATABASE clock
//     (`clock_timestamp()`, never the job's), and again at the final boundary with
//     `for update`. A committed UPDATE of that row since the snapshot raises
//     serialization failure 40001 and aborts the whole transaction.
//   * **A fresh clock after the lock.** The locking read's qualification, expiry
//     included, is evaluated BEFORE it waits for a lock, so a lease expiring during
//     that wait is still returned. A SEPARATE statement re-validates owner, token and
//     expiry against a fresh database clock once the lock is held.
//   * **All or nothing.** No refusal returns a partial snapshot or any evidence. This
//     file writes nothing, so an ordinary refusal COMMITs a read-only transaction;
//     a fence failure aborts it. Either way the caller gets a refusal and no evidence.
//
// **PostgreSQL computes the facts.** Ordering, the reset barrier, clock validity and
// the conservation identity are all computed by the server: ordering by row comparison
// over `(epoch, recorded_at, id)` — the ordering ADR-0013 §3 names — clock validity
// against `clock_timestamp()` using the existing approved `MAX_INTENT_CLOCK_SKEW_MS`,
// and the money identity in exact arbitrary-precision `numeric`. Timestamps cross the
// boundary as exact signed epoch-microsecond TEXT and whole cents as TEXT, so nothing
// is truncated to millisecond `Date` precision and no money value becomes a JS float.
// No caller boolean is accepted as any of these facts.
//
// **The standing intent is read globally for the capability**, not filtered to the
// requested epoch, and the newest row wins even when its parameters are malformed:
// `order by ... limit 1` here is "the newest row", never a page of history, and a
// malformed newest row is never skipped so an older well-formed row can stand in.
//
// **Lifetime.** A successful read returns HISTORICAL evidence, handed back after the
// transaction ended. It is not live write-admission and grants no write capability.
// The decision it carries is computed with `evaluatePaperAuthority`'s own default
// availability, which is `COMPILED_PAPER_BUNDLE_AVAILABLE === false`; this file accepts
// no audited-bundle override from any caller.

import postgres from 'postgres';

import { readPaperAuthorityRawInTransaction } from './paper-authority-sql.js';
import {
  buildPaperAuthorityEvidence,
  paperAuthorityFenceIsValid,
  paperAuthorityScopeIsValid,
  type PaperAuthorityFence,
  type PaperAuthorityReadResult,
  type PaperAuthorityScope,
} from '../../domain/paper-authority-evidence.js';

/** Serialization failure: a concurrent commit moved a row this fence locked. */
const SERIALIZATION_FAILURE = '40001';

export interface PaperAuthorityStore {
  readAuthority(
    scope: PaperAuthorityScope,
    fence: PaperAuthorityFence,
  ): Promise<PaperAuthorityReadResult>;
  close(): Promise<void>;
}

export function createPostgresPaperAuthorityStore(
  connectionString: string,
  /** Deterministic test barriers. `afterLatestRead` lands BETWEEN two reads — after the
   * standing intent, before the configure row, the ordering comparison and the roots —
   * so a concurrent commit there would change a READ COMMITTED result and must not
   * change this one. `beforeFinalFence` lands after every read and before the final
   * fence, and receives this transaction's own backend process id so a test can
   * observe, from a separate connection, that the final locking statement is genuinely
   * blocked and by which backend. The id is queried ONLY when a barrier is supplied, so
   * a production read issues no extra statement for it. Neither barrier can alter what
   * is read or decided. */
  testEffects?: {
    afterLatestRead?: () => Promise<void>;
    beforeFinalFence?: (context: { backendPid: number }) => Promise<void>;
  },
): PaperAuthorityStore {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connection: {
      statement_timeout: 5000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 8000,
    },
  });
  type Transaction = postgres.TransactionSql;

  async function one(
    tx: Transaction,
    query: string,
    values: readonly unknown[],
  ): Promise<Record<string, unknown> | null> {
    const rows = await tx.unsafe(query, values as never[]);
    // More than one row where the record permits one is a refusal input, never a pick.
    return rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
  }

  return {
    async readAuthority(scope, fence): Promise<PaperAuthorityReadResult> {
      // Validated before any statement is issued: a malformed scope, epoch or fence
      // must not reach the driver as parameters and must not open a transaction at
      // all. The evidence builder re-checks all three.
      if (!paperAuthorityScopeIsValid(scope))
        return { detail: 'scope', kind: 'refused', reason: 'scope' };
      if (!paperAuthorityFenceIsValid(fence))
        return { detail: 'fence', kind: 'refused', reason: 'scope' };
      if (scope.capability !== fence.capability)
        return { detail: 'capability-mismatch', kind: 'refused', reason: 'scope' };
      try {
        return await sql.begin('isolation level repeatable read', async (tx) => {
          // Start fence: owner, token and a live expiry on the DATABASE clock.
          const lease = await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp()',
            [fence.capability, fence.owner, fence.fencingToken.toString()],
          );
          const leaseHeld = lease.length === 1;
          // The SAME verified statements the writer runs, from one shared module. The
          // mid-read barrier lands between the standing intent and everything compared
          // against it: a concurrent commit there would change a READ COMMITTED result
          // and must not change this one.
          const raw = await readPaperAuthorityRawInTransaction(
            tx,
            fence.capability,
            scope.epoch,
            leaseHeld,
            testEffects?.afterLatestRead,
          );

          if (testEffects?.beforeFinalFence !== undefined) {
            const self = await one(tx, 'select pg_backend_pid()::text as pid', []);
            await testEffects.beforeFinalFence({ backendPid: Number(self?.pid) });
          }

          // Final boundary, in two statements on purpose; see the header.
          const locked = await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp() for update',
            [fence.capability, fence.owner, fence.fencingToken.toString()],
          );
          const live =
            locked.length === 1
              ? await tx.unsafe(
                  'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp()',
                  [fence.capability, fence.owner, fence.fencingToken.toString()],
                )
              : [];
          return buildPaperAuthorityEvidence(
            { ...raw, leaseStillHeld: locked.length === 1 && live.length === 1 },
            scope,
            fence,
          );
        });
      } catch (error) {
        // A serialization failure IS the fence firing: the whole transaction rolled
        // back, so there is no partial evidence to salvage.
        if ((error as { code?: string }).code === SERIALIZATION_FAILURE)
          return { detail: 'serialization-failure', kind: 'refused', reason: 'lease-lost' };
        throw error;
      }
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
