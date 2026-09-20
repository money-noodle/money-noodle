// The exposure guard's rules, and the refusals that matter most.
//
// Every fixture below is synthetic, hand-built to the documented `tofu show
// -json` shape. None came from a real plan, and nothing here reaches a provider,
// a network or a credential.
//
// The cases are written as "what a maintainer could actually do by accident":
// merge an `exposure.tfvars` pull request and let the next automatic deploy pick
// it up; type the ordinary apply phrase for an exposure; confirm an exposure
// against a plan that no longer contains one.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  APPLY_CONFIRMATION,
  EXPOSURE_CONFIRMATION,
  ExposureGuardError,
  MODES,
  collectResourceChanges,
  decide,
} from './infra-exposure-guard.mjs';

const guardPath = join(dirname(fileURLToPath(import.meta.url)), 'infra-exposure-guard.mjs');

// A value that must never be echoed. A rendered plan carries state, which is
// sensitive by default even when no secret exists, so every fixture plants one
// and the CLI case below proves none of them reaches the output.
const PLAN_VALUE_MARKER = 'synthetic-plan-value-marker';

const change = ({ actions, index, module = 'module.service', name, type }) => ({
  address: `${module}.${type}.${name}${index === undefined ? '' : `[${index}]`}`,
  change: {
    actions,
    after: { marker: PLAN_VALUE_MARKER },
    before: actions.includes('create') ? null : { marker: PLAN_VALUE_MARKER },
  },
  mode: 'managed',
  module_address: module,
  name,
  provider_name: 'registry.opentofu.org/hashicorp/google',
  type,
  ...(index === undefined ? {} : { index }),
});

const publicBinding = (actions) =>
  change({ actions, index: 0, name: 'public', type: 'google_cloud_run_v2_service_iam_member' });
const service = (actions) =>
  change({ actions, name: 'service', type: 'google_cloud_run_v2_service' });
const namedInvoker = (actions) =>
  change({
    actions,
    index: 'serviceAccount:example-runtime@example-project.iam.gserviceaccount.com',
    name: 'authorised_invokers',
    type: 'google_cloud_run_v2_service_iam_member',
  });

const plan = (...resourceChanges) => ({
  format_version: '1.2',
  resource_changes: resourceChanges,
  terraform_version: '1.12.6',
});

/** Runs the guard's rules over a synthetic plan, returning its refusal code. */
function refusal(run) {
  try {
    run();
    return null;
  } catch (error) {
    assert.ok(error instanceof ExposureGuardError, `expected a refusal, got ${error}`);
    return error.code;
  }
}

const evaluate = ({ confirmation, mode, rendering }) =>
  decide({ changes: collectResourceChanges(rendering), confirmation, mode });

test('an apply that creates the service and exposes it is refused', () => {
  // The collapse the accepted order exists to prevent: a service that is public
  // the moment it exists cannot be verified before it is reachable.
  assert.equal(
    refusal(() =>
      evaluate({
        confirmation: EXPOSURE_CONFIRMATION,
        mode: 'dispatch',
        rendering: plan(service(['create']), publicBinding(['create'])),
      }),
    ),
    'exposure-not-isolated',
  );
});

test('an apply that exposes while changing the revision is refused', () => {
  // An access change hidden inside a release is an access change nobody
  // reviewed as one.
  assert.equal(
    refusal(() =>
      evaluate({
        confirmation: EXPOSURE_CONFIRMATION,
        mode: 'dispatch',
        rendering: plan(service(['update']), publicBinding(['create'])),
      }),
    ),
    'exposure-not-isolated',
  );

  // Any other resource, not only the service itself.
  assert.equal(
    refusal(() =>
      evaluate({
        confirmation: EXPOSURE_CONFIRMATION,
        mode: 'dispatch',
        rendering: plan(namedInvoker(['create']), publicBinding(['create'])),
      }),
    ),
    'exposure-not-isolated',
  );
});

test('an isolated exposure under its own confirmation is allowed', () => {
  const decision = evaluate({
    confirmation: EXPOSURE_CONFIRMATION,
    mode: 'dispatch',
    rendering: plan(service(['no-op']), publicBinding(['create'])),
  });
  assert.equal(decision.outcome, 'exposure');
  assert.deepEqual(decision.addresses, [
    'module.service.google_cloud_run_v2_service_iam_member.public[0] create',
  ]);
});

test('removing the reviewed exposure is the same operation in reverse', () => {
  // Deleting `exposure.tfvars` and applying that plan is an access change too,
  // and it is confirmed the same way rather than slipping through as a cleanup.
  const decision = evaluate({
    confirmation: EXPOSURE_CONFIRMATION,
    mode: 'dispatch',
    rendering: plan(publicBinding(['delete'])),
  });
  assert.equal(decision.outcome, 'exposure');

  assert.equal(
    refusal(() =>
      evaluate({
        confirmation: APPLY_CONFIRMATION,
        mode: 'dispatch',
        rendering: plan(publicBinding(['delete'])),
      }),
    ),
    'missing-exposure-confirmation',
  );
});

test('the ordinary apply phrase cannot expose', () => {
  assert.equal(
    refusal(() =>
      evaluate({
        confirmation: APPLY_CONFIRMATION,
        mode: 'dispatch',
        rendering: plan(publicBinding(['create'])),
      }),
    ),
    'missing-exposure-confirmation',
  );

  // Nor can an empty confirmation, nor a near miss.
  for (const confirmation of ['', 'change-public-access', `${EXPOSURE_CONFIRMATION} `]) {
    assert.equal(
      refusal(() =>
        evaluate({ confirmation, mode: 'dispatch', rendering: plan(publicBinding(['create'])) }),
      ),
      'missing-exposure-confirmation',
    );
  }
});

test('the automatic deploy refuses a pending exposure rather than performing it', () => {
  // The merge-triggered path has no typed confirmation at all. If an
  // `exposure.tfvars` pull request merges before the guarded apply has run, the
  // next automatic deploy of that stack stops here, red, with nothing applied.
  assert.equal(
    refusal(() => evaluate({ mode: 'automatic', rendering: plan(publicBinding(['create'])) })),
    'exposure-in-unconfirmed-path',
  );

  // Even alongside the release it was planning to perform.
  assert.equal(
    refusal(() =>
      evaluate({
        mode: 'automatic',
        rendering: plan(service(['update']), publicBinding(['create'])),
      }),
    ),
    'exposure-in-unconfirmed-path',
  );
});

test('a rollback cannot change who may invoke', () => {
  // Rollback reassigns traffic. Reaching the public binding from it would make
  // an access change a side effect of a recovery.
  assert.equal(
    refusal(() => evaluate({ mode: 'rollback', rendering: plan(publicBinding(['delete'])) })),
    'exposure-in-unconfirmed-path',
  );
});

test('an exposure confirmation that matches no exposure is refused', () => {
  // The apply the maintainer confirmed is not the apply that would run — most
  // likely because the exposure already applied, or the file never merged.
  assert.equal(
    refusal(() =>
      evaluate({
        confirmation: EXPOSURE_CONFIRMATION,
        mode: 'dispatch',
        rendering: plan(service(['update'])),
      }),
    ),
    'exposure-confirmation-without-change',
  );

  assert.equal(
    refusal(() =>
      evaluate({ confirmation: EXPOSURE_CONFIRMATION, mode: 'dispatch', rendering: plan() }),
    ),
    'exposure-confirmation-without-change',
  );
});

test('an already-exposed service still deploys automatically', () => {
  // Once the exposure has applied, the binding plans as a no-op and ordinary
  // releases continue. A guard that blocked this would make exposure a one-way
  // door out of automatic delivery.
  const decision = evaluate({
    mode: 'automatic',
    rendering: plan(publicBinding(['no-op']), service(['update'])),
  });
  assert.equal(decision.outcome, 'no-exposure');
  assert.deepEqual(decision.addresses, []);

  // `read` is not a change either.
  assert.equal(
    evaluate({ mode: 'automatic', rendering: plan(publicBinding(['read'])) }).outcome,
    'no-exposure',
  );
});

test('a plan with no exposure passes in every path', () => {
  for (const mode of MODES) {
    assert.equal(
      evaluate({ mode, rendering: plan(service(['update']), namedInvoker(['create'])) }).outcome,
      'no-exposure',
    );
  }

  // The platform stack has no service module at all, and the apply job also
  // applies it.
  assert.equal(
    evaluate({
      mode: 'dispatch',
      rendering: plan(
        change({
          actions: ['update'],
          module: '',
          name: 'platform',
          type: 'google_project_service',
        }),
      ),
    }).outcome,
    'no-exposure',
  );

  // A plan that changes nothing at all is legitimate; `resource_changes` may be
  // absent entirely.
  assert.equal(
    evaluate({ mode: 'automatic', rendering: { format_version: '1.2' } }).outcome,
    'no-exposure',
  );
});

test('a binding of the same type outside the service module is not this binding', () => {
  // Matching on type and name alone would let a future module's identically
  // named resource silently satisfy or trip the guard.
  const elsewhere = change({
    actions: ['create'],
    index: 0,
    module: 'module.something_else',
    name: 'public',
    type: 'google_cloud_run_v2_service_iam_member',
  });
  assert.equal(evaluate({ mode: 'automatic', rendering: plan(elsewhere) }).outcome, 'no-exposure');

  // A nested module call still counts, because that is still the service module.
  const nested = change({
    actions: ['create'],
    index: 0,
    module: 'module.wrapper.module.service',
    name: 'public',
    type: 'google_cloud_run_v2_service_iam_member',
  });
  assert.equal(
    refusal(() => evaluate({ mode: 'automatic', rendering: plan(nested) })),
    'exposure-in-unconfirmed-path',
  );
});

test('a plan the guard cannot read is refused rather than assumed harmless', () => {
  const cases = [
    ['unreadable-plan', 'not an object', []],
    ['unreadable-plan', 'a string', 'resource_changes'],
    ['unreadable-plan', 'a non-array changes key', { resource_changes: {} }],
    ['unreadable-plan', 'an entry that is not an object', { resource_changes: [null] }],
    [
      'unreadable-plan',
      'an entry with no address',
      { resource_changes: [{ type: 'a', name: 'b' }] },
    ],
    [
      'unreadable-plan',
      'an entry with no type',
      { resource_changes: [{ address: 'a', change: { actions: ['create'] }, name: 'b' }] },
    ],
    [
      'unreadable-plan',
      'an entry with no actions',
      { resource_changes: [{ address: 'a', change: {}, name: 'b', type: 'c' }] },
    ],
    [
      'unreadable-plan',
      'an entry with an empty action list',
      { resource_changes: [{ address: 'a', change: { actions: [] }, name: 'b', type: 'c' }] },
    ],
  ];

  for (const [code, label, rendering] of cases) {
    assert.equal(
      refusal(() => collectResourceChanges(rendering)),
      code,
      `expected ${label} to be refused`,
    );
  }
});

test('a path that declares no supported mode is refused', () => {
  // Fail closed: a caller that forgot `--mode` is a caller whose intent is
  // unknown, and an unknown intent must not apply an exposure.
  for (const mode of ['', undefined, 'deploy', 'DISPATCH']) {
    assert.equal(
      refusal(() => decide({ changes: [], confirmation: '', mode })),
      'unknown-mode',
    );
  }
});

test('the confirmation phrases are distinct and neither contains the other', () => {
  assert.notEqual(APPLY_CONFIRMATION, EXPOSURE_CONFIRMATION);
  assert.ok(!APPLY_CONFIRMATION.includes(EXPOSURE_CONFIRMATION));
  assert.ok(!EXPOSURE_CONFIRMATION.includes(APPLY_CONFIRMATION));
});

test('the command exits nonzero on a refusal and prints no plan value', () => {
  const run = (rendering, args) =>
    spawnSync(process.execPath, [guardPath, '--plan', '-', ...args], {
      encoding: 'utf8',
      input: typeof rendering === 'string' ? rendering : JSON.stringify(rendering),
    });

  const refused = run(plan(service(['create']), publicBinding(['create'])), [
    '--mode',
    'dispatch',
    '--confirmation',
    EXPOSURE_CONFIRMATION,
  ]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /exposure-not-isolated/);

  const allowed = run(plan(publicBinding(['create'])), [
    '--mode',
    'dispatch',
    '--confirmation',
    EXPOSURE_CONFIRMATION,
  ]);
  assert.equal(allowed.status, 0);
  assert.match(
    allowed.stdout,
    /module\.service\.google_cloud_run_v2_service_iam_member\.public\[0\] create/,
  );

  const automatic = run(plan(publicBinding(['create'])), ['--mode', 'automatic']);
  assert.equal(automatic.status, 1);

  // Malformed JSON is a refusal, not a pass.
  const malformed = run('{ "resource_changes": [', ['--mode', 'automatic']);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /unreadable-plan/);

  // A missing `--plan` is a usage error, still nonzero.
  const usage = spawnSync(process.execPath, [guardPath, '--mode', 'automatic'], {
    encoding: 'utf8',
  });
  assert.equal(usage.status, 2);

  // Nothing the guard printed carries a value from the document it read.
  for (const result of [refused, allowed, automatic, malformed, usage]) {
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes(PLAN_VALUE_MARKER),
      'the guard must print addresses and actions only, never plan values',
    );
  }
});
