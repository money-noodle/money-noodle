#!/usr/bin/env node

// Static policy checks over `infra/` and the delivery workflow.
//
// These run inside the existing repository gate (`pnpm verify:foundation`, which
// executes `node --test tools/*.test.mjs`), so they need no OpenTofu binary, no
// provider, and no credential. Everything they assert is a property of the
// committed text.
//
// The OpenTofu-native checks — `fmt`, `validate`, and `tofu test` — need the
// pinned binary and run separately through the Nx `infra:*` targets and the
// delivery workflow. See `infra/README.md`.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const infraRoot = join(repoRoot, 'infra');

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '.terraform' ? [] : walk(child);
    return entry.isFile() ? [child] : [];
  });
}

function relative(path) {
  return path.slice(repoRoot.length + 1);
}

const infraFiles = walk(infraRoot);
const tofuFiles = infraFiles.filter((path) => path.endsWith('.tf'));
const testFiles = infraFiles.filter((path) => path.endsWith('.tftest.hcl'));
const lockFiles = infraFiles.filter((path) => path.endsWith('.terraform.lock.hcl'));

const stackDirectories = existsSync(join(infraRoot, 'stacks'))
  ? readdirSync(join(infraRoot, 'stacks'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(infraRoot, 'stacks', entry.name))
  : [];

const read = (path) => readFileSync(path, 'utf8');
const readStack = (directory) =>
  walk(directory)
    .filter((path) => path.endsWith('.tf'))
    .map(read)
    .join('\n');

const pinnedToolVersion = read(join(infraRoot, '.terraform-version')).trim();

test('Delivery requires the runtime rendering bridge in credential-free checks for every consumed source', () => {
  const workflow = read(join(repoRoot, '.github/workflows/delivery.yml'));
  // Use the existing delivery policy guard's bounded, top-level job convention.
  const checks = workflow.match(/\n {2}checks:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n|$)/)?.[1];
  assert.ok(checks, 'checks job must exist');
  const bridgeCommand = 'node infra/modules/cloud-run-service/tests/runtime-contract.mjs';
  const bridge = checks.match(
    /      - name: Prove evaluated production runtime compatibility\n([\s\S]*?)(?=\n      - |$)/,
  )?.[1];
  assert.equal(bridge?.trim(), `run: ${bridgeCommand}`);
  assert.equal(checks.split(bridgeCommand).length, 2);
  assert.doesNotMatch(checks, /continue-on-error:|id-token:|environment:/);
  const bridgeIndex = checks.indexOf(bridgeCommand);
  for (const command of ['pnpm install --frozen-lockfile', 'node tools/infra-check.mjs all']) {
    const index = checks.indexOf(`run: ${command}`);
    assert.ok(index >= 0 && index < bridgeIndex);
  }
  for (const event of ['pull_request', 'push']) {
    const trigger = workflow.match(
      new RegExp(`\\n {2}${event}:\\n([\\s\\S]*?)(?=\\n {2}[a-z_]+:|$)`),
    )?.[1];
    assert.ok(trigger, `${event} trigger must exist`);
    for (const path of [
      'infra/**',
      'apps/web/**',
      'services/platform-api/**',
      'packages/platform-api-client/**',
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ]) {
      assert.ok(trigger.includes(`      - '${path}'`), `${event} must cover ${path}`);
    }
  }
});

test('runtime rendering tests mock Google and override every declared remote-state read', () => {
  for (const stack of ['web', 'api']) {
    const directory = join(infraRoot, 'stacks', stack);
    const source = readStack(directory);
    const fixture = read(join(directory, 'tests/runtime-contract.tftest.hcl'));
    assert.match(fixture, /mock_provider\s+"google"\s*\{/);
    const reads = [...source.matchAll(/data\s+"terraform_remote_state"\s+"([a-z_]+)"/g)]
      .map((match) => match[1])
      .sort();
    const overrides = [...fixture.matchAll(/target\s*=\s*data\.terraform_remote_state\.([a-z_]+)/g)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(overrides, reads, `${stack} must override exactly every remote-state read`);
  }
});

test('the infrastructure tree exists and is non-trivial', () => {
  assert.ok(tofuFiles.length > 0, 'expected OpenTofu configuration under infra/');
  assert.ok(stackDirectories.length >= 3, 'expected separate platform, web, and API stacks');
  assert.ok(testFiles.length > 0, 'expected at least one OpenTofu test file');
});

test('the OpenTofu version is pinned exactly and identically everywhere', () => {
  assert.match(pinnedToolVersion, /^\d+\.\d+\.\d+$/, '.terraform-version must be an exact version');

  for (const path of tofuFiles) {
    const match = read(path).match(/required_version\s*=\s*"([^"]+)"/);
    if (!match) continue;
    assert.equal(
      match[1],
      pinnedToolVersion,
      `${relative(path)} must pin required_version to ${pinnedToolVersion} exactly, with no range operator`,
    );
  }
});

test('every module and stack declares a provider version and never a range', () => {
  const declared = new Set();

  for (const path of tofuFiles) {
    const source = read(path);
    if (!source.includes('required_providers')) continue;

    const match = source.match(/google\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/s);
    assert.ok(match, `${relative(path)} declares required_providers without a google version`);

    const version = match[1];
    assert.match(
      version,
      /^\d+\.\d+\.\d+$/,
      `${relative(path)} pins the google provider as "${version}". A range operator lets an unreviewed provider version reach a plan.`,
    );
    declared.add(version);
  }

  assert.equal(
    declared.size,
    1,
    `every module and stack must pin the same provider version; found ${[...declared].join(', ')}`,
  );
});

test('committed dependency locks agree with the declared provider version', () => {
  assert.ok(lockFiles.length > 0, 'expected committed .terraform.lock.hcl files');

  const declared = read(join(infraRoot, 'stacks', 'platform', 'main.tf')).match(
    /google\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/s,
  )[1];

  for (const path of lockFiles) {
    const source = read(path);
    assert.match(
      source,
      new RegExp(`version\\s*=\\s*"${declared.replace(/\./g, '\\.')}"`),
      `${relative(path)} does not lock the declared provider version ${declared}`,
    );

    // `tofu providers lock -platform=...` writes one `h1:` hash per platform
    // package. A lock generated on one developer's machine carries a single
    // hash and then fails on the Linux runner, so more than one is required.
    // This proves multi-platform generation happened; it does not identify
    // which platforms, because the format does not label them.
    const hashCount = (source.match(/"h1:/g) ?? []).length;
    assert.ok(
      hashCount > 1,
      `${relative(path)} carries ${hashCount} h1 hash(es). Regenerate with \`tofu providers lock -platform=linux_amd64 -platform=darwin_arm64\` so the lock is not developer-machine-specific.`,
    );
  }
});

test('no long-lived cloud credential or account identifier is committed', () => {
  // ADR-0005 rules out a stored provider key entirely, and the issue forbids
  // committing account, project, or billing identifiers. Real values arrive as
  // variables at bootstrap.
  const forbidden = [
    [/-----BEGIN[A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/"type"\s*:\s*"service_account"/, 'a service account key file'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
    [/\bprivate_key_id\b/, 'a service account key field'],
    [/^\s*credentials\s*=/m, 'a provider `credentials` argument, which implies a key file'],
    [
      /\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/,
      'a literal that matches a Google billing account id',
    ],
  ];

  for (const path of [...tofuFiles, ...testFiles]) {
    const source = read(path);
    for (const [pattern, description] of forbidden) {
      assert.ok(
        !pattern.test(source),
        `${relative(path)} appears to contain ${description}. Real identifiers are supplied at bootstrap and never committed.`,
      );
    }
  }
});

test('each stack holds separate remote state under its own prefix', () => {
  const prefixes = new Map();

  for (const directory of stackDirectories) {
    const name = basename(directory);
    const source = readStack(directory);

    assert.match(
      source,
      /backend\s+"gcs"\s*\{/,
      `stack ${name} must declare a gcs backend; state is never local and never committed`,
    );

    // A stack reading another stack's published contract configures that read
    // with the *other* stack's prefix, so the stack's own prefix is the one
    // paired with a `backend` block rather than a `terraform_remote_state`.
    for (const [, prefix] of source.matchAll(/prefix\s*=\s*"(stacks\/[^"]+)"/g)) {
      if (!prefixes.has(prefix)) prefixes.set(prefix, new Set());
      prefixes.get(prefix).add(name);
    }
  }

  const own = new Map();
  for (const directory of stackDirectories) {
    own.set(basename(directory), `stacks/${basename(directory)}`);
  }

  const distinct = new Set(own.values());
  assert.equal(
    distinct.size,
    own.size,
    'two stacks share a state prefix, which would couple their locks and contradict ADR-0006',
  );
});

test('stacks cross boundaries only through published contract outputs', () => {
  // ADR-0006: values crossing stacks pass as explicit declared inputs or by
  // reading a published output, never by one stack reaching into another's
  // internals. `terraform_remote_state` exposes every output, so the discipline
  // is that only `contract_`-prefixed outputs are consumed — and this is what
  // makes that discipline enforced rather than merely intended.
  const published = new Map();

  for (const directory of stackDirectories) {
    const outputs = new Set();
    for (const [, name] of readStack(directory).matchAll(/output\s+"([^"]+)"/g)) {
      outputs.add(name);
    }
    published.set(basename(directory), outputs);
  }

  for (const directory of stackDirectories) {
    const consumer = basename(directory);
    const source = readStack(directory);
    const references = [
      ...source.matchAll(/data\.terraform_remote_state\.([a-z_]+)\.outputs\.([a-z_0-9]+)/g),
    ];

    for (const [, producer, output] of references) {
      assert.ok(
        output.startsWith('contract_'),
        `stack ${consumer} reads \`${producer}.outputs.${output}\`, which is not a published contract output. Cross-stack reads must use a \`contract_\`-prefixed output.`,
      );

      const producerOutputs = published.get(producer);
      assert.ok(producerOutputs, `stack ${consumer} reads unknown stack \`${producer}\``);
      assert.ok(
        producerOutputs.has(output),
        `stack ${consumer} reads \`${producer}.outputs.${output}\`, which stack ${producer} does not publish`,
      );
    }
  }
});

test('the API stack does not depend on the web stack', () => {
  // The dependency contract is one-directional: web reads api, never the
  // reverse. A cycle would make independent deployment impossible.
  const apiSource = readStack(join(infraRoot, 'stacks', 'api'));
  assert.ok(
    !/data\.terraform_remote_state\.web\b/.test(apiSource),
    'the API stack reads the web stack, which creates a dependency cycle and defeats independent deployment',
  );
});

test('destructive operations are not available to ordinary automation', () => {
  const allSources = [...tofuFiles, ...testFiles].map((path) => [path, read(path)]);

  for (const [path, source] of allSources) {
    for (const [, value] of source.matchAll(/force_destroy\s*=\s*(\w+)/g)) {
      assert.equal(
        value,
        'false',
        `${relative(path)} sets force_destroy = ${value}. A bucket that deletes its contents on destroy is not a recoverable state store.`,
      );
    }
  }

  const stateBucket = read(join(infraRoot, 'modules', 'state-bucket', 'main.tf'));
  assert.match(
    stateBucket,
    /prevent_destroy\s*=\s*true/,
    'state buckets must set prevent_destroy; removing state is a reviewed code change, never an automation step',
  );
  assert.match(
    stateBucket,
    /versioning\s*\{\s*enabled\s*=\s*true/,
    'state buckets must enable object versioning from the first apply, per ADR-0006',
  );

  const cloudRun = read(join(infraRoot, 'modules', 'cloud-run-service', 'main.tf'));
  assert.match(
    cloudRun,
    /deletion_protection\s*=\s*var\.deletion_protection/,
    'Cloud Run services must expose deletion protection rather than defaulting to destroyable',
  );

  const secrets = read(join(infraRoot, 'modules', 'secret-store', 'main.tf'));
  assert.match(secrets, /prevent_destroy\s*=\s*true/, 'secret containers must set prevent_destroy');
});

test('images deploy by digest and never by a mutable tag', () => {
  const cloudRun = read(join(infraRoot, 'modules', 'cloud-run-service', 'variables.tf'));
  assert.match(
    cloudRun,
    /\^sha256:\[0-9a-f\]\{64\}\$/,
    'image_digest must be validated as a full sha256 digest; deploying by tag breaks attribution and rollback (ADR-0005)',
  );

  const service = read(join(infraRoot, 'modules', 'cloud-run-service', 'main.tf'));
  assert.ok(
    service.includes('@${var.image_digest}'),
    'the image reference must be built with `@digest`, not `:tag`',
  );
});

test('runtime identities are distinct per deployable unit and hold no registry access', () => {
  // The identities moved to the maintainer-applied bootstrap stack (#178), so
  // the account ids are declared there. They are still one per deployable unit
  // and still mechanically distinct; a shared identity would make blast radius a
  // convention rather than a property.
  //
  // Since #241 a unit is a deployable service *or* a declared Cloud Run Job
  // (ADR-0013 §1). The rule is extended rather than relaxed: the set is still
  // exact, so an identity nobody asked for still fails, and a job key must still
  // be pinned by the stack that resolves it.
  const bootstrapVariables = read(join(infraRoot, 'stacks', 'bootstrap', 'variables.tf'));
  const declared = bootstrapVariables.match(
    /variable "runtime_service_accounts"[\s\S]*?default = \{([\s\S]*?)\n {2}\}/,
  )?.[1];
  assert.ok(declared, 'bootstrap must declare one runtime account id per deployable unit');

  const accounts = Object.fromEntries(
    [...declared.matchAll(/"([a-z][-a-z0-9]*)"\s*=\s*"([a-z][-a-z0-9]*)"/g)].map(
      ([, unit, accountId]) => [unit, accountId],
    ),
  );
  assert.deepEqual(
    Object.keys(accounts).sort(),
    ['engine-restore', 'platform-api', 'web'],
    'bootstrap must declare a runtime identity for each deployable service and each declared job, keyed by the name that unit stack pins',
  );
  assert.equal(
    new Set(Object.values(accounts)).size,
    Object.values(accounts).length,
    'every runtime identity must be mechanically distinct from every other',
  );
  // ADR-0013 §1 names this one, and the engine-jobs stack resolves it by key.
  assert.equal(
    accounts['engine-restore'],
    'engine-restore-runtime',
    'the restore job identity must be the account id ADR-0013 §1 names',
  );

  // Every job key must also be declared as a job, so the identity's own
  // description says which kind of unit it runs rather than calling a job a
  // service.
  const jobNames = bootstrapVariables.match(
    /variable "runtime_job_names"[\s\S]*?default\s*=\s*\[([^\]]*)\]/,
  )?.[1];
  assert.ok(jobNames, 'bootstrap must declare which runtime identities belong to jobs');
  assert.deepEqual(
    [...jobNames.matchAll(/"([a-z][-a-z0-9]*)"/g)].map(([, name]) => name).sort(),
    ['engine-restore'],
    'the declared job identities must be exactly the jobs that exist',
  );

  // Each stack selects its own identity by the name it pins, so no unit can be
  // wired to run as another's identity.
  for (const [unit, stack, key] of [
    ['platform-api', 'api', 'service_name'],
    ['web', 'web', 'service_name'],
    ['engine-restore', 'engine-jobs', 'job_name'],
  ]) {
    const source = readStack(join(infraRoot, 'stacks', stack));
    assert.ok(
      source.includes('contract_runtime_service_account_emails'),
      `the ${stack} stack must read its runtime identity from the bootstrap contract`,
    );
    assert.ok(
      source.includes(`[var.${key}]`),
      `the ${stack} stack must select its runtime identity by its own pinned ${key}`,
    );
    assert.match(
      read(join(infraRoot, 'stacks', stack, 'variables.tf')),
      new RegExp(`condition\\s*=\\s*var\\.${key} == "${unit}"`),
      `the ${stack} stack's ${key} must stay pinned, because it is the identity key`,
    );
    assert.ok(
      Object.hasOwn(accounts, unit),
      `bootstrap must declare the identity the ${stack} stack resolves`,
    );
  }

  const cloudRun = read(join(infraRoot, 'modules', 'cloud-run-service', 'main.tf'));
  for (const source of [cloudRun, read(join(infraRoot, 'stacks', 'bootstrap', 'main.tf'))]) {
    assert.ok(
      !/artifactregistry\.(reader|writer)/.test(source),
      'a runtime identity must not be granted Artifact Registry access; Cloud Run pulls as the service agent (ADR-0005)',
    );
    assert.ok(
      !/storage\.(object)?[Aa]dmin/.test(source),
      'a runtime identity must not be granted access to infrastructure state',
    );
  }
});

test('a service apply declares no identity, project-level, or secret IAM resource', () => {
  // #178: the first authorized `api` apply failed on `iam.serviceAccounts.create`
  // because the module asked the deployer to create its runtime identity. #217: the
  // first routine deploy after #216 failed again, on a Secret Manager IAM member —
  // the deployer can mutate nothing in Secret Manager, and the secret container is
  // created by a maintainer-applied stack, so a grant declared in the release path
  // could only fail the deploy that needed it. The deployer administers no identity
  // and no project IAM, and in Secret Manager it holds secret-level metadata read
  // and nothing else (#224), so a plan for either service must contain Cloud Run
  // resources and service-level bindings only.
  const forbidden = [
    [/resource\s+"google_service_account"/, 'a service account'],
    [/resource\s+"google_project_iam_(member|binding|policy)"/, 'a project IAM binding'],
    [
      /resource\s+"google_service_account_iam_(member|binding|policy)"/,
      'a service account IAM binding',
    ],
    [/resource\s+"google_organization_iam_/, 'an organization IAM binding'],
    [
      /resource\s+"google_secret_manager_secret(_iam_(member|binding|policy))?"/,
      'a Secret Manager resource',
    ],
  ];

  const releasePaths = [
    join(infraRoot, 'modules', 'cloud-run-service'),
    join(infraRoot, 'stacks', 'api'),
    join(infraRoot, 'stacks', 'web'),
  ];

  for (const directory of releasePaths) {
    for (const path of walk(directory).filter((candidate) => candidate.endsWith('.tf'))) {
      const source = read(path);
      for (const [pattern, description] of forbidden) {
        assert.ok(
          !pattern.test(source),
          `${relative(path)} declares ${description}. A service apply runs as the deployer, which administers no identity or project IAM and can mutate nothing in Secret Manager (ADR-0005, 2026-09-19 and 2026-10-05 amendments; #217, #224); declare it in a maintainer-applied stack instead.`,
        );
      }
    }
  }

  // What stays is per-service and per-release: the service itself and its
  // service-level invoker bindings.
  const cloudRun = read(join(infraRoot, 'modules', 'cloud-run-service', 'main.tf'));
  for (const retained of [
    /resource\s+"google_cloud_run_v2_service"\s+"service"/,
    /resource\s+"google_cloud_run_v2_service_iam_member"\s+"authorised_invokers"/,
  ]) {
    assert.match(cloudRun, retained, 'the service module must keep its per-service resources');
  }

  // Secret access still exists; it is declared where it can actually be applied,
  // beside the container, and granted by name from the maintainer-applied platform
  // stack. A reference the service stacks declare is validated against that intent
  // rather than granted by them (#217).
  assert.match(
    read(join(infraRoot, 'modules', 'secret-store', 'main.tf')),
    /resource\s+"google_secret_manager_secret_iam_member"\s+"accessor"/,
    'the secret store must declare the access boundary for the containers it creates',
  );
  assert.match(
    read(join(infraRoot, 'stacks', 'platform', 'main.tf')),
    /accessor_members\s*=/,
    'the platform stack must pass the declared consumers through to the secret store',
  );
  assert.match(
    read(join(infraRoot, 'modules', 'cloud-run-service', 'variables.tf')),
    /variable "accessible_secret_ids"/,
    'the service module must keep declared secret intent as a validated input',
  );

  // And the identity arrives as a validated input rather than being created.
  const variables = read(join(infraRoot, 'modules', 'cloud-run-service', 'variables.tf'));
  const block = variables.match(/variable "runtime_service_account_email" \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'the module must take the runtime identity as an input');
  assert.match(block, /validation \{[\s\S]*can\(regex\(/, 'the input must be validated');
  assert.ok(
    block.includes('gserviceaccount'),
    'the runtime identity input must be validated as a service account email, not accepted as any string',
  );
});

test('the deployer cannot read secret values or hold administrative roles', () => {
  const bootstrap = read(join(infraRoot, 'stacks', 'bootstrap', 'variables.tf'));

  for (const role of [
    'roles/owner',
    'roles/editor',
    'roles/secretmanager.admin',
    'roles/secretmanager.secretAccessor',
  ]) {
    assert.ok(
      !new RegExp(`default\\s*=\\s*\\[[^\\]]*"${role.replace('.', '\\.')}"`, 's').test(bootstrap),
      `the deployer must not hold ${role} (ADR-0005)`,
    );
  }

  for (const rejected of [
    'roles/owner',
    'roles/secretmanager.admin',
    'roles/secretmanager.secretAccessor',
  ]) {
    assert.ok(
      bootstrap.includes(rejected),
      `the deployer role validation must explicitly reject ${rejected} rather than merely omitting it`,
    );
  }
});

test('the only Secret Manager grant the deployer can receive is secret-level metadata read', () => {
  // #224: once the first container existed, every pipeline plan of the platform
  // stack refreshed it as the deployer and failed with 403 on
  // `secretmanager.secrets.get`, so no routine deploy could run. The resolution is a
  // read-only grant at secret level. These assertions are what keep it read-only and
  // at secret level: the roles that may appear anywhere under `infra/`, where the
  // plan-only grant is declared, and who receives it.
  const allowedRoles = new Set([
    'roles/secretmanager.secretAccessor',
    'roles/secretmanager.viewer',
  ]);

  for (const path of [...tofuFiles, ...testFiles]) {
    const source = read(path);
    // Every Secret Manager role this configuration *grants*, as a `role =` or
    // `…_role =` assignment. A role named in a refusal list — the bootstrap
    // validation that rejects `roles/secretmanager.admin`, for instance — is the
    // opposite of a grant and is deliberately not matched.
    for (const [, role] of source.matchAll(
      /\b(?:role|[a-z_]*_role)\s*=\s*"(roles\/secretmanager\.[A-Za-z.]+)"/g,
    )) {
      assert.ok(
        allowedRoles.has(role),
        `${relative(path)} grants ${role}. Secret Manager carries exactly two grants in this platform: secretAccessor for a declared value consumer, and viewer at secret level for the identity that must plan the container (#224).`,
      );
    }

    // A permission granting `versions.access` reads values. It is matched as a
    // quoted literal, which is the only way it could reach a provider — a custom
    // role's permission list or a role name. Prose about its absence uses backticks
    // and is deliberately not caught here.
    assert.ok(
      !/"[a-z.]*secretmanager\.versions\.access"/.test(source),
      `${relative(path)} declares secretmanager.versions.access. Only a declared runtime consumer reads a value, and it does so through secretAccessor rather than through a hand-built role.`,
    );
  }

  // No Secret Manager role at project level, by any resource, and no custom role: a
  // `google_project_iam_custom_role` in a pipeline-planned stack would itself need
  // `iam.roles.get` to refresh, which the deployer does not have, so it would move
  // the same denial rather than remove it.
  for (const path of tofuFiles) {
    const source = read(path);
    assert.ok(
      !/resource\s+"google_project_iam_custom_role"/.test(source),
      `${relative(path)} declares a project custom role. The deployer cannot refresh one (no iam.roles.get), so a custom role moves the 403 of #224 instead of fixing it.`,
    );
    const projectBindings = source.match(
      /resource\s+"google_project_iam_(?:member|binding|policy)"[\s\S]*?\n}/g,
    );
    for (const binding of projectBindings ?? []) {
      assert.ok(
        !/roles\/secretmanager/.test(binding),
        `${relative(path)} grants a Secret Manager role at project level. Every Secret Manager grant in this platform is bound to one secret (ADR-0005).`,
      );
    }
  }

  // The plan-only grant is declared beside the container, as a secret-level member,
  // with its role fixed in the module rather than taken as an input.
  const store = read(join(infraRoot, 'modules', 'secret-store', 'main.tf'));
  assert.match(
    store,
    /resource\s+"google_secret_manager_secret_iam_member"\s+"metadata_reader"/,
    'the secret store must declare the plan-only grant as a secret-level IAM member',
  );
  assert.match(
    store,
    /metadata_reader_role\s*=\s*"roles\/secretmanager\.viewer"/,
    'the plan-only role must be fixed in the module; an input here is where a future edit would pass admin',
  );
  assert.ok(
    !/variable\s+"metadata_reader_role"/.test(
      read(join(infraRoot, 'modules', 'secret-store', 'variables.tf')),
    ),
    'the plan-only role must not be configurable',
  );

  // And the deployer receives exactly that, from the maintainer-applied stack, while
  // never appearing among the identities that can read a value.
  const platform = read(join(infraRoot, 'stacks', 'platform', 'main.tf'));
  const metadataLocal = platform.match(
    /secret_metadata_reader_members\s*=\s*\{[\s\S]*?\n {2}\}/,
  )?.[0];
  assert.ok(metadataLocal, 'the platform stack must declare who may plan the secret containers');
  assert.match(
    metadataLocal,
    /local\.deployer/,
    'the plan-only reader is the deployer, named from the bootstrap contract rather than written down',
  );
  const accessorLocal = platform.match(/secret_accessor_members\s*=\s*\{[\s\S]*?\n {2}\}/)?.[0];
  assert.ok(accessorLocal, 'the platform stack must declare who may read each secret');
  assert.ok(
    !/local\.deployer/.test(accessorLocal),
    'the deployer must never be derived into the accessor list: it plans containers and does not read contents',
  );
});

test('budget management has an explicit billing-account authority boundary', () => {
  const bootstrapMain = read(join(infraRoot, 'stacks', 'bootstrap', 'main.tf'));
  const bootstrapVariables = read(join(infraRoot, 'stacks', 'bootstrap', 'variables.tf'));

  assert.match(
    bootstrapMain,
    /resource\s+"google_billing_account_iam_member"\s+"deployer_budget_manager"/,
    'a project IAM role cannot authorize budget creation on a billing account',
  );
  assert.match(
    bootstrapMain,
    /role\s*=\s*"roles\/billing\.costsManager"/,
    'the deployer billing grant must be limited to cost and budget management',
  );
  assert.match(
    bootstrapVariables,
    /variable\s+"billing_account_id"/,
    'bootstrap must receive the billing account whose narrow budget grant it owns',
  );
});

test('the accepted budget ceiling and alert thresholds are represented', () => {
  const budget = read(join(infraRoot, 'modules', 'budget-guardrail', 'variables.tf'));

  assert.match(
    budget,
    /monthly_ceiling"[\s\S]*?default\s*=\s*25\b/,
    'the accepted USD 25 monthly alert budget must be the default',
  );
  assert.match(
    budget,
    /threshold_percents"[\s\S]*?default\s*=\s*\[20,\s*50,\s*80,\s*100\]/,
    'the accepted 20/50/80/100 percent alert thresholds must be the default',
  );
  assert.match(
    budget,
    /currency_code"[\s\S]*?default\s*=\s*"USD"/,
    'the ceiling is denominated in USD, matching the accepted decision and the dated pricing evidence',
  );
});

test('services scale to zero, bounding idle cost', () => {
  const cloudRun = read(join(infraRoot, 'modules', 'cloud-run-service', 'variables.tf'));
  assert.match(
    cloudRun,
    /min_instances"[\s\S]*?default\s*=\s*0\b/,
    'minimum instances must default to zero (`principles.md`, and the accepted cost model prices it)',
  );
  assert.match(
    cloudRun,
    /var\.min_instances\s*==\s*0/,
    'a standing minimum instance count must be rejected rather than silently permitted',
  );
});

test('services default to two maximum instances, bounding saturation cost', () => {
  const cloudRun = read(join(infraRoot, 'modules', 'cloud-run-service', 'variables.tf'));
  assert.match(
    cloudRun,
    /max_instances"[\s\S]*?default\s*=\s*2\b/,
    'maximum instances must default to two per service (accepted recommendation Q4a of #75)',
  );
  for (const stack of ['api', 'web']) {
    assert.doesNotMatch(
      read(join(infraRoot, 'stacks', stack, 'main.tf')),
      /\bmax_instances\s*=/,
      `the ${stack} stack must not override the bounded default`,
    );
  }
});

test('no DNS resource is declared, so Vercel remains authoritative for noodle.money', () => {
  // Issue #14 excludes any change to existing Vercel DNS, and ADR-0004 defers the
  // domain cutover to a separately reviewed plan. Interim validation targets
  // default *.run.app URLs only. This is the mechanical proof of that exclusion:
  // the configuration contains nothing that could publish a DNS record or claim
  // a custom domain.
  const forbidden = [
    /resource\s+"google_dns_/,
    /resource\s+"google_cloud_run_domain_mapping"/,
    /resource\s+"google_compute_global_forwarding_rule"/,
    /resource\s+"google_compute_managed_ssl_certificate"/,
    /resource\s+"google_compute_region_network_endpoint_group"/,
  ];

  for (const path of tofuFiles) {
    const source = read(path);
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(source),
        `${relative(path)} declares a DNS or custom-domain resource. The domain cutover is a separately reviewed change (ADR-0004); Vercel DNS stays untouched.`,
      );
    }
  }
});

/* ------------------------------------------------------- private-before-public */

// `docs/operations/delivery.md` requires a stricter order for first creation:
// create the service privately, verify it independently with a separate
// read-only identity and an audience-bound token, and only then expose it as a
// separate reviewed step. A hardcoded `true`, or a default of `true`, would make
// the apply that creates a service the apply that publishes it — and a service
// that is public on creation cannot be verified before it is reachable.

test('a service is created private and exposed only as a separate reviewed step', () => {
  const moduleVariables = read(join(infraRoot, 'modules', 'cloud-run-service', 'variables.tf'));
  const moduleBlock = moduleVariables.match(
    /variable "allow_unauthenticated" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(moduleBlock, 'the service module must declare allow_unauthenticated');
  assert.match(
    moduleBlock,
    /default\s*=\s*false/,
    'the service module must default to a private service',
  );

  for (const stack of ['api', 'web']) {
    const variables = read(join(infraRoot, 'stacks', stack, 'variables.tf'));
    const block = variables.match(/variable "allow_unauthenticated" \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(block, `the ${stack} stack must declare allow_unauthenticated as a reviewed input`);
    assert.match(
      block,
      /default\s*=\s*false/,
      `the ${stack} stack must default to a private service, so its first apply creates nothing public`,
    );

    const main = read(join(infraRoot, 'stacks', stack, 'main.tf'));
    assert.match(
      main,
      /allow_unauthenticated\s*=\s*var\.allow_unauthenticated/,
      `the ${stack} stack must pass the reviewed variable rather than a literal`,
    );
    assert.doesNotMatch(
      main,
      /allow_unauthenticated\s*=\s*true/,
      `the ${stack} stack hardcodes public access, so a single apply would both create and expose the service`,
    );
  }
});

test('no pipeline run can expose a service while creating it', () => {
  // Exposure must be a distinct, reviewed change. If the delivery workflow could
  // supply the value, a create and an expose would collapse into one dispatch.
  const delivery = read(join(repoRoot, '.github', 'workflows', 'delivery.yml'));
  assert.ok(
    !delivery.includes('allow_unauthenticated'),
    'the delivery workflow must supply no public-access value; exposure is a separate reviewed change, not a workflow input',
  );
});

test('the public invoker binding has one writer and no suppressed drift', () => {
  const competing = [
    /resource\s+"google_cloud_run_v2_service_iam_policy"/,
    /resource\s+"google_cloud_run_v2_service_iam_binding"/,
    /resource\s+"google_cloud_run_service_iam_policy"/,
    /resource\s+"google_cloud_run_service_iam_binding"/,
  ];

  const declarations = [];
  for (const path of tofuFiles) {
    const source = read(path);
    for (const pattern of competing) {
      assert.ok(
        !pattern.test(source),
        `${relative(path)} declares a second writer of the invoker policy. Two writers make who may invoke ambiguous, and a whole-policy resource can silently drop the least-privilege service-to-service grant.`,
      );
    }
    assert.ok(
      !/\nimport\s*\{/.test(source),
      `${relative(path)} declares an import block. Adopting an out-of-band IAM binding would make an exposure that was never reviewed look like desired state.`,
    );
    if (/resource\s+"google_cloud_run_v2_service_iam_member"\s+"public"/.test(source)) {
      declarations.push(path);
    }
  }

  assert.equal(
    declarations.length,
    1,
    'exactly one resource may grant public invocation, so exposure is reviewable in one place',
  );

  const block = read(declarations[0]).match(
    /resource\s+"google_cloud_run_v2_service_iam_member"\s+"public"\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(block, 'expected the public invoker binding to be readable');
  assert.ok(
    !/ignore_changes/.test(block),
    'the public binding must not ignore changes; drift in who may invoke has to be visible',
  );
  assert.match(
    block,
    /count\s*=\s*var\.allow_unauthenticated\s*\?\s*1\s*:\s*0/,
    'the public binding must exist only when the reviewed input asks for it',
  );
  assert.match(block, /member\s*=\s*"allUsers"/, 'the public binding must add exactly `allUsers`');
});

test('an HCL test proves a created service carries no allUsers binding', () => {
  for (const [label, path] of [
    [
      'the service module',
      join(infraRoot, 'modules', 'cloud-run-service', 'tests', 'exposure.tftest.hcl'),
    ],
    ['the api stack', join(infraRoot, 'stacks', 'api', 'tests', 'exposure.tftest.hcl')],
    ['the web stack', join(infraRoot, 'stacks', 'web', 'tests', 'exposure.tftest.hcl')],
  ]) {
    assert.ok(existsSync(path), `${label} must carry an exposure test`);
    const source = read(path);
    assert.match(
      source,
      /mock_provider "google" \{\}/,
      `${label}'s exposure test must mock the provider and reach no provider API`,
    );
    assert.match(
      source,
      /== 0\n/,
      `${label}'s exposure test must assert that creation produces no public binding`,
    );
    assert.match(
      source,
      /allow_unauthenticated = true/,
      `${label}'s exposure test must also cover the separate exposure step`,
    );
    assert.match(
      source,
      /"allUsers"/,
      `${label}'s exposure test must assert the exposed member is exactly allUsers`,
    );
  }
});

// ---------------------------------------------------------------------------
// Telemetry configuration, identity and retention (#72).
//
// Focused static guards over the committed telemetry configuration. Nothing
// here observes a provider: these assert what the source asks for, which is the
// only thing source can establish. Actual ingestion, actual retention ageing
// and actual IAM remain #8's evidence.
// ---------------------------------------------------------------------------

const cloudRunModule = read(join(infraRoot, 'modules/cloud-run-service/main.tf'));
const cloudRunVariables = read(join(infraRoot, 'modules/cloud-run-service/variables.tf'));
const retentionModule = read(join(infraRoot, 'modules/telemetry-retention/main.tf'));
const retentionVariables = read(join(infraRoot, 'modules/telemetry-retention/variables.tf'));
const retentionOutputs = read(join(infraRoot, 'modules/telemetry-retention/outputs.tf'));

test('telemetry export is configured explicitly and carries attributable identity', () => {
  for (const name of [
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_PROTOCOL',
    'OTEL_SERVICE_NAME',
    'OTEL_RESOURCE_ATTRIBUTES',
    'OTEL_TRACES_SAMPLER',
    'OTEL_TRACES_SAMPLER_ARG',
  ]) {
    assert.ok(cloudRunModule.includes(name), `the runtime must receive ${name}`);
  }

  // OTLP over HTTP/protobuf, so the exporter stays replaceable.
  assert.match(cloudRunModule, /OTEL_EXPORTER_OTLP_PROTOCOL = "http\/protobuf"/);
  // Parent-based head sampling, configurable and unity at the first slice.
  assert.match(cloudRunModule, /OTEL_TRACES_SAMPLER\s*= "parentbased_traceidratio"/);
  assert.match(cloudRunVariables, /variable "trace_sample_ratio"[\s\S]*?default\s*=\s*1/);

  // Every signal is attributable to a service, release, source commit and image
  // digest, and those stay three distinct facts.
  for (const attribute of [
    'service.name=',
    'service.version=',
    'deployment.environment.name=',
    'money_noodle.image_digest=',
    'money_noodle.source_commit=',
  ]) {
    assert.ok(cloudRunModule.includes(attribute), `resource attributes must carry ${attribute}`);
  }
});

test('telemetry authentication needs no credential in configuration', () => {
  // The quota project is a project identifier the exporter sends as a header.
  assert.match(cloudRunModule, /GOOGLE_CLOUD_QUOTA_PROJECT/);
  // No credential may be configured into an OTEL header variable, and no
  // service-account key may be referenced anywhere in the module.
  assert.ok(
    !/OTEL_EXPORTER_OTLP_HEADERS/.test(cloudRunModule),
    'no credential may be carried in an OTEL header variable',
  );
  for (const forbidden of [/credentials_json/, /service_account_key/, /private_key/]) {
    assert.ok(!forbidden.test(cloudRunModule), `the module must not reference ${forbidden}`);
  }

  // Reserved names cannot be overridden through `extra_env`, so a deployment
  // cannot quietly retarget telemetry or substitute a quota project.
  const reserved = cloudRunVariables.match(/variable "extra_env"[\s\S]*?\n}/)?.[0];
  assert.ok(reserved, 'extra_env must still validate reserved names');
  assert.ok(reserved.includes('GOOGLE_CLOUD_QUOTA_PROJECT'));
  assert.ok(reserved.includes('startswith(name, "OTEL_")'));
});

test('the runtime identity holds telemetry write authority and nothing more', () => {
  // The grant moved to the maintainer-applied bootstrap stack (#178). It is the
  // same five roles, still the only project-level authority a runtime identity
  // holds, and it is now unreachable by the delivery pipeline.
  const bootstrapMain = read(join(infraRoot, 'stacks', 'bootstrap', 'main.tf'));
  const bootstrapVariables = read(join(infraRoot, 'stacks', 'bootstrap', 'variables.tf'));

  const grant = bootstrapMain.match(
    /resource "google_project_iam_member" "runtime_telemetry"[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(grant, 'the telemetry IAM grant must still exist, in the bootstrap stack');
  assert.match(
    grant,
    /google_service_account\.runtime\[each\.value\.service\]\.email/,
    'the grant must name the runtime identity bootstrap creates, not an interpolated string',
  );

  const roles = bootstrapVariables.match(
    /variable "runtime_telemetry_roles"[\s\S]*?default = \[([\s\S]*?)\n {2}\]/,
  )?.[1];
  assert.ok(roles, 'bootstrap must declare the telemetry roles it grants');

  // Google's Telemetry API documentation requires these two alongside the
  // classic per-signal roles. Desired configuration only: nothing is applied.
  for (const role of [
    'roles/cloudtrace.agent',
    'roles/logging.logWriter',
    'roles/monitoring.metricWriter',
    'roles/serviceusage.serviceUsageConsumer',
    'roles/telemetry.writer',
  ]) {
    assert.ok(roles.includes(role), `the runtime identity must declare ${role}`);
  }

  // Writing telemetry is not reading anything, and not deploying anything.
  for (const forbidden of [
    'roles/run.admin',
    'roles/run.developer',
    'roles/storage.admin',
    'roles/owner',
    'roles/editor',
    'roles/artifactregistry',
    'roles/secretmanager',
  ]) {
    assert.ok(!roles.includes(forbidden), `the runtime identity must never hold ${forbidden}`);
  }

  // The variable refuses a role outside the telemetry families and refuses an
  // administrative role inside them, so a future edit cannot widen it quietly.
  const variableBlock = bootstrapVariables.match(
    /variable "runtime_telemetry_roles" \{([\s\S]*?)\n\}\n\nvariable/,
  )?.[1];
  assert.ok(variableBlock, 'the telemetry role list must stay validated');
  assert.match(variableBlock, /roles\/cloudtrace\./);
  assert.match(variableBlock, /"roles\/logging\.admin"/);
  assert.match(variableBlock, /"roles\/owner"/);

  // The service module no longer grants anything at project level at all.
  assert.ok(
    !/resource\s+"google_project_iam_member"/.test(cloudRunModule),
    'the service module must declare no project IAM; a service apply holds no project-IAM authority',
  );
});

test('the deployer can bind a service invoker and administers no identity', () => {
  // #178: a private service needs service-level `roles/run.invoker` bindings for
  // the web and for the post-apply verifier, which `roles/run.developer` cannot
  // set. `roles/run.admin` is confined to Cloud Run: it grants no project IAM and
  // no identity administration.
  const bootstrap = read(join(infraRoot, 'stacks', 'bootstrap', 'variables.tf'));
  const declared = bootstrap.match(
    /variable "deployer_roles"[\s\S]*?default = \[([\s\S]*?)\n {2}\]/,
  )?.[1];
  assert.ok(declared, 'bootstrap must enumerate the deployer roles');

  assert.ok(declared.includes('"roles/run.admin"'), 'the deployer must administer Cloud Run');
  assert.ok(
    !declared.includes('"roles/run.developer"'),
    'run.developer cannot set a service-level invoker binding; the first private apply fails on it',
  );
  assert.ok(
    declared.includes('"roles/iam.serviceAccountUser"'),
    'the deployer must keep the authority to act as the runtime identities it deploys',
  );
  assert.match(
    declared,
    /not `?run\.developer`?|Cloud Run administration/i,
    'the role swap must carry a comment saying why, so a reviewer sees the reason rather than the diff',
  );

  // Acting as an identity is not administering one. None of these may appear.
  for (const role of [
    'roles/owner',
    'roles/editor',
    'roles/resourcemanager.projectIamAdmin',
    'roles/iam.securityAdmin',
    'roles/iam.serviceAccountAdmin',
    'roles/iam.serviceAccountCreator',
    'roles/iam.serviceAccountKeyAdmin',
    'roles/secretmanager.admin',
    'roles/secretmanager.secretAccessor',
    'roles/secretmanager.viewer',
  ]) {
    assert.ok(
      !declared.includes(`"${role}"`),
      `the deployer must not hold ${role}; creating and granting identities is the maintainer's bootstrap, not CI's (ADR-0005)`,
    );
  }
});

test('log retention is explicit, and a shorter debug window cannot be claimed falsely', () => {
  // The accepted 2026-09-15 policy: application and debug logs at 14 days.
  assert.match(retentionVariables, /variable "log_retention_days"[\s\S]*?default\s*=\s*14/);
  assert.match(retentionVariables, /variable "debug_log_retention_days"[\s\S]*?default\s*=\s*14/);
  assert.match(retentionModule, /retention_days = var\.log_retention_days/);

  // A sink routes a copy; it does not stop `_Default` keeping its own. The
  // module refuses to configure a shorter debug window while that copy exists.
  const debugBucket = retentionModule.match(
    /resource "google_logging_project_bucket_config" "debug"[\s\S]*?\n}/,
  )?.[0];
  assert.ok(debugBucket, 'the debug bucket must still exist');
  assert.match(debugBucket, /precondition/);
  assert.match(debugBucket, /var\.debug_log_retention_days >= var\.log_retention_days/);
  assert.match(debugBucket, /var\.debug_excluded_from_default_bucket/);

  // The effective window is reported as the longer of the two copies.
  assert.match(retentionOutputs, /effective_days/);
  assert.match(retentionOutputs, /max\(var\.debug_log_retention_days, var\.log_retention_days\)/);
});

test('provider-fixed retention is recorded as provider behaviour, not as configuration', () => {
  const policy = retentionOutputs;
  // Trace 30 days and OTLP metric 24 months are accepted provider behaviour.
  assert.match(policy, /traces = \{[\s\S]*?days\s*=\s*30[\s\S]*?configured\s*=\s*false/);
  assert.match(policy, /metrics = \{[\s\S]*?days\s*=\s*730[\s\S]*?configured\s*=\s*false/);
  assert.match(policy, /progressive(ly)? downsampl/i);
  assert.ok(
    !/configurable TTL|deletion guarantee['"]?\s*:/i.test(policy) ||
      /not an IaC-configurable deletion guarantee|not a configurable TTL/i.test(policy),
    'provider-fixed retention must not be described as configurable',
  );

  // Audit retention is separate and untouched.
  assert.match(policy, /audit_logs = \{[\s\S]*?days\s*=\s*400[\s\S]*?configured\s*=\s*false/);
  assert.match(policy, /Audit is not telemetry/);
});

test('the evaluated runtime bridge proves telemetry correlation and stays mandatory', () => {
  const bridge = read(join(repoRoot, 'infra/modules/cloud-run-service/tests/runtime-contract.mjs'));
  const config = read(
    join(repoRoot, 'infra/modules/cloud-run-service/tests/runtime-contract.vitest.config.ts'),
  );
  const workflow = read(join(repoRoot, '.github/workflows/delivery.yml'));

  // The bridge consumes evaluated resources, and its allowed environment names
  // now include the quota project.
  assert.match(bridge, /GOOGLE_CLOUD_QUOTA_PROJECT/);
  assert.match(bridge, /tofu[\s\S]*?'test'/);

  // The telemetry correlation contract is explicitly included, alongside the
  // two rendering contracts it must not race for the global tracer provider.
  assert.match(config, /telemetry-correlation\.contract\.ts/);
  assert.match(config, /fileParallelism: false/);

  // The credential-free checks job still runs the bridge, and still proves it
  // reached no provider afterwards.
  const checks = workflow.match(/\n {2}checks:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n|$)/)?.[1];
  assert.ok(checks, 'the credential-free checks job must exist');
  assert.match(checks, /node infra\/modules\/cloud-run-service\/tests\/runtime-contract\.mjs/);
  assert.match(checks, /Prove the checks reached no provider/);
  assert.ok(!/id-token:|environment:/.test(checks), 'the bridge must stay credential-free');

  // The bridge's own refusal suite only runs once OpenTofu, a provider download and
  // a `tofu test` of two stacks have succeeded, which is a CI-only path. So the
  // extractor also has a provider-free test over a synthetic capture, and it has to
  // stay wired into the foundation checks: without it the bridge's expectation can
  // drift from what the stacks render and nothing notices until `main` is red, which
  // is what happened at 6142ed1.
  const scripts = read(join(repoRoot, 'package.json'));
  assert.match(
    scripts,
    /node --test tools\/\*\.test\.mjs infra\/modules\/cloud-run-service\/tests\/\*\.test\.mjs/,
    'the provider-free extractor test must run in verify:foundation',
  );
  assert.match(bridge, /export function extractRuntimeRendering/);
});

test('the narrow telemetry authentication exception is enforced, not merely described', () => {
  const eslintConfig = read(join(repoRoot, 'eslint.config.mjs'));
  const probes = read(join(repoRoot, 'tools/verify-boundary-rules.mjs'));

  // Exactly two files may import a provider authentication library.
  for (const allowed of [
    'apps/web/src/adapters/telemetry/workload-identity-headers.ts',
    'services/platform-api/src/adapters/telemetry/workload-identity-headers.ts',
  ]) {
    assert.ok(eslintConfig.includes(allowed), `${allowed} must be named as the exception`);
  }
  assert.match(eslintConfig, /google-auth-library/);
  assert.match(eslintConfig, /'googleapis', '@google-cloud\/\*\*'/);

  // Inner layers stay free of telemetry and of provider authentication.
  assert.match(
    eslintConfig,
    /Inner API layers must remain framework, telemetry-backend and provider-authentication independent/,
  );

  // The rules are proved by probes rather than trusted.
  for (const probe of [
    "import { Compute } from 'google-auth-library'",
    "import { trace } from '@opentelemetry/api'",
  ]) {
    assert.ok(probes.includes(probe), `a boundary probe must exercise ${probe}`);
  }
});

// ---------------------------------------------------------------------------
// The reviewed exposure file (#180).
//
// `allow_unauthenticated` has a committed source of truth now: a per-stack
// `exposure.tfvars`, admitted by a narrow `.gitignore` exception and passed by
// `-var-file` only when it exists. That file is the whole approval record, so
// its location and its content are pinned here — a tfvars that could carry
// anything else would be a second, unreviewed way to configure a service.
// ---------------------------------------------------------------------------

const EXPOSURE_FILE = 'exposure.tfvars';
const EXPOSURE_STACKS = ['api', 'web'];

// The second reviewed file, on the same terms (#241). The dispatched apply
// exposes only the digest, the source commit and the confirmation, so the one-time
// restore had no reviewed way to be told what to do at all. `restore.tfvars` is
// that record: one boolean and three container mount paths, nothing
// account-specific, pinned here exactly as the exposure file is.
const RESTORE_FILE = 'restore.tfvars';
const RESTORE_STACKS = ['engine-jobs'];
const RESTORE_MOUNT = '/mnt/stage';

/** Every committed tfvars this repository admits, as `<stack>/<file>`. */
const COMMITTED_TFVARS = [
  ...EXPOSURE_STACKS.map((stack) => `infra/stacks/${stack}/${EXPOSURE_FILE}`),
  ...RESTORE_STACKS.map((stack) => `infra/stacks/${stack}/${RESTORE_FILE}`),
];

test('no automatically loaded tfvars exists anywhere under infra', () => {
  // `tofu` loads `*.auto.tfvars` without being asked, including during
  // `tofu test`. One would flip the creating-plan assertions in every
  // `tests/exposure.tftest.hcl` while leaving them looking green, which is
  // exactly why the mechanism is a `-var-file` the workflow names explicitly.
  for (const path of infraFiles) {
    assert.ok(
      !basename(path).endsWith('.auto.tfvars'),
      `${relative(path)} would be loaded automatically, including by \`tofu test\`. Exposure is passed by an explicit \`-var-file\`, so the creating-plan tests stay true.`,
    );
  }
});

test('an exposure file may exist only where exposure is reviewable', () => {
  const found = infraFiles.filter((path) => basename(path) === EXPOSURE_FILE);
  const permitted = EXPOSURE_STACKS.map((stack) => join(infraRoot, 'stacks', stack, EXPOSURE_FILE));

  for (const path of found) {
    assert.ok(
      permitted.includes(path),
      `${relative(path)} is an exposure file outside the api and web stacks. Only those two declare a public invoker binding, so only those two can be exposed.`,
    );
  }
});

test('an exposure file, when one exists, may say only that the service is public', () => {
  // The file is an approval record, not a configuration surface. Anything else
  // in it would be a second way to change a service that no one reviewed as a
  // change to that service.
  for (const stack of EXPOSURE_STACKS) {
    const path = join(infraRoot, 'stacks', stack, EXPOSURE_FILE);
    if (!existsSync(path)) continue;

    const statements = read(path)
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
    assert.deepEqual(
      statements,
      ['allow_unauthenticated = true'],
      `${relative(path)} must contain exactly \`allow_unauthenticated = true\`, comments aside. An exposure file that can set anything else is not an exposure record.`,
    );
  }
});

test('the gitignore exception admits exactly the reviewed tfvars files', () => {
  const gitignore = read(join(repoRoot, '.gitignore'));
  assert.ok(
    gitignore.split('\n').includes('*.tfvars'),
    'every other tfvars must stay ignored; they carry account identifiers supplied at bootstrap',
  );

  const exceptions = gitignore
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line.startsWith('!') && line.includes('.tfvars') && !line.includes('example'),
    );
  assert.deepEqual(
    exceptions.sort(),
    COMMITTED_TFVARS.map((path) => `!${path}`).sort(),
    'the tfvars exception must name exactly the reviewed files, so no other tfvars can be committed by a wildcard',
  );
});

test('a restore inputs file may exist only in the stack that owns the one-time job', () => {
  const found = infraFiles.filter((path) => basename(path) === RESTORE_FILE);
  const permitted = RESTORE_STACKS.map((stack) => join(infraRoot, 'stacks', stack, RESTORE_FILE));

  for (const path of found) {
    assert.ok(
      permitted.includes(path),
      `${relative(path)} is a restore inputs file outside the engine-jobs stack. Only that stack declares the one-time job, so only that stack can be told what to restore.`,
    );
  }
});

test('the restore inputs file may say only what the one-time execution is asked to do', () => {
  // The same rule as the exposure file: an approval record, not a configuration
  // surface. Anything else in it would be a second way to change the job that
  // nobody reviewed as a change to the job.
  for (const stack of RESTORE_STACKS) {
    const path = join(infraRoot, 'stacks', stack, RESTORE_FILE);
    if (!existsSync(path)) continue;

    const body = read(path)
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');

    const assignments = [...body.matchAll(/^\s*([a-z_]+)\s*=/gmu)].map(([, name]) => name);
    assert.deepEqual(
      assignments.sort(),
      ['restore_arguments', 'restore_secret_binding_enabled'],
      `${relative(path)} must set exactly the secret-binding gate and the restore arguments. A restore inputs file that can set anything else is not a reviewed record of one execution.`,
    );

    assert.match(
      body,
      /restore_secret_binding_enabled\s*=\s*true/u,
      `${relative(path)} exists to turn the declared secret reference on; with it off the job cannot connect at all`,
    );

    // Every location is a path under the mount, so the file carries no bucket
    // name, project id or address of any kind (SECURITY.md). The bucket itself is
    // read from the platform stack's published contract.
    const values = [...body.matchAll(/"([^"]*)"/gu)].map(([, value]) => value);
    for (const value of values) {
      assert.ok(
        value.startsWith('--') || value.startsWith(`${RESTORE_MOUNT}/`),
        `${relative(path)} carries ${JSON.stringify(value)}, which is neither a flag nor a path under ${RESTORE_MOUNT}. A restore inputs file must hold no identifier.`,
      );
    }

    // The three locations the entrypoint requires, by the names it parses.
    for (const flag of ['--archive', '--workstation', '--evidence-dir']) {
      assert.ok(
        values.includes(flag),
        `${relative(path)} must pass ${flag}; the entrypoint parses that exact name`,
      );
    }
  }
});

test('the restore job mounts the staging bucket it is told to read from', () => {
  // The gap this closed: a container reads its image and its mounts and nothing
  // else, so arguments naming paths the job never mounts describe an execution
  // that cannot find its inputs (#241).
  const stack = readStack(join(infraRoot, 'stacks', 'engine-jobs'));
  assert.match(stack, /dynamic "volumes"/u, 'the job must declare the staged volume');
  assert.match(stack, /dynamic "volume_mounts"/u, 'the job must mount the staged volume');
  assert.match(
    stack,
    /contract_engine_restore_stage_bucket/u,
    'the bucket must be read from the platform contract, never written down here',
  );
  assert.ok(
    !/read_only\s*=\s*true/u.test(stack),
    'the mount is writable, because the job writes its evidence document back under --evidence-dir',
  );

  // The bucket and its grant live where they can actually be applied: the
  // deployer that runs a dispatched apply holds no Cloud Storage role at all.
  const platform = readStack(join(infraRoot, 'stacks', 'platform'));
  assert.match(platform, /resource "google_storage_bucket" "engine_restore_stage"/u);
  assert.match(
    platform,
    /resource "google_storage_bucket_iam_member" "engine_restore_stage_object_user"/u,
  );
  assert.match(platform, /uniform_bucket_level_access = true/u);
  assert.match(platform, /public_access_prevention {4}= "enforced"/u);
  assert.match(platform, /roles\/storage\.objectUser/u);
  assert.ok(
    !/resource "google_storage_bucket"/u.test(readStack(join(infraRoot, 'stacks', 'engine-jobs'))),
    'the engine-jobs stack must declare no bucket: its apply holds no Cloud Storage authority',
  );

  const deployerRoles = read(join(infraRoot, 'stacks', 'bootstrap', 'variables.tf')).match(
    /variable "deployer_roles"[\s\S]*?default = \[([\s\S]*?)\n {2}\]/,
  )?.[1];
  assert.ok(deployerRoles, 'the deployer roles must stay enumerated');
  assert.ok(
    !/roles\/storage\./u.test(deployerRoles),
    'the deployer must hold no Cloud Storage role; if that changes, the staging bucket could move to the release path and this reasoning needs revisiting',
  );
});
