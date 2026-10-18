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

import { MAX_INTENT_CLOCK_SKEW_MS } from '../../domain/intent.js';
import {
  buildPaperAuthorityEvidence,
  paperAuthorityFenceIsValid,
  paperAuthorityScopeIsValid,
  type PaperAuthorityFence,
  type PaperAuthorityReadResult,
  type PaperAuthorityScope,
} from '../../domain/paper-authority-evidence.js';

/** Exact signed epoch microseconds as TEXT, extracted before any driver Date.
 * `control_intent.recorded_at` carries no `isfinite` check, so a non-finite timestamp
 * is reported as NULL rather than allowed to raise on the numeric cast. */
const MICRO = (column: string): string =>
  `case when isfinite(${column}) then (extract(epoch from ${column})*1000000)::numeric(30,0)::text else null end`;

/** Serialization failure: a concurrent commit moved a row this fence locked. */
const SERIALIZATION_FAILURE = '40001';

/** `(epoch, recorded_at, id)` as a PostgreSQL row, compared lexicographically by the
 * server. The same ordering as `control_intent_latest_idx`. */
const ORDER_KEY = (alias: string): string =>
  `row(${alias}.epoch, ${alias}.recorded_at, ${alias}.id)`;

// `epoch_text`, never `epoch`: an output column named `epoch` SHADOWS the table column
// in `order by epoch desc`, which would order the authoritative epoch as TEXT and put
// epoch 9 above epoch 10. The alias keeps the ordering on the integer column.
const INTENT_COLUMNS = `id,capability,action,actor,epoch::text as epoch_text,${MICRO('recorded_at')} as recorded_at_us,(isfinite(recorded_at) and recorded_at - clock_timestamp() <= $2::interval) as time_valid,parameters`;

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
      // The existing approved allowance, carried to the server as an interval so the
      // comparison is made against the database clock. No tolerance is invented here.
      const skew = `${MAX_INTENT_CLOCK_SKEW_MS} milliseconds`;
      try {
        return await sql.begin('isolation level repeatable read', async (tx) => {
          // Start fence: owner, token and a live expiry on the DATABASE clock.
          const lease = await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp()',
            [fence.capability, fence.owner, fence.fencingToken.toString()],
          );
          const leaseHeld = lease.length === 1;
          const observed = leaseHeld
            ? await one(tx, `select ${MICRO('clock_timestamp()')} as observed_at_us`, [])
            : null;
          // The standing intent: GLOBAL latest for the capability, not filtered to the
          // requested epoch, newest first under the authoritative ordering. A malformed
          // newest row is returned as the newest row.
          const latest = leaseHeld
            ? await one(
                tx,
                `select ${INTENT_COLUMNS} from engine.control_intent where capability=$1 order by epoch desc, recorded_at desc, id desc limit 1`,
                [fence.capability, skew],
              )
            : null;
          // Mid-read barrier: the standing intent is above, everything compared against
          // it is below. A concurrent commit landing here is the case that distinguishes
          // one snapshot from two.
          await testEffects?.afterLatestRead?.();
          // The configure row this request could bind: newest `configure` for the
          // capability AT the requested epoch, malformed parameters included. The
          // reducer requires `configure.epoch === snapshot.epoch`, so the epoch filter
          // is that requirement and not a narrowing of the standing intent.
          const configure = leaseHeld
            ? await one(
                tx,
                `select ${INTENT_COLUMNS} from engine.control_intent where capability=$1 and action='configure' and epoch=$3 order by epoch desc, recorded_at desc, id desc limit 1`,
                [fence.capability, skew, scope.epoch],
              )
            : null;
          // Ordering and the reset barrier, computed by the server over the two rows it
          // already chose. The reset is global for the capability, under the same
          // ordering, so a reset recorded under a newer epoch orders after a configure
          // under an older one.
          const ordering =
            latest === null || configure === null
              ? null
              : await one(
                  tx,
                  `select (${ORDER_KEY('c')} <= ${ORDER_KEY('l')}) as configure_at_or_before_latest, (r.id is null or ${ORDER_KEY('r')} < ${ORDER_KEY('c')}) as configure_after_reset, r.id as newest_reset_id from engine.control_intent c cross join engine.control_intent l left join (select id,epoch,recorded_at from engine.control_intent where capability=$1 and action='reset' order by epoch desc, recorded_at desc, id desc limit 1) r on true where c.id=$2 and l.id=$3`,
                  [fence.capability, configure.id, latest.id],
                );
          // The funding and budget root pair, joined on the FULL primary key, located
          // by the configure row's own persisted parameters and actor — extracted in
          // SQL, so no JS coercion picks the key. Identity is then reported from the
          // ROWS, so the reducer compares two independent persisted sources.
          //
          // `other_epoch_root_exists` is audit only; no epoch policy is invented here,
          // and the lookup deliberately uses the requested epoch, which makes the
          // reducer's own epoch equality a construction of this lookup rather than an
          // independent fact. The independently discriminating facts are the pair's
          // existence, the exact conservation identity and the birth-intent binding.
          const funding =
            configure === null
              ? null
              : await one(
                  tx,
                  `select f.funding_id,f.epoch::text as epoch_text,f.budget_id,b.starting_cents::text as starting_cents,b.available_cents::text as available_cents,b.reserved_cents::text as reserved_cents,b.realized_cents::text as realized_cents,b.correction_cents::text as correction_cents,b.revision::text as revision,((b.available_cents::numeric + b.reserved_cents::numeric) = (b.starting_cents::numeric + b.realized_cents::numeric + b.correction_cents::numeric)) as identity_holds,(b.revision >= 1) as revision_valid,(b.birth_config_intent_id = f.birth_config_intent_id) as birth_bound,exists(select 1 from engine.control_intent bi where bi.id=f.birth_config_intent_id and bi.capability=$1 and bi.action='configure' and bi.epoch=f.epoch and bi.actor=f.actor) as birth_intent_bound,exists(select 1 from engine.paper_funding_root o where o.funding_id=f.funding_id and o.budget_id=f.budget_id and o.epoch<>f.epoch) as other_epoch_root_exists from engine.control_intent ci join engine.paper_funding_root f on f.funding_id = ci.parameters->>'funding_id' and f.epoch = $3 and f.budget_id = ci.actor || ':paper' join engine.paper_budget_root b on b.funding_id=f.funding_id and b.epoch=f.epoch and b.budget_id=f.budget_id where ci.id=$2`,
                  [fence.capability, configure.id, scope.epoch],
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
            {
              configure,
              funding,
              latest,
              leaseHeld,
              leaseStillHeld: locked.length === 1 && live.length === 1,
              observedAtMicroseconds: observed === null ? null : observed.observed_at_us,
              ordering,
            },
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
