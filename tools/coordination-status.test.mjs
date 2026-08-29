import assert from 'node:assert/strict';
import test from 'node:test';

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests exercise the real script as a child process. Both `git` and `gh` are replaced by
// generated shims on an isolated PATH, so no test reaches the network, the real repository, or a
// real GitHub session. The script reads the clock directly, so deadlines are pinned far enough from
// the present that no realistic run date changes the outcome.
const STATUS_TOOL = fileURLToPath(new URL('./coordination-status.mjs', import.meta.url));
const FAR_FUTURE = '2999-01-01T00:00:00Z';
const LONG_PAST = '2000-01-01T00:00:00Z';

// The status tool runs with PATH limited to the shim directory so it can never reach a real `git`
// or `gh`; each shim therefore restores a PATH of its own for the utilities it uses.
const SHIM_PATH = 'PATH=/usr/bin:/bin';

const GIT_SHIM = `#!/bin/sh
${SHIM_PATH}
case "$1" in
  status) printf '## test/coordination-status-coverage...origin/v2\\n' ;;
  worktree) printf '/fake/worktree abc1234 [test/coordination-status-coverage]\\n' ;;
  *) printf 'unexpected git invocation: %s\\n' "$*" >&2; exit 127 ;;
esac
`;

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

const PLAN_ISSUE = {
  number: 2,
  title: 'Plan: sample shared plan',
  body: 'Plan-State: active\nIntegration-Owner: maintainer\n',
  labels: [{ name: 'work:plan' }],
  updatedAt: '2026-08-29T19:08:12Z',
  url: 'https://example.invalid/2',
};

const claimIssue = ({ number, state, checkIn, label }) => ({
  number,
  title: `Work: sample claim ${number}`,
  body: [
    'Parent-Plan: #2',
    `Claim-State: ${state}`,
    'Claim-Harness: claude-code',
    'Claim-Agent: cc-sample',
    'Claim-Branch: test/sample',
    'Claim-Worktree: /fake/worktree',
    `Check-In-By: ${checkIn}`,
    '',
  ].join('\n'),
  labels: [{ name: label }],
  updatedAt: '2026-08-29T19:08:12Z',
  url: `https://example.invalid/${number}`,
});

const ACTIVE_CLAIM = claimIssue({
  number: 9,
  state: 'active',
  checkIn: FAR_FUTURE,
  label: 'work:active',
});
const UNRELATED_ISSUE = {
  number: 42,
  title: 'Not coordinated work',
  body: '',
  labels: [{ name: 'question' }],
  updatedAt: '2026-08-29T19:08:12Z',
  url: 'https://example.invalid/42',
};

// `gh` is dispatched on its first argument, which is unique per call the script makes.
function ghShim(overrides = {}) {
  return {
    '--version': { stdout: 'gh version 2.0.0 (test)\n' },
    auth: { stdout: 'Logged in to github.com as test-agent\n' },
    repo: { stdout: 'example/registry\n' },
    label: { stdout: JSON.stringify(COORDINATION_LABELS) },
    issue: { stdout: JSON.stringify([PLAN_ISSUE, ACTIVE_CLAIM, UNRELATED_ISSUE]) },
    pr: { stdout: JSON.stringify([]) },
    ...overrides,
  };
}

function writeExecutable(directory, name, body) {
  const path = join(directory, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeGhShim(directory, responses) {
  const branches = Object.entries(responses).map(([subcommand, response]) => {
    if (response.raw) return `  ${subcommand}) ${response.raw} ;;`;
    const slug = subcommand.replace(/[^a-z0-9]/gi, '_');
    const out = join(directory, `gh-${slug}.out`);
    const err = join(directory, `gh-${slug}.err`);
    writeFileSync(out, response.stdout ?? '');
    writeFileSync(err, response.stderr ?? '');
    return `  ${subcommand}) cat '${out}'; cat '${err}' >&2; exit ${response.status ?? 0} ;;`;
  });

  const unexpected = `  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 127 ;;`;
  writeExecutable(
    directory,
    'gh',
    ['#!/bin/sh', SHIM_PATH, 'case "$1" in', ...branches, unexpected, 'esac', ''].join('\n'),
  );
}

// `gh: null` removes the GitHub CLI from PATH entirely.
function runStatus(t, { gh = ghShim(), args = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mn-coordination-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  writeExecutable(directory, 'git', GIT_SHIM);
  if (gh !== null) writeGhShim(directory, gh);

  const result = spawnSync(process.execPath, [STATUS_TOOL, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: directory, HOME: directory },
  });

  assert.equal(result.error, undefined, `could not run the status tool: ${result.error?.message}`);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

// The property under test: an unreachable or unparsable registry must never render as an empty
// board. No claim section may be reported as absent, and the run must exit non-zero saying so.
// Fixtures used with this helper must contain no legitimately empty section ahead of the failure,
// because a section already printed keeps its "none" when a later step fails.
function assertReportsUnknown(result, { detail } = {}) {
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /COORDINATION UNKNOWN/);
  assert.match(result.stderr, /Do not assume work is unclaimed/);
  assert.doesNotMatch(result.stdout, /^none$/m);
  assert.doesNotMatch(result.stdout, /no open coordinated work/);
  if (detail) assert.match(result.stderr, detail);
}

test('a healthy registry prints the plans, claims, and pull requests it can prove', (t) => {
  const result = runStatus(t);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /## Shared registry\nexample\/registry/);
  assert.match(result.stdout, /#2 \[active\] Plan: sample shared plan/);
  assert.match(result.stdout, /integration-owner=maintainer/);
  assert.match(result.stdout, /#9 \[active\] Work: sample claim 9/);
  assert.match(result.stdout, /parent=#2 harness=claude-code agent=cc-sample/);
  assert.match(
    result.stdout,
    new RegExp(`branch=test/sample worktree=/fake/worktree check-in=${FAR_FUTURE} \\(current\\)`),
  );
  assert.match(result.stdout, /## Open pull requests\nnone/);
  assert.match(result.stdout, /none detected from registry deadlines/);
  // An issue without a work:* label is not coordinated work and is not reported as a claim.
  assert.doesNotMatch(result.stdout, /#42/);
});

test('a missing GitHub CLI reports coordination unknown instead of an empty board', (t) => {
  const result = runStatus(t, { gh: null });

  assertReportsUnknown(result, { detail: /gh/ });
  assert.doesNotMatch(result.stdout, /## Shared registry/);
  assert.doesNotMatch(result.stdout, /## Shared plans/);
  assert.doesNotMatch(result.stdout, /## Open work claims/);
  // Local evidence the tool can still prove is kept.
  assert.match(result.stdout, /## Local worktrees/);
});

test('an unauthenticated GitHub CLI reports coordination unknown instead of an empty board', (t) => {
  const result = runStatus(t, {
    gh: ghShim({ auth: { status: 1, stderr: 'You are not logged into any GitHub hosts\n' } }),
  });

  assertReportsUnknown(result, {
    detail: /not authenticated; the shared registry cannot be verified/,
  });
  assert.doesNotMatch(result.stdout, /## Shared plans/);
});

test('an unreachable issue registry fails loudly and surfaces the underlying error', (t) => {
  const result = runStatus(t, {
    gh: ghShim({
      issue: { status: 1, stderr: 'error connecting to api.github.com: dial tcp: no such host\n' },
    }),
  });

  assertReportsUnknown(result, { detail: /dial tcp: no such host/ });
  assert.match(result.stderr, /gh issue list/);
  assert.doesNotMatch(result.stdout, /## Shared plans/);
});

test('malformed registry output is treated as unknown, not as an empty registry', (t) => {
  const result = runStatus(t, {
    gh: ghShim({ issue: { stdout: '<html><body>502 Bad Gateway</body></html>\n' } }),
  });

  assertReportsUnknown(result);
  assert.doesNotMatch(result.stdout, /## Shared plans/);
});

test('registry output of the wrong shape fails loudly rather than dropping claims', (t) => {
  const withoutLabels = [{ ...ACTIVE_CLAIM, labels: undefined }];
  const result = runStatus(t, { gh: ghShim({ issue: { stdout: JSON.stringify(withoutLabels) } }) });

  assertReportsUnknown(result);
});

test('an unreadable issue body fails loudly rather than silently hiding a claim', (t) => {
  const nullBody = [PLAN_ISSUE, { ...ACTIVE_CLAIM, body: null }];
  const result = runStatus(t, { gh: ghShim({ issue: { stdout: JSON.stringify(nullBody) } }) });

  assertReportsUnknown(result);
});

test('a registry command killed by a signal is reported as unknown with the signal named', (t) => {
  const result = runStatus(t, { gh: ghShim({ label: { raw: 'kill -TERM $$' } }) });

  assertReportsUnknown(result, { detail: /terminated by SIGTERM/ });
  assert.match(result.stderr, /gh label list/);
});

test('a registry command failing without stderr still names the command and its exit status', (t) => {
  const result = runStatus(t, { gh: ghShim({ repo: { status: 4, stdout: '', stderr: '' } }) });

  assertReportsUnknown(result, { detail: /gh repo view .* failed: exit status 4/ });
});

test('a failure after the claim board still marks the whole run unknown', (t) => {
  const result = runStatus(t, {
    gh: ghShim({ pr: { status: 1, stderr: 'gh: connection reset by peer\n' } }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /COORDINATION UNKNOWN/);
  assert.match(result.stderr, /connection reset by peer/);
  // The claims it did prove stay visible, but nothing is reported as absent.
  assert.match(result.stdout, /#9 \[active\] Work: sample claim 9/);
  assert.doesNotMatch(result.stdout, /none detected from registry deadlines/);
  assert.doesNotMatch(result.stdout, /no open coordinated work/);
});

test('a reachable but empty registry is distinguishable from an unreachable one', (t) => {
  const result = runStatus(t, { gh: ghShim({ issue: { stdout: '[]' }, pr: { stdout: '[]' } }) });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /## Shared plans\nnone/);
  assert.match(result.stdout, /## Open work claims\nnone/);
  assert.match(
    result.stdout,
    /Registry currently has no open coordinated work\. Confirm this is expected before editing shared scope\./,
  );
});

test('a registry missing coordination labels warns and still exits non-zero', (t) => {
  const partial = COORDINATION_LABELS.filter(
    ({ name }) => name !== 'work:blocked' && name !== 'work:abandoned',
  );
  const result = runStatus(t, { gh: ghShim({ label: { stdout: JSON.stringify(partial) } }) });

  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /WARNING missing coordination labels: work:blocked, work:abandoned/);
  // The claims it can still prove are reported alongside the warning.
  assert.match(result.stdout, /#9 \[active\] Work: sample claim 9/);
});

test('an overdue active claim is surfaced for the maintainer and never auto-cleaned', (t) => {
  const overdue = claimIssue({
    number: 11,
    state: 'active',
    checkIn: LONG_PAST,
    label: 'work:active',
  });
  const blocked = claimIssue({
    number: 12,
    state: 'blocked',
    checkIn: LONG_PAST,
    label: 'work:blocked',
  });
  const result = runStatus(t, {
    gh: ghShim({ issue: { stdout: JSON.stringify([overdue, blocked]) } }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, new RegExp(`check-in=${LONG_PAST} \\(overdue\\)`));
  assert.match(
    result.stdout,
    /ASK MAINTAINER: #11 check-in overdue; do not take over or clean automatically/,
  );
  // Only claims that say they are active are suspected stale.
  assert.doesNotMatch(result.stdout, /ASK MAINTAINER: #12/);
});

test('an active claim with no check-in deadline is suspected stale rather than trusted', (t) => {
  const undated = claimIssue({
    number: 13,
    state: 'active',
    checkIn: 'unclaimed',
    label: 'work:active',
  });
  const result = runStatus(t, { gh: ghShim({ issue: { stdout: JSON.stringify([undated]) } }) });

  assert.equal(result.exitCode, 2);
  assert.match(
    result.stdout,
    /ASK MAINTAINER: #13 check-in unknown; do not take over or clean automatically/,
  );
});

test('the command takes no arguments and ignores anything passed to it', (t) => {
  const baseline = runStatus(t);
  const withArguments = runStatus(t, { args: ['--json', '--help', 'unexpected'] });

  assert.equal(withArguments.exitCode, baseline.exitCode);
  assert.equal(withArguments.stdout, baseline.stdout);
  assert.equal(withArguments.stderr, '');
});

// KNOWN GAP, reported to the maintainer rather than changed here: the board only shows issues
// carrying a work:* label. An open issue that holds claim fields but lost its label is invisible,
// and the run still exits 0. This test pins the current behavior so the gap stays visible; the
// missing-label warning above only fires when the labels are absent from the repository itself.
test('an issue holding claim fields but no work:* label is currently invisible to the board', (t) => {
  const claim = claimIssue({
    number: 14,
    state: 'active',
    checkIn: FAR_FUTURE,
    label: 'work:active',
  });
  const unlabeled = { ...claim, labels: [{ name: 'area:foundation' }] };
  const result = runStatus(t, { gh: ghShim({ issue: { stdout: JSON.stringify([unlabeled]) } }) });

  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /#14/);
  assert.match(result.stdout, /## Open work claims\nnone/);
});
