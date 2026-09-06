import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCoordination } from './coordination-lib.mjs';
import { computeNextWork, dependencyIssueNumbers } from './coordination-next-work.mjs';

const NOW = Date.parse('2026-09-06T12:00:00Z');
const LOCAL = { branches: [], worktrees: [] };
function issue(number, state = 'ready', overrides = {}, version = '2') {
  const owned = ['active', 'review'].includes(state);
  const fields = {
    'Registry-Schema-Version': version,
    'Parent-Plan': '#27',
    'Scope-Paths': `files/${number}`,
    'Depends-On': 'none',
    'Dependency-Notes': 'none',
    'Integration-Owner': 'maintainer',
    'Reconciled-Claim-Comment-IDs': 'none',
    'Claim-State': state,
    'Claim-Harness': owned ? 'pi' : 'unclaimed',
    'Claim-Run-ID': owned ? `run-${number}` : 'unclaimed',
    'Claim-Agent': owned ? `agent-${number}` : 'unclaimed',
    'Claim-Branch': owned ? `claim-v1/issue-${number}` : 'unclaimed',
    'Claim-Host': owned ? 'runner' : 'unclaimed',
    'Claimed-At': owned ? '2026-09-06T10:00:00Z' : 'unclaimed',
    'Check-In-By': owned ? '2026-09-06T12:00:00Z' : 'unclaimed',
    'Waiting-Since': state === 'blocked' ? '2026-09-05T12:00:00Z' : 'unclaimed',
    'Checkpoint-Evidence-Version': '1',
    'Checkpoint-State': state,
    'Checkpoint-At': ['proposed', 'ready'].includes(state) ? 'unclaimed' : '2026-09-06T10:00:00Z',
    'Checkpoint-Commit': owned ? 'a'.repeat(40) : 'uncommitted',
    'Checkpoint-Changed-Path-Count': '0',
    'Checkpoint-Checks-Verdict': 'unavailable',
    'Checkpoint-CI-Run': 'unavailable',
    'Checkpoint-CI-Commit': 'unavailable',
    'Checkpoint-Security-Impact': 'none',
    'Checkpoint-Tenant-Impact': 'none',
    'Checkpoint-Provider-Impact': 'none',
    'Checkpoint-Deployment-Impact': 'none',
    'Checkpoint-Residual-Risk-Count': '0',
    'Next-Action': 'test',
    Blockers: 'none',
    ...overrides,
  };
  if (version === '1') {
    for (const key of [
      'Registry-Schema-Version',
      'Scope-Paths',
      'Dependency-Notes',
      'Claim-Host',
      'Waiting-Since',
    ])
      delete fields[key];
    fields['Claim-Worktree'] = owned ? '/synthetic/claim' : 'unclaimed';
  }
  return {
    number,
    title: `Work ${number}`,
    url: `https://example.invalid/${number}`,
    updatedAt: '2026-09-06T10:00:00Z',
    state: ['done', 'abandoned'].includes(state) ? 'closed' : 'open',
    labels: [`work:${state}`],
    body: Object.entries(fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  };
}
function board(
  issues,
  {
    scope = { status: 'complete', claims: [], pullRequests: [] },
    comments = new Map(issues.map(({ number }) => [number, []])),
    nowMs = NOW,
    refs,
  } = {},
) {
  const reservedRefs =
    refs ??
    issues
      .filter(({ body }) => /Claim-State: (active|review)\n/.test(body))
      .map(({ number }) => ({
        ref: `refs/heads/claim-v1/issue-${number}`,
        sha: 'a'.repeat(40),
        objectType: 'commit',
      }));
  const coordination = analyzeCoordination({
    issues,
    commentsByIssue: comments,
    local: LOCAL,
    reservedRefs,
    nowMs,
  });
  const before = JSON.stringify({ issues, coordination, scope });
  const result = computeNextWork({
    issues,
    workItems: coordination.workItems,
    commentsByIssue: comments,
    local: LOCAL,
    remoteClaims: coordination.remoteClaims,
    scope,
    nowMs,
  });
  assert.equal(
    JSON.stringify({ issues, coordination, scope }),
    before,
    'pure helper must not mutate inputs',
  );
  return result;
}
const row = (result, number) => result.items.find((item) => item.number === number);

test('proposed and ready availability is derived and stable, not a priority or authority', () => {
  const input = [
    issue(30),
    issue(4, 'proposed'),
    issue(9, 'ready', { 'Depends-On': '#40' }),
    issue(40, 'done'),
  ];
  const result = board(input);
  assert.deepEqual(result.candidates, [4, 9, 30]);
  assert.deepEqual(
    result.items.map(({ rank }) => rank),
    [1, 2, 3],
  );
  assert.equal(result.order, 'issue-number-ascending');
  assert.deepEqual(board([...input].reverse()), result);
  assert(
    result.items.every(
      ({ category, candidateSafety, liveness }) =>
        category === 'parked' && candidateSafety === 'not-established' && liveness.kind === 'none',
    ),
  );
  assert.deepEqual(board([issue(3), issue(3)]).candidates, []);
});

test('transitive closed prerequisites require full comments and coherent completion', () => {
  const input = [
    issue(1, 'ready', { 'Depends-On': '#2' }),
    issue(2, 'done', { 'Depends-On': '#3' }),
    issue(3, 'done'),
  ];
  assert.deepEqual(row(board(input), 1).dependencyClosure.numbers, [2, 3]);
  assert.deepEqual([...dependencyIssueNumbers(input)].sort(), [1, 2, 3]);
  const comments = new Map([
    [1, []],
    [2, []],
  ]);
  assert.equal(row(board(input, { comments }), 1).availability, 'unknown');
  const contradiction = {
    id: 10,
    body: 'I am taking ownership',
    author: 'other',
    createdAt: '2026-09-06T11:00:00Z',
    updatedAt: '2026-09-06T11:00:00Z',
  };
  comments.set(3, [contradiction]);
  assert.equal(row(board(input, { comments }), 1).availability, 'unknown');
  input[2] = issue(3, 'abandoned');
  assert.equal(row(board(input), 1).dependencyClosure.status, 'unknown');
});

test('cycles, self, missing and malformed evidence refuse only affected closures', () => {
  for (const broken of [
    issue(2, 'ready', { 'Depends-On': '#1' }),
    issue(2, 'ready', { 'Depends-On': '#2' }),
    issue(2, 'ready', { 'Depends-On': '#999' }),
    issue(2, 'ready', { 'Depends-On': 'not a ticket' }),
    issue(2, 'ready', { 'Registry-Schema-Version': '99' }),
  ]) {
    const result = board([issue(1, 'ready', { 'Depends-On': '#2' }), broken, issue(8)]);
    assert.equal(row(result, 1).availability, 'unknown');
    assert.deepEqual(result.candidates, [8]);
    assert(result.diagnostics.length > 0);
  }
  const result = board([issue(1, 'ready', { 'Depends-On': '#2' }), issue(2, 'proposed')]);
  assert.equal(row(result, 1).availability, 'excluded');
  assert.deepEqual(row(result, 1).dependencyClosure.blocked, [2]);
});

test('all states retain state-specific liveness, including exact deadline edges', () => {
  const result = board([
    issue(1, 'active'),
    issue(2, 'review'),
    issue(3, 'blocked'),
    issue(4, 'proposed'),
    issue(5),
    { ...issue(6, 'done'), state: 'open' },
    { ...issue(7, 'abandoned'), state: 'open' },
    issue(8, 'mystery'),
  ]);
  assert.deepEqual(
    result.items.map(({ category }) => category),
    [
      'agent-owed',
      'agent-owed',
      'principal-owed',
      'parked',
      'parked',
      'terminal',
      'terminal',
      'unknown',
    ],
  );
  assert.equal(row(result, 1).liveness.status, 'current');
  assert.equal(row(board([issue(1, 'active')], { nowMs: NOW + 1 }), 1).liveness.status, 'overdue');
  for (const [value, status] of [
    ['unclaimed', 'unknown'],
    ['yesterday', 'invalid'],
  ]) {
    assert.equal(
      row(board([issue(1, 'review', { 'Check-In-By': value })]), 1).liveness.status,
      status,
    );
  }
});

test('principal visibility is unconditional; legacy waiting ages remain unknown and never expire', () => {
  const legacy = issue(2, 'blocked', {}, '1');
  const result = board(
    [
      issue(1, 'blocked'),
      legacy,
      issue(3, 'blocked', { 'Waiting-Since': '2026-09-07T12:00:00Z' }),
      issue(4, 'blocked', { 'Waiting-Since': 'bad' }),
    ],
    { scope: { status: 'unavailable' } },
  );
  assert.deepEqual(result.principalOwed, [1, 2, 3, 4]);
  assert.equal(row(result, 1).liveness.ageMs, 86400000);
  assert.equal(row(result, 2).liveness.status, 'unknown');
  assert.equal(row(result, 2).liveness.ageMs, null);
  assert.equal(row(result, 3).liveness.status, 'invalid');
  assert.equal(row(result, 4).liveness.status, 'invalid');
  assert.equal(
    row(board([issue(1, 'blocked')], { nowMs: NOW + 1e12 }), 1).liveness.status,
    'waiting',
  );
  const owned = issue(5, 'active', {}, '1');
  owned.body = owned.body.replaceAll('State: active', 'State: blocked');
  owned.labels = ['work:blocked'];
  assert.equal(row(board([owned]), 5).category, 'agent-owed');
});

test('planning scope includes declared reservations, broad prefixes, observed creep and PR changes', () => {
  const candidate = issue(1, 'ready', { 'Scope-Paths': 'files/**' });
  const active = issue(2, 'active', { 'Scope-Paths': 'other/file' });
  const scope = {
    status: 'complete',
    claims: [{ number: 2, observed: { status: 'complete', paths: ['other/file'] } }],
    pullRequests: [],
  };
  assert.equal(row(board([candidate, active], { scope }), 1).availability, 'available');
  scope.claims[0].observed.paths = ['files/creep'];
  assert(
    row(board([candidate, active], { scope }), 1).exclusionReasons.some(
      ({ code }) => code === 'planning-observed-claim-overlap',
    ),
  );
  scope.claims[0].observed.paths = [];
  active.body = active.body.replace('Scope-Paths: other/file', 'Scope-Paths: files/sub/**');
  assert.equal(row(board([candidate, active], { scope }), 1).planningScope.status, 'blocked');
  scope.pullRequests = [{ number: 88, observed: { status: 'complete', paths: ['files/pr'] } }];
  assert(
    row(board([candidate], { scope }), 1).exclusionReasons.some(
      ({ code }) => code === 'planning-pr-overlap',
    ),
  );
  assert.equal(
    row(board([candidate, issue(7, 'blocked', { 'Scope-Paths': 'files/pr' })]), 1).planningScope
      .status,
    'blocked',
  );
});

test('unknown reservations, unsupported scope, orphan refs and global races never become clearance', () => {
  const legacy = issue(2, 'blocked', {}, '1');
  assert.equal(row(board([issue(1), legacy]), 1).planningScope.status, 'unknown');
  assert.equal(
    row(board([issue(1, 'ready', { 'Scope-Paths': 'none' }), legacy]), 1).availability,
    'available',
  );
  assert.equal(row(board([issue(1, 'ready', {}, '1')]), 1).availability, 'unknown');
  for (const status of ['unavailable', 'inactive'])
    assert.deepEqual(board([issue(1)], { scope: { status } }).candidates, []);
  const refs = [{ ref: 'refs/heads/claim-v1/issue-1', objectType: 'commit', sha: 'a'.repeat(40) }];
  assert.deepEqual(board([issue(1)], { refs }).candidates, []);
  const active = issue(2, 'active');
  active.body += '\nClaim-Agent: ambiguous';
  assert.equal(row(board([issue(1), active]), 1).planningScope.status, 'unknown');
});

test('mixed v1/v2 closures preserve legacy evidence without widening legacy availability', () => {
  const completed = issue(2, 'done', {}, '1');
  const result = board([
    issue(1, 'proposed', { 'Depends-On': '#2' }),
    completed,
    issue(3, 'ready', {}, '1'),
  ]);
  assert.deepEqual(result.candidates, [1]);
  assert.equal(row(result, 3).planningScope.status, 'unknown');
  assert.equal(row(result, 1).dependencyClosure.status, 'clear');
});

test('orphan contradictions stay closure-local while unmapped reserved evidence is global', () => {
  const refs = [{ ref: 'refs/heads/claim-v1/issue-1', objectType: 'commit', sha: 'a'.repeat(40) }];
  const result = board([issue(1), issue(2)], { refs });
  assert.deepEqual(result.candidates, [2]);
  assert.equal(row(result, 1).availability, 'unknown');
  refs.push({ ref: 'refs/heads/claim-v99/issue-3', objectType: 'commit', sha: 'a'.repeat(40) });
  assert.deepEqual(board([issue(1), issue(2)], { refs }).candidates, []);
});

test('unstructured plausible ownership cannot silently disappear from planning reservations', () => {
  const comments = new Map([
    [1, []],
    [
      2,
      [
        {
          id: 1,
          author: 'other',
          body: 'I am taking ownership',
          createdAt: '2026-09-06T11:00:00Z',
          updatedAt: '2026-09-06T11:00:00Z',
        },
      ],
    ],
  ]);
  const result = board([issue(1), issue(2)], { comments });
  assert.equal(row(result, 1).planningScope.status, 'unknown');
  assert.deepEqual(result.candidates, []);
});
