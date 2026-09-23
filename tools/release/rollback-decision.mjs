// The rollback decision, as a rule rather than an operation.
//
// Given the revision that was serving before a deploy and the health results
// observed after it, this says what should happen next: nothing, roll back to
// that exact revision, or stop and tell a human. It decides only. Nothing here
// reads a credential, calls a provider, or changes anything that is running,
// and no caller is wired to it yet (#155).
//
// Three properties matter more than convenience:
//
//   * At most one rollback per deploy, structurally. `rollback` is returned
//     only while the deploy's own health check is the sole result. Acting on it
//     means recording the re-check, which moves the input past that point, so
//     there is no input at all for which this returns `rollback` twice.
//   * The target is the noted revision, returned verbatim. It is never derived,
//     normalised or guessed. If nothing usable was noted, the answer is `halt`,
//     never a best effort.
//   * Every doubt resolves to `halt`. This is total: it never throws and never
//     falls through to `none`. A decision helper that crashes on confusing
//     input is a worse failure mode than one that stops and names its reason,
//     and "looks like no action was needed" is the one answer a confused
//     rollback helper must never give.

/** The three things this can decide. */
export const NONE = 'none';
export const ROLLBACK = 'rollback';
export const HALT = 'halt';

/** Why a decision stopped. Stable codes, so callers and tests match on them. */
export const HALT_REASONS = Object.freeze({
  NO_PREVIOUS_REVISION: 'no-previous-revision',
  RECHECK_WITHOUT_ROLLBACK: 'recheck-without-rollback',
  ROLLBACK_DID_NOT_RECOVER: 'rollback-did-not-recover',
  TOO_MANY_HEALTH_CHECKS: 'too-many-health-checks',
  UNEXPECTED_RECHECK: 'unexpected-recheck',
  UNREADABLE_HEALTH_RESULTS: 'unreadable-health-results',
});

/**
 * One check after the deploy, and at most one more after a rollback.
 *
 * This is also the bound on rollbacks: a third result could only exist if
 * something rolled back twice, which these rules never authorise.
 */
export const MAX_HEALTH_CHECKS = 2;

const none = () => Object.freeze({ action: NONE });
const rollback = (revision) => Object.freeze({ action: ROLLBACK, revision });
const halt = (reason) => Object.freeze({ action: HALT, reason });

/** The noted revision, or `null` when nothing usable was noted. */
function notedRevision(value) {
  if (typeof value !== 'string') return null;
  if (value.trim().length === 0) return null;
  return value;
}

/** The health results as booleans, or `null` when they cannot be read as stated. */
function readHealthChecks(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const results = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return null;
    // Strictly boolean. A truthy string or a missing field is an unread check,
    // not a passing one, and guessing which is the whole bug worth avoiding.
    if (typeof entry.healthy !== 'boolean') return null;
    results.push(entry.healthy);
  }
  return results;
}

/**
 * Decides what a deploy should do next.
 *
 * `previousRevision` is the revision noted as serving before the deploy, or
 * `null` when none was noted. `healthChecks` is the ordered list of results —
 * `[{ healthy }]` after the deploy, and `[{ healthy }, { healthy }]` once a
 * rollback has happened and health was checked again.
 *
 * Returns a frozen `{ action: 'none' }`, `{ action: 'rollback', revision }`, or
 * `{ action: 'halt', reason }`.
 */
export function decideRollback(input) {
  const { healthChecks, previousRevision } = input ?? {};
  const revision = notedRevision(previousRevision);
  const results = readHealthChecks(healthChecks);

  if (results === null) return halt(HALT_REASONS.UNREADABLE_HEALTH_RESULTS);
  if (results.length > MAX_HEALTH_CHECKS) return halt(HALT_REASONS.TOO_MANY_HEALTH_CHECKS);

  const [afterDeploy, afterRollback] = results;
  const rolledBack = results.length === MAX_HEALTH_CHECKS;

  if (afterDeploy) {
    // A re-check exists only because a rollback ran, and a healthy deploy is
    // never rolled back. Something acted outside these rules; say so.
    return rolledBack ? halt(HALT_REASONS.UNEXPECTED_RECHECK) : none();
  }

  if (revision === null) {
    return halt(
      rolledBack ? HALT_REASONS.RECHECK_WITHOUT_ROLLBACK : HALT_REASONS.NO_PREVIOUS_REVISION,
    );
  }

  // Rule 3: the deploy is unhealthy and a revision was noted. Roll back to it,
  // then check health once more. This is the only branch that returns
  // `rollback`, and it is unreachable once a re-check has been recorded.
  if (!rolledBack) return rollback(revision);

  // Rule 4: the re-check decides. Recovered means nothing further to do; still
  // unhealthy means stop, with no second attempt and no guessing.
  return afterRollback ? none() : halt(HALT_REASONS.ROLLBACK_DID_NOT_RECOVER);
}
