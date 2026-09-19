// The ordered release vector, proved against the manifests this repository
// actually declares and against synthetic ones it does not.
//
// Provider-free by construction: nothing here starts a container, opens a
// socket or reads a credential.

import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATIONS } from '../delivery/catalog-v2.mjs';
import { findForbiddenMarkers } from '../delivery/sanitize.mjs';
import {
  DEPLOYMENT_FIELDS,
  ReleasePlanError,
  discoverProjectManifestPaths,
  loadDeploymentManifests,
  parseDeploymentManifests,
  readProjectManifests,
} from './deployment-manifests.mjs';
import {
  DEPLOY_OPERATION,
  ROLLBACK_OPERATION,
  assertForwardOnly,
  forbiddenPermissionSlots,
  planReleaseVector,
} from './affected-services.mjs';

const declared = loadDeploymentManifests();

const plan = (affectedProjects) =>
  planReleaseVector({
    affectedProjects,
    manifests: declared.manifests,
    projects: declared.projects,
  });

/** The refusal code a call produces, or `null` when it did not refuse. */
function refusal(run) {
  try {
    run();
    return null;
  } catch (error) {
    assert.ok(error instanceof ReleasePlanError, `expected a refusal, got ${error}`);
    return error.code;
  }
}

const deployment = (overrides = {}) => ({
  dependsOn: [],
  image: 'example',
  order: 1,
  port: 8080,
  service: 'example',
  stack: 'api',
  unit: 'example',
  verify: ['/health/ready'],
  ...overrides,
});

const entry = (project, overrides) => ({
  deployment: deployment(overrides),
  path: `${project}/project.json`,
  project,
});

test('the deployable surface comes from declared manifests, not from a table here', () => {
  const paths = discoverProjectManifestPaths();
  assert.ok(paths.length >= 3, 'expected the workspace to declare several projects');
  assert.ok(
    paths.some((path) => path.endsWith('/apps/web/project.json')),
    'discovery must find a nested project manifest',
  );

  const entries = readProjectManifests(paths);
  const deployable = entries.filter((candidate) => candidate.deployment !== undefined);
  assert.deepEqual(
    deployable.map(({ project }) => project).sort(),
    ['platform-api', 'web'],
    'exactly the two services declare a deployment today',
  );

  // The planner reads the declaration. A project that stops declaring one stops
  // being deployable without any edit to this directory.
  for (const candidate of deployable) {
    assert.deepEqual(Object.keys(candidate.deployment).sort(), [...DEPLOYMENT_FIELDS].sort());
  }
});

test('an API-only change plans one service', () => {
  const result = plan(['platform-api']);
  assert.deepEqual(result.units, ['api']);
  assert.deepEqual(result.unaffected, ['web']);
  assert.equal(result.vector[0].stack, 'api');
  assert.equal(result.vector[0].image, 'platform-api');
});

test('a web-only change plans one service', () => {
  const result = plan(['web']);
  assert.deepEqual(result.units, ['web']);
  assert.deepEqual(result.unaffected, ['api']);
  assert.equal(result.vector[0].stack, 'web');
});

test('a coordinated change plans API first, then web', () => {
  // Supplied in the wrong order on purpose: the vector is the declared order,
  // never the order the affected set happened to arrive in.
  const result = plan(['web', 'platform-api']);
  assert.deepEqual(result.units, ['api', 'web']);
  assert.deepEqual(result.unaffected, []);
  assert.ok(result.vector[0].order < result.vector[1].order);
});

test('an unrelated change plans nothing', () => {
  const result = plan([]);
  assert.deepEqual(result.units, []);
  assert.deepEqual(result.vector, []);
  assert.deepEqual(result.unaffected, ['api', 'web']);
});

test('the plan carries the catalog row, not numbers restated here', () => {
  const row = OPERATIONS[DEPLOY_OPERATION];
  const result = plan(['platform-api', 'web']);
  assert.equal(result.operation, DEPLOY_OPERATION);
  assert.equal(result.approvalClass, row.approvalClass);
  assert.equal(result.maxTargets, row.maxTargets);
  assert.deepEqual([...result.permissionSlots], [...row.permissionSlots]);
  assert.equal(result.sourceRef, 'refs/heads/main');
});

test('a forward release never mints a rollback permission', () => {
  const rollback = OPERATIONS[ROLLBACK_OPERATION];
  assert.ok(rollback.requiresVerifiedPredecessor, 'the catalog still guards recovery');
  assert.deepEqual([...forbiddenPermissionSlots()], [...rollback.permissionSlots]);

  for (const affected of [[], ['web'], ['platform-api'], ['platform-api', 'web']]) {
    const result = plan(affected);
    assert.equal(result.predecessor, null);
    for (const slot of rollback.permissionSlots) {
      assert.ok(!result.permissionSlots.includes(slot), `a forward plan spent ${slot}`);
    }
  }

  // The guard denies a plan built to carry recovery authority, whatever
  // produced it.
  const forward = plan(['platform-api']);
  assert.equal(
    refusal(() => assertForwardOnly({ ...forward, operation: ROLLBACK_OPERATION })),
    'rollback-refused',
  );
  assert.equal(
    refusal(() =>
      assertForwardOnly({ ...forward, permissionSlots: [...rollback.permissionSlots] }),
    ),
    'rollback-refused',
  );
  assert.equal(
    refusal(() => assertForwardOnly({ ...forward, predecessor: { revision: 'previous' } })),
    'rollback-refused',
  );
});

test('the plan is publishable evidence', () => {
  // A job summary is public and never masked. Nothing in a plan may carry a
  // shape that must not be published.
  assert.deepEqual(findForbiddenMarkers(plan(['platform-api', 'web'])), []);
});

test('an affected project nothing declares is refused rather than ignored', () => {
  assert.equal(
    refusal(() => plan(['ghost'])),
    'unknown-project',
  );
  assert.equal(
    refusal(() => plan([''])),
    'invalid-affected-input',
  );
  assert.equal(
    refusal(() => plan('platform-api')),
    'invalid-affected-input',
  );
  assert.equal(
    refusal(() => plan([42])),
    'invalid-affected-input',
  );
});

test('more affected services than the catalog allows refuses the whole vector', () => {
  const manifests = parseDeploymentManifests([
    entry('one', { order: 1, unit: 'one' }),
    entry('two', { order: 2, unit: 'two' }),
    entry('three', { order: 3, unit: 'three' }),
  ]);
  const projects = new Set(['one', 'two', 'three']);

  assert.equal(
    refusal(() =>
      planReleaseVector({ affectedProjects: ['one', 'two', 'three'], manifests, projects }),
    ),
    'target-count-exceeded',
  );
  // Two still plan normally: the bound refuses the excess, it does not disable
  // the path.
  assert.deepEqual(
    planReleaseVector({ affectedProjects: ['three', 'one'], manifests, projects }).units,
    ['one', 'three'],
  );
});

test('an ambiguous manifest set produces no vector at all', () => {
  const cases = [
    ['duplicate-unit', [entry('one'), entry('two', { order: 2 })]],
    ['duplicate-order', [entry('one', { unit: 'one' }), entry('two', { unit: 'two' })]],
    [
      'unknown-dependency',
      [
        entry('one', { dependsOn: ['absent'], unit: 'one' }),
        entry('two', { order: 2, unit: 'two' }),
      ],
    ],
    [
      'dependency-order',
      [
        entry('one', { dependsOn: ['two'], order: 1, unit: 'one' }),
        entry('two', { order: 2, unit: 'two' }),
      ],
    ],
    ['self-dependency', [entry('one', { dependsOn: ['one'], unit: 'one' })]],
    ['no-deployable-units', [{ path: 'x/project.json', project: 'x' }]],
    ['unknown-field', [{ deployment: { ...deployment(), extra: true }, path: 'p', project: 'p' }]],
    ['missing-field', [{ deployment: { unit: 'one' }, path: 'p', project: 'p' }]],
    ['invalid-name', [entry('one', { stack: 'Api' })]],
    ['invalid-order', [entry('one', { order: 0 })]],
    ['invalid-port', [entry('one', { port: 70000 })]],
    ['invalid-depends-on', [entry('one', { dependsOn: 'api' })]],
    ['missing-verification', [entry('one', { verify: [] })]],
    ['invalid-verification', [entry('one', { verify: ['health/ready'] })]],
    ['invalid-verification', [entry('one', { verify: ['/a', '/a'] })]],
    ['invalid-deployment', [{ deployment: [], path: 'p', project: 'p' }]],
  ];

  for (const [code, entries] of cases) {
    assert.equal(
      refusal(() => parseDeploymentManifests(entries)),
      code,
      `expected ${code} for ${JSON.stringify(entries)}`,
    );
  }
});

test('a declared stack must have reviewed infrastructure to apply', () => {
  for (const manifest of declared.manifests.values()) {
    assert.ok(['api', 'web'].includes(manifest.stack));
  }
  assert.equal(
    refusal(() => loadDeploymentManifests('/nonexistent-money-noodle-root')),
    'no-deployable-units',
  );
});

test('the declared order matches the accepted deployment order', () => {
  // "A coordinated compatible contract change deploys API first, verifies it,
  // then web." The declared orders are what makes that true, so they are
  // asserted rather than assumed.
  const api = declared.manifests.get('api');
  const web = declared.manifests.get('web');
  assert.ok(api.order < web.order);
  assert.deepEqual([...web.dependsOn], ['api']);
  assert.deepEqual([...api.dependsOn], []);
  assert.ok(api.verify.includes('/v1/platform/status'), 'the API contract is verified after apply');
  for (const manifest of [api, web]) {
    assert.ok(manifest.verify.includes('/health/ready'));
  }
});
