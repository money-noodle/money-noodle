#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseReservedClaimRef } from './coordination-schema.mjs';
import {
  SCHEMA_VERSION,
  analyzeCoordination,
  claimField,
  classifyCommitRelationship,
  classifyIntegrationCheckout,
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
    headRefName: requiredString(pr.head?.ref, `${context} head ref`),
    baseRefName: requiredString(pr.base?.ref, `${context} base ref`),
    updatedAt: requiredTimestamp(pr.updated_at, `${context} updated_at`),
    url: requiredString(pr.html_url, `${context} html_url`),
    draft: Boolean(pr.draft),
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

function readHookFiles() {
  return Object.fromEntries(
    ['pre-commit', 'pre-merge-commit'].map((name) => {
      const path = `.githooks/${name}`;
      try {
        const stat = statSync(join(process.cwd(), path));
        const permissions = stat.mode & 0o777;
        return [name, { path, mode: `100${permissions.toString(8).padStart(3, '0')}`, executable: Boolean(permissions & 0o111) }];
      } catch {
        return [name, { path, mode: 'missing', executable: false }];
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
  const symbolic = runGit(['-C', worktree.path, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
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
    symbolicBranch: symbolic.stdout.trim(),
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

function directRemoteRef(repository, ref) {
  const result = runGit(
    ['ls-remote', '--refs', `https://github.com/${repository}.git`, ref],
    { allowFailure: true },
  );
  if (result.status !== 0) return null;
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return null;
  const [sha, returnedRef] = lines[0].split('\t');
  return returnedRef === ref && /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : null;
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
  const hookCwd = integrationCheckout.path ?? process.cwd();
  return {
    status,
    worktrees,
    branches,
    hooks: {
      configuration: readHookConfiguration(hookCwd),
      files: readHookFiles(),
    },
    integrationCheckout,
  };
}

function readRegistry(local, nowMs) {
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

  const remoteMain = directRemoteRef(repository, 'refs/heads/main');
  const integration = local.integrationCheckout;
  const integrationRelationship =
    integration.path && integration.localHead && remoteMain
      ? readCommitRelationship(integration.localHead, remoteMain, integration.path)
      : 'unavailable';
  integration.remoteHead = remoteMain;
  integration.relationship = integrationRelationship;
  integration.status = classifyIntegrationCheckout({
    symbolicBranch: integration.symbolicBranch,
    clean: integration.clean,
    inProgress: integration.inProgress,
    localHead: integration.localHead,
    remoteHead: remoteMain,
    relationship: integrationRelationship,
    available: Boolean(integration.path && remoteMain),
  });
  integration.reason = integration.status === 'unavailable' ? integration.reason : null;

  const labelRecords = apiPages(`repos/${repository}/labels?per_page=100`);
  const availableLabels = new Set(
    labelRecords.map((label, index) => requiredString(label?.name, `GitHub label ${index + 1} name`)),
  );
  const missingLabels = REQUIRED_LABELS.filter((label) => !availableLabels.has(label));

  let issueRecords = apiPages(`repos/${repository}/issues?state=all&per_page=100`)
    .filter((issue) => !issue?.pull_request)
    .map(normalizeIssue);
  const reservedRefs = apiPages(
    `repos/${repository}/git/matching-refs/heads/claim-v?per_page=100`,
  ).map(normalizeRemoteRef);
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
  const claimRelationships = new Map();
  for (const issue of issueRecords) {
    const state = claimField(issue.body, 'Claim-State');
    if (!['active', 'review'].includes(state)) continue;
    const matches = reservedRefs.filter(
      ({ ref }) => parseReservedClaimRef(ref).issueNumber === issue.number,
    );
    const checkpointCommit = claimField(issue.body, 'Checkpoint-Commit');
    if (matches.length === 1) {
      claimRelationships.set(
        issue.number,
        readCommitRelationship(checkpointCommit, matches[0].sha),
      );
    }
  }

  const commentsByIssue = new Map();
  for (const issue of issueRecords.filter(
    ({ number, state }) => state === 'open' || reservedIssueNumbers.has(number),
  )) {
    const comments = apiPages(`repos/${repository}/issues/${issue.number}/comments?per_page=100`).map(
      (comment) => normalizeComment(comment, issue.number),
    );
    commentsByIssue.set(issue.number, comments);
  }

  const pullRequests = apiPages(`repos/${repository}/pulls?state=open&per_page=100`).map(
    normalizePullRequest,
  );
  const coordination = analyzeCoordination({
    issues: issueRecords,
    commentsByIssue,
    local,
    reservedRefs,
    claimRelationships,
    nowMs,
  });
  const maintainerQuestions = [
    ...[...coordination.plans, ...coordination.workItems].flatMap((item) =>
      item.questions.map((entry) => ({ issueNumber: item.number, ...entry })),
    ),
    ...coordination.remoteClaims.questions,
  ];

  return {
    repository,
    labels: { required: REQUIRED_LABELS, missing: missingLabels },
    plans: coordination.plans,
    workItems: coordination.workItems,
    remoteClaims: coordination.remoteClaims,
    pullRequests,
    maintainerQuestions,
  };
}

function buildReport() {
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
  };

  try {
    report.local = readLocalGit();
    report.registry = readRegistry(report.local, isoInstantMilliseconds(generatedAt));
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
    }
    for (const hook of Object.values(report.local.hooks.files)) {
      if (hook.mode !== '100755' || !hook.executable) {
        report.warnings.push({
          code: 'integration-hook-file-mode',
          message: `${hook.path} has mode ${hook.mode}, not 100755; do not repair automatically`,
        });
      }
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
      `hooksPath=${effective?.value ?? 'unset'} scope=${effective?.scope ?? 'unset'} origin=${effective?.origin ?? 'unset'} status=${configuration.status}`,
    );
    for (const hook of Object.values(report.local.hooks.files)) {
      console.log(`${hook.path} mode=${hook.mode} executable=${hook.executable}`);
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
      `  branch=${item.claim['Claim-Branch']} ${locality} check-in=${item.deadline.value} (${item.deadline.status}) local=${item.localEvidence.status} remote-lifecycle=${lifecycle}`,
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
      `${remote.ref} ${remote.sha} mapping=${remote.mapping.status}${remote.mapping.issueNumber ? ` issue=#${remote.mapping.issueNumber}` : ''}`,
    );
  }

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
      `#${pr.number} ${pr.headRefName} -> ${pr.baseRefName}: ${pr.title} (${pr.url}) updated=${pr.updatedAt}`,
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

const arguments_ = process.argv.slice(2);
if (arguments_.includes("--help")) {
  console.log("Usage: node tools/coordination-status.mjs [--json]");
  console.log(ADVISORY);
  process.exit(0);
}
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--json")) {
  console.error("Usage: node tools/coordination-status.mjs [--json]");
  process.exit(2);
}

const report = buildReport();
if (arguments_[0] === "--json") console.log(JSON.stringify(report, null, 2));
else renderHuman(report);
process.exitCode = report.coordinationKnown && report.warnings.length === 0 ? 0 : 2;
