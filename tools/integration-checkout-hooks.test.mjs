import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateClaimBootstrapEvidence } from './coordination-lib.mjs';

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_NAMES = ['pre-commit', 'pre-merge-commit'];

function git(repository, args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function attemptGit(repository, args) {
  return spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function write(repository, path, contents) {
  const destination = join(repository, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function commit(repository, message) {
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', message]);
}

function disposableRepository(t) {
  const repository = mkdtempSync(join(tmpdir(), 'mn-integration-hooks-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', '--local', 'user.name', 'Money Noodle Test']);
  git(repository, ['config', '--local', 'user.email', 'test@example.invalid']);
  git(repository, ['config', '--local', 'commit.gpgsign', 'false']);
  write(repository, 'state.txt', 'base\n');
  commit(repository, 'Create base');
  return repository;
}

function bootstrapFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mn-claim-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const integration = join(root, 'integration');
  const claimWorktree = join(root, 'claim-worktree');
  git(root, ['init', '--bare', remote]);
  git(root, ['clone', remote, integration]);
  git(integration, ['config', '--local', 'user.name', 'Money Noodle Test']);
  git(integration, ['config', '--local', 'user.email', 'test@example.invalid']);
  git(integration, ['config', '--local', 'commit.gpgsign', 'false']);
  git(integration, ['switch', '-c', 'main']);
  write(integration, 'base.txt', 'base\n');
  commit(integration, 'Create main');
  git(integration, ['push', '-u', 'origin', 'main']);
  git(integration, ['switch', '-c', 'claim-v1/issue-61']);
  write(integration, 'claim.txt', 'claim\n');
  commit(integration, 'Create claim checkpoint');
  const checkpoint = git(integration, ['rev-parse', 'HEAD']).trim();
  git(integration, ['push', 'origin', 'refs/heads/claim-v1/issue-61']);
  git(integration, ['switch', 'main']);
  git(integration, ['branch', '-D', 'claim-v1/issue-61']);
  git(integration, ['update-ref', '-d', 'refs/remotes/origin/claim-v1/issue-61']);
  return { root, remote, integration, claimWorktree, checkpoint };
}

function refExists(repository, ref) {
  return attemptGit(repository, ['show-ref', '--verify', '--quiet', ref]).status === 0;
}

function integrationState(repository) {
  return {
    symbolicRef: git(repository, ['symbolic-ref', '-q', 'HEAD']).trim(),
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    clean: git(repository, ['status', '--porcelain=v2', '--untracked-files=all']).trim() === '',
    inProgress: false,
  };
}

function directRemoteClaim(repository) {
  const output = git(repository, [
    'ls-remote',
    '--refs',
    'origin',
    'refs/heads/claim-v1/issue-61',
  ]).trim();
  if (!output) return { status: 'missing' };
  const sha = output.split(/\s+/)[0];
  return {
    status: 'found',
    ref: 'refs/heads/claim-v1/issue-61',
    objectType: 'commit',
    sha,
  };
}

function worktreeUsesBranch(repository, branchRef) {
  const records = git(repository, ['worktree', 'list', '--porcelain']).trim().split(/\n\n+/);
  return records.some((record) => record.split('\n').includes(`branch ${branchRef}`));
}

function bootstrapClaim(fixture) {
  const { integration, claimWorktree, checkpoint } = fixture;
  const branch = 'claim-v1/issue-61';
  const branchRef = `refs/heads/${branch}`;
  const trackingRef = `refs/remotes/origin/${branch}`;
  const integrationBefore = integrationState(integration);
  const directRefBefore = directRemoteClaim(integration);
  const preexisting = {
    localBranch: refExists(integration, branchRef),
    worktreePath: existsSync(claimWorktree),
    branchWorktree: worktreeUsesBranch(integration, branchRef),
    remoteTracking: refExists(integration, trackingRef) ? 'present' : 'missing',
  };
  const evidence = {
    issueNumber: 61,
    checkpointCommit: checkpoint,
    directRefBefore,
    directRefAfter: directRefBefore,
    preexisting,
    fetch: null,
    pushCount: 0,
    remoteTrackingHead: null,
    localBranchHead: null,
    branchRemote: null,
    branchMerge: null,
    claimWorktree: null,
    integrationBefore,
    integrationAfter: integrationState(integration),
  };
  if (
    !integrationBefore.clean ||
    integrationBefore.inProgress ||
    Object.values(preexisting).some((value) => value !== false && value !== 'missing')
  ) {
    return { evidence, result: validateClaimBootstrapEvidence(evidence) };
  }

  const fetched = attemptGit(integration, [
    '-c',
    'maintenance.auto=false',
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-write-fetch-head',
    'origin',
    `${branchRef}:${trackingRef}`,
  ]);
  evidence.fetch = {
    status: fetched.status === 0 ? 'succeeded' : 'failed',
    remote: 'origin',
    sourceRef: branchRef,
    destinationRef: trackingRef,
    tags: false,
    force: false,
    writeFetchHead: false,
    recurseSubmodules: false,
    autoMaintenance: false,
  };
  if (fetched.status !== 0) {
    evidence.integrationAfter = integrationState(integration);
    return { evidence, result: validateClaimBootstrapEvidence(evidence) };
  }
  git(integration, ['branch', '--track', branch, trackingRef]);
  git(integration, ['worktree', 'add', claimWorktree, branch]);
  evidence.directRefAfter = directRemoteClaim(integration);
  evidence.remoteTrackingHead = git(integration, ['rev-parse', trackingRef]).trim();
  evidence.localBranchHead = git(integration, ['rev-parse', branchRef]).trim();
  evidence.branchRemote = git(integration, ['config', '--get', `branch.${branch}.remote`]).trim();
  evidence.branchMerge = git(integration, ['config', '--get', `branch.${branch}.merge`]).trim();
  evidence.claimWorktree = {
    head: git(claimWorktree, ['rev-parse', 'HEAD']).trim(),
    branch: git(claimWorktree, ['symbolic-ref', '-q', 'HEAD']).trim(),
    symbolicRef: git(claimWorktree, ['symbolic-ref', '-q', 'HEAD']).trim(),
    countForBranch: worktreeUsesBranch(integration, branchRef) ? 1 : 0,
    locked: false,
    prunable: false,
    clean: git(claimWorktree, ['status', '--porcelain=v2', '--untracked-files=all']).trim() === '',
  };
  evidence.integrationAfter = integrationState(integration);
  return { evidence, result: validateClaimBootstrapEvidence(evidence) };
}

function activateDisposableHooks(repository) {
  const hooks = join(repository, '.githooks');
  mkdirSync(hooks);
  for (const name of HOOK_NAMES) {
    const source = join(REPOSITORY_ROOT, '.githooks', name);
    const destination = join(hooks, name);
    copyFileSync(source, destination);
    chmodSync(destination, 0o755);
  }
  git(repository, ['config', '--local', 'core.hooksPath', '.githooks']);
}

test('committed integration hooks are executable POSIX shell programs', () => {
  for (const name of HOOK_NAMES) {
    const path = join(REPOSITORY_ROOT, '.githooks', name);
    assert.equal(statSync(path).mode & 0o111, 0o111, name);
    assert.match(readFileSync(path, 'utf8'), /^#!\/bin\/sh\n/);
  }
});

test('claim bootstrap validates an exact no-force fetch and five matching SHAs', (t) => {
  const fixture = bootstrapFixture(t);
  const remoteBefore = git(fixture.integration, ['ls-remote', '--heads', 'origin']);
  rmSync(join(fixture.integration, '.git', 'FETCH_HEAD'), { force: true });
  const { evidence, result } = bootstrapClaim(fixture);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(
    new Set([
      evidence.checkpointCommit,
      evidence.directRefAfter.sha,
      evidence.remoteTrackingHead,
      evidence.localBranchHead,
      evidence.claimWorktree.head,
    ]).size,
    1,
  );
  assert.equal(existsSync(join(fixture.integration, '.git', 'FETCH_HEAD')), false);
  assert.equal(git(fixture.integration, ['ls-remote', '--heads', 'origin']), remoteBefore);
  assert.equal(evidence.pushCount, 0);
  assert.equal(evidence.integrationBefore.head, evidence.integrationAfter.head);
  assert.equal(evidence.integrationAfter.symbolicRef, 'refs/heads/main');
});

test('claim bootstrap preserves branch, path, worktree, tracking, partial, and dirty collisions', (t) => {
  const branchCollision = bootstrapFixture(t);
  git(branchCollision.integration, ['branch', 'claim-v1/issue-61', branchCollision.checkpoint]);
  const branchResult = bootstrapClaim(branchCollision);
  assert.equal(branchResult.result.valid, false);
  assert.equal(
    git(branchCollision.integration, ['rev-parse', 'refs/heads/claim-v1/issue-61']).trim(),
    branchCollision.checkpoint,
  );
  assert.equal(existsSync(branchCollision.claimWorktree), false);

  const pathCollision = bootstrapFixture(t);
  mkdirSync(pathCollision.claimWorktree);
  write(pathCollision.claimWorktree, 'marker.txt', 'preserve\n');
  assert.equal(bootstrapClaim(pathCollision).result.valid, false);
  assert.equal(readFileSync(join(pathCollision.claimWorktree, 'marker.txt'), 'utf8'), 'preserve\n');
  assert.equal(refExists(pathCollision.integration, 'refs/heads/claim-v1/issue-61'), false);

  const worktreeCollision = bootstrapFixture(t);
  git(worktreeCollision.integration, [
    'worktree',
    'add',
    '-b',
    'claim-v1/issue-61',
    join(worktreeCollision.root, 'other-worktree'),
    worktreeCollision.checkpoint,
  ]);
  assert.equal(bootstrapClaim(worktreeCollision).result.valid, false);
  assert.equal(
    worktreeUsesBranch(worktreeCollision.integration, 'refs/heads/claim-v1/issue-61'),
    true,
  );
  assert.equal(existsSync(worktreeCollision.claimWorktree), false);

  const trackingCollision = bootstrapFixture(t);
  git(trackingCollision.integration, [
    'update-ref',
    'refs/remotes/origin/claim-v1/issue-61',
    trackingCollision.checkpoint,
  ]);
  assert.equal(bootstrapClaim(trackingCollision).result.valid, false);
  assert.equal(
    git(trackingCollision.integration, [
      'rev-parse',
      'refs/remotes/origin/claim-v1/issue-61',
    ]).trim(),
    trackingCollision.checkpoint,
  );

  const dirtyIntegration = bootstrapFixture(t);
  write(dirtyIntegration.integration, 'dirty.txt', 'preserve dirty state\n');
  assert.equal(bootstrapClaim(dirtyIntegration).result.valid, false);
  assert.equal(
    readFileSync(join(dirtyIntegration.integration, 'dirty.txt'), 'utf8'),
    'preserve dirty state\n',
  );
  assert.equal(refExists(dirtyIntegration.integration, 'refs/heads/claim-v1/issue-61'), false);
});

test('claim bootstrap validation rejects partial, dirty, non-fast-forward, and raced evidence without repair', (t) => {
  const partial = bootstrapFixture(t);
  git(partial.integration, ['branch', 'claim-v1/issue-61', partial.checkpoint]);
  const partialEvidence = bootstrapClaim(partial).evidence;
  assert.equal(validateClaimBootstrapEvidence(partialEvidence).valid, false);
  assert.equal(existsSync(partial.claimWorktree), false);

  const dirty = bootstrapFixture(t);
  const bootstrapped = bootstrapClaim(dirty);
  write(dirty.claimWorktree, 'untracked.txt', 'preserve\n');
  bootstrapped.evidence.claimWorktree.clean = false;
  assert.equal(validateClaimBootstrapEvidence(bootstrapped.evidence).valid, false);
  assert.equal(readFileSync(join(dirty.claimWorktree, 'untracked.txt'), 'utf8'), 'preserve\n');

  const collision = bootstrapFixture(t);
  git(collision.integration, ['switch', '--detach', collision.checkpoint]);
  write(collision.integration, 'divergent.txt', 'divergent\n');
  commit(collision.integration, 'Create divergent tracking value');
  const divergent = git(collision.integration, ['rev-parse', 'HEAD']).trim();
  git(collision.integration, ['switch', 'main']);
  git(collision.integration, ['update-ref', 'refs/remotes/origin/claim-v1/issue-61', divergent]);
  const refused = attemptGit(collision.integration, [
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    'origin',
    'refs/heads/claim-v1/issue-61:refs/remotes/origin/claim-v1/issue-61',
  ]);
  assert.notEqual(refused.status, 0);
  assert.equal(
    git(collision.integration, ['rev-parse', 'refs/remotes/origin/claim-v1/issue-61']).trim(),
    divergent,
  );
  const refusedEvidence = {
    ...bootstrapClaim(collision).evidence,
    fetch: {
      status: 'non-fast-forward-refused',
      remote: 'origin',
      sourceRef: 'refs/heads/claim-v1/issue-61',
      destinationRef: 'refs/remotes/origin/claim-v1/issue-61',
      tags: false,
      force: false,
      writeFetchHead: false,
      recurseSubmodules: false,
      autoMaintenance: false,
    },
  };
  assert.equal(validateClaimBootstrapEvidence(refusedEvidence).valid, false);

  const raced = bootstrapFixture(t);
  const before = directRemoteClaim(raced.integration);
  git(raced.remote, [
    'update-ref',
    'refs/heads/claim-v1/issue-61',
    git(raced.integration, ['rev-parse', 'main']).trim(),
  ]);
  const after = directRemoteClaim(raced.integration);
  const racedEvidence = bootstrapClaim(raced).evidence;
  racedEvidence.directRefBefore = before;
  racedEvidence.directRefAfter = after;
  assert.notEqual(before.sha, after.sha);
  assert.equal(validateClaimBootstrapEvidence(racedEvidence).valid, false);
});

test('pre-commit refuses a normal authored commit on main and allows a topic commit', (t) => {
  const repository = disposableRepository(t);
  activateDisposableHooks(repository);
  const mainHead = git(repository, ['rev-parse', 'HEAD']).trim();
  write(repository, 'state.txt', 'direct main change\n');
  git(repository, ['add', 'state.txt']);

  const refused = attemptGit(repository, ['commit', '-m', 'Direct main change']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to create an authored commit.*main/i);
  assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), mainHead);

  git(repository, ['switch', '-c', 'feat/topic']);
  const accepted = attemptGit(repository, ['commit', '-m', 'Topic change']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.notEqual(git(repository, ['rev-parse', 'HEAD']).trim(), mainHead);
});

test('similarly named non-main branches are not blocked by either hook', (t) => {
  const repository = disposableRepository(t);
  activateDisposableHooks(repository);
  git(repository, ['switch', '-c', 'topic/main']);
  write(repository, 'topic.txt', 'topic\n');
  const authored = attemptGit(repository, ['add', '.']);
  assert.equal(authored.status, 0, authored.stderr);
  const committed = attemptGit(repository, ['commit', '-m', 'Topic named main']);
  assert.equal(committed.status, 0, committed.stderr);

  git(repository, ['switch', '-c', 'feat/side', 'main']);
  write(repository, 'side.txt', 'side\n');
  commit(repository, 'Create side');
  git(repository, ['switch', 'topic/main']);
  write(repository, 'topic-two.txt', 'topic two\n');
  commit(repository, 'Diverge topic');
  const merged = attemptGit(repository, ['merge', '--no-edit', 'feat/side']);
  assert.equal(merged.status, 0, merged.stderr);
});

test('an exact fast-forward on main succeeds because it creates no merge commit', (t) => {
  const repository = disposableRepository(t);
  activateDisposableHooks(repository);
  git(repository, ['switch', '-c', 'feat/fast-forward']);
  write(repository, 'feature.txt', 'fast-forward\n');
  commit(repository, 'Create fast-forward topic');
  const topicHead = git(repository, ['rev-parse', 'HEAD']).trim();
  git(repository, ['switch', 'main']);

  const merged = attemptGit(repository, ['merge', '--ff-only', 'feat/fast-forward']);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), topicHead);
});

test('pre-merge-commit refuses a non-fast-forward merge on main', (t) => {
  const repository = disposableRepository(t);
  git(repository, ['switch', '-c', 'feat/non-fast-forward']);
  write(repository, 'feature.txt', 'feature\n');
  commit(repository, 'Create feature side');
  git(repository, ['switch', 'main']);
  write(repository, 'main-side.txt', 'main side\n');
  commit(repository, 'Create main side');
  const mainHead = git(repository, ['rev-parse', 'HEAD']).trim();
  activateDisposableHooks(repository);

  const refused = attemptGit(repository, ['merge', '--no-edit', 'feat/non-fast-forward']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to create a merge commit.*main/i);
  assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), mainHead);
});

test('a non-fast-forward merge commit remains available on a topic integration-test branch', (t) => {
  const repository = disposableRepository(t);
  git(repository, ['switch', '-c', 'feat/side']);
  write(repository, 'side.txt', 'side\n');
  commit(repository, 'Create side');
  git(repository, ['switch', 'main']);
  git(repository, ['switch', '-c', 'test/integration-pr-61-base-bbbbbbbbbbbb-attempt-1']);
  write(repository, 'scratch.txt', 'scratch\n');
  commit(repository, 'Create scratch side');
  activateDisposableHooks(repository);

  const merged = attemptGit(repository, ['merge', '--no-edit', 'feat/side']);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(
    git(repository, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length,
    3,
  );
});
