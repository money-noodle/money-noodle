#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

const readme = read('README.md');
const security = read('SECURITY.md');
const contributing = read('CONTRIBUTING.md');
const versionControl = read('docs/development/version-control.md');
const parallelWork = read('docs/development/parallel-work.md');
const parallelWorkTemplate = read('.github/ISSUE_TEMPLATE/parallel-work.yml');
const sharedPlanTemplate = read('.github/ISSUE_TEMPLATE/shared-plan.yml');
const coordinationSchema = read('tools/coordination-schema.mjs');
const coordinationClaim = read('tools/coordination-claim.mjs');
const coordinationLib = read('tools/coordination-lib.mjs');
const coordinationStatus = read('tools/coordination-status.mjs');
const coordinationWriter = read('tools/coordination-write.mjs');
const preCommitHook = read('.githooks/pre-commit');
const preMergeCommitHook = read('.githooks/pre-merge-commit');
const integrationHookTests = read('tools/integration-checkout-hooks.test.mjs');
const delivery = read('docs/operations/delivery.md');
const agents = read('AGENTS.md');
const docsIndex = read('docs/README.md');
const currentStatus = read('docs/current-status.md');
const overview = read('docs/architecture/overview.md');
const principles = read('docs/architecture/principles.md');
const dataIdentityObservability = read('docs/architecture/data-identity-observability.md');
const coordinationDecision = read(
  'docs/architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md',
);
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

const decisionDirectory = 'docs/architecture/decisions';
const decisionRecordPaths = readdirSync(decisionDirectory)
  .filter((name) => /^ADR-\d{4}.*\.md$/.test(name))
  .sort()
  .map((name) => `${decisionDirectory}/${name}`);
const decisionRecords = decisionRecordPaths.map((path) => [path, read(path)]);

const currentStatusRoutes = [
  ['README.md', readme, 'docs/current-status.md'],
  ['SECURITY.md', security, 'docs/current-status.md'],
  ['CONTRIBUTING.md', contributing, 'docs/current-status.md'],
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

const identityVocabularyPaths = [
  'AGENTS.md',
  '.github/workflows/delivery.yml',
  'docs/architecture/data-identity-observability.md',
  'docs/architecture/decisions/ADR-0002-openapi-and-generated-client.md',
  'docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md',
  'docs/architecture/decisions/ADR-0006-infrastructure-as-code-and-remote-state.md',
  'docs/architecture/decisions/ADR-0009-administrative-observability-surface.md',
  'docs/architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md',
  'docs/architecture/overview.md',
  'docs/architecture/principles.md',
  'docs/development/parallel-work.md',
  'docs/development/version-control.md',
  'docs/operations/deployment-composition.md',
  'infra/README.md',
  'infra/bootstrap.md',
];

const collectFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? collectFiles(path) : [path];
  });

const providerDialectPaths = collectFiles('infra').filter(
  (path) => path.endsWith('.tf') || path.endsWith('.tftest.hcl'),
);

const isProviderDialectPath = (path) =>
  path.startsWith('infra/') && (path.endsWith('.tf') || path.endsWith('.tftest.hcl'));

const vocabularyProse = (path, source) => {
  if (isProviderDialectPath(path)) return '';
  if (!path.endsWith('.md')) return source;

  const mermaid = [];
  const prose = source
    .replaceAll(/```([^\n]*)\n([\s\S]*?)```/g, (_match, info, body) => {
      if (info.trim().toLowerCase() === 'mermaid') mermaid.push(body);
      return '\n';
    })
    .replaceAll(/`[^`\n]*`/g, '')
    .replaceAll(/“[^”\n]*”|"[^"\n]*"/g, '');

  return `${prose}\n${mermaid.join('\n')}`;
};

const retiredApproverNoun = /\bapprovers?\b/i;
const machinePrincipalPatterns = [
  /\b(?:deployer|planner|reader|runtime|workload|ci|api|web|automation|machine)(?:[- ](?:workload|service account|identity)){0,2}[- ]principals?\b/i,
  /\b(?:service accounts?|workload identit(?:y|ies)|machine credentials?|automation)\s+(?:is|are|acts? as|serves? as|becomes?)\s+(?:an?\s+)?principals?\b/i,
  /\bprincipals?\s+(?:is|are|includes?|means?|identifies?)\s+[^.!?\n]{0,80}\b(?:service accounts?|workload identit(?:y|ies)|machine credentials?|automation)\b/i,
  /\bactor\s*\/\s*principal\b[^.!?\n]{0,100}\b(?:service accounts?|workload identit(?:y|ies)|machine credentials?)\b/i,
];

const assertIdentityVocabulary = (path, source) => {
  const prose = vocabularyProse(path, source);
  assert.doesNotMatch(prose, retiredApproverNoun, `${path} must not use the retired approver noun`);
  for (const pattern of machinePrincipalPatterns) {
    assert.doesNotMatch(
      prose,
      pattern,
      `${path} must not describe a machine identity as a principal`,
    );
  }
};

const normalizePolicyText = (source) => source.replaceAll(/[`*_]/g, '').replaceAll(/[ \t]+/g, ' ');

const supportedDecisionStatuses = new Set([
  'Proposed',
  'Working',
  'Settled',
  'Superseded',
  'Retired',
]);

const parseDecisionRecordHeader = (path, source) => {
  const headings = [...source.matchAll(/^# (ADR-\d{4}):/gm)];
  const statuses = [...source.matchAll(/^> \*\*Status:\*\* ([^\n]+)$/gm)];

  assert.equal(headings.length, 1, `${path} must contain exactly one ADR heading`);
  assert.equal(statuses.length, 1, `${path} must contain exactly one Status header`);

  const id = headings[0][1];
  const status = statuses[0][1].trim();
  assert.notEqual(status, 'Accepted', `${path} must not use obsolete Status: Accepted`);
  assert.ok(
    supportedDecisionStatuses.has(status),
    `${path} must use a lifecycle status from the decision index`,
  );

  return { id, path, status };
};

const parseDecisionIndexStatuses = (source) => {
  const statuses = new Map();
  const rows = source.matchAll(/^\| \[\`(ADR-\d{4})\`\]\([^)]+\) \| ([^|]+?) \|/gm);

  for (const [, id, rawStatus] of rows) {
    assert.ok(!statuses.has(id), `decision index must contain exactly one row for ${id}`);
    statuses.set(id, rawStatus.trim());
  }

  return statuses;
};

const assertDecisionLifecycleConsistency = (records, indexSource) => {
  const headers = records.map(([path, source]) => parseDecisionRecordHeader(path, source));
  const indexStatuses = parseDecisionIndexStatuses(indexSource);
  const recordIds = headers.map(({ id }) => id).sort();
  const indexIds = [...indexStatuses.keys()].sort();

  assert.deepEqual(indexIds, recordIds, 'decision index rows must match the ADR files exactly');
  for (const { id, path, status } of headers) {
    assert.equal(indexStatuses.get(id), status, `${path} status must match the decision index`);
  }

  return headers;
};

const normalizeDecisionAuthorityText = (source) =>
  normalizePolicyText(source.replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1'));

const assertNoProposedDecisionAuthority = (path, source, proposedIds) => {
  const normalized = normalizeDecisionAuthorityText(source);
  const lines = normalized.split('\n');

  for (const id of proposedIds) {
    const escapedId = id.replaceAll('-', '\\-');
    const authorityPatterns = [
      new RegExp(
        String.raw`\b(?:see|per|under|as (?:required|decided|established) by)\s+(?:the\s+)?(?:proposed\s+)?${escapedId}\b`,
        'i',
      ),
      new RegExp(
        String.raw`\b${escapedId}\b[^.!?\n]{0,120}\b(?:requires|mandates|authorizes|establishes|decides|supersedes)\b`,
        'i',
      ),
      new RegExp(
        String.raw`\b(?:implements?|follows?|is governed|required|mandated|authorized)\b[^.!?\n]{0,120}\b${escapedId}\b`,
        'i',
      ),
      new RegExp(
        String.raw`\b${escapedId}\b[^.!?\n]{0,120}\b(?:is|remains)\s+(?:accepted|authoritative|current authority)\b`,
        'i',
      ),
    ];

    for (const pattern of authorityPatterns) {
      assert.doesNotMatch(
        normalized,
        pattern,
        `${path} must not treat Proposed ${id} as current authority`,
      );
    }

    for (const line of lines.filter((candidate) => candidate.includes(id))) {
      const startsWithDirection =
        /^\s*(?:[-*]\s*)?(?:use|store|deploy|create|run|implement|require)\b/i.test(line);
      const preservesProposalCondition = new RegExp(
        String.raw`\b${escapedId}\b[^;\n]{0,120}\bseparately accepted\b[^;\n]{0,80}\bWorking\b`,
        'i',
      ).test(line);
      assert.ok(
        !startsWithDirection || preservesProposalCondition,
        `${path} must not direct implementation from Proposed ${id}`,
      );
    }
  }
};

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

const scopedPushAuthorityWideningPatterns = [
  /\bagents?\b[^.!?\n]{0,80}\bmay\s+(?:normally\s+)?push\s+(?:directly\s+to\s+)?(?:the\s+)?(?:integration branch|main|protected refs?|tags?)\b/i,
  /\bagents?\b[^.!?\n]{0,80}\bmay\s+push\s+another claim(?:'s)? branch\b/i,
  /\bagents?\b[^.!?\n]{0,80}\bmay\s+(?:force push|rewrite\s+(?:the\s+)?(?:branch\s+)?history)\b/i,
  /\bagents?\b[^.!?\n]{0,80}\bmay\s+(?:delete|remove)\s+(?:the\s+)?(?:branch|tag|ref|worktree)\b/i,
  /\b(?:prior|previous|earlier)\s+(?:CI\s+)?(?:run|evidence|verdict)\b[^.!?\n]{0,100}\bremains? valid\b[^.!?\n]{0,80}\b(?:after|despite)\s+(?:a\s+)?(?:branch[- ]?)?head change\b/i,
  /\b(?:pending|failed|cancelled|skipped|missing|unavailable)\s+(?:checks?|CI)\b[^.!?\n]{0,100}\b(?:may|can)\s+be\s+(?:reported|recorded|treated)\s+as\s+(?:passed|successful)\b/i,
  /\bagents?\b[^.!?\n]{0,80}\bmay\s+automatically\s+(?:clean up|delete|remove)\b/i,
  /\bagents?\b[^.!?\n]{0,100}\bmay\s+integrate\b[^.!?\n]{0,100}\bwithout\s+(?:a\s+)?pull request\b/i,
  /(?:\bissue\s+)?#40\b[^.!?\n]{0,100}\bauthorizes?\s+(?:publication|a push)\s+of\s+its\s+own\s+(?:implementation\s+)?branch\b/i,
];

const assertNoScopedPushAuthorityWidening = (path, source) => {
  const normalized = normalizePolicyText(source);
  for (const pattern of scopedPushAuthorityWideningPatterns) {
    assert.doesNotMatch(
      normalized,
      pattern,
      `${path} must preserve scoped owned-branch publication authority`,
    );
  }
};

const scopedPublicationContradictionPatterns = [
  /\ba permitted (?:owned-)?branch push\b[^.!?\n]{0,100}\b(?:does not|cannot|will not)\s+advance\b[^.!?\n]{0,100}\ban existing pull request(?:'s)? head\b/i,
  /\b(?:prior|previous)\s+(?:head\s+)?(?:checks? and reviews?|reviews? and checks?)\b[^.!?\n]{0,100}\bremain(?:s)? valid\b[^.!?\n]{0,120}\b(?:pull request head changes?|push advances?)\b/i,
  /\b(?:permitted\s+)?(?:owned-)?branch push\b[^.!?\n]{0,80}\bauthorizes?\b[^.!?\n]{0,100}\b(?:pull-request creation|pull-request metadata changes?|retargeting|closing|reopening|merging)\b/i,
];

const assertNoScopedPublicationContradiction = (path, source) => {
  const normalized = normalizePolicyText(source);
  for (const pattern of scopedPublicationContradictionPatterns) {
    assert.doesNotMatch(
      normalized,
      pattern,
      `${path} must preserve existing-pull-request advancement semantics`,
    );
  }
};

const checkpointRolloutContradictionPatterns = [
  /\bversion 1 header\b[^.!?\n]{0,100}\brequired\b[^.!?\n]{0,120}\bcheckpoint comments? created before (?:issue )?#40 (?:is|was) integrated\b/i,
  /\bhistorical checkpoint comments?\b[^.!?\n]{0,100}\b(?:must|may|should|are required to)\s+be\s+(?:edited|backfilled)\b/i,
  /\bhistorical checkpoint comments?\b[^.!?\n]{0,100}\b(?:invalid|not valid)\b[^.!?\n]{0,100}\b(?:without|unless)\b[^.!?\n]{0,60}\b(?:backfill|version 1 header)\b/i,
  /\bcurrent coordination status tooling\s+(?:currently\s+)?validates? every version 1 field\b/i,
  /\buntil (?:issue )?#41 integrates schema validation\b[^.!?\n]{0,140}\bmanual(?: and independent| independent)? verification\b[^.!?\n]{0,60}\b(?:is optional|is unnecessary|is not required)\b/i,
];

const assertNoCheckpointRolloutContradiction = (path, source) => {
  const normalized = normalizePolicyText(source);
  for (const pattern of checkpointRolloutContradictionPatterns) {
    assert.doesNotMatch(
      normalized,
      pattern,
      `${path} must preserve the prospective version 1 checkpoint rollout`,
    );
  }
};

const checkpointEvidenceHeader = `Checkpoint-Evidence-Version: 1
Checkpoint-State: proposed
Checkpoint-At: unclaimed
Checkpoint-Commit: uncommitted
Checkpoint-Changed-Path-Count: 0
Checkpoint-Checks-Verdict: unavailable
Checkpoint-CI-Run: unavailable
Checkpoint-CI-Commit: unavailable
Checkpoint-Security-Impact: unknown
Checkpoint-Tenant-Impact: unknown
Checkpoint-Provider-Impact: unknown
Checkpoint-Deployment-Impact: unknown
Checkpoint-Residual-Risk-Count: 0
Next-Action: unclaimed
Blockers: none`;

test('governed prose enforces principal, agent, and workload-identity vocabulary', () => {
  for (const path of identityVocabularyPaths) assertIdentityVocabulary(path, read(path));

  assert.throws(
    () => assertIdentityVocabulary('retired.md', 'A second approver must sign off.'),
    /must not use the retired approver noun/,
  );
  for (const mutation of [
    'The deployer principal applies the reviewed plan.',
    'A workload identity is a principal.',
    'Actor/principal: a human session, service account, or workload identity that acts.',
  ]) {
    assert.throws(
      () => assertIdentityVocabulary('machine-principal.md', mutation),
      /must not describe a machine identity as a principal/,
      mutation,
    );
  }

  for (const permitted of [
    'The maintainer acting personally as the human principal may approve the change.',
    'Approval requires an approving review from an eligible reviewer.',
    'The event envelope records the actor type and actor ID.',
  ]) {
    assert.doesNotThrow(() => assertIdentityVocabulary('permitted.md', permitted), permitted);
  }

  assert.doesNotThrow(() =>
    assertIdentityVocabulary(
      'literal.md',
      'The literal provider identifier is `principalSet://iam.googleapis.com/example`.',
    ),
  );
  assert.doesNotThrow(() =>
    assertIdentityVocabulary(
      'quotation.md',
      'The provider documentation says "a deployer principal may exchange the token".',
    ),
  );
  assert.ok(providerDialectPaths.length > 0, 'provider-dialect fixtures must exist');
  const providerDialect = providerDialectPaths.map((path) => read(path)).join('\n');
  assert.match(providerDialect, /principalSet:\/\/iam\.googleapis\.com/);
  assert.match(providerDialect, /Federated CI principal/);
  for (const path of providerDialectPaths) assertIdentityVocabulary(path, read(path));
  assert.doesNotThrow(() =>
    assertIdentityVocabulary(
      'infra/example.tf',
      'principal = "principalSet://iam.googleapis.com/example" # provider approver dialect',
    ),
  );

  assert.match(agents, /principal\*\* for a person holding authority/);
  assert.match(agents, /agent\*\* for an AI session executing bounded work/);
  assert.match(agents, /workload identity\*\* for a machine credential something runs as/);
  assert.match(dataIdentityObservability, /\*\*Actor:\*\* the event-envelope role/i);
  assert.match(
    datedComposition,
    /"eliminates the maintenance and security burden associated with service account keys"/,
  );
});

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

test('scoped branch publication stays claim-bound and checkpoint evidence stays exact', () => {
  const governedSources = [
    ['AGENTS.md', agents],
    ['ADR-0011', coordinationDecision],
    ['parallel-work.md', parallelWork],
    ['version-control.md', versionControl],
  ];

  for (const [path, source] of governedSources) {
    assertNoScopedPushAuthorityWidening(path, source);
    assertNoScopedPublicationContradiction(path, source);
    assertNoCheckpointRolloutContradiction(path, source);
    assert.match(source, /owned typed branch|typed branch it owns|registered typed branch/i, path);
    assert.match(source, /normal(?:, non-force| fast-forward| owned-branch)? push/i, path);
    assert.match(source, /pull requests? remain[^.!?\n]{0,120}(?:only|mandatory)/i, path);
    assert.match(source, /provider/i, path);
    assert.match(source, /deploy/i, path);
  }

  assert.match(parallelWork, /## Scoped owned-branch publication/);
  assert.match(parallelWork, /identical `Claim-Branch` name/);
  assert.match(parallelWork, /force push, `--force-with-lease`/);
  assert.match(
    parallelWork,
    /branch\/ref deletion and cleanup each require separate explicit authorization/i,
  );
  assert.match(
    versionControl,
    /does not authorize publication of the issue #40 implementation branch/i,
  );
  assert.match(
    coordinationDecision,
    /#40 implementation branch cannot use the rule it introduces/i,
  );
  assert.match(
    agents,
    /#40 implementation branch still requires separate explicit maintainer authorization/i,
  );

  assert.ok(
    parallelWorkTemplate.replaceAll(/^ {8}/gm, '').includes(checkpointEvidenceHeader),
    'parallel-work issue form must keep the exact evidence header fields and order',
  );
  assert.match(parallelWork, /Checkpoint-State.*equals `Claim-State`/i);
  assert.match(parallelWork, /derived from the actual comparison with the registered base/i);
  assert.match(
    parallelWork,
    /immutable full `https:\/\/github\.com\/money-noodle\/money-noodle\/actions\/runs\//,
  );
  assert.match(parallelWork, /`Checkpoint-CI-Commit`[^.!?\n]{0,160}equals `Checkpoint-Commit`/);
  assert.match(parallelWork, /branch-head change immediately invalidates the prior CI run/i);
  assert.match(parallelWork, /lists exactly the declared number of residual risks/i);
  assert.match(parallelWork, /permitted push automatically advances that pull request's head/i);
  assert.match(parallelWork, /new head immediately invalidates all prior checks and reviews/i);
  assert.match(
    parallelWork,
    /pull-request creation, metadata changes, retargeting, closing, reopening, and merging still require separate explicit authorization/i,
  );
  assert.match(
    parallelWork,
    /version 1 (?:evidence-)?header requirement is prospective[^.!?\n]{0,160}only to checkpoint comments created after issue #40 is integrated/i,
  );
  assert.match(
    parallelWork,
    /historical checkpoint comments remain immutable, valid evidence[^.!?\n]{0,180}do not edit[^.!?\n]{0,40}backfill/i,
  );
  assert.match(
    parallelWork,
    /integrated schema validation checks every field of a present version 1 evidence header/i,
  );
  assert.match(
    parallelWork,
    /syntactic and semantic validity alone does not prove that a run or impact claim is true/i,
  );
  for (const verdict of [
    'passed',
    'pending',
    'failed',
    'cancelled',
    'skipped',
    'missing',
    'unavailable',
    'mixed',
  ]) {
    assert.ok(
      checkpointEvidenceHeader.includes(verdict) ||
        parallelWorkTemplate.includes(`\`${verdict}\``) ||
        parallelWork.includes(`\`${verdict}\``),
      `checkpoint evidence must define the ${verdict} verdict`,
    );
  }

  for (const mutation of [
    'An agent may push the integration branch.',
    'An agent may push tags.',
    'An agent may force push the claimed branch.',
    'An agent may rewrite the branch history.',
    'An agent may delete the branch after review.',
    "An agent may push another claim's branch.",
    'Previous CI evidence remains valid after a head change.',
    'Pending checks may be reported as passed.',
    'An agent may automatically clean up the worktree.',
    'An agent may integrate directly without a pull request.',
    '#40 authorizes publication of its own implementation branch.',
  ]) {
    assert.throws(
      () => assertNoScopedPushAuthorityWidening('scoped-push mutation', mutation),
      /must preserve scoped owned-branch publication authority/,
      mutation,
    );
  }

  for (const mutation of [
    "A permitted branch push does not advance an existing pull request's head.",
    'Prior checks and reviews remain valid after the pull request head changes.',
    'A permitted branch push authorizes pull-request metadata changes.',
  ]) {
    assert.throws(
      () => assertNoScopedPublicationContradiction('pull-request advancement mutation', mutation),
      /must preserve existing-pull-request advancement semantics/,
      mutation,
    );
  }

  for (const mutation of [
    'The version 1 header is required for checkpoint comments created before issue #40 is integrated.',
    'Historical checkpoint comments must be backfilled.',
    'Historical checkpoint comments are invalid without a version 1 header.',
    'Current coordination status tooling validates every version 1 field.',
    'Until issue #41 integrates schema validation, manual and independent verification is optional.',
  ]) {
    assert.throws(
      () => assertNoCheckpointRolloutContradiction('checkpoint rollout mutation', mutation),
      /must preserve the prospective version 1 checkpoint rollout/,
      mutation,
    );
  }
});

test('registry v2 policy preserves mixed-version, non-atomic, and bootstrap boundaries', () => {
  for (const source of [parallelWorkTemplate, sharedPlanTemplate]) {
    assert.match(source, /Registry-Schema-Version/);
    assert.doesNotMatch(source, /Claim-Worktree|Shared-Hotspots|\/Users\//);
    assert.match(source, /required: true/);
  }
  assert.match(parallelWorkTemplate, /Claim-Host/);
  assert.match(parallelWorkTemplate, /Waiting-Since/);
  assert.match(parallelWorkTemplate, /Depends-On: none/);
  assert.match(parallelWorkTemplate, /Dependency-Notes: none/);

  assert.match(parallelWork, /body with no version field is an implicit version 1 record/i);
  assert.match(parallelWork, /untouched v1 and v2 records together/i);
  assert.match(parallelWork, /There is no bulk migration/i);
  assert.match(
    parallelWork,
    /historical comments are never migrated, edited, backfilled, or reinterpreted/i,
  );
  assert.match(parallelWork, /not[^.!?\n]{0,40}server-side compare-and-swap/i);
  assert.match(
    parallelWork,
    /Body, state-label, and append-only comment updates are separate non-atomic host surfaces/i,
  );
  assert.match(
    parallelWork,
    /final snapshot[^.!?\n]{0,160}body[^.!?\n]{0,80}label[^.!?\n]{0,80}comment/i,
  );
  assert.match(parallelWork, /complete` maps to `work:done`/i);
  assert.match(parallelWork, /single-record and explicitly invoked/i);
  assert.match(parallelWork, /performs no discovery[^.!?\n]{0,100}automatic migration/i);
  assert.match(parallelWork, /#42 and #44/);
  assert.match(parallelWork, /#41 bootstrap used deterministic fixtures and mocked host ports/i);
  assert.match(
    parallelWork,
    /integrated writer is now authoritative[^.!?\n]{0,140}remote-reference primitive/i,
  );

  assert.match(coordinationSchema, /CURRENT_REGISTRY_SCHEMA_VERSION = '2'/);
  assert.match(coordinationSchema, /unsupported-schema-version/);
  assert.match(coordinationSchema, /removed-v2-field/);
  assert.match(coordinationSchema, /missing-principal-liveness/);
  assert.doesNotMatch(coordinationSchema, /(?:create|delete|update)Ref|ls-remote|git push/);

  assert.match(coordinationWriter, /invalid-proposed-record/);
  assert.match(coordinationWriter, /updateBody/);
  assert.match(coordinationWriter, /replaceStateLabel/);
  assert.match(coordinationWriter, /addComment/);
  assert.match(coordinationWriter, /status: 'partial'/);
  assert.match(coordinationWriter, /--dry-run/);
  assert.match(coordinationWriter, /--apply/);
  assert.match(coordinationWriter, /createGitHubCliHost/);
  assert.match(coordinationWriter, /finalVerification/);
  assert.doesNotMatch(coordinationWriter, /spawnSync|gh issue|bulk migrat/i);
});

test('remote-reference claim authority is derived, create-only, and isolated from the general writer', () => {
  assert.match(coordinationClaim, /CANONICAL_REPOSITORY = 'money-noodle\/money-noodle'/);
  assert.match(coordinationSchema, /claim-v\$\{CLAIM_BRANCH_VERSION\}\/issue-/);
  assert.match(coordinationSchema, /\^claim-v\(\[1-9\]\\d\*\)\\\/issue-/);
  assert.match(coordinationSchema, /BOOTSTRAP_ISSUE = 42/);
  assert.match(coordinationSchema, /BOOTSTRAP_BRANCH = 'arch\/remote-reference-claim-primitive'/);
  assert.match(coordinationClaim, /statusCode !== 201/);
  assert.match(coordinationClaim, /error\?\.statusCode === 422/);
  assert.match(coordinationClaim, /create-ambiguous/);
  assert.match(coordinationClaim, /ref-present-parked-body/);
  assert.match(coordinationClaim, /claim-present-ref-absent/);
  assert.match(coordinationClaim, /writer-recovery/);
  assert.match(coordinationClaim, /ref-present-operation-mismatch/);
  assert.match(
    coordinationClaim,
    /matchingCheckpoints\.some\(\(\{ operationId: id \}\) => id !== operationId\)/,
  );
  assert.match(coordinationClaim, /claimSnapshotGuard\(claim, operationId\)\(\{ issue \}\)/);
  assert.match(coordinationClaim, /'--method', 'POST', `\$\{root\}\/git\/refs`/);
  assert.doesNotMatch(coordinationClaim, /'--method',\s*'(?:PATCH|PUT|DELETE)'/);
  assert.doesNotMatch(coordinationClaim, /git\s+push|force-push|force push|update-ref|delete-ref/i);

  assert.match(coordinationWriter, /initial-claim-requires-reference/);
  assert.match(coordinationWriter, /dedicated remote-reference claim module/);
  assert.match(coordinationWriter, /CLAIM_ESTABLISHMENT_AUTHORITY = Symbol/);
  assert.match(coordinationWriter, /missing-claim-snapshot-guard/);
  assert.match(coordinationWriter, /stage: 'claim-snapshot-guard'/);
  assert.match(coordinationClaim, /evaluateClaimCommentHistoryForBody/);
  assert.match(coordinationClaim, /claimSnapshotGuard: claimSnapshotGuard\(claim, operationId/);
  assert.match(coordinationLib, /export function evaluateClaimCommentHistoryForBody/);
  assert.doesNotMatch(coordinationWriter, /\/git\/refs|createClaimRef/);
  assert.doesNotMatch(coordinationLib, /from ['"]\.\/coordination-claim\.mjs['"]/);
  assert.doesNotMatch(coordinationStatus, /from ['"]\.\/coordination-claim\.mjs['"]/);

  const implementationSources = readdirSync('tools')
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => [`tools/${name}`, read(`tools/${name}`)]);
  const privilegedCallsites = implementationSources.filter(([, source]) =>
    source.includes('executeClaimEstablishmentWrite('),
  );
  assert.deepEqual(privilegedCallsites.map(([path]) => path).sort(), [
    'tools/coordination-claim.mjs',
    'tools/coordination-write.mjs',
  ]);
  const privilegedPreparationCallsites = implementationSources.filter(([, source]) =>
    source.includes('prepareClaimEstablishmentWrite('),
  );
  assert.deepEqual(privilegedPreparationCallsites.map(([path]) => path).sort(), [
    'tools/coordination-claim.mjs',
    'tools/coordination-write.mjs',
  ]);

  for (const source of [parallelWork, versionControl]) {
    assert.match(source, /claim-v1\/issue-<N>/);
    assert.match(source, /remote reference/i);
    assert.match(source, /no automatic (?:adoption|release|cleanup)|never adopt/i);
  }
});

test('integration checkout hooks, lifecycle status, bootstrap, and holds remain fail closed', () => {
  for (const [path, hook] of [
    ['.githooks/pre-commit', preCommitHook],
    ['.githooks/pre-merge-commit', preMergeCommitHook],
  ]) {
    assert.match(hook, /^#!\/bin\/sh\n/);
    assert.match(hook, /symbolic-ref --quiet HEAD/);
    assert.match(hook, /\[ "\$branch" = "refs\/heads\/main" \]/);
    assert.doesNotMatch(hook, /--short/);
    assert.equal(statSync(path).mode & 0o111, 0o111, `${path} must be executable`);
  }
  assert.doesNotMatch(integrationHookTests, /--no-verify/);
  assert.match(
    integrationHookTests,
    /git\(repository, \['config', '--local', 'core\.hooksPath', '\.githooks'\]\)/,
  );
  assert.match(integrationHookTests, /\['merge', '--ff-only'/);
  assert.match(integrationHookTests, /\['merge', '--no-edit'/);

  for (const state of [
    'mirrored',
    'fast-forward-lag',
    'local-ahead',
    'dirty-or-in-progress',
    'divergence',
    'unavailable',
  ])
    assert.match(coordinationLib, new RegExp(`['\"]${state}['\"]`));
  for (const state of [
    'matched',
    'local-ahead',
    'remote-ahead',
    'missing-branch',
    'divergence',
    'unavailable',
  ])
    assert.match(coordinationLib, new RegExp(`['\"]${state}['\"]`));
  assert.match(coordinationStatus, /--show-origin.*--show-scope.*core\.hooksPath/s);
  assert.match(coordinationStatus, /git\/ref\/\$\{fullRef\.slice\('refs\/'.length\)\}/);
  assert.match(coordinationStatus, /compare\/\$\{left\}\.\.\.\$\{right\}/);
  assert.match(coordinationStatus, /indexMode/);
  assert.match(coordinationStatus, /filesystem.*executable/s);
  assert.doesNotMatch(coordinationStatus, /\['ls-remote'/);
  assert.doesNotMatch(
    coordinationStatus,
    /(?:reset|update-ref|worktree', 'remove|config', '--local', 'core\.hooksPath)/,
  );

  assert.match(
    parallelWork,
    /git fetch --no-tags --no-write-fetch-head --no-recurse-submodules --no-auto-maintenance origin refs\/heads\/claim-v1\/issue-<N>:refs\/remotes\/origin\/claim-v1\/issue-<N>/,
  );
  assert.match(parallelWork, /five SHA surfaces to agree/i);
  assert.match(
    parallelWork,
    /direct-ref reads, local remote-tracking ref, local branch, and dedicated worktree HEAD/i,
  );
  assert.match(parallelWork, /exactly one clean unlocked non-prunable worktree/i);
  assert.match(parallelWork, /zero push/i);
  assert.match(parallelWork, /Every collision[^.!?\n]{0,180}preserved for principal review/i);
  assert.match(
    parallelWork,
    /bootstrap never retries, adopts, resets, repoints, force-updates, removes, or cleans/i,
  );
  assert.match(parallelWork, /test\/integration-pr-<PR>-base-<first-12-base-hex>-attempt-<N>/);
  assert.match(parallelWork, /## Integration hold evidence/);
  assert.match(
    parallelWork,
    /Integration-Hold-ID: pr-<PR>-head-<full-head>-base-<full-base>-attempt-<N>/,
  );
  assert.match(
    parallelWork,
    /Holds have no expiry, transfer, takeover, cleanup, or automatic release/,
  );
  assert.match(parallelWork, /#43 pull-request text must not use a closing keyword/i);
  assert.match(
    parallelWork,
    /#43 becomes principal-owned `work:blocked` with a strict `Waiting-Since` and no agent deadline/i,
  );
  assert.match(
    parallelWork,
    /activation followed by successful read-only activation and refusal verification permits `done`/i,
  );
  assert.match(
    versionControl,
    /sole integration checkout is the worktree on full symbolic ref `refs\/heads\/main`/,
  );
  assert.match(
    versionControl,
    /hooks are inert until separately authorized repository-local activation/i,
  );
});

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

test('contribution guidance requires ordinary independent review and denies elevated authority', () => {
  assert.match(contributing, /Public forks and pull-request code are untrusted/);
  assert.match(contributing, /read-only validation with no provider identity/);
  assert.match(contributing, /cannot deploy/);
  assert.match(contributing, /parallel-work claim protocol/);
  assert.match(contributing, /ordinary public contribution requires independent review/i);
  assert.match(contributing, /docs\/development\/version-control\.md/);
  assert.match(contributing, /temporary sole-maintainer exception belongs only to the maintainer/i);
  assert.match(contributing, /contributors and agents cannot invoke or request it/i);
  assertNoDelegatedIntegrationAuthority('CONTRIBUTING.md', contributing);
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
  assert.equal(currentStatusRoutes.length, 9, 'all nine governed entry points must route');
  const ownedMarkers = [
    /phairow\/money-noodle-private-archive/,
    /host-enforced full-SHA action pinning/i,
    /Strict `main` protection requires/,
    /branch-protection administrator enforcement is currently disabled/i,
    /active default-branch `stable` ruleset/i,
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
    assertNoEnabledAdministratorEnforcementClaim(path, source);
  }

  assert.match(currentStatus, /organization membership reports only the maintainer/i);
  assert.match(currentStatus, /two write-role outside collaborators/i);
  assert.match(currentStatus, /Branch-protection administrator enforcement is currently disabled/);
  assert.match(currentStatus, /active default-branch `stable` ruleset/i);
  assert.match(currentStatus, /always-allowed `OrganizationAdmin` bypass actor/);
  for (const [path, source] of [
    ['AGENTS.md', agents],
    ['ADR-0011', coordinationDecision],
    ['docs/current-status.md', currentStatus],
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
  assert.match(currentStatus, /prevent_self_review=true/);
  assert.match(currentStatus, /distinct eligible actor/);
  assert.match(currentStatus, /configured owner reviewer alone/);
  assert.match(currentStatus, /mechanically blocked/);
  assert.match(currentStatus, /repository provider\/apply variable or secret/);
  assert.match(currentStatus, /aquasecurity\/setup-trivy/);
});

test('ADR headers use lifecycle statuses and match every decision-index row', () => {
  const headers = assertDecisionLifecycleConsistency(decisionRecords, decisionIndex);
  const statuses = new Map(headers.map(({ id, status }) => [id, status]));

  for (let number = 1; number <= 7; number += 1) {
    const id = `ADR-${String(number).padStart(4, '0')}`;
    assert.equal(statuses.get(id), 'Working', `${id} must be Working`);
  }
  assert.equal(statuses.get('ADR-0008'), 'Proposed');
  assert.equal(statuses.get('ADR-0009'), 'Proposed');

  const acceptedMutation = decisionRecords.map(([path, source]) => [
    path,
    path.endsWith('ADR-0008-single-object-store.md')
      ? source.replace('> **Status:** Proposed', '> **Status:** Accepted')
      : source,
  ]);
  assert.throws(
    () => assertDecisionLifecycleConsistency(acceptedMutation, decisionIndex),
    /must not use obsolete Status: Accepted/,
  );

  const indexMismatch = decisionIndex.replace(
    '| [`ADR-0008`](ADR-0008-single-object-store.md) | Proposed |',
    '| [`ADR-0008`](ADR-0008-single-object-store.md) | Working |',
  );
  assert.notEqual(indexMismatch, decisionIndex, 'the index mismatch mutation must apply');
  assert.throws(
    () => assertDecisionLifecycleConsistency(decisionRecords, indexMismatch),
    /ADR-0008-single-object-store\.md status must match the decision index/,
  );
});

test('Proposed ADRs remain isolated from current architecture authority', () => {
  const headers = assertDecisionLifecycleConsistency(decisionRecords, decisionIndex);
  const proposedIds = headers.filter(({ status }) => status === 'Proposed').map(({ id }) => id);
  const currentArchitectureSources = [
    ['docs/architecture/data-identity-observability.md', dataIdentityObservability],
    ['docs/architecture/principles.md', principles],
    ['docs/architecture/overview.md', overview],
  ];

  for (const [path, source] of currentArchitectureSources) {
    assertNoProposedDecisionAuthority(path, source, proposedIds);
  }

  const historicalDirection = dataIdentityObservability.match(
    /^### Accepted historical and analytical direction$([\s\S]*?)^Open decisions include/m,
  );
  assert.ok(historicalDirection, 'the accepted historical direction must remain explicit');
  assert.match(historicalDirection[1], /Use Scaleway's S3-compatible object storage/);
  assert.match(historicalDirection[1], /accepted direction remains current/);
  assert.match(historicalDirection[1], /ADR-0008[\s\S]*separately accepted and becomes Working/);
  assert.doesNotMatch(historicalDirection[1], /^- Use Google Cloud Storage/m);

  for (const proposedSpendRequirement of [
    /month-to-date and forecast operating spend/i,
    /operating-cost-ceiling proximity/i,
    /free-tier\/quota headroom/i,
  ]) {
    assert.doesNotMatch(
      principles,
      proposedSpendRequirement,
      'accepted principles must not contain ADR-0009 spend-surface requirements',
    );
  }

  const proposedOverview = overview.match(
    /^### Proposal only: administrative observability \(not current architecture\)$([\s\S]*?)^## Source and deployment map$/m,
  );
  assert.ok(proposedOverview, 'overview must isolate the proposal-only diagram');
  assert.match(
    proposedOverview[1],
    /excluded from current architecture and the source\/deployment map/i,
  );
  assert.match(proposedOverview[1], /Neither record, its scope,[\s\S]*is accepted or implemented/);
  for (const node of ['topic', 'job', 'readModel', 'adminView']) {
    assert.match(
      proposedOverview[1],
      new RegExp(`^\\s*${node}\\["PROPOSED ONLY`, 'm'),
      `${node} must be labeled proposal-only`,
    );
  }
  const proposedEdges = proposedOverview[1].split('\n').filter((line) => line.includes('-.'));
  assert.equal(proposedEdges.length, 7, 'the proposal diagram must retain seven proposed flows');
  for (const edge of proposedEdges) {
    assert.match(edge, /PROPOSED FLOW/, `proposed edge must be labeled: ${edge.trim()}`);
  }
  assert.match(
    overview,
    /No row below is proposed\.[\s\S]{0,220}proposal-only subsection above[\s\S]{0,160}outside this map/i,
  );

  for (const [path, mutation] of [
    [
      'accepted-storage mutation',
      '- Use Google Cloud Storage for historical data. See proposed ADR-0008.',
    ],
    ['supersession mutation', 'ADR-0008 supersedes the current Scaleway direction.'],
    ['admin-requirement mutation', 'ADR-0009 requires an administrative spend surface.'],
    ['implementation mutation', 'Implement the ingestion job under ADR-0009.'],
  ]) {
    assert.throws(
      () => assertNoProposedDecisionAuthority(path, mutation, proposedIds),
      /must not (?:treat|direct implementation from) Proposed ADR-000[89]/,
      mutation,
    );
  }
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

test('current provider configuration remains absent and mechanically blocked', () => {
  assert.match(
    currentStatus,
    /Repository and production-environment Actions variables and secrets are empty/,
  );
  assert.match(currentStatus, /no Google Cloud project resource/i);
  assert.match(currentStatus, /provider delivery/);
  assert.match(
    currentStatus,
    /every provider path remains mechanically blocked before authentication/i,
  );
  assert.match(currentStatus, /aquasecurity\/setup-trivy/);
});

test('no workflow executes contributor source through pull_request_target', () => {
  for (const path of workflowPaths) {
    assert.doesNotMatch(read(path), /^\s*pull_request_target\s*:/m, path);
  }
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^permissions:\n\s+contents: read$/m);
  assert.doesNotMatch(ci, /id-token:\s*write/);
});
