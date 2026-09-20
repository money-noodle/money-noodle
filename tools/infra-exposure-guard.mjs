#!/usr/bin/env node

// The saved-plan exposure guard.
//
// `docs/operations/delivery.md` accepts a stricter order for first creation than
// for an ordinary release: create the service with no public IAM, verify it
// independently, and expose it only as a separate reviewed step under its own
// H2 approval. The configuration half of that order is already enforced —
// `allow_unauthenticated` defaults to false everywhere and the workflow supplies
// no value for it — but nothing stopped a *plan* from carrying an exposure along
// with something else, and nothing let the credential-free paths refuse one.
//
// This runs between `tofu plan -out=…` and `tofu apply …` in every path that
// applies a service stack. It reads the `tofu show -json` rendering of that exact
// saved plan and answers one question: does this plan change who may invoke the
// service, and is this a path allowed to do that?
//
// Three properties it is built around.
//
//   * It keys on the single writer. `google_cloud_run_v2_service_iam_member.public`
//     inside the service module is the only resource that can grant `allUsers`
//     (`tools/infra-policy.test.mjs` proves there is exactly one), so the guard
//     matches on type and name inside that module call rather than on an address
//     string with a `count` index baked into it.
//   * An exposure must be alone. A plan that both creates the service and exposes
//     it is the collapse the accepted order exists to prevent; a plan that exposes
//     while also changing a revision hides an access change inside a release.
//   * It prints addresses and actions, never values. A rendered plan carries
//     state, which is sensitive by default even when no secret exists, so nothing
//     here echoes the document it read.
//
// Node built-ins only: the provider jobs install no dependencies and have no
// `setup-node` step. It reaches no network and holds no credential.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The typed phrase that authorises an ordinary apply. Cannot expose. */
export const APPLY_CONFIRMATION = 'APPLY-TO-PRODUCTION';

/**
 * The distinct typed phrase that authorises an access change.
 *
 * Deliberately not a variant of the apply phrase: it names the effect rather
 * than the environment, because the same operation in reverse — removing the
 * reviewed `exposure.tfvars` and applying that — is also an access change.
 */
export const EXPOSURE_CONFIRMATION = 'CHANGE-PUBLIC-ACCESS';

/**
 * How the calling path describes itself.
 *
 * `automatic` is the merge-triggered `deploy` job and `rollback` is traffic
 * reassignment; neither has a typed confirmation at all, so neither may ever
 * change the public binding. `dispatch` is the manually confirmed apply.
 */
export const MODES = Object.freeze(['automatic', 'rollback', 'dispatch']);

/** The service module's resources, matched by type and name rather than address. */
const PUBLIC_BINDING = Object.freeze({
  type: 'google_cloud_run_v2_service_iam_member',
  name: 'public',
});
const SERVICE = Object.freeze({
  type: 'google_cloud_run_v2_service',
  name: 'service',
});

/** Actions that change nothing. A plan full of these is not a change at all. */
const INERT_ACTIONS = new Set(['no-op', 'read']);

export class ExposureGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExposureGuardError';
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new ExposureGuardError(code, message);
};

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * The resource changes a rendered plan declares, normalised.
 *
 * Refuses rather than tolerates a shape it does not recognise: a plan this
 * cannot read is a plan whose exposure content is unknown, and an unknown
 * exposure content must not be applied.
 */
export function collectResourceChanges(plan) {
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    refuse('unreadable-plan', 'The rendered plan is not a JSON object.');
  }
  const declared = plan.resource_changes;
  // A plan with nothing to change omits the key entirely; that is legitimate.
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    refuse('unreadable-plan', 'The rendered plan declares a non-array resource_changes.');
  }

  return declared.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      refuse('unreadable-plan', `Resource change ${index} is not an object.`);
    }
    if (!isNonEmptyString(entry.address)) {
      refuse('unreadable-plan', `Resource change ${index} declares no address.`);
    }
    if (!isNonEmptyString(entry.type) || !isNonEmptyString(entry.name)) {
      refuse('unreadable-plan', `Resource change ${index} declares no type or name.`);
    }
    const actions = entry.change?.actions;
    if (!Array.isArray(actions) || actions.length === 0 || !actions.every(isNonEmptyString)) {
      refuse('unreadable-plan', `Resource change ${index} declares no actions.`);
    }
    return Object.freeze({
      actions: Object.freeze([...actions]),
      address: entry.address,
      moduleAddress: typeof entry.module_address === 'string' ? entry.module_address : '',
      name: entry.name,
      type: entry.type,
    });
  });
}

const changed = (entry) => !entry.actions.every((action) => INERT_ACTIONS.has(action));

/** Whether a change belongs to the service module's copy of `resource`. */
const isServiceModuleResource = (entry, resource) =>
  entry.type === resource.type &&
  entry.name === resource.name &&
  /(^|\.)module\.service$/u.test(entry.moduleAddress);

/** Splits the changed resources into the public binding and everything else. */
export function classify(changes) {
  const effective = changes.filter(changed);
  return {
    exposure: effective.filter((entry) => isServiceModuleResource(entry, PUBLIC_BINDING)),
    other: effective.filter((entry) => !isServiceModuleResource(entry, PUBLIC_BINDING)),
    serviceCreated: effective.some(
      (entry) => isServiceModuleResource(entry, SERVICE) && entry.actions.includes('create'),
    ),
  };
}

/** `address action[,action]`, which is everything a refusal may disclose. */
const describe = (entries) =>
  entries.map((entry) => `${entry.address} ${entry.actions.join(',')}`).sort();

/**
 * The decision.
 *
 * Returns `{ outcome, reason, addresses }` when the plan may be applied and
 * throws `ExposureGuardError` when it may not. Separated from the CLI so the
 * rules are testable without a process, a file or an exit code.
 */
export function decide({ changes, confirmation = '', mode }) {
  if (!MODES.includes(mode)) {
    refuse(
      'unknown-mode',
      `The calling path declared no supported mode. Expected one of ${MODES.join(', ')}.`,
    );
  }

  const { exposure, other, serviceCreated } = classify(changes);
  const addresses = describe(exposure);

  if (exposure.length === 0) {
    if (confirmation === EXPOSURE_CONFIRMATION) {
      refuse(
        'exposure-confirmation-without-change',
        'An access change was confirmed, but this plan changes no public invoker binding. Nothing is applied under a confirmation that does not match the plan.',
      );
    }
    return {
      addresses: [],
      outcome: 'no-exposure',
      reason: 'This plan changes no public invoker binding.',
    };
  }

  if (mode !== 'dispatch') {
    refuse(
      'exposure-in-unconfirmed-path',
      `This plan changes the public invoker binding, and the ${mode} path carries no typed confirmation. Exposure is a separately approved operation, never a side effect of a release or a rollback.`,
    );
  }

  if (confirmation !== EXPOSURE_CONFIRMATION) {
    refuse(
      'missing-exposure-confirmation',
      `This plan changes the public invoker binding. That needs the distinct access-change confirmation; the ordinary apply phrase does not authorise it.`,
    );
  }

  if (other.length > 0) {
    refuse(
      'exposure-not-isolated',
      serviceCreated
        ? 'This plan would create the service and expose it in one apply. The accepted order creates it private, verifies it independently, and exposes it separately.'
        : 'This plan changes the public invoker binding alongside other resources. An access change is applied on its own, so what was approved is exactly what runs.',
    );
  }

  return {
    addresses,
    outcome: 'exposure',
    reason: 'This plan changes only the public invoker binding, under its own confirmation.',
  };
}

function argument(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function readPlan(source) {
  if (!isNonEmptyString(source)) {
    refuse('usage', '--plan <file|-> is required.');
  }
  let raw;
  try {
    raw = readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch {
    // The path is named; the document is not echoed.
    refuse('unreadable-plan', 'The rendered plan could not be read.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    refuse('unreadable-plan', 'The rendered plan is not valid JSON.');
  }
}

export function main(argv = process.argv.slice(2)) {
  const plan = readPlan(argument(argv, 'plan'));
  const decision = decide({
    changes: collectResourceChanges(plan),
    confirmation: argument(argv, 'confirmation') ?? '',
    mode: argument(argv, 'mode') ?? '',
  });

  for (const entry of decision.addresses) console.log(`public invoker change: ${entry}`);
  console.log(`Exposure guard: ${decision.outcome}. ${decision.reason}`);
  return decision;
}

// Entry-point detection without `import.meta.filename`, which the runner's
// preinstalled Node may predate.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    if (error instanceof ExposureGuardError) {
      console.error(`Exposure guard refused (${error.code}). ${error.message}`);
      process.exitCode = error.code === 'usage' ? 2 : 1;
    } else {
      // Never re-print the plan, even through an unexpected failure.
      console.error('Exposure guard failed to evaluate the rendered plan.');
      process.exitCode = 2;
    }
  }
}
