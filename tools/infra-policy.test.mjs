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
  const grant = cloudRunModule.match(
    /resource "google_project_iam_member" "runtime_telemetry"[\s\S]*?\n}/,
  )?.[0];
  assert.ok(grant, 'the telemetry IAM grant must still exist');

  // Google's Telemetry API documentation requires these two alongside the
  // classic per-signal roles. Desired configuration only: this grants nothing.
  for (const role of [
    'roles/cloudtrace.agent',
    'roles/logging.logWriter',
    'roles/monitoring.metricWriter',
    'roles/serviceusage.serviceUsageConsumer',
    'roles/telemetry.writer',
  ]) {
    assert.ok(grant.includes(role), `the runtime identity must declare ${role}`);
  }

  // Writing telemetry is not reading anything, and not deploying anything.
  for (const forbidden of [
    'roles/run.admin',
    'roles/storage.admin',
    'roles/owner',
    'roles/editor',
  ]) {
    assert.ok(!grant.includes(forbidden), `the runtime identity must never hold ${forbidden}`);
  }
  // The grant disappears entirely when telemetry is not configured.
  assert.match(grant, /var\.telemetry_endpoint == null \? toset\(\[\]\)/);
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
