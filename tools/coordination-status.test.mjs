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
const CLAIM_REFS_ENDPOINT = `repos/${REPOSITORY}/git/matching-refs/heads/claim-v?per_page=100`;
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
  worktreeOutput = 'worktree /fake/worktree\nHEAD abc1234\nbranch refs/heads/test/sample\n\n',
) {
  const worktreeFile = join(directory, 'git-worktrees.out');
  writeFileSync(worktreeFile, worktreeOutput);
  writeExecutable(
    directory,
    'git',
    `#!/bin/sh
${SHIM_PATH}
printf 'git GIT_OPTIONAL_LOCKS=%s %s\\n' "$GIT_OPTIONAL_LOCKS" "$*" >> "$INVOCATION_LOG"
if [ "$1" = "--no-optional-locks" ]; then shift; else exit 126; fi
case "$1" in
  status) printf '## test/sample...origin/main\\n' ;;
  worktree) cat '${worktreeFile}' ;;
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

function runStatus(t, { responses = defaultResponses(), gh = true, args = [], gitWorktrees } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mn-coordination-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const invocationLog = join(directory, 'invocations.log');
  writeFileSync(invocationLog, '');
  writeFileSync(join(directory, 'sentinel.txt'), 'unchanged\n');
  writeGitShim(directory, gitWorktrees);
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
  const result = runStatus(t, { responses, args: ['--json'] });
  const report = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.equal(report.registry.remoteClaims.questions.length, 0);
  assert.equal(
    report.registry.workItems.some(({ number }) => number === 73),
    false,
  );
  assert(result.invocations.includes('gh api repos/example/registry/issues/73'));
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
  assert.equal(gitInvocations.length, 3);
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
