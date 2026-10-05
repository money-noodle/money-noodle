// A service stack is an input of its deployment unit (#227).
//
// The four cases the maintainer's decision names are asserted end to end — through
// the real manifests and the real stacks, then through the planner that produces the
// vector the workflow deploys — plus the mapping's own edges on a synthetic tree.
//
// Nothing here reaches a network or a provider.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planReleaseVector } from './affected-services.mjs';
import { REPOSITORY_ROOT, loadDeploymentManifests } from './deployment-manifests.mjs';
import {
  projectsAffectedByStackPaths,
  readChangedPaths,
  stackInputDirectories,
  stackInputsByUnit,
} from './stack-inputs.mjs';
import { main as planRelease } from './plan-release.mjs';

const declared = loadDeploymentManifests();

/** The vector a push of exactly these paths would deploy, in declared order. */
function vectorFor(changedPaths, affectedProjects = []) {
  const stackAffected = projectsAffectedByStackPaths({
    changedPaths,
    manifests: declared.manifests,
  });
  return planReleaseVector({
    affectedProjects: [...new Set([...affectedProjects, ...stackAffected])],
    manifests: declared.manifests,
    projects: declared.projects,
  }).units;
}

test('a stack-only change deploys exactly the unit whose manifest names that stack', () => {
  // The case that motivated the decision: #219/#220 changed only the api stack, the
  // vector was empty, and the binding waited for an unrelated commit.
  assert.deepEqual(vectorFor(['infra/stacks/api/variables.tf']), ['api']);
  assert.deepEqual(vectorFor(['infra/stacks/web/main.tf']), ['web']);
  // Every path under the directory, not only the ones that look like configuration.
  assert.deepEqual(vectorFor(['infra/stacks/api/tests/runtime-contract.tftest.hcl']), ['api']);
  assert.deepEqual(vectorFor(['infra/stacks/api/.terraform.lock.hcl']), ['api']);
});

test('a change to a module both service stacks compose deploys both, in declared order', () => {
  const units = vectorFor(['infra/modules/cloud-run-service/main.tf']);

  assert.deepEqual(units, ['api', 'web']);
  // The order is the acceptance criterion, not an accident of iteration: the API
  // deploys and is verified before the web that reads it.
  const api = declared.manifests.get('api');
  const web = declared.manifests.get('web');
  assert.ok(api.order < web.order);
  assert.deepEqual([...web.dependsOn], ['api']);
});

test('a maintainer-applied stack produces no service vector', () => {
  // `platform` and `bootstrap` are applied by the maintainer under their own
  // authority (ADR-0005, ADR-0006). No manifest names them, so nothing maps to them,
  // and the routine path must not deploy a service because one of them changed.
  assert.deepEqual(vectorFor(['infra/stacks/platform/main.tf']), []);
  assert.deepEqual(vectorFor(['infra/stacks/bootstrap/variables.tf']), []);
  assert.deepEqual(vectorFor(['infra/stacks/platform/tests/secret-access.tftest.hcl']), []);
});

test('a module only a maintainer-applied stack composes produces no service vector', () => {
  for (const module of [
    'infra/modules/secret-store',
    'infra/modules/artifact-registry',
    'infra/modules/budget-guardrail',
    'infra/modules/telemetry-retention',
    'infra/modules/state-bucket',
    'infra/modules/workload-identity-federation',
  ]) {
    assert.deepEqual(vectorFor([`${module}/main.tf`]), [], `${module} must deploy no service`);
  }
});

test('a documentation change deploys nothing', () => {
  assert.deepEqual(vectorFor(['docs/operations/delivery.md', 'infra/bootstrap.md']), []);
});

test('an application change and its stack change are one deploy of that unit', () => {
  // Unioned, not chosen between. A commit that changes both must not produce the
  // unit twice, and must not exceed the catalog bound by double-counting.
  assert.deepEqual(vectorFor(['infra/stacks/api/main.tf'], ['platform-api']), ['api']);
  assert.deepEqual(vectorFor(['infra/stacks/api/main.tf'], ['platform-api', 'web']), [
    'api',
    'web',
  ]);
});

test('the mapping is derived from the stack, not from a table beside it', () => {
  // The two sources are the manifest's own `stack` field and the stack's own module
  // blocks. Asserting the derivation is what keeps a future stack from needing an
  // edit here as well.
  assert.deepEqual(stackInputDirectories('api'), [
    'infra/modules/cloud-run-service',
    'infra/stacks/api',
  ]);
  assert.deepEqual(stackInputDirectories('web'), [
    'infra/modules/cloud-run-service',
    'infra/stacks/web',
  ]);
  assert.deepEqual(stackInputDirectories('platform'), [
    'infra/modules/artifact-registry',
    'infra/modules/budget-guardrail',
    'infra/modules/secret-store',
    'infra/modules/telemetry-retention',
    'infra/stacks/platform',
  ]);

  const byUnit = stackInputsByUnit(declared.manifests);
  for (const manifest of declared.manifests.values()) {
    assert.ok(
      byUnit.get(manifest.unit).includes(`infra/stacks/${manifest.stack}`),
      `${manifest.unit} must have its declared stack among its inputs`,
    );
  }
});

test('a module a stack composes transitively is an input too', () => {
  // The infrastructure is flat today. The rule is not: a module that composes
  // another module has to carry it, or a change one level down would deploy nothing.
  const root = mkdtempSync(join(tmpdir(), 'money-noodle-stack-inputs-'));
  try {
    const write = (directory, body) => {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'main.tf'), body);
    };
    write('infra/stacks/example', 'module "outer" {\n  source = "../../modules/outer"\n}\n');
    write('infra/modules/outer', 'module "inner" {\n  source = "../../modules/inner"\n}\n');
    write('infra/modules/inner', '# nothing further\n');

    assert.deepEqual(stackInputDirectories('example', root), [
      'infra/modules/inner',
      'infra/modules/outer',
      'infra/stacks/example',
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('a module cycle terminates instead of recursing', () => {
  const root = mkdtempSync(join(tmpdir(), 'money-noodle-stack-cycle-'));
  try {
    const write = (directory, body) => {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'main.tf'), body);
    };
    write('infra/stacks/example', 'module "a" {\n  source = "../../modules/a"\n}\n');
    write('infra/modules/a', 'module "b" {\n  source = "../../modules/b"\n}\n');
    write('infra/modules/b', 'module "a" {\n  source = "../../modules/a"\n}\n');

    assert.deepEqual(stackInputDirectories('example', root), [
      'infra/modules/a',
      'infra/modules/b',
      'infra/stacks/example',
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('a path is matched on a directory boundary rather than as a prefix', () => {
  assert.deepEqual(vectorFor(['infra/stacks/apifoo/main.tf']), []);
  assert.deepEqual(vectorFor(['infra/stacks/api-next/main.tf']), []);
  assert.deepEqual(vectorFor(['infra/modules/cloud-run-service-extra/main.tf']), []);
  // The directory itself, with no file under it, still names the unit: a deletion
  // or a rename reported as the directory is a change to that stack.
  assert.deepEqual(vectorFor(['infra/stacks/api']), ['api']);
});

test('the changed-path list is read in either form the caller may hold it', () => {
  assert.deepEqual(readChangedPaths('a/b.tf\nc/d.tf\n'), ['a/b.tf', 'c/d.tf']);
  // `git diff --name-only` output with trailing blank lines and stray whitespace.
  assert.deepEqual(readChangedPaths('  a/b.tf  \n\n'), ['a/b.tf']);
  assert.deepEqual(readChangedPaths('["a/b.tf"]'), ['a/b.tf']);
  assert.deepEqual(readChangedPaths(''), []);
  assert.deepEqual(readChangedPaths(undefined), []);
  assert.throws(() => readChangedPaths('[not json'), { code: 'invalid-changed-input' });
  assert.throws(() => readChangedPaths('{"paths":[]}'), { code: 'invalid-changed-input' });
});

test('a malformed input refuses rather than planning from a guess', () => {
  assert.throws(
    () =>
      projectsAffectedByStackPaths({
        changedPaths: 'infra/stacks/api',
        manifests: declared.manifests,
      }),
    { code: 'invalid-changed-input' },
  );
  assert.throws(
    () => projectsAffectedByStackPaths({ changedPaths: [''], manifests: declared.manifests }),
    { code: 'invalid-changed-input' },
  );
  assert.throws(() => stackInputsByUnit(new Map()), { code: 'no-deployable-units' });
  assert.throws(() => stackInputDirectories('../escape'), { code: 'invalid-name' });
  assert.throws(() => stackInputDirectories(''), { code: 'invalid-name' });
});

test('the planner unions both inputs and reports which stack change selected a unit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'money-noodle-plan-release-'));
  try {
    const affected = join(directory, 'affected.json');
    const changed = join(directory, 'changed.txt');
    const summary = join(directory, 'summary.md');
    writeFileSync(affected, '[]\n');
    writeFileSync(changed, 'infra/stacks/api/variables.tf\n');

    const plan = planRelease(['--affected', affected, '--changed', changed], {
      GITHUB_STEP_SUMMARY: summary,
    });

    assert.deepEqual([...plan.units], ['api']);
    assert.deepEqual([...plan.unaffected], ['web']);
    // The published record says a stack change selected it, so a reader of a run can
    // tell a stack-only deploy from an application deploy without reading the diff.
    const published = readFileSync(summary, 'utf8');
    assert.match(published, /selected by a stack change: `platform-api`/u);
    assert.match(published, /1\. `api`/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('the planner without a changed list behaves exactly as the project graph alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'money-noodle-plan-release-bare-'));
  try {
    const affected = join(directory, 'affected.json');
    writeFileSync(affected, '["platform-api"]\n');

    assert.deepEqual([...planRelease(['--affected', affected], {}).units], ['api']);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('the delivery workflow feeds the planner both inputs from one range', () => {
  // The guard against the mechanism being bypassed: a workflow that stopped passing
  // `--changed`, or computed it from a different base than the affected set, would
  // silently restore the behaviour this change exists to fix.
  const workflow = readFileSync(join(REPOSITORY_ROOT, '.github/workflows/delivery.yml'), 'utf8');
  const job = workflow.match(/\n {2}release-plan:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n)/u)?.[1];
  assert.ok(job, 'the release vector job must exist');

  assert.match(job, /git diff --name-only "\$NX_BASE" HEAD > changed\.txt/u);
  assert.match(
    job,
    /node tools\/release\/plan-release\.mjs --affected affected\.json --changed changed\.txt/u,
  );
  // One range for both inputs.
  const ranges = [...job.matchAll(/NX_BASE: \$\{\{ steps\.range\.outputs\.base \}\}/gu)];
  assert.equal(ranges.length, 2, 'both inputs must come from the established range');
  assert.match(job, /rm -f affected\.json changed\.txt/u);
});
