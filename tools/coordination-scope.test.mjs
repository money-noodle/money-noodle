import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { validateStandaloneCheckpointEvidence } from './coordination-schema.mjs';
import {
  assertFreshScopeGate,
  buildScopeRouting,
  changedPathsFromTrees,
  classifyClaimPair,
  compareUtf8,
  completeObservedEvidence,
  evaluateScopeGate,
  normalizeScopePaths,
  parseJsonWithUniqueKeys,
  parseScopeGate,
  parseScopePath,
  parseScopePathList,
  parseSerializingConfiguration,
  provisionalEmptyObservedEvidence,
  recoverInitialClaimBase,
  scopeEntryIntersects,
  scopeEntryMatchesPath,
} from './coordination-scope.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function entries(value) {
  const result = normalizeScopePaths(value);
  assert.equal(result.status, 'declared');
  return result.entries;
}

function claim(number, declared, observed, overrides = {}) {
  return {
    number,
    branch: `claim-v1/issue-${number}`,
    remoteHead: SHA_A,
    declaredEntries: entries(declared),
    observed,
    ...overrides,
  };
}

function pullRequest(number, paths, overrides = {}) {
  return {
    number,
    headRepository: 'money-noodle/money-noodle',
    headRef: `feature/${number}`,
    headSha: SHA_B,
    observed: completeObservedEvidence(paths),
    ...overrides,
  };
}

test('the exact grammar accepts only a repository file, literal prefix glob, or root glob', () => {
  assert.deepEqual(parseScopePath('docs/file.md'), {
    status: 'valid',
    kind: 'exact',
    value: 'docs/file.md',
    path: 'docs/file.md',
  });
  assert.equal(parseScopePath('docs/**').kind, 'prefix');
  assert.equal(parseScopePath('**').kind, 'root');
  assert.equal(parseScopePath('~/literal').kind, 'exact');
  assert.equal(parseScopePath('C:/drive-like').kind, 'exact');
  assert.equal(parseScopePath('C:literal').kind, 'exact');
  for (const invalid of [
    '',
    '/root',
    'root/',
    'a//b',
    './a',
    'a/../b',
    'a\\b',
    'a,b',
    'a b',
    'a\tb',
    'a\0b',
    '.git/config',
    '.GIT/config',
    'a/*.mjs',
    'a/**/b',
    'a?',
    'a[0]',
    'a{b}',
    'a!b',
    'Cafe\u0301.md',
    '\ud800',
  ]) {
    assert.equal(parseScopePath(invalid).status, 'invalid', invalid);
  }
  assert.equal(parseScopePath('**', { exactOnly: true }).status, 'invalid');
  assert.equal(parseScopePath('src/**', { exactOnly: true }).status, 'invalid');
});

test('declaration normalization is canonical, unique, and unsigned UTF-8 sorted', () => {
  assert.deepEqual(normalizeScopePaths('none'), { status: 'none', paths: [], entries: [] });
  assert.equal(normalizeScopePaths('docs/a.md, tools/**').status, 'declared');
  assert.equal(normalizeScopePaths('docs/a.md\ntools/**').status, 'declared');
  for (const invalid of [
    ' none',
    'none ',
    'tools/**,docs/a.md',
    'tools/**, docs/a.md',
    'docs/a.md,  tools/**',
    'docs/a.md, docs/a.md',
    'none, tools/**',
    'docs/a.md\r\ntools/**',
  ]) {
    assert.equal(normalizeScopePaths(invalid).status, 'invalid', invalid);
  }
  assert(compareUtf8('a', 'é') < 0);
  assert.equal(parseScopePathList(['é', 'a']).status, 'invalid');
  assert.equal(parseScopePathList([null, 'docs/a.md']).status, 'invalid');
  assert.deepEqual(
    completeObservedEvidence([], { status: 'unavailable', paths: ['escape'], count: 99 }),
    { status: 'complete', paths: [], count: 0 },
  );
});

test('mathematical intersections preserve the file-versus-descendant boundary', () => {
  const exact = parseScopePath('services/api');
  const child = parseScopePath('services/api/openapi.yaml');
  const prefix = parseScopePath('services/api/**');
  const nested = parseScopePath('services/api/openapi/**');
  const sibling = parseScopePath('services/web/**');
  assert.equal(scopeEntryIntersects(exact, prefix), false);
  assert.equal(scopeEntryIntersects(child, prefix), true);
  assert.equal(scopeEntryIntersects(prefix, nested), true);
  assert.equal(scopeEntryIntersects(prefix, sibling), false);
  assert.equal(scopeEntryIntersects(parseScopePath('**'), sibling), true);
  assert.equal(scopeEntryMatchesPath(prefix, 'services/api'), false);
  assert.equal(scopeEntryMatchesPath(prefix, 'services/api/a.ts'), true);
});

test('strict JSON tokenization rejects duplicate keys before materialization', () => {
  assert.equal(parseJsonWithUniqueKeys('{"outer":{"key":1,"key":2}}').code, 'duplicate-key');
  assert.equal(parseJsonWithUniqueKeys('{"a":1,"b":2}').status, 'valid');
});

test('the serializing file has exact accepted canonical bytes', () => {
  const source = readFileSync(
    new URL('../.github/coordination/serializing-paths.v1.json', import.meta.url),
    'utf8',
  );
  const parsed = parseSerializingConfiguration(source);
  assert.equal(Buffer.byteLength(source), 1238);
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '6862befc4d8b049f462154ca6d328607051ebea51fef17d35e18fdcebd7ca10d',
  );
  assert.equal(parsed.status, 'valid');
  assert.equal(parsed.paths.length, 32);
  for (const invalid of [
    source.replace('\n', '\r\n'),
    `\ufeff${source}`,
    source.trimEnd(),
    `${source}\n`,
    source.replace('  "version"', ' "version"'),
    source.replace('"version": 1,', '"version": 1,\n  "version": 1,'),
    source.replace('"version": 1', '"extra": true,\n  "version": 1'),
    source.replace('"version": 1', '"version": 2'),
  ]) {
    assert.equal(parseSerializingConfiguration(invalid).status, 'invalid');
  }
});

test('initial claim base recovery requires one fully valid unedited unreconciled establishment operation', () => {
  const identity = {
    'Claim-Harness': 'pi',
    'Claim-Run-ID': 'run-44',
    'Claim-Agent': 'agent-44',
    'Claim-Branch': 'claim-v1/issue-44',
    'Claim-Host': 'runner-01',
    'Claimed-At': '2026-09-05T01:00:00Z',
  };
  const lines = {
    ...identity,
    'Claim-State': 'active',
    'Check-In-By': '2026-09-05T05:00:00Z',
    'Waiting-Since': 'unclaimed',
    'Checkpoint-Evidence-Version': '1',
    'Checkpoint-State': 'active',
    'Checkpoint-At': identity['Claimed-At'],
    'Checkpoint-Commit': SHA_A,
    'Checkpoint-Changed-Path-Count': '0',
    'Checkpoint-Checks-Verdict': 'unavailable',
    'Checkpoint-CI-Run': 'unavailable',
    'Checkpoint-CI-Commit': 'unavailable',
    'Checkpoint-Security-Impact': 'present',
    'Checkpoint-Tenant-Impact': 'none',
    'Checkpoint-Provider-Impact': 'none',
    'Checkpoint-Deployment-Impact': 'none',
    'Checkpoint-Residual-Risk-Count': '1',
    'Next-Action': 'bootstrap',
    Blockers: 'none',
  };
  const issue = {
    body: `Reconciled-Claim-Comment-IDs: none\n${Object.entries(identity)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}\n`,
  };
  const comment = {
    id: 10,
    body: `Coordination-Write-ID: claim-44\n${Object.entries(lines)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}\n`,
    createdAt: '2026-09-05T01:00:00Z',
    updatedAt: '2026-09-05T01:00:00Z',
  };
  const recover = (candidateIssue, candidateComments) =>
    recoverInitialClaimBase(candidateIssue, candidateComments, {
      validateCheckpointEvidence: validateStandaloneCheckpointEvidence,
    });
  assert.deepEqual(recover(issue, [comment]), {
    status: 'recovered',
    baseCommit: SHA_A,
    commentId: 10,
  });
  assert.equal(recover(issue, [comment, { ...comment, id: 11 }]).status, 'unavailable');
  assert.equal(
    recover(issue, [{ ...comment, updatedAt: '2026-09-05T02:00:00Z' }]).status,
    'unavailable',
  );
  assert.equal(
    recover({ ...issue, body: issue.body.replace('none', '10') }, [comment]).status,
    'unavailable',
  );
  assert.equal(
    recover(issue, [{ ...comment, body: comment.body.replace('claim-44', 'claim/44') }]).status,
    'unavailable',
  );
  for (const invalidBody of [
    comment.body.replace('Check-In-By: 2026-09-05T05:00:00Z', 'Check-In-By: unclaimed'),
    comment.body.replace('Checkpoint-CI-Run: unavailable', 'Checkpoint-CI-Run: bad'),
    comment.body.replace('Checkpoint-Tenant-Impact: none', 'Checkpoint-Tenant-Impact: maybe'),
    comment.body.replace(
      'Checkpoint-Checks-Verdict: unavailable',
      'Checkpoint-Checks-Verdict: passed',
    ),
  ]) {
    assert.equal(
      recover(issue, [{ ...comment, body: invalidBody }]).status,
      'unavailable',
      invalidBody,
    );
  }
});

test('complete recursive immutable trees derive exact sorted changed paths and fail closed', () => {
  const base = {
    commitSha: SHA_A,
    treeSha: SHA_B,
    truncated: false,
    entries: [
      { path: 'a.txt', mode: '100644', type: 'blob', sha: SHA_A },
      { path: 'dir', mode: '040000', type: 'tree', sha: SHA_B },
      { path: 'dir/old.txt', mode: '100644', type: 'blob', sha: SHA_C },
      { path: 'link', mode: '120000', type: 'blob', sha: SHA_A },
      { path: 'module', mode: '160000', type: 'commit', sha: SHA_A },
      { path: 'node', mode: '040000', type: 'tree', sha: SHA_B },
      { path: 'node/child.txt', mode: '100644', type: 'blob', sha: SHA_A },
    ],
  };
  const head = {
    commitSha: SHA_B,
    treeSha: SHA_C,
    truncated: false,
    entries: [
      { path: 'a.txt', mode: '100755', type: 'blob', sha: SHA_A },
      { path: 'dir', mode: '040000', type: 'tree', sha: SHA_B },
      { path: 'dir/new.txt', mode: '100644', type: 'blob', sha: SHA_C },
      { path: 'link', mode: '120000', type: 'blob', sha: SHA_B },
      { path: 'module', mode: '160000', type: 'commit', sha: SHA_B },
      { path: 'node', mode: '100644', type: 'blob', sha: SHA_C },
    ],
  };
  assert.deepEqual(changedPathsFromTrees(base, head).paths, [
    'a.txt',
    'dir/new.txt',
    'dir/old.txt',
    'link',
    'module',
    'node',
    'node/child.txt',
  ]);
  assert.equal(changedPathsFromTrees({ ...base, truncated: true }, head).status, 'unavailable');
  assert.equal(
    changedPathsFromTrees({ ...base, entries: [...base.entries, base.entries[0]] }, head).status,
    'unavailable',
  );
  assert.equal(
    changedPathsFromTrees({ ...base, entries: [{ ...base.entries[0], path: '../escape' }] }, head)
      .status,
    'unavailable',
  );
  assert.equal(
    changedPathsFromTrees(
      {
        ...base,
        entries: [{ path: 'missing/child.txt', mode: '100644', type: 'blob', sha: SHA_A }],
      },
      head,
    ).status,
    'unavailable',
  );
});

test('claim pair blockers cover exact, observed, creep, count, unavailable, and serializing intersections', () => {
  const serializing = entries('docs/development/parallel-work.md, tools/coordination-lib.mjs');
  const exact = classifyClaimPair(
    claim(1, 'docs/a.md', completeObservedEvidence([])),
    claim(2, 'docs/a.md', completeObservedEvidence([])),
    serializing,
  );
  assert.equal(exact.status, 'blocked');
  assert(exact.blockers.includes('exact declared-file collision'));

  const observed = classifyClaimPair(
    claim(1, 'docs/**', completeObservedEvidence(['docs/a.md'])),
    claim(2, 'docs/**', completeObservedEvidence(['docs/a.md'])),
    serializing,
  );
  assert(observed.blockers.includes('observed same-path collision'));

  const serialized = classifyClaimPair(
    claim(1, 'docs/**', completeObservedEvidence([])),
    claim(2, 'docs/development/**', completeObservedEvidence([])),
    serializing,
  );
  assert(serialized.blockers.includes('serializing-path collision'));

  const creep = classifyClaimPair(
    claim(1, 'docs/**', completeObservedEvidence(['tools/a.mjs'])),
    claim(2, 'services/**', completeObservedEvidence([])),
    serializing,
  );
  assert(creep.blockers.includes('observed paths exceed declared scope'));

  const countMismatch = classifyClaimPair(
    claim(1, 'docs/**', { ...completeObservedEvidence([]), count: 1 }),
    claim(2, 'services/**', completeObservedEvidence([])),
    serializing,
  );
  assert(
    countMismatch.blockers.includes('changed-path count disagrees with the complete observed set'),
  );

  const unavailable = classifyClaimPair(
    claim(1, 'docs/**', { status: 'unavailable', paths: [], count: null }),
    claim(2, 'services/**', completeObservedEvidence([])),
    serializing,
  );
  assert(unavailable.blockers.includes('observed evidence is unavailable'));

  const provisional = classifyClaimPair(
    claim(1, 'apps/**', provisionalEmptyObservedEvidence()),
    claim(2, 'services/**', completeObservedEvidence([])),
    serializing,
    { leftProvisional: true },
  );
  assert.equal(provisional.status, 'clear');
  assert.equal(
    classifyClaimPair(
      claim(1, 'apps/**', provisionalEmptyObservedEvidence()),
      claim(2, 'services/**', completeObservedEvidence([])),
      serializing,
    ).status,
    'blocked',
  );
});

test('broad overlap is advisory only with complete disjoint observed sets', () => {
  const result = classifyClaimPair(
    claim(1, 'docs/**', completeObservedEvidence(['docs/a.md'])),
    claim(2, 'docs/**', completeObservedEvidence(['docs/b.md'])),
    entries('tools/coordination-lib.mjs'),
  );
  assert.equal(result.status, 'advisory');
});

test('intrinsic claim defects route only to the affected claim', () => {
  const affected = claim(44, 'docs/**', completeObservedEvidence(['tools/a.mjs']));
  const unrelated = claim(45, 'services/**', completeObservedEvidence([]));
  const result = buildScopeRouting({
    repository: 'money-noodle/money-noodle',
    claims: [affected, unrelated],
    pullRequests: [],
    serializingEntries: entries('tools/coordination-lib.mjs'),
  });
  assert.deepEqual(result.claimScopes.get(44).claimBlockerIds, ['scope-v1:claim:44:scope-creep']);
  assert.equal(result.claimScopes.get(44).status, 'blocked');
  assert.deepEqual(result.claimScopes.get(45).claimBlockerIds, []);
  assert.equal(result.claimScopes.get(45).status, 'clear');
});

test('same-named fork and duplicate self-PR association remain unavailable', () => {
  const owner = claim(44, 'docs/**', completeObservedEvidence([]));
  const fork = pullRequest(70, ['docs/a.md'], {
    headRepository: 'fork/example',
    headRef: owner.branch,
    headSha: owner.remoteHead,
  });
  const forkResult = buildScopeRouting({
    repository: 'money-noodle/money-noodle',
    claims: [owner],
    pullRequests: [fork],
    serializingEntries: entries('tools/coordination-lib.mjs'),
  });
  assert.equal(forkResult.claimScopes.get(44).status, 'unavailable');
  assert.equal(forkResult.pullRequestScopes.get(70).status, 'unavailable');

  const self = pullRequest(71, [], {
    headRef: owner.branch,
    headSha: owner.remoteHead,
  });
  const duplicate = buildScopeRouting({
    repository: 'money-noodle/money-noodle',
    claims: [owner],
    pullRequests: [self, { ...self, number: 72 }],
    serializingEntries: entries('tools/coordination-lib.mjs'),
  });
  assert.equal(duplicate.claimScopes.get(44).status, 'unavailable');
});

test('stable canonical findings route only to operation-specific targets', () => {
  const claims = [claim(44, 'docs/**', completeObservedEvidence(['docs/a.md']))];
  const pulls = [
    pullRequest(70, ['docs/b.md']),
    pullRequest(71, ['docs/b.md', 'services/a.ts']),
    pullRequest(72, ['docs/self.md'], {
      headRef: 'claim-v1/issue-44',
      headSha: SHA_A,
    }),
  ];
  const result = buildScopeRouting({
    repository: 'money-noodle/money-noodle',
    claims,
    pullRequests: pulls,
    serializingEntries: entries('tools/coordination-lib.mjs'),
  });
  assert.deepEqual(
    result.findings.map(({ id }) => id),
    ['scope-v1:claim-pr:44:70', 'scope-v1:claim-pr:44:71', 'scope-v1:pr-pr:70:71'],
  );
  assert.equal(result.findings[0].version, 1);
  assert.deepEqual(result.findings[0].routes, [
    { gate: 'claim', target: 44 },
    { gate: 'publication', target: 44 },
    { gate: 'checkpoint', target: 44 },
    { gate: 'integration-pr', target: 70 },
  ]);
  assert.deepEqual(evaluateScopeGate('claim:44', result.findings), {
    requested: 'claim:44',
    status: 'blocked',
    blockingFindingIds: ['scope-v1:claim-pr:44:70', 'scope-v1:claim-pr:44:71'],
  });
  assert.equal(evaluateScopeGate('integration-pr:72', result.findings).status, 'clear');
  assert.equal(
    evaluateScopeGate('publication:70', result.findings, { targetExists: false }).status,
    'unknown',
  );
  assert.equal(evaluateScopeGate('claim:44', result.findings, { known: false }).status, 'unknown');
  assert.equal(parseScopeGate('claim:01').status, 'invalid');
  assert.equal(parseScopeGate('publication:0').status, 'invalid');
  assert.equal(evaluateScopeGate(undefined, result.findings).status, 'clear');
  assert.equal(
    assertFreshScopeGate(
      evaluateScopeGate('integration-pr:72', result.findings),
      'integration-pr:72',
    ),
    true,
  );
  assert.throws(() =>
    assertFreshScopeGate(evaluateScopeGate('claim:44', result.findings), 'claim:44'),
  );
  assert.throws(() =>
    assertFreshScopeGate(evaluateScopeGate('board', result.findings), 'claim:44'),
  );
  assert.throws(() =>
    assertFreshScopeGate(
      { requested: 'publication:44', status: 'clear', blockingFindingIds: [] },
      'checkpoint:44',
    ),
  );
});
