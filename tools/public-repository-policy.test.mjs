#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

const readme = read('README.md');
const security = read('SECURITY.md');
const contributing = read('CONTRIBUTING.md');
const versionControl = read('docs/development/version-control.md');
const delivery = read('docs/operations/delivery.md');
const agents = read('AGENTS.md');
const docsIndex = read('docs/README.md');
const currentStatus = read('docs/current-status.md');
const overview = read('docs/architecture/overview.md');
const trustDecision = read(
  'docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md',
);
const decisionIndex = read('docs/architecture/decisions/README.md');
const engineering = read('docs/engineering/standards.md');
const objectStoreDecision = read('docs/architecture/decisions/ADR-0008-single-object-store.md');
const adminSurfaceDecision = read(
  'docs/architecture/decisions/ADR-0009-administrative-observability-surface.md',
);
const datedComposition = read('docs/operations/deployment-composition.md');

const currentStatusRoutes = [
  ['README.md', readme, 'docs/current-status.md'],
  ['AGENTS.md', agents, 'docs/current-status.md'],
  ['docs/README.md', docsIndex, 'current-status.md'],
  ['docs/development/version-control.md', versionControl, '../current-status.md'],
  ['docs/operations/delivery.md', delivery, '../current-status.md'],
  ['docs/architecture/overview.md', overview, '../current-status.md'],
  [
    'docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md',
    trustDecision,
    '../../current-status.md',
  ],
];

const workflowPaths = ['.github/workflows/ci.yml', '.github/workflows/delivery.yml'];

test('public entry points route to security, contribution, architecture, and license owners', () => {
  for (const target of [
    'SECURITY.md',
    'CONTRIBUTING.md',
    'docs/architecture/overview.md',
    'docs/current-status.md',
    'LICENSE',
  ]) {
    assert.ok(readme.includes(`](${target})`), `README.md must route readers to ${target}`);
  }
  assert.match(readme, /no real-money authority/i);
  assert.match(currentStatus, /nothing here has been remotely deployed/i);
});

test('security reporting is enabled, private, and requires revocation before history cleanup', () => {
  assert.match(security, /private vulnerability reporting is enabled/i);
  assert.match(security, /github\.com\/money-noodle\/money-noodle\/security\/advisories\/new/);
  assert.match(security, /never (?:put|open)[\s\S]*public issue/i);
  const revoke = security.search(/Revoke or rotate/i);
  const cleanup = security.search(/history cleanup/i);
  assert.ok(revoke >= 0 && cleanup > revoke, 'revocation or rotation must precede history cleanup');
});

test('contribution guidance denies public pull requests provider and deployment authority', () => {
  assert.match(contributing, /Public forks and pull-request code are untrusted/);
  assert.match(contributing, /read-only validation with no provider identity/);
  assert.match(contributing, /cannot deploy/);
  assert.match(contributing, /parallel-work claim protocol/);
});

test('current source identity is organization-owned while the personal archive stays distinct', () => {
  assert.match(currentStatus, /money-noodle\/money-noodle/);
  assert.doesNotMatch(currentStatus, /phairow\/money-noodle(?!-private-archive)/);
  assert.match(currentStatus, /phairow\/money-noodle-private-archive/);
  assert.match(
    currentStatus,
    /github\.com\/money-noodle\/money-noodle\/actions\/runs\/33292553091/,
  );
  assert.match(datedComposition, /As-of evidence \(2026-08-29, not current repository truth\)/);
  assert.match(datedComposition, /phairow\/money-noodle` was \*\*private\*\*/);
});

test('current repository truth has one owner and every governed entry point routes to it', () => {
  const ownedMarkers = [
    /phairow\/money-noodle-private-archive/,
    /host-enforced full-SHA action pinning/i,
    /`affected projects and repository gates`/,
    /`secret scan`/,
    /`container platform-api`/,
    /`container web`/,
    /prevent_self_review=true/,
    /mechanically blocked/,
    /aquasecurity\/setup-trivy/,
  ];

  for (const [path, source, target] of currentStatusRoutes) {
    assert.ok(source.includes(`](${target})`), `${path} must route to ${target}`);
    for (const marker of ownedMarkers) {
      assert.doesNotMatch(source, marker, `${path} must route rather than restate ${marker}`);
    }
  }

  for (const marker of ownedMarkers) assert.match(currentStatus, marker);
});

test('current repository truth names host security controls and rejects stale contradictions', () => {
  for (const context of [
    'affected projects and repository gates',
    'secret scan',
    'container platform-api',
    'container web',
  ]) {
    assert.ok(currentStatus.includes(context), `current status must name ${context}`);
  }
  assert.match(currentStatus, /host-enforced full-SHA action pinning/i);
  assert.match(currentStatus, /secret scanning/i);
  assert.match(currentStatus, /push protection/i);

  for (const [path, source] of [
    ...currentStatusRoutes.map(([path, source]) => [path, source]),
    ['docs/current-status.md', currentStatus],
  ]) {
    assert.doesNotMatch(source, /source repository is still private/i, path);
    assert.doesNotMatch(source, /GitHub Actions are currently disabled/i, path);
    assert.doesNotMatch(source, /intentionally becoming public/i, path);
    assert.doesNotMatch(
      source,
      /required (?:CI )?(?:status )?checks? (?:are )?not yet attached/i,
      path,
    );
    assert.doesNotMatch(source, /required check names still need attaching/i, path);
  }
});

test('current production truth requires distinct approval and remains mechanically blocked', () => {
  assert.match(currentStatus, /prevent_self_review=true/);
  assert.match(currentStatus, /distinct eligible actor/);
  assert.match(currentStatus, /configured owner reviewer alone/);
  assert.match(currentStatus, /mechanically blocked/);
  assert.match(currentStatus, /repository provider\/apply variable or secret/);
  assert.match(currentStatus, /aquasecurity\/setup-trivy/);
});

test('workflow and decision lifecycle each have one authority and proposed records are trimmed', () => {
  assert.match(engineering, /^## Implementation workflow$/m);
  assert.match(agents, /docs\/engineering\/standards\.md#implementation-workflow/);
  assert.doesNotMatch(agents, /^\d+\. (?:Inspect|Update|Resolve|Implement|Add|Run|Validate)/m);

  assert.match(decisionIndex, /^## Lifecycle$/m);
  assert.match(docsIndex, /architecture\/decisions\/README\.md#lifecycle/);
  assert.doesNotMatch(docsIndex, /^- \*\*(?:Proposed|Working|Settled)/m);
  assert.doesNotMatch(decisionIndex, /still carry `## Validation`/);
  for (const source of [objectStoreDecision, adminSurfaceDecision]) {
    assert.doesNotMatch(source, /^## (?:Validation|Revisit when)$/m);
  }
});

test('no workflow executes contributor source through pull_request_target', () => {
  for (const path of workflowPaths) {
    assert.doesNotMatch(read(path), /^\s*pull_request_target\s*:/m, path);
  }
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^permissions:\n\s+contents: read$/m);
  assert.doesNotMatch(ci, /id-token:\s*write/);
});
