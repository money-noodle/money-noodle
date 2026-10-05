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
// Four outcomes, and the reason never carries a connection detail:
//
//   * `ready`           — reachable, and SELECT-only.
//   * `unreachable`     — the probe did not complete. Why stays in the adapter.
//   * `over-privileged` — reachable, but the connected identity can do more than read.
//   * `unexpected-shape` — reachable, and it answered with something unreadable.
//
// The last one is separated from `unreachable` because the two need different
// people: a cold or unreachable database resolves itself or is an outage, while a
// row this API cannot parse is a change upstream and will not resolve on its own.
// Both still fail closed, and the distinction is carried as a state rather than as
// a message, so the adapter decides what a public probe is allowed to say (#210).
//
// `not-configured` is a revision running with no projection at all. That was a
// legitimate state while nothing depended on it; since #210 a read endpoint does,
// and the composition says so by refusing to call it ready — see
// `createCheckProjectionReadiness`.

import { projectionFailureCode, type PaperProjectionPort } from '../domain/paper-projection.js';
import {
  evaluateProjectionPrivileges,
  type PrivilegeViolation,
} from '../domain/projection-privileges.js';

export type ProjectionReadinessState =
  'not-configured' | 'over-privileged' | 'ready' | 'unexpected-shape' | 'unreachable';

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
   * `true` was for the interval between #209 landing and the maintainer entering
   * the secret value: the API had no read endpoint then, so a revision with no
   * projection still served its whole declared contract. #210 added three, so the
   * composition now passes `false` and a missing projection is an unready
   * revision. The flag stays rather than being inlined because it is the one knob
   * that decides whether a half-configured revision serves, and a test that wants
   * to prove either behaviour should not have to reach for a different module.
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
    } catch (error) {
      // The message is deliberately never read. The adapter has already reduced
      // whatever the driver said to a safe error, and re-reading it here would risk
      // carrying a host or a connection string into a readiness response. Only the
      // code is consulted, and only to tell "did not answer" from "answered with
      // something unreadable".
      return verdict(
        projectionFailureCode(error) === 'projection-unexpected-shape'
          ? 'unexpected-shape'
          : 'unreachable',
        false,
      );
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
