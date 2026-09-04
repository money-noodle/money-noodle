import assert from 'node:assert/strict';
import test from 'node:test';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_TOOL = fileURLToPath(new URL('./coordination-status.mjs', import.meta.url));
const FAR_FUTURE = '2999-01-01T00:00:00Z';
const LONG_PAST = '2000-01-01T00:00:00Z';
const REPOSITORY = 'example/registry';
const ISSUES_ENDPOINT = `repos/${REPOSITORY}/issues?state=all&per_page=100`;
const LABELS_ENDPOINT = `repos/${REPOSITORY}/labels?per_page=100`;
const PULLS_ENDPOINT = `repos/${REPOSITORY}/pulls?state=open&per_page=100`;
const CLAIM_REFS_ENDPOINT = `repos/${REPOSITORY}/git/matching-refs/heads/claim-v?per_page=100`;
const MAIN_REF_ENDPOINT = `repos/${REPOSITORY}/git/ref/heads/main`;
const SHIM_PATH = 'PATH=/usr/bin:/bin';

const COORDINATION_LABELS = [
  'work:plan',
  'work:proposed',
  'work:ready',
  'work:active',
  'work:blocked',
  'work:review',
  'work:done',
  'work:abandoned',
].map((name) => ({ name }));

function restIssue({ number, title, body, labels, state = 'open' }) {
  return {
    number,
    title,
    body,
    labels: labels.map((name) => ({ name })),
    state,
    updated_at: '2026-08-29T19:08:12Z',
    html_url: `https://example.invalid/${number}`,
  };
}

const PLAN_ISSUE = restIssue({
  number: 2,
  title: 'Plan: sample shared plan',
  body: 'Plan-State: active\nIntegration-Owner: maintainer\n',
  labels: ['work:plan', 'work:active'],
});

function claimIssue({
  number,
  state,
  checkIn = FAR_FUTURE,
  label = `work:${state}`,
  dependencies = 'none',
}) {
  return restIssue({
    number,
    title: `Work: sample claim ${number}`,
    body: [
      'Parent-Plan: #2',
      `Depends-On: ${dependencies}`,
      'Integration-Owner: maintainer',
      'Reconciled-Claim-Comment-IDs: none',
      `Claim-State: ${state}`,
      'Claim-Harness: pi',
      'Claim-Run-ID: run-123',
      'Claim-Agent: pi-sample',
      'Claim-Branch: test/sample',
      'Claim-Worktree: /fake/worktree',
      'Claimed-At: 2026-08-29T18:00:00Z',
      `Check-In-By: ${checkIn}`,
      'Checkpoint-At: 2026-08-29T18:00:00Z',
      'Checkpoint-Commit: uncommitted',
      'Next-Action: test',
      'Blockers: none',
      '',
    ].join('\n'),
    labels: label ? [label] : ['area:foundation'],
  });
}

const ACTIVE_CLAIM = claimIssue({ number: 9, state: 'active' });

function v2ReadyIssue(number, overrides = {}) {
  const fields = {
    'Registry-Schema-Version': '2',
    'Parent-Plan': '#2',
    'Scope-Paths': 'tools/**',
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
    'Next-Action': 'claim after the full protocol',
    Blockers: 'none',
    ...overrides,
  };
  return restIssue({
    number,
    title: `Work: v2 record ${number}`,
    body: `${Object.entries(fields)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n')}\n`,
    labels: ['work:ready'],
  });
}

function v2ActiveIssue(number, overrides = {}) {
  const issue = v2ReadyIssue(number, {
    'Claim-State': 'active',
    'Claim-Harness': 'pi',
    'Claim-Run-ID': `run-${number}`,
    'Claim-Agent': `agent-${number}`,
    'Claim-Branch': `claim-v1/issue-${number}`,
    'Claim-Host': 'runner-01',
    'Claimed-At': '2026-09-01T01:00:00Z',
    'Check-In-By': FAR_FUTURE,
    'Checkpoint-State': 'active',
    'Checkpoint-At': '2026-09-01T01:00:00Z',
    'Checkpoint-Commit': 'a'.repeat(40),
    ...overrides,
  });
  issue.labels = [{ name: 'work:active' }];
  return issue;
}

const UNRELATED_ISSUE = restIssue({
  number: 42,
  title: 'Not coordinated work',
  body: '',
  labels: ['question'],
});

function commentEndpoint(number) {
  return `repos/${REPOSITORY}/issues/${number}/comments?per_page=100`;
}

function claimRefEndpoint(number) {
  return `repos/${REPOSITORY}/git/ref/heads/claim-v1/issue-${number}`;
}

function compareEndpoint(left, right) {
  return `repos/${REPOSITORY}/compare/${left}...${right}`;
}

function restRef(ref, sha = 'a'.repeat(40), type = 'commit') {
  return { ref, object: { type, sha } };
}

function restCompare(left, status, aheadBy, behindBy) {
  return { status, ahead_by: aheadBy, behind_by: behindBy, base_commit: { sha: left } };
}

function restCheckpointComment(issue, id = 7300, body = issue.body) {
  return {
    id,
    user: { login: 'maintainer' },
    body: `Coordination-Write-ID: checkpoint-${id}\n${body}`,
    created_at: '2026-09-01T02:00:00Z',
    updated_at: '2026-09-01T02:00:00Z',
  };
}

function restIntegrationHold({
  id = 8000,
  action = 'acquire',
  pr = '61',
  head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  attempt = '1',
  principal = 'maintainer',
  acquiredAt = '2026-09-03T05:00:00.000Z',
  eventAt = acquiredAt,
  outcome = action === 'acquire' ? 'unclaimed' : 'integrated',
  author = principal,
  updatedAt = eventAt,
} = {}) {
  return {
    id,
    user: { login: author },
    body: [
      '## Integration hold evidence',
      'Integration-Hold-Evidence-Version: 1',
      `Integration-Hold-Action: ${action}`,
      `Integration-Hold-ID: pr-${pr}-head-${head}-base-${base}-attempt-${attempt}`,
      `Integration-Hold-Principal: ${principal}`,
      `Integration-Hold-PR: ${pr}`,
      `Integration-Hold-Head: ${head}`,
      `Integration-Hold-Base: ${base}`,
      `Integration-Hold-Attempt: ${attempt}`,
      `Integration-Hold-Scratch-Branch: test/integration-pr-${pr}-base-${base.slice(0, 12)}-attempt-${attempt}`,
      `Integration-Hold-Acquired-At: ${acquiredAt}`,
      `Integration-Hold-Event-At: ${eventAt}`,
      `Integration-Hold-Outcome: ${outcome}`,
    ].join('\n'),
    created_at: eventAt,
    updated_at: updatedAt,
  };
}

function defaultResponses() {
  return {
    '--version': { stdout: 'gh version 2.0.0 (test)\n' },
    auth: { stdout: 'Logged in to github.com as test-agent\n' },
    repo: { stdout: `${REPOSITORY}\n` },
    [`api:${LABELS_ENDPOINT}`]: { stdout: JSON.stringify([COORDINATION_LABELS]) },
    [`api:${ISSUES_ENDPOINT}`]: {
      stdout: JSON.stringify([[PLAN_ISSUE, ACTIVE_CLAIM, UNRELATED_ISSUE]]),
    },
    [`api:${CLAIM_REFS_ENDPOINT}`]: { stdout: '[[]]' },
    [`api:${MAIN_REF_ENDPOINT}`]: {
      stdout: JSON.stringify(restRef('refs/heads/main')),
    },
    [`api:${PULLS_ENDPOINT}`]: { stdout: '[[]]' },
  };
}

function writeExecutable(directory, name, body) {
  const path = join(directory, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeGitShim(
  directory,
  worktreeOutput = [
    'worktree /fake/integration',
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/main',
    '',
    'worktree /fake/worktree',
    'HEAD abc1234',
    'branch refs/heads/test/sample',
    '',
  ].join('\n'),
  hooksConfigOutput = '',
  localBranchesOutput = 'test/sample\tabc1234\n',
) {
  const worktreeFile = join(directory, 'git-worktrees.out');
  const hooksConfigFile = join(directory, 'git-hooks-config.out');
  const localBranchesFile = join(directory, 'git-local-branches.out');
  const integrationGitDirectory = join(directory, 'integration-git');
  writeFileSync(worktreeFile, worktreeOutput);
  writeFileSync(hooksConfigFile, hooksConfigOutput);
  writeFileSync(localBranchesFile, localBranchesOutput);
  writeExecutable(
    directory,
    'git',
    `#!/bin/sh
${SHIM_PATH}
printf 'git GIT_OPTIONAL_LOCKS=%s %s\\n' "$GIT_OPTIONAL_LOCKS" "$*" >> "$INVOCATION_LOG"
if [ "$1" = "--no-optional-locks" ]; then shift; else exit 126; fi
if [ "$1" = "-C" ]; then
  cwd=$2
  shift 2
  case "$1" in
    status) case " $* " in *" --branch "*) printf '# branch.oid ${'a'.repeat(40)}\\n# branch.head main\\n' ;; *) : ;; esac ;;
    symbolic-ref) if [ "$cwd" = "/fake/worktree" ]; then printf 'refs/heads/claim-v1/issue-61\\n'; else printf 'refs/heads/main\\n'; fi ;;
    rev-parse) printf '${integrationGitDirectory}\\n' ;;
    config) if [ -s '${hooksConfigFile}' ]; then cat '${hooksConfigFile}'; else exit 1; fi ;;
    ls-files) printf '100755 %s 0\\t%s\\n' '${'b'.repeat(40)}' "$4" ;;
    merge-base) if [ "$3" = "${'b'.repeat(40)}" ] && [ "$4" = "${'a'.repeat(40)}" ]; then exit 0; else exit 1; fi ;;
    *) printf 'unexpected git -C invocation: %s %s\\n' "$cwd" "$*" >&2; exit 127 ;;
  esac
  exit 0
fi
case "$1" in
  status) printf '## test/sample...origin/main\\n' ;;
  worktree) cat '${worktreeFile}' ;;
  for-each-ref) cat '${localBranchesFile}' ;;
  ls-remote) printf '${'a'.repeat(40)}\\trefs/heads/main\\n' ;;
  *) printf 'unexpected git invocation: %s\\n' "$*" >&2; exit 127 ;;
esac
`,
  );
}

function writeGhShim(directory, responses) {
  const responseFile = join(directory, 'responses.json');
  const countsFile = join(directory, 'gh-counts.json');
  writeFileSync(responseFile, JSON.stringify(responses));
  writeFileSync(countsFile, '{}');
  writeExecutable(
    directory,
    'gh',
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INVOCATION_LOG, "gh " + args.join(" ") + "\\n");
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)}, "utf8"));
const key = args[0] === "api" ? "api:" + args.at(-1) : args[0];
let fallback = key.includes("/comments?per_page=100") ? { stdout: "[[]]" } : undefined;
if (!fallback && key.includes("/git/ref/heads/claim-v1/issue-")) {
  const ref = key.slice(key.indexOf("repos/") + 6).split("/git/ref/")[1];
  fallback = { stdout: JSON.stringify({ ref: "refs/" + ref, object: { type: "commit", sha: "${'a'.repeat(40)}" } }) };
}
const configured = responses[key] ?? fallback;
const counts = JSON.parse(fs.readFileSync(${JSON.stringify(countsFile)}, "utf8"));
const call = counts[key] ?? 0;
counts[key] = call + 1;
fs.writeFileSync(${JSON.stringify(countsFile)}, JSON.stringify(counts));
const response = configured?.sequence ? configured.sequence[Math.min(call, configured.sequence.length - 1)] : configured;
if (!response) {
  process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
  process.exit(127);
}
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.status ?? 0);
`,
  );
}

function runStatus(
  t,
  {
    responses = defaultResponses(),
    gh = true,
    args = [],
    gitWorktrees,
    gitHooksConfig,
    gitLocalBranches,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'mn-coordination-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const invocationLog = join(directory, 'invocations.log');
  writeFileSync(invocationLog, '');
  writeFileSync(join(directory, 'sentinel.txt'), 'unchanged\n');
  mkdirSync(join(directory, '.githooks'));
  writeExecutable(directory, '.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
  writeExecutable(directory, '.githooks/pre-merge-commit', '#!/bin/sh\nexit 0\n');
  writeExecutable(directory, 'hostname', '#!/bin/sh\nprintf "runner-01\\n"\n');
  writeGitShim(directory, gitWorktrees, gitHooksConfig, gitLocalBranches);
  if (gh) writeGhShim(directory, responses);
  const beforeFiles = readdirSync(directory).sort();
  const beforeSentinel = readFileSync(join(directory, 'sentinel.txt'), 'utf8');

  const result = spawnSync(process.execPath, [STATUS_TOOL, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: directory, HOME: directory, INVOCATION_LOG: invocationLog },
  });

  assert.equal(result.error, undefined, `could not run status tool: ${result.error?.message}`);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    invocations: readFileSync(invocationLog, 'utf8').trim().split('\n').filter(Boolean),
    beforeFiles,
    afterFiles: readdirSync(directory).sort(),
    beforeSentinel,
    afterSentinel: readFileSync(join(directory, 'sentinel.txt'), 'utf8'),
  };
}

function assertReportsUnknown(result, detail) {
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /COORDINATION UNKNOWN/);
  assert.match(result.stderr, /Do not assume work is unclaimed/);
  assert.doesNotMatch(result.stdout, /## Shared plans/);
  if (detail) assert.match(result.stderr, detail);
}

test('healthy human output reports reconciled claims and advisory candidate semantics', (t) => {
  const result = runStatus(t);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /## Shared registry\nexample\/registry/);
  assert.match(result.stdout, /#2 \[active\] Plan: sample shared plan/);
  assert.match(result.stdout, /#9 \[active; claimed\] Work: sample claim 9/);
  assert.match(result.stdout, /dependencies=clear reconciliation=consistent/);
  assert.match(result.stdout, /local=matched/);
  assert.match(result.stdout, /claiming is safe/);
  assert.doesNotMatch(result.stdout, /#42/);
});

test('plan integration holds are visible, paired deterministically, and malformed evidence warns', (t) => {
  {
    const responses = defaultResponses();
    responses[`api:${commentEndpoint(2)}`] = {
      stdout: JSON.stringify([[restIntegrationHold()]]),
    };
    const result = runStatus(t, { responses, args: ['--json'] });
    const report = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 0);
    assert.equal(report.registry.plans[0].integrationHold.status, 'held');
    assert.match(report.registry.plans[0].integrationHold.active.holdId, /^pr-61-head-/);
  }
  {
    const responses = defaultResponses();
    responses[`api:${commentEndpoint(2)}`] = {
      stdout: JSON.stringify([[restIntegrationHold({ author: 'other-principal' })]]),
    };
    const result = runStatus(t, { responses, args: ['--json'] });
    const report = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 2);
    assert.equal(report.registry.plans[0].integrationHold.status, 'question');
    assert(
      report.registry.maintainerQuestions.some(
        ({ issueNumber, code }) => issueNumber === 2 && code === 'integration-hold-malformed',
      ),
    );
  }
});

test('versioned JSON mode is one parseable document with candidate safety explicit', (t) => {
  const ready = claimIssue({ number: 10, state: 'ready', label: 'work:ready' });
  ready.body = ready.body
    .replace('Claim-Harness: pi', 'Claim-Harness: unclaimed')
    .replace('Claim-Run-ID: run-123', 'Claim-Run-ID: unclaimed')
    .replace('Claim-Agent: pi-sample', 'Claim-Agent: unclaimed')
    .replace('Claim-Branch: test/sample', 'Claim-Branch: unclaimed')
    .replace('Claim-Worktree: /fake/worktree', 'Claim-Worktree: unclaimed')
    .replace('Claimed-At: 2026-08-29T18:00:00Z', 'Claimed-At: unclaimed')
    .replace(`Check-In-By: ${FAR_FUTURE}`, 'Check-In-By: unclaimed');
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE, ready]]) };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(report.schemaVersion, '1.0');
  assert.equal(report.coordinationKnown, true);
  assert.equal(report.registry.workItems[0].triage, 'candidate');
  assert.equal(report.registry.workItems[0].candidateSafety, 'not-established');
  assert.equal(report.local.integrationCheckout.status, 'mirrored');
  assert.equal(report.local.hooks.configuration.status, 'unset');
  assert.equal(report.local.hooks.configuration.effective, null);
  assert.equal(report.local.hooks.checkoutPath, '/fake/integration');
  assert.equal(report.local.hooks.files['pre-commit'].indexMode, '100755');
  assert.equal(report.local.hooks.files['pre-commit'].filesystem.status, 'missing');
  assert.equal(report.local.hooks.files['pre-merge-commit'].indexMode, '100755');
  assert.equal(report.local.hooks.files['pre-merge-commit'].filesystem.status, 'missing');
  assert.equal(report.local.hooks.ready, false);
  assert.match(report.advisory, /never proves that claiming is safe/);
});

test('hook configuration reports effective value, scope, and origin without changing it', (t) => {
  const configured = runStatus(t, {
    args: ['--json'],
    gitHooksConfig: 'local\tfile:/fake/integration/.git/config\t.githooks\n',
  });
  const report = JSON.parse(configured.stdout);
  assert.equal(configured.exitCode, 2);
  assert.deepEqual(report.local.hooks.configuration.effective, {
    scope: 'local',
    origin: 'file:/fake/integration/.git/config',
    value: '.githooks',
  });
  assert.equal(report.local.hooks.checkoutPath, '/fake/integration');
  assert.equal(report.local.hooks.ready, false);
  assert(report.warnings.some(({ code }) => code === 'integration-hooks-not-ready'));

  const mismatch = runStatus(t, {
    args: ['--json'],
    gitHooksConfig: 'global\tfile:/fake/home/.gitconfig\t/unsafe/hooks\n',
  });
  const mismatchReport = JSON.parse(mismatch.stdout);
  assert.equal(mismatch.exitCode, 2);
  assert(mismatchReport.warnings.some(({ code }) => code === 'integration-hooks-path-mismatch'));

  const wrongScope = runStatus(t, {
    args: ['--json'],
    gitHooksConfig: 'global\tfile:/fake/home/.gitconfig\t.githooks\n',
  });
  const wrongScopeReport = JSON.parse(wrongScope.stdout);
  assert.equal(wrongScope.exitCode, 2);
  assert(wrongScopeReport.warnings.some(({ code }) => code === 'integration-hooks-path-mismatch'));
});

test('mixed v1/v2 JSON exposes each record schema without changing candidate ordering', (t) => {
  const readyV2 = v2ReadyIssue(11);
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = {
    stdout: JSON.stringify([[PLAN_ISSUE, ACTIVE_CLAIM, readyV2]]),
  };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);
  const v1 = report.registry.workItems.find(({ number }) => number === 9);
  const v2 = report.registry.workItems.find(({ number }) => number === 11);

  assert.equal(result.exitCode, 0);
  assert.deepEqual([v1.number, v2.number], [9, 11]);
  assert.equal(v1.registrySchema.version, '1');
  assert.equal(v1.registrySchema.explicit, false);
  assert.equal(v2.registrySchema.version, '2');
  assert.equal(v2.registrySchema.explicit, true);
  assert.equal(v2.triage, 'candidate');
  assert.deepEqual(v2.scopePaths, ['tools/**']);
});

test('unsupported and malformed host edits remain on the human board and fail closed', (t) => {
  const unsupported = v2ReadyIssue(12, { 'Registry-Schema-Version': 'future' });
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE, unsupported]]) };
  const result = runStatus(t, { responses });

  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /#12 \[ready; question\]/);
  assert.match(result.stdout, /## Unparseable or unsupported registry records/);
  assert.match(result.stdout, /schema=vfuture status=unsupported/);
  assert.match(result.stdout, /unsupported-schema-version/);
  assert.doesNotMatch(result.stdout, /#12 dependencies clear; claiming safety not established/);
});

test('issue and pull request retrieval consumes records beyond the first API page', (t) => {
  const secondPage = claimIssue({ number: 77, state: 'active' });
  secondPage.body = secondPage.body
    .replace('Claim-Branch: test/sample', 'Claim-Branch: test/page-two')
    .replace('Claim-Worktree: /fake/worktree', 'Claim-Worktree: /remote/page-two');
  const pull = {
    number: 88,
    title: 'Page two PR',
    head: { ref: 'test/page-two' },
    base: { ref: 'main' },
    updated_at: '2026-08-29T20:00:00Z',
    html_url: 'https://example.invalid/pull/88',
    draft: false,
  };
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = {
    stdout: JSON.stringify([[PLAN_ISSUE, ACTIVE_CLAIM], [secondPage]]),
  };
  responses[`api:${PULLS_ENDPOINT}`] = { stdout: JSON.stringify([[], [pull]]) };
  const result = runStatus(t, { responses });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /#77/);
  assert.match(result.stdout, /#88 test\/page-two -> main/);
  assert(result.invocations.includes(`gh api --paginate --slurp ${ISSUES_ENDPOINT}`));
  assert(result.invocations.includes(`gh api --paginate --slurp ${PULLS_ENDPOINT}`));
});

test('reserved claim-ref enumeration consumes every page and reconciles a derived active claim', (t) => {
  const active = v2ActiveIssue(73);
  const remote = {
    ref: 'refs/heads/claim-v1/issue-73',
    object: { type: 'commit', sha: 'a'.repeat(40) },
  };
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE], [active]]) };
  responses[`api:${CLAIM_REFS_ENDPOINT}`] = { stdout: JSON.stringify([[], [remote]]) };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);
  const item = report.registry.workItems.find(({ number }) => number === 73);

  assert.equal(result.exitCode, 0);
  assert.equal(item.remoteClaim.branchStatus, 'derived');
  assert.equal(item.remoteClaim.matchingRefs.length, 1);
  assert.equal(item.remoteClaim.lifecycle.status, 'matched');
  assert.equal(item.remoteClaim.lifecycle.checkpointCommit, 'a'.repeat(40));
  assert.equal(item.remoteClaim.lifecycle.remoteHead, 'a'.repeat(40));
  assert.equal(report.registry.remoteClaims.refs.length, 1);
  assert(result.invocations.includes(`gh api --paginate --slurp ${CLAIM_REFS_ENDPOINT}`));
});

test('a reserved ref directly fetches its closed terminal issue and preserves it without migration', (t) => {
  const terminal = v2ActiveIssue(73, {
    'Claim-State': 'done',
    'Check-In-By': 'unclaimed',
    'Checkpoint-State': 'done',
  });
  terminal.state = 'closed';
  terminal.labels = [{ name: 'work:done' }];
  const remote = {
    ref: 'refs/heads/claim-v1/issue-73',
    object: { type: 'commit', sha: 'a'.repeat(40) },
  };
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE]]) };
  responses[`api:${CLAIM_REFS_ENDPOINT}`] = { stdout: JSON.stringify([[remote]]) };
  responses['api:repos/example/registry/issues/73'] = { stdout: JSON.stringify(terminal) };
  responses[`api:${commentEndpoint(73)}`] = {
    stdout: JSON.stringify([[restCheckpointComment(terminal)]]),
  };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.equal(report.registry.remoteClaims.questions.length, 0);
  assert.equal(
    report.registry.workItems.some(({ number }) => number === 73),
    false,
  );
  assert(result.invocations.includes('gh api repos/example/registry/issues/73'));
  assert(result.invocations.includes(`gh api --paginate --slurp ${commentEndpoint(73)}`));
});

test('closed reserved-ref issues fail closed on wrong labels and conflicting comments', (t) => {
  const remote = {
    ref: 'refs/heads/claim-v1/issue-73',
    object: { type: 'commit', sha: 'a'.repeat(40) },
  };
  for (const [name, configure, expectedCode] of [
    [
      'wrong label',
      (terminal, responses) => {
        terminal.labels = [{ name: 'work:active' }];
        responses[`api:${commentEndpoint(73)}`] = {
          stdout: JSON.stringify([[restCheckpointComment(terminal)]]),
        };
      },
      'body-label-state-mismatch',
    ],
    [
      'conflicting comment',
      (terminal, responses) => {
        const competing = v2ActiveIssue(73, {
          'Claim-Run-ID': 'competing-run',
          'Claim-Agent': 'competing-agent',
        });
        responses[`api:${commentEndpoint(73)}`] = {
          stdout: JSON.stringify([[restCheckpointComment(competing, 7301)]]),
        };
      },
      'competing-ownership-comment',
    ],
  ]) {
    const terminal = v2ActiveIssue(73, {
      'Claim-State': 'done',
      'Check-In-By': 'unclaimed',
      'Checkpoint-State': 'done',
    });
    terminal.state = 'closed';
    terminal.labels = [{ name: 'work:done' }];
    const responses = defaultResponses();
    responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE]]) };
    responses[`api:${CLAIM_REFS_ENDPOINT}`] = { stdout: JSON.stringify([[remote]]) };
    responses['api:repos/example/registry/issues/73'] = { stdout: JSON.stringify(terminal) };
    configure(terminal, responses);
    responses['api:repos/example/registry/issues/73'] = { stdout: JSON.stringify(terminal) };
    const report = JSON.parse(runStatus(t, { responses, args: ['--json'] }).stdout);
    assert(
      report.registry.maintainerQuestions.some(
        ({ issueNumber, code }) => issueNumber === 73 && code === expectedCode,
      ),
      name,
    );
  }
});

test('a closed active issue still blocks the #42 rollout invariant', (t) => {
  const bootstrap = v2ActiveIssue(42, {
    'Claim-Branch': 'arch/remote-reference-claim-primitive',
  });
  const closedActive = v2ActiveIssue(73);
  closedActive.state = 'closed';
  const remote = {
    ref: 'refs/heads/claim-v1/issue-73',
    object: { type: 'commit', sha: 'a'.repeat(40) },
  };
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = {
    stdout: JSON.stringify([[PLAN_ISSUE, bootstrap, closedActive]]),
  };
  responses[`api:${CLAIM_REFS_ENDPOINT}`] = { stdout: JSON.stringify([[remote]]) };
  responses['api:repos/example/registry/issues/73'] = { stdout: JSON.stringify(closedActive) };
  responses[`api:${commentEndpoint(73)}`] = {
    stdout: JSON.stringify([[restCheckpointComment(closedActive, 7302)]]),
  };
  const report = JSON.parse(runStatus(t, { responses, args: ['--json'] }).stdout);
  assert(
    report.registry.maintainerQuestions.some(
      ({ issueNumber, code }) => issueNumber === 73 && code === 'claim-primitive-rollout-blocked',
    ),
  );
  const bootstrapItem = report.registry.workItems.find(({ number }) => number === 42);
  assert(bootstrapItem.questions.some(({ code }) => code === 'claim-primitive-rollout-blocked'));
});

test('integration-main classification requires stable direct-ref and host compare evidence', (t) => {
  const local = 'a'.repeat(40);
  const remote = 'b'.repeat(40);
  const stable = defaultResponses();
  stable[`api:${MAIN_REF_ENDPOINT}`] = {
    stdout: JSON.stringify(restRef('refs/heads/main', remote)),
  };
  stable[`api:${compareEndpoint(local, remote)}`] = {
    stdout: JSON.stringify(restCompare(local, 'ahead', 1, 0)),
  };
  const stableReport = JSON.parse(runStatus(t, { responses: stable, args: ['--json'] }).stdout);
  assert.equal(stableReport.local.integrationCheckout.status, 'fast-forward-lag');
  assert.equal(stableReport.local.integrationCheckout.relationship, 'right-ahead');

  const refRace = defaultResponses();
  refRace[`api:${MAIN_REF_ENDPOINT}`] = {
    sequence: [
      { stdout: JSON.stringify(restRef('refs/heads/main', remote)) },
      { stdout: JSON.stringify(restRef('refs/heads/main', 'c'.repeat(40))) },
    ],
  };
  refRace[`api:${compareEndpoint(local, remote)}`] =
    stable[`api:${compareEndpoint(local, remote)}`];
  const refRaceReport = JSON.parse(runStatus(t, { responses: refRace, args: ['--json'] }).stdout);
  assert.equal(refRaceReport.local.integrationCheckout.status, 'unavailable');

  const compareRace = defaultResponses();
  compareRace[`api:${MAIN_REF_ENDPOINT}`] = {
    stdout: JSON.stringify(restRef('refs/heads/main', remote)),
  };
  compareRace[`api:${compareEndpoint(local, remote)}`] = {
    sequence: [
      { stdout: JSON.stringify(restCompare(local, 'ahead', 1, 0)) },
      { stdout: JSON.stringify(restCompare(local, 'diverged', 1, 1)) },
    ],
  };
  const compareRaceReport = JSON.parse(
    runStatus(t, { responses: compareRace, args: ['--json'] }).stdout,
  );
  assert.equal(compareRaceReport.local.integrationCheckout.status, 'unavailable');

  const malformed = defaultResponses();
  malformed[`api:${MAIN_REF_ENDPOINT}`] = {
    stdout: JSON.stringify(restRef('refs/heads/main', remote, 'tag')),
  };
  const malformedReport = JSON.parse(
    runStatus(t, { responses: malformed, args: ['--json'] }).stdout,
  );
  assert.equal(malformedReport.local.integrationCheckout.status, 'unavailable');
});

test('status uses stable direct-ref and compare evidence and fails closed on races', (t) => {
  const issue = v2ActiveIssue(61);
  const checkpoint = 'a'.repeat(40);
  const remote = 'b'.repeat(40);
  const ref = 'refs/heads/claim-v1/issue-61';
  const baseResponses = () => {
    const responses = defaultResponses();
    responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE, issue]]) };
    responses[`api:${CLAIM_REFS_ENDPOINT}`] = {
      stdout: JSON.stringify([[{ ref, object: { type: 'commit', sha: remote } }]]),
    };
    return responses;
  };

  const stable = baseResponses();
  stable[`api:${claimRefEndpoint(61)}`] = { stdout: JSON.stringify(restRef(ref, remote)) };
  stable[`api:${compareEndpoint(checkpoint, remote)}`] = {
    stdout: JSON.stringify(restCompare(checkpoint, 'ahead', 1, 0)),
  };
  const stableReport = JSON.parse(runStatus(t, { responses: stable, args: ['--json'] }).stdout);
  const stableItem = stableReport.registry.workItems.find(({ number }) => number === 61);
  assert.equal(stableItem.remoteClaim.lifecycle.status, 'remote-ahead');
  assert.equal(stableItem.remoteClaim.lifecycle.source, 'github-compare');
  assert(
    stableItem.questions.some(({ code }) => code === 'claim-lifecycle-remote-ahead'),
    'remote-ahead must be an explicit maintainer question even when the remote commit is absent locally',
  );

  const refRace = baseResponses();
  refRace[`api:${claimRefEndpoint(61)}`] = {
    sequence: [
      { stdout: JSON.stringify(restRef(ref, remote)) },
      { stdout: JSON.stringify(restRef(ref, 'c'.repeat(40))) },
    ],
  };
  refRace[`api:${compareEndpoint(checkpoint, remote)}`] =
    stable[`api:${compareEndpoint(checkpoint, remote)}`];
  const refRaceReport = JSON.parse(runStatus(t, { responses: refRace, args: ['--json'] }).stdout);
  assert.equal(
    refRaceReport.registry.workItems.find(({ number }) => number === 61).remoteClaim.lifecycle
      .status,
    'unavailable',
  );

  const compareRace = baseResponses();
  compareRace[`api:${claimRefEndpoint(61)}`] = {
    stdout: JSON.stringify(restRef(ref, remote)),
  };
  compareRace[`api:${compareEndpoint(checkpoint, remote)}`] = {
    sequence: [
      { stdout: JSON.stringify(restCompare(checkpoint, 'ahead', 1, 0)) },
      { stdout: JSON.stringify(restCompare(checkpoint, 'diverged', 1, 1)) },
    ],
  };
  const compareRaceReport = JSON.parse(
    runStatus(t, { responses: compareRace, args: ['--json'] }).stdout,
  );
  assert.equal(
    compareRaceReport.registry.workItems.find(({ number }) => number === 61).remoteClaim.lifecycle
      .status,
    'unavailable',
  );

  const malformed = baseResponses();
  malformed[`api:${claimRefEndpoint(61)}`] = {
    stdout: JSON.stringify(restRef(ref, remote, 'tag')),
  };
  const malformedReport = JSON.parse(
    runStatus(t, { responses: malformed, args: ['--json'] }).stdout,
  );
  assert.equal(
    malformedReport.registry.workItems.find(({ number }) => number === 61).remoteClaim.lifecycle
      .status,
    'unavailable',
  );
});

test('same-host clean claim containment is the only local-ahead fallback', (t) => {
  const issue = v2ActiveIssue(61);
  const checkpoint = 'a'.repeat(40);
  const remote = 'b'.repeat(40);
  const ref = 'refs/heads/claim-v1/issue-61';
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE, issue]]) };
  responses[`api:${CLAIM_REFS_ENDPOINT}`] = {
    stdout: JSON.stringify([[{ ref, object: { type: 'commit', sha: remote } }]]),
  };
  responses[`api:${claimRefEndpoint(61)}`] = { stdout: JSON.stringify(restRef(ref, remote)) };
  responses[`api:${compareEndpoint(checkpoint, remote)}`] = {
    status: 1,
    stderr: 'not found',
  };
  const worktrees = [
    'worktree /fake/integration',
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/main',
    '',
    'worktree /fake/worktree',
    `HEAD ${checkpoint}`,
    'branch refs/heads/claim-v1/issue-61',
    '',
  ].join('\n');
  const report = JSON.parse(
    runStatus(t, {
      responses,
      args: ['--json'],
      gitWorktrees: worktrees,
      gitLocalBranches: `claim-v1/issue-61\t${checkpoint}\n`,
    }).stdout,
  );
  const item = report.registry.workItems.find(({ number }) => number === 61);
  assert.equal(item.remoteClaim.lifecycle.status, 'local-ahead');
  assert.equal(item.remoteClaim.lifecycle.source, 'same-host-local-containment');
});

test('missing, orphaned, malformed, and unsupported reserved-ref evidence fails closed', (t) => {
  const cases = [
    {
      issue: v2ActiveIssue(73),
      refs: [],
      code: 'derived-claim-ref-missing',
    },
    {
      issue: v2ReadyIssue(73),
      refs: [
        { ref: 'refs/heads/claim-v1/issue-73', object: { type: 'commit', sha: 'a'.repeat(40) } },
      ],
      code: 'orphaned-claim-ref',
    },
    {
      issue: v2ReadyIssue(73),
      refs: [
        { ref: 'refs/heads/claim-v1/issue-073', object: { type: 'commit', sha: 'a'.repeat(40) } },
      ],
      code: 'malformed-claim-ref',
    },
    {
      issue: v2ReadyIssue(73),
      refs: [
        { ref: 'refs/heads/claim-v2/issue-73', object: { type: 'commit', sha: 'a'.repeat(40) } },
      ],
      code: 'unsupported-claim-ref-version',
    },
  ];
  for (const fixture of cases) {
    const responses = defaultResponses();
    responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE, fixture.issue]]) };
    responses[`api:${CLAIM_REFS_ENDPOINT}`] = { stdout: JSON.stringify([fixture.refs]) };
    const report = JSON.parse(runStatus(t, { responses, args: ['--json'] }).stdout);
    assert(
      report.registry.maintainerQuestions.some(({ code }) => code === fixture.code),
      fixture.code,
    );
  }
});

test('only the exact #42 bootstrap branch bypasses derived-ref checks and competing ownership blocks rollout', (t) => {
  const bootstrap = v2ActiveIssue(42, { 'Claim-Branch': 'arch/remote-reference-claim-primitive' });
  {
    const responses = defaultResponses();
    responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE, bootstrap]]) };
    const result = runStatus(t, { responses, args: ['--json'] });
    const report = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 0);
    assert.equal(report.registry.workItems[0].remoteClaim.branchStatus, 'bootstrap');
  }
  {
    const competing = v2ActiveIssue(73);
    const responses = defaultResponses();
    responses[`api:${ISSUES_ENDPOINT}`] = {
      stdout: JSON.stringify([[PLAN_ISSUE, bootstrap, competing]]),
    };
    responses[`api:${CLAIM_REFS_ENDPOINT}`] = {
      stdout: JSON.stringify([
        [
          {
            ref: 'refs/heads/claim-v1/issue-73',
            object: { type: 'commit', sha: 'a'.repeat(40) },
          },
        ],
      ]),
    };
    const report = JSON.parse(runStatus(t, { responses, args: ['--json'] }).stdout);
    assert.equal(
      report.registry.maintainerQuestions.filter(
        ({ code }) => code === 'claim-primitive-rollout-blocked',
      ).length,
      2,
    );
  }
});

test('latest structured claim comment disagreements become maintainer questions', (t) => {
  const responses = defaultResponses();
  responses[`api:${commentEndpoint(9)}`] = {
    stdout: JSON.stringify([
      [
        {
          id: 500,
          user: { login: 'maintainer' },
          body: `Claim-State: active\nClaim-Agent: pi-sample\nCheck-In-By: ${FAR_FUTURE}\n`,
          created_at: '2026-08-29T19:00:00Z',
          updated_at: '2026-08-29T19:00:00Z',
        },
      ],
      [
        {
          id: 501,
          user: { login: 'maintainer' },
          body: 'Claim-State: blocked\nClaim-Agent: another-agent\nCheck-In-By: 2999-02-01T00:00:00Z\n',
          created_at: '2026-08-29T20:00:00Z',
          updated_at: '2026-08-29T20:00:00Z',
        },
      ],
    ]),
  };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);
  const item = report.registry.workItems.find(({ number }) => number === 9);

  assert.equal(result.exitCode, 2);
  assert.equal(item.reconciliation, 'question');
  assert(item.questions.filter(({ code }) => code === 'body-comment-mismatch').length >= 3);
  assert.equal(item.triage, 'question');
});

test('unstructured claim comments fail closed instead of inferring ownership', (t) => {
  const responses = defaultResponses();
  responses[`api:${commentEndpoint(9)}`] = {
    stdout: JSON.stringify([
      [
        {
          id: 502,
          user: { login: 'maintainer' },
          body: 'Claimed by somebody; checkpoint later.',
          created_at: '2026-08-29T20:00:00Z',
          updated_at: '2026-08-29T20:00:00Z',
        },
      ],
    ]),
  };
  const report = JSON.parse(runStatus(t, { responses, args: ['--json'] }).stdout);

  assert(
    report.registry.maintainerQuestions.some(({ code }) => code === 'unstructured-claim-comment'),
  );
});

test('JSON retains explicitly reconciled historical claim comments as visible evidence', (t) => {
  const reconciled = {
    ...ACTIVE_CLAIM,
    body: ACTIVE_CLAIM.body.replace(
      'Reconciled-Claim-Comment-IDs: none',
      'Reconciled-Claim-Comment-IDs: 500',
    ),
  };
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[PLAN_ISSUE, reconciled]]) };
  responses[`api:${commentEndpoint(9)}`] = {
    stdout: JSON.stringify([
      [
        {
          id: 500,
          user: { login: 'test-agent' },
          body: 'Started work before structured comments existed.',
          created_at: '2026-08-29T18:30:00Z',
          updated_at: '2026-08-29T18:30:00Z',
        },
        {
          id: 501,
          user: { login: 'maintainer' },
          body: [
            'Claim-State: active',
            'Claim-Harness: pi',
            'Claim-Run-ID: run-123',
            'Claim-Agent: pi-sample',
            'Claim-Branch: test/sample',
            'Claim-Worktree: /fake/worktree',
            `Check-In-By: ${FAR_FUTURE}`,
            'Checkpoint-At: 2026-08-29T18:00:00Z',
            'Checkpoint-Commit: uncommitted',
          ].join('\n'),
          created_at: '2026-08-29T19:00:00Z',
          updated_at: '2026-08-29T19:00:00Z',
        },
      ],
    ]),
  };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);
  const item = report.registry.workItems.find(({ number }) => number === 9);

  assert.equal(result.exitCode, 0);
  assert.equal(item.claimCommentResolution.status, 'valid');
  assert.equal(item.claimCommentResolution.authority, 'maintainer-or-integration-owner');
  assert.deepEqual(item.claimCommentResolution.reconciledIds, [500]);
  assert.deepEqual(item.claimCommentResolution.unresolvedIds, [501]);
  assert.equal(item.claimComments.find(({ id }) => id === 500).reconciliation, 'reconciled');
  assert.equal(item.latestUnresolvedClaimComment.id, 501);
});

test('claim-bearing issues missing work labels stay visible and warn', (t) => {
  const unlabeled = claimIssue({ number: 14, state: 'active', label: null });
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[unlabeled]]) };
  const result = runStatus(t, { responses });

  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /#14 \[active; question\]/);
  assert.match(result.stdout, /body-label-state-mismatch/);
});

test('blocked and review claims with expired or invalid deadlines both warn', (t) => {
  const blocked = claimIssue({ number: 15, state: 'blocked', checkIn: LONG_PAST });
  blocked.body = blocked.body
    .replace('Claim-Branch: test/sample', 'Claim-Branch: test/blocked')
    .replace('Claim-Worktree: /fake/worktree', 'Claim-Worktree: /remote/blocked');
  const review = claimIssue({ number: 16, state: 'review', checkIn: 'not-a-date' });
  review.body = review.body
    .replace('Claim-Branch: test/sample', 'Claim-Branch: test/review')
    .replace('Claim-Worktree: /fake/worktree', 'Claim-Worktree: /remote/review');
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[blocked, review]]) };
  const report = JSON.parse(runStatus(t, { responses, args: ['--json'] }).stdout);

  assert(
    report.registry.maintainerQuestions.some(
      ({ issueNumber, code }) => issueNumber === 15 && code === 'check-in-overdue',
    ),
  );
  assert(
    report.registry.maintainerQuestions.some(
      ({ issueNumber, code }) => issueNumber === 16 && code === 'check-in-invalid',
    ),
  );
});

test('local branch and registered worktree contradictions are surfaced without repair', (t) => {
  const mismatch = {
    ...ACTIVE_CLAIM,
    body: ACTIVE_CLAIM.body.replace(
      'Claim-Worktree: /fake/worktree',
      'Claim-Worktree: /claimed/elsewhere',
    ),
  };
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify([[mismatch]]) };
  const report = JSON.parse(runStatus(t, { responses, args: ['--json'] }).stdout);
  const item = report.registry.workItems[0];

  assert.equal(item.localEvidence.status, 'contradiction');
  assert(item.questions.some(({ code }) => code === 'branch-worktree-mismatch'));
});

test('locked and prunable porcelain evidence cannot report a matched worktree', (t) => {
  for (const [marker, code] of [
    ['locked worktree is in use', 'worktree-locked'],
    ['prunable gitdir points to a missing location', 'worktree-prunable'],
  ]) {
    const gitWorktrees = [
      'worktree /fake/worktree',
      'HEAD abc1234',
      'branch refs/heads/test/sample',
      marker,
      '',
    ].join('\n');
    const result = runStatus(t, { args: ['--json'], gitWorktrees });
    const report = JSON.parse(result.stdout);
    const item = report.registry.workItems.find(({ number }) => number === 9);

    assert.equal(result.exitCode, 2);
    assert.equal(item.localEvidence.status, 'contradiction');
    assert(item.questions.some((question) => question.code === code));
  }
});

test('an unreachable registry is coordination-unknown, never an empty board', (t) => {
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { status: 1, stderr: 'dial tcp: no such host\n' };
  const result = runStatus(t, { responses });

  assertReportsUnknown(result, /dial tcp: no such host/);
  assert.doesNotMatch(result.stdout, /^none$/m);
});

test('malformed paginated output is coordination-unknown', (t) => {
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = { stdout: JSON.stringify({ not: 'pages' }) };
  const result = runStatus(t, { responses });

  assertReportsUnknown(result, /invalid paginated response/);
});

test('impossible GitHub calendar timestamps fail closed', (t) => {
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = {
    stdout: JSON.stringify([[{ ...ACTIVE_CLAIM, updated_at: '2026-02-30T19:08:12Z' }]]),
  };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 2);
  assert.equal(report.coordinationKnown, false);
  assert.match(report.errors[0].message, /strict valid ISO instant/);
});

test('malformed issue records fail closed rather than dropping work', (t) => {
  const responses = defaultResponses();
  responses[`api:${ISSUES_ENDPOINT}`] = {
    stdout: JSON.stringify([[{ ...ACTIVE_CLAIM, body: null }]]),
  };
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 2);
  assert.equal(report.coordinationKnown, false);
  assert.equal(report.registry, null);
  assert.match(report.errors[0].message, /body must be a string/);
});

test('missing GitHub CLI is coordination-unknown', (t) => {
  const result = runStatus(t, { gh: false });
  assertReportsUnknown(result, /GitHub CLI is unavailable/);
});

test('status uses only read-only commands and does not change local files', (t) => {
  const result = runStatus(t);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.afterFiles, result.beforeFiles);
  assert.equal(result.afterSentinel, result.beforeSentinel);
  const gitInvocations = result.invocations.filter((entry) => entry.startsWith('git '));
  assert.equal(gitInvocations.length, 9);
  assert(
    gitInvocations.every((entry) =>
      entry.startsWith('git GIT_OPTIONAL_LOCKS=0 --no-optional-locks '),
    ),
  );
  assert(
    result.invocations.every(
      (entry) =>
        entry === 'git GIT_OPTIONAL_LOCKS=0 --no-optional-locks status --short --branch' ||
        entry === 'git GIT_OPTIONAL_LOCKS=0 --no-optional-locks worktree list --porcelain' ||
        entry.startsWith('git GIT_OPTIONAL_LOCKS=0 --no-optional-locks for-each-ref --format=') ||
        entry.startsWith(
          'git GIT_OPTIONAL_LOCKS=0 --no-optional-locks -C /fake/integration status ',
        ) ||
        entry.startsWith(
          'git GIT_OPTIONAL_LOCKS=0 --no-optional-locks -C /fake/integration symbolic-ref ',
        ) ||
        entry.startsWith(
          'git GIT_OPTIONAL_LOCKS=0 --no-optional-locks -C /fake/integration rev-parse ',
        ) ||
        entry.startsWith(
          'git GIT_OPTIONAL_LOCKS=0 --no-optional-locks -C /fake/integration config ',
        ) ||
        entry.startsWith(
          'git GIT_OPTIONAL_LOCKS=0 --no-optional-locks -C /fake/integration ls-files ',
        ) ||
        entry === 'gh --version' ||
        entry === 'gh auth status' ||
        entry.startsWith('gh repo view ') ||
        entry.startsWith('gh api --paginate --slurp repos/') ||
        entry.startsWith('gh api repos/'),
    ),
  );
  assert(
    result.invocations.every(
      (entry) => !/\b(POST|PATCH|PUT|DELETE|create|edit|close|push|remove|prune)\b/i.test(entry),
    ),
    result.invocations.join('\n'),
  );
});
