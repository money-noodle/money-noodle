import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CHECKPOINT_EVIDENCE_FIELDS,
  V2_PLAN_FIELDS,
  V2_PORTABLE_CLAIM_FIELDS,
} from './coordination-schema.mjs';
import * as productionClaimModule from './coordination-claim.mjs';
import * as productionWriteModule from './coordination-write.mjs';

const instrumentedDirectory = mkdtempSync(join(tmpdir(), 'mn-writer-private-test-'));
const writerSourcePath = fileURLToPath(new URL('./coordination-write.mjs', import.meta.url));
let instrumentedSource = readFileSync(writerSourcePath, 'utf8').replaceAll(
  "'./coordination-schema.mjs'",
  JSON.stringify(new URL('./coordination-schema.mjs', import.meta.url).href),
);
instrumentedSource += `
export {
  executeCoordinationWriteWithDependencies as __testExecuteCoordinationWrite,
  runCoordinationWriteCliWithDependencies as __testRunCoordinationWriteCli,
};
`;
const instrumentedPath = join(instrumentedDirectory, 'coordination-write.instrumented.mjs');
writeFileSync(instrumentedPath, instrumentedSource);
process.once('exit', () => rmSync(instrumentedDirectory, { recursive: true, force: true }));
const instrumentedWriteModule = await import(pathToFileURL(instrumentedPath).href);
const {
  CoordinationWriteError,
  prepareCoordinationWrite,
  __testExecuteCoordinationWrite: executeCoordinationWrite,
  __testRunCoordinationWriteCli: runCoordinationWriteCli,
} = instrumentedWriteModule;
const {
  executeCoordinationWrite: executeProductionCoordinationWrite,
  runCoordinationWriteCli: runProductionCoordinationWriteCli,
} = productionWriteModule;
const WRITER_TOOL = fileURLToPath(new URL('./coordination-write.mjs', import.meta.url));

const COMMIT = 'c'.repeat(40);
const RUN = 'https://github.com/money-noodle/money-noodle/actions/runs/456';
const PLAN_V1_BODY = `## Outcome

Preserve the shared-plan narrative.

Plan-State: active
Integration-Owner: maintainer
Last-Plan-Update: 2026-09-01T01:00:00Z
`;

const V1_BODY = `## Parent shared plan

Parent-Plan: #27

## Outcome and scope

Preserve this narrative exactly.

## Dependencies and integration

Depends-On: none
Integration-Owner: maintainer
Shared-Hotspots: tools/**
Reconciled-Claim-Comment-IDs: none

## Portable claim

Claim-State: active
Claim-Harness: pi
Claim-Run-ID: run-41
Claim-Agent: writer-test
Claim-Branch: arch/writer-test
Claim-Worktree: /historical/writer-test
Claimed-At: 2026-09-01T01:00:00Z
Check-In-By: 2026-09-01T07:00:00Z

## Current checkpoint

Checkpoint-At: unclaimed
Checkpoint-Commit: uncommitted
Next-Action: unclaimed
Blockers: none
`;

function values(overrides = {}) {
  return {
    'Parent-Plan': '#27',
    'Scope-Paths': 'docs/example.md\ntools/**',
    'Depends-On': 'none',
    'Dependency-Notes': 'none',
    'Integration-Owner': 'maintainer',
    'Reconciled-Claim-Comment-IDs': 'none',
    'Claim-State': 'active',
    'Claim-Harness': 'pi',
    'Claim-Run-ID': 'run-41',
    'Claim-Agent': 'writer-test',
    'Claim-Branch': 'arch/writer-test',
    'Claim-Host': 'runner-01',
    'Claimed-At': '2026-09-01T01:00:00Z',
    'Check-In-By': '2026-09-01T07:00:00Z',
    'Waiting-Since': 'unclaimed',
    'Checkpoint-Evidence-Version': '1',
    'Checkpoint-State': 'active',
    'Checkpoint-At': '2026-09-01T02:00:00Z',
    'Checkpoint-Commit': COMMIT,
    'Checkpoint-Changed-Path-Count': '2',
    'Checkpoint-Checks-Verdict': 'passed',
    'Checkpoint-CI-Run': RUN,
    'Checkpoint-CI-Commit': COMMIT,
    'Checkpoint-Security-Impact': 'present',
    'Checkpoint-Tenant-Impact': 'none',
    'Checkpoint-Provider-Impact': 'none',
    'Checkpoint-Deployment-Impact': 'none',
    'Checkpoint-Residual-Risk-Count': '1',
    'Next-Action': 'request review',
    Blockers: 'none',
    ...overrides,
  };
}

function checkpointComment(fields = values()) {
  return [...V2_PORTABLE_CLAIM_FIELDS, ...CHECKPOINT_EVIDENCE_FIELDS]
    .map((field) => `${field}: ${fields[field]}`)
    .join('\n');
}

function planValues(overrides = {}) {
  return {
    'Registry-Schema-Version': '2',
    'Plan-State': 'complete',
    'Integration-Owner': 'maintainer',
    'Last-Plan-Update': '2026-09-01T04:00:00Z',
    ...overrides,
  };
}

function planComment(fields = planValues()) {
  return V2_PLAN_FIELDS.map((field) => `${field}: ${fields[field]}`).join('\n');
}

const TEST_STATE_LABELS = new Set([
  'work:proposed',
  'work:ready',
  'work:active',
  'work:blocked',
  'work:review',
  'work:done',
  'work:abandoned',
]);

class MockHost {
  constructor(body = V1_BODY, labels = ['work:ready', 'area:foundation']) {
    this.issue = {
      body,
      labels,
      comments: [
        {
          id: 1,
          body: 'Historical checkpoint evidence remains byte-for-byte immutable.',
        },
      ],
    };
    this.calls = [];
    this.fail = {};
    this.afterComment = undefined;
  }

  snapshot() {
    return structuredClone(this.issue);
  }

  async readIssue() {
    this.calls.push('read');
    return this.snapshot();
  }

  async updateBody(_number, body) {
    this.calls.push('body');
    this.issue.body = body;
    if (this.fail.body) throw new Error(this.fail.body);
  }

  async replaceStateLabel(_number, label) {
    this.calls.push('label');
    this.issue.labels = [
      ...this.issue.labels.filter((entry) => !TEST_STATE_LABELS.has(entry)),
      label,
    ];
    if (this.fail.label) throw new Error(this.fail.label);
  }

  async addComment(_number, body) {
    this.calls.push('comment');
    this.issue.comments.push({ id: this.issue.comments.length + 1, body });
    this.afterComment?.(this.issue);
    if (this.fail.comment) throw new Error(this.fail.comment);
  }

  mutationCount() {
    return this.calls.filter((entry) => ['body', 'label', 'comment'].includes(entry)).length;
  }
}

test('implicit-v1 migration is deterministic, complete, and preserves narrative without local paths', () => {
  const first = prepareCoordinationWrite({ currentBody: V1_BODY, values: values() });
  const second = prepareCoordinationWrite({ currentBody: first.body, values: values() });

  assert.equal(first.migrated, true);
  assert.equal(first.sourceVersion, '1');
  assert.equal(first.targetVersion, '2');
  assert.equal(first.validation.valid, true);
  assert.equal(second.migrated, false);
  assert.equal(second.body, first.body);
  assert.match(first.body, /Preserve this narrative exactly\./);
  assert.match(first.body, /Registry-Schema-Version: 2/);
  assert.match(first.body, /Scope-Paths: docs\/example\.md, tools\/\*\*/);
  assert.doesNotMatch(first.body, /Claim-Worktree|Shared-Hotspots/);
});

test('shared-plan construction also migrates one implicit-v1 body deterministically', () => {
  const currentBody = `## Outcome\n\nKeep the plan narrative.\n\nPlan-State: active\nIntegration-Owner: maintainer\nLast-Plan-Update: 2026-09-01T01:00:00Z\n`;
  const first = prepareCoordinationWrite({
    currentBody,
    kind: 'plan',
    values: {
      'Plan-State': 'active',
      'Integration-Owner': 'maintainer',
      'Last-Plan-Update': '2026-09-01T02:00:00Z',
    },
  });
  const second = prepareCoordinationWrite({
    currentBody: first.body,
    kind: 'plan',
    values: first.fields,
  });

  assert.equal(first.validation.valid, true);
  assert.equal(first.migrated, true);
  assert.equal(second.body, first.body);
  assert.match(first.body, /Keep the plan narrative\./);
});

test('migration collisions and unsupported versions stop before construction', () => {
  assert.throws(
    () =>
      prepareCoordinationWrite({
        currentBody: `${V1_BODY}\nScope-Paths: tools/**\n`,
        values: values(),
      }),
    (error) => error instanceof CoordinationWriteError && error.code === 'migration-collision',
  );
  assert.throws(
    () =>
      prepareCoordinationWrite({
        currentBody: `Registry-Schema-Version: 99\n${V1_BODY}`,
        values: values(),
      }),
    (error) =>
      error instanceof CoordinationWriteError && error.code === 'unsupported-schema-version',
  );
});

test('writer and claim public exports expose no caller-injected mutation path', async () => {
  assert.deepEqual(Object.keys(productionWriteModule).sort(), [
    'CoordinationWriteError',
    'executeCoordinationWrite',
    'prepareClaimEstablishmentWrite',
    'prepareCoordinationWrite',
    'runCoordinationWriteCli',
  ]);
  assert.deepEqual(Object.keys(productionClaimModule).sort(), [
    'BOOTSTRAP_BRANCH',
    'BOOTSTRAP_ISSUE',
    'CANONICAL_REPOSITORY',
    'CLAIM_BRANCH_VERSION',
    'CoordinationClaimError',
    'claimBranchForIssue',
    'claimRefForIssue',
    'executeCoordinationClaim',
    'parseReservedClaimBranch',
    'parseReservedClaimRef',
    'prepareCoordinationClaim',
    'runCoordinationClaimCli',
    'validateClaimBranch',
  ]);
  assert.equal(
    [...Object.keys(productionWriteModule), ...Object.keys(productionClaimModule)].some((name) =>
      /ForTest|GitHub.*Host|ScopeGuard|SnapshotGuard/.test(name),
    ),
    false,
  );

  const fakeHost = new MockHost();
  const fakeAuthority = () => ({ valid: true, status: 'clear' });
  const injected = [
    { host: fakeHost },
    { writerHost: fakeHost },
    { claimHost: fakeHost },
    { scopeGuard: fakeAuthority },
    { claimSnapshotGuard: fakeAuthority },
    { buildReport: fakeAuthority },
    { runGh: fakeAuthority },
    { readText: fakeAuthority },
    { writeOutput: fakeAuthority },
    { dependencies: { host: fakeHost, scopeGuard: fakeAuthority } },
  ];
  for (const dependency of injected) {
    await assert.rejects(
      executeProductionCoordinationWrite({
        repository: 'money-noodle/money-noodle',
        issueNumber: 41,
        expectedBody: V1_BODY,
        values: values(),
        checkpointComment: checkpointComment(),
        operationId: 'production-writer-injection',
        ...dependency,
      }),
      (error) => error.code === 'production-dependency-injection-forbidden',
      Object.keys(dependency)[0],
    );
    await assert.rejects(
      runProductionCoordinationWriteCli({ argv: ['--apply'], ...dependency }),
      (error) => error.code === 'production-dependency-injection-forbidden',
      Object.keys(dependency)[0],
    );
  }
  assert.equal(fakeHost.mutationCount(), 0);
});

test('incomplete or semantically invalid writes issue zero host mutations', async () => {
  const host = new MockHost();
  const before = host.snapshot();

  await assert.rejects(
    executeCoordinationWrite({
      host,
      issueNumber: 41,
      expectedBody: V1_BODY,
      values: values({ 'Check-In-By': 'unclaimed' }),
      checkpointComment: checkpointComment(values({ 'Check-In-By': 'unclaimed' })),
      operationId: 'invalid-41',
    }),
    (error) => error instanceof CoordinationWriteError && error.code === 'invalid-proposed-record',
  );
  assert.equal(host.mutationCount(), 0);
  assert.deepEqual(host.snapshot(), before);
});

test('the general writer rejects every parked-to-agent-owned transition before host mutation', async () => {
  const readyBody = V1_BODY.replace('Claim-State: active', 'Claim-State: ready')
    .replace('Claim-Harness: pi', 'Claim-Harness: unclaimed')
    .replace('Claim-Run-ID: run-41', 'Claim-Run-ID: unclaimed')
    .replace('Claim-Agent: writer-test', 'Claim-Agent: unclaimed')
    .replace('Claim-Branch: arch/writer-test', 'Claim-Branch: unclaimed')
    .replace('Claim-Worktree: /historical/writer-test', 'Claim-Worktree: unclaimed')
    .replace('Claimed-At: 2026-09-01T01:00:00Z', 'Claimed-At: unclaimed')
    .replace('Check-In-By: 2026-09-01T07:00:00Z', 'Check-In-By: unclaimed');
  for (const sourceState of ['ready', 'proposed']) {
    for (const targetState of ['active', 'review']) {
      const source = readyBody.replace('Claim-State: ready', `Claim-State: ${sourceState}`);
      const host = new MockHost(source, [`work:${sourceState}`, 'area:foundation']);
      const target = values({
        'Claim-State': targetState,
        'Claim-Branch': 'claim-v1/issue-42',
        'Checkpoint-State': targetState,
      });
      await assert.rejects(
        executeCoordinationWrite({
          host,
          issueNumber: 42,
          expectedBody: source,
          values: target,
          checkpointComment: checkpointComment(target),
          operationId: `direct-${sourceState}-${targetState}`,
        }),
        (error) =>
          error instanceof CoordinationWriteError &&
          error.code === 'initial-claim-requires-reference',
      );
      assert.equal(host.mutationCount(), 0);
    }
  }

  const target = values({ 'Claim-Branch': 'claim-v1/issue-42' });
  const files = new Map([
    ['ready.md', readyBody],
    ['values.json', JSON.stringify(target)],
    ['comment.md', checkpointComment(target)],
  ]);
  let ghCalls = 0;
  await assert.rejects(
    runCoordinationWriteCli({
      argv: [
        '--dry-run',
        '--repo',
        'money-noodle/money-noodle',
        '--issue',
        '42',
        '--kind',
        'work-item',
        '--expected-body-file',
        'ready.md',
        '--values-file',
        'values.json',
        '--comment-file',
        'comment.md',
        '--operation-id',
        'direct-cli-42',
      ],
      readText: async (path) => files.get(path),
      runGh: async () => {
        ghCalls += 1;
        throw new Error('rejection must happen before GitHub');
      },
      writeOutput: () => {},
    }),
    (error) =>
      error instanceof CoordinationWriteError && error.code === 'initial-claim-requires-reference',
  );
  assert.equal(ghCalls, 0);
});

test('a valid write uses exactly one body request and completes separate label and comment surfaces', async () => {
  const host = new MockHost();
  const historical = structuredClone(host.issue.comments[0]);
  const result = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'write-41',
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.mutations, { body: 1, label: 1, comment: 1 });
  assert.equal(host.calls.filter((entry) => entry === 'body').length, 1);
  assert.deepEqual(host.issue.comments[0], historical);
  assert.equal(host.issue.comments.length, 2);
  assert.match(host.issue.comments[1].body, /^Coordination-Write-ID: write-41\n/);
  assert(host.issue.labels.includes('work:active'));
});

test('body drift during comment creation fails coherent final verification', async () => {
  const host = new MockHost();
  host.afterComment = (issue) => {
    issue.body = `${issue.body}\nConcurrent-Body-Edit: present\n`;
  };
  const result = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'body-drift-41',
  });

  assert.equal(result.status, 'collision');
  assert.equal(result.stage, 'final-verification');
  assert.deepEqual(result.finalVerification, { body: false, label: true, comment: true });
});

test('label drift after label verification is surfaced and retry repairs only that surface', async () => {
  const host = new MockHost();
  host.afterComment = (issue) => {
    issue.labels = [...issue.labels.filter((label) => !TEST_STATE_LABELS.has(label)), 'work:ready'];
    host.afterComment = undefined;
  };
  const input = {
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'label-drift-41',
  };
  const first = await executeCoordinationWrite(input);

  assert.equal(first.status, 'partial');
  assert.equal(first.stage, 'final-verification');
  assert.deepEqual(first.finalVerification, { body: true, label: false, comment: true });
  const second = await executeCoordinationWrite(input);
  assert.equal(second.status, 'complete');
  assert.deepEqual(second.mutations, { body: 0, label: 1, comment: 0 });
  assert.deepEqual(second.finalVerification, { body: true, label: true, comment: true });
});

test('a changed host body is a detected collision with no mutation', async () => {
  const host = new MockHost(`${V1_BODY}\nUnmanaged-Edit: present\n`);
  const before = host.snapshot();
  const result = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'collision-41',
  });

  assert.equal(result.status, 'collision');
  assert.deepEqual(result.mutations, { body: 0, label: 0, comment: 0 });
  assert.deepEqual(host.snapshot(), before);
});

test('a pre-existing operation marker collision stops before every host mutation', async () => {
  const host = new MockHost();
  host.issue.comments.push({
    id: 2,
    body: 'Coordination-Write-ID: collision-marker-41\nDifferent-Evidence: present\n',
  });
  const before = host.snapshot();
  const result = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'collision-marker-41',
  });

  assert.equal(result.status, 'collision');
  assert.equal(result.stage, 'pre-write-comment');
  assert.deepEqual(result.mutations, { body: 0, label: 0, comment: 0 });
  assert.deepEqual(host.snapshot(), before);
});

test('an uncertain body response is recoverable without issuing a second body request', async () => {
  const host = new MockHost();
  host.fail.body = 'response lost after body update';
  const input = {
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'resume-body-41',
  };
  const first = await executeCoordinationWrite(input);
  assert.equal(first.status, 'partial');
  assert.equal(first.stage, 'body');
  assert.deepEqual(first.mutations, { body: 1, label: 0, comment: 0 });

  delete host.fail.body;
  const second = await executeCoordinationWrite(input);
  assert.equal(second.status, 'complete');
  assert.deepEqual(second.mutations, { body: 0, label: 1, comment: 1 });
  assert.equal(host.calls.filter((entry) => entry === 'body').length, 1);
});

test('interrupted label operations surface partial state and resume without a second body write', async () => {
  const host = new MockHost();
  host.fail.label = 'simulated label interruption';
  const first = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'resume-label-41',
  });
  assert.equal(first.status, 'partial');
  assert.equal(first.stage, 'label');
  assert.deepEqual(first.mutations, { body: 1, label: 1, comment: 0 });

  delete host.fail.label;
  const second = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'resume-label-41',
  });
  assert.equal(second.status, 'complete');
  assert.deepEqual(second.mutations, { body: 0, label: 0, comment: 1 });
  assert.equal(host.calls.filter((entry) => entry === 'body').length, 1);
});

test('comment uncertainty resumes by operation marker without duplicating historical evidence', async () => {
  const host = new MockHost();
  host.fail.comment = 'response lost after append';
  const first = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'resume-comment-41',
  });
  assert.equal(first.status, 'partial');
  assert.equal(first.stage, 'comment');
  assert.equal(host.issue.comments.length, 2);

  delete host.fail.comment;
  const second = await executeCoordinationWrite({
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'resume-comment-41',
  });
  assert.equal(second.status, 'complete');
  assert.deepEqual(second.mutations, { body: 0, label: 0, comment: 0 });
  assert.equal(host.issue.comments.length, 2);
});

test('shared-plan migration maps complete to work:done and resumes an interrupted write', async () => {
  const host = new MockHost(PLAN_V1_BODY, ['work:plan', 'work:active', 'area:foundation']);
  host.fail.label = 'response lost after plan label update';
  const input = {
    host,
    issueNumber: 27,
    expectedBody: PLAN_V1_BODY,
    values: planValues(),
    checkpointComment: planComment(),
    operationId: 'plan-complete-27',
    kind: 'plan',
  };
  const first = await executeCoordinationWrite(input);

  assert.equal(first.status, 'partial');
  assert.equal(first.stage, 'label');
  assert.match(host.issue.body, /Registry-Schema-Version: 2/);
  assert(host.issue.labels.includes('work:plan'));
  assert(host.issue.labels.includes('work:done'));
  delete host.fail.label;

  const second = await executeCoordinationWrite(input);
  assert.equal(second.status, 'complete');
  assert.equal(second.migrated, true);
  assert.equal(second.desiredLabel, 'work:done');
  assert.deepEqual(second.mutations, { body: 0, label: 0, comment: 1 });
  assert.deepEqual(second.finalVerification, { body: true, label: true, comment: true });
  assert.equal(host.calls.filter((entry) => entry === 'body').length, 1);
  assert.equal(host.issue.comments.length, 2);
});

test('a repeated completed write is idempotent across every host surface', async () => {
  const host = new MockHost();
  const input = {
    host,
    issueNumber: 41,
    expectedBody: V1_BODY,
    values: values(),
    checkpointComment: checkpointComment(),
    operationId: 'repeat-41',
  };
  assert.equal((await executeCoordinationWrite(input)).status, 'complete');
  const repeat = await executeCoordinationWrite(input);

  assert.equal(repeat.status, 'complete');
  assert.deepEqual(repeat.mutations, { body: 0, label: 0, comment: 0 });
  assert.deepEqual(repeat.finalVerification, { body: true, label: true, comment: true });
  assert.equal(host.issue.comments.length, 2);
});

function cliArguments(mode = '--dry-run') {
  return [
    mode,
    '--repo',
    'money-noodle/money-noodle',
    '--issue',
    '41',
    '--kind',
    'work-item',
    '--expected-body-file',
    'body.md',
    '--values-file',
    'values.json',
    '--comment-file',
    'comment.md',
    '--operation-id',
    'cli-write-41',
  ];
}

function cliFiles(fieldValues = values()) {
  return new Map([
    ['body.md', V1_BODY],
    ['values.json', JSON.stringify(fieldValues)],
    ['comment.md', checkpointComment(fieldValues)],
  ]);
}

function mockedGhAdapter() {
  const issue = {
    body: V1_BODY,
    labels: ['work:ready', 'area:foundation'],
    comments: [{ id: 1, body: 'Immutable historical evidence.' }],
  };
  const calls = [];
  const runGh = async (args, input) => {
    calls.push({ args: [...args], input });
    const endpoint = args.find((argument) => argument.startsWith('repos/'));
    const methodIndex = args.indexOf('--method');
    const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1];
    if (args.includes('--paginate')) return JSON.stringify([issue.comments]);
    if (method === 'PATCH') {
      const payload = JSON.parse(input);
      if (payload.body !== undefined) issue.body = payload.body;
      if (payload.labels !== undefined) issue.labels = payload.labels;
    } else if (method === 'POST' && endpoint.endsWith('/comments')) {
      issue.comments.push({ id: issue.comments.length + 1, body: JSON.parse(input).body });
      return JSON.stringify(issue.comments.at(-1));
    }
    return JSON.stringify({
      body: issue.body,
      labels: issue.labels.map((name) => ({ name })),
    });
  };
  return { issue, calls, runGh };
}

test('explicit adapter dry-run validates and previews without invoking GitHub', async () => {
  const files = cliFiles();
  const outputs = [];
  let ghCalls = 0;
  const result = await runCoordinationWriteCli({
    argv: cliArguments('--dry-run'),
    readText: async (path) => files.get(path),
    runGh: async () => {
      ghCalls += 1;
      throw new Error('dry-run must not invoke GitHub');
    },
    writeOutput: (text) => outputs.push(text),
  });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.migrated, true);
  assert.equal(result.desiredLabel, 'work:active');
  assert.equal(ghCalls, 0);
  assert.equal(JSON.parse(outputs.join('')).status, 'dry-run');
});

test('explicit adapter apply performs one bounded issue write and verifies all surfaces', async () => {
  const files = cliFiles();
  const adapter = mockedGhAdapter();
  const result = await runCoordinationWriteCli({
    argv: cliArguments('--apply'),
    readText: async (path) => files.get(path),
    runGh: adapter.runGh,
    writeOutput: () => {},
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.mutations, { body: 1, label: 1, comment: 1 });
  assert.deepEqual(result.finalVerification, { body: true, label: true, comment: true });
  assert.equal(adapter.calls.filter(({ args }) => args.includes('PATCH')).length, 2);
  assert.equal(adapter.calls.filter(({ args }) => args.includes('POST')).length, 1);
  assert(adapter.issue.labels.includes('work:active'));
  assert.equal(adapter.issue.comments.length, 2);
});

test('production writer boundary constructs its host and completes through the gh executable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mn-writer-production-boundary-'));
  try {
    const bodyPath = join(directory, 'body.md');
    const valuesPath = join(directory, 'values.json');
    const commentPath = join(directory, 'comment.md');
    const statePath = join(directory, 'state.json');
    const invocationPath = join(directory, 'invocations.log');
    writeFileSync(bodyPath, V1_BODY);
    writeFileSync(valuesPath, JSON.stringify(values()));
    writeFileSync(commentPath, checkpointComment());
    writeFileSync(
      statePath,
      JSON.stringify({
        issue: {
          state: 'open',
          body: V1_BODY,
          labels: [{ name: 'work:ready' }, { name: 'area:foundation' }],
        },
        comments: [{ id: 1, user: { login: 'maintainer' }, body: 'Historical evidence.' }],
      }),
    );
    writeFileSync(invocationPath, '');
    const ghPath = join(directory, 'gh');
    writeFileSync(
      ghPath,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(invocationPath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(logPath, args.join(' ') + '\\n');
const endpoint = args.find((arg) => arg.startsWith('repos/'));
const methodIndex = args.indexOf('--method');
const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1];
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args.includes('--paginate')) process.stdout.write(JSON.stringify([state.comments]));
else if (method === 'PATCH') {
  const value = JSON.parse(input);
  if (value.body !== undefined) state.issue.body = value.body;
  if (value.labels !== undefined) state.issue.labels = value.labels.map((name) => ({ name }));
  save();
  process.stdout.write(JSON.stringify(state.issue));
} else if (method === 'POST' && endpoint.endsWith('/comments')) {
  const comment = { id: 2, user: { login: 'maintainer' }, body: JSON.parse(input).body };
  state.comments.push(comment);
  save();
  process.stdout.write(JSON.stringify(comment));
} else process.stdout.write(JSON.stringify(state.issue));
`,
    );
    chmodSync(ghPath, 0o755);
    const args = cliArguments('--apply').map((value) => {
      if (value === 'body.md') return bodyPath;
      if (value === 'values.json') return valuesPath;
      if (value === 'comment.md') return commentPath;
      return value;
    });
    const result = spawnSync(process.execPath, [WRITER_TOOL, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, PATH: directory },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'complete');
    assert.deepEqual(output.mutations, { body: 1, label: 1, comment: 1 });
    assert.deepEqual(output.finalVerification, { body: true, label: true, comment: true });
    const finalState = JSON.parse(readFileSync(statePath, 'utf8'));
    assert(finalState.issue.labels.some(({ name }) => name === 'work:active'));
    assert.equal(finalState.comments.length, 2);
    assert.match(readFileSync(invocationPath, 'utf8'), /--method PATCH/);
    assert.match(readFileSync(invocationPath, 'utf8'), /--method POST/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit adapter apply rejects invalid input before any GitHub call or mutation', async () => {
  const invalid = values({ 'Check-In-By': 'unclaimed' });
  const files = cliFiles(invalid);
  let ghCalls = 0;

  await assert.rejects(
    runCoordinationWriteCli({
      argv: cliArguments('--apply'),
      readText: async (path) => files.get(path),
      runGh: async () => {
        ghCalls += 1;
        return '{}';
      },
      writeOutput: () => {},
    }),
    (error) => error instanceof CoordinationWriteError && error.code === 'invalid-proposed-record',
  );
  assert.equal(ghCalls, 0);
});
