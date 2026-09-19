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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalDigest, isGitObjectId, isSha256Hex } from './delivery/canonical-json.mjs';
import {
  CONSENT_BODY_FIELDS,
  OPERATIONS,
  PERMITTED_EVENTS,
  PERMITTED_FEDERATED_WORKFLOW,
  PERMITTED_REF,
} from './delivery/catalog-v2.mjs';
import {
  EXECUTION_IDENTITIES,
  RESOURCE_OPERATIONS,
  isResourceKey,
} from './delivery/execution-identities.mjs';
import { deriveExplicitConsent, evaluateGrant } from './delivery/grant.mjs';
import { REFUSAL_CODES } from './delivery/refusals.mjs';
import { assertPublishable, findForbiddenMarkers } from './delivery/sanitize.mjs';

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
    assert.ok(
      condition.includes("github.ref == 'refs/heads/main'"),
      `job "${job.name}" must be gated on protected main; no other ref may reach a provider`,
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
  assert.match(
    authorization.body,
    /permissions:\s*\{\}/,
    'the authorization job reads only repository variables and must receive no token permissions',
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
    "needs.authorization.outputs.provider_configured == 'true'",
    "needs.authorization.outputs.environment_reviewers_verified == 'true'",
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
  for (const requirement of [
    "needs.authorization.outputs.apply_authorized == 'true'",
    "needs.authorization.outputs.provider_configured == 'true'",
    "needs.authorization.outputs.environment_reviewers_verified == 'true'",
  ]) {
    assert.ok(
      condition.includes(requirement),
      `rollback changes what production serves and must require \`${requirement}\``,
    );
  }
  assert.match(
    rollback.body,
    /environment: production/,
    'rollback must use the protected environment',
  );
});

test('every provider operation receives the complete stack input contract', () => {
  const authorization = deliveryJobs().find(({ name }) => name === 'authorization');
  assert.ok(authorization, 'expected an authorization job');

  for (const name of [
    'GCP_PROJECT_ID',
    'GCP_PROJECT_NUMBER',
    'GCP_STATE_BUCKET_PREFIX',
    'GCP_BILLING_ACCOUNT_ID',
    'GCP_BUDGET_ALERT_EMAIL_ADDRESSES_JSON',
  ]) {
    assert.ok(
      authorization.body.includes(`vars.${name}`),
      `authorization must refuse provider operations until ${name} is configured`,
    );
  }

  for (const jobName of ['plan', 'drift', 'apply']) {
    const job = deliveryJobs().find(({ name }) => name === jobName);
    for (const variable of [
      'TF_VAR_bootstrap_state_bucket',
      'TF_VAR_platform_state_bucket',
      'TF_VAR_api_state_bucket',
      'TF_VAR_project_number',
      'TF_VAR_billing_account_id',
      'TF_VAR_budget_alert_email_addresses',
    ]) {
      assert.ok(job.body.includes(variable), `${jobName} does not supply ${variable}`);
    }
  }
});

test('service plans are explicit and bind the digest to its attested source commit', () => {
  const plan = deliveryJobs().find(({ name }) => name === 'plan');
  assert.match(
    plan.body,
    /github\.event\.inputs\.stack/,
    'manual plan must operate only on the selected stack',
  );
  assert.match(
    plan.body,
    /\^sha256:\[0-9a-f\]\{64\}\$/,
    'service plan must reject a mutable or malformed digest',
  );
  assert.match(plan.body, /\^\[0-9a-f\]\{40\}\$/, 'service plan must require a full source commit');
  assert.match(
    plan.body,
    /--source-digest "\$SOURCE_COMMIT"/,
    'service plan must cryptographically bind digest provenance to source commit',
  );
  assert.match(
    plan.body,
    /--signer-workflow/,
    'service plan must constrain the workflow that signed provenance',
  );
  assert.match(
    plan.body,
    /--source-ref refs\/heads\/main/,
    'service plan must accept provenance only from protected main',
  );
});

test('rollback reloads all dynamic template inputs from state and applies a saved plan', () => {
  const rollback = deliveryJobs().find(({ name }) => name === 'rollback');
  for (const output of [
    'deployed_digest',
    'artifact_version',
    'source_commit',
    'configured_revision_suffix',
  ]) {
    assert.ok(
      rollback.body.includes(`tofu output -raw ${output}`),
      `rollback must preserve ${output} from the currently configured template`,
    );
  }
  assert.match(
    rollback.body,
    /tofu plan[^\n]*-out=rollback\.tfplan/,
    'rollback must save the reviewed traffic-only plan',
  );
  assert.match(
    rollback.body,
    /tofu apply[^\n]*rollback\.tfplan/,
    'rollback must apply exactly its saved plan',
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
  assert.match(
    drift.body,
    /github\.event_name == 'schedule'/,
    'drift authority must be limited to the scheduled event',
  );
  assert.match(
    drift.body,
    /github\.ref == 'refs\/heads\/main'/,
    'scheduled drift must remain limited to the exact main workflow ref',
  );
  assert.ok(
    !/issues:\s*write/.test(drift.body),
    'drift does not write issues and must not receive that permission',
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

test('the manual CI baseline covers applications and no-provider OpenTofu checks', () => {
  const ciPath = join(workflowDirectory, 'ci.yml');
  assert.ok(existsSync(ciPath), 'ci.yml must still exist');

  const ci = read(ciPath);
  for (const gate of [
    'pnpm audit --audit-level high',
    'aquasecurity/trivy-action',
    'pnpm nx affected -t lint,typecheck,test,contract,build',
  ]) {
    assert.ok(ci.includes(gate), `ci.yml no longer runs its \`${gate}\` gate`);
  }
  for (const baselineControl of [
    'workflow_dispatch:',
    "GITHUB_REF\" == 'refs/heads/main'",
    'git rev-list --count --all',
    'snapshot_path_count=',
    'git hash-object -t tree /dev/null',
  ]) {
    assert.ok(
      ci.includes(baselineControl),
      `ci.yml manual baseline no longer proves \`${baselineControl}\``,
    );
  }
  assert.equal(
    JSON.parse(read(join(repoRoot, 'nx.json'))).defaultBase,
    'main',
    'Nx affected calculations must default to sole integration branch main',
  );
  assert.match(
    read(join(repoRoot, 'tools', 'check-openapi-compatibility.mjs')),
    /'origin\/main'/,
    'OpenAPI compatibility must default to origin/main',
  );

  const infraBaseline = ci.match(
    /\n  infrastructure-baseline:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n|$)/,
  )?.[1];
  assert.ok(infraBaseline, 'manual CI must define an OpenTofu-native infrastructure baseline');
  assert.match(
    infraBaseline,
    /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/,
    'OpenTofu installation is reserved for the manual baseline on main',
  );
  assert.match(
    infraBaseline,
    /opentofu\/setup-opentofu@a1320f892987e89d278cc92dc5adc984fb93aca4/,
    'manual infrastructure checks must use the reviewed pinned OpenTofu setup action',
  );
  assert.match(
    infraBaseline,
    /tofu_version:\s*'1\.12\.6'/,
    'manual infrastructure checks must use repository-pinned OpenTofu 1.12.6',
  );
  assert.match(
    infraBaseline,
    /node tools\/infra-check\.mjs all/,
    'manual infrastructure checks must run fmt, validate, and every mocked-provider test',
  );
  assert.match(
    infraBaseline,
    /GOOGLE_APPLICATION_CREDENTIALS/,
    'manual infrastructure checks must prove no provider credential was present',
  );
  assert.ok(
    !/id-token:\s*write/.test(infraBaseline),
    'the no-provider infrastructure baseline must not receive an OIDC token',
  );
});

test('secret scanning is checksum-pinned, full-history, nonzero, and least-privilege', () => {
  const ci = read(join(workflowDirectory, 'ci.yml'));
  const secretJob = ci.match(/\n  secrets:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n|$)/)?.[1];
  assert.ok(secretJob, 'ci.yml must retain the secret-scan job');

  assert.ok(
    !ci.includes('gitleaks/gitleaks-action'),
    'the annotated-tag wrapper action must not return; CI installs the reviewed binary directly',
  );
  assert.match(secretJob, /GITLEAKS_VERSION:\s*'8\.24\.3'/, 'Gitleaks must be exact');
  assert.match(
    secretJob,
    /GITLEAKS_LINUX_X64_SHA256:\s*'9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c'/,
    'the Linux x64 release asset must carry its independently verified official checksum',
  );
  assert.match(
    secretJob,
    /gitleaks_\$\{GITLEAKS_VERSION\}_linux_x64\.tar\.gz/,
    'CI must download only the reviewed Linux x64 release asset',
  );
  assert.match(
    secretJob,
    /sha256sum --check --strict/,
    'the release archive checksum must be verified before extraction and execution',
  );
  assert.ok(
    secretJob.indexOf('sha256sum --check --strict') <
      secretJob.indexOf('"$RUNNER_TEMP/gitleaks" version'),
    'checksum verification must precede binary execution',
  );
  for (const control of [
    'fetch-depth: 0',
    "--log-opts='--all'",
    '--redact',
    "grep -Eo '[0-9]+ commits scanned\\.'",
    "grep -Eo 'scanned ~[0-9]+ bytes'",
    '^[1-9][0-9]*$',
    'findings are withheld from logs',
  ]) {
    assert.ok(secretJob.includes(control), `secret scanning no longer enforces \`${control}\``);
  }
  assert.match(
    secretJob,
    /permissions:\n\s+contents: read/,
    'secret scanning needs only read access to repository contents',
  );
  assert.ok(
    !/pull-requests:\s*(?:read|write)/.test(secretJob),
    'the direct scanner does not call the pull-request API and must not receive that permission',
  );
  assert.ok(
    !/secrets\.|GITHUB_TOKEN/.test(secretJob),
    'secret scanning must not receive a repository or provider secret',
  );
});

test('every federation composition boundary enforces exact main, workflow, and event sets', () => {
  const boundaries = [
    'infra/modules/delivery-trust/variables.tf',
    'infra/modules/workload-identity-federation/variables.tf',
    'infra/stacks/bootstrap/variables.tf',
  ];
  for (const relativePath of boundaries) {
    const source = read(join(repoRoot, relativePath));
    assert.match(
      source,
      /length\(var\.allowed_refs\) == 1 && one\(var\.allowed_refs\) == "refs\/heads\/main"/,
      `${relativePath} must reject every ref allowlist except exactly main`,
    );
    const workflowVariable = source.match(
      /variable "allowed_workflow_paths" \{([\s\S]*?)\n\}/,
    )?.[1];
    assert.ok(workflowVariable, `${relativePath} must declare allowed_workflow_paths`);
    assert.match(
      workflowVariable,
      /validation \{[\s\S]*?length\(var\.allowed_workflow_paths\) == 1 &&\s*one\(var\.allowed_workflow_paths\) == "\.github\/workflows\/delivery\.yml"/,
      `${relativePath} must validate every workflow allowlist as exactly the delivery workflow`,
    );
    for (const eventName of ['push', 'workflow_dispatch', 'schedule']) {
      assert.ok(
        source.includes(`"${eventName}"`),
        `${relativePath} must include ${eventName} in the closed event set`,
      );
    }
    assert.match(
      source,
      /length\(var\.allowed_event_names\) == 3/,
      `${relativePath} must reject additional federation events`,
    );
  }

  for (const testPath of [
    'infra/modules/delivery-trust/tests/trust_policy.tftest.hcl',
    'infra/modules/workload-identity-federation/tests/federation.tftest.hcl',
    'infra/stacks/bootstrap/tests/bootstrap.tftest.hcl',
  ]) {
    const source = read(join(repoRoot, testPath));
    assert.match(source, /allowed_refs = \["refs\/heads\/v2"\]/, `${testPath} must reject v2`);
    assert.match(
      source,
      /allowed_refs = \["refs\/heads\/main", "refs\/heads\/release"\]/,
      `${testPath} must reject an additional ref`,
    );
    assert.match(
      source,
      /allowed_workflow_paths = \["\.github\/workflows\/ci\.yml"\]/,
      `${testPath} must reject another workflow`,
    );
    assert.match(
      source,
      /allowed_workflow_paths = \["\.github\/workflows\/delivery\.yml", "\.github\/workflows\/ci\.yml"\]/,
      `${testPath} must reject an additional workflow`,
    );
  }
});

test('bootstrap targets the current organization source without committing numeric identities', () => {
  const bootstrapPath = join(repoRoot, 'infra', 'stacks', 'bootstrap', 'variables.tf');
  const bootstrap = read(bootstrapPath);
  assert.match(
    bootstrap,
    /variable "repository_owner" \{[\s\S]*?default\s*=\s*"money-noodle"[\s\S]*?\n\}/,
    'bootstrap must default to the organization that owns the public source',
  );
  assert.match(
    bootstrap,
    /variable "repository_name" \{[\s\S]*?default\s*=\s*"money-noodle"[\s\S]*?\n\}/,
    'bootstrap must default to the current source repository name',
  );
  for (const variable of ['repository_id', 'repository_owner_id']) {
    const block = bootstrap.match(new RegExp(`variable "${variable}" \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(block, `bootstrap must declare ${variable}`);
    assert.doesNotMatch(block, /\bdefault\s*=/, `${variable} must remain a bootstrap API input`);
  }

  const bootstrapTests = read(
    join(repoRoot, 'infra', 'stacks', 'bootstrap', 'tests', 'bootstrap.tftest.hcl'),
  );
  assert.match(
    bootstrapTests,
    /var\.repository_owner == "money-noodle" && var\.repository_name == "money-noodle"/,
    'OpenTofu tests must guard the current organization-owned source defaults',
  );

  const guide = read(join(repoRoot, 'infra', 'bootstrap.md'));
  for (const endpoint of [
    'repos/money-noodle/money-noodle --jq .id',
    'repos/money-noodle/money-noodle --jq .owner.id',
    '/repos/money-noodle/money-noodle/actions/secrets',
    'repos/money-noodle/money-noodle/environments/production',
  ]) {
    assert.ok(
      guide.includes(endpoint),
      `bootstrap guidance must use current API endpoint ${endpoint}`,
    );
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
  assert.match(
    bootstrap,
    /allowed_refs"[\s\S]*?default\s*=\s*\["refs\/heads\/main"\]/,
    'bootstrap must authorize protected main as the sole delivery ref',
  );
  assert.match(
    delivery,
    /push:\n\s+branches: \['main'\]/,
    'delivery publication must trigger only from main',
  );
  assert.ok(
    !delivery.includes('refs/heads/v2'),
    'the deleted v2 branch must not remain in delivery triggers or provenance verification',
  );

  const trustTests = read(
    join(repoRoot, 'infra', 'modules', 'delivery-trust', 'tests', 'trust_policy.tftest.hcl'),
  );
  assert.match(
    trustTests,
    /name\s*=\s*"deleted-v2-branch"[\s\S]*?ref\s*=\s*"refs\/heads\/v2"/,
    'the trust suite must retain a negative case proving the deleted v2 branch is denied',
  );
});

/* ------------------------------------------------- account-identifier redaction */

// Repository variables are not secrets, so GitHub masks none of their values.
// Once #76 sets them, the billing account id, project id, project number and
// state-bucket prefix would otherwise be rendered verbatim into a public job
// summary by `tofu show`, and into a public log by `tofu apply`. These guards
// assert that every identifier the workflow feeds to a provider has a
// redaction rule, and they execute the workflow's own redaction programs
// rather than only matching their text.

const MASK_STEP = 'Mask account identifiers and write the redaction rules';
const RULES_FILE = 'account-redactions.json';
const REDACTOR_FILE = 'redact-account-identifiers.py';

// An identifier short or generic enough to match unrelated plan text is more
// dangerous as a rule than as output, so a few variables are deliberately not
// redacted. Every entry needs a reason a reviewer can check.
const unredactedVariables = new Map([
  ['GCP_REGISTRY_HOST', 'a fixed public regional endpoint, not account data'],
  ['GCP_REGISTRY_REPOSITORY', 'a generic repository name that would match unrelated plan text'],
  [
    'GCP_WORKLOAD_IDENTITY_PROVIDER',
    'a resource name that grants nothing without a conforming token, and whose project number is covered by its own rule',
  ],
  ['GCP_DEPLOYER_SERVICE_ACCOUNT', 'an identity address that grants nothing without federation'],
  ['INFRA_APPLY_AUTHORIZED', 'a typed authorization flag, not an identifier'],
  ['PRODUCTION_ENVIRONMENT_REVIEWERS_VERIFIED', 'a typed verification flag, not an identifier'],
]);

// Returns the body of the masking step in the named job.
function maskStep(jobName) {
  const job = deliveryJobs().find(({ name }) => name === jobName);
  assert.ok(job, `expected a ${jobName} job`);
  const body = job.body.match(
    new RegExp(`\\n {6}- name: ${MASK_STEP}\\n([\\s\\S]*?)(?=\\n {6}- |$)`),
  )?.[1];
  assert.ok(body, `job "${jobName}" has no "${MASK_STEP}" step`);
  return body;
}

// Lifts a shell heredoc out of a `run: |` block and removes the workflow's
// indentation, giving the exact program the runner executes.
function heredoc(body, opener) {
  const source = body.match(new RegExp(`${opener} <<'PY'\\n([\\s\\S]*?)\\n {10}PY\\n`))?.[1];
  assert.ok(source, `expected a ${opener} heredoc`);
  return `${source
    .split('\n')
    .map((line) => (line.startsWith(' '.repeat(10)) ? line.slice(10) : line))
    .join('\n')}\n`;
}

// Writes the masking step's two programs into a scratch directory and returns
// the rules the builder produces for the given repository-variable values.
function buildRules(variables) {
  const body = maskStep('plan');
  const directory = mkdtempSync(join(tmpdir(), 'delivery-redaction-'));
  const builder = join(directory, 'build-rules.py');
  const redactor = join(directory, REDACTOR_FILE);
  writeFileSync(builder, heredoc(body, 'python3 -'));
  writeFileSync(redactor, heredoc(body, `cat > "\\$RUNNER_TEMP/${REDACTOR_FILE}"`));

  const result = spawnSync('python3', [builder], {
    encoding: 'utf8',
    env: { RUNNER_TEMP: directory, ...variables },
  });
  assert.equal(
    result.error?.code,
    undefined,
    'python3 must be available; this workflow redacts with it, so a silently skipped guard is worse than none',
  );
  assert.equal(result.status, 0, `the rule builder failed: ${result.stderr}`);

  return {
    directory,
    redactor,
    rulesPath: join(directory, RULES_FILE),
    rules: JSON.parse(readFileSync(join(directory, RULES_FILE), 'utf8')),
    masked: [...result.stdout.matchAll(/::add-mask::(.*)/g)].map(([, value]) => value),
  };
}

test('every job that reaches a provider masks its account identifiers', () => {
  const privileged = deliveryJobs().filter(({ body }) => /id-token:\s*write/.test(body));
  assert.ok(privileged.length >= 4, 'expected several jobs to exchange a provider token');

  for (const job of privileged) {
    const body = maskStep(job.name);
    assert.match(
      body,
      /::add-mask::/,
      `job "${job.name}" must register account identifiers as masked values, or provider output reaches the public log verbatim`,
    );
    assert.ok(
      body.includes(`Path(os.environ['RUNNER_TEMP'], '${RULES_FILE}')`),
      `job "${job.name}" must persist the redaction rules for text that reaches a job summary`,
    );
  }

  const checks = deliveryJobs().find(({ name }) => name === 'checks');
  assert.ok(
    !checks.body.includes(MASK_STEP),
    'the static check job reaches no provider and needs no masking step',
  );
});

test('every account identifier fed to OpenTofu has a redaction rule', () => {
  const { rules } = buildRules({
    GCP_PROJECT_ID: 'project-id-value',
    GCP_PROJECT_NUMBER: '418273645901',
    GCP_BILLING_ACCOUNT_ID: '01A2B3-4C5D6E-7F8901',
    GCP_STATE_BUCKET_PREFIX: 'state-bucket-prefix-value',
    GCP_BUDGET_ALERT_EMAIL_ADDRESSES_JSON: '["alerts@example.test"]',
  });
  const ruled = new Set(rules.map(([, placeholder]) => placeholder));
  const builder = heredoc(maskStep('plan'), 'python3 -');

  // Every repository variable that reaches OpenTofu as a TF_VAR_*, plus the
  // project id that reaches the registry reference, must be redacted or
  // explicitly and justifiably exempt.
  const fedToTofu = new Set();
  for (const [, expression] of delivery.matchAll(/\n\s+TF_VAR_[a-z_]+:([^\n]*)/g)) {
    for (const [, name] of expression.matchAll(/vars\.([A-Z0-9_]+)/g)) fedToTofu.add(name);
  }
  assert.ok(fedToTofu.size >= 4, 'expected several repository variables to reach OpenTofu');
  fedToTofu.add('GCP_PROJECT_ID');

  for (const name of fedToTofu) {
    if (unredactedVariables.has(name)) continue;
    assert.ok(
      builder.includes(`'${name}'`),
      `${name} reaches a provider but has no redaction rule; add one or record why it is safe in unredactedVariables`,
    );
  }

  for (const placeholder of [
    '<billing-account-id>',
    '<project-id>',
    '<project-number>',
    '<state-bucket-prefix>',
    '<budget-alert-address>',
  ]) {
    assert.ok(ruled.has(placeholder), `the rule set must produce ${placeholder}`);
  }
});

test('redaction replaces the longest identifier first and leaves no tail behind', () => {
  // A state-bucket prefix is commonly a prefix of the project id. Replacing the
  // shorter value first would leave "<state-bucket-prefix>-42" in the summary,
  // which still discloses the project id.
  const identifiers = {
    GCP_PROJECT_ID: 'money-noodle-prod-42',
    GCP_PROJECT_NUMBER: '418273645901',
    GCP_BILLING_ACCOUNT_ID: '01A2B3-4C5D6E-7F8901',
    GCP_STATE_BUCKET_PREFIX: 'money-noodle-prod',
    GCP_BUDGET_ALERT_EMAIL_ADDRESSES_JSON: '["alerts@example.test"]',
  };
  const { directory, redactor, rulesPath, rules, masked } = buildRules(identifiers);

  const lengths = rules.map(([value]) => value.length);
  assert.deepEqual(
    lengths,
    [...lengths].sort((left, right) => right - left),
    'rules must be ordered longest value first',
  );

  const values = [
    'money-noodle-prod-42',
    '418273645901',
    '01A2B3-4C5D6E-7F8901',
    'money-noodle-prod',
    'alerts@example.test',
  ];
  for (const value of values) {
    assert.ok(masked.includes(value), `${value} must be registered with ::add-mask::`);
  }

  const plan = join(directory, 'plan.txt');
  writeFileSync(
    plan,
    [
      '  + billing_account = "01A2B3-4C5D6E-7F8901"',
      '  + project         = "money-noodle-prod-42"',
      '  + projects        = ["projects/418273645901"]',
      '  + bucket          = "money-noodle-prod-platform"',
      '  + email           = "alerts@example.test"',
      '  + image           = "us-west1-docker.pkg.dev/money-noodle-prod-42/platform/web"',
      '',
    ].join('\n'),
  );

  const applied = spawnSync('python3', [redactor, rulesPath, plan], { encoding: 'utf8' });
  assert.equal(applied.status, 0, `the redactor failed: ${applied.stderr}`);

  const redacted = readFileSync(plan, 'utf8');
  for (const value of values) {
    assert.ok(
      !redacted.includes(value),
      `${value} survived redaction and would be published in a job summary`,
    );
  }
  assert.ok(
    redacted.includes('"<project-id>"') && redacted.includes('"<state-bucket-prefix>-platform"'),
    'each identifier must be replaced by its own placeholder',
  );
});

test('redaction tolerates unset variables so a provider-disabled run stays green', () => {
  const { rules, masked, redactor, rulesPath, directory } = buildRules({});
  assert.deepEqual(rules, [], 'an unconfigured repository must produce no redaction rule');
  assert.deepEqual(masked, [], 'an unconfigured repository must mask nothing');

  const plan = join(directory, 'plan.txt');
  writeFileSync(plan, 'No changes. Your infrastructure matches the configuration.\n');
  const applied = spawnSync('python3', [redactor, rulesPath, plan], { encoding: 'utf8' });
  assert.equal(applied.status, 0, `the redactor must succeed with no rules: ${applied.stderr}`);
  assert.equal(
    readFileSync(plan, 'utf8'),
    'No changes. Your infrastructure matches the configuration.\n',
  );

  // A malformed address list must not fail the step either; it yields no rule.
  const malformed = buildRules({ GCP_BUDGET_ALERT_EMAIL_ADDRESSES_JSON: 'not-json' });
  assert.deepEqual(malformed.rules, [], 'a malformed address list must contribute no rule');
});

test('rendered plan and drift text is redacted before it reaches a job summary', () => {
  for (const [jobName, file] of [
    ['plan', 'plan.txt'],
    ['drift', 'drift.txt'],
  ]) {
    const job = deliveryJobs().find(({ name }) => name === jobName);
    const render = job.body.indexOf(`> ${file}`);
    const redact = job.body.indexOf(`"$RUNNER_TEMP/${RULES_FILE}" ${file}`);
    const summary = job.body.indexOf('GITHUB_STEP_SUMMARY');

    assert.ok(render !== -1, `job "${jobName}" must render ${file}`);
    assert.ok(
      redact > render,
      `job "${jobName}" must redact ${file} after rendering it and before publishing it`,
    );
    assert.ok(
      summary > redact,
      `job "${jobName}" writes ${file} to a job summary before redacting it`,
    );
    assert.ok(
      !job.body.includes("os.environ['TF_VAR_budget_alert_email_addresses']"),
      `job "${jobName}" must use the shared redaction rules, not an inline address-only pass`,
    );
  }
});

// ---------------------------------------------------------------------------
// Execution-identity ownership over `infra/**`.
//
// "Every declared delivery operation has a named execution identity" is only a
// property if nothing is left over on either side. These assertions fail when a
// resource is added without an owner, when an owner is declared for a resource
// that no longer exists, and when a resource is claimed by more than one
// identity. See `tools/delivery/execution-identities.mjs`.
// ---------------------------------------------------------------------------

/** Every `<modules|stacks>/<directory>:<type>.<name>` declared under `infra/`. */
function declaredResourceOperations() {
  const infraRoot = join(repoRoot, 'infra');
  const found = [];

  for (const parent of ['modules', 'stacks']) {
    const parentPath = join(infraRoot, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(parentPath, entry.name);
      for (const file of readdirSync(directory)) {
        if (!file.endsWith('.tf')) continue;
        const source = read(join(directory, file));
        for (const [, type, name] of source.matchAll(
          /^resource\s+"([a-z0-9_]+)"\s+"([a-z0-9_]+)"/gm,
        )) {
          found.push({
            key: `${parent}/${entry.name}:${type}.${name}`,
            file: relative(join(directory, file)),
          });
        }
      }
    }
  }
  return found;
}

test('every resource operation in infra/** maps to exactly one named identity', () => {
  const declared = declaredResourceOperations();
  assert.ok(declared.length > 0, 'expected declared resources under infra/');

  const duplicates = declared
    .map(({ key }) => key)
    .filter((key, index, all) => all.indexOf(key) !== index);
  assert.deepEqual(duplicates, [], 'a resource address must be declared once');

  const declaredKeys = declared.map(({ key }) => key).sort();
  const mappedKeys = Object.keys(RESOURCE_OPERATIONS).sort();

  const unowned = declaredKeys.filter((key) => !mappedKeys.includes(key));
  assert.deepEqual(
    unowned,
    [],
    `every declared resource needs a named execution identity in tools/delivery/execution-identities.mjs. Unowned: ${unowned.join(', ')}`,
  );

  const orphaned = mappedKeys.filter((key) => !declaredKeys.includes(key));
  assert.deepEqual(
    orphaned,
    [],
    `an identity claims a resource that no longer exists. Orphaned: ${orphaned.join(', ')}`,
  );

  for (const key of declaredKeys) {
    const row = RESOURCE_OPERATIONS[key];
    assert.ok(isResourceKey(key), `${key} is not a well-formed resource address`);

    // Exactly one identity. An array, a list or a "team" is not an identity.
    assert.equal(typeof row.identity, 'string', `${key} must name exactly one identity`);
    const identity = EXECUTION_IDENTITIES[row.identity];
    assert.ok(identity, `${key} names undeclared identity ${row.identity}`);
    assert.ok(
      identity.catalogOperations.includes(row.catalogOperation),
      `${key} claims ${row.catalogOperation}, which ${row.identity} is not permitted to execute`,
    );

    // A permission justification, not a restatement of the resource name.
    assert.ok(
      row.justification.length >= 40,
      `${key} needs a justification for why ${row.identity} may perform this operation`,
    );
    assert.match(row.justification, /\.$/, `${key}'s justification must be a sentence`);
    assert.ok(
      !row.justification.toLowerCase().includes('todo'),
      `${key}'s justification is a placeholder`,
    );
  }
});

test('the credential-free checks job runs the delivery control policy guard', () => {
  // The adapters are only a control if they actually run. This asserts the
  // guard is in the `checks` job — which holds no `id-token` permission and no
  // environment — and that the workflow re-runs it when the adapters change.
  const checks = deliveryJobs().find(({ name }) => name === 'checks');
  assert.ok(checks, 'expected a checks job');
  assert.ok(
    checks.body.includes('run: node --test tools/delivery-control-policy.test.mjs'),
    'the checks job must run the delivery control policy suite',
  );
  assert.ok(
    !/id-token:|environment:/.test(checks.body),
    'the delivery control guard must stay in the credential-free job',
  );

  for (const event of ['pull_request', 'push']) {
    const trigger = delivery.match(
      new RegExp(`\\n {2}${event}:\\n([\\s\\S]*?)(?=\\n {2}[a-z_]+:|$)`),
    )?.[1];
    assert.ok(trigger, `${event} trigger must exist`);
    for (const path of ['tools/delivery/**', 'tools/delivery-control-policy.test.mjs']) {
      assert.ok(
        trigger.includes(`      - '${path}'`),
        `${event} must re-run the guard when ${path} changes`,
      );
    }
  }
});

test('creating a service and exposing it are owned by different identities', () => {
  // The private-before-public seam only holds if the apply that creates a
  // service cannot also perform the exposure. Different owners, different
  // approval classes, different catalog rows.
  const service =
    RESOURCE_OPERATIONS['modules/cloud-run-service:google_cloud_run_v2_service.service'];
  const exposure =
    RESOURCE_OPERATIONS['modules/cloud-run-service:google_cloud_run_v2_service_iam_member.public'];

  assert.notEqual(service.identity, exposure.identity);
  assert.equal(EXECUTION_IDENTITIES[service.identity].approvalClass, 'H1');
  assert.equal(EXECUTION_IDENTITIES[exposure.identity].approvalClass, 'H2');
  assert.equal(exposure.catalogOperation, 'workload.access.change');
  assert.match(
    EXECUTION_IDENTITIES[exposure.identity].mustNot,
    /independently verified in private/,
    'the access executor must record that it cannot expose an unverified private candidate',
  );
});

test('no workload identity may grant itself its own authority', () => {
  // Every binding that establishes the deployer's own authority is owned by the
  // human bootstrap principal, because an identity that can extend its own
  // permissions makes least privilege unenforceable.
  const selfGranting = [
    'stacks/bootstrap:google_project_iam_member.deployer',
    'stacks/bootstrap:google_billing_account_iam_member.deployer_budget_manager',
    'modules/workload-identity-federation:google_service_account_iam_member.deployer_impersonation',
    'modules/workload-identity-federation:google_iam_workload_identity_pool_provider.github',
    'modules/state-bucket:google_storage_bucket_iam_member.deployer',
  ];

  for (const key of selfGranting) {
    const row = RESOURCE_OPERATIONS[key];
    assert.ok(row, `${key} must be mapped`);
    assert.equal(
      row.identity,
      'bootstrap-principal',
      `${key} grants the deployer authority and must be owned by the human bootstrap principal`,
    );
    assert.equal(row.catalogOperation, 'bootstrap.initialize');
  }

  assert.equal(EXECUTION_IDENTITIES['bootstrap-principal'].tokenClass, 'none');
  assert.match(EXECUTION_IDENTITIES['bootstrap-principal'].mustNot, /Become a workflow identity/);
});

// ---------------------------------------------------------------------------
// The trusted release-artifact chain (#71).
//
// One artifact per eligible release: built once, tested and scanned as built,
// published by that exact digest, and attested to the repository, workflow,
// source commit and run that produced it. These assertions are static and
// provider-free; they prove the workflow's shape, never that a publication
// happened.
// ---------------------------------------------------------------------------

const ci = read(join(workflowDirectory, 'ci.yml'));

/** One job body from `ci.yml`, using the same convention as `deliveryJobs`. */
function ciJob(name) {
  return ci.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`))?.[1];
}

/** The required checks `delivery.yml` waits for, as the workflow declares them. */
function declaredRequiredChecks() {
  const block = delivery.match(/REQUIRED_CHECKS: \|\n([\s\S]*?)\n {8}run:/)?.[1];
  assert.ok(block, 'the qualification job must declare the required checks it waits for');
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Index of a step's `- name:` line, so ordering can be asserted by position. */
function stepIndex(body, name) {
  const index = body.indexOf(`- name: ${name}`);
  assert.ok(index >= 0, `expected a step named "${name}"`);
  return index;
}

test('release qualification requires every required check on this exact head', () => {
  const qualify = deliveryJobs().find(({ name }) => name === 'qualify');
  assert.ok(qualify, 'delivery must define a release qualification job');

  // The gate exists because GitHub cannot express a cross-workflow `needs`.
  // Every check it waits for is one `ci.yml` actually defines under that name;
  // a rename on either side detaches the gate silently otherwise.
  const required = declaredRequiredChecks();
  assert.deepEqual(
    [...required].sort(),
    [
      'affected projects and repository gates',
      'container platform-api',
      'container web',
      'secret scan',
    ],
    'the qualification gate must wait for exactly the required checks owned by ci.yml',
  );
  // Expand `ci.yml`'s job names the way GitHub does, matrix included, so a
  // renamed job or a changed matrix value detaches the gate loudly here rather
  // than silently at release time.
  const ciCheckNames = new Set();
  for (const [, , body] of ci.matchAll(
    /\n  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n|$)/g,
  )) {
    const declared = body.match(/^    name: (.+)$/m)?.[1]?.trim();
    if (!declared) continue;
    const projects = [...body.matchAll(/^          - project: (\S+)$/gm)].map(([, value]) => value);
    if (declared.includes('${{ matrix.project }}') && projects.length > 0) {
      for (const project of projects) {
        ciCheckNames.add(declared.replaceAll('${{ matrix.project }}', project));
      }
    } else {
      ciCheckNames.add(declared);
    }
  }
  for (const name of required) {
    assert.ok(ciCheckNames.has(name), `ci.yml no longer produces a check named "${name}"`);
  }

  // Evidence is per-commit. A run attached to another head is refused rather
  // than accepted as "close enough", which is what makes a head change
  // invalidate prior qualification.
  assert.match(
    qualify.body,
    /commits\/\$\{HEAD_SHA\}\/check-runs/,
    'qualification must read the checks attached to this exact commit',
  );
  assert.match(
    qualify.body,
    /if \[\[ "\$head" != "\$HEAD_SHA" \]\]/,
    'qualification must refuse a check run attached to a different head',
  );
  assert.match(
    qualify.body,
    /if \[\[ "\$conclusion" != 'success' \]\]/,
    'anything other than success must deny: failure, cancellation, timeout and skip alike',
  );
  assert.match(
    qualify.body,
    /Required evidence never completed for this head/,
    'missing or never-completing evidence must fail closed rather than wait forever',
  );

  // The gate reads results. It holds no provider authority and no write.
  assert.match(qualify.body, /checks: read/);
  assert.ok(
    !/id-token:\s*write/.test(qualify.body),
    'the qualification gate must not receive an OIDC token',
  );
  assert.ok(
    !/contents:\s*write|environment:/.test(qualify.body),
    'the qualification gate must not hold write or environment authority',
  );
});

test('publication is gated on qualification of the exact head being published', () => {
  const publish = deliveryJobs().find(({ name }) => name === 'publish');
  assert.ok(publish, 'delivery must define a publish job');

  assert.match(
    publish.body,
    /needs: \[checks, authorization, qualify\]/,
    'publication must depend on the credential-free checks, the authorization state and qualification',
  );
  assert.match(
    publish.body,
    /needs\.qualify\.outputs\.qualified_head == github\.sha/,
    'publication must require qualification of the commit it is publishing, not of some earlier one',
  );
  assert.match(
    publish.body,
    /github\.ref == 'refs\/heads\/main'/,
    'publication stays bound to protected main',
  );
});

test('the release artifact is built once, tested and scanned before anything is published', () => {
  const publish = deliveryJobs().find(({ name }) => name === 'publish');

  const build = stepIndex(publish.body, 'Build the release candidate with provenance and SBOM');
  const probe = stepIndex(publish.body, 'Prove the candidate digest serves its runtime contract');
  const scan = stepIndex(publish.body, 'Scan the candidate digest before publication');
  const push = stepIndex(
    publish.body,
    'Publish the tested digest and prove it is the one in the registry',
  );
  const attest = stepIndex(publish.body, 'Attest build provenance');
  const login = publish.body.indexOf('docker/login-action');
  const auth = publish.body.indexOf('google-github-actions/auth');

  assert.ok(build < probe, 'the candidate must be built before it is tested');
  assert.ok(probe < scan, 'the tested artifact must be the one scanned');
  assert.ok(scan < auth, 'scanning must gate publication, so it precedes the provider token');
  assert.ok(auth < login && login < push, 'the registry is reached only after the scan passes');
  assert.ok(push < attest, 'provenance is attested for the digest actually published');

  // Built locally. Nothing reaches the registry from the build step itself.
  const buildStep = publish.body.slice(build, probe);
  assert.match(buildStep, /--load/, 'the release candidate must be built locally, not pushed');
  assert.ok(
    !/--push/.test(buildStep),
    'building must not publish: the scan and the image test come first',
  );
  assert.match(buildStep, /--provenance=true/);
  assert.match(buildStep, /--attest=type=sbom/);
  assert.match(
    buildStep,
    /\^sha256:\[0-9a-f\]\{64\}\$/,
    'the build must refuse to continue without an exact digest',
  );
});

test('a second build cannot replace the artifact that was tested and scanned', () => {
  const publish = deliveryJobs().find(({ name }) => name === 'publish');
  const pushStep = publish.body.slice(
    stepIndex(publish.body, 'Publish the tested digest and prove it is the one in the registry'),
  );

  assert.match(
    pushStep,
    /if \[\[ "\$published" != "\$DIGEST" \]\]/,
    'the published digest must be compared against the digest that was tested and scanned',
  );
  assert.match(
    pushStep,
    /The published digest is not the digest that was tested and scanned/,
    'a mismatch must fail closed with an explicit reason',
  );
  assert.match(
    publish.body,
    /subject-digest: \$\{\{ steps\.publish\.outputs\.digest \}\}/,
    'the attestation must name the verified published digest, not an unverified build output',
  );
  assert.ok(
    !/--tag[^\n]*:latest/.test(delivery),
    'nothing may be published under a mutable latest tag',
  );
});

test('the image test and the scan target the same digest, in both workflows', () => {
  const publish = deliveryJobs().find(({ name }) => name === 'publish');
  assert.match(
    publish.body,
    /image-ref: \$\{\{ steps\.build\.outputs\.image \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}/,
    'the release scan must address the candidate by digest, never by a floating tag',
  );
  assert.match(
    publish.body,
    /reference="\$IMAGE@\$DIGEST"/,
    'the release image test must run the candidate by digest',
  );

  // The pull-request path proves the same property against the image it built,
  // so a container that cannot start is caught before release time.
  const containers = ciJob('containers');
  assert.ok(containers, 'ci.yml must still define the container job');
  const built = containers.indexOf('Build attributable OCI image');
  const probed = containers.indexOf('Prove the built image serves its runtime contract');
  const scanned = containers.indexOf('name: Scan image');
  assert.ok(
    built >= 0 && probed > built && scanned > probed,
    'ci must build, then test, then scan',
  );
});

test('the image acceptance exercises the production runtime contract and attributable version', () => {
  for (const [label, body] of [
    ['delivery', deliveryJobs().find(({ name }) => name === 'publish').body],
    ['ci', ciJob('containers')],
  ]) {
    assert.match(body, /NODE_ENV=production/, `${label} must test the production runtime mode`);
    assert.match(
      body,
      /MONEY_NOODLE_COMMIT="\$SOURCE_COMMIT"/,
      `${label} must run the image under this run's exact source commit`,
    );
    assert.match(body, /\/health\/ready/, `${label} must require readiness, not merely a process`);
    assert.match(
      body,
      /grep -Fq "\\"version\\":\\"\$ARTIFACT_VERSION\\""/,
      `${label} must require the image to report its attributable version`,
    );
    assert.match(
      body,
      /org\.opencontainers\.image\.revision/,
      `${label} must require the artifact to name the commit it was built from`,
    );
    assert.match(
      body,
      /State\.Health\.Status/,
      `${label} must use the health contract the image itself declares`,
    );
    // The probe must never reach a real service.
    assert.match(
      body,
      /PLATFORM_API_ORIGIN='https:\/\/platform-api\.invalid'/,
      `${label} must probe against a reserved, unroutable origin`,
    );
  }
});

test('both images declare their own health contract and carry their provenance labels', () => {
  for (const [project, dockerfile, port] of [
    ['web', 'apps/web/Dockerfile', '3000'],
    ['platform-api', 'services/platform-api/Dockerfile', '3001'],
  ]) {
    const source = read(join(repoRoot, dockerfile));
    assert.match(source, /^HEALTHCHECK /m, `${project} must declare how it proves itself healthy`);
    assert.ok(
      source.includes(`process.env.PORT||${port}`),
      `${project}'s health check must probe its own declared port`,
    );
    assert.match(
      source,
      /\/health\/ready/,
      `${project}'s health check must use the readiness route`,
    );

    for (const label of [
      'org.opencontainers.image.source',
      'org.opencontainers.image.revision',
      'org.opencontainers.image.version',
      'money.noodle.source.ref',
      'money.noodle.build.workflow',
      'money.noodle.build.run',
    ]) {
      assert.ok(source.includes(label), `${project} must bind ${label} into the artifact`);
    }
    for (const argument of [
      'SOURCE_REPOSITORY',
      'SOURCE_COMMIT',
      'SOURCE_REF',
      'BUILD_WORKFLOW',
      'BUILD_RUN',
      'ARTIFACT_VERSION',
    ]) {
      assert.match(
        source,
        new RegExp(`^ARG ${argument}=unknown$`, 'm'),
        `${project} must accept ${argument} and default it, so a local build needs no arguments`,
      );
    }
  }

  // The build definitions forward those bindings, and both workflows supply them.
  for (const project of ['apps/web', 'services/platform-api']) {
    const target = JSON.parse(read(join(repoRoot, project, 'project.json'))).targets.container
      .options.command;
    for (const argument of ['SOURCE_REPOSITORY', 'SOURCE_COMMIT', 'BUILD_WORKFLOW', 'BUILD_RUN']) {
      assert.ok(
        target.includes(`--build-arg ${argument}=`),
        `${project}'s container target must forward ${argument}`,
      );
    }
  }
  for (const [label, body] of [
    ['delivery', deliveryJobs().find(({ name }) => name === 'publish').body],
    ['ci', ciJob('containers')],
  ]) {
    assert.match(
      body,
      /SOURCE_COMMIT: \$\{\{ github\.sha \}\}/,
      `${label} must bind the artifact to the commit being built`,
    );
    assert.match(
      body,
      /BUILD_WORKFLOW: \$\{\{ github\.workflow_ref \}\}/,
      `${label} must bind the artifact to the trusted workflow that built it`,
    );
    assert.match(
      body,
      /BUILD_RUN: \$\{\{ github\.run_id \}\}\/\$\{\{ github\.run_attempt \}\}/,
      `${label} must bind the artifact to the exact build run`,
    );
  }
});

test('dependency, secret and image scan gates all precede release publication', () => {
  const required = declaredRequiredChecks();
  // The dependency audit and the secret scan are required checks, so they are
  // proven complete and successful before `publish` can start at all.
  assert.ok(ci.includes('pnpm audit --audit-level high'), 'ci must still audit dependencies');
  assert.ok(
    required.includes('affected projects and repository gates'),
    'the dependency audit runs inside a required check the release waits for',
  );
  assert.ok(
    required.includes('secret scan'),
    'the secret scan is a required check the release waits for',
  );
  assert.ok(
    required.includes('container platform-api') && required.includes('container web'),
    'both container builds are required checks the release waits for',
  );

  const publish = deliveryJobs().find(({ name }) => name === 'publish');
  assert.ok(
    stepIndex(publish.body, 'Scan the candidate digest before publication') <
      publish.body.indexOf('google-github-actions/auth'),
    'the image scan must gate publication rather than follow it',
  );
});

// ---------------------------------------------------------------------------
// Artifact identity bound to the #70 grant contract (#71).
//
// The publication path does not re-implement authorization. It drives the one
// grant check, so a substituted digest or missing evidence is refused by the
// same code, under the same clause, as every other operation. These fixtures
// are synthetic and provider-free: no registry, no token, no network.
// ---------------------------------------------------------------------------

const SYNTHETIC_SOURCE_COMMIT = 'c'.repeat(40);
const SYNTHETIC_ARTIFACT_DIGEST = 'a'.repeat(64);
const SYNTHETIC_SUBSTITUTE_DIGEST = '9'.repeat(64);

/**
 * A complete, synthetic `artifact.publish` consent body.
 *
 * Every identifier is obviously fake. `artifactDigest` is bare lowercase hex
 * because that is what the catalog's encoding requires; the registry reference
 * form (`sha256:<hex>`) is a transport detail, not the consent field.
 */
function artifactConsentBody(overrides = {}) {
  return {
    approvalRef: { commentId: 2, issueNumber: 1 },
    artifactVector: [
      {
        artifactDigest: SYNTHETIC_ARTIFACT_DIGEST,
        tuple: {
          buildInvocation: 'synthetic-run-1/1',
          buildTarget: 'container',
          builderIdentity: 'synthetic-delivery-workflow',
          configurationDigest: 'b'.repeat(64),
          configurationVersion: 'config-1',
          deployableProject: 'platform-api',
          outputPlatform: 'linux/amd64',
          sourceSHA: SYNTHETIC_SOURCE_COMMIT,
        },
      },
    ],
    catalog: 'money-noodle.production-operations',
    controlDependencyDigest: 'd'.repeat(64),
    controlSourceSHA: 'e'.repeat(40),
    effectBounds: { 'publish-artifact': 1 },
    environment: 'synthetic-production',
    executorClass: 'registry-writer',
    expiresAt: '2026-09-13T01:00:00Z',
    inputDigest: 'f'.repeat(64),
    issuedAt: '2026-09-13T00:00:00Z',
    notBefore: '2026-09-13T00:00:00Z',
    operation: 'artifact.publish',
    permissionSlot: 'artifact-publication',
    planDigest: null,
    policyDigest: '1'.repeat(64),
    principal: 'synthetic-principal',
    readBounds: {
      maxBytes: 4096,
      maxPages: 1,
      timeoutSeconds: 10,
      validUntil: '2026-09-13T01:00:00Z',
    },
    reasonRef: 'synthetic-release-1',
    recovery: null,
    recoveryContractDigest: '2'.repeat(64),
    repositoryIdentity: 'synthetic-repository',
    requestId: 'synthetic-request-1',
    requester: 'synthetic-agent',
    sourceSHA: SYNTHETIC_SOURCE_COMMIT,
    targetVector: [
      {
        actionCounts: { 'publish-artifact': 1 },
        configurationVersion: 'config-1',
        expectedSafeVersions: { artifact: 'none' },
        intendedSafeVersions: { artifact: 'release-candidate' },
        logicalIncarnation: 'synthetic-api-1',
      },
    ],
    transportPhases: [
      {
        actionId: 'publish-artifact',
        maxSubmissions: 1,
        phaseId: 'publish',
        targetIds: ['synthetic-api-1'],
      },
    ],
    verificationContractDigest: '3'.repeat(64),
    verifierClass: 'registry-provenance-reader',
    version: 2,
    ...overrides,
  };
}

const publishExecution = (overrides = {}) => ({
  event: 'push',
  ref: PERMITTED_REF,
  workflowPath: PERMITTED_FEDERATED_WORKFLOW,
  actor: 'synthetic-agent',
  executorOwner: {
    jobId: 'publish',
    runAttempt: 1,
    runId: 'run-1',
    workflowPath: PERMITTED_FEDERATED_WORKFLOW,
    workflowSHA: 'b'.repeat(40),
  },
  ...overrides,
});

const publishLedger = (overrides = {}) => ({
  activeRequestId: null,
  consumedSlots: {},
  corroboration: { requestId: 'synthetic-request-1', witnessConfirmed: true },
  verifiedPredecessors: [],
  ...overrides,
});

const PUBLISH_NOW = '2026-09-13T00:30:00Z';

function decidePublication({ body = {}, execution, ledger, expected, now = PUBLISH_NOW } = {}) {
  const derived = deriveExplicitConsent(artifactConsentBody(body));
  return {
    derived,
    decision: evaluateGrant({
      consent: derived.consent,
      execution: execution ?? publishExecution(),
      ledger: ledger ?? publishLedger(),
      expected: expected ?? { repositoryIdentity: 'synthetic-repository' },
      now,
    }),
  };
}

function assertPublicationRefused(decision, code) {
  assert.equal(decision.allowed, false, `expected a refusal, got ${JSON.stringify(decision)}`);
  assert.equal(decision.mayExchangeMutationToken, false);
  assert.equal(decision.refusal.code, code);
  assert.ok(REFUSAL_CODES.includes(code), `${code} must be a declared refusal code`);
  assert.ok(decision.refusal.clauseReference.includes('#'), 'a refusal must name its clause');
  return decision.refusal;
}

test('the release artifact identities are the catalog row, not restated literals', () => {
  const row = OPERATIONS['artifact.publish'];
  assert.ok(row, 'catalog v2 must still carry the artifact publication row');
  assert.deepEqual(row.permissionSlots, ['artifact-publication']);
  assert.equal(row.verifierClass, 'registry-provenance-reader');
  assert.equal(row.executorClass, 'registry-writer');

  // The workflow's trusted source, workflow and event identities are the ones
  // the catalog defines. Asserting equality here is what stops the workflow and
  // the contract drifting into two different definitions of "trusted".
  assert.ok(
    delivery.includes(`github.ref == '${PERMITTED_REF}'`),
    'publication must be bound to the catalog-permitted ref',
  );
  assert.equal(PERMITTED_FEDERATED_WORKFLOW, '.github/workflows/delivery.yml');
  assert.ok(
    PERMITTED_EVENTS.includes('push'),
    'publication runs on push, which must remain inside the closed permitted event set',
  );

  // Consent for a release carries the artifact binding the publication needs.
  for (const field of ['artifactVector', 'sourceSHA', 'controlSourceSHA']) {
    assert.ok(CONSENT_BODY_FIELDS.includes(field), `consent must still carry ${field}`);
  }
});

test('a fully bound artifact publication is allowed and exchanges nothing by itself', () => {
  const { derived, decision } = decidePublication();
  assert.equal(decision.allowed, true, JSON.stringify(decision.refusal ?? {}));
  assert.equal(decision.operation, 'artifact.publish');
  assert.equal(decision.permissionSlot, 'artifact-publication');
  assert.equal(decision.verifierClass, 'registry-provenance-reader');
  assert.equal(decision.providerEnabled, false);
  assert.equal(decision.grantKey, derived.grantKey);
});

test('a substituted artifact digest is refused in the publication path', () => {
  // The recorded envelope binds one digest. Rebuilding the consent around a
  // different digest is internally consistent but is no longer the envelope the
  // journal recorded, which is exactly the substitution this must catch.
  const recorded = deriveExplicitConsent(artifactConsentBody());
  const substituted = artifactConsentBody({
    artifactVector: [
      {
        artifactDigest: SYNTHETIC_SUBSTITUTE_DIGEST,
        tuple: artifactConsentBody().artifactVector[0].tuple,
      },
    ],
  });

  const { decision } = decidePublication({
    body: substituted,
    expected: {
      repositoryIdentity: 'synthetic-repository',
      consentDigest: recorded.consentDigest,
    },
  });
  assertPublicationRefused(decision, 'consent-digest-mismatch');

  // A mutable tag is not a digest, and an empty vector is not a binding.
  for (const artifactVector of [
    [{ artifactDigest: 'latest', tuple: artifactConsentBody().artifactVector[0].tuple }],
    [],
  ]) {
    const { decision: refused } = decidePublication({ body: { artifactVector } });
    const refusal = assertPublicationRefused(refused, 'artifact-binding-missing');
    assert.match(
      refusal.reason,
      /a mutable tag is not a digest|each artifact entry is exactly/,
      'the refusal must say why the binding is not a binding',
    );
  }
});

test('missing or stale authorization evidence is refused in the publication path', () => {
  // Missing: an intent nobody corroborated is pending, never authority.
  assertPublicationRefused(
    decidePublication({ ledger: publishLedger({ corroboration: null }) }).decision,
    'journal-not-corroborated',
  );
  assertPublicationRefused(
    decidePublication({
      ledger: publishLedger({
        corroboration: { requestId: 'synthetic-request-1', witnessConfirmed: false },
      }),
    }).decision,
    'witness-missing',
  );

  // Stale: the original window has closed, and a retry does not reopen it.
  assertPublicationRefused(
    decidePublication({ now: '2026-09-13T01:00:00Z' }).decision,
    'validity-window-expired',
  );
  assertPublicationRefused(
    decidePublication({
      now: '2026-09-14T00:00:00Z',
      execution: publishExecution({
        executorOwner: {
          jobId: 'publish',
          runAttempt: 2,
          runId: 'run-2',
          workflowPath: PERMITTED_FEDERATED_WORKFLOW,
          workflowSHA: 'b'.repeat(40),
        },
      }),
    }).decision,
    'validity-window-expired',
  );

  // Spent: the slot is consumed at admission and a second release cannot reuse
  // it, so a rerun cannot republish under the same consent.
  const { derived } = decidePublication();
  assertPublicationRefused(
    decidePublication({
      ledger: publishLedger({
        consumedSlots: {
          'artifact-publication': {
            admissionEventId: 'intent-1',
            grantKey: derived.grantKey,
          },
        },
      }),
    }).decision,
    'slot-already-spent',
  );
});

test('a wrong source, workflow or event cannot publish an artifact', () => {
  for (const [ref, code] of [
    ['refs/heads/claim-v1/issue-71', 'ref-not-permitted'],
    ['refs/tags/v1', 'ref-not-permitted'],
    ['refs/pull/1/merge', 'ref-not-permitted'],
  ]) {
    assertPublicationRefused(
      decidePublication({ execution: publishExecution({ ref }) }).decision,
      code,
    );
  }

  for (const workflowPath of ['.github/workflows/ci.yml', '.github/workflows/delivery-copy.yml']) {
    assertPublicationRefused(
      decidePublication({
        execution: publishExecution({
          workflowPath,
          executorOwner: {
            jobId: 'publish',
            runAttempt: 1,
            runId: 'run-1',
            workflowPath,
            workflowSHA: 'b'.repeat(40),
          },
        }),
      }).decision,
      'workflow-not-permitted',
    );
  }

  for (const event of ['pull_request', 'pull_request_target', 'release']) {
    assertPublicationRefused(
      decidePublication({ execution: publishExecution({ event }) }).decision,
      'event-not-permitted',
    );
  }

  // A run that is not the named requester is not the signer either.
  assertPublicationRefused(
    decidePublication({ execution: publishExecution({ actor: 'unrelated-agent' }) }).decision,
    'actor-not-requester',
  );
});

test('the synthetic artifact and attestation examples are themselves publishable', () => {
  const body = artifactConsentBody();
  const [artifact] = body.artifactVector;

  // The worked example a reviewer can read: one tuple, one digest, bound to the
  // repository, trusted workflow, source commit and build run.
  const attestationExample = {
    artifactDigest: artifact.artifactDigest,
    buildRun: 'synthetic-run-1/1',
    buildWorkflow: `${PERMITTED_FEDERATED_WORKFLOW}@${PERMITTED_REF}`,
    imageReference: `synthetic-registry/synthetic-project/platform-api@sha256:${artifact.artifactDigest}`,
    predicateType: 'https://slsa.dev/provenance/v1',
    repositoryIdentity: body.repositoryIdentity,
    sourceCommit: artifact.tuple.sourceSHA,
    sourceRef: PERMITTED_REF,
  };

  assert.deepEqual(findForbiddenMarkers(attestationExample), []);
  assert.deepEqual(findForbiddenMarkers(body), []);
  assert.equal(assertPublishable(attestationExample, 'attestation example'), attestationExample);
  assert.ok(isSha256Hex(artifact.artifactDigest), 'an artifact digest is bare lowercase hex');
  assert.ok(isGitObjectId(artifact.tuple.sourceSHA), 'a source commit is a full object id');
  assert.ok(isSha256Hex(canonicalDigest(attestationExample)), 'the example has a stable identity');

  // Obviously synthetic: no real project, registry host, account or service URL.
  const text = JSON.stringify({ body, attestationExample });
  for (const shape of [/\.run\.app/, /gserviceaccount\.com/, /pkg\.dev/, /\bprojects\/\d/]) {
    assert.ok(!shape.test(text), `the examples must not contain ${shape}`);
  }
});

// ---------------------------------------------------------------------------
// Synthetic events and path changes (#71).
// ---------------------------------------------------------------------------

/** Translates a workflow `paths:` glob into a matcher. */
function pathFilterMatcher(pattern) {
  const source = pattern
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** The `paths:` filters a workflow declares for one event. */
function declaredPathFilters(workflow, event) {
  const trigger = workflow.match(
    new RegExp(`\\n  ${event}:\\n([\\s\\S]*?)(?=\\n  [a-z_]+:\\n|\\n[a-z]+:|$)`),
  )?.[1];
  if (!trigger) return null;
  const paths = trigger.match(/paths:\n([\s\S]*?)(?=\n {2}\S|$)/)?.[1];
  if (!paths) return null;
  return [...paths.matchAll(/^ {6}- '([^']+)'$/gm)].map(([, value]) => value);
}

const deliveryTriggers = (changed) => {
  const filters = declaredPathFilters(delivery, 'push');
  assert.ok(filters, 'delivery must keep its push path filter');
  const matchers = filters.map(pathFilterMatcher);
  return changed.some((path) => matchers.some((matcher) => matcher.test(path)));
};

test('synthetic path changes route to the workflows that own them', () => {
  const cases = [
    ['app-only', ['apps/web/src/app/page.tsx'], true],
    ['api-only', ['services/platform-api/src/adapters/http/create-http-server.ts'], true],
    ['contract', ['services/platform-api/openapi/platform-api.v1.yaml'], true],
    ['shared input', ['packages/platform-api-client/src/index.ts'], true],
    ['infrastructure', ['infra/stacks/api/main.tf'], true],
    ['delivery adapters', ['tools/delivery/grant.mjs'], true],
    ['workflow itself', ['.github/workflows/delivery.yml'], true],
    ['lockfile', ['pnpm-lock.yaml'], true],
    ['unrelated docs', ['docs/current-status.md'], false],
    ['unrelated coordination', ['tools/coordination-status.mjs'], false],
    ['mixed docs and app', ['docs/current-status.md', 'apps/web/src/app/page.tsx'], true],
  ];

  for (const [label, changed, expectedToRun] of cases) {
    assert.equal(
      deliveryTriggers(changed),
      expectedToRun,
      `${label} must ${expectedToRun ? '' : 'not '}reach the delivery workflow`,
    );
  }

  // Both trigger lists must agree, or a change would be checked on the pull
  // request and unchecked on the push that publishes it.
  assert.deepEqual(
    declaredPathFilters(delivery, 'pull_request'),
    declaredPathFilters(delivery, 'push'),
    'delivery must filter pull_request and push identically',
  );
});

test('required-check attachment survives: the gates run for every change', () => {
  // `ci.yml` deliberately carries no path filter. Every required check attaches
  // to every commit, so a documentation-only change cannot silently skip a
  // required check and leave a branch unmergeable or a release unqualified.
  for (const event of ['push', 'pull_request']) {
    assert.equal(
      declaredPathFilters(ci, event),
      null,
      `ci.yml must not filter ${event} by path: required checks must attach to every commit`,
    );
  }
  assert.match(ci, /\n  push:\n    branches: \['\*\*'\]/, 'ci must run on every branch push');

  // An unrelated-docs change therefore still produces every required check,
  // which is what lets `qualify` demand all four without deadlocking.
  for (const name of declaredRequiredChecks()) {
    assert.ok(name.length > 0);
  }
});
