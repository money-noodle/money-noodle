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
    const env = {};
    assert.ok(Array.isArray(container.env) && container.env.length > 0);
    for (const entry of container.env) {
      const name = text(entry.name);
      assert.ok(!Object.hasOwn(env, name), 'Duplicate environment name.');
      assert.deepEqual(entry.value_source, []);
      assert.ok(
        /^(NODE_ENV|PLATFORM_API_ORIGIN|ARTIFACT_VERSION|MONEY_NOODLE_(COMMIT|SERVICE|ENVIRONMENT)|OTEL_[A-Z_]+)$/u.test(
          name,
        ),
        'Unsupported environment name.',
      );
      env[name] = text(entry.value);
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
      image,
      port,
      expected,
      livePath: probe('liveness_probe', '/health/live'),
      readyPath: probe('startup_probe', '/health/ready'),
    };
  });
}

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
