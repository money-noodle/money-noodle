import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import prettier from 'prettier';

import {
  BOOTSTRAP_BRANCH,
  CHECKPOINT_EVIDENCE_FIELDS,
  V2_PORTABLE_CLAIM_FIELDS,
  claimBranchForIssue,
  claimRefForIssue,
  normalizeScopePaths,
  parseReservedClaimBranch,
  parseReservedClaimRef,
  parseStrictDependencies,
  registryVersion,
  structuredRecord,
  validateCheckpointComment,
  validateClaimBranch,
  validatePlanBody,
  validateWorkItemBody,
} from './coordination-schema.mjs';

const COMMIT = 'a'.repeat(40);
const RUN = 'https://github.com/money-noodle/money-noodle/actions/runs/123';

test('the pure schema boundary owns deterministic claim branch derivation and parsing', () => {
  assert.equal(claimBranchForIssue(73), 'claim-v1/issue-73');
  assert.equal(claimRefForIssue(73), 'refs/heads/claim-v1/issue-73');
  assert.deepEqual(parseReservedClaimBranch('claim-v1/issue-73'), {
    status: 'supported',
    branch: 'claim-v1/issue-73',
    version: 1,
    issueNumber: 73,
    ref: 'refs/heads/claim-v1/issue-73',
  });
  assert.equal(parseReservedClaimRef('refs/heads/claim-v2/issue-73').status, 'unsupported');
  assert.equal(
    validateClaimBranch({ issueNumber: 42, claimState: 'active', branch: BOOTSTRAP_BRANCH }).status,
    'bootstrap',
  );
  assert.equal(
    validateClaimBranch({
      issueNumber: 74,
      claimState: 'review',
      branch: 'claim-v1/issue-73',
    }).code,
    'claim-branch-issue-mismatch',
  );
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '73']) {
    assert.throws(() => claimBranchForIssue(invalid), RangeError);
  }
});

function proposedFields(overrides = {}) {
  return {
    'Registry-Schema-Version': '2',
    'Parent-Plan': '#27',
    'Scope-Paths': 'tools/**, docs/example.md',
    'Depends-On': 'none',
    'Dependency-Notes': 'none',
    'Integration-Owner': 'maintainer',
    'Reconciled-Claim-Comment-IDs': 'none',
    'Claim-State': 'proposed',
    'Claim-Harness': 'unclaimed',
    'Claim-Run-ID': 'unclaimed',
    'Claim-Agent': 'unclaimed',
    'Claim-Branch': 'unclaimed',
    'Claim-Host': 'unclaimed',
    'Claimed-At': 'unclaimed',
    'Check-In-By': 'unclaimed',
    'Waiting-Since': 'unclaimed',
    'Checkpoint-Evidence-Version': '1',
    'Checkpoint-State': 'proposed',
    'Checkpoint-At': 'unclaimed',
    'Checkpoint-Commit': 'uncommitted',
    'Checkpoint-Changed-Path-Count': '0',
    'Checkpoint-Checks-Verdict': 'unavailable',
    'Checkpoint-CI-Run': 'unavailable',
    'Checkpoint-CI-Commit': 'unavailable',
    'Checkpoint-Security-Impact': 'unknown',
    'Checkpoint-Tenant-Impact': 'unknown',
    'Checkpoint-Provider-Impact': 'unknown',
    'Checkpoint-Deployment-Impact': 'unknown',
    'Checkpoint-Residual-Risk-Count': '0',
    'Next-Action': 'unclaimed',
    Blockers: 'none',
    ...overrides,
  };
}

function bodyFrom(fields) {
  return `${Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')}\n`;
}

function activeFields(overrides = {}) {
  return proposedFields({
    'Claim-State': 'active',
    'Claim-Harness': 'pi',
    'Claim-Run-ID': 'run-41',
    'Claim-Agent': 'schema-test',
    'Claim-Branch': 'arch/schema-test',
    'Claim-Host': 'runner-01',
    'Claimed-At': '2026-09-01T00:00:00Z',
    'Check-In-By': '2026-09-01T06:00:00Z',
    'Checkpoint-State': 'active',
    'Checkpoint-At': '2026-09-01T01:00:00Z',
    'Checkpoint-Commit': COMMIT,
    'Checkpoint-Changed-Path-Count': '3',
    'Checkpoint-Checks-Verdict': 'passed',
    'Checkpoint-CI-Run': RUN,
    'Checkpoint-CI-Commit': COMMIT,
    'Checkpoint-Security-Impact': 'present',
    'Checkpoint-Tenant-Impact': 'none',
    'Checkpoint-Provider-Impact': 'none',
    'Checkpoint-Deployment-Impact': 'none',
    'Checkpoint-Residual-Risk-Count': '1',
    'Next-Action': 'request review',
    ...overrides,
  });
}

function errorCodes(result) {
  return result.errors.map(({ code }) => code);
}

test('version dispatch treats unversioned records as implicit v1 and exposes unsupported versions', () => {
  assert.deepEqual(registryVersion('Claim-State: ready\n'), {
    version: '1',
    explicit: false,
    status: 'supported',
    errors: [],
  });
  assert.equal(registryVersion('Registry-Schema-Version: 2\n').version, '2');
  const unsupported = validateWorkItemBody('Registry-Schema-Version: 99\nClaim-State: ready\n');
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.status, 'unsupported');
  assert.deepEqual(errorCodes(unsupported), ['unsupported-schema-version']);
});

test('mixed implicit-v1 and explicit-v2 records remain independently readable', () => {
  const implicit = validateWorkItemBody('Claim-State: ready\nDepends-On: none\n');
  const explicit = validateWorkItemBody(bodyFrom(proposedFields()));

  assert.equal(implicit.valid, true);
  assert.equal(implicit.version, '1');
  assert.equal(explicit.valid, true);
  assert.equal(explicit.version, '2');
});

test('issue-form headings and field blocks are parsed without hiding collisions', () => {
  const formBody = [
    '### Registry-Schema-Version',
    '',
    '2',
    '',
    '### Scope-Paths',
    '',
    'tools/**',
    'docs/example.md',
    '',
    '### Ownership and liveness',
    '',
    'Claim-State: proposed',
  ].join('\n');
  const record = structuredRecord(formBody, [
    'Registry-Schema-Version',
    'Scope-Paths',
    'Claim-State',
  ]);

  assert.equal(record.fields['Registry-Schema-Version'], '2');
  assert.equal(record.fields['Scope-Paths'], 'tools/**\ndocs/example.md');
  assert.equal(record.fields['Claim-State'], 'proposed');
  const duplicate = structuredRecord(`${formBody}\nClaim-State: ready\n`, ['Claim-State']);
  assert.deepEqual(duplicate.duplicates, ['Claim-State']);
});

test('a deterministic body emitted by the parallel-work Issue Form validates as complete v2', () => {
  const fields = proposedFields();
  const formBody = [
    '### Registry-Schema-Version',
    '',
    fields['Registry-Schema-Version'],
    '',
    '### Parent-Plan',
    '',
    fields['Parent-Plan'],
    '',
    '### Outcome and scope',
    '',
    'One bounded test outcome.',
    '',
    '### Scope-Paths',
    '',
    'tools/**',
    'docs/example.md',
    '',
    '### Dependencies and integration',
    '',
    ...['Depends-On', 'Dependency-Notes', 'Integration-Owner', 'Reconciled-Claim-Comment-IDs'].map(
      (field) => `${field}: ${fields[field]}`,
    ),
    '',
    '### Claim-State',
    '',
    fields['Claim-State'],
    '',
    '### Claim-Harness',
    '',
    fields['Claim-Harness'],
    '',
    '### Ownership and liveness',
    '',
    ...[
      'Claim-Run-ID',
      'Claim-Agent',
      'Claim-Branch',
      'Claim-Host',
      'Claimed-At',
      'Check-In-By',
      'Waiting-Since',
    ].map((field) => `${field}: ${fields[field]}`),
    '',
    '### Current checkpoint',
    '',
    ...CHECKPOINT_EVIDENCE_FIELDS.map((field) => `${field}: ${fields[field]}`),
  ].join('\n');
  const result = validateWorkItemBody(formBody);

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.normalized.scopePaths, ['tools/**', 'docs/example.md']);
});

test('v2 requires every field and rejects removed local-path and hotspot fields', () => {
  const missing = validateWorkItemBody(
    bodyFrom(proposedFields({ 'Dependency-Notes': undefined })).replace(
      'Dependency-Notes: undefined\n',
      '',
    ),
  );
  assert.equal(missing.valid, false);
  assert(errorCodes(missing).includes('missing-field'));

  for (const removed of ['Claim-Worktree: /tmp/local', 'Shared-Hotspots: tools/**']) {
    const result = validateWorkItemBody(`${bodyFrom(proposedFields())}${removed}\n`);
    assert.equal(result.valid, false, removed);
    assert(errorCodes(result).includes('removed-v2-field'), removed);
  }
});

test('strict dependencies separate issue references from dependency prose', () => {
  assert.deepEqual(parseStrictDependencies('none'), { status: 'clear', numbers: [] });
  assert.deepEqual(parseStrictDependencies('#2, #7'), { status: 'declared', numbers: [2, 7] });
  for (const invalid of ['#2 #7', '#2, decision pending', '#2,#7', '#2, #2', 'issue 2']) {
    assert.equal(parseStrictDependencies(invalid).status, 'invalid', invalid);
    const result = validateWorkItemBody(bodyFrom(proposedFields({ 'Depends-On': invalid })));
    assert(errorCodes(result).includes('invalid-dependencies'), invalid);
  }
});

test('scope paths are portable repository paths or explicit none, never local paths', () => {
  assert.deepEqual(normalizeScopePaths('tools/**\ndocs/example.md'), {
    status: 'declared',
    paths: ['tools/**', 'docs/example.md'],
  });
  assert.deepEqual(normalizeScopePaths('none'), { status: 'none', paths: [] });
  for (const invalid of [
    '/Users/example/worktree',
    'C:/Users/example/worktree',
    '~/worktree',
    '../secret',
    './tools',
    'tools//example.mjs',
    'tools/a, tools/a',
    'path with spaces',
  ]) {
    assert.equal(normalizeScopePaths(invalid).status, 'invalid', invalid);
  }
});

test('agent-owned, principal-waiting, parked, and terminal liveness combinations fail closed', () => {
  assert.equal(validateWorkItemBody(bodyFrom(activeFields())).valid, true);

  const blocked = proposedFields({
    'Claim-State': 'blocked',
    'Waiting-Since': '2026-09-01T02:00:00Z',
    'Checkpoint-State': 'blocked',
    'Checkpoint-At': '2026-09-01T02:00:00Z',
  });
  assert.equal(validateWorkItemBody(bodyFrom(blocked)).valid, true);

  const cases = [
    [activeFields({ 'Check-In-By': 'unclaimed' }), 'missing-agent-liveness'],
    [activeFields({ 'Waiting-Since': '2026-09-01T01:00:00Z' }), 'mixed-liveness'],
    [{ ...blocked, 'Waiting-Since': 'unclaimed' }, 'missing-principal-liveness'],
    [{ ...blocked, 'Claim-Agent': 'agent' }, 'blocked-agent-ownership'],
    [proposedFields({ 'Check-In-By': '2026-09-01T03:00:00Z' }), 'parked-liveness'],
    [
      proposedFields({
        'Claim-State': 'done',
        'Claim-Agent': 'only-one-field',
        'Checkpoint-State': 'done',
        'Checkpoint-At': '2026-09-01T03:00:00Z',
      }),
      'partial-terminal-ownership',
    ],
  ];
  for (const [fields, code] of cases) {
    assert(errorCodes(validateWorkItemBody(bodyFrom(fields))).includes(code), code);
  }
});

test('checkpoint evidence validates exact state, commit, run, verdict, impacts, and counts', () => {
  const mutations = [
    [{ 'Checkpoint-State': 'review' }, 'checkpoint-state-mismatch'],
    [{ 'Checkpoint-Commit': 'abc' }, 'invalid-checkpoint-commit'],
    [{ 'Checkpoint-Changed-Path-Count': '-1' }, 'invalid-changed-path-count'],
    [{ 'Checkpoint-Checks-Verdict': 'green' }, 'invalid-checks-verdict'],
    [{ 'Checkpoint-CI-Commit': 'b'.repeat(40) }, 'ci-commit-mismatch'],
    [
      { 'Checkpoint-CI-Run': 'unavailable', 'Checkpoint-CI-Commit': 'unavailable' },
      'passed-without-ci',
    ],
    [{ 'Checkpoint-Security-Impact': 'maybe' }, 'invalid-impact'],
    [{ 'Checkpoint-Residual-Risk-Count': 'one' }, 'invalid-residual-risk-count'],
  ];
  for (const [override, code] of mutations) {
    const result = validateWorkItemBody(bodyFrom(activeFields(override)));
    assert(errorCodes(result).includes(code), code);
  }
});

test('complete v2 checkpoint comments match every ownership and evidence field', () => {
  const body = bodyFrom(activeFields());
  const work = validateWorkItemBody(body);
  const comment = bodyFrom(
    Object.fromEntries(
      [...V2_PORTABLE_CLAIM_FIELDS, ...CHECKPOINT_EVIDENCE_FIELDS].map((field) => [
        field,
        work.fields[field],
      ]),
    ),
  );
  assert.equal(validateCheckpointComment(comment, work).valid, true);
  const mismatch = validateCheckpointComment(
    comment.replace('Claim-Host: runner-01', 'Claim-Host: other'),
    work,
  );
  assert.equal(mismatch.valid, false);
  assert(errorCodes(mismatch).includes('body-comment-mismatch'));

  const historicalV1 = comment
    .replace('Claim-Host: runner-01', 'Claim-Worktree: /historical/local/path')
    .replace('Waiting-Since: unclaimed\n', '');
  const historical = validateCheckpointComment(historicalV1, work);
  assert.equal(historical.valid, true);
  assert.equal(historical.applicable, false);
  assert.equal(historical.historicalContract, true);
  assert.equal(historical.contractVersion, '1');
});

test('plan records use implicit-v1 compatibility and explicit-v2 semantic validation', () => {
  assert.equal(validatePlanBody('Plan-State: active\n').version, '1');
  const valid = validatePlanBody(
    bodyFrom({
      'Registry-Schema-Version': '2',
      'Plan-State': 'active',
      'Integration-Owner': 'maintainer',
      'Last-Plan-Update': '2026-09-01T02:00:00Z',
    }),
  );
  assert.equal(valid.valid, true);
  const invalid = validatePlanBody(
    valid.fields ? bodyFrom({ ...valid.fields, 'Last-Plan-Update': 'today' }) : '',
  );
  assert(errorCodes(invalid).includes('invalid-plan-update'));
});

function assertIssueForm(path, expectedDropdowns) {
  const source = readFileSync(path, 'utf8');
  return prettier.format(source, { parser: 'yaml' }).then((formatted) => {
    assert.equal(typeof formatted, 'string');
    assert.doesNotMatch(
      source,
      /^about:/m,
      `${path} must use Issue Form keys, not config.yml front matter`,
    );
    assert.match(source, /^name:/m);
    assert.match(source, /^description:/m);
    assert.match(source, /^body:/m);
    const elements = [...source.matchAll(/^  - type: (\S+)$/gm)];
    assert(elements.length <= 10, `${path} exceeds GitHub's ten-element Issue Form limit`);
    const interactive = elements.filter((match) => match[1] !== 'markdown').length;
    assert.equal((source.match(/^      required: true$/gm) ?? []).length, interactive);
    for (const [label, option] of expectedDropdowns) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(
        source,
        new RegExp(
          `type: dropdown[\\s\\S]*?label: ${escaped}[\\s\\S]*?options:\\n        - "?${option}"?`,
        ),
        `${path} must host-constrain ${label}`,
      );
    }
    assert.doesNotMatch(source, /Claim-Worktree|Shared-Hotspots|\/Users\//);
  });
}

test('GitHub Issue Forms are valid YAML and maximize required and enumerated host constraints', async () => {
  await assertIssueForm('.github/ISSUE_TEMPLATE/parallel-work.yml', [
    ['Registry-Schema-Version', '2'],
    ['Claim-State', 'proposed'],
    ['Claim-Harness', 'unclaimed'],
  ]);
  await assertIssueForm('.github/ISSUE_TEMPLATE/shared-plan.yml', [
    ['Registry-Schema-Version', '2'],
    ['Plan-State', 'proposed'],
  ]);
});
