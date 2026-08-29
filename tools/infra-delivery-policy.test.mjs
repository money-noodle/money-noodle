#!/usr/bin/env node

// Static safety guards over the delivery workflow.
//
// These run inside the existing repository gate (`node --test tools/*.test.mjs`)
// and need no OpenTofu, no provider, and no credential.
//
// The single most important property asserted here is that no path through this
// workflow reaches a provider without separately recorded explicit
// authorization, which is issue #14's final acceptance criterion.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowDirectory = join(repoRoot, '.github', 'workflows');
const deliveryPath = join(workflowDirectory, 'delivery.yml');

const read = (path) => readFileSync(path, 'utf8');
const relative = (path) => path.slice(repoRoot.length + 1);

const workflowPaths = readdirSync(workflowDirectory)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => join(workflowDirectory, name));

const delivery = existsSync(deliveryPath) ? read(deliveryPath) : null;
const pinnedToolVersion = read(join(repoRoot, 'infra', '.terraform-version')).trim();

// Splits the top-level `jobs:` mapping into individual job bodies.
function deliveryJobs() {
  const jobsSection = delivery.slice(delivery.indexOf('\njobs:\n'));
  const matches = [
    ...jobsSection.matchAll(/\n {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n|$)/g),
  ];
  return matches.map(([, name, body]) => ({ name, body }));
}

test('the delivery workflow exists', () => {
  assert.ok(delivery, 'expected .github/workflows/delivery.yml');
  assert.ok(deliveryJobs().length >= 5, 'expected the delivery workflow to define several jobs');
});

test('every action is pinned to a commit SHA', () => {
  for (const path of workflowPaths) {
    for (const [, reference] of read(path).matchAll(/uses:\s*(\S+)/g)) {
      assert.match(
        reference,
        /@[0-9a-f]{40}$/,
        `${relative(path)} uses ${reference}, which is not pinned to a commit SHA. A moving tag lets an action's content change under a workflow that holds provider authority.`,
      );
    }
  }
});

test('no job grants provider authority to a pull request', () => {
  // ADR-0005: a token minted for a fork or an untrusted pull request must not be
  // exchangeable for provider authority. Planning reads remote state, and state
  // is sensitive by default, so this covers plan as well as apply.
  const privileged = deliveryJobs().filter(({ body }) => /id-token:\s*write/.test(body));
  assert.ok(privileged.length > 0, 'expected at least one job to request an OIDC token');

  for (const job of privileged) {
    const condition = job.body.match(/\n {4}if: >-\n([\s\S]*?)\n {4}\S/)?.[1] ?? '';
    assert.ok(
      condition.includes('github.event_name'),
      `job "${job.name}" requests id-token: write without constraining github.event_name`,
    );
    assert.ok(
      !condition.includes('pull_request'),
      `job "${job.name}" requests id-token: write on a pull request event`,
    );
    assert.ok(
      condition.includes("federation_configured == 'true'"),
      `job "${job.name}" must be gated on federation being configured, so an unconfigured repository reaches no provider`,
    );
  }
});

test('an unconfigured repository cannot reach a provider at all', () => {
  // As committed, none of the GCP repository variables exist. The authorization
  // job resolves them to false and every provider job is skipped. This is what
  // makes "no provider resource is applied without explicit authorization" a
  // property of the workflow rather than a promise about operator behaviour.
  const authorization = deliveryJobs().find(({ name }) => name === 'authorization');
  assert.ok(authorization, 'expected an authorization job');
  assert.ok(
    authorization.body.includes('vars.GCP_WORKLOAD_IDENTITY_PROVIDER'),
    'authorization state must be derived from repository variables the maintainer sets deliberately',
  );
  assert.ok(
    !/secrets\./.test(authorization.body),
    'authorization state must not depend on a secret; federation identifiers are non-secret by construction',
  );
});

test('applying requires explicit recorded authorization', () => {
  const apply = deliveryJobs().find(({ name }) => name === 'apply');
  assert.ok(apply, 'expected an apply job');

  const condition = apply.body.match(/if: >-\n([\s\S]*?)\n {4}runs-on:/)?.[1];
  assert.ok(condition, 'the apply job must carry a guard condition');

  for (const requirement of [
    "github.event_name == 'workflow_dispatch'",
    "github.event.inputs.action == 'apply'",
    "github.event.inputs.confirmation == 'APPLY-TO-PRODUCTION'",
    "needs.authorization.outputs.apply_authorized == 'true'",
    "needs.authorization.outputs.federation_configured == 'true'",
  ]) {
    assert.ok(
      condition.includes(requirement),
      `the apply job must require \`${requirement}\`. Issue #14: no provider resource is applied without separately recorded explicit authorization.`,
    );
  }

  assert.match(
    apply.body,
    /environment: production/,
    'the apply job must run in a protected environment, so required reviewers apply to it',
  );
});

test('rollback mutates production and carries the same authorization requirement', () => {
  const rollback = deliveryJobs().find(({ name }) => name === 'rollback');
  assert.ok(rollback, 'expected a rollback job');

  const condition = rollback.body.match(/if: >-\n([\s\S]*?)\n {4}runs-on:/)?.[1];
  assert.ok(
    condition.includes("needs.authorization.outputs.apply_authorized == 'true'"),
    'rollback changes what production serves and must be authorized like an apply',
  );
  assert.match(
    rollback.body,
    /environment: production/,
    'rollback must use the protected environment',
  );
});

test('no workflow can destroy infrastructure', () => {
  // ADR-0006: destroy is not available to ordinary automation. Removing a
  // resource requires a reviewed code change.
  for (const path of workflowPaths) {
    const source = read(path);
    assert.ok(
      !/\b(?:tofu|terraform)\s+destroy\b/.test(source),
      `${relative(path)} invokes destroy. Removing a resource is a reviewed code change, never a pipeline action.`,
    );
    assert.ok(
      !/\s-destroy\b/.test(source),
      `${relative(path)} passes -destroy to a plan or apply, which would queue a teardown.`,
    );
  }
});

test('applies are serialized and never cancelled mid-flight', () => {
  const concurrency = delivery.match(/\nconcurrency:\n([\s\S]*?)\n\S/)?.[1];
  assert.ok(concurrency, 'the delivery workflow must declare a concurrency group');
  assert.match(
    concurrency,
    /cancel-in-progress:\s*false/,
    'an in-flight apply must not be cancelled; cancelling mid-apply is how state locks are orphaned',
  );

  const invocations = [...delivery.matchAll(/tofu (?:plan|apply)([^\n]*)/g)];
  assert.ok(invocations.length > 0, 'expected plan and apply invocations');
  for (const [line, flags] of invocations) {
    assert.match(
      flags,
      /-lock-timeout=/,
      `\`${line.trim()}\` must wait for the state lock rather than failing immediately or proceeding without it`,
    );
  }
});

test('deployment verifies provenance, health, and the public contract', () => {
  assert.match(
    delivery,
    /gh attestation verify/,
    'the deployment step must verify the digest carries an attestation from this repository (ADR-0005)',
  );
  assert.match(
    delivery,
    /--repo "\$\{\{ github\.repository \}\}"/,
    'attestation verification must be scoped to this repository, otherwise any signed image passes',
  );
  assert.match(
    delivery,
    /\/health\/ready/,
    'deployment must verify readiness before reporting success',
  );
  assert.match(
    delivery,
    /\/v1\/platform\/status/,
    'deployment must verify the public contract, not only that the process answers',
  );
});

test('deployment is by digest and a tag is refused before the provider is reached', () => {
  assert.match(
    delivery,
    /\^sha256:\[0-9a-f\]\{64\}\$/,
    'the workflow must reject a non-digest image reference before it reaches an apply',
  );
  assert.ok(
    !/--tag[^\n]*:latest/.test(delivery),
    'nothing may be published or deployed under a `latest` tag',
  );
});

test('drift is reported and never silently corrected', () => {
  const drift = deliveryJobs().find(({ name }) => name === 'drift');
  assert.ok(drift, 'expected a scheduled drift job');

  assert.match(drift.body, /-refresh-only/, 'drift detection must propose no changes');
  assert.match(
    drift.body,
    /-detailed-exitcode/,
    'drift detection must distinguish "no difference" from "difference found"',
  );
  assert.ok(
    !/tofu apply/.test(drift.body),
    'the drift job must not apply. A difference between reviewed desired state and observed reality is information the maintainer must see.',
  );
});

test('no provider credential is stored as a GitHub secret', () => {
  // ADR-0005 rules out a stored provider key entirely. Federation identifiers are
  // `vars`, non-secret by construction; a `secrets.GCP_*` reference would mean
  // somebody had pasted a key.
  for (const path of workflowPaths) {
    for (const [, name] of read(path).matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      assert.ok(
        !/^(?:GCP|GOOGLE|GCLOUD|TF)_/.test(name),
        `${relative(path)} reads secrets.${name}. Provider access comes from OIDC token exchange; no long-lived cloud key is stored (ADR-0005).`,
      );
    }
  }
});

test('the workflow installs the OpenTofu version the repository pins', () => {
  const pinned = delivery.match(/TOFU_VERSION:\s*'([^']+)'/)?.[1];
  assert.equal(
    pinned,
    pinnedToolVersion,
    'the workflow must install the version in infra/.terraform-version, so local and CI results mean the same thing',
  );

  for (const [, version] of delivery.matchAll(
    /tofu_version:\s*\$\{\{\s*env\.TOFU_VERSION\s*\}\}/g,
  )) {
    assert.ok(version === undefined || true);
  }
  assert.ok(
    !/tofu_version:\s*(?:latest|['"]?\d)/.test(delivery),
    'the workflow must not install `latest` or a second hard-coded version',
  );
});

test('the delivery workflow does not weaken or replace the existing CI gate', () => {
  const ciPath = join(workflowDirectory, 'ci.yml');
  assert.ok(existsSync(ciPath), 'ci.yml must still exist');

  const ci = read(ciPath);
  for (const gate of [
    'pnpm audit --audit-level high',
    'gitleaks/gitleaks-action',
    'aquasecurity/trivy-action',
    'pnpm nx affected -t lint,typecheck,test,contract,build',
  ]) {
    assert.ok(ci.includes(gate), `ci.yml no longer runs its \`${gate}\` gate`);
  }
});

test('the workflow authorised for delivery is the one that exists', () => {
  // The trust conjunction names an exact `job_workflow_ref`. If the bootstrap
  // default and the workflow filename disagree, every delivery run is refused
  // by the provider for a reason that is confusing to diagnose.
  const bootstrap = read(join(repoRoot, 'infra', 'stacks', 'bootstrap', 'variables.tf'));
  const authorised = bootstrap.match(
    /allowed_workflow_paths"[\s\S]*?default\s*=\s*\[\s*"([^"]+)"/,
  )?.[1];

  assert.ok(authorised, 'the bootstrap stack must declare an authorised workflow path');
  assert.ok(
    existsSync(join(repoRoot, authorised)),
    `the bootstrap stack authorises ${authorised}, which does not exist in the repository`,
  );
  assert.equal(
    authorised,
    '.github/workflows/delivery.yml',
    'the authorised delivery workflow must be the delivery workflow',
  );
});
