import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
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
