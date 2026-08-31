#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

const readme = read('README.md');
const security = read('SECURITY.md');
const contributing = read('CONTRIBUTING.md');
const versionControl = read('docs/development/version-control.md');
const parallelWork = read('docs/development/parallel-work.md');
const delivery = read('docs/operations/delivery.md');
const agents = read('AGENTS.md');
const overview = read('docs/architecture/overview.md');
const coordinationDecision = read(
  'docs/architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md',
);
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

const normalizePolicyText = (source) => source.replaceAll(/[`*_]/g, '').replaceAll(/[ \t]+/g, ' ');

const delegatedAuthoritySubject = String.raw`\b(?:(?:an?|the)\s+)?(?:agents?|workload identit(?:y|ies)|automation)\b`;
const integrationExceptionAction =
  String.raw`(?:` +
  String.raw`(?:invoke|request|use)\b[^.!?\n]{0,100}\b(?:temporary\s+)?(?:sole-maintainer\s+)?(?:integration\s+)?exception\b` +
  String.raw`|(?:perform|make|execute|approve)\b[^.!?\n]{0,80}\b(?:exception\s+)?merge\b` +
  String.raw`)`;

const delegatedAuthorityPatterns = [
  new RegExp(
    String.raw`${delegatedAuthoritySubject}[^.!?\n]{0,80}\b(?:is|are)\s+(?:explicitly\s+)?authorized\s+to\s+${integrationExceptionAction}`,
    'i',
  ),
  new RegExp(
    String.raw`${delegatedAuthoritySubject}[^.!?\n]{0,80}\b(?:may|can)\s+${integrationExceptionAction}`,
    'i',
  ),
  new RegExp(
    String.raw`${delegatedAuthoritySubject}[^.!?\n]{0,80}\b(?:has|holds|receives|is granted)\s+[^.!?\n]{0,40}\b(?:exception|integration|merge)\s+authority\b`,
    'i',
  ),
  new RegExp(
    String.raw`${delegatedAuthoritySubject}[^.!?\n]{0,80}\b(?:has|holds|receives|is granted)\s+(?:the\s+)?(?:authority|permission)\s+to\s+${integrationExceptionAction}`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:(?:temporary\s+)?(?:sole-maintainer\s+)?(?:integration\s+)?exception|(?:exception|integration|merge)\s+authority)\b[^.!?\n]{0,80}\b(?:may|can|is authorized to)\s+be\s+delegated\s+to\s+${delegatedAuthoritySubject}`,
    'i',
  ),
];

const assertNoDelegatedIntegrationAuthority = (path, source) => {
  const normalized = normalizePolicyText(source);
  for (const pattern of delegatedAuthorityPatterns) {
    assert.doesNotMatch(
      normalized,
      pattern,
      `${path} must fail closed on explicit agent, workload-identity, or automation exception authority`,
    );
  }
};

const enabledAdministratorEnforcement =
  /\b(?:branch-protection\s+)?administrator enforcement\s+(?:(?:is|remains)\s+(?:(?:currently|now)\s+)?enabled|has\s+been\s+enabled)\b/i;
const deniedAdministratorEnforcementClaims = [
  /\b(?:does|do)\s+not\s+(?:state|claim|report|say|establish|indicate)\b[^.!?\n]{0,160}\badministrator enforcement\s+(?:is|remains)\s+(?:currently\s+|now\s+)?enabled\b/i,
  /\bmust\s+not\s+be\s+(?:read|treated|understood|interpreted)\s+as\s+(?:claiming|stating|reporting)\b[^.!?\n]{0,160}\badministrator enforcement\s+(?:is|remains)\s+(?:currently\s+|now\s+)?enabled\b/i,
  /\b(?:branch-protection\s+)?administrator enforcement\s+(?:is|remains)\s+not\s+enabled\b/i,
];

const assertNoEnabledAdministratorEnforcementClaim = (path, source) => {
  const statements = normalizePolicyText(source)
    .split(/(?<=[.!?])(?:\s+|$)|\n+/)
    .filter(Boolean);
  for (const statement of statements) {
    if (!enabledAdministratorEnforcement.test(statement)) continue;
    assert.ok(
      deniedAdministratorEnforcementClaims.some((pattern) => pattern.test(statement)),
      `${path} must not claim that branch-protection administrator enforcement is enabled: ${statement.trim()}`,
    );
  }
};

test('authority guards reject explicit widening and stale host truth', () => {
  assert.throws(
    () =>
      assertNoDelegatedIntegrationAuthority(
        'agent mutation',
        'An agent is authorized to invoke the temporary exception and perform the merge.',
      ),
    /must fail closed on explicit agent, workload-identity, or automation exception authority/,
  );
  assert.throws(
    () =>
      assertNoDelegatedIntegrationAuthority(
        'workload mutation',
        'A workload identity may use the sole-maintainer integration exception.',
      ),
    /must fail closed on explicit agent, workload-identity, or automation exception authority/,
  );
  assert.throws(
    () =>
      assertNoEnabledAdministratorEnforcementClaim(
        'host-truth mutation',
        'Branch-protection administrator enforcement is enabled.',
      ),
    /must not claim that branch-protection administrator enforcement is enabled/,
  );
  assert.doesNotThrow(() =>
    assertNoEnabledAdministratorEnforcementClaim(
      'retirement instruction',
      'Separately authorized host-control work enables branch-protection administrator enforcement.',
    ),
  );
});

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

  assert.match(versionControl, /organization membership reports only the maintainer/i);
  assert.match(versionControl, /two write-role outside collaborators/i);
  assert.match(versionControl, /Branch-protection administrator enforcement is currently disabled/);
  assert.match(versionControl, /active default-branch `stable` ruleset/i);
  assert.match(versionControl, /always-allowed `OrganizationAdmin` bypass actor/);
  for (const [path, source] of [
    ['AGENTS.md', agents],
    ['ADR-0011', coordinationDecision],
    ['docs/development/parallel-work.md', parallelWork],
    ['docs/development/version-control.md', versionControl],
    ['docs/operations/delivery.md', delivery],
  ]) {
    assertNoEnabledAdministratorEnforcementClaim(path, source);
    assert.doesNotMatch(
      source,
      /admin(?:istrator)? enforcement,\s+and no force push/i,
      `${path} must not retain the stale enabled-enforcement host summary`,
    );
  }
});

test('temporary integration exception is maintainer-only, exact-head, evidenced, and expiring', () => {
  const governedSources = [
    ['AGENTS.md', agents],
    ['ADR-0011', coordinationDecision],
    ['parallel-work.md', parallelWork],
    ['version-control.md', versionControl],
    ['delivery.md', delivery],
  ];

  for (const [path, source] of governedSources) {
    assert.match(source, /temporary sole-maintainer|temporary maintainer-only/i, path);
    assert.match(source, /maintainer[^\n]*personally|maintainer acting personally/i, path);
    assert.match(source, /agent|workload identity/i, path);
    assert.match(source, /provider/i, path);
    assert.match(source, /deploy/i, path);
  }

  assert.match(
    versionControl,
    /may waive \*\*only\*\* unavailable independent pull-request approval/,
  );
  assert.match(
    versionControl,
    /pull request remains the only route|Integration still occurs through a pull request/i,
  );
  assert.match(versionControl, /pull request's exact current head commit/);
  for (const context of [
    'affected projects and repository gates',
    'secret scan',
    'container platform-api',
    'container web',
  ]) {
    assert.ok(versionControl.includes(context), `temporary exception must retain ${context}`);
  }
  for (const conclusion of [
    'Stale',
    'missing',
    'pending',
    'cancelled',
    'skipped-required',
    'neutral-required',
    'failed',
  ]) {
    assert.ok(
      versionControl.includes(conclusion),
      `temporary exception must reject ${conclusion} check evidence`,
    );
  }

  assert.match(versionControl, /durable public evidence/i);
  assert.match(versionControl, /identifying the pull request/i);
  assert.match(versionControl, /exact qualifying head commit/i);
  assert.match(versionControl, /resulting `main` commit/i);
  assert.match(versionControl, /specific reason an independent eligible reviewer was unavailable/i);
  assert.match(versionControl, /required check's name, successful conclusion, and run reference/i);
  assert.match(versionControl, /expires immediately when a second maintainer-designated/i);
  assert.match(versionControl, /before provider delivery is enabled/i);
  assert.match(versionControl, /enables branch-protection administrator enforcement/i);
  assert.match(versionControl, /removes the active `OrganizationAdmin` bypass actor/i);
  assert.match(versionControl, /does not perform those setting changes/i);

  for (const [path, source] of governedSources) {
    assertNoDelegatedIntegrationAuthority(path, source);
  }

  assert.match(
    versionControl,
    /cannot invoke the exception, request that it be invoked, infer it/i,
  );
  assert.match(parallelWork, /does not establish that the exception applies/i);
  assert.match(parallelWork, /they do not recommend or ask for the exception/i);
  assert.match(delivery, /cannot invoke or request the temporary sole-maintainer exception/i);
  assert.match(coordinationDecision, /It cannot satisfy or bypass `prevent_self_review=true`/);
  assert.match(delivery, /policy forbids use of the environment administrator bypass/i);
  assert.match(versionControl, /never authorizes a failed-check bypass, direct or force push/i);
  assert.doesNotMatch(versionControl, /merge only after review and required checks/i);
  assert.doesNotMatch(versionControl, /A reviewed merge to protected `main`/i);

  assert.match(coordinationDecision, /^> \*\*Status:\*\* Working$/m);
  assert.doesNotMatch(coordinationDecision, /^## (?:Validation|Revisit when)$/m);
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
  assert.match(
    versionControl,
    /Repository and production-environment Actions variables and secrets are empty/,
  );
  assert.match(versionControl, /no provider delivery or Google Cloud federation exists/);
  assert.match(
    delivery,
    /Repository and production-environment Actions variables and secrets are empty/,
  );
  assert.match(delivery, /every provider path is mechanically blocked before authentication/);
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
