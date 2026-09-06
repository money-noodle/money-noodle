#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeScopePaths,
  parseReservedClaimRef,
  validateStandaloneCheckpointEvidence,
} from './coordination-schema.mjs';
import {
  buildScopeRouting,
  changedPathsFromTrees,
  compareUtf8,
  evaluateScopeGate,
  parseScopeGate,
  parseSerializingConfiguration,
  provisionalEmptyObservedEvidence,
  recoverInitialClaimBase,
} from './coordination-scope.mjs';
import {
  SCHEMA_VERSION,
  analyzeCoordination,
  authoritativeCommitRelationship,
  claimField,
  classifyCommitRelationship,
  classifyIntegrationCheckout,
  classifyRemoteClaimEvidence,
  isoInstantMilliseconds,
} from './coordination-lib.mjs';

const REQUIRED_LABELS = [
  "work:plan",
  "work:proposed",
  "work:ready",
  "work:active",
  "work:blocked",
  "work:review",
  "work:done",
  "work:abandoned",
];
const ADVISORY =
  "Candidate output is triage evidence only; it never proves that claiming is safe or authorizes takeover, cleanup, integration, push, or deployment.";

function run(command, args, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
    killSignal: 'SIGTERM',
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail =
      result.error?.message ||
      result.stderr?.trim() ||
      (result.signal ? `terminated by ${result.signal}` : `exit status ${result.status}`);
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error.message}`);
  }
}

function apiPages(endpoint) {
  const pages = parseJson(
    run('gh', ['api', '--paginate', '--slurp', endpoint]).stdout,
    `gh api ${endpoint}`,
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`gh api ${endpoint} returned an invalid paginated response`);
  }
  return pages.flat();
}

function apiRecord(endpoint) {
  const record = parseJson(run('gh', ['api', endpoint]).stdout, `gh api ${endpoint}`);
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`gh api ${endpoint} returned an invalid record`);
  }
  return record;
}

function requiredString(value, context) {
  if (typeof value !== "string") throw new Error(`${context} must be a string`);
  return value;
}

function requiredTimestamp(value, context) {
  const timestamp = requiredString(value, context);
  if (isoInstantMilliseconds(timestamp) === undefined) {
    throw new Error(`${context} must be a strict valid ISO instant`);
  }
  return timestamp;
}

function normalizeLabels(value, context) {
  if (!Array.isArray(value)) throw new Error(`${context} labels must be an array`);
  return value.map((label, index) =>
    requiredString(label?.name, `${context} label ${index + 1} name`),
  );
}

function normalizeIssue(issue) {
  if (!Number.isInteger(issue?.number)) throw new Error("GitHub issue number must be an integer");
  const context = `GitHub issue #${issue.number}`;
  if (!['open', 'closed'].includes(issue.state)) throw new Error(`${context} has invalid state`);
  return {
    number: issue.number,
    title: requiredString(issue.title, `${context} title`),
    body: requiredString(issue.body, `${context} body`),
    state: issue.state,
    labels: normalizeLabels(issue.labels, context),
    updatedAt: requiredTimestamp(issue.updated_at, `${context} updated_at`),
    url: requiredString(issue.html_url, `${context} html_url`),
  };
}

function normalizeComment(comment, issueNumber) {
  if (!Number.isInteger(comment?.id)) throw new Error(`GitHub issue #${issueNumber} comment id must be an integer`);
  const context = `GitHub issue #${issueNumber} comment ${comment.id}`;
  return {
    id: comment.id,
    author: requiredString(comment.user?.login, `${context} author`),
    body: requiredString(comment.body, `${context} body`),
    createdAt: requiredTimestamp(comment.created_at, `${context} created_at`),
    updatedAt: requiredTimestamp(comment.updated_at, `${context} updated_at`),
  };
}

function normalizeRemoteRef(record, index) {
  const context = `GitHub reserved claim ref ${index + 1}`;
  return {
    ref: requiredString(record?.ref, `${context} ref`),
    objectType: requiredString(record?.object?.type, `${context} object type`),
    sha: requiredString(record?.object?.sha, `${context} object sha`),
  };
}

function normalizePullRequest(pr) {
  if (!Number.isInteger(pr?.number)) throw new Error('GitHub pull request number must be an integer');
  const context = `GitHub pull request #${pr.number}`;
  return {
    number: pr.number,
    title: requiredString(pr.title, `${context} title`),
    state: typeof pr.state === 'string' ? pr.state : null,
    headRefName: requiredString(pr.head?.ref, `${context} head ref`),
    headRef: requiredString(pr.head?.ref, `${context} head ref`),
    headSha: typeof pr.head?.sha === 'string' ? pr.head.sha : null,
    headRepository: typeof pr.head?.repo?.full_name === 'string' ? pr.head.repo.full_name : null,
    baseRefName: requiredString(pr.base?.ref, `${context} base ref`),
    baseRef: requiredString(pr.base?.ref, `${context} base ref`),
    baseSha: typeof pr.base?.sha === 'string' ? pr.base.sha : null,
    baseRepository: typeof pr.base?.repo?.full_name === 'string' ? pr.base.repo.full_name : null,
    updatedAt: requiredTimestamp(pr.updated_at, `${context} updated_at`),
    url: requiredString(pr.html_url, `${context} html_url`),
    draft: typeof pr.draft === 'boolean' ? pr.draft : null,
  };
}

function requireUnique(records, key, context) {
  const values = records.map((record) => record[key]);
  if (new Set(values).size !== values.length) {
    throw new Error(`${context} contains duplicate ${key} identities`);
  }
  return records;
}

function stableRecordSet(records, key) {
  return [...records].sort((left, right) =>
    typeof left[key] === 'number' ? left[key] - right[key] : compareUtf8(left[key], right[key]),
  );
}

function stableIssueSet(issues) {
  return stableRecordSet(
    issues.map((issue) => {
      if (new Set(issue.labels).size !== issue.labels.length) {
        throw new Error(`GitHub issue #${issue.number} contains duplicate label identities`);
      }
      return { ...issue, labels: [...issue.labels].sort(compareUtf8) };
    }),
    'number',
  );
}

function registrySurfaceIdentity({ labels, issues, commentsByIssue, reservedRefs, pullRequests, main }) {
  const refIdentity = ({ ref, objectType, sha }) => ({ ref, objectType, sha });
  const pullIdentity = ({
    number,
    title,
    state,
    headRefName,
    headRef,
    headSha,
    headRepository,
    baseRefName,
    baseRef,
    baseSha,
    baseRepository,
    updatedAt,
    url,
    draft,
  }) => ({
    number,
    title,
    state,
    headRefName,
    headRef,
    headSha,
    headRepository,
    baseRefName,
    baseRef,
    baseSha,
    baseRepository,
    updatedAt,
    url,
    draft,
  });
  return JSON.stringify({
    labels: [...labels].sort(compareUtf8),
    issues: stableIssueSet(issues),
    comments: [...commentsByIssue.entries()]
      .sort(([left], [right]) => left - right)
      .map(([issueNumber, comments]) => [issueNumber, stableRecordSet(comments, 'id')]),
    reservedRefs: stableRecordSet(reservedRefs.map(refIdentity), 'ref'),
    pullRequests: stableRecordSet(pullRequests.map(pullIdentity), 'number'),
    main,
  });
}

function rereadRegistrySurfaces(repository) {
  const labels = apiPages(`repos/${repository}/labels?per_page=100`).map((label, index) =>
    requiredString(label?.name, `GitHub label ${index + 1} name`),
  );
  requireUnique(labels.map((name) => ({ name })), 'name', 'GitHub labels');
  let issues = apiPages(`repos/${repository}/issues?state=all&per_page=100`)
    .filter((issue) => !issue?.pull_request)
    .map(normalizeIssue);
  requireUnique(issues, 'number', 'GitHub issues');
  const reservedRefs = apiPages(
    `repos/${repository}/git/matching-refs/heads/claim-v?per_page=100`,
  ).map(normalizeRemoteRef);
  requireUnique(reservedRefs, 'ref', 'GitHub reserved claim refs');
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  for (const remote of reservedRefs) {
    const mapping = parseReservedClaimRef(remote.ref);
    if (mapping.status !== 'supported') continue;
    const listed = issueByNumber.get(mapping.issueNumber);
    if (!listed || listed.state === 'closed') {
      const direct = normalizeIssue(apiRecord(`repos/${repository}/issues/${mapping.issueNumber}`));
      if (direct.number !== mapping.issueNumber) {
        throw new Error(`direct GitHub issue #${mapping.issueNumber} returned a different identity`);
      }
      issueByNumber.set(direct.number, direct);
    }
  }
  issues = [...issueByNumber.values()];
  const reservedIssueNumbers = new Set(
    reservedRefs
      .map(({ ref }) => parseReservedClaimRef(ref))
      .filter(({ status }) => status === 'supported')
      .map(({ issueNumber }) => issueNumber),
  );
  const commentsByIssue = new Map();
  for (const issue of issues.filter(
    ({ number, state }) => state === 'open' || reservedIssueNumbers.has(number),
  )) {
    const comments = apiPages(
      `repos/${repository}/issues/${issue.number}/comments?per_page=100`,
    ).map((comment) => normalizeComment(comment, issue.number));
    requireUnique(comments, 'id', `GitHub issue #${issue.number} comments`);
    commentsByIssue.set(issue.number, comments);
  }
  const pullRequests = apiPages(`repos/${repository}/pulls?state=open&per_page=100`).map(
    normalizePullRequest,
  );
  requireUnique(pullRequests, 'number', 'GitHub open pull requests');
  return {
    labels,
    issues,
    commentsByIssue,
    reservedRefs,
    pullRequests,
    main: readExactDirectRef(repository, 'refs/heads/main'),
  };
}

function parseWorktrees(output) {
  const entries = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice(9), head: null, branch: null, locked: null, prunable: null };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch refs/heads/")) current.branch = line.slice(18);
    else if (current && line === "detached") current.branch = null;
    else if (current && line.startsWith("locked")) current.locked = line.slice(6).trim() || true;
    else if (current && line.startsWith("prunable")) current.prunable = line.slice(8).trim() || true;
  }
  if (current) entries.push(current);
  return entries;
}

function runGit(args, { allowFailure = false } = {}) {
  return run("git", ["--no-optional-locks", ...args], {
    allowFailure,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
}

function runGitBytes(args) {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: 30_000,
    killSignal: 'SIGTERM',
  });
  if (result.error) return { status: null, stdout: null };
  return { status: result.status, stdout: result.stdout };
}

function readHookConfiguration(cwd) {
  const result = runGit(
    ['-C', cwd, 'config', '--show-origin', '--show-scope', '--get-all', 'core.hooksPath'],
    { allowFailure: true },
  );
  if (result.status === 1 && result.stdout === '') {
    return { status: 'unset', entries: [], effective: null };
  }
  if (result.status !== 0) {
    return { status: 'unavailable', entries: [], effective: null };
  }
  const entries = result.stdout
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [scope, origin, ...value] = line.split('\t');
      if (!scope || !origin || value.length === 0) throw new Error('git config returned malformed hooksPath evidence');
      return { scope, origin, value: value.join('\t') };
    });
  return {
    status: entries.length > 0 ? 'configured' : 'unset',
    entries,
    effective: entries.at(-1) ?? null,
  };
}

function readHookFiles(checkoutPath) {
  return Object.fromEntries(
    ['pre-commit', 'pre-merge-commit'].map((name) => {
      const path = `.githooks/${name}`;
      const index = runGit(['-C', checkoutPath, 'ls-files', '--stage', '--', path], {
        allowFailure: true,
      });
      let indexMode = 'unavailable';
      if (index.status === 0 && index.stdout === '') indexMode = 'missing';
      else if (index.status === 0) {
        const lines = index.stdout.trimEnd().split('\n');
        const match =
          lines.length === 1 ? /^(100644|100755) [0-9a-f]{40} 0\t(.+)$/.exec(lines[0]) : null;
        indexMode = match?.[2] === path ? match[1] : 'malformed';
      }
      try {
        const stat = statSync(join(checkoutPath, path));
        const permissions = stat.mode & 0o777;
        return [
          name,
          {
            path,
            indexMode,
            filesystem: {
              status: 'present',
              permissions: permissions.toString(8).padStart(3, '0'),
              executable: Boolean(permissions & 0o111),
            },
          },
        ];
      } catch (error) {
        return [
          name,
          {
            path,
            indexMode,
            filesystem: {
              status: error?.code === 'ENOENT' ? 'missing' : 'unavailable',
              permissions: null,
              executable: false,
            },
          },
        ];
      }
    }),
  );
}

function readIntegrationCheckout(worktrees) {
  const matches = worktrees.filter(({ branch }) => branch === 'main');
  if (matches.length !== 1 || matches[0].locked || matches[0].prunable) {
    return {
      status: 'unavailable',
      reason: matches.length === 1 ? 'integration worktree is locked or prunable' : `expected one main worktree, found ${matches.length}`,
      path: matches.length === 1 ? matches[0].path : null,
      localHead: matches.length === 1 ? matches[0].head : null,
      remoteHead: null,
      symbolicBranch: matches.length === 1 ? matches[0].branch : null,
      clean: false,
      inProgress: false,
      relationship: 'unavailable',
    };
  }

  const worktree = matches[0];
  const status = runGit(
    ['-C', worktree.path, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'],
    { allowFailure: true },
  );
  const symbolic = runGit(['-C', worktree.path, 'symbolic-ref', '--quiet', 'HEAD'], {
    allowFailure: true,
  });
  const gitDirectory = runGit(['-C', worktree.path, 'rev-parse', '--absolute-git-dir'], {
    allowFailure: true,
  });
  if (status.status !== 0 || symbolic.status !== 0 || gitDirectory.status !== 0) {
    return {
      status: 'unavailable',
      reason: 'integration checkout evidence could not be read',
      path: worktree.path,
      localHead: worktree.head,
      remoteHead: null,
      symbolicBranch: null,
      clean: false,
      inProgress: false,
      relationship: 'unavailable',
    };
  }
  const clean = status.stdout.split('\n').every((line) => line === '' || line.startsWith('#'));
  const operationMarkers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'BISECT_LOG',
  ];
  const gitDir = gitDirectory.stdout.trim();
  const inProgress = operationMarkers.some((marker) => existsSync(join(gitDir, marker)));
  return {
    status: 'unavailable',
    reason: 'direct remote main has not been read',
    path: worktree.path,
    localHead: worktree.head,
    remoteHead: null,
    symbolicRef: symbolic.stdout.trim(),
    symbolicBranch:
      symbolic.stdout.trim() === 'refs/heads/main' ? 'main' : symbolic.stdout.trim(),
    clean,
    inProgress,
    relationship: 'unavailable',
  };
}

function readCommitRelationship(left, right, cwd = process.cwd()) {
  if (left === right) return 'equal';
  const leftAncestor = runGit(['-C', cwd, 'merge-base', '--is-ancestor', left, right], {
    allowFailure: true,
  });
  const rightAncestor = runGit(['-C', cwd, 'merge-base', '--is-ancestor', right, left], {
    allowFailure: true,
  });
  const statuses = [leftAncestor.status, rightAncestor.status];
  const available = statuses.every((status) => status === 0 || status === 1);
  return classifyCommitRelationship({
    left,
    right,
    leftIsAncestor: leftAncestor.status === 0,
    rightIsAncestor: rightAncestor.status === 0,
    available,
  });
}

function directApiResult(endpoint) {
  const result = run('gh', ['api', endpoint], { allowFailure: true });
  if (result.status !== 0) {
    return /(?:HTTP|status) 404|Not Found/i.test(result.stderr)
      ? { status: 'missing' }
      : { status: 'unavailable' };
  }
  try {
    return { status: 'available', value: parseJson(result.stdout, `gh api ${endpoint}`) };
  } catch {
    return { status: 'malformed' };
  }
}

function readExactDirectRef(repository, fullRef) {
  const endpoint = `repos/${repository}/git/ref/${fullRef.slice('refs/'.length)}`;
  const result = directApiResult(endpoint);
  if (result.status !== 'available') return { status: result.status, endpoint };
  const record = result.value;
  if (
    !record ||
    Array.isArray(record) ||
    record.ref !== fullRef ||
    record.object?.type !== 'commit' ||
    !/^[0-9a-f]{40}$/.test(record.object?.sha ?? '')
  ) {
    return { status: 'malformed', endpoint };
  }
  return {
    status: 'found',
    endpoint,
    ref: record.ref,
    objectType: record.object.type,
    sha: record.object.sha,
  };
}

function readAuthoritativeCompare(repository, left, right) {
  const endpoint = `repos/${repository}/compare/${left}...${right}`;
  const result = directApiResult(endpoint);
  if (result.status !== 'available') return { status: result.status, endpoint };
  const record = result.value;
  const relationships = {
    identical: 'equal',
    ahead: 'right-ahead',
    behind: 'left-ahead',
    diverged: 'divergence',
  };
  const relationship = relationships[record?.status];
  const aheadBy = record?.ahead_by;
  const behindBy = record?.behind_by;
  const baseSha = record?.base_commit?.sha;
  const countsValid =
    Number.isSafeInteger(aheadBy) &&
    aheadBy >= 0 &&
    Number.isSafeInteger(behindBy) &&
    behindBy >= 0 &&
    ((record.status === 'identical' && aheadBy === 0 && behindBy === 0) ||
      (record.status === 'ahead' && aheadBy > 0 && behindBy === 0) ||
      (record.status === 'behind' && aheadBy === 0 && behindBy > 0) ||
      (record.status === 'diverged' && aheadBy > 0 && behindBy > 0));
  if (!relationship || !countsValid || baseSha !== left) return { status: 'malformed', endpoint };
  return {
    status: 'available',
    endpoint,
    relationship,
    evidenceKey: `${left}:${right}:${record.status}:${aheadBy}:${behindBy}:${baseSha}`,
    aheadBy,
    behindBy,
  };
}

function readRemoteCommitEvidence(repository, fullRef, left) {
  const directRefBefore = readExactDirectRef(repository, fullRef);
  const remote = directRefBefore.status === 'found' ? directRefBefore.sha : null;
  const comparable = /^[0-9a-f]{40}$/.test(left ?? '') && remote && left !== remote;
  const compareBefore = comparable
    ? readAuthoritativeCompare(repository, left, remote)
    : {
        status: left === remote ? 'available' : 'unavailable',
        relationship: 'equal',
        evidenceKey: `${left}:equal`,
      };
  const compareAfter = comparable
    ? readAuthoritativeCompare(repository, left, remote)
    : { ...compareBefore };
  const directRefAfter = readExactDirectRef(repository, fullRef);
  return { directRefBefore, compareBefore, compareAfter, directRefAfter };
}

function readLocalHostLabels() {
  const result = run('hostname', [], { allowFailure: true });
  if (result.status !== 0) return new Set();
  const hostname = result.stdout.trim();
  return new Set([hostname, hostname.replace(/\.local$/i, '')].filter(Boolean));
}

function readClaimContainment(issue, local, checkpointCommit, remoteHead, localHostLabels) {
  const branch = claimField(issue.body, 'Claim-Branch');
  const fullRef = `refs/heads/${branch}`;
  const claimHost = claimField(issue.body, 'Claim-Host');
  if (!localHostLabels.has(claimHost)) return { status: 'wrong-host', relationship: 'unavailable' };
  const branches = local.branches.filter(({ name }) => name === branch);
  const worktrees = local.worktrees.filter(({ branch: candidate }) => candidate === branch);
  if (branches.length !== 1 || worktrees.length !== 1) {
    return { status: branches.length === 0 || worktrees.length === 0 ? 'missing' : 'ambiguous', relationship: 'unavailable' };
  }
  const [localBranch] = branches;
  const [worktree] = worktrees;
  if (worktree.locked || worktree.prunable) return { status: 'ambiguous', relationship: 'unavailable' };
  const branchToCheckpoint = readCommitRelationship(localBranch.head, checkpointCommit, worktree.path);
  if (localBranch.head !== checkpointCommit) {
    return {
      status:
        branchToCheckpoint === 'right-ahead'
          ? 'behind'
          : branchToCheckpoint === 'divergence'
            ? 'diverged'
            : 'mismatched',
      relationship: 'unavailable',
      localBranchHead: localBranch.head,
    };
  }
  const status = runGit(['-C', worktree.path, 'status', '--porcelain=v2', '--untracked-files=all'], {
    allowFailure: true,
  });
  const symbolic = runGit(['-C', worktree.path, 'symbolic-ref', '--quiet', 'HEAD'], {
    allowFailure: true,
  });
  if (status.status !== 0 || symbolic.status !== 0) return { status: 'unavailable', relationship: 'unavailable' };
  if (status.stdout !== '') return { status: 'dirty', relationship: 'unavailable' };
  if (symbolic.stdout.trim() !== fullRef || worktree.head !== localBranch.head) {
    return { status: 'mismatched', relationship: 'unavailable' };
  }
  const relationship = readCommitRelationship(checkpointCommit, remoteHead, worktree.path);
  return {
    status: relationship === 'left-ahead' ? 'contained' : relationship === 'divergence' ? 'diverged' : relationship === 'right-ahead' ? 'behind' : 'unavailable',
    relationship,
    localBranchHead: localBranch.head,
    worktreePath: worktree.path,
  };
}

function readLocalGit() {
  const status = runGit(["status", "--short", "--branch"]).stdout.trim();
  const worktrees = parseWorktrees(runGit(["worktree", "list", "--porcelain"]).stdout);
  const branches = runGit([
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)",
    "refs/heads/",
  ]).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, head] = line.split("\t");
      if (!name || !head) throw new Error("git for-each-ref returned malformed branch evidence");
      return { name, head };
    });
  const integrationCheckout = readIntegrationCheckout(worktrees);
  const hookCheckout = integrationCheckout.path;
  const configuration = hookCheckout
    ? readHookConfiguration(hookCheckout)
    : { status: 'unavailable', entries: [], effective: null };
  const files = hookCheckout ? readHookFiles(hookCheckout) : {};
  const ready =
    configuration.effective?.scope === 'local' &&
    configuration.effective?.value === '.githooks' &&
    Object.values(files).length === 2 &&
    Object.values(files).every(
      (hook) => hook.indexMode === '100755' && hook.filesystem.status === 'present' && hook.filesystem.executable,
    );
  return {
    status,
    worktrees,
    branches,
    hooks: {
      checkoutPath: hookCheckout ?? null,
      configuration,
      files,
      ready,
    },
    integrationCheckout,
  };
}

function readImmutableTree(repository, commitSha) {
  if (!/^[0-9a-f]{40}$/.test(commitSha ?? '')) {
    return { status: 'unavailable', reason: 'commit identity is malformed' };
  }
  const commitEndpoint = `repos/${repository}/git/commits/${commitSha}`;
  const commit = directApiResult(commitEndpoint);
  if (
    commit.status !== 'available' ||
    commit.value?.sha !== commitSha ||
    !/^[0-9a-f]{40}$/.test(commit.value?.tree?.sha ?? '')
  ) {
    return { status: 'unavailable', reason: `immutable commit ${commitSha} is unavailable or malformed` };
  }
  const treeSha = commit.value.tree.sha;
  const treeEndpoint = `repos/${repository}/git/trees/${treeSha}?recursive=1`;
  const tree = directApiResult(treeEndpoint);
  if (
    tree.status !== 'available' ||
    tree.value?.sha !== treeSha ||
    tree.value?.truncated !== false ||
    !Array.isArray(tree.value?.tree)
  ) {
    return { status: 'unavailable', reason: `recursive tree ${treeSha} is unavailable, malformed, or truncated` };
  }
  return {
    status: 'complete',
    commitSha,
    treeSha,
    truncated: false,
    entries: tree.value.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
  };
}

function readSerializingActivation(repository, mainSha) {
  const mainTree = readImmutableTree(repository, mainSha);
  // A complete main tree without the configuration is the required non-self-activation state.
  // Once this implementation is running, unavailable current-main evidence always fails closed.
  if (mainTree.status !== 'complete') {
    return { status: 'unavailable', reason: mainTree.reason, mainTree };
  }
  const validatedMainTree = changedPathsFromTrees(mainTree, mainTree);
  if (validatedMainTree.status !== 'complete') {
    return { status: 'unavailable', reason: validatedMainTree.reason, mainTree };
  }
  const path = '.github/coordination/serializing-paths.v1.json';
  const candidates = mainTree.entries.filter((entry) => entry.path === path);
  if (candidates.length === 0) return { status: 'inactive', mainTree };
  if (candidates.length !== 1 || candidates[0].type !== 'blob' || !/^[0-9a-f]{40}$/.test(candidates[0].sha ?? '')) {
    return { status: 'unavailable', reason: 'serializing configuration tree entry is ambiguous or malformed' };
  }
  const result = directApiResult(`repos/${repository}/git/blobs/${candidates[0].sha}`);
  if (
    result.status !== 'available' ||
    result.value?.sha !== candidates[0].sha ||
    result.value?.encoding !== 'base64' ||
    typeof result.value?.content !== 'string'
  ) {
    return { status: 'unavailable', reason: 'serializing configuration blob is unavailable or malformed' };
  }
  let source;
  try {
    const encoded = result.value.content.replace(/\n/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded.replace(/=+$/, (padding) => padding)) {
      return { status: 'unavailable', reason: 'serializing configuration blob is not canonical base64' };
    }
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (result.value.size !== undefined && result.value.size !== bytes.length) {
      return { status: 'unavailable', reason: 'serializing configuration blob size disagrees' };
    }
  } catch {
    return { status: 'unavailable', reason: 'serializing configuration blob is not valid base64 UTF-8' };
  }
  const configuration = parseSerializingConfiguration(source);
  return configuration.status === 'valid'
    ? { status: 'active', configuration, mainTree }
    : { status: 'unavailable', reason: configuration.message, configuration, mainTree };
}

function validCompareRecord(record, left) {
  const counts =
    Number.isSafeInteger(record?.ahead_by) &&
    record.ahead_by >= 0 &&
    Number.isSafeInteger(record?.behind_by) &&
    record.behind_by >= 0;
  const statusCounts =
    (record?.status === 'identical' && record.ahead_by === 0 && record.behind_by === 0) ||
    (record?.status === 'ahead' && record.ahead_by > 0 && record.behind_by === 0) ||
    (record?.status === 'behind' && record.ahead_by === 0 && record.behind_by > 0) ||
    (record?.status === 'diverged' && record.ahead_by > 0 && record.behind_by > 0);
  return counts && statusCounts && record?.base_commit?.sha === left;
}

function readMergeBase(repository, left, right) {
  if (left === right && /^[0-9a-f]{40}$/.test(left ?? '')) return { status: 'available', sha: left };
  const endpoint = `repos/${repository}/compare/${left}...${right}`;
  const result = directApiResult(endpoint);
  const sha = result.value?.merge_base_commit?.sha;
  return result.status === 'available' &&
    validCompareRecord(result.value, left) &&
    /^[0-9a-f]{40}$/.test(sha ?? '')
    ? { status: 'available', sha }
    : { status: 'unavailable', reason: `merge-base evidence for ${left}...${right} is unavailable or malformed` };
}

function readAncestorEvidence(repository, ancestor, descendant) {
  if (ancestor === descendant) return { status: 'ancestor' };
  const result = directApiResult(`repos/${repository}/compare/${ancestor}...${descendant}`);
  return result.status === 'available' &&
    validCompareRecord(result.value, ancestor) &&
    result.value.status === 'ahead'
    ? { status: 'ancestor' }
    : { status: 'unavailable' };
}

function pullRequestIdentity(pr) {
  return [
    pr.number,
    pr.state,
    pr.draft,
    pr.headRepository,
    pr.headRef,
    pr.headSha,
    pr.baseRepository,
    pr.baseRef,
    pr.baseSha,
    pr.updatedAt,
  ];
}

function stablePullRequestSet(before, after) {
  const canonical = (values) =>
    values
      .map(pullRequestIdentity)
      .sort((left, right) => left[0] - right[0])
      .map((identity) => JSON.stringify(identity));
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
}

function readRemoteObservedAgainstMain(repository, mainCommit, headCommit, initialBase = null) {
  const mergeBaseBefore = readMergeBase(repository, mainCommit, headCommit);
  if (mergeBaseBefore.status !== 'available') {
    return { status: 'unavailable', paths: [], count: null, reason: mergeBaseBefore.reason };
  }
  const ancestryPoints = [
    ...(initialBase ? [[initialBase, mergeBaseBefore.sha]] : []),
    [mergeBaseBefore.sha, mainCommit],
    [mergeBaseBefore.sha, headCommit],
  ];
  if (
    ancestryPoints.some(
      ([ancestor, descendant]) =>
        readAncestorEvidence(repository, ancestor, descendant).status !== 'ancestor',
    )
  ) {
    return {
      status: 'unavailable',
      paths: [],
      count: null,
      reason: 'initial-base or merge-base ancestry evidence is unavailable',
    };
  }
  const baseTreeBefore = readImmutableTree(repository, mergeBaseBefore.sha);
  const headTree = readImmutableTree(repository, headCommit);
  const observed = changedPathsFromTrees(baseTreeBefore, headTree);
  const mergeBaseAfter = readMergeBase(repository, mainCommit, headCommit);
  const baseTreeAfter = mergeBaseAfter.status === 'available'
    ? readImmutableTree(repository, mergeBaseAfter.sha)
    : { status: 'unavailable' };
  if (
    mergeBaseAfter.status !== 'available' ||
    mergeBaseBefore.sha !== mergeBaseAfter.sha ||
    baseTreeBefore.status !== 'complete' ||
    baseTreeAfter.status !== 'complete' ||
    baseTreeBefore.treeSha !== baseTreeAfter.treeSha
  ) {
    return {
      status: 'unavailable',
      paths: [],
      count: null,
      reason: 'merge-base commit/tree identity changed or became unavailable during tree observation',
    };
  }
  return observed;
}

function readLocalImmutableTree(cwd, commitSha) {
  if (!/^[0-9a-f]{40}$/.test(commitSha ?? '')) {
    return { status: 'unavailable', reason: 'local commit identity is malformed' };
  }
  const object = runGit(['-C', cwd, 'cat-file', '-t', commitSha], { allowFailure: true });
  const tree = runGit(['-C', cwd, 'rev-parse', `${commitSha}^{tree}`], { allowFailure: true });
  const listing = runGitBytes([
    '-C',
    cwd,
    'ls-tree',
    '-r',
    '-t',
    '-z',
    '--full-tree',
    commitSha,
  ]);
  const treeSha = tree.stdout.trim();
  if (
    object.status !== 0 ||
    object.stdout !== 'commit\n' ||
    tree.status !== 0 ||
    !/^[0-9a-f]{40}$/.test(treeSha) ||
    listing.status !== 0 ||
    !Buffer.isBuffer(listing.stdout)
  ) {
    return { status: 'unavailable', reason: 'local immutable commit or recursive tree is unavailable' };
  }
  let listingText;
  try {
    listingText = new TextDecoder('utf-8', { fatal: true }).decode(listing.stdout);
  } catch {
    return { status: 'unavailable', reason: 'local recursive tree contains a non-UTF-8 path' };
  }
  if (listingText !== '' && !listingText.endsWith('\0')) {
    return { status: 'unavailable', reason: 'local recursive tree framing is malformed' };
  }
  const entries = listingText === ''
    ? []
    : listingText.slice(0, -1).split('\0').map((line) => {
        const match = line.match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]+)$/);
        return match
          ? { mode: match[1], type: match[2], sha: match[3], path: match[4] }
          : { path: null, mode: null, type: null, sha: null };
      });
  return { status: 'complete', commitSha, treeSha, truncated: false, entries };
}

export function readLocalObservedAgainstMain(cwd, mainCommit, headCommit, initialBase) {
  const mergeBaseBefore = runGit(
    ['-C', cwd, 'merge-base', mainCommit, headCommit],
    { allowFailure: true },
  );
  const mergeBase = mergeBaseBefore.stdout.trim();
  const ancestryPairs = [
    [initialBase, mergeBase],
    [mergeBase, mainCommit],
    [mergeBase, headCommit],
  ];
  if (
    mergeBaseBefore.status !== 0 ||
    !/^[0-9a-f]{40}$/.test(mergeBase) ||
    ancestryPairs.some(
      ([ancestor, descendant]) =>
        runGit(
          ['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant],
          { allowFailure: true },
        ).status !== 0,
    )
  ) {
    return { status: 'unavailable', paths: [], count: null, reason: 'guarded local merge-base or ancestry evidence is unavailable' };
  }
  const baseTreeBefore = readLocalImmutableTree(cwd, mergeBase);
  const observed = changedPathsFromTrees(
    baseTreeBefore,
    readLocalImmutableTree(cwd, headCommit),
  );
  const mergeBaseAfter = runGit(
    ['-C', cwd, 'merge-base', mainCommit, headCommit],
    { allowFailure: true },
  );
  const baseTreeAfter = readLocalImmutableTree(cwd, mergeBase);
  if (
    mergeBaseAfter.status !== 0 ||
    mergeBaseAfter.stdout.trim() !== mergeBase ||
    baseTreeBefore.status !== 'complete' ||
    baseTreeAfter.status !== 'complete' ||
    baseTreeBefore.treeSha !== baseTreeAfter.treeSha
  ) {
    return { status: 'unavailable', paths: [], count: null, reason: 'guarded local merge-base commit/tree changed during observation' };
  }
  return observed.status === 'complete' ? { ...observed, source: 'same-host-local-immutable-tree' } : observed;
}

function guardedLocalObserved({ local, item, remoteMain, initialBase }) {
  if (item.remoteClaim?.lifecycle?.status !== 'local-ahead') {
    return { status: 'unavailable', paths: [], count: null, reason: 'claim is not a qualified local-ahead lifecycle' };
  }
  const branch = item.claim['Claim-Branch'];
  const checkpoint = item.checkpoint['Checkpoint-Commit'];
  const worktrees = local.worktrees.filter(({ branch: candidate }) => candidate === branch);
  const branches = local.branches.filter(({ name }) => name === branch);
  if (
    worktrees.length !== 1 ||
    branches.length !== 1 ||
    worktrees[0].locked ||
    worktrees[0].prunable ||
    worktrees[0].head !== checkpoint ||
    branches[0].head !== checkpoint
  ) {
    return { status: 'unavailable', paths: [], count: null, reason: 'same-host branch/worktree immutable identity is missing or ambiguous' };
  }
  const cwd = worktrees[0].path;
  const remoteHead = item.remoteClaim.lifecycle.remoteHead;
  if (
    !/^[0-9a-f]{40}$/.test(remoteHead ?? '') ||
    runGit(
      ['-C', cwd, 'merge-base', '--is-ancestor', initialBase, remoteHead],
      { allowFailure: true },
    ).status !== 0 ||
    runGit(
      ['-C', cwd, 'merge-base', '--is-ancestor', remoteHead, checkpoint],
      { allowFailure: true },
    ).status !== 0
  ) {
    return { status: 'unavailable', paths: [], count: null, reason: 'same-host B <= R <= L ancestry is unavailable' };
  }
  const symbolic = runGit(['-C', cwd, 'symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true });
  const branchBefore = runGit(
    ['-C', cwd, 'rev-parse', `refs/heads/${branch}`],
    { allowFailure: true },
  );
  const headBefore = runGit(['-C', cwd, 'rev-parse', 'HEAD'], { allowFailure: true });
  const clean = runGit(
    ['-C', cwd, 'status', '--porcelain=v2', '--untracked-files=all'],
    { allowFailure: true },
  );
  if (
    symbolic.status !== 0 ||
    symbolic.stdout.trim() !== `refs/heads/${branch}` ||
    branchBefore.status !== 0 ||
    headBefore.status !== 0 ||
    branchBefore.stdout.trim() !== checkpoint ||
    headBefore.stdout.trim() !== checkpoint ||
    clean.status !== 0 ||
    clean.stdout !== ''
  ) {
    return { status: 'unavailable', paths: [], count: null, reason: 'same-host worktree is not exact and clean' };
  }
  const observed = readLocalObservedAgainstMain(cwd, remoteMain, checkpoint, initialBase);
  const branchAfter = runGit(
    ['-C', cwd, 'rev-parse', `refs/heads/${branch}`],
    { allowFailure: true },
  );
  const headAfter = runGit(['-C', cwd, 'rev-parse', 'HEAD'], { allowFailure: true });
  if (
    branchAfter.status !== 0 ||
    headAfter.status !== 0 ||
    branchAfter.stdout.trim() !== checkpoint ||
    headAfter.stdout.trim() !== checkpoint
  ) {
    return { status: 'unavailable', paths: [], count: null, reason: 'same-host branch or HEAD changed during observation' };
  }
  return observed;
}

function applyScopeEvidence({
  repository,
  coordination,
  local,
  issues,
  commentsByIssue,
  pullRequests,
  remoteMain,
  provisionalClaim = null,
}) {
  const activation = readSerializingActivation(repository, remoteMain);
  const emptyClaimScope = () => ({
    findingIds: [],
    claimBlockerIds: [],
    publicationBlockerIds: [],
    checkpointBlockerIds: [],
    advisoryIds: [],
    status: 'unavailable',
  });
  const emptyPullRequestScope = () => ({ findingIds: [], integrationBlockerIds: [], status: 'unavailable' });
  for (const item of coordination.workItems) item.scope = emptyClaimScope();
  for (const pr of pullRequests) pr.scope = emptyPullRequestScope();
  if (activation.status !== 'active') {
    return { status: activation.status, findings: [], activation };
  }

  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const claimItems = coordination.workItems.filter(
    (item) =>
      item.registrySchema.version === '2' &&
      item.registrySchema.valid &&
      (['active', 'review'].includes(item.claimState) || item.number === provisionalClaim?.issueNumber),
  );
  const claims = claimItems.map((item) => {
      const issue = issueByNumber.get(item.number);
      const declaration = normalizeScopePaths(claimField(issue?.body ?? '', 'Scope-Paths'));
      const recovered = recoverInitialClaimBase(issue, commentsByIssue.get(item.number) ?? [], {
        validateCheckpointEvidence: validateStandaloneCheckpointEvidence,
      });
      const remoteHead = item.remoteClaim?.matchingRefs?.length === 1 ? item.remoteClaim.matchingRefs[0].sha : null;
      const isProvisional = item.number === provisionalClaim?.issueNumber;
      const effectiveBranch = isProvisional ? provisionalClaim.branch : item.claim['Claim-Branch'];
      const exactRef = `refs/heads/${effectiveBranch}`;
      const directRefBefore = readExactDirectRef(repository, exactRef);
      const preRefPhase = isProvisional && provisionalClaim.phase === 'before-ref';
      const preRefAbsent = preRefPhase && directRefBefore.status === 'missing';
      const effectiveRemoteHead = isProvisional
        ? provisionalClaim.phase === 'before-ref'
          ? provisionalClaim.expectedBase
          : directRefBefore?.status === 'found'
            ? directRefBefore.sha
            : null
        : remoteHead;
      const effectiveBase = isProvisional ? provisionalClaim.expectedBase : recovered.baseCommit;
      let observed = preRefAbsent
        ? provisionalEmptyObservedEvidence()
        : { status: 'unavailable', paths: [], count: null, reason: 'claim identity or establishment base is unavailable' };
      if (
        !preRefPhase &&
        ['declared', 'none'].includes(declaration.status) &&
        (isProvisional || recovered.status === 'recovered') &&
        /^[0-9a-f]{40}$/.test(effectiveRemoteHead ?? '')
      ) {
        observed = !isProvisional && item.remoteClaim?.lifecycle?.status === 'local-ahead'
          ? guardedLocalObserved({ local, item, remoteMain, initialBase: effectiveBase })
          : readRemoteObservedAgainstMain(
              repository,
              remoteMain,
              effectiveRemoteHead,
              effectiveBase,
            );
      }
      const directRefAfter = readExactDirectRef(repository, exactRef);
      const enumeratedRefs = coordination.remoteClaims.refs.filter(({ ref }) => ref === exactRef);
      const enumeratedStable = preRefPhase
        ? enumeratedRefs.length === 0
        : enumeratedRefs.length === 1 && enumeratedRefs[0].sha === effectiveRemoteHead;
      const stableClaimRef = enumeratedStable && (preRefPhase
        ? preRefAbsent && directRefAfter.status === 'missing'
        : directRefBefore.status === 'found' &&
          directRefAfter.status === 'found' &&
          directRefBefore.sha === effectiveRemoteHead &&
          directRefAfter.sha === effectiveRemoteHead);
      if (!stableClaimRef) {
        observed = { status: 'unavailable', paths: [], count: null, reason: 'exact claim ref is missing, malformed, or unstable around scope observation' };
      }
      if (
        isProvisional &&
        (typeof provisionalClaim.expectedIssueBody !== 'string' ||
          issue?.body !== provisionalClaim.expectedIssueBody)
      ) {
        observed = {
          status: 'unavailable',
          paths: [],
          count: null,
          reason: 'candidate issue body changed from the exact invoking claim snapshot',
        };
      }
      return {
        number: item.number,
        branch: effectiveBranch,
        remoteHead: effectiveRemoteHead,
        declaredEntries: declaration.entries ?? [],
        observed,
        checkpointChangedPathCount: isProvisional
          ? 0
          : /^\d+$/.test(item.checkpoint['Checkpoint-Changed-Path-Count'] ?? '')
            ? Number(item.checkpoint['Checkpoint-Changed-Path-Count'])
            : Number.NaN,
        provisional: preRefAbsent,
      };
    });

  const participatingPullRequests = pullRequests.filter(
    (pr) => pr.baseRepository === repository && pr.baseRef === 'main',
  );
  for (const pr of pullRequests) {
    if (!participatingPullRequests.includes(pr)) pr.scope.status = 'clear';
  }
  const observedPullRequests = participatingPullRequests.map((pr) => {
    let observed = { status: 'unavailable', paths: [], count: null, reason: 'pull-request identity is incomplete' };
    if (
      pr.state === 'open' &&
      typeof pr.draft === 'boolean' &&
      /^[0-9a-f]{40}$/.test(pr.headSha ?? '') &&
      /^[0-9a-f]{40}$/.test(pr.baseSha ?? '')
    ) {
      observed = readRemoteObservedAgainstMain(repository, remoteMain, pr.headSha);
    }
    return { ...pr, observed };
  });

  const after = apiPages(`repos/${repository}/pulls?state=open&per_page=100`).map(normalizePullRequest);
  const stable = stablePullRequestSet(pullRequests, after);
  const mainAfter = readExactDirectRef(repository, 'refs/heads/main');
  const stableMain = mainAfter.status === 'found' && mainAfter.sha === remoteMain;
  const unexpectedClaimTarget = claims.some((claim) =>
    pullRequests.some(
      (pr) =>
        pr.headRepository === repository &&
        pr.headRef === claim.branch &&
        (pr.baseRepository !== repository || pr.baseRef !== 'main'),
    ),
  );
  const routed = buildScopeRouting({
    repository,
    claims,
    pullRequests: observedPullRequests,
    serializingEntries: activation.configuration.entries,
  });
  for (const item of coordination.workItems) {
    if (routed.claimScopes.has(item.number)) item.scope = routed.claimScopes.get(item.number);
  }
  for (const pr of pullRequests) {
    if (routed.pullRequestScopes.has(pr.number)) pr.scope = routed.pullRequestScopes.get(pr.number);
  }
  const evidenceComplete =
    stable &&
    stableMain &&
    !unexpectedClaimTarget &&
    claims.every(
      ({ observed, provisional }) =>
        observed.status === 'complete' ||
        (provisional && observed.status === 'provisional-empty-before-ref'),
    ) &&
    observedPullRequests.every(({ observed }) => observed.status === 'complete') &&
    [...routed.claimScopes.values(), ...routed.pullRequestScopes.values()].every(
      ({ status }) => status !== 'unavailable',
    );
  return {
    status: evidenceComplete ? 'complete' : 'unavailable',
    findings: evidenceComplete ? routed.findings : [],
    activation,
    stablePullRequests: stable,
    stableMain,
  };
}

export function isExactSameOperationPostRefTransition({
  provisionalClaim,
  issue,
  reservedRefs,
  entry,
}) {
  const ref = `refs/heads/${provisionalClaim?.branch ?? ''}`;
  const state = claimField(issue?.body ?? '', 'Claim-State');
  return (
    provisionalClaim?.phase === 'after-ref' &&
    provisionalClaim.refCreatedByOperation === true &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provisionalClaim.operationId ?? '') &&
    issue?.number === provisionalClaim.issueNumber &&
    issue.body === provisionalClaim.expectedIssueBody &&
    reservedRefs.filter((remote) => remote.ref === ref).length === 1 &&
    reservedRefs.find((remote) => remote.ref === ref)?.sha === provisionalClaim.expectedBase &&
    entry?.code === 'orphaned-claim-ref' &&
    entry.message ===
      `${ref} exists while issue #${provisionalClaim.issueNumber} is ${state}; do not adopt or release it automatically`
  );
}

function readRegistry(local, nowMs, { provisionalClaim = null } = {}) {
  let ghVersion;
  try {
    ghVersion = run("gh", ["--version"], { allowFailure: true });
  } catch {
    throw new Error("GitHub CLI is unavailable; the shared registry cannot be verified");
  }
  if (ghVersion.status !== 0) throw new Error("GitHub CLI is unavailable; the shared registry cannot be verified");
  const auth = run("gh", ["auth", "status"], { allowFailure: true });
  if (auth.status !== 0) throw new Error("GitHub CLI is not authenticated; the shared registry cannot be verified");

  const repository = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).stdout.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("GitHub repository identity is malformed");

  const integration = local.integrationCheckout;
  const mainRemoteEvidence = readRemoteCommitEvidence(
    repository,
    'refs/heads/main',
    integration.localHead,
  );
  const stableMainRef =
    mainRemoteEvidence.directRefBefore.status === 'found' &&
    mainRemoteEvidence.directRefAfter.status === 'found' &&
    mainRemoteEvidence.directRefBefore.sha === mainRemoteEvidence.directRefAfter.sha;
  const remoteMain = stableMainRef ? mainRemoteEvidence.directRefAfter.sha : null;
  const integrationRelationship = stableMainRef
    ? authoritativeCommitRelationship({
        left: integration.localHead,
        right: remoteMain,
        compareBefore: mainRemoteEvidence.compareBefore,
        compareAfter: mainRemoteEvidence.compareAfter,
      })
    : 'unavailable';
  integration.remoteHead = remoteMain;
  integration.relationship = integrationRelationship;
  integration.remoteEvidence = mainRemoteEvidence;
  integration.status = classifyIntegrationCheckout({
    symbolicBranch: integration.symbolicBranch,
    clean: integration.clean,
    inProgress: integration.inProgress,
    localHead: integration.localHead,
    remoteHead: remoteMain,
    relationship: integrationRelationship,
    available: Boolean(integration.path && stableMainRef),
  });
  integration.reason =
    integration.status === 'unavailable'
      ? 'direct-ref or authoritative compare evidence is missing, malformed, unavailable, or unstable'
      : null;

  const labelRecords = apiPages(`repos/${repository}/labels?per_page=100`);
  const labelNames = labelRecords.map((label, index) =>
    requiredString(label?.name, `GitHub label ${index + 1} name`),
  );
  requireUnique(labelNames.map((name) => ({ name })), 'name', 'GitHub labels');
  const availableLabels = new Set(labelNames);
  const missingLabels = REQUIRED_LABELS.filter((label) => !availableLabels.has(label));

  let issueRecords = apiPages(`repos/${repository}/issues?state=all&per_page=100`)
    .filter((issue) => !issue?.pull_request)
    .map(normalizeIssue);
  requireUnique(issueRecords, 'number', 'GitHub issues');
  const reservedRefs = apiPages(
    `repos/${repository}/git/matching-refs/heads/claim-v?per_page=100`,
  ).map(normalizeRemoteRef);
  requireUnique(reservedRefs, 'ref', 'GitHub reserved claim refs');
  const issueByNumber = new Map(issueRecords.map((issue) => [issue.number, issue]));
  for (const remote of reservedRefs) {
    const mapping = parseReservedClaimRef(remote.ref);
    if (mapping.status !== 'supported') continue;
    const listed = issueByNumber.get(mapping.issueNumber);
    if (!listed || listed.state === 'closed') {
      const direct = normalizeIssue(apiRecord(`repos/${repository}/issues/${mapping.issueNumber}`));
      issueByNumber.set(direct.number, direct);
    }
  }
  issueRecords = [...issueByNumber.values()];
  const reservedIssueNumbers = new Set(
    reservedRefs
      .map(({ ref }) => parseReservedClaimRef(ref))
      .filter(({ status }) => status === 'supported')
      .map(({ issueNumber }) => issueNumber),
  );
  const claimLifecycles = new Map();
  const localHostLabels = readLocalHostLabels();
  for (const issue of issueRecords) {
    const state = claimField(issue.body, 'Claim-State');
    if (!['active', 'review'].includes(state)) continue;
    const expectedRef = `refs/heads/${claimField(issue.body, 'Claim-Branch')}`;
    const parsed = parseReservedClaimRef(expectedRef);
    if (parsed.status !== 'supported' || parsed.issueNumber !== issue.number) continue;
    const matches = reservedRefs.filter(({ ref }) => ref === expectedRef);
    const enumeratedRemoteHead =
      matches.length === 0 ? null : matches.length === 1 ? matches[0].sha : undefined;
    const checkpointCommit = claimField(issue.body, 'Checkpoint-Commit');
    const remoteEvidence = readRemoteCommitEvidence(repository, expectedRef, checkpointCommit);
    const candidateRemoteHead =
      remoteEvidence.directRefBefore.status === 'found'
        ? remoteEvidence.directRefBefore.sha
        : null;
    const localContainment = candidateRemoteHead
      ? readClaimContainment(
          issue,
          local,
          checkpointCommit,
          candidateRemoteHead,
          localHostLabels,
        )
      : { status: 'unavailable', relationship: 'unavailable' };
    claimLifecycles.set(
      issue.number,
      classifyRemoteClaimEvidence({
        checkpointCommit,
        expectedRef,
        enumeratedRemoteHead,
        ...remoteEvidence,
        localContainment,
      }),
    );
  }

  const commentsByIssue = new Map();
  for (const issue of issueRecords.filter(
    ({ number, state }) => state === 'open' || reservedIssueNumbers.has(number),
  )) {
    const comments = apiPages(`repos/${repository}/issues/${issue.number}/comments?per_page=100`).map(
      (comment) => normalizeComment(comment, issue.number),
    );
    requireUnique(comments, 'id', `GitHub issue #${issue.number} comments`);
    commentsByIssue.set(issue.number, comments);
  }

  const pullRequests = apiPages(`repos/${repository}/pulls?state=open&per_page=100`).map(
    normalizePullRequest,
  );
  requireUnique(pullRequests, 'number', 'GitHub open pull requests');
  const coordination = analyzeCoordination({
    issues: issueRecords,
    commentsByIssue,
    local,
    reservedRefs,
    claimLifecycles,
    nowMs,
  });
  const scopeMainBefore = readExactDirectRef(repository, 'refs/heads/main');
  const scope = applyScopeEvidence({
    repository,
    coordination,
    local,
    issues: issueRecords,
    commentsByIssue,
    pullRequests,
    remoteMain,
    provisionalClaim,
  });
  if (scope.activation.status === 'active') {
    const beforeIdentity = registrySurfaceIdentity({
      labels: labelNames,
      issues: issueRecords,
      commentsByIssue,
      reservedRefs,
      pullRequests,
      main: scopeMainBefore,
    });
    const afterSurfaces = rereadRegistrySurfaces(repository);
    const stable =
      scopeMainBefore.status === 'found' &&
      scopeMainBefore.sha === remoteMain &&
      afterSurfaces.main.status === 'found' &&
      afterSurfaces.main.sha === remoteMain &&
      beforeIdentity === registrySurfaceIdentity(afterSurfaces);
    scope.surroundingRegistryStable = stable;
    if (!stable) {
      scope.status = 'unavailable';
      scope.findings = [];
      for (const item of coordination.workItems) item.scope = {
        findingIds: [],
        claimBlockerIds: [],
        publicationBlockerIds: [],
        checkpointBlockerIds: [],
        advisoryIds: [],
        status: 'unavailable',
      };
      for (const pr of pullRequests) pr.scope = {
        findingIds: [],
        integrationBlockerIds: [],
        status: 'unavailable',
      };
    }
  }
  const transitionalIssue = provisionalClaim
    ? issueRecords.find(({ number }) => number === provisionalClaim.issueNumber)
    : null;
  const expectedPostRefOrphan = (entry) =>
    scope.status === 'complete' &&
    isExactSameOperationPostRefTransition({
      provisionalClaim,
      issue: transitionalIssue,
      reservedRefs,
      entry,
    });
  const maintainerQuestions = [
    ...[...coordination.plans, ...coordination.workItems].flatMap((item) =>
      item.questions.map((entry) => ({ issueNumber: item.number, ...entry })),
    ),
    ...coordination.remoteClaims.questions.filter((entry) => !expectedPostRefOrphan(entry)),
  ];

  return {
    repository,
    labels: { required: REQUIRED_LABELS, missing: missingLabels },
    plans: coordination.plans,
    workItems: coordination.workItems,
    remoteClaims: coordination.remoteClaims,
    pullRequests,
    scopeFindings: scope.findings,
    scopeStatus: scope.status,
    serializingConfiguration: {
      status: scope.activation.status,
      version: scope.activation.configuration?.version ?? null,
      paths: scope.activation.configuration?.paths ?? [],
    },
    maintainerQuestions,
  };
}

export function buildReport(scopeSelector = 'board', { provisionalClaim = null } = {}) {
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    advisory: ADVISORY,
    coordinationKnown: false,
    local: null,
    registry: null,
    warnings: [],
    errors: [],
    scopeGate: { requested: scopeSelector, status: 'unknown', blockingFindingIds: [] },
  };

  try {
    report.local = readLocalGit();
    report.registry = readRegistry(report.local, isoInstantMilliseconds(generatedAt), { provisionalClaim });
    report.coordinationKnown = true;
    if (['local-ahead', 'dirty-or-in-progress', 'divergence', 'unavailable'].includes(report.local.integrationCheckout.status)) {
      report.warnings.push({
        code: 'integration-checkout-not-safe',
        message: `integration checkout status is ${report.local.integrationCheckout.status}; preserve evidence and do not repair automatically`,
      });
    }
    const hookConfiguration = report.local.hooks.configuration;
    const effectiveHooks = hookConfiguration.effective;
    if (hookConfiguration.status === 'unavailable') {
      report.warnings.push({
        code: 'integration-hooks-configuration-unavailable',
        message: 'effective core.hooksPath could not be read; do not configure or repair automatically',
      });
    } else if (effectiveHooks && (effectiveHooks.value !== '.githooks' || effectiveHooks.scope !== 'local')) {
      report.warnings.push({
        code: 'integration-hooks-path-mismatch',
        message: `effective core.hooksPath is ${effectiveHooks.value} at ${effectiveHooks.scope} scope, not repository-local .githooks; do not configure or repair automatically`,
      });
    } else if (effectiveHooks && !report.local.hooks.ready) {
      report.warnings.push({
        code: 'integration-hooks-not-ready',
        message: `repository-local hooks are configured but committed/index or filesystem executable evidence is not ready in ${report.local.hooks.checkoutPath}; do not repair automatically`,
      });
    }
    if (report.registry.scopeStatus === 'unavailable') {
      report.warnings.push({
        code: 'scope-evidence-unavailable',
        message: 'three-layer scope evidence is incomplete, malformed, or unstable; selected operations fail closed',
      });
    }
    if (report.registry.labels.missing.length > 0) {
      report.warnings.push({
        code: "missing-coordination-labels",
        message: `missing coordination labels: ${report.registry.labels.missing.join(", ")}`,
      });
    }
    report.warnings.push(...report.registry.maintainerQuestions);
  } catch (error) {
    report.errors.push({ code: "coordination-unknown", message: error.message });
  }
  if (report.coordinationKnown) {
    const selector = parseScopeGate(scopeSelector);
    const claimTarget = ['claim', 'publication', 'checkpoint'].includes(selector.kind)
      ? report.registry.workItems.find(({ number }) => number === selector.target)
      : null;
    const pullRequestTarget = selector.kind === 'integration-pr'
      ? report.registry.pullRequests.find(({ number }) => number === selector.target)
      : null;
    const targetExists =
      selector.kind === 'board' || Boolean(claimTarget) || Boolean(pullRequestTarget);
    const targetScope = claimTarget?.scope ?? pullRequestTarget?.scope;
    const known =
      selector.status === 'valid' &&
      (report.registry.scopeStatus === 'complete' ||
        (report.registry.scopeStatus === 'inactive' && selector.kind === 'board')) &&
      report.warnings.length === 0 &&
      (!targetScope || targetScope.status !== 'unavailable');
    report.scopeGate = evaluateScopeGate(scopeSelector, report.registry.scopeFindings, {
      known,
      targetExists,
    });
    if (known && targetScope) {
      const blockerField = {
        claim: 'claimBlockerIds',
        publication: 'publicationBlockerIds',
        checkpoint: 'checkpointBlockerIds',
        'integration-pr': 'integrationBlockerIds',
      }[selector.kind];
      const ids = [...new Set(targetScope[blockerField] ?? [])].sort(compareUtf8);
      report.scopeGate = {
        requested: scopeSelector,
        status: ids.length > 0 ? 'blocked' : 'clear',
        blockingFindingIds: ids,
      };
    }
  }
  return report;
}

function section(title) {
  process.stdout.write(`\n## ${title}\n`);
}

function renderHuman(report) {
  if (report.local) {
    section("Local Git state");
    console.log(report.local.status || "clean");
    section("Local worktrees");
    if (report.local.worktrees.length === 0) console.log("none observed");
    for (const worktree of report.local.worktrees) {
      const detail = worktree.branch ? `[${worktree.branch}]` : "[detached]";
      console.log(`${worktree.path} ${worktree.head ?? "unknown"} ${detail}`);
    }
    section('Integration checkout');
    const integration = report.local.integrationCheckout;
    console.log(
      `status=${integration.status} branch=${integration.symbolicBranch ?? 'unknown'} local=${integration.localHead ?? 'unavailable'} direct-remote=${integration.remoteHead ?? 'unavailable'} clean=${integration.clean} in-progress=${integration.inProgress}`,
    );
    section('Integration hooks');
    const configuration = report.local.hooks.configuration;
    const effective = configuration.effective;
    console.log(
      `checkout=${report.local.hooks.checkoutPath ?? 'unavailable'} hooksPath=${effective?.value ?? 'unset'} scope=${effective?.scope ?? 'unset'} origin=${effective?.origin ?? 'unset'} status=${configuration.status} ready=${report.local.hooks.ready}`,
    );
    for (const hook of Object.values(report.local.hooks.files)) {
      console.log(
        `${hook.path} index-mode=${hook.indexMode} filesystem=${hook.filesystem.status} permissions=${hook.filesystem.permissions ?? 'unavailable'} executable=${hook.filesystem.executable}`,
      );
    }
  }

  if (!report.coordinationKnown) {
    console.error(`\nCOORDINATION UNKNOWN: ${report.errors.map(({ message }) => message).join("; ")}`);
    console.error("Do not assume work is unclaimed. Inspect Git/worktrees and ask the maintainer before overlapping work.");
    return;
  }

  const { registry } = report;
  section("Shared registry");
  console.log(registry.repository);
  if (registry.labels.missing.length > 0) {
    console.log(`WARNING missing coordination labels: ${registry.labels.missing.join(", ")}`);
  }

  section("Shared plans");
  if (registry.plans.length === 0) console.log("none");
  for (const plan of registry.plans) {
    console.log(`#${plan.number} [${plan.planState}] ${plan.title} (${plan.url})`);
    console.log(
      `  schema=v${plan.registrySchema.version}${plan.registrySchema.explicit ? '' : ' (implicit)'} updated=${plan.updatedAt} integration-owner=${plan.integrationOwner} integration-hold=${plan.integrationHold.status}`,
    );
    if (plan.integrationHold.status === 'held') {
      console.log(`  hold=${plan.integrationHold.active.holdId}`);
    }
  }

  section("Open work evidence");
  if (registry.workItems.length === 0) console.log("none");
  for (const item of registry.workItems) {
    console.log(`#${item.number} [${item.claimState}; ${item.triage}] ${item.title} (${item.url})`);
    console.log(
      `  schema=v${item.registrySchema.version}${item.registrySchema.explicit ? '' : ' (implicit)'} parent=${item.parentPlan} dependencies=${item.dependencies.status} reconciliation=${item.reconciliation}`,
    );
    const locality =
      item.registrySchema.version === '2'
        ? `host=${item.claim['Claim-Host']} waiting-since=${item.waiting.value}`
        : `worktree=${item.claim['Claim-Worktree']}`;
    const lifecycle = item.remoteClaim?.lifecycle?.status ?? 'not-applicable';
    console.log(
      `  branch=${item.claim['Claim-Branch']} ${locality} check-in=${item.deadline.value} (${item.deadline.status}) local=${item.localEvidence.status} remote-lifecycle=${lifecycle} scope=${item.scope.status}`,
    );
  }

  const malformed = [
    ...registry.plans.filter(({ registrySchema }) => !registrySchema.valid),
    ...registry.workItems.filter(({ registrySchema }) => !registrySchema.valid),
  ];
  if (malformed.length > 0) {
    section('Unparseable or unsupported registry records');
    for (const item of malformed) {
      console.log(
        `#${item.number} schema=v${item.registrySchema.version} status=${item.registrySchema.status}`,
      );
      for (const error of item.registrySchema.errors) {
        console.log(`  [${error.code}] ${error.field}: ${error.message}`);
      }
    }
  }

  section('Reserved claim references');
  if (registry.remoteClaims.refs.length === 0) console.log('none');
  for (const remote of registry.remoteClaims.refs) {
    console.log(
      `${remote.ref} ${remote.sha} mapping=${remote.mapping.status}${remote.mapping.issueNumber ? ` issue=#${remote.mapping.issueNumber}` : ''} disposition=${remote.disposition ?? 'unresolved'}`,
    );
  }

  section('Routed scope findings');
  if (registry.scopeFindings.length === 0) console.log('none');
  for (const finding of registry.scopeFindings) {
    if (finding.kind === 'claim-pr') {
      const issue = finding.claimNumbers[0];
      const pr = finding.pullRequestNumbers[0];
      console.log(
        `[BLOCK claim-pr] claim #${issue} <-> PR #${pr} paths=${finding.paths.join(', ')} routes=claim:#${issue},publication:#${issue},checkpoint:#${issue},integration-pr:#${pr}`,
      );
    } else {
      const [lower, higher] = finding.pullRequestNumbers;
      console.log(
        `[BLOCK pr-pr] PR #${lower} <-> PR #${higher} paths=${finding.paths.join(', ')} routes=integration-pr:#${lower},integration-pr:#${higher} global-publication=false`,
      );
    }
  }

  section('Scope gate');
  const gateExit = report.scopeGate.requested === 'board'
    ? report.warnings.length === 0 ? 0 : 2
    : report.scopeGate.status === 'clear' ? 0 : 2;
  console.log(
    `requested=${report.scopeGate.requested} status=${report.scopeGate.status} blockers=${report.scopeGate.blockingFindingIds.join(', ') || 'none'} exit=${gateExit}`,
  );

  section('Ready candidates (evidence only)');
  const candidates = registry.workItems.filter(({ triage }) => triage === "candidate");
  if (candidates.length === 0) console.log("none");
  for (const item of candidates) {
    console.log(`#${item.number} dependencies clear; claiming safety not established (${item.url})`);
  }
  console.log(`NOTE: ${ADVISORY}`);

  section("Open pull requests");
  if (registry.pullRequests.length === 0) console.log("none");
  for (const pr of registry.pullRequests) {
    console.log(
      `#${pr.number} ${pr.headRefName} -> ${pr.baseRefName}: ${pr.title} (${pr.url}) updated=${pr.updatedAt} scope=${pr.scope.status}`,
    );
  }

  section("Maintainer questions and warnings");
  if (report.warnings.length === 0) console.log("none");
  for (const warning of report.warnings) {
    const subject = warning.issueNumber ? `#${warning.issueNumber} ` : "";
    console.log(`ASK MAINTAINER: ${subject}[${warning.code}] ${warning.message}`);
  }

  if (registry.workItems.length === 0 && registry.pullRequests.length === 0) {
    console.log("Registry currently has no open coordinated work. Confirm this is expected before editing shared scope.");
  }
}

function parseArguments(arguments_) {
  let json = false;
  let gate = 'board';
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json' && !json) json = true;
    else if (argument === '--gate' && gate === 'board' && index + 1 < arguments_.length) gate = arguments_[++index];
    else return { status: 'invalid' };
  }
  if (parseScopeGate(gate).status !== 'valid') return { status: 'invalid' };
  return { status: 'valid', json, gate };
}

function main(arguments_) {
  if (arguments_.includes('--help')) {
    console.log('Usage: node tools/coordination-status.mjs [--json] [--gate <claim:N|publication:N|checkpoint:N|integration-pr:N>]');
    console.log(ADVISORY);
    return 0;
  }
  const parsed = parseArguments(arguments_);
  if (parsed.status !== 'valid') {
    console.error('Usage: node tools/coordination-status.mjs [--json] [--gate <claim:N|publication:N|checkpoint:N|integration-pr:N>]');
    return 2;
  }
  const report = buildReport(parsed.gate);
  if (parsed.json) console.log(JSON.stringify(report, null, 2));
  else renderHuman(report);
  if (parsed.gate !== 'board') return report.scopeGate.status === 'clear' ? 0 : 2;
  return report.coordinationKnown && report.warnings.length === 0 ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
