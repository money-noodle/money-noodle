// Readiness, for a service that now depends on a database it does not own.
//
// Cloud Run has no separate readiness probe: the startup probe on `/health/ready`
// is what gates a revision from receiving traffic, so a revision that cannot
// reach the projection, or that reached it as a role with more than SELECT,
// must never report ready. That is the fail-closed half of ADR-0012, and it is
// the reason this is a use case rather than a line in the HTTP adapter: the rule
// is testable without a server and without a database.
//
// Liveness is deliberately untouched. `/health/live` says only that the process
// can answer, and a database outage is not a reason to have the platform restart
// a process that is working perfectly well.
//
// Three outcomes, and the reason never carries a connection detail:
//
//   * `ready`        — reachable, and SELECT-only.
//   * `unreachable`  — the probe failed. Why it failed stays inside the adapter.
//   * `over-privileged` — reachable, but the role can do more than read.
//
// `not-configured` exists for the window this ticket lands in: the secret
// container is declared and empty until the maintainer enters a value, so a
// revision may legitimately run with no projection configured at all. Which way
// that resolves is the caller's choice, stated once at composition time rather
// than guessed here — see `createCheckProjectionReadiness`.

import type { PaperProjectionPort } from '../domain/paper-projection.js';
import {
  evaluateProjectionPrivileges,
  type PrivilegeViolation,
} from '../domain/projection-privileges.js';

export type ProjectionReadinessState =
  'not-configured' | 'over-privileged' | 'ready' | 'unreachable';

export interface ProjectionReadiness {
  readonly ready: boolean;
  readonly state: ProjectionReadinessState;
  /** Safe to log and to summarise. Never a host, role, or driver message. */
  readonly violations: readonly PrivilegeViolation[];
}

export interface CheckProjectionReadinessDependencies {
  /**
   * The tables the privilege rule insists on. Passed in rather than imported so
   * a deployment that renames a table cannot pass readiness against the default
   * names while reading different ones.
   */
  readonly expectedTables: readonly string[];
  /**
   * The port, or `null` when no projection is configured for this revision.
   */
  readonly projection: PaperProjectionPort | null;
  /**
   * Whether an unconfigured projection is allowed to report ready.
   *
   * `true` is for the interval between this change landing and the maintainer
   * entering the secret value: the API has no read endpoints yet (#210), so a
   * revision with no projection still serves its whole declared contract. Once a
   * read endpoint exists this becomes `false` and a missing projection is an
   * unready revision, which is the honest answer from that point on.
   */
  readonly readyWithoutProjection: boolean;
}

export type CheckProjectionReadiness = () => Promise<ProjectionReadiness>;

const NO_VIOLATIONS = Object.freeze([]) as readonly PrivilegeViolation[];

const verdict = (
  state: ProjectionReadinessState,
  ready: boolean,
  violations: readonly PrivilegeViolation[] = NO_VIOLATIONS,
): ProjectionReadiness => Object.freeze({ ready, state, violations });

export function createCheckProjectionReadiness(
  dependencies: CheckProjectionReadinessDependencies,
): CheckProjectionReadiness {
  return async () => {
    const { projection } = dependencies;
    if (projection === null) {
      return verdict('not-configured', dependencies.readyWithoutProjection);
    }

    let observation;
    try {
      observation = await projection.probePrivileges();
    } catch {
      // Deliberately swallowed. The adapter has already reduced whatever the
      // driver said to a safe error; re-reading it here only risks carrying a
      // host or a connection string into a readiness response.
      return verdict('unreachable', false);
    }

    const privileges = evaluateProjectionPrivileges({
      attributes: observation.attributes,
      expectedTables: dependencies.expectedTables,
      grants: observation.grants,
    });

    return privileges.selectOnly
      ? verdict('ready', true)
      : verdict('over-privileged', false, privileges.violations);
  };
}
