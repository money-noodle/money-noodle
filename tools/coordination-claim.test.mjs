import assert from 'node:assert/strict';
import test from 'node:test';

import { CHECKPOINT_EVIDENCE_FIELDS, V2_PORTABLE_CLAIM_FIELDS } from './coordination-schema.mjs';
import {
  BOOTSTRAP_BRANCH,
  CANONICAL_REPOSITORY,
  CoordinationClaimError,
  claimBranchForIssue,
  claimRefForIssue,
  createGitHubClaimHost,
  executeCoordinationClaim,
  parseReservedClaimBranch,
  parseReservedClaimRef,
  prepareCoordinationClaim,
  runCoordinationClaimCli,
  validateClaimBranch,
} from './coordination-claim.mjs';

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ISSUE = 73;
const BRANCH = `claim-v1/issue-${ISSUE}`;
const REF = `refs/heads/${BRANCH}`;

function parkedFields(overrides = {}) {
  return {
    'Registry-Schema-Version': '2',
    'Parent-Plan': '#27',
    'Scope-Paths': 'tools/coordination-claim.mjs, tools/coordination-claim.test.mjs',
    'Depends-On': 'none',
    'Dependency-Notes': 'none',
    'Integration-Owner': 'maintainer',
    'Reconciled-Claim-Comment-IDs': 'none',
    'Claim-State': 'ready',
    'Claim-Harness': 'unclaimed',
    'Claim-Run-ID': 'unclaimed',
    'Claim-Agent': 'unclaimed',
    'Claim-Branch': 'unclaimed',
    'Claim-Host': 'unclaimed',
    'Claimed-At': 'unclaimed',
    'Check-In-By': 'unclaimed',
    'Waiting-Since': 'unclaimed',
    'Checkpoint-Evidence-Version': '1',
    'Checkpoint-State': 'ready',
    'Checkpoint-At': '2026-09-01T00:00:00Z',
    'Checkpoint-Commit': BASE,
    'Checkpoint-Changed-Path-Count': '0',
    'Checkpoint-Checks-Verdict': 'unavailable',
    'Checkpoint-CI-Run': 'unavailable',
    'Checkpoint-CI-Commit': 'unavailable',
    'Checkpoint-Security-Impact': 'present',
    'Checkpoint-Tenant-Impact': 'none',
    'Checkpoint-Provider-Impact': 'none',
    'Checkpoint-Deployment-Impact': 'none',
    'Checkpoint-Residual-Risk-Count': '2',
    'Next-Action': 'claim through the remote reference primitive',
    Blockers: 'none',
    ...overrides,
  };
}

function bodyFrom(fields) {
  return `${Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')}\n`;
}

const PARKED_BODY = bodyFrom(parkedFields());

function activeValues(overrides = {}) {
  return {
    'Claim-State': 'active',
    'Claim-Harness': 'pi',
    'Claim-Run-ID': 'run-73',
    'Claim-Agent': 'claim-test',
    'Claim-Branch': BRANCH,
    'Claim-Host': 'runner-01',
    'Claimed-At': '2026-09-01T01:00:00Z',
    'Check-In-By': '2999-09-01T07:00:00Z',
    'Waiting-Since': 'unclaimed',
    'Checkpoint-State': 'active',
    'Checkpoint-At': '2026-09-01T01:00:00Z',
    'Checkpoint-Commit': BASE,
    'Checkpoint-Changed-Path-Count': '0',
    'Checkpoint-Checks-Verdict': 'unavailable',
    'Checkpoint-CI-Run': 'unavailable',
    'Checkpoint-CI-Commit': 'unavailable',
    'Checkpoint-Security-Impact': 'present',
    'Checkpoint-Tenant-Impact': 'none',
    'Checkpoint-Provider-Impact': 'none',
    'Checkpoint-Deployment-Impact': 'none',
    'Checkpoint-Residual-Risk-Count': '2',
    'Next-Action': 'create the dedicated worktree',
    Blockers: 'none',
    ...overrides,
  };
}

function checkpointComment(fields = activeValues()) {
  return [...V2_PORTABLE_CLAIM_FIELDS, ...CHECKPOINT_EVIDENCE_FIELDS]
    .map((field) => `${field}: ${fields[field] ?? parkedFields()[field]}`)
    .join('\n');
}

const STATE_LABELS = new Set([
  'work:proposed',
  'work:ready',
  'work:active',
  'work:blocked',
  'work:review',
  'work:done',
  'work:abandoned',
]);

class MockWriterHost {
  constructor(timeline = []) {
    this.timeline = timeline;
    this.issue = {
      state: 'open',
      body: PARKED_BODY,
      labels: ['work:ready', 'area:foundation'],
      comments: [],
    };
    this.fail = {};
    this.failBefore = {};
    this.mutations = [];
  }

  snapshot() {
    return structuredClone(this.issue);
  }

  async readIssue() {
    this.timeline.push('issue-read');
    return this.snapshot();
  }

  async updateBody(_number, body) {
    this.timeline.push('body');
    this.mutations.push('body');
    this.issue.body = body;
    if (this.fail.body) throw new Error(this.fail.body);
  }

  async replaceStateLabel(_number, label) {
    this.timeline.push('label');
    this.mutations.push('label');
    if (this.failBefore.label) throw new Error(this.failBefore.label);
    this.issue.labels = [...this.issue.labels.filter((entry) => !STATE_LABELS.has(entry)), label];
    if (this.fail.label) throw new Error(this.fail.label);
  }

  async addComment(_number, body) {
    this.timeline.push('comment');
    this.mutations.push('comment');
    if (this.failBefore.comment) throw new Error(this.failBefore.comment);
    this.issue.comments.push({ id: this.issue.comments.length + 1, body });
    if (this.fail.comment) throw new Error(this.fail.comment);
  }
}

class MockClaimHost {
  constructor(timeline = []) {
    this.timeline = timeline;
    this.repository = { nameWithOwner: CANONICAL_REPOSITORY, defaultBranch: 'main' };
    this.main = { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE } };
    this.ref = null;
    this.createCalls = 0;
    this.mode = 'success';
  }

  async readRepository() {
    this.timeline.push('repository-read');
    return structuredClone(this.repository);
  }

  async readMainRef() {
    this.timeline.push('main-read');
    return structuredClone(this.main);
  }

  async readClaimRef() {
    this.timeline.push('claim-ref-read');
    return structuredClone(this.ref);
  }

  async createClaimRef({ ref, sha }) {
    this.timeline.push('create-ref');
    this.createCalls += 1;
    if (this.mode === '422-present' || (this.mode === 'atomic' && this.ref)) {
      if (!this.ref) this.ref = { ref, object: { type: 'commit', sha } };
      const error = new Error('Validation Failed');
      error.statusCode = 422;
      throw error;
    }
    if (this.mode === '422-absent') {
      const error = new Error('Validation Failed');
      error.statusCode = 422;
      throw error;
    }
    if (this.mode === 'ambiguous-present') {
      this.ref = { ref, object: { type: 'commit', sha } };
      throw new Error('response lost');
    }
    if (this.mode === 'ambiguous-absent') throw new Error('timeout');
    this.ref = { ref, object: { type: 'commit', sha } };
    if (this.mode === 'malformed') {
      return { statusCode: 201, body: { ref, object: { type: 'tag', sha } } };
    }
    return { statusCode: 201, body: structuredClone(this.ref) };
  }
}

function prepareInput(overrides = {}) {
  return {
    repository: CANONICAL_REPOSITORY,
    issueNumber: ISSUE,
    expectedBase: BASE,
    expectedBody: PARKED_BODY,
    values: activeValues(),
    checkpointComment: checkpointComment(),
    operationId: 'claim-73',
    ...overrides,
  };
}

function input(claimHost, writerHost, overrides = {}) {
  return {
    claimHost,
    writerHost,
    ...prepareInput(),
    ...overrides,
  };
}

test('version-1 branch derivation is canonical and independent of mutable metadata', () => {
  assert.equal(claimBranchForIssue(1), 'claim-v1/issue-1');
  assert.equal(
    claimBranchForIssue(Number.MAX_SAFE_INTEGER),
    `claim-v1/issue-${Number.MAX_SAFE_INTEGER}`,
  );
  assert.equal(claimRefForIssue(73), REF);
  assert.deepEqual(parseReservedClaimBranch(BRANCH), {
    status: 'supported',
    branch: BRANCH,
    version: 1,
    issueNumber: 73,
    ref: REF,
  });
  assert.equal(parseReservedClaimRef(REF).issueNumber, 73);
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '73']) {
    assert.throws(() => claimBranchForIssue(invalid), RangeError);
  }
  for (const malformed of [
    'claim-v1/issue-073',
    'claim-v0/issue-73',
    'claim-v1/issue-0',
    'claim-v1/other-73',
  ]) {
    assert.equal(parseReservedClaimBranch(malformed).status, 'malformed', malformed);
  }
  assert.equal(parseReservedClaimBranch('claim-v2/issue-73').status, 'unsupported');
});

test('bootstrap and derived branch validation fail closed on every wrong issue or version', () => {
  assert.equal(
    validateClaimBranch({ issueNumber: 42, claimState: 'active', branch: BOOTSTRAP_BRANCH }).status,
    'bootstrap',
  );
  assert.equal(
    validateClaimBranch({ issueNumber: 41, claimState: 'active', branch: BOOTSTRAP_BRANCH }).code,
    'bootstrap-branch-wrong-issue',
  );
  assert.equal(
    validateClaimBranch({ issueNumber: 42, claimState: 'active', branch: 'arch/other' }).status,
    'invalid',
  );
  assert.equal(
    validateClaimBranch({ issueNumber: 73, claimState: 'review', branch: BRANCH }).status,
    'derived',
  );
  assert.equal(
    validateClaimBranch({ issueNumber: 74, claimState: 'active', branch: BRANCH }).code,
    'claim-branch-issue-mismatch',
  );
});

test('claim preparation derives the branch and validates every write artifact without a host', () => {
  const prepared = prepareCoordinationClaim(prepareInput());
  assert.equal(prepared.branch, BRANCH);
  assert.equal(prepared.ref, REF);
  assert.equal(prepared.prepared.fields['Claim-Branch'], BRANCH);
  assert.equal(prepared.operation.marker, 'Coordination-Write-ID: claim-73');
  assert.match(prepared.operation.comment, /^Coordination-Write-ID: claim-73\n/);

  const cases = [
    [{ repository: 'other/repository' }, 'repository-mismatch'],
    [{ values: activeValues({ 'Claim-Branch': 'claim-v1/issue-74' }) }, 'caller-selected-branch'],
    [{ values: activeValues({ 'Claim-State': 'review' }) }, 'invalid-initial-claim-state'],
    [
      {
        values: activeValues({ 'Checkpoint-Commit': OTHER }),
        checkpointComment: checkpointComment(activeValues({ 'Checkpoint-Commit': OTHER })),
      },
      'checkpoint-base-mismatch',
    ],
  ];
  for (const [override, code] of cases) {
    assert.throws(
      () => prepareCoordinationClaim(prepareInput(override)),
      (error) => error instanceof CoordinationClaimError && error.code === code,
      code,
    );
  }
});

test('invalid target comment and operation evidence fail before every host call', async () => {
  for (const override of [
    { checkpointComment: 'Claim-State: active' },
    { operationId: 'invalid operation id' },
  ]) {
    const timeline = [];
    const claimHost = new MockClaimHost(timeline);
    const writerHost = new MockWriterHost(timeline);
    await assert.rejects(executeCoordinationClaim(input(claimHost, writerHost, override)));
    assert.deepEqual(timeline, []);
    assert.equal(claimHost.createCalls, 0);
    assert.deepEqual(writerHost.mutations, []);
  }
});

test('qualifying HTTP 201 creates the ref before any issue mutation and completes the writer', async () => {
  const timeline = [];
  const claimHost = new MockClaimHost(timeline);
  const writerHost = new MockWriterHost(timeline);
  const result = await executeCoordinationClaim(input(claimHost, writerHost));

  assert.equal(result.status, 'complete');
  assert.equal(result.refMutations, 1);
  assert.deepEqual(result.writerMutations, { body: 1, label: 1, comment: 1 });
  assert(timeline.indexOf('create-ref') < timeline.indexOf('body'));
  assert.equal(claimHost.createCalls, 1);
  assert.equal(claimHost.ref.ref, REF);
});

test('two concurrent contenders produce one winner and a zero-registry-mutation loser', async () => {
  const claimHost = new MockClaimHost();
  claimHost.mode = 'atomic';
  const winnerWriter = new MockWriterHost();
  const loserWriter = new MockWriterHost();
  const [first, second] = await Promise.all([
    executeCoordinationClaim(input(claimHost, winnerWriter, { operationId: 'contender-a' })),
    executeCoordinationClaim(input(claimHost, loserWriter, { operationId: 'contender-b' })),
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter(({ status }) => status === 'complete').length, 1);
  assert.equal(outcomes.filter(({ status }) => status === 'lost-race').length, 1);
  const loser = first.status === 'lost-race' ? winnerWriter : loserWriter;
  assert.deepEqual(loser.mutations, []);
});

test('HTTP 422 is never success and distinguishes a lost race from absent-ref failure', async () => {
  for (const [mode, expected] of [
    ['422-present', 'lost-race'],
    ['422-absent', 'failed'],
  ]) {
    const claimHost = new MockClaimHost();
    claimHost.mode = mode;
    const writerHost = new MockWriterHost();
    const result = await executeCoordinationClaim(input(claimHost, writerHost));
    assert.equal(result.status, expected, mode);
    assert.deepEqual(result.writerMutations, { body: 0, label: 0, comment: 0 });
    assert.deepEqual(writerHost.mutations, []);
  }
});

test('ambiguous or malformed create responses never adopt even when the ref is observed', async () => {
  for (const mode of ['ambiguous-present', 'ambiguous-absent', 'malformed']) {
    const claimHost = new MockClaimHost();
    claimHost.mode = mode;
    const writerHost = new MockWriterHost();
    const result = await executeCoordinationClaim(input(claimHost, writerHost));
    assert.equal(result.status, 'ambiguous', mode);
    assert.deepEqual(writerHost.mutations, []);
  }
});

test('repository mismatch and stale remote main fail before ref or issue mutation', async () => {
  for (const configure of [
    (host) => (host.repository.nameWithOwner = 'other/repository'),
    (host) => (host.main.object.sha = OTHER),
  ]) {
    const claimHost = new MockClaimHost();
    configure(claimHost);
    const writerHost = new MockWriterHost();
    await assert.rejects(
      executeCoordinationClaim(input(claimHost, writerHost)),
      CoordinationClaimError,
    );
    assert.equal(claimHost.createCalls, 0);
    assert.deepEqual(writerHost.mutations, []);
  }
});

test('closed, mislabeled, malformed, or competing parked issues create no orphan ref', async () => {
  const cases = [
    ['closed issue', (writer) => (writer.issue.state = 'closed'), 'claim-issue-not-open'],
    [
      'wrong state label',
      (writer) => (writer.issue.labels = ['work:proposed', 'area:foundation']),
      'pre-create-label-mismatch',
    ],
    [
      'multiple state labels',
      (writer) => writer.issue.labels.push('work:proposed'),
      'pre-create-label-mismatch',
    ],
    [
      'malformed ownership',
      (writer) => writer.issue.comments.push({ id: 1, body: 'Claim-State: ready\n' }),
      'malformed-ownership-evidence',
    ],
    [
      'competing ownership',
      (writer) => {
        const competing = activeValues({
          'Claim-Run-ID': 'competing-run',
          'Claim-Agent': 'competing-agent',
        });
        writer.issue.comments.push({ id: 1, body: checkpointComment(competing) });
      },
      'competing-agent-ownership',
    ],
  ];
  for (const [name, configure, stage] of cases) {
    const claimHost = new MockClaimHost();
    const writerHost = new MockWriterHost();
    configure(writerHost);
    const outcome = await executeCoordinationClaim(input(claimHost, writerHost));
    assert.equal(outcome.stage, stage, name);
    assert.equal(claimHost.createCalls, 0, name);
    assert.deepEqual(writerHost.mutations, [], name);
  }
});

test('a complete schema-v2 readiness checkpoint with another marker remains valid pre-create history', async () => {
  const claimHost = new MockClaimHost();
  const writerHost = new MockWriterHost();
  writerHost.issue.comments.push({
    id: 1,
    body: `Coordination-Write-ID: claim-73-readiness\n${checkpointComment(parkedFields())}`,
  });
  const outcome = await executeCoordinationClaim(input(claimHost, writerHost));
  assert.equal(outcome.status, 'complete');
  assert.equal(claimHost.createCalls, 1);
});

test('orphaned refs, body collisions, and active-body/ref-absent contradictions stop safely', async () => {
  const prepared = prepareCoordinationClaim(prepareInput());
  {
    const claimHost = new MockClaimHost();
    claimHost.ref = { ref: REF, object: { type: 'commit', sha: BASE } };
    const writerHost = new MockWriterHost();
    assert.equal((await executeCoordinationClaim(input(claimHost, writerHost))).status, 'orphaned');
  }
  {
    const claimHost = new MockClaimHost();
    const writerHost = new MockWriterHost();
    writerHost.issue.body = prepared.prepared.body;
    assert.equal(
      (await executeCoordinationClaim(input(claimHost, writerHost))).stage,
      'claim-present-ref-absent',
    );
  }
  {
    const claimHost = new MockClaimHost();
    claimHost.ref = { ref: REF, object: { type: 'commit', sha: BASE } };
    const writerHost = new MockWriterHost();
    writerHost.issue.body = `${PARKED_BODY}\nConcurrent: present\n`;
    assert.equal(
      (await executeCoordinationClaim(input(claimHost, writerHost))).status,
      'collision',
    );
  }
});

test('body-success label-or-comment failures retry beside a real readiness marker without another ref', async () => {
  for (const failedSurface of ['label', 'comment']) {
    const claimHost = new MockClaimHost();
    const writerHost = new MockWriterHost();
    writerHost.issue.comments.push({
      id: 1,
      body: `Coordination-Write-ID: claim-73-readiness\n${checkpointComment(parkedFields())}`,
    });
    writerHost.failBefore[failedSurface] = `${failedSurface} request failed`;
    const first = await executeCoordinationClaim(input(claimHost, writerHost));
    assert.equal(first.stage, 'writer-partial', failedSurface);
    assert.equal(claimHost.createCalls, 1);
    delete writerHost.failBefore[failedSurface];
    const second = await executeCoordinationClaim(input(claimHost, writerHost));
    assert.equal(second.status, 'complete', failedSurface);
    assert.equal(second.stage, 'writer-recovery', failedSurface);
    assert.equal(claimHost.createCalls, 1);
    assert.equal(second.writerMutations.body, 0);
    assert.equal(
      writerHost.issue.comments.filter(({ body }) =>
        body.includes('Coordination-Write-ID: claim-73-readiness'),
      ).length,
      1,
    );
  }
});

test('an exact complete matching claim is existing evidence and receives no duplicate comment', async () => {
  const claimHost = new MockClaimHost();
  const writerHost = new MockWriterHost();
  assert.equal((await executeCoordinationClaim(input(claimHost, writerHost))).status, 'complete');
  const commentCount = writerHost.issue.comments.length;
  const existing = await executeCoordinationClaim(
    input(claimHost, writerHost, { operationId: 'later-same-claimant' }),
  );
  assert.equal(existing.status, 'existing');
  assert.equal(existing.stage, 'existing-coherent-claim');
  assert.equal(writerHost.issue.comments.length, commentCount);
  assert.equal(claimHost.createCalls, 1);
});

test('a malformed operation marker blocks prepared-body recovery', async () => {
  const claimHost = new MockClaimHost();
  claimHost.ref = { ref: REF, object: { type: 'commit', sha: BASE } };
  const writerHost = new MockWriterHost();
  const prepared = prepareCoordinationClaim(prepareInput());
  writerHost.issue.body = prepared.prepared.body;
  writerHost.issue.comments.push({ id: 1, body: 'Coordination-Write-ID: other-operation\n' });
  const result = await executeCoordinationClaim(input(claimHost, writerHost));
  assert.equal(result.stage, 'ref-present-malformed-operation-evidence');
  assert.deepEqual(writerHost.mutations, []);
});

test('conflicting structured ownership blocks recovery even without an operation marker', async () => {
  const claimHost = new MockClaimHost();
  claimHost.ref = { ref: REF, object: { type: 'commit', sha: BASE } };
  const writerHost = new MockWriterHost();
  const prepared = prepareCoordinationClaim(prepareInput());
  writerHost.issue.body = prepared.prepared.body;
  const competing = activeValues({
    'Claim-Run-ID': 'other-run',
    'Claim-Agent': 'another-agent',
  });
  writerHost.issue.comments.push({ id: 1, body: checkpointComment(competing) });
  const result = await executeCoordinationClaim(input(claimHost, writerHost));
  assert.equal(result.stage, 'ref-present-competing-agent-ownership');
  assert.deepEqual(writerHost.mutations, []);
});

test('claim CLI dry-run validates derivation without invoking GitHub', async () => {
  const files = new Map([
    ['body.md', PARKED_BODY],
    ['values.json', JSON.stringify(activeValues())],
    ['comment.md', checkpointComment()],
  ]);
  let calls = 0;
  const output = [];
  const result = await runCoordinationClaimCli({
    argv: [
      '--dry-run',
      '--repo',
      CANONICAL_REPOSITORY,
      '--issue',
      String(ISSUE),
      '--expected-base',
      BASE,
      '--expected-body-file',
      'body.md',
      '--values-file',
      'values.json',
      '--comment-file',
      'comment.md',
      '--operation-id',
      'dry-73',
    ],
    readText: async (path) => files.get(path),
    claimRunGh: async () => {
      calls += 1;
      throw new Error('dry-run must not call GitHub');
    },
    writerRunGh: async () => {
      calls += 1;
      throw new Error('dry-run must not call GitHub');
    },
    writeOutput: (text) => output.push(text),
  });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.ref, REF);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(output.join('')).branch, BRANCH);

  await assert.rejects(
    runCoordinationClaimCli({
      argv: [
        '--dry-run',
        '--repo',
        CANONICAL_REPOSITORY,
        '--issue',
        '073',
        '--expected-base',
        BASE,
        '--expected-body-file',
        'body.md',
        '--values-file',
        'values.json',
        '--comment-file',
        'comment.md',
        '--operation-id',
        'dry-73',
      ],
      readText: async (path) => files.get(path),
      claimRunGh: async () => {
        calls += 1;
        throw new Error('canonical parsing must fail before GitHub');
      },
      writerRunGh: async () => {
        calls += 1;
        throw new Error('canonical parsing must fail before GitHub');
      },
      writeOutput: () => {},
    }),
    (error) => error instanceof CoordinationClaimError && error.code === 'invalid-issue-number',
  );
  assert.equal(calls, 0);
});

test('GitHub claim adapter exposes only current reads and one create-only POST', async () => {
  const calls = [];
  const runGh = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'repo') {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: CANONICAL_REPOSITORY,
          defaultBranchRef: { name: 'main' },
        }),
        stderr: '',
      };
    }
    if (args.includes('--method')) {
      return {
        status: 0,
        stdout: `HTTP/2 201 Created\ncontent-type: application/json\n\n${JSON.stringify({ ref: REF, object: { type: 'commit', sha: BASE } })}`,
        stderr: '',
      };
    }
    return {
      status: 0,
      stdout: JSON.stringify({
        ref: args.at(-1).endsWith('heads/main') ? 'refs/heads/main' : REF,
        object: { type: 'commit', sha: BASE },
      }),
      stderr: '',
    };
  };
  const host = createGitHubClaimHost({ runGh });
  await host.readRepository();
  await host.readMainRef();
  await host.readClaimRef(REF);
  await host.createClaimRef({ ref: REF, sha: BASE });

  const mutations = calls.filter(({ args }) => args.includes('--method'));
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, [
    'api',
    '--include',
    '--method',
    'POST',
    `repos/${CANONICAL_REPOSITORY}/git/refs`,
    '--input',
    '-',
  ]);
  assert.deepEqual(JSON.parse(mutations[0].input), { ref: REF, sha: BASE });
  assert(
    calls.every(({ args }) => {
      const methodIndex = args.indexOf('--method');
      const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1];
      return !['DELETE', 'PATCH', 'PUT'].includes(method);
    }),
  );
});
