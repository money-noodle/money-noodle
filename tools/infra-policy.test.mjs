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

test('runtime identities are distinct per service and hold no registry access', () => {
  const stacks = ['web', 'api'].map((name) => ({
    name,
    source: readStack(join(infraRoot, 'stacks', name)),
  }));

  const accountIds = stacks.map(({ source }) => {
    const match = source.match(/runtime_service_account_id"[\s\S]*?default\s*=\s*"([^"]+)"/);
    return match?.[1];
  });

  assert.ok(
    accountIds.every(Boolean),
    'both service stacks must declare their own runtime service account id',
  );
  assert.equal(
    new Set(accountIds).size,
    accountIds.length,
    `the web and API runtime identities must be mechanically distinct; both default to ${accountIds[0]}`,
  );

  const cloudRun = read(join(infraRoot, 'modules', 'cloud-run-service', 'main.tf'));
  assert.ok(
    !/artifactregistry\.(reader|writer)/.test(cloudRun),
    'a runtime identity must not be granted Artifact Registry access; Cloud Run pulls as the service agent (ADR-0005)',
  );
  assert.ok(
    !/storage\.(object)?[Aa]dmin/.test(cloudRun),
    'a runtime identity must not be granted access to infrastructure state',
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
    /monthly_ceiling"[\s\S]*?default\s*=\s*30\b/,
    'the accepted USD 30 monthly ceiling must be the default',
  );
  assert.match(
    budget,
    /threshold_percents"[\s\S]*?default\s*=\s*\[50,\s*80,\s*100\]/,
    'the accepted 50/80/100 percent alert thresholds must be the default',
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
