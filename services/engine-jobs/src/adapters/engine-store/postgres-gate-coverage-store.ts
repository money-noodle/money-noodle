// Reads a persisted gate coverage receipt and its universe inside ONE coherent
// transaction, as `engine_writer` (ADR-0013 §2): SELECT only on the tables 0006 and
// 0004 already grant, plus the row lock the fence needs on `engine.job_lease`. No
// DDL, no migration, no INSERT, UPDATE or DELETE statement exists in this file, and
// no new grant is required: `engine_writer` already holds select on every table read
// here and select/update on the lease.
//
// The snapshot and locking protocol is explicit, not assumed:
//
//   * **One snapshot.** The transaction runs at REPEATABLE READ, so every statement
//     in it sees the same snapshot. A concurrent insert or update of a candidate,
//     outcome, phase event or head is invisible to this read, so no pair of queries
//     can be mixed across two states.
//   * **Two fences.** The lease is proved at the start against the database clock
//     (`clock_timestamp()`, the clock both runners share, never the job's), and again
//     at the final boundary with `for update`. Under REPEATABLE READ a locking read
//     of a row that a concurrent transaction has committed over raises serialization
//     failure 40001, so a lease takeover or token replacement aborts the whole
//     transaction instead of letting a stale result be admitted.
//   * **All or nothing.** Any refusal or error rolls the transaction back and returns
//     no receipt. Nothing partial is returned and nothing is carried to another
//     transaction: the receipt is scoped to the snapshot that produced it.
//
// Clocks cross the boundary as exact signed epoch-microsecond TEXT, extracted in
// PostgreSQL before any driver Date, so no recorded or cutoff authority is truncated
// to millisecond Date precision. Counts cross as TEXT for the same reason. No money
// column is read, so no rounding question arises here.
//
// REPEATABLE READ is chosen over an explicitly READ ONLY transaction because the
// final fence needs a row lock; the guarantee that nothing is written is structural
// (this file issues no write statement) rather than declared.

import postgres from 'postgres';

import { CONTROL_ACTIONS } from '../../domain/intent.js';
import {
  paperGateRowScopeIsValid,
  type PaperGateRowScope,
} from '../../domain/paper-gate-row-codec.js';
import {
  PAPER_GATE_UNIVERSE_LIMIT,
  verifyPaperGateCoverage,
  type PaperGateCoverageFence,
  type PaperGateCoverageResult,
} from '../../domain/paper-gate-coverage.js';

const NAMESPACE = [
  'generation_key',
  'funding_id',
  'epoch',
  'budget_id',
  'generation_config_intent_id',
  'sample_policy',
] as const;

const scopeValues = (scope: PaperGateRowScope): unknown[] => NAMESPACE.map((k) => scope[k]);

/** Exact signed epoch microseconds as TEXT, extracted before any driver Date. */
const MICRO = (column: string): string =>
  `(extract(epoch from ${column})*1000000)::numeric(30,0)::text`;
const MICROSECONDS = (column: string, alias: string): string => `${MICRO(column)} as ${alias}`;

const NAMESPACE_PREDICATE = NAMESPACE.map((k, i) => `${k}=$${i + 1}`).join(' and ');

/** Serialization failure: a concurrent commit moved a row this fence locked. */
const SERIALIZATION_FAILURE = '40001';

export interface PaperGateCoverageStore {
  readCoverage(
    scope: PaperGateRowScope,
    fence: PaperGateCoverageFence,
  ): Promise<PaperGateCoverageResult>;
  close(): Promise<void>;
}

export function createPostgresGateCoverageStore(
  connectionString: string,
  /** Deterministic test barrier, run after the snapshot and before the final fence. */
  testEffects?: { afterSnapshot?: () => Promise<void> },
): PaperGateCoverageStore {
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
    // More than one row where the schema permits one is a refusal input, never a pick.
    return rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
  }

  return {
    async readCoverage(scope, fence): Promise<PaperGateCoverageResult> {
      // Validated before any statement is issued, with the row decoder's own scope
      // predicate: a malformed namespace must not reach the driver as parameters, and
      // must not open a transaction at all. The verifier re-checks both.
      if (!paperGateRowScopeIsValid(scope))
        return { detail: 'namespace', kind: 'refused', reason: 'scope' };
      if (
        typeof fence.capability !== 'string' ||
        fence.capability.length === 0 ||
        typeof fence.owner !== 'string' ||
        fence.owner.length === 0 ||
        typeof fence.fencingToken !== 'bigint' ||
        fence.fencingToken < 1n
      )
        return { detail: 'fence', kind: 'refused', reason: 'scope' };
      try {
        return await sql.begin('isolation level repeatable read', async (tx) => {
          const values = scopeValues(scope);
          // Start fence: owner, token and a live expiry on the DATABASE clock.
          const lease = await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp()',
            [fence.capability, fence.owner, fence.fencingToken.toString()],
          );
          const leaseHeld = lease.length === 1;
          const generation = leaseHeld
            ? await one(
                tx,
                `select ${NAMESPACE.join(',')},actor,source_kind,gate_formula,bundle_id,settings_descriptor,enabled from engine.paper_gate_generation where ${NAMESPACE_PREDICATE}`,
                values,
              )
            : null;
          const roots = leaseHeld
            ? await one(
                tx,
                'select exists(select 1 from engine.paper_funding_root where funding_id=$1 and epoch=$2 and budget_id=$3) as funding, exists(select 1 from engine.paper_budget_root where funding_id=$1 and epoch=$2 and budget_id=$3) as budget',
                [scope.funding_id, scope.epoch, scope.budget_id],
              )
            : null;
          const head = leaseHeld
            ? await one(
                tx,
                `select ${NAMESPACE.join(',')},latest_event_key,revision::text as revision,event_kind,projected_phase from engine.paper_gate_head where ${NAMESPACE_PREDICATE}`,
                values,
              )
            : null;
          const event =
            head === null
              ? null
              : await one(
                  tx,
                  `select ${NAMESPACE.join(',')},event_key,event_kind,revision_after::text as revision_after,prior_event_key,revision_before::text as revision_before,previous_phase,result_phase,projected_phase,current_effect_config_intent_id,latest_intent_id,run_id,source_kind,evidence_version,coverage_receipt_id,${MICROSECONDS('evidence_observed_at', 'evidence_observed_at_us')},${MICROSECONDS('coverage_cutoff_at', 'coverage_cutoff_at_us')},${MICROSECONDS('recorded_at', 'recorded_at_us')},captured_candidate_count::text as captured_candidate_count,captured_resolved_count::text as captured_resolved_count,captured_unresolved_count::text as captured_unresolved_count,input_count::text as input_count,${MICROSECONDS('universe_first_closes_at', 'universe_first_closes_at_us')},${MICROSECONDS('universe_last_closes_at', 'universe_last_closes_at_us')} from engine.paper_gate_phase_event where event_key=$7 and ${NAMESPACE_PREDICATE}`,
                  [...values, head.latest_event_key],
                );
          const inputs =
            event === null
              ? []
              : await tx.unsafe(
                  `select ${NAMESPACE.join(',')},event_key,ordinal::text as ordinal,candidate_key from engine.paper_gate_phase_input where event_key=$7 and ${NAMESPACE_PREDICATE} order by ordinal`,
                  [...values, event.event_key] as never[],
                );
          // One row past the schema's own ceiling, so a universe that cannot legally
          // exist fails closed instead of being silently truncated or paginated away.
          const universe = leaseHeld
            ? await tx.unsafe(
                `select c.candidate_key,${MICROSECONDS('c.closes_at', 'closes_at_us')},${MICROSECONDS('c.created_at', 'created_at_us')},case when o.candidate_key is null then null else ${MICRO('o.recorded_at')} end as outcome_recorded_at_us from engine.paper_gate_candidate c left join engine.paper_gate_outcome o on o.candidate_key=c.candidate_key where ${NAMESPACE.map((k, i) => `c.${k}=$${i + 1}`).join(' and ')} order by c.closes_at,c.candidate_key limit ${PAPER_GATE_UNIVERSE_LIMIT + 1}`,
                values as never[],
              )
            : [];
          const newest = leaseHeld
            ? await one(
                tx,
                'select id,action,epoch::text as epoch from engine.control_intent where capability=$1 order by epoch desc, recorded_at desc, id desc limit 1',
                [fence.capability],
              )
            : null;
          const newestControlIntentValid =
            newest !== null &&
            typeof newest.id === 'string' &&
            CONTROL_ACTIONS.includes(newest.action as never) &&
            typeof newest.epoch === 'string' &&
            /^[1-9][0-9]{0,9}$/.test(newest.epoch);

          await testEffects?.afterSnapshot?.();

          // Final boundary. A committed lease takeover raises 40001 here under
          // REPEATABLE READ, which aborts the whole transaction; an expiry or a
          // token replacement that is still visible in this snapshot fails the match.
          const still = await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp() for update',
            [fence.capability, fence.owner, fence.fencingToken.toString()],
          );
          return verifyPaperGateCoverage(
            {
              event,
              generation,
              head,
              inputs: [...inputs] as readonly unknown[],
              leaseHeld,
              leaseStillHeld: still.length === 1,
              newestControlIntentId: newest === null ? null : newest.id,
              newestControlIntentValid,
              rootsPresent: roots,
              universe: [...universe] as readonly unknown[],
            },
            scope,
            fence,
          );
        });
      } catch (error) {
        // A serialization failure IS the fence firing: the whole transaction rolled
        // back, so there is no partial receipt to salvage.
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
