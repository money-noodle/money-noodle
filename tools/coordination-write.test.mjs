import assert from 'node:assert/strict';
import test from 'node:test';

import { CHECKPOINT_EVIDENCE_FIELDS, V2_PORTABLE_CLAIM_FIELDS } from './coordination-schema.mjs';
import {
  CoordinationWriteError,
  executeCoordinationWrite,
  prepareCoordinationWrite,
} from './coordination-write.mjs';

const COMMIT = 'c'.repeat(40);
const RUN = 'https://github.com/money-noodle/money-noodle/actions/runs/456';
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

Claim-State: ready
Claim-Harness: unclaimed
Claim-Run-ID: unclaimed
Claim-Agent: unclaimed
Claim-Branch: unclaimed
Claim-Worktree: unclaimed
Claimed-At: unclaimed
Check-In-By: unclaimed

## Current checkpoint

Checkpoint-At: unclaimed
Checkpoint-Commit: uncommitted
Next-Action: unclaimed
Blockers: none
`;

function values(overrides = {}) {
  return {
    'Parent-Plan': '#27',
    'Scope-Paths': 'tools/**\ndocs/example.md',
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

class MockHost {
  constructor(body = V1_BODY) {
    this.issue = {
      body,
      labels: ['work:ready', 'area:foundation'],
      comments: [
        {
          id: 1,
          body: 'Historical checkpoint evidence remains byte-for-byte immutable.',
        },
      ],
    };
    this.calls = [];
    this.fail = {};
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
    this.issue.labels = [...this.issue.labels.filter((entry) => !entry.startsWith('work:')), label];
    if (this.fail.label) throw new Error(this.fail.label);
  }

  async addComment(_number, body) {
    this.calls.push('comment');
    this.issue.comments.push({ id: this.issue.comments.length + 1, body });
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
  assert.match(first.body, /Scope-Paths: tools\/\*\*, docs\/example\.md/);
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
  assert.equal(host.issue.comments.length, 2);
});
