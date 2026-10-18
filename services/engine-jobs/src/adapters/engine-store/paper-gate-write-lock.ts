// Per-capability write serialization, as ENGINE-SIDE PREPARATION only.
//
// The unresolved gap this is preparing for: a control recorder that INSERTs a newer
// intent after a gate writer's snapshot and commits before the writer's COMMIT is not
// ordered against that write. An insert-only recorder creates a single read-write
// dependency edge, not a cycle, so PostgreSQL's SSI has nothing to abort — the hosted
// vector measured the writer committing under a superseded intent.
//
// **Raising every control writer to SERIALIZABLE does NOT close it, and that option is
// WITHDRAWN** for exactly that reason: there is no cycle for SSI to break.
//
// What CAN close it is a lock both sides take. This module defines that lock so the two
// participants derive the same key from the same text. The recorder side now takes it
// too: `services/platform-api/.../postgres-engine-store.ts` acquires the same key in its
// single INSERT statement, approved by Rai on 2026-10-18 as CODE AND TESTS ONLY — not
// deployed and not activated.
//
// **Current write admission is still NOT claimed.** It needs a deployment in which the
// engine writer runs with `capabilityWriteLock: 'required'` on a DIRECT endpoint and the
// recorder build carrying that statement is live. Neither has happened; the mode still
// defaults to `off` and nothing is wired.
//
// One further prerequisite was MEASURED rather than assumed and is not resolved here: the
// recorder's statement ends in `returning id`, which PostgreSQL refuses `42501` under
// `engine_control_recorder`, because that role is granted `INSERT` and no `SELECT`. That
// is equally true of the statement before the lock was added, so it is pre-existing and
// the lock is privilege-neutral, but it means the granted role cannot execute the
// recorder's statement at all today.
// `services/engine-jobs/checks/paper-gate-control-recorder-lock-postgres.mjs` vector 1
// asserts that, and resolving it is a grant/migration or API-shape decision for the
// principal.
//
// **Key derivation**, one definition for both participants: the capability is appended to
// a fixed namespace string and hashed with `hashtextextended(text, 0)`, giving the bigint
// an advisory lock key needs. A hash collision can only make two unrelated capabilities
// serialize against each other, which over-serializes and never under-serializes.
//
// **Protocol.** The writer takes a SESSION-level lock on a connection it opens for that
// one call BEFORE `BEGIN`, so its snapshot is taken after the wait rather than before it;
// holds it through COMMIT or ROLLBACK; releases it on that same session in a `finally`;
// and then CLOSES the connection, so even a release that fails cannot leave a lock behind
// — PostgreSQL drops session advisory locks when the session ends. A `max: 1` pool is not
// a substitute: session advisory locks are re-entrant per session, so two overlapping
// calls sharing a backend would each believe they held it. (postgres.js reserved handles
// expose no `begin`, so a per-call connection is also the only way to run the transaction
// on the very session that holds the lock.)
//
// Acquisition is bounded by the connection's EXISTING `lock_timeout`; no new tolerance is
// invented. A timeout arrives as `55P03` before any mutation and is mapped to a refusal.

/** The fixed namespace half of the lock text. Both participants must use it verbatim. */
export const PAPER_GATE_WRITE_LOCK_NAMESPACE = 'money-noodle/paper-gate-capability-write/v1';

/** The exact text that is hashed into the advisory lock key. */
export function paperGateWriteLockText(capability: string): string {
  return `${PAPER_GATE_WRITE_LOCK_NAMESPACE}:${capability}`;
}

/** `hashtextextended(<text>, 0)` over `paperGateWriteLockText(capability)`. Exposed as SQL
 * so a participating recorder can be written against the identical derivation. */
export const PAPER_GATE_WRITE_LOCK_KEY_SQL = 'hashtextextended($1::text, 0)';

/** Blocking session-level acquisition, bounded by the connection's own `lock_timeout`. */
export const PAPER_GATE_WRITE_LOCK_ACQUIRE_SQL = `select pg_advisory_lock(${PAPER_GATE_WRITE_LOCK_KEY_SQL}) is null as acquired`;

/** Release on the SAME session. Returns false when this session did not hold it. */
export const PAPER_GATE_WRITE_LOCK_RELEASE_SQL = `select pg_advisory_unlock(${PAPER_GATE_WRITE_LOCK_KEY_SQL}) as released`;

/** Last-resort cleanup for the same session, so a release that reports false cannot leave
 * a lock behind on a connection that goes back to the pool. */
export const PAPER_GATE_WRITE_LOCK_RELEASE_ALL_SQL =
  'select pg_advisory_unlock_all() is null as cleared';

/** Whether this capability's lock is currently held by SOME session, for the tests and
 * for the leak check after a failure.
 *
 * `pg_locks` splits a bigint advisory key into two `oid` halves: `classid` is the high 32
 * bits and `objid` the low 32. Both halves are recovered with integer arithmetic on the
 * bigint — measured against a real holder, not assumed. */
export const PAPER_GATE_WRITE_LOCK_HELD_SQL = `select count(*)::text as holders from pg_locks where locktype='advisory' and granted and classid::bigint = (((${PAPER_GATE_WRITE_LOCK_KEY_SQL}) >> 32) & 4294967295) and objid::bigint = ((${PAPER_GATE_WRITE_LOCK_KEY_SQL}) & 4294967295)`;

/** How the writer treats the per-capability lock. `off` is the default and preserves the
 * measured non-participating behaviour; `required` takes the lock and is what a
 * participating-recorder deployment would use. It changes serialization only — it can
 * never grant admission. */
export type PaperGateWriteLockMode = 'off' | 'required';
/** How the acquisition statement reports the backend that took the lock, in the SAME
 * statement, so the pid cannot belong to a different session than the one that locked. */
export const PAPER_GATE_WRITE_LOCK_ACQUIRE_WITH_PID_SQL = `select pg_backend_pid()::text as pid from pg_advisory_lock(${PAPER_GATE_WRITE_LOCK_KEY_SQL})`;

/** The FIRST statement inside the transaction: this backend's pid, and whether THIS
 * backend is a granted holder of exactly this key. */
export const PAPER_GATE_WRITE_LOCK_OWNERSHIP_SQL = `select pg_backend_pid()::text as pid, (select count(*) from pg_locks where locktype='advisory' and granted and pid = pg_backend_pid() and classid::bigint = (((${PAPER_GATE_WRITE_LOCK_KEY_SQL}) >> 32) & 4294967295) and objid::bigint = ((${PAPER_GATE_WRITE_LOCK_KEY_SQL}) & 4294967295))::text as held`;

/** What the connection string alone can be said to be.
 *
 * `known-transaction-pooler` is a host this project KNOWS multiplexes sessions, where a
 * session-level lock cannot be relied on at all. `unclassified` means exactly that: it is
 * **not** a claim of directness. The list below is not and cannot be exhaustive, so an
 * `unclassified` endpoint still requires an explicit wiring decision that it is direct
 * before `required` mode may be switched on in a deployment. */
export type PaperGateWriteLockEndpoint = 'known-transaction-pooler' | 'unclassified';

/** Known transaction-pooler host markers. Neon presents its pooled endpoint as a
 * `-pooler` host; PgBouncer and Supabase's pooler are named in their hosts too. */
const POOLED_HOST_MARKERS: readonly string[] = ['-pooler.', 'pgbouncer', 'pooler.supabase'];

export function classifyPaperGateWriteLockEndpoint(
  connectionString: string,
): PaperGateWriteLockEndpoint {
  let host = '';
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    // An unparseable string is not a claim of directness either.
    return 'unclassified';
  }
  return POOLED_HOST_MARKERS.some((marker) => host.includes(marker))
    ? 'known-transaction-pooler'
    : 'unclassified';
}

export interface PaperGateWriteLockOwnership {
  /** From the acquisition statement itself. */
  acquiringBackendPid: number | undefined;
  /** From the first statement after `BEGIN`. */
  transactionBackendPid: number | undefined;
  /** Granted holders of this key on the transaction's own backend; must be exactly one. */
  heldByThisBackend: number | undefined;
}

export type PaperGateWriteLockVerdict =
  | { ok: true }
  | {
      ok: false;
      detail:
        | 'acquiring-pid-unknown'
        | 'transaction-pid-unknown'
        | 'backend-reassigned'
        | 'lock-not-owned';
    };

/** Fail-closed, before any mutation.
 *
 * What this DOES establish: the backend that ran the acquisition statement is the same
 * backend the transaction is running on, and that backend is a granted holder of this
 * exact key at the start of the transaction.
 *
 * What it does NOT establish, and must not be read as: that the endpoint is direct, that
 * ownership persists for the rest of the transaction, or that a proxy cannot reassign the
 * backend later. A single matching pid proves one moment, not a property. Through a
 * session-multiplexing proxy none of the cleanup guarantees hold either: the release may
 * not reach the acquiring backend, and ending the logical connection does not terminate a
 * pooled server backend. Directness therefore stays an explicit wiring prerequisite. */
export function verifyPaperGateWriteLockOwnership(
  ownership: PaperGateWriteLockOwnership,
): PaperGateWriteLockVerdict {
  if (
    !Number.isSafeInteger(ownership.acquiringBackendPid) ||
    (ownership.acquiringBackendPid ?? 0) <= 0
  )
    return { detail: 'acquiring-pid-unknown', ok: false };
  if (
    !Number.isSafeInteger(ownership.transactionBackendPid) ||
    (ownership.transactionBackendPid ?? 0) <= 0
  )
    return { detail: 'transaction-pid-unknown', ok: false };
  if (ownership.acquiringBackendPid !== ownership.transactionBackendPid)
    return { detail: 'backend-reassigned', ok: false };
  if (ownership.heldByThisBackend !== 1) return { detail: 'lock-not-owned', ok: false };
  return { ok: true };
}
