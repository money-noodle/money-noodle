// Readiness for the signed-in surface.
//
// The same fail-closed shape ADR-0012 established for the projection, applied to
// the second thing a revision now cannot serve without. Once this contract
// publishes sign-in and the budget controls, a revision whose identity
// configuration is missing cannot answer them — and Cloud Run's startup probe on
// `/health/ready` is what keeps such a revision from receiving traffic at all,
// so the previous one keeps serving instead.
//
// What is checked is deliberately *configuration*, not reachability. A liveness
// or reachability probe against the identity provider would make every cold start
// depend on a third party being up, and would turn a provider blip into a
// rollout failure; the thing worth failing closed on is a revision that was
// deployed without the values it needs, which is a local fact and is knowable
// without a network call.
//
// Liveness is untouched, exactly as for the projection: an identity provider
// outage is not a reason for the platform to restart a process that is working.

export type IdentityReadinessState = 'not-configured' | 'ready';

export interface IdentityReadiness {
  readonly ready: boolean;
  readonly state: IdentityReadinessState;
}

export interface CheckIdentityReadinessDependencies {
  /**
   * Whether this revision has everything the signed-in surface needs: the
   * provider configuration, the account id, the session store and the control
   * recorder. The composition decides what "everything" is; this use case decides
   * what an incomplete answer means.
   */
  readonly configured: () => boolean;
  /**
   * Whether an unconfigured identity may still report ready.
   *
   * `true` is the interval before the maintainer has entered the Secret Manager
   * values: the public dashboard is the whole of the served contract then, and a
   * signed-in route that answers "not configured" is honest rather than broken.
   * The composition passes `false` once the signed-in surface is part of what a
   * revision promises. Keeping it a flag rather than inlining it is what let the
   * projection land in two steps (#209 then #210), and identity lands the same way.
   */
  readonly readyWithoutIdentity: boolean;
}

export type CheckIdentityReadiness = () => IdentityReadiness;

export function createCheckIdentityReadiness(
  dependencies: CheckIdentityReadinessDependencies,
): CheckIdentityReadiness {
  return () =>
    dependencies.configured()
      ? Object.freeze({ ready: true, state: 'ready' as const })
      : Object.freeze({
          ready: dependencies.readyWithoutIdentity,
          state: 'not-configured' as const,
        });
}
