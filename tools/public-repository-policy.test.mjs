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
const overview = read('docs/architecture/overview.md');
const trustDecision = read(
  'docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md',
);
const datedComposition = read('docs/operations/deployment-composition.md');

const currentTruthPaths = [
  'AGENTS.md',
  'docs/development/version-control.md',
  'docs/operations/delivery.md',
  'docs/architecture/overview.md',
];

const workflowPaths = ['.github/workflows/ci.yml', '.github/workflows/delivery.yml'];

test('public entry points route to security, contribution, architecture, and license owners', () => {
  for (const target of [
    'SECURITY.md',
    'CONTRIBUTING.md',
    'docs/architecture/overview.md',
    'LICENSE',
  ]) {
    assert.ok(readme.includes(`](${target})`), `README.md must route readers to ${target}`);
  }
  assert.match(readme, /no real-money authority/i);
  assert.match(readme, /Nothing here is remotely deployed yet/i);
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
  for (const [path, source] of [
    ['AGENTS.md', agents],
    ['docs/development/version-control.md', versionControl],
    ['docs/operations/delivery.md', delivery],
    ['docs/architecture/overview.md', overview],
    ['ADR-0005', trustDecision],
  ]) {
    assert.match(source, /money-noodle\/money-noodle/, `${path} must name the current source`);
    assert.doesNotMatch(
      source,
      /phairow\/money-noodle(?!-private-archive)/,
      `${path} must not name the transferred personal source`,
    );
    assert.match(
      source,
      /phairow\/money-noodle-private-archive/,
      `${path} must keep the private archive distinct`,
    );
  }
  assert.match(
    versionControl,
    /github\.com\/money-noodle\/money-noodle\/actions\/runs\/33292553091/,
  );
  assert.match(datedComposition, /As-of evidence \(2026-08-29, not current repository truth\)/);
  assert.match(datedComposition, /phairow\/money-noodle` was \*\*private\*\*/);
});

test('current repository truth names host security controls and strict required checks', () => {
  const requiredContexts = [
    'affected projects and repository gates',
    'secret scan',
    'container platform-api',
    'container web',
  ];
  for (const path of ['README.md', ...currentTruthPaths]) {
    const source = read(path);
    for (const context of requiredContexts) {
      assert.ok(source.includes(context), `${path} must name required context ${context}`);
    }
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
  for (const [path, source] of [
    ['README.md', readme],
    ['AGENTS.md', agents],
    ['docs/development/version-control.md', versionControl],
    ['docs/architecture/overview.md', overview],
  ]) {
    assert.match(source, /host-enforced full-SHA action pinning/i, path);
    assert.match(source, /secret scanning/i, path);
    assert.match(source, /push protection/i, path);
  }
});

test('current production truth requires distinct approval and remains mechanically blocked', () => {
  for (const [path, source] of [
    ['docs/development/version-control.md', versionControl],
    ['docs/operations/delivery.md', delivery],
  ]) {
    assert.match(source, /prevent_self_review=true/, path);
    assert.match(source, /distinct eligible actor/, path);
    assert.match(source, /configured owner reviewer alone/, path);
    assert.match(source, /mechanically blocked/, path);
  }
  assert.match(versionControl, /provider\/apply variable or secret/);
  assert.match(delivery, /No repository variable or secret is currently configured/);
  assert.match(versionControl, /aquasecurity\/setup-trivy/);
});

test('no workflow executes contributor source through pull_request_target', () => {
  for (const path of workflowPaths) {
    assert.doesNotMatch(read(path), /^\s*pull_request_target\s*:/m, path);
  }
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^permissions:\n\s+contents: read$/m);
  assert.doesNotMatch(ci, /id-token:\s*write/);
});
