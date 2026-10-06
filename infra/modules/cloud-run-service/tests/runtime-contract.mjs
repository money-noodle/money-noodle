#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const testFile = 'tests/runtime-contract.tftest.hcl';
const version = readFileSync(join(root, 'infra/.terraform-version'), 'utf8').trim();

function one(values) {
  assert.ok(Array.isArray(values) && values.length === 1, 'Expected exactly one evaluated value.');
  return values[0];
}
function known(value) {
  if (value === true) return false;
  if (value && typeof value === 'object') return Object.values(value).every(known);
  return true;
}
function text(value) {
  assert.ok(typeof value === 'string' && value.length > 0, 'Missing evaluated string.');
  return value;
}

// Qualified against OpenTofu 1.12.6 test -json -verbose (UI 1.2, plan 1.2).
// Consume evaluated resources, never configuration expressions or a copied merge.
export function extractRuntimeRendering(raw, stack) {
  assert.ok(['web', 'api'].includes(stack), 'Unsupported stack.');
  const runs = stack === 'web' ? ['published_origin', 'explicit_origin'] : ['production_api'];
  const records = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const allowedTypes = new Set([
    'version',
    'test_abstract',
    'test_file',
    'test_run',
    'test_plan',
    'test_summary',
  ]);
  for (const record of records) {
    assert.ok(
      allowedTypes.has(record.type) && record['@level'] === 'info',
      'Unsupported OpenTofu output.',
    );
  }
  const reported = one(records.filter((record) => record.type === 'version'));
  assert.equal(reported.tofu, version);
  assert.equal(reported.ui, '1.2');
  assert.deepEqual(one(records.filter((record) => record.type === 'test_abstract')).test_abstract, {
    [testFile]: runs,
  });
  assert.deepEqual(one(records.filter((record) => record.type === 'test_file')).test_file, {
    path: testFile,
    status: 'pass',
  });
  assert.deepEqual(one(records.filter((record) => record.type === 'test_summary')).test_summary, {
    status: 'pass',
    passed: runs.length,
    failed: 0,
    errored: 0,
    skipped: 0,
  });
  assert.equal(records.filter((record) => record.type === 'test_plan').length, runs.length);
  assert.equal(records.filter((record) => record.type === 'test_run').length, runs.length);

  return runs.map((run) => {
    assert.deepEqual(
      one(records.filter((record) => record.type === 'test_run' && record['@testrun'] === run))
        .test_run,
      {
        path: testFile,
        run,
        status: 'pass',
      },
    );
    const record = one(
      records.filter((entry) => entry.type === 'test_plan' && entry['@testrun'] === run),
    );
    assert.equal(record['@testfile'], testFile);
    const plan = record.test_plan;
    assert.equal(plan.terraform_version, version);
    assert.equal(plan.format_version, '1.2');
    assert.equal(plan.errored, false);
    const module = one(plan.planned_values.root_module.child_modules);
    assert.equal(module.address, 'module.service');
    const resource = one(
      module.resources.filter((entry) => entry.type === 'google_cloud_run_v2_service'),
    );
    const change = one(
      plan.resource_changes.filter((entry) => entry.address === resource.address),
    ).change;
    const container = one(one(resource.values.template).containers);
    const unknown = change.after_unknown?.template;
    assert.ok(known(unknown), 'Runtime configuration contains unknown values.');
    assert.ok(
      known(resource.sensitive_values?.template),
      'Runtime configuration contains sensitive values.',
    );
    // An environment entry is one of exactly two kinds (#209, ADR-0012).
    //
    //   * A plain value entry: no `value_source`, a name on the allowlist regex,
    //     and a non-empty evaluated value. Unchanged rules.
    //   * A secret-reference entry: a name on the explicit per-stack allowlist
    //     below, no inline value at all, and one `secret_key_ref` naming the
    //     secret this stack's evaluated plan declares, at `latest`.
    //
    // The second kind is why this bridge still proves what it claims to. It reads
    // a *reference*, so the rendering can be checked without a value existing
    // anywhere — which is the same reason the value is held in a managed secret
    // rather than in configuration.
    // #242 adds six, each behind `identity_secret_binding_enabled`, which is off
    // until the maintainer has created those containers. They are allowlisted with
    // the gate rather than after it, so the flip is a one-line change here too and
    // the rendered plan is still checked name by name: a name outside this list
    // fails, an inline value fails, and a reference to a container the plan does
    // not also declare as granted fails.
    const secretNameAllowlist =
      stack === 'api'
        ? [
            'PLATFORM_API_PROJECTION_DATABASE_URL',
            'PLATFORM_API_ENGINE_READER_DATABASE_URL',
            'PLATFORM_API_ENGINE_RECORDER_DATABASE_URL',
            'PLATFORM_API_ACCOUNT_DATABASE_URL',
            'PLATFORM_API_IDENTITY_AUDIENCE',
            'PLATFORM_API_IDENTITY_ISSUER',
            'PLATFORM_API_IDENTITY_ACCOUNT_ID',
          ]
        : [];
    // Taken from the evaluated plan, never restated here. A literal copied into
    // this file would keep passing after the stack stopped declaring the binding,
    // which is precisely the drift this bridge exists to catch.
    const declaredSecretEnv = plan.variables.secret_environment?.value ?? {};
    const grantedSecretIds = plan.variables.accessible_secret_ids?.value ?? [];

    const env = {};
    const secretEnv = {};
    assert.ok(Array.isArray(container.env) && container.env.length > 0);
    for (const entry of container.env) {
      const name = text(entry.name);
      assert.ok(
        !Object.hasOwn(env, name) && !Object.hasOwn(secretEnv, name),
        'Duplicate environment name.',
      );

      if (Array.isArray(entry.value_source) && entry.value_source.length > 0) {
        assert.ok(secretNameAllowlist.includes(name), 'Unsupported secret environment name.');
        // Null rather than empty string: the pinned provider renders an absent
        // inline value as null, and accepting anything else would accept an entry
        // carrying both a literal and a reference.
        assert.ok(
          entry.value === null || entry.value === undefined,
          'A secret reference carries no inline value.',
        );
        const source = one(entry.value_source);
        assert.deepEqual(Object.keys(source), ['secret_key_ref']);
        const reference = one(source.secret_key_ref);
        assert.deepEqual(Object.keys(reference).sort(), ['secret', 'version']);
        const secret = text(reference.secret);
        assert.equal(
          secret,
          text(declaredSecretEnv[name]),
          'A secret reference must name the secret this plan declares for it.',
        );
        // A reference the runtime identity cannot read would surface as an
        // instance that will not start, so it is refused here instead.
        assert.ok(
          grantedSecretIds.includes(secret),
          'A referenced secret must also be granted to this runtime identity.',
        );
        // `latest` is the accepted custody rule: revocation is "add a new
        // version", so a pinned version would keep serving a replaced credential.
        assert.equal(reference.version, 'latest');
        secretEnv[name] = { secret, version: reference.version };
        continue;
      }

      assert.deepEqual(entry.value_source, []);
      assert.ok(
        /^(NODE_ENV|PLATFORM_API_ORIGIN|ARTIFACT_VERSION|MONEY_NOODLE_(COMMIT|SERVICE|ENVIRONMENT)|GOOGLE_CLOUD_QUOTA_PROJECT|OTEL_[A-Z_]+)$/u.test(
          name,
        ),
        'Unsupported environment name.',
      );
      env[name] = text(entry.value);
    }

    // The rendering must match the declared intent exactly. A dropped binding is a
    // change to the production runtime, and an extra one is a new credential path.
    assert.deepEqual(Object.keys(secretEnv).sort(), Object.keys(declaredSecretEnv).sort());
    // Stated separately as well as through the empty allowlist above, because
    // "the web is never a database client" is the rule most worth failing loudly.
    if (stack === 'web') {
      assert.deepEqual(secretEnv, {}, 'The web stack may hold no secret reference.');
    }
    // Since #219 the api runtime binds the projection connection string, so the
    // expected rendering is a fixed one rather than "whatever this stack declares".
    // Matching the declaration alone would also accept a stack that quietly declared
    // nothing, which is the shape of a credential path switched off by accident.
    if (stack === 'api') {
      assert.deepEqual(secretEnv, {
        PLATFORM_API_PROJECTION_DATABASE_URL: {
          secret: 'platform-api-projection-database-url',
          version: 'latest',
        },
      });
    }
    const required = [
      'NODE_ENV',
      'ARTIFACT_VERSION',
      'MONEY_NOODLE_COMMIT',
      'MONEY_NOODLE_SERVICE',
      'MONEY_NOODLE_ENVIRONMENT',
    ];
    if (stack === 'web') required.push('PLATFORM_API_ORIGIN');
    for (const name of required) text(env[name]);
    const outputs = plan.planned_values.outputs;
    const output = (name) => {
      assert.equal(outputs[name]?.sensitive, false);
      assert.ok(known(plan.output_changes[name]?.after_unknown));
      return text(outputs[name]?.value);
    };
    const expected = {
      version: output('artifact_version'),
      sourceCommit: output('source_commit'),
      digest: output('deployed_digest'),
      ...(stack === 'web' ? { origin: output('configured_api_base_url') } : {}),
    };
    assert.equal(expected.version, plan.variables.artifact_version.value);
    assert.equal(expected.sourceCommit, plan.variables.source_commit.value);
    assert.equal(expected.digest, plan.variables.image_digest.value);
    const image = text(container.image);
    assert.equal(
      image,
      `us-west1-docker.pkg.dev/example-project/platform/${stack === 'api' ? 'platform-api' : 'web'}@${expected.digest}`,
    );
    const port = one(container.ports).container_port;
    assert.equal(port, stack === 'web' ? 3000 : 3001);
    const probe = (name, path) => {
      const http = one(one(container[name]).http_get);
      assert.equal(http.path, path);
      assert.equal(http.port, port);
      return http.path;
    };
    return {
      run,
      env,
      secretEnv,
      image,
      port,
      expected,
      livePath: probe('liveness_probe', '/health/live'),
      readyPath: probe('startup_probe', '/health/ready'),
    };
  });
}

const planOf = (records) => records.find((record) => record.type === 'test_plan').test_plan;

const containerEnv = (records) =>
  planOf(records).planned_values.root_module.child_modules[0].resources.find(
    (entry) => entry.type === 'google_cloud_run_v2_service',
  ).values.template[0].containers[0].env;

const secretReferenceEntry = (records) =>
  containerEnv(records).find((entry) => entry.value_source?.length > 0);

const secretKeyRef = (records) => secretReferenceEntry(records).value_source[0].secret_key_ref[0];

// Mutate the actual capture to prove the extractor fails closed, without a
// parallel handwritten rendering fixture that could drift from production.
function verifyExtractionFailures(raw, stack) {
  const mutations = [
    (records) => records.push(records.find((record) => record.type === 'test_plan')),
    (records) => records.push({ type: 'unsupported', '@level': 'info' }),
    (records) => {
      records.find((record) => record.type === 'test_summary').test_summary.status = 'fail';
    },
    (records) => {
      records.find((record) => record.type === 'version').ui = 'unsupported';
    },
    (records) => {
      const plan = records.find((record) => record.type === 'test_plan').test_plan;
      const resource = plan.planned_values.root_module.child_modules[0].resources.find(
        (entry) => entry.type === 'google_cloud_run_v2_service',
      );
      resource.values.template[0].containers[0].env = [];
    },
    (records) => {
      const plan = records.find((record) => record.type === 'test_plan').test_plan;
      const resource = plan.planned_values.root_module.child_modules[0].resources.find(
        (entry) => entry.type === 'google_cloud_run_v2_service',
      );
      const env = resource.values.template[0].containers[0].env;
      env.push(env[0]);
    },
    (records) => {
      const plan = records.find((record) => record.type === 'test_plan').test_plan;
      const change = plan.resource_changes.find(
        (entry) => entry.type === 'google_cloud_run_v2_service',
      ).change;
      change.after_unknown.template = true;
    },
    (records) => {
      const plan = records.find((record) => record.type === 'test_plan').test_plan;
      delete plan.planned_values.outputs.source_commit;
    },
    // A secret reference under a name no stack allowlists. Refused on both, which
    // is what stops the allowlist being a comment.
    (records) => {
      containerEnv(records).push({
        name: 'DATABASE_URL',
        value: null,
        value_source: [{ secret_key_ref: [{ secret: 'some-secret', version: 'latest' }] }],
      });
    },
    ...(stack === 'api'
      ? [
          // Each field of the accepted reference, broken one at a time.
          (records) => {
            secretKeyRef(records).version = '1';
          },
          (records) => {
            secretKeyRef(records).secret = 'a-secret-the-plan-does-not-declare';
          },
          (records) => {
            secretReferenceEntry(records).value = 'an inline value';
          },
          (records) => {
            secretReferenceEntry(records).name = 'DATABASE_URL';
          },
          (records) => {
            secretKeyRef(records).project = 'example-project';
          },
          (records) => {
            secretReferenceEntry(records).value_source[0].secret_key_ref.push({
              secret: 'a-second-secret',
              version: 'latest',
            });
          },
          // The reference survives but the plan stops declaring it. The
          // plan-derived comparison is what refuses this, which is why the secret
          // id is read from the evaluated plan rather than only pinned below.
          (records) => {
            delete planOf(records).variables.secret_environment;
          },
          // A reference the runtime identity was never granted.
          (records) => {
            planOf(records).variables.accessible_secret_ids.value = [];
          },
          // The declared binding silently dropped from the rendering.
          (records) => {
            const env = containerEnv(records);
            env.splice(env.indexOf(secretReferenceEntry(records)), 1);
          },
          // Both sides dropped together, so declaration and rendering still agree
          // and only the fixed expectation is left to refuse it. This is what a
          // credential path switched off by accident looks like: nothing
          // contradicts itself, and the api simply stops reading the projection
          // (#219).
          (records) => {
            const env = containerEnv(records);
            env.splice(env.indexOf(secretReferenceEntry(records)), 1);
            planOf(records).variables.secret_environment.value = {};
          },
        ]
      : [
          // The web stack carries none, and must keep carrying none.
          (records) => {
            containerEnv(records).push({
              name: 'PLATFORM_API_PROJECTION_DATABASE_URL',
              value: null,
              value_source: [
                {
                  secret_key_ref: [
                    { secret: 'platform-api-projection-database-url', version: 'latest' },
                  ],
                },
              ],
            });
          },
        ]),
  ];
  for (const mutate of mutations) {
    const records = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    mutate(records);
    assert.throws(() =>
      extractRuntimeRendering(records.map((record) => JSON.stringify(record)).join('\n'), stack),
    );
  }
}

function main() {
  const parent = process.env.RUNTIME_CONTRACT_SCRATCH ?? tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(parent, 'runtime-contract-'));
  const keep = process.env.RUNTIME_CONTRACT_SCRATCH !== undefined;
  const execute = (command, args, cwd, label, env = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    writeFileSync(join(scratch, `${label}.stdout`), result.stdout ?? '', { mode: 0o600 });
    writeFileSync(join(scratch, `${label}.stderr`), result.stderr ?? '', { mode: 0o600 });
    assert.ok(!result.error && result.status === 0, `${label} failed; no raw output is emitted.`);
    return result.stdout;
  };
  try {
    const reported = execute('tofu', ['version', '-json'], root, 'version');
    assert.equal(JSON.parse(reported).terraform_version, version);
    cpSync(join(root, 'infra'), join(scratch, 'infra'), {
      recursive: true,
      filter: (source) =>
        !['.terraform', 'terraform.tfstate', 'terraform.tfstate.backup'].includes(basename(source)),
    });
    // Give provider setup an empty home and no inherited cloud/TF settings. All
    // remote reads are overridden and the Google provider is mocked in HCL.
    const home = join(scratch, 'home');
    mkdirSync(home);
    const tofuEnv = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => /^(GOOGLE_|GCLOUD_|CLOUDSDK_|TF_|TOFU_)/u.test(key))
        .map((key) => [key, undefined]),
    );
    Object.assign(tofuEnv, { HOME: home, TF_IN_AUTOMATION: '1' });
    const rendering = {};
    for (const stack of ['web', 'api']) {
      const cwd = join(scratch, 'infra/stacks', stack);
      execute(
        'tofu',
        ['init', '-backend=false', '-input=false', '-lockfile=readonly'],
        cwd,
        `${stack}-init`,
        tofuEnv,
      );
      const raw = execute(
        'tofu',
        ['test', `-filter=${testFile}`, '-json', '-verbose'],
        cwd,
        `${stack}-render`,
        tofuEnv,
      );
      rendering[stack] = extractRuntimeRendering(raw, stack);
      verifyExtractionFailures(raw, stack);
    }
    const path = join(scratch, 'evaluated-runtime.json');
    writeFileSync(path, JSON.stringify(rendering), { mode: 0o600 });
    // Same dependency ordering as web:test (#65), not a stale generated dist.
    execute(
      'pnpm',
      ['nx', 'run', 'platform-api-client:build', '--skip-nx-cache'],
      root,
      'client-build',
    );
    execute(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'infra/modules/cloud-run-service/tests/runtime-contract.vitest.config.ts',
      ],
      root,
      'composition',
      { RUNTIME_CONTRACT_RENDERING: path },
    );
    console.log(
      'Configuration-contract v1: 3 evaluated production renderings passed real reader/composition checks. Public API schema remains v1; no deployed-revision or provenance proof.',
    );
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error('Runtime configuration bridge failed. No raw capture is emitted.');
    process.exitCode = 1;
  }
}
