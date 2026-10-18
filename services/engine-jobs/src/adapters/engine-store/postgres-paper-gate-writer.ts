// Writes a persisted paper-gate generation, phase event, its ordered inputs and the head
// move, atomically, as `engine_writer` (ADR-0013 §2). This is persistence only: it does
// not activate paper mode, does not touch funding, control, intents or settings, and
// writes no money value.
//
// No new grant is required, verified against the migrations rather than assumed: 0006
// grants `engine_writer` select/insert on `paper_gate_generation`, `paper_gate_candidate`,
// `paper_gate_outcome`, `paper_gate_phase_event` and `paper_gate_phase_input`, and
// select/insert/update on `paper_gate_head`; 0001 grants select (and update, which the
// `for share` revalidation needs) on `engine.control_intent`; 0004 grants select/update
// on `engine.job_lease`. DELETE is revoked on all of them, which is why ROLLBACK is the
// only way to undo a partial write and why every post-mutation refusal throws.
//
// ## Order of checks, explicitly
//
//   1. Request, scope and fence are validated BEFORE any statement, so a malformed
//      request never reaches the driver and never opens a transaction.
//   2. Start lease fence: owner, token and a live expiry on the DATABASE clock.
//   3. Replay check by `event_key`. A match returns the recorded event and deliberately
//      does NOT read control authority, so a replay can never be mistaken for present
//      write admission.
//   4. Run record: the write must name a real `job_run_record` for this capability.
//   5. Present authority, read and validated INSIDE this transaction from the real
//      control and funding/budget rows, through the SAME shared statements the reader
//      uses. A historical receipt, a caller boolean or a caller-supplied config id is
//      never accepted in its place.
//   6. Generation, head and universe reads; derivation; CAS precondition.
//   7. Mutations. From here every refusal throws an internal control sentinel so the
//      transaction ROLLS BACK; a normal return would commit and is forbidden.
//   8. Bound-row revalidation (`for share` on the exact control rows the decision bound)
//      and the final lease fence: the locking read, then a SEPARATE fresh-database-clock
//      read, because the locking read's qualification is evaluated before it waits.
//
// ## What this transaction does and does not linearize
//
// It runs at SERIALIZABLE, which is strictly stronger than the reader's REPEATABLE READ
// and needs no schema, grant or API change. Within it:
//
//   * A concurrent UPDATE of the exact control rows the decision bound, of the lease, or
//     of this generation's head is caught — by `for share`/`for update` conflicts or by
//     the head CAS — and aborts or refuses.
//   * A concurrent INSERT of a NEWER control intent (a pause, reset or configure
//     recorded after this transaction's snapshot and committed before its COMMIT) is
//     NOT ordered against this write unless that recorder also runs at SERIALIZABLE.
//     PostgreSQL's serializable guarantee holds only among transactions that are all
//     serializable, and the control recorder's isolation is outside this module's
//     surface. So this writer linearizes against the lease and against other writers,
//     and its authority check is "the control record as of this transaction's snapshot",
//     NOT "no superseding intent exists at commit".
//
// That gap is deliberate and reported rather than papered over: this batch does not
// claim current write admission. Closing it needs one of three things, none of which is
// in this batch's allowed surface — the control recorder taking a per-capability lock
// the writer also takes (`pg_advisory_xact_lock` needs no grant, but needs the recorder
// side), every control writer running SERIALIZABLE, or a per-capability control-generation
// row the recorder bumps and the writer locks `for update` (a schema change).
//
// ## Availability
//
// This module exports exactly ONE factory and no availability-taking function. The core
// is module-private. The factory accepts an optional opaque `admission` value and asks
// `./paper-gate-audited-policy-gate.js` whether it is THIS artifact's audited-policy
// token. In the production build that gate has no token at all, so the answer is always
// `false` and an otherwise valid record refuses `bundle-unavailable` — including when the
// caller passes the genuine fixture token imported from the separate test-support
// artifact. A forged symbol or object is refused by identity.
//
// The test-support build replaces that one gate file and compiles the SAME source into
// `dist-test-support`, which `tsconfig.build.json` never produces, `.dockerignore`
// ignores and the Dockerfile does not copy. One real adapter, two artifacts: the positive
// path exercises exactly this code, not a surrogate.

import postgres from 'postgres';

import {
  COMPILED_PAPER_BUNDLE_AVAILABLE,
  evaluatePaperAuthority,
} from '../../domain/paper-authority.js';
import { buildPaperAuthorityEvidence } from '../../domain/paper-authority-evidence.js';
import { PAPER_GATE_UNIVERSE_LIMIT } from '../../domain/paper-gate-coverage.js';
import {
  PAPER_GATE_EVIDENCE_VERSION,
  PAPER_GATE_GENESIS_REVISION,
  comparePaperGateGenerationReplay,
  comparePaperGateReplay,
  derivePaperGateEvaluation,
  derivePaperGateUniverse,
  paperGateEpochFromText,
  paperGateIsoMilliseconds,
  paperGateWriteRequestIsValid,
  type PaperGateFence,
  type PaperGateIntendedEvent,
  type PaperGateUniverseEntry,
  type PaperGateWriteRefusal,
  type PaperGateWriteRequest,
  type PaperGateWriteResult,
} from '../../domain/paper-gate-write.js';
import type { RegimeGatePhase } from '../../domain/paper-regime.js';
import { grantsAuditedPolicy } from './paper-gate-audited-policy-gate.js';
import {
  PAPER_GATE_WRITE_LOCK_ACQUIRE_WITH_PID_SQL,
  PAPER_GATE_WRITE_LOCK_OWNERSHIP_SQL,
  PAPER_GATE_WRITE_LOCK_RELEASE_ALL_SQL,
  PAPER_GATE_WRITE_LOCK_RELEASE_SQL,
  classifyPaperGateWriteLockEndpoint,
  paperGateWriteLockText,
  verifyPaperGateWriteLockOwnership,
  type PaperGateWriteLockMode,
  type PaperGateWriteLockVerdict,
} from './paper-gate-write-lock.js';
import { MICRO, readPaperAuthorityRawInTransaction } from './paper-authority-sql.js';

const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const UNIQUE_VIOLATION = '23505';
/** `lock_timeout` elapsed while waiting for a lock, and the statement-level cancel that
 * can surface instead. Both arrive BEFORE any mutation when they come from acquisition. */
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

/** Thrown for any refusal decided after the first mutation, so the transaction rolls
 * back and the refusal is mapped OUTSIDE the transaction. A normal return would
 * COMMIT. */
class PaperGateWriteControl extends Error {
  constructor(
    readonly refusal: PaperGateWriteRefusal,
    readonly detail: string,
  ) {
    super('paper-gate-write-control');
    this.name = 'PaperGateWriteControl';
  }
}

export interface PaperGateWriter {
  write(request: PaperGateWriteRequest, fence: PaperGateFence): Promise<PaperGateWriteResult>;
  close(): Promise<void>;
}

export interface PaperGateWriterOptions {
  /** Per-capability write serialization. `off` is the default and preserves the measured
   * non-participating behaviour; `required` takes the session-level advisory lock on a
   * connection it opens for that call, before `BEGIN`. It changes serialization only and
   * can never grant admission.
   *
   * Recorder participation was approved by Rai on 2026-10-18 as CODE AND TESTS ONLY: the
   * platform-API recorder now takes the same key, but nothing is deployed or activated.
   * **Current write admission remains unclaimed** until a deployment in which the engine
   * writer runs `required` on a DIRECT endpoint and the recorder build carrying that
   * statement is live. */
  capabilityWriteLock?: PaperGateWriteLockMode;
}

export interface PaperGateWriterTestEffects {
  /** Between the standing-intent read and everything compared against it. */
  afterAuthorityRead?: () => Promise<void>;
  /** After the event row is inserted and before the head move, for the rollback test. */
  afterEventInsert?: () => Promise<void>;
  /** After every mutation, before the final fence; receives this transaction's own
   * backend process id so a test can observe the locking statement genuinely blocked. */
  beforeFinalFence?: (context: { backendPid: number }) => Promise<void>;
  /** Reports how the per-capability lock was released, so a test can prove no lock is
   * left behind on a connection that returns to the pool. */
  onWriteLockCleanup?: (outcome: 'released' | 'released-all' | 'cleanup-failed') => void;
  /** Reports the fail-closed ownership verdict taken as the first statement inside the
   * transaction, so a test can prove the check ran and what it concluded. */
  onWriteLockOwnership?: (verdict: PaperGateWriteLockVerdict) => void;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const micro = (value: unknown): bigint | undefined => {
  const raw = text(value);
  return raw !== undefined && /^-?[0-9]{1,25}$/.test(raw) ? BigInt(raw) : undefined;
};

const count = (value: unknown): number | undefined => {
  const raw = text(value);
  if (raw === undefined || !/^[0-9]{1,7}$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

/** MODULE-PRIVATE. Not exported, so no artifact offers an availability-taking entry
 * point; the only way in is the factory below, through this artifact's own gate. */
function createPaperGateWriterCore(
  connectionString: string,
  auditedBundleAvailable: boolean,
  testEffects?: PaperGateWriterTestEffects,
  lockMode: PaperGateWriteLockMode = 'off',
): PaperGateWriter {
  /** The reader's bounds, unchanged, and shared with the per-write locked connection so
   * no timeout differs between the two paths. */
  const CONNECTION_OPTIONS = {
    max: 1,
    prepare: false,
    connection: {
      statement_timeout: 5000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 8000,
    },
  } as const;
  const sql = postgres(connectionString, CONNECTION_OPTIONS);
  type Transaction = postgres.TransactionSql;

  async function one(
    tx: Transaction,
    query: string,
    values: readonly unknown[],
  ): Promise<Record<string, unknown> | null> {
    const rows = await tx.unsafe(query, values as never[]);
    return rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
  }

  return {
    async write(request, fence): Promise<PaperGateWriteResult> {
      const invalid = paperGateWriteRequestIsValid(request, fence);
      if (invalid !== undefined) return { detail: invalid, kind: 'refused', reason: invalid };
      const scope = request.scope;
      if (!scope.budget_id.endsWith(':paper'))
        return { detail: 'budget-identity', kind: 'refused', reason: 'scope' };
      const observedMs = paperGateIsoMilliseconds(request.evidenceObservedAtIso) as number;
      const namespace = [
        scope.generation_key,
        scope.funding_id,
        scope.epoch,
        scope.budget_id,
        scope.generation_config_intent_id,
        scope.sample_policy,
      ];
      // 1b. Per-capability write serialization, when required. The lock is SESSION level
      // on a connection opened for this one call, taken BEFORE `BEGIN`, so the snapshot
      // below is taken after the wait rather than before it; a transactional lock taken
      // as the first statement would snapshot first and would not be sufficient.
      // Reservation is not optional: `max: 1` alone cannot stop two overlapping calls
      // from sharing a backend, and session advisory locks are re-entrant per session.
      const lockText = paperGateWriteLockText(fence.capability);
      // This call's OWN physical connection, not a handle borrowed from a shared pool.
      // That is what makes the session-level lock safe: session advisory locks are
      // re-entrant per session, so two overlapping calls sharing a backend would each
      // believe they held it, and `max: 1` cannot prevent that. postgres.js reserved
      // handles also expose no `begin`, so a per-call connection is the only way to run
      // the transaction on the very session that holds the lock. It is CLOSED in the
      // `finally` below, so even a release that fails cannot leave a lock behind.
      let locked: ReturnType<typeof postgres> | undefined;
      let lockHeld = false;
      let acquiringBackendPid: number | undefined;
      if (lockMode === 'required') {
        // A host this project KNOWS multiplexes sessions cannot carry a session-level
        // lock at all, so `required` mode refuses BEFORE any connection is opened and
        // before anything is acquired. An unclassified host is NOT thereby proven direct:
        // that remains an explicit wiring prerequisite, documented in the lock module.
        if (classifyPaperGateWriteLockEndpoint(connectionString) === 'known-transaction-pooler')
          return { detail: 'write-lock-endpoint-pooled', kind: 'refused', reason: 'conflict' };
        const connection = postgres(connectionString, CONNECTION_OPTIONS);
        try {
          // Bounded by this connection's EXISTING `lock_timeout`; no new tolerance. The
          // acquiring backend reports itself in the SAME statement, so the pid cannot
          // belong to a session other than the one that took the lock.
          const acquired = await connection.unsafe(PAPER_GATE_WRITE_LOCK_ACQUIRE_WITH_PID_SQL, [
            lockText,
          ] as never[]);
          acquiringBackendPid = Number(
            (acquired[0] as { pid?: unknown } | undefined)?.pid ?? Number.NaN,
          );
        } catch (error) {
          const code = (error as { code?: string }).code;
          // Nothing was locked and nothing was written; the transaction never began, so
          // this connection is closed here and the `finally` below never sees it.
          await connection.end({ timeout: 5 });
          if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED)
            return { detail: 'write-lock-timeout', kind: 'refused', reason: 'conflict' };
          throw error;
        }
        // Assigned only once the lock is genuinely held, so the cleanup path below is
        // reached exactly when there is something to clean up.
        locked = connection;
        lockHeld = true;
      }
      const runner = locked ?? sql;
      try {
        return await runner.begin('isolation level serializable', async (tx) => {
          // 1c. FAIL-CLOSED ownership check, as the FIRST statement after `BEGIN` and
          // before any read or mutation: the backend running this transaction must be the
          // backend that acquired the lock, and must be a granted holder of this exact
          // key. A mismatch refuses here, with nothing written.
          if (lockMode === 'required') {
            const ownership = await one(tx, PAPER_GATE_WRITE_LOCK_OWNERSHIP_SQL, [lockText]);
            const verdict = verifyPaperGateWriteLockOwnership({
              acquiringBackendPid,
              heldByThisBackend: count(ownership?.held),
              transactionBackendPid: Number(ownership?.pid ?? Number.NaN),
            });
            testEffects?.onWriteLockOwnership?.(verdict);
            if (!verdict.ok)
              return {
                detail: 'write-lock-' + verdict.detail,
                kind: 'refused',
                reason: 'conflict' as const,
              };
          }

          // 2. Start fence on the DATABASE clock.
          const lease = await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp()',
            [fence.capability, fence.owner, fence.fencingToken.toString()],
          );
          if (lease.length !== 1)
            return { detail: 'start-boundary', kind: 'refused', reason: 'lease-not-held' as const };

          // 3. The event this request names, if it is already recorded.
          const existing = await one(
            tx,
            `select generation_key,funding_id,epoch::text as epoch_text,budget_id,generation_config_intent_id,sample_policy,event_kind,revision_after::text as revision_after,prior_event_key,revision_before::text as revision_before,previous_phase,result_phase,projected_phase,current_effect_config_intent_id,latest_intent_id,run_id,source_kind,evidence_version,coverage_receipt_id,${MICRO('evidence_observed_at')} as evidence_observed_at_us,${MICRO('coverage_cutoff_at')} as coverage_cutoff_at_us,captured_candidate_count::text as captured_candidate_count,captured_resolved_count::text as captured_resolved_count,captured_unresolved_count::text as captured_unresolved_count,input_count::text as input_count,${MICRO('universe_first_closes_at')} as universe_first_closes_at_us,${MICRO('universe_last_closes_at')} as universe_last_closes_at_us,(select p.run_id from engine.paper_gate_phase_event p where p.event_key=paper_gate_phase_event.prior_event_key) as prior_event_run_id from engine.paper_gate_phase_event where event_key=$1`,
            [request.eventKey],
          );

          // 4. Run record bound to this capability.
          const run = await one(
            tx,
            'select run_id,capability,mode from engine.job_run_record where run_id=$1',
            [request.runId],
          );
          if (run === null || run.capability !== fence.capability)
            return { detail: 'run-binding', kind: 'refused', reason: 'run-record' as const };

          const generationRow = await one(
            tx,
            'select generation_key,actor,bundle_id,gate_formula,sample_policy,settings_descriptor,enabled,minimum_policy_windows::text as minimum_policy_windows,evidence_half_life_windows::text as evidence_half_life_windows,pause_confidence::text as pause_confidence,resume_confidence::text as resume_confidence,initialization_run_id,reset_origin,reset_barrier_intent_id from engine.paper_gate_generation where generation_key=$1 and funding_id=$2 and epoch=$3 and budget_id=$4 and generation_config_intent_id=$5 and sample_policy=$6',
            namespace,
          );
          const headRow = await one(
            tx,
            // The head event's own `run_id` comes with it: a persisted regime lineage's
            // state run is the run that WROTE the current head event, not the
            // generation's initialization run.
            'select h.generation_key,h.latest_event_key,h.revision::text as revision,h.event_kind,h.projected_phase,e.run_id as head_event_run_id from engine.paper_gate_head h join engine.paper_gate_phase_event e on e.event_key=h.latest_event_key where h.generation_key=$1',
            [scope.generation_key],
          );

          const genesisIntent = (): PaperGateIntendedEvent => ({
            capturedCandidateCount: 0,
            capturedResolvedCount: 0,
            capturedUnresolvedCount: 0,
            eventKind: 'genesis',
            inputCandidateKeys: [],
            inputCount: 0,
            previousPhase: undefined,
            priorEventKey: undefined,
            projectedPhase: 'warming',
            revisionAfter: PAPER_GATE_GENESIS_REVISION,
            revisionBefore: undefined,
            universeFirstClosesAtMicroseconds: undefined,
            universeLastClosesAtMicroseconds: undefined,
          });

          type Derived = {
            intended: PaperGateIntendedEvent;
            inputEntries: readonly PaperGateUniverseEntry[];
            regime: {
              summaryResolvedWindows: number;
              effectiveWindows: string;
              weightedMeanEdge: string | null;
              standardError: string | null;
              negativeReturnConfidence: string | null;
            };
          };

          /** The evaluated payload a write at `revisionBefore` would persist. Used by the
           * write path with the PRESENT head, and by the replay path with the RECORDED
           * revision, so a replay never depends on present state. */
          const deriveEvaluated = async (
            revisionBefore: bigint,
            priorEventKey: string | undefined,
            previousPhase: RegimeGatePhase,
            nowMs: number,
            /** The run that wrote the event this transition follows. Required for a
             * persisted lineage; absent only at genesis, where the lineage is the
             * initialization run instead. */
            priorEventRunId: string | undefined,
          ): Promise<Derived | { refusal: PaperGateWriteRefusal; detail: string }> => {
            if (generationRow === null) return { detail: 'absent', refusal: 'generation' };
            const minimumPolicyWindows = count(generationRow.minimum_policy_windows);
            if (minimumPolicyWindows === undefined)
              return { detail: 'settings', refusal: 'generation' };
            // PostgreSQL applies the cutoff: a candidate created after it is outside this
            // universe, and an outcome recorded after it leaves its candidate unresolved.
            // One row past the schema ceiling so an illegal universe fails closed.
            const universe = await tx.unsafe(
              `select c.candidate_key,${MICRO('c.closes_at')} as closes_at_us,c.contract_id,c.side,case when o.candidate_key is null then null else ${MICRO('o.resolved_at')} end as resolved_at_us,case when o.candidate_key is null then null else ${MICRO('o.recorded_at')} end as recorded_at_us,case when o.candidate_key is null then null else o.realized_edge::text end as realized_edge from engine.paper_gate_candidate c left join engine.paper_gate_outcome o on o.candidate_key=c.candidate_key and o.recorded_at <= $7::text::timestamptz where c.generation_key=$1 and c.funding_id=$2 and c.epoch=$3 and c.budget_id=$4 and c.generation_config_intent_id=$5 and c.sample_policy=$6 and c.created_at <= $7::text::timestamptz order by c.closes_at,c.candidate_key limit ${PAPER_GATE_UNIVERSE_LIMIT + 1}`,
              [...namespace, request.coverageCutoffAtIso] as never[],
            );
            const entries: PaperGateUniverseEntry[] = [];
            for (const row of universe) {
              const key = text(row.candidate_key);
              const closes = micro(row.closes_at_us);
              const contractId = text(row.contract_id);
              const side = text(row.side);
              if (
                key === undefined ||
                closes === undefined ||
                contractId === undefined ||
                side === undefined
              )
                return { detail: 'candidate-representation', refusal: 'universe' };
              entries.push({
                candidateKey: key,
                closesAtMicroseconds: closes,
                contractId,
                outcomeRecordedAtMicroseconds: micro(row.recorded_at_us),
                outcomeResolvedAtMicroseconds: micro(row.resolved_at_us),
                realizedEdge: text(row.realized_edge),
                side,
              });
            }
            const universeShape = derivePaperGateUniverse(entries);
            if (universeShape === undefined)
              return { detail: 'universe-shape', refusal: 'universe' };
            if (revisionBefore !== PAPER_GATE_GENESIS_REVISION && priorEventRunId === undefined)
              return { detail: 'prior-event-run', refusal: 'head' };
            const lineage =
              revisionBefore === PAPER_GATE_GENESIS_REVISION
                ? ({
                    initializationRunId: String(generationRow.initialization_run_id),
                    kind: 'initialized',
                    priorGenerationState: 'none',
                    revision: 0,
                  } as const)
                : ({
                    kind: 'persisted',
                    revision: Number(revisionBefore),
                    // The run that wrote the event being followed, as 0006 records it.
                    stateRunId: priorEventRunId ?? '',
                  } as const);
            const outcome = derivePaperGateEvaluation(
              {
                bundleId: String(generationRow.bundle_id),
                configIntentId: scope.generation_config_intent_id,
                enabled: generationRow.enabled === true,
                epoch: scope.epoch,
                evidenceHalfLifeWindows: String(generationRow.evidence_half_life_windows),
                gateFormula: String(generationRow.gate_formula),
                initializationRunId: String(generationRow.initialization_run_id),
                minimumPolicyWindows,
                pauseConfidence: String(generationRow.pause_confidence),
                resumeConfidence: String(generationRow.resume_confidence),
                samplePolicy: String(generationRow.sample_policy),
                settingsDescriptor: String(generationRow.settings_descriptor),
              },
              entries,
              previousPhase,
              lineage,
              observedMs,
              nowMs,
            );
            if ('refusal' in outcome) return { detail: outcome.detail, refusal: outcome.refusal };
            return {
              inputEntries: outcome.inputs,
              intended: {
                capturedCandidateCount: universeShape.capturedCandidateCount,
                capturedResolvedCount: universeShape.capturedResolvedCount,
                capturedUnresolvedCount: universeShape.capturedUnresolvedCount,
                eventKind: 'evaluated',
                inputCandidateKeys: outcome.inputs.map((entry) => entry.candidateKey),
                inputCount: universeShape.capturedResolvedCount,
                previousPhase,
                priorEventKey,
                projectedPhase: outcome.evaluation.phase,
                revisionAfter: revisionBefore + 1n,
                revisionBefore,
                universeFirstClosesAtMicroseconds: universeShape.firstClosesAtMicroseconds,
                universeLastClosesAtMicroseconds: universeShape.lastClosesAtMicroseconds,
              },
              regime: {
                effectiveWindows: String(outcome.evaluation.effectiveWindows),
                negativeReturnConfidence:
                  outcome.evaluation.negativeReturnConfidence === null
                    ? null
                    : String(outcome.evaluation.negativeReturnConfidence),
                standardError:
                  outcome.evaluation.standardError === null
                    ? null
                    : String(outcome.evaluation.standardError),
                summaryResolvedWindows: outcome.evaluation.resolvedWindows,
                weightedMeanEdge:
                  outcome.evaluation.weightedMeanEdge === null
                    ? null
                    : String(outcome.evaluation.weightedMeanEdge),
              },
            };
          };

          // The DATABASE clock as whole milliseconds, floored. The regime arithmetic takes
          // integer milliseconds and only compares `observedAtMs <= nowMs`, so flooring the
          // current instant is conservative, never permissive. No JS clock is consulted.
          const clockRow = await one(tx, `select ${MICRO('clock_timestamp()')} as now_us`, []);
          const nowMicro = clockRow === null ? undefined : micro(clockRow.now_us);
          if (nowMicro === undefined)
            return { detail: 'clock', kind: 'refused', reason: 'universe' as const };
          const nowMs = Number(nowMicro / 1000n);
          if (!Number.isSafeInteger(nowMs))
            return { detail: 'clock', kind: 'refused', reason: 'universe' as const };

          // ---- 5. REPLAY. Derived against the RECORDED revision, with NO present
          // authority read, so a replay can never be mistaken for present write
          // admission and never depends on where the head is now. ----
          if (existing !== null) {
            const recordedBefore = micro(existing.revision_before);
            let replayIntended: PaperGateIntendedEvent;
            if (String(existing.event_kind) === 'evaluated') {
              if (recordedBefore === undefined)
                return {
                  detail: 'revision_before',
                  kind: 'refused',
                  reason: 'replay-mismatch' as const,
                };
              const previousPhase = text(existing.previous_phase) as RegimeGatePhase | undefined;
              if (previousPhase === undefined)
                return {
                  detail: 'previous_phase',
                  kind: 'refused',
                  reason: 'replay-mismatch' as const,
                };
              const derived = await deriveEvaluated(
                recordedBefore,
                text(existing.prior_event_key),
                previousPhase,
                nowMs,
                // On replay the prior event is the one the RECORDED event follows, read
                // from history rather than from the present head.
                text(existing.prior_event_run_id),
              );
              if ('refusal' in derived)
                return { detail: derived.detail, kind: 'refused', reason: derived.refusal };
              replayIntended = derived.intended;
            } else {
              replayIntended = genesisIntent();
              // F3: a genesis or reset replay must agree on the GENERATION as well. The
              // three `numeric` settings are compared by PostgreSQL against the request's
              // decimal text, so the comparison is exact and introduces no JS coercion.
              const g = request.kind === 'evaluate' ? undefined : request.generation;
              const persistedGeneration =
                g === undefined
                  ? null
                  : await one(
                      tx,
                      'select bundle_id,profile_claim,enabled,minimum_policy_windows::text as minimum_policy_windows,(evidence_half_life_windows = $7::text::numeric) as half_matches,(pause_confidence = $8::text::numeric) as pause_matches,(resume_confidence = $9::text::numeric) as resume_matches,initialization_run_id,reset_origin,reset_barrier_intent_id from engine.paper_gate_generation where generation_key=$1 and funding_id=$2 and epoch=$3 and budget_id=$4 and generation_config_intent_id=$5 and sample_policy=$6',
                      [
                        ...namespace,
                        g.evidenceHalfLifeWindows,
                        g.pauseConfidence,
                        g.resumeConfidence,
                      ],
                    );
              if (persistedGeneration === null)
                return {
                  detail: 'generation',
                  kind: 'refused',
                  reason: 'replay-mismatch' as const,
                };
              // `priorGenerationKey` is not persisted, so it is re-derived against real
              // history with the SAME predicate the write path applied, using the
              // PERSISTED barrier rather than the request's claim.
              let priorVerified: boolean | undefined;
              if (request.kind === 'reset') {
                const verified = await one(
                  tx,
                  // Every parameter is used, so PostgreSQL can infer each type.
                  "select g.generation_key from engine.paper_gate_generation g join engine.control_intent p on p.id=g.generation_config_intent_id join engine.control_intent b on b.id=$1 where g.generation_key=$2 and g.funding_id=$3 and g.epoch=$4 and g.budget_id=$5 and b.capability=$6 and b.action='reset' and row(b.epoch,b.recorded_at,b.id) > row(p.epoch,p.recorded_at,p.id)",
                  [
                    text(persistedGeneration.reset_barrier_intent_id) ?? '',
                    request.priorGenerationKey,
                    scope.funding_id,
                    scope.epoch,
                    scope.budget_id,
                    fence.capability,
                  ],
                );
                priorVerified = verified !== null;
              }
              const generationMismatch = comparePaperGateGenerationReplay(
                {
                  bundleId: String(persistedGeneration.bundle_id),
                  enabled: persistedGeneration.enabled === true,
                  evidenceHalfLifeMatches: persistedGeneration.half_matches === true,
                  initializationRunId: String(persistedGeneration.initialization_run_id),
                  minimumPolicyWindows: String(persistedGeneration.minimum_policy_windows),
                  pauseConfidenceMatches: persistedGeneration.pause_matches === true,
                  priorGenerationVerified: priorVerified,
                  profileClaim: String(persistedGeneration.profile_claim),
                  resetBarrierIntentId: text(persistedGeneration.reset_barrier_intent_id),
                  resetOrigin: String(persistedGeneration.reset_origin),
                  resumeConfidenceMatches: persistedGeneration.resume_matches === true,
                },
                request,
              );
              if (generationMismatch !== undefined)
                return {
                  detail: generationMismatch,
                  kind: 'refused',
                  reason: 'replay-mismatch' as const,
                };
            }
            const inputs = await tx.unsafe(
              'select candidate_key from engine.paper_gate_phase_input where event_key=$1 order by ordinal',
              [request.eventKey] as never[],
            );
            const mismatch = comparePaperGateReplay(
              {
                budgetId: String(existing.budget_id),
                capturedCandidateCount: count(existing.captured_candidate_count) ?? -1,
                capturedResolvedCount: count(existing.captured_resolved_count) ?? -1,
                capturedUnresolvedCount: count(existing.captured_unresolved_count) ?? -1,
                configIntentId: String(existing.generation_config_intent_id),
                coverageCutoffAtMicroseconds: micro(existing.coverage_cutoff_at_us) ?? -1n,
                coverageReceiptId: String(existing.coverage_receipt_id),
                currentEffectConfigIntentId: String(existing.current_effect_config_intent_id),
                // The canonical epoch parser, not the small count parser: the full
                // PostgreSQL integer domain is legitimate here.
                epoch: paperGateEpochFromText(existing.epoch_text) ?? -1,
                eventKind: String(existing.event_kind),
                evidenceObservedAtMicroseconds: micro(existing.evidence_observed_at_us) ?? -1n,
                evidenceVersion: String(existing.evidence_version),
                fundingId: String(existing.funding_id),
                generationKey: String(existing.generation_key),
                inputCandidateKeys: inputs.map((row) => String(row.candidate_key)),
                inputCount: count(existing.input_count) ?? -1,
                latestIntentId: String(existing.latest_intent_id),
                previousPhase: text(existing.previous_phase),
                priorEventKey: text(existing.prior_event_key),
                projectedPhase: String(existing.projected_phase),
                resultPhase: text(existing.result_phase),
                revisionAfter: micro(existing.revision_after) ?? -1n,
                revisionBefore: recordedBefore,
                runId: String(existing.run_id),
                samplePolicy: String(existing.sample_policy),
                sourceKind: String(existing.source_kind),
                universeFirstClosesAtMicroseconds: micro(existing.universe_first_closes_at_us),
                universeLastClosesAtMicroseconds: micro(existing.universe_last_closes_at_us),
              },
              replayIntended,
              request,
            );
            if (mismatch !== undefined)
              return { detail: mismatch, kind: 'refused', reason: 'replay-mismatch' as const };
            return {
              kind: 'replayed' as const,
              receipt: {
                admission: 'none',
                authority: 'not-evaluated-on-replay',
                boundConfigureIntentId: String(existing.current_effect_config_intent_id),
                boundLatestIntentId: String(existing.latest_intent_id),
                derived: {
                  capturedCandidateCount: replayIntended.capturedCandidateCount,
                  capturedResolvedCount: replayIntended.capturedResolvedCount,
                  capturedUnresolvedCount: replayIntended.capturedUnresolvedCount,
                  firstClosesAtMicroseconds: replayIntended.universeFirstClosesAtMicroseconds,
                  lastClosesAtMicroseconds: replayIntended.universeLastClosesAtMicroseconds,
                },
                eventKey: request.eventKey,
                eventKind: replayIntended.eventKind,
                generationCreated: false,
                headMoved: false,
                inputCandidateKeys: replayIntended.inputCandidateKeys,
                lifetime: 'committed-write-record-not-standing-authority',
                previousPhase: replayIntended.previousPhase,
                projectedPhase: replayIntended.projectedPhase,
                protocol: 'paper-gate-persisted-write-result-v1',
                revisionAfter: replayIntended.revisionAfter,
                revisionBefore: replayIntended.revisionBefore,
                scope,
                validity: 'single-transaction-snapshot-only',
              },
            };
          }

          // ---- 6. WRITE PATH. Present authority, in THIS transaction, through the SAME
          // shared statements the reader uses. A historical receipt, a caller boolean or
          // a caller-supplied config id is never accepted in its place. ----
          const raw = await readPaperAuthorityRawInTransaction(
            tx,
            fence.capability,
            scope.epoch,
            true,
            testEffects?.afterAuthorityRead,
          );
          const evidence = buildPaperAuthorityEvidence(
            // The START fence result, which was proved above and is all this evidence is
            // used for: the authority DECISION. It is deliberately not the final fence —
            // that happens after the mutations, below, and a failure there throws so the
            // whole transaction rolls back. Nothing here is a caller permission.
            { ...raw, leaseStillHeld: true },
            { capability: fence.capability, epoch: scope.epoch },
            fence,
          );
          if (evidence.kind !== 'read')
            return { detail: evidence.detail, kind: 'refused', reason: 'authority' as const };
          const decision = evaluatePaperAuthority(
            evidence.evidence.snapshot,
            auditedBundleAvailable,
          );
          if (!decision.allowed)
            return { detail: decision.reason, kind: 'refused', reason: 'authority' as const };
          // The scope must be the identity the control record actually names. The caller
          // supplies no part of this binding.
          if (
            decision.config.funding_id !== scope.funding_id ||
            decision.config.budget_id !== scope.budget_id ||
            decision.configIntentId !== scope.generation_config_intent_id ||
            evidence.evidence.snapshot.epoch !== scope.epoch
          )
            return {
              detail: 'scope-not-authorised',
              kind: 'refused',
              reason: 'authority' as const,
            };

          let intended: PaperGateIntendedEvent;
          let inputEntries: readonly PaperGateUniverseEntry[] = [];
          let regimeNumbers = {
            effectiveWindows: '0',
            negativeReturnConfidence: null as string | null,
            standardError: null as string | null,
            summaryResolvedWindows: 0,
            weightedMeanEdge: null as string | null,
          };

          if (request.kind === 'evaluate') {
            if (generationRow === null)
              return { detail: 'absent', kind: 'refused', reason: 'generation' as const };
            if (headRow === null)
              return { detail: 'absent', kind: 'refused', reason: 'head' as const };
            const headRevision = micro(headRow.revision);
            if (headRevision === undefined)
              return { detail: 'revision', kind: 'refused', reason: 'head' as const };
            // CAS precondition, before any mutation.
            if (request.expectedRevision !== headRevision)
              return {
                detail: 'head-at-' + headRevision.toString(),
                kind: 'refused',
                reason: 'stale-revision' as const,
              };
            const previousPhase = text(headRow.projected_phase) as RegimeGatePhase | undefined;
            if (previousPhase === undefined)
              return { detail: 'previous-phase', kind: 'refused', reason: 'head' as const };
            const derived = await deriveEvaluated(
              headRevision,
              text(headRow.latest_event_key),
              previousPhase,
              nowMs,
              text(headRow.head_event_run_id),
            );
            if ('refusal' in derived)
              return { detail: derived.detail, kind: 'refused', reason: derived.refusal };
            intended = derived.intended;
            inputEntries = derived.inputEntries;
            regimeNumbers = derived.regime;
          } else {
            // Genesis, for a brand new generation or for a properly barriered reset.
            if (generationRow !== null)
              return { detail: 'present', kind: 'refused', reason: 'generation-exists' as const };
            if (headRow !== null)
              return { detail: 'present', kind: 'refused', reason: 'head' as const };
            // F4: the key is not the namespace. 0006's primary key is the generation key
            // alone, so a second generation could otherwise occupy the SAME
            // (funding, epoch, budget, config intent, policy) under a different key.
            // Occupancy is checked against the real namespace, and the lineage kind is
            // DERIVED from history rather than taken from `request.kind`.
            const occupancy = await one(
              tx,
              'select (select count(*) from engine.paper_gate_generation g where g.funding_id=$1 and g.epoch=$2 and g.budget_id=$3 and g.generation_config_intent_id=$4 and g.sample_policy=$5)::text as exact_namespace, (select count(*) from engine.paper_gate_generation g where g.funding_id=$1 and g.epoch=$2 and g.budget_id=$3)::text as budget_namespace',
              [
                scope.funding_id,
                scope.epoch,
                scope.budget_id,
                scope.generation_config_intent_id,
                scope.sample_policy,
              ],
            );
            const exactNamespace = count(occupancy?.exact_namespace);
            const budgetNamespace = count(occupancy?.budget_namespace);
            if (exactNamespace === undefined || budgetNamespace === undefined)
              return { detail: 'occupancy', kind: 'refused', reason: 'generation' as const };
            if (exactNamespace > 0)
              return {
                detail: 'namespace-occupied',
                kind: 'refused',
                reason: 'generation-exists' as const,
              };
            // A first generation for this budget namespace is an initialization; any
            // later one follows an existing generation and must therefore be a reset with
            // a real barrier. A post-reset configure presented as `initialize` is
            // refused rather than mislabelled `none`.
            const derivedKind = budgetNamespace === 0 ? 'initialize' : 'reset';
            if (request.kind !== derivedKind)
              return {
                detail: 'lineage-kind-' + derivedKind,
                kind: 'refused',
                reason: 'generation' as const,
              };
            if (request.kind === 'reset') {
              // The barrier is the schema's own `reset_origin='post-reset'` plus a real
              // reset intent, not a caller label: it must be an actual `reset` for this
              // capability, it must order strictly AFTER the prior generation's configure
              // intent, and the new generation's own configure must itself be post-reset,
              // which the authority decision above already required.
              const barrier = await one(
                tx,
                "select b.id from engine.control_intent b join engine.paper_gate_generation g on g.generation_key=$3 join engine.control_intent p on p.id=g.generation_config_intent_id where b.id=$1 and b.capability=$2 and b.action='reset' and row(b.epoch,b.recorded_at,b.id) > row(p.epoch,p.recorded_at,p.id) and g.funding_id=$4 and g.epoch=$5 and g.budget_id=$6",
                [
                  request.resetBarrierIntentId,
                  fence.capability,
                  request.priorGenerationKey,
                  scope.funding_id,
                  scope.epoch,
                  scope.budget_id,
                ],
              );
              if (barrier === null)
                return {
                  detail: 'barrier-ordering',
                  kind: 'refused',
                  reason: 'reset-barrier' as const,
                };
            }
            intended = genesisIntent();
          }

          // ---- 7. MUTATIONS. Every refusal below THROWS so the work rolls back. ----
          const fail = (refusal: PaperGateWriteRefusal, detail: string): never => {
            throw new PaperGateWriteControl(refusal, detail);
          };
          let generationCreated = false;
          if (request.kind !== 'evaluate') {
            await tx.unsafe(
              "insert into engine.paper_gate_generation(generation_key,funding_id,epoch,budget_id,actor,generation_config_intent_id,initialization_run_id,source_kind,sample_policy,gate_formula,bundle_id,profile_claim,settings_descriptor,enabled,minimum_policy_windows,evidence_half_life_windows,pause_confidence,resume_confidence,reset_origin,reset_barrier_intent_id,initialized_at) values($1,$2,$3,$4,$5,$6,$7,'prospective-engine-run',$8,'adaptive-fee-edge-window-v1',$9,$10,$11,$12,$13,$14::text::numeric,$15::text::numeric,$16::text::numeric,$17,$18,clock_timestamp())",
              [
                scope.generation_key,
                scope.funding_id,
                scope.epoch,
                scope.budget_id,
                scope.budget_id.slice(0, -':paper'.length),
                scope.generation_config_intent_id,
                request.runId,
                scope.sample_policy,
                request.generation.bundleId,
                request.generation.profileClaim,
                // The descriptor IS `paperRegimeSettingsIdentity(...)` of these very
                // columns, built from the same values the row stores.
                [
                  'regime-settings-v1',
                  request.generation.enabled,
                  request.generation.minimumPolicyWindows,
                  Number(request.generation.evidenceHalfLifeWindows),
                  Number(request.generation.pauseConfidence),
                  Number(request.generation.resumeConfidence),
                ].join(':'),
                request.generation.enabled,
                request.generation.minimumPolicyWindows,
                request.generation.evidenceHalfLifeWindows,
                request.generation.pauseConfidence,
                request.generation.resumeConfidence,
                request.kind === 'reset' ? 'post-reset' : 'none',
                request.kind === 'reset' ? request.resetBarrierIntentId : null,
              ] as never[],
            );
            generationCreated = true;
          }

          const inserted = await tx.unsafe(
            "insert into engine.paper_gate_phase_event(event_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,event_kind,revision_after,prior_event_key,revision_before,previous_phase,result_phase,projected_phase,current_effect_config_intent_id,latest_intent_id,run_id,source_kind,evidence_version,coverage_receipt_id,evidence_observed_at,coverage_cutoff_at,recorded_at,captured_candidate_count,captured_resolved_count,captured_unresolved_count,input_count,universe_first_closes_at,universe_last_closes_at,summary_resolved_windows,effective_windows,weighted_mean_edge,standard_error,negative_return_confidence) values($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11::bigint,$12,$13,$14,$15,$16,$17,'prospective-engine-run',$18,$19,$20::text::timestamptz,$21::text::timestamptz,clock_timestamp(),$22,$23,$24,$25,(select min(b.closes_at) from engine.paper_gate_candidate b where b.generation_key=$2 and b.funding_id=$3 and b.epoch=$4 and b.budget_id=$5 and b.generation_config_intent_id=$6 and b.sample_policy=$7 and b.created_at <= $21::text::timestamptz and $8='evaluated'),(select max(b.closes_at) from engine.paper_gate_candidate b where b.generation_key=$2 and b.funding_id=$3 and b.epoch=$4 and b.budget_id=$5 and b.generation_config_intent_id=$6 and b.sample_policy=$7 and b.created_at <= $21::text::timestamptz and $8='evaluated'),$26,$27::text::numeric,$28::text::numeric,$29::text::numeric,$30::text::numeric) returning event_key,(extract(epoch from universe_first_closes_at)*1000000)::numeric(30,0)::text as universe_first_closes_at_us,(extract(epoch from universe_last_closes_at)*1000000)::numeric(30,0)::text as universe_last_closes_at_us",
            [
              request.eventKey,
              ...namespace,
              intended.eventKind,
              intended.revisionAfter.toString(),
              intended.priorEventKey ?? null,
              intended.revisionBefore === undefined ? null : intended.revisionBefore.toString(),
              intended.previousPhase ?? null,
              intended.eventKind === 'genesis' ? null : intended.projectedPhase,
              intended.projectedPhase,
              decision.configIntentId,
              decision.latestIntentId,
              request.runId,
              PAPER_GATE_EVIDENCE_VERSION,
              request.coverageReceiptId,
              request.evidenceObservedAtIso,
              request.coverageCutoffAtIso,
              intended.capturedCandidateCount,
              intended.capturedResolvedCount,
              intended.capturedUnresolvedCount,
              intended.inputCount,
              // The universe bounds are NOT transported: the statement derives them with
              // `min`/`max` over the same predicate, so the stored instants are exact
              // timestamptz values the server read, never a microsecond integer
              // multiplied by an interval in float8. The insert returns them and they are
              // cross-checked against the derived values below.
              regimeNumbers.summaryResolvedWindows,
              regimeNumbers.effectiveWindows,
              regimeNumbers.weightedMeanEdge,
              regimeNumbers.standardError,
              regimeNumbers.negativeReturnConfidence,
            ] as never[],
          );
          const insertedRow =
            inserted.length === 1 ? (inserted[0] as Record<string, unknown>) : null;
          if (insertedRow === null) fail('conflict', 'event-insert');
          // The server-derived bounds must be exactly what was derived from the same rows.
          // A disagreement means the two predicates diverged and the event must not stand.
          if (
            micro(insertedRow?.universe_first_closes_at_us) !==
              intended.universeFirstClosesAtMicroseconds ||
            micro(insertedRow?.universe_last_closes_at_us) !==
              intended.universeLastClosesAtMicroseconds
          )
            fail('conflict', 'universe-bound-mismatch');
          await testEffects?.afterEventInsert?.();

          if (intended.inputCandidateKeys.length > 0) {
            // Ordered inputs, written by the SERVER from the candidate rows themselves, so
            // no timestamp or identity round-trips through JS.
            const insertedInputs = await tx.unsafe(
              "insert into engine.paper_gate_phase_input(event_key,ordinal,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,revision_after,event_kind,projected_phase,candidate_key,closes_at,contract_id,side) select $1,(k.ord-1)::int,c.generation_key,c.funding_id,c.epoch,c.budget_id,c.generation_config_intent_id,c.sample_policy,$2::bigint,'evaluated',$3,c.candidate_key,c.closes_at,c.contract_id,c.side from unnest($4::text[]) with ordinality as k(candidate_key,ord) join engine.paper_gate_candidate c on c.candidate_key=k.candidate_key returning ordinal",
              [
                request.eventKey,
                intended.revisionAfter.toString(),
                intended.projectedPhase,
                intended.inputCandidateKeys as string[],
              ] as never[],
            );
            if (insertedInputs.length !== intended.inputCandidateKeys.length)
              fail('conflict', 'input-insert');
            if (insertedInputs.length !== inputEntries.length) fail('conflict', 'input-count');
          }

          // Conditional head move, in the same transaction. The CAS predicate is the exact
          // namespace and the exact revision this write was derived against.
          //
          // MEASURED, not assumed: at SERIALIZABLE this predicate is belt-and-braces. A
          // hosted control that removed `revision=$11` left every vector green, because a
          // loser whose snapshot predates the winner's commit is aborted with 40001 on
          // this very UPDATE before the predicate can matter, and a loser whose snapshot
          // follows the commit is already refused by the pre-mutation stale-revision
          // check. The predicate is kept because it is the protection at any weaker
          // isolation level, and `unique (generation_key, revision_after)` on the event
          // is a further backstop; none of the three is presented as proven by the other.
          if (request.kind === 'evaluate') {
            const moved = await tx.unsafe(
              'update engine.paper_gate_head set latest_event_key=$1,revision=$2::bigint,event_kind=$3,projected_phase=$4 where generation_key=$5 and funding_id=$6 and epoch=$7 and budget_id=$8 and generation_config_intent_id=$9 and sample_policy=$10 and revision=$11::bigint returning generation_key',
              [
                request.eventKey,
                intended.revisionAfter.toString(),
                intended.eventKind,
                intended.projectedPhase,
                ...namespace,
                (intended.revisionBefore as bigint).toString(),
              ] as never[],
            );
            if (moved.length !== 1) fail('conflict', 'head-cas');
          } else {
            const created = await tx.unsafe(
              'insert into engine.paper_gate_head(generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,latest_event_key,revision,event_kind,projected_phase) values($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9,$10) returning generation_key',
              [
                ...namespace,
                request.eventKey,
                intended.revisionAfter.toString(),
                intended.eventKind,
                intended.projectedPhase,
              ] as never[],
            );
            if (created.length !== 1) fail('conflict', 'head-insert');
          }

          // 8. Bound-row revalidation then the final lease fence. `for share` on the exact
          // control rows the decision bound raises 40001 if either was updated since this
          // snapshot. It does NOT see a newer intent inserted meanwhile; see the header.
          const boundIds = [...new Set([decision.configIntentId, decision.latestIntentId])];
          const bound = await tx.unsafe(
            'select id from engine.control_intent where id=any($1) for share',
            [boundIds] as never[],
          );
          if (bound.length !== boundIds.length) fail('authority', 'bound-rows-vanished');

          if (testEffects?.beforeFinalFence !== undefined) {
            const self = await one(tx, 'select pg_backend_pid()::text as pid', []);
            await testEffects.beforeFinalFence({ backendPid: Number(self?.pid) });
          }
          const locked = await tx.unsafe(
            'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp() for update',
            [fence.capability, fence.owner, fence.fencingToken.toString()],
          );
          // The locking read's qualification, expiry included, was evaluated BEFORE it
          // waited for the lock, so liveness is re-read against a FRESH clock now that the
          // row cannot change.
          const live =
            locked.length === 1
              ? await tx.unsafe(
                  'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp()',
                  [fence.capability, fence.owner, fence.fencingToken.toString()],
                )
              : [];
          if (locked.length !== 1 || live.length !== 1) fail('lease-lost', 'final-boundary');

          return {
            kind: 'written' as const,
            receipt: {
              admission: 'none',
              authority: 'validated-in-this-transaction',
              boundConfigureIntentId: decision.configIntentId,
              boundLatestIntentId: decision.latestIntentId,
              derived: {
                capturedCandidateCount: intended.capturedCandidateCount,
                capturedResolvedCount: intended.capturedResolvedCount,
                capturedUnresolvedCount: intended.capturedUnresolvedCount,
                firstClosesAtMicroseconds: intended.universeFirstClosesAtMicroseconds,
                lastClosesAtMicroseconds: intended.universeLastClosesAtMicroseconds,
              },
              eventKey: request.eventKey,
              eventKind: intended.eventKind,
              generationCreated,
              headMoved: true,
              inputCandidateKeys: intended.inputCandidateKeys,
              lifetime: 'committed-write-record-not-standing-authority',
              previousPhase: intended.previousPhase,
              projectedPhase: intended.projectedPhase,
              protocol: 'paper-gate-persisted-write-result-v1',
              revisionAfter: intended.revisionAfter,
              revisionBefore: intended.revisionBefore,
              scope,
              validity: 'single-transaction-snapshot-only',
            },
          };
        });
      } catch (error) {
        // Mapped OUTSIDE the transaction, which has already rolled back.
        if (error instanceof PaperGateWriteControl)
          return { detail: error.detail, kind: 'refused', reason: error.refusal };
        const code = (error as { code?: string }).code;
        if (code === SERIALIZATION_FAILURE)
          return { detail: 'serialization-failure', kind: 'refused', reason: 'conflict' };
        if (code === DEADLOCK_DETECTED)
          return { detail: 'deadlock', kind: 'refused', reason: 'conflict' };
        if (code === UNIQUE_VIOLATION)
          return { detail: 'unique-violation', kind: 'refused', reason: 'conflict' };
        // Anything else is a real failure and is never turned into a success.
        throw error;
      } finally {
        // Released on the SAME session, after success and after failure alike, before the
        // connection can return to the pool.
        if (locked !== undefined) {
          let cleanup: 'released' | 'released-all' | 'cleanup-failed' = 'released';
          if (lockHeld) {
            try {
              const rows = await locked.unsafe(PAPER_GATE_WRITE_LOCK_RELEASE_SQL, [
                lockText,
              ] as never[]);
              if ((rows[0] as { released?: unknown } | undefined)?.released !== true) {
                // Should not happen on the acquiring session; clear everything this
                // session holds before the connection goes away.
                await locked.unsafe(PAPER_GATE_WRITE_LOCK_RELEASE_ALL_SQL, [] as never[]);
                cleanup = 'released-all';
              }
            } catch {
              cleanup = 'cleanup-failed';
            }
          }
          testEffects?.onWriteLockCleanup?.(cleanup);
          // Closed unconditionally. On a DIRECT endpoint the session ends here, which
          // releases any session advisory lock the ladder above could not. Through a
          // session-multiplexing proxy neither claim holds: the release may not reach the
          // acquiring backend and ending the logical connection need not terminate a
          // pooled server backend — which is why `required` mode refuses a known pooler
          // outright and why an unclassified endpoint still needs an explicit wiring
          // decision that it is direct.
          await locked.end({ timeout: 5 });
        }
      }
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

/** The only factory this module exports. `admission` is an opaque value, never a boolean
 * and never a loader: this artifact's own gate decides whether it is the audited-policy
 * token, and the production gate has no token, so the answer there is always `false`.
 * Availability therefore falls back to `COMPILED_PAPER_BUNDLE_AVAILABLE`, and an
 * otherwise valid record refuses `authority`/`bundle-unavailable`. */
export function createPostgresPaperGateWriter(
  connectionString: string,
  testEffects?: PaperGateWriterTestEffects,
  admission?: unknown,
  options?: PaperGateWriterOptions,
): PaperGateWriter {
  const audited = grantsAuditedPolicy(admission) ? true : COMPILED_PAPER_BUNDLE_AVAILABLE;
  return createPaperGateWriterCore(
    connectionString,
    audited,
    testEffects,
    options?.capabilityWriteLock ?? 'off',
  );
}
