// Per-capability write serialization, as ENGINE-SIDE PREPARATION only.
//
// The unresolved gap this is preparing for: a control recorder that INSERTs a newer
// intent after a gate writer's snapshot and commits before the writer's COMMIT is not
// ordered against that write. An insert-only recorder creates a single read-write
// dependency edge, not a cycle, so PostgreSQL's SSI has nothing to abort — the hosted
// vector measured the writer committing under a superseded intent. Raising every control
// writer to SERIALIZABLE does NOT close it for that reason, and that claim has been
// withdrawn.
//
// What CAN close it is a lock both sides take. This module defines that lock so the two
// participants derive the same key from the same text, and the writer can take it today;
// the recorder side needs a change to `services/platform-api`, which this batch is NOT
// authorized to make. Until real recorders participate, nothing here may be read as
// current write admission.
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
