// The ordered forward release vector.
//
// Given the deployment manifests each project declares and the projects a
// commit actually affected, this produces the exact ordered vector the delivery
// workflow deploys — or refuses, when the inputs admit more than one answer.
//
// Three properties matter more than convenience:
//
//   * The bound comes from the catalog row, not from a number restated here.
//     `service.deploy` is "one forward vector, at most 2 services"; a longer
//     vector is refused rather than truncated.
//   * The vector is forward only. `service.rollback` requires a verified
//     predecessor, which cannot exist before a first deployment, so nothing in
//     this module may ever name the rollback slot.
//   * Unaffected services are reported as unaffected, not omitted silently.
//     "Unaffected services remain unchanged and independently healthy" is an
//     acceptance criterion, so the plan states which services it leaves alone.

import { CATALOG_ID, CATALOG_VERSION, OPERATIONS, PERMITTED_REF } from '../delivery/catalog-v2.mjs';
import { ReleasePlanError } from './deployment-manifests.mjs';

export const DEPLOY_OPERATION = 'service.deploy';
export const ROLLBACK_OPERATION = 'service.rollback';

const refuse = (code, message) => {
  throw new ReleasePlanError(code, message);
};

const deployRow = () => {
  const row = OPERATIONS[DEPLOY_OPERATION];
  if (row === undefined) refuse('unknown-operation', `The catalog has no ${DEPLOY_OPERATION} row.`);
  if (row.mutating !== true) refuse('unknown-operation', `${DEPLOY_OPERATION} is not a mutation.`);
  return row;
};

/** The slots a forward release may never spend, however it was reached. */
export function forbiddenPermissionSlots() {
  const rollback = OPERATIONS[ROLLBACK_OPERATION];
  return Object.freeze(rollback === undefined ? [] : [...rollback.permissionSlots]);
}

/**
 * Computes the ordered forward vector for one commit.
 *
 * `affectedProjects` is the affected set the workspace's own project graph
 * produced. It is validated against the declared projects rather than trusted:
 * a name nothing declares means the caller and this repository disagree about
 * what exists, which is not a state to deploy from.
 */
export function planReleaseVector({ affectedProjects, manifests, projects }) {
  const row = deployRow();

  if (!(manifests instanceof Map) || manifests.size === 0) {
    refuse('no-deployable-units', 'No declared deployment manifests were supplied.');
  }
  if (!(projects instanceof Set) || projects.size === 0) {
    refuse('invalid-affected-input', 'The declared project set is missing.');
  }
  if (!Array.isArray(affectedProjects)) {
    refuse('invalid-affected-input', 'The affected project list must be an array.');
  }

  const affected = new Set();
  for (const name of affectedProjects) {
    if (typeof name !== 'string' || name.length === 0) {
      refuse('invalid-affected-input', 'An affected project name must be a non-empty string.');
    }
    if (!projects.has(name)) {
      refuse('unknown-project', `"${name}" is affected but no project.json declares it.`);
    }
    affected.add(name);
  }

  const ordered = [...manifests.values()].sort((left, right) => left.order - right.order);
  const selected = ordered.filter((manifest) => affected.has(manifest.project));

  if (selected.length > row.maxTargets) {
    refuse(
      'target-count-exceeded',
      `${DEPLOY_OPERATION} allows at most ${row.maxTargets} targets; ${selected.length} are affected.`,
    );
  }

  // The manifest validation already proves a dependency declares a lower order,
  // so this cannot fail for a well-formed manifest set. It is asserted anyway:
  // the ordering is the acceptance criterion ("deploys API first, verifies it,
  // then web"), and an ordering guarantee that is never checked is a comment.
  const position = new Map(selected.map((manifest, index) => [manifest.unit, index]));
  for (const manifest of selected) {
    for (const dependency of manifest.dependsOn) {
      if (!position.has(dependency)) continue;
      if (position.get(dependency) >= position.get(manifest.unit)) {
        refuse(
          'dependency-order',
          `"${manifest.unit}" would deploy before "${dependency}", which it depends on.`,
        );
      }
    }
  }

  const vector = selected.map((manifest) =>
    Object.freeze({
      image: manifest.image,
      order: manifest.order,
      port: manifest.port,
      project: manifest.project,
      service: manifest.service,
      stack: manifest.stack,
      unit: manifest.unit,
      verify: [...manifest.verify],
    }),
  );

  const plan = Object.freeze({
    approvalClass: row.approvalClass,
    catalogId: CATALOG_ID,
    catalogVersion: CATALOG_VERSION,
    maxTargets: row.maxTargets,
    operation: DEPLOY_OPERATION,
    permissionSlots: Object.freeze([...row.permissionSlots]),
    // There is no verified predecessor before a first deployment, and this path
    // never invents one. Recovery is a separately approved operation.
    predecessor: null,
    sourceRef: PERMITTED_REF,
    unaffected: Object.freeze(
      ordered.filter((manifest) => !affected.has(manifest.project)).map(({ unit }) => unit),
    ),
    units: Object.freeze(vector.map(({ unit }) => unit)),
    vector: Object.freeze(vector),
  });

  return assertForwardOnly(plan);
}

/**
 * Refuses a plan that would spend a recovery permission.
 *
 * Deliberately a separate, exported check rather than an inline condition, so
 * the policy suite can run it against a hostile plan and prove it denies.
 */
export function assertForwardOnly(plan) {
  const forbidden = forbiddenPermissionSlots();
  if (plan.operation !== DEPLOY_OPERATION) {
    refuse('rollback-refused', `A release plan may only be ${DEPLOY_OPERATION}.`);
  }
  if (plan.predecessor !== null) {
    refuse('rollback-refused', 'A forward release plan carries no predecessor evidence.');
  }
  for (const slot of plan.permissionSlots) {
    if (forbidden.includes(slot)) {
      refuse('rollback-refused', `A forward release plan may not spend the "${slot}" slot.`);
    }
  }
  if (plan.vector.length > plan.maxTargets) {
    refuse('target-count-exceeded', 'A release plan may not exceed its catalog target bound.');
  }
  return plan;
}
