import assert from 'node:assert/strict';
import test from 'node:test';

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const UNRELATED_ISSUE = restIssue({
  number: 42,
  title: 'Not coordinated work',
  body: '',
  labels: ['question'],
});

function commentEndpoint(number) {
  return `repos/${REPOSITORY}/issues/${number}/comments?per_page=100`;
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
    [`api:${PULLS_ENDPOINT}`]: { stdout: '[[]]' },
  };
}

function writeExecutable(directory, name, body) {
  const path = join(directory, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeGitShim(directory) {
  writeExecutable(
    directory,
    'git',
    `#!/bin/sh
${SHIM_PATH}
printf 'git %s\\n' "$*" >> "$INVOCATION_LOG"
case "$1" in
  status) printf '## test/sample...origin/main\\n' ;;
  worktree) printf 'worktree /fake/worktree\\nHEAD abc1234\\nbranch refs/heads/test/sample\\n\\n' ;;
  for-each-ref) printf 'test/sample\\tabc1234\\n' ;;
  *) printf 'unexpected git invocation: %s\\n' "$*" >&2; exit 127 ;;
esac
`,
  );
}

function writeGhShim(directory, responses) {
  const responseFile = join(directory, 'responses.json');
  writeFileSync(responseFile, JSON.stringify(responses));
  writeExecutable(
    directory,
    'gh',
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INVOCATION_LOG, "gh " + args.join(" ") + "\\n");
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)}, "utf8"));
const key = args[0] === "api" ? "api:" + args.at(-1) : args[0];
const fallback = key.includes("/comments?per_page=100") ? { stdout: "[[]]" } : undefined;
const response = responses[key] ?? fallback;
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

function runStatus(t, { responses = defaultResponses(), gh = true, args = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mn-coordination-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const invocationLog = join(directory, 'invocations.log');
  writeFileSync(invocationLog, '');
  writeFileSync(join(directory, 'sentinel.txt'), 'unchanged\n');
  writeGitShim(directory);
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
  assert.match(report.advisory, /never proves that claiming is safe/);
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
  assert(
    result.invocations.every(
      (entry) =>
        entry.startsWith('git status ') ||
        entry === 'git status --short --branch' ||
        entry === 'git worktree list --porcelain' ||
        entry.startsWith('git for-each-ref ') ||
        entry === 'gh --version' ||
        entry === 'gh auth status' ||
        entry.startsWith('gh repo view ') ||
        entry.startsWith('gh api --paginate --slurp repos/'),
    ),
  );
  assert(
    result.invocations.every(
      (entry) =>
        !/\b(POST|PATCH|PUT|DELETE|create|edit|close|merge|push|remove|prune)\b/i.test(entry),
    ),
  );
});
