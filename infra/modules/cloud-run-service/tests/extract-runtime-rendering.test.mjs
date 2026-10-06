#!/usr/bin/env node

// The runtime-contract bridge's extractor, against a capture this file builds.
//
// Why this exists: the bridge's own refusal suite runs *inside* the bridge, which
// first needs OpenTofu, a provider download and a `tofu test` of two stacks. That
// is a CI-only path, so the bridge's expectation could drift from what the stacks
// actually render and nothing would notice until `main` went red — which is what
// happened at 6142ed1, where #242's six gated secret references made the rendering
// legitimately smaller than the declaration and the bridge compared the two
// directly.
//
// So the extractor is exercised here over a synthetic `tofu test -json -verbose`
// capture. It runs in `pnpm check` on every change, needs no provider, and reaches
// nothing.
//
// What this is not: a substitute for the bridge. The capture is shaped to the
// bridge's own assertions rather than recorded from OpenTofu, so it proves what the
// extractor accepts and refuses — not that a real plan has this shape. The bridge
// still runs in CI, against a real evaluated plan, and is still the thing that
// proves the rendering. Both are needed: this one fails fast and locally, that one
// is true.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractRuntimeRendering } from './runtime-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tofuVersion = readFileSync(join(root, 'infra/.terraform-version'), 'utf8').trim();
const testFile = 'tests/runtime-contract.tftest.hcl';
const digest = `sha256:${'2'.repeat(64)}`;
const commit = '2'.repeat(40);

/** The containers the api stack declares, as #242 leaves them. */
const DECLARED = Object.freeze({
  PLATFORM_API_ACCOUNT_DATABASE_URL: 'platform-api-account-database-url',
  PLATFORM_API_ENGINE_READER_DATABASE_URL: 'platform-api-engine-reader-database-url',
  PLATFORM_API_ENGINE_RECORDER_DATABASE_URL: 'platform-api-engine-recorder-database-url',
  PLATFORM_API_IDENTITY_ACCOUNT_ID: 'platform-api-identity-account-id',
  PLATFORM_API_IDENTITY_AUDIENCE: 'platform-api-identity-audience',
  PLATFORM_API_IDENTITY_ISSUER: 'platform-api-identity-issuer',
  PLATFORM_API_PROJECTION_DATABASE_URL: 'platform-api-projection-database-url',
});

const PROJECTION = 'PLATFORM_API_PROJECTION_DATABASE_URL';

const secretEntry = (name, secret, version = 'latest') => ({
  name,
  value: null,
  value_source: [{ secret_key_ref: [{ secret, version }] }],
});

/**
 * A capture shaped to the bridge's assertions.
 *
 * Every field the extractor reads is present and nothing else is, so an assertion
 * the extractor gains without this capture gaining the field fails here loudly
 * rather than being skipped.
 */
function capture({
  stack = 'api',
  projectionGate = true,
  identityGate = false,
  declared = DECLARED,
  extraEnv = [],
} = {}) {
  const runs = stack === 'web' ? ['published_origin', 'explicit_origin'] : ['production_api'];
  const port = stack === 'web' ? 3000 : 3001;
  const image = `us-west1-docker.pkg.dev/example-project/platform/${
    stack === 'api' ? 'platform-api' : 'web'
  }@${digest}`;

  const records = [
    { '@level': 'info', type: 'version', tofu: tofuVersion, ui: '1.2' },
    { '@level': 'info', type: 'test_abstract', test_abstract: { [testFile]: runs } },
    { '@level': 'info', type: 'test_file', test_file: { path: testFile, status: 'pass' } },
  ];

  for (const run of runs) {
    const env = [
      { name: 'NODE_ENV', value: 'production', value_source: [] },
      { name: 'ARTIFACT_VERSION', value: 'release-1.2.3', value_source: [] },
      { name: 'MONEY_NOODLE_COMMIT', value: commit, value_source: [] },
      {
        name: 'MONEY_NOODLE_SERVICE',
        value: stack === 'api' ? 'platform-api' : 'web',
        value_source: [],
      },
      { name: 'MONEY_NOODLE_ENVIRONMENT', value: 'production', value_source: [] },
      ...(stack === 'web'
        ? [{ name: 'PLATFORM_API_ORIGIN', value: 'https://api.example.test', value_source: [] }]
        : []),
    ];
    if (stack === 'api' && projectionGate && Object.hasOwn(declared, PROJECTION)) {
      env.push(secretEntry(PROJECTION, declared[PROJECTION]));
    }
    if (stack === 'api' && identityGate) {
      for (const [name, secret] of Object.entries(declared)) {
        if (name !== PROJECTION) env.push(secretEntry(name, secret));
      }
    }
    env.push(...extraEnv);

    const address = 'module.service.google_cloud_run_v2_service.service';
    const outputs = {
      artifact_version: { sensitive: false, value: 'release-1.2.3' },
      deployed_digest: { sensitive: false, value: digest },
      source_commit: { sensitive: false, value: commit },
      ...(stack === 'web'
        ? { configured_api_base_url: { sensitive: false, value: 'https://api.example.test' } }
        : {}),
    };

    records.push({
      '@level': 'info',
      type: 'test_run',
      '@testrun': run,
      test_run: { path: testFile, run, status: 'pass' },
    });
    records.push({
      '@level': 'info',
      type: 'test_plan',
      '@testrun': run,
      '@testfile': testFile,
      test_plan: {
        terraform_version: tofuVersion,
        format_version: '1.2',
        errored: false,
        variables: {
          artifact_version: { value: 'release-1.2.3' },
          image_digest: { value: digest },
          source_commit: { value: commit },
          ...(stack === 'api'
            ? {
                accessible_secret_ids: { value: Object.values(declared) },
                identity_secret_binding_enabled: { value: identityGate },
                projection_secret_binding_enabled: { value: projectionGate },
                secret_environment: { value: declared },
              }
            : { accessible_secret_ids: { value: [] } }),
        },
        planned_values: {
          outputs,
          root_module: {
            child_modules: [
              {
                address: 'module.service',
                resources: [
                  {
                    address,
                    type: 'google_cloud_run_v2_service',
                    values: {
                      template: [
                        {
                          containers: [
                            {
                              env,
                              image,
                              ports: [{ container_port: port }],
                              liveness_probe: [{ http_get: [{ path: '/health/live', port }] }],
                              startup_probe: [{ http_get: [{ path: '/health/ready', port }] }],
                            },
                          ],
                        },
                      ],
                    },
                    sensitive_values: { template: [{}] },
                  },
                ],
              },
            ],
          },
        },
        resource_changes: [
          {
            address,
            type: 'google_cloud_run_v2_service',
            change: { after_unknown: { template: [{}] } },
          },
        ],
        output_changes: Object.fromEntries(
          Object.keys(outputs).map((name) => [name, { after_unknown: false }]),
        ),
      },
    });
  }

  records.push({
    '@level': 'info',
    type: 'test_summary',
    test_summary: { status: 'pass', passed: runs.length, failed: 0, errored: 0, skipped: 0 },
  });
  return records.map((record) => JSON.stringify(record)).join('\n');
}

/** Rebuild a capture, mutate the plan, and hand back the lines again. */
function mutated(options, mutate) {
  const records = capture(options)
    .split('\n')
    .map((line) => JSON.parse(line));
  mutate(records.find((record) => record.type === 'test_plan').test_plan);
  return records.map((record) => JSON.stringify(record)).join('\n');
}

const containerEnv = (plan) =>
  plan.planned_values.root_module.child_modules[0].resources[0].values.template[0].containers[0]
    .env;

test('each gate position renders exactly the references that gate admits', () => {
  // This is the case that failed on main at 6142ed1: six declared references are
  // withheld on purpose, because Cloud Run refuses a revision that references a
  // container which does not exist yet.
  const gatedOff = extractRuntimeRendering(capture({ identityGate: false }), 'api');
  assert.deepEqual(Object.keys(gatedOff[0].secretEnv), [PROJECTION]);

  const both = extractRuntimeRendering(capture({ identityGate: true }), 'api');
  assert.deepEqual(Object.keys(both[0].secretEnv).sort(), Object.keys(DECLARED).sort());

  const identityOnly = extractRuntimeRendering(
    capture({ identityGate: true, projectionGate: false }),
    'api',
  );
  assert.equal(Object.keys(identityOnly[0].secretEnv).length, 6);
  assert.ok(!Object.hasOwn(identityOnly[0].secretEnv, PROJECTION));

  const neither = extractRuntimeRendering(
    capture({ identityGate: false, projectionGate: false }),
    'api',
  );
  assert.deepEqual(neither[0].secretEnv, {});
});

test('every admitted reference names its own container, at latest', () => {
  const [rendering] = extractRuntimeRendering(capture({ identityGate: true }), 'api');
  for (const [name, secret] of Object.entries(DECLARED)) {
    assert.deepEqual(rendering.secretEnv[name], { secret, version: 'latest' });
  }
});

test('the web stack renders no secret reference', () => {
  const renderings = extractRuntimeRendering(capture({ stack: 'web' }), 'web');
  assert.equal(renderings.length, 2);
  for (const rendering of renderings) assert.deepEqual(rendering.secretEnv, {});
});

test('a reference rendered while its gate is off is refused', () => {
  const raw = capture({
    extraEnv: [
      secretEntry(
        'PLATFORM_API_ENGINE_RECORDER_DATABASE_URL',
        'platform-api-engine-recorder-database-url',
      ),
    ],
    identityGate: false,
  });
  assert.throws(() => extractRuntimeRendering(raw, 'api'));
});

test('a gate that claims to be on while nothing further renders is refused', () => {
  // The shape of a half-finished rollout: the flag flipped, the rendering did not.
  const raw = mutated({ identityGate: false }, (plan) => {
    plan.variables.identity_secret_binding_enabled.value = true;
  });
  assert.throws(() => extractRuntimeRendering(raw, 'api'));
});

test('a declared reference that stops rendering with every gate on is refused', () => {
  const raw = mutated({ identityGate: true }, (plan) => {
    const env = containerEnv(plan);
    env.splice(
      env.findIndex((entry) => entry.name === 'PLATFORM_API_IDENTITY_ISSUER'),
      1,
    );
  });
  assert.throws(() => extractRuntimeRendering(raw, 'api'));
});

test('a gate that is renamed away or is not a boolean is refused', () => {
  // Without this, a missing flag reads as `undefined`, withholds everything, and
  // looks indistinguishable from a deliberate off-switch.
  for (const mutate of [
    (plan) => delete plan.variables.identity_secret_binding_enabled,
    (plan) => delete plan.variables.projection_secret_binding_enabled,
    (plan) => {
      plan.variables.projection_secret_binding_enabled.value = 'true';
    },
    (plan) => {
      plan.variables.identity_secret_binding_enabled.value = null;
    },
  ]) {
    assert.throws(() => extractRuntimeRendering(mutated({}, mutate), 'api'));
  }
});

test('a rendered reference the stack does not declare is refused', () => {
  const raw = capture({
    declared: { [PROJECTION]: DECLARED[PROJECTION] },
    identityGate: true,
    extraEnv: [secretEntry('PLATFORM_API_IDENTITY_AUDIENCE', 'platform-api-identity-audience')],
  });
  assert.throws(() => extractRuntimeRendering(raw, 'api'));
});

test('an allowlisted name pointing at another container is refused', () => {
  const raw = mutated({ identityGate: true }, (plan) => {
    containerEnv(plan).find(
      (entry) => entry.name === 'PLATFORM_API_IDENTITY_ISSUER',
    ).value_source[0].secret_key_ref[0].secret = 'platform-api-identity-audience';
  });
  assert.throws(() => extractRuntimeRendering(raw, 'api'));
});

test('a name no stack allowlists is refused', () => {
  const raw = capture({ extraEnv: [secretEntry('DATABASE_URL', 'some-container')] });
  assert.throws(() => extractRuntimeRendering(raw, 'api'));
  assert.throws(() =>
    extractRuntimeRendering(
      capture({ stack: 'web', extraEnv: [secretEntry(PROJECTION, DECLARED[PROJECTION])] }),
      'web',
    ),
  );
});

test('a pinned version, an inline value, and an ungranted container are refused', () => {
  const pinned = mutated({}, (plan) => {
    containerEnv(plan).find(
      (entry) => entry.value_source?.length > 0,
    ).value_source[0].secret_key_ref[0].version = '1';
  });
  assert.throws(() => extractRuntimeRendering(pinned, 'api'));

  const inline = mutated({}, (plan) => {
    containerEnv(plan).find((entry) => entry.value_source?.length > 0).value = 'a value';
  });
  assert.throws(() => extractRuntimeRendering(inline, 'api'));

  const ungranted = mutated({}, (plan) => {
    plan.variables.accessible_secret_ids.value = [];
  });
  assert.throws(() => extractRuntimeRendering(ungranted, 'api'));
});
