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

const exceptionControlWideningPatterns = [
  /\bstale approval\s+(?:still\s+)?(?:(?:may|can|does|will)\s+)?(?:qualif(?:y|ies)|satisf(?:y|ies)|count(?:s)?|remain(?:s)? valid)\b/i,
  /\b(?:temporary\s+)?(?:sole-maintainer\s+)?(?:integration\s+)?exception\b[^.!?\n]{0,120}\b(?:may|can|is authorized to)\s+(?:waive|bypass|skip|ignore)\b[^.!?\n]{0,80}\b(?:conversation resolution|stale-review dismissal|required checks?)\b/i,
  /\b(?:conversation resolution|stale-review dismissal|required checks?)\b[^.!?\n]{0,100}\b(?:may|can|is authorized to)\s+be\s+(?:waived|bypassed|skipped|ignored)\b/i,
  /\bhead change\b[^.!?\n]{0,80}\b(?:does not|need not|will not|cannot)\s+invalidate\b[^.!?\n]{0,100}\b(?:checks?|evidence|qualification)\b/i,
  /\b(?:previous|prior|earlier)\b[^.!?\n]{0,80}\b(?:checks?|evidence|qualification)\b[^.!?\n]{0,80}\bremain(?:s)? valid\b[^.!?\n]{0,80}\bhead change\b/i,
];

const assertNoExceptionControlWidening = (path, source) => {
  const normalized = normalizePolicyText(source);
  for (const pattern of exceptionControlWideningPatterns) {
    assert.doesNotMatch(
      normalized,
      pattern,
      `${path} must not widen the exception beyond its two approval subgates`,
    );
  }
};

const exceptionSemanticContradictionPatterns = [
  /\bunder\s+(?:the\s+)?(?:temporary\s+)?(?:sole-maintainer\s+)?(?:integration\s+)?exception\b[^.!?\n]{0,100}\b(?:required approving review|last-push approval)\s+(?:is|remains)\s+mandatory\b/i,
  /\b(?:temporary\s+)?(?:sole-maintainer\s+)?(?:integration\s+)?exception\b[^.!?\n]{0,120}\b(?:may|can|is authorized to)\s+merge\s+(?:(?:with|despite)\s+unresolved conversations?|while\s+conversations?\s+(?:remain(?:s)?|are)\s+unresolved)\b/i,
  /\b(?:head change|new head commit)\b\s+(?:still\s+)?(?:leaves?|keeps?)\b[^.!?\n]{0,120}\b(?:prior|previous|earlier)\b[^.!?\n]{0,120}\b(?:required[- ]checks?|exception evidence|qualification)\b[^.!?\n]{0,80}\b(?:qualified|valid)\b/i,
  /\b(?:temporary\s+)?(?:sole-maintainer\s+)?(?:integration\s+)?exception\b[^.!?\n]{0,120}\b(?:may|can|is authorized to)\s+(?:also\s+)?(?:waive|bypass|skip|ignore)\s+(?:the\s+)?(?:branch deletion protection|deletion protection|force-push protection|(?:any|another|additional|other) protections?)\b/i,
];

const assertNoExceptionSemanticContradiction = (path, source) => {
  const normalized = normalizePolicyText(source);
  for (const pattern of exceptionSemanticContradictionPatterns) {
    assert.doesNotMatch(
      normalized,
      pattern,
      `${path} must preserve the exact temporary-exception control semantics`,
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
  for (const mutation of [
    'A stale approval qualifies for the temporary exception.',
    'The temporary exception may waive conversation resolution.',
    'The temporary exception may waive stale-review dismissal.',
    'The temporary exception may waive required checks.',
    'A head change does not invalidate previous checks or exception evidence.',
    'Previous exception evidence remains valid after a head change.',
  ]) {
    assert.throws(
      () => assertNoExceptionControlWidening('control mutation', mutation),
      /must not widen the exception beyond its two approval subgates/,
      mutation,
    );
  }
  for (const mutation of [
    'Under the temporary exception, last-push approval is mandatory.',
    'The temporary exception can merge with unresolved conversations.',
    'A new head commit leaves prior required-check and exception evidence qualified.',
    'The temporary exception may also bypass branch deletion protection.',
  ]) {
    assert.throws(
      () => assertNoExceptionSemanticContradiction('semantic mutation', mutation),
      /must preserve the exact temporary-exception control semantics/,
      mutation,
    );
  }
  for (const permitted of [
    'Under the temporary exception, last-push approval is not mandatory.',
    'The temporary exception cannot merge with unresolved conversations.',
    'The temporary exception can merge only after all unresolved conversations are resolved.',
    'A new head commit does not leave prior required-check or exception evidence qualified.',
    'The temporary exception may not bypass branch deletion protection.',
    'Retirement work may make last-push approval mandatory after the temporary exception expires.',
    'Retirement work restores branch deletion protection after the temporary exception expires.',
  ]) {
    assert.doesNotThrow(
      () => assertNoExceptionSemanticContradiction('denial or retirement wording', permitted),
      permitted,
    );
  }
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
    assert.match(source, /required approving review/i, path);
    assert.match(source, /last-push approval/i, path);
    assert.match(source, /stale approval never qualifies/i, path);
    assert.match(source, /conversation resolution[^.!?\n]{0,160}(?:remains?|is) mandatory/i, path);
    assert.match(
      source,
      /(?:every|all four) required checks?[^.!?\n]{0,320}exact current head/i,
      path,
    );
    assert.match(
      source,
      /head change invalidates all previous required-check and exception-evidence qualification/i,
      path,
    );
    assert.doesNotMatch(
      source,
      /last-push(?:-control| approval| controls?)[^.!?\n]{0,120}\bremains? (?:mandatory|forbidden)/i,
      `${path} must not retain the superseded mandatory last-push subgate wording`,
    );
    assertNoExceptionControlWidening(path, source);
    assertNoExceptionSemanticContradiction(path, source);
  }

  assert.match(versionControl, /may waive \*\*only\*\* the unavailable independent-review gate/);
  assert.match(versionControl, /comprises exactly two approval subgates/i);
  assert.match(
    versionControl,
    /required approving review and last-push approval[\s\S]{0,120}may waive either or both/i,
  );
  for (const [path, source] of governedSources.slice(1)) {
    assert.match(source, /stale-review dismissal remains in force/i, path);
  }
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
  assert.match(versionControl, /approval subgate or subgates waived/i);
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
