import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildReport,
  main,
  parseDependsOn,
  parseScopePaths,
  parseWorkItem,
  pages,
  readRegistry,
  MAX_PAGES,
  PAGE_SIZE,
  renderReport,
  scopeOverlap,
} from './coordination-status.mjs';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function body({
  scope = 'none',
  dependsOn = 'none',
  agent = 'unclaimed',
  branch = 'none',
  claimedAt = 'none',
} = {}) {
  return [
    `Scope-Paths: ${scope}`,
    `Depends-On: ${dependsOn}`,
    'Dependency-Notes: none',
    `Claim-Agent: ${agent}`,
    `Claim-Branch: ${branch}`,
    `Claimed-At: ${claimedAt}`,
    'Integration-Owner: money-noodle',
  ].join('\n');
}

const issue = (number, labels, options = {}) => ({
  number,
  state: options.state ?? 'open',
  title: options.title ?? `Work: ${number}`,
  labels,
  body: options.body ?? body(options),
});

const active = (number, options) =>
  issue(number, ['work:active'], {
    agent: options.agent,
    branch: `claim-v1/issue-${number}`,
    claimedAt: options.claimedAt ?? '2026-09-08T09:00:00.000Z',
    scope: options.scope,
  });

test('scope paths accept the three declared forms and reject everything else', () => {
  assert.equal(parseScopePaths('none').status, 'none');
  assert.equal(parseScopePaths('**').status, 'declared');
  assert.equal(parseScopePaths('docs/**, tools/a.mjs').status, 'declared');
  assert.equal(parseScopePaths('tools/b.mjs, tools/a.mjs').status, 'declared', 'order is advisory');
  assert.equal(parseScopePaths('tools/a.mjs, tools/a.mjs').status, 'invalid', 'must be unique');
  assert.equal(parseScopePaths('tools/*.mjs').status, 'invalid', 'no free globs');
  assert.equal(parseScopePaths('/tools/a.mjs').status, 'invalid');
  assert.equal(parseScopePaths('tools/../a.mjs').status, 'invalid');
  assert.equal(parseScopePaths('tools/a.mjs,tools/b.mjs').status, 'declared');
  assert.equal(parseScopePaths(undefined).status, 'missing');
});

test('scope overlap follows prefix containment, not string prefixes', () => {
  const entries = (raw) => parseScopePaths(raw).entries;
  assert.deepEqual(scopeOverlap(entries('tools/a.mjs'), entries('tools/b.mjs')), []);
  assert.deepEqual(scopeOverlap(entries('tools/a.mjs'), entries('tools/**')), [
    'tools/a.mjs',
    'tools/**',
  ]);
  assert.deepEqual(scopeOverlap(entries('docs/**'), entries('docs/architecture/**')), [
    'docs/**',
    'docs/architecture/**',
  ]);
  assert.deepEqual(scopeOverlap(entries('tools/**'), entries('toolsmith/**')), []);
  assert.deepEqual(scopeOverlap(entries('**'), entries('tools/a.mjs')), ['**', 'tools/a.mjs']);
  assert.deepEqual(scopeOverlap(entries('tools/**'), entries('tools')), [], 'dir/** excludes dir');
});

test('Depends-On accepts none or canonical references only', () => {
  assert.deepEqual(parseDependsOn('none'), { status: 'none', numbers: [] });
  assert.deepEqual(parseDependsOn('#12, #13'), { status: 'declared', numbers: [12, 13] });
  assert.equal(parseDependsOn('12, 13').status, 'invalid');
  assert.equal(parseDependsOn('#12,#13').status, 'declared');
  assert.equal(parseDependsOn('see #12').status, 'invalid');
});

test('ready lists only work:ready issues whose dependencies are all closed', () => {
  const report = buildReport({
    issues: [
      issue(10, ['work:done'], { state: 'closed' }),
      issue(11, ['work:ready'], { state: 'open' }),
      issue(20, ['work:ready'], { dependsOn: '#10' }),
      issue(21, ['work:ready'], { dependsOn: '#11' }),
      issue(22, ['work:ready'], { dependsOn: '#10, #11' }),
      issue(23, ['work:proposed'], { dependsOn: '#10' }),
    ],
    claimBranches: [],
    now: NOW,
  });

  assert.deepEqual(
    report.ready.map((entry) => entry.number),
    [11, 20],
  );
  assert.deepEqual(
    report.blocked.map((entry) => [entry.number, entry.blockedBy]),
    [
      [21, [11]],
      [22, [11]],
    ],
  );
  assert.deepEqual(
    report.proposed.map((entry) => entry.number),
    [23],
  );
  assert.equal(report.warnings.length, 0);
});

test('an unknown dependency blocks the item and is warned about', () => {
  const report = buildReport({
    issues: [issue(30, ['work:ready'], { dependsOn: '#999' })],
    claimBranches: [],
    now: NOW,
  });
  assert.deepEqual(report.ready, []);
  assert.deepEqual(report.blocked[0].blockedBy, [999]);
  assert.match(report.warnings.join('\n'), /#30: Depends-On names #999/);
});

test('two active claims with intersecting declared scope are reported as an overlap', () => {
  const report = buildReport({
    issues: [
      active(40, { agent: 'noodle-1', scope: 'docs/**' }),
      active(41, { agent: 'noodle-2', scope: 'docs/architecture/overview.md' }),
      active(42, { agent: 'noodle-3', scope: 'tools/a.mjs' }),
    ],
    claimBranches: ['claim-v1/issue-40', 'claim-v1/issue-41', 'claim-v1/issue-42'],
    now: NOW,
  });

  assert.equal(report.overlaps.length, 1);
  assert.deepEqual(report.overlaps[0].issues, [40, 41]);
  assert.deepEqual(report.overlaps[0].paths, ['docs/**', 'docs/architecture/overview.md']);
  assert.equal(report.warnings.length, 0, 'an overlap is a warning row, not a failure');
  assert.match(renderReport(report), /#40 and #41 both declare/);
});

test('claim refs and active issues are reconciled in both directions', () => {
  const report = buildReport({
    issues: [active(50, { agent: 'noodle-1', scope: 'tools/a.mjs' }), issue(51, ['work:ready'])],
    claimBranches: ['claim-v1/issue-52', 'claim-v1/issue-50', 'not-a-claim'],
    now: NOW,
  });
  const warnings = report.warnings.join('\n');
  assert.match(warnings, /claim-v1\/issue-52 exists but issue #52 is unknown/);
  assert.doesNotMatch(warnings, /#50 is active but/);
  assert.match(warnings, /not-a-claim: unrecognized reserved ref/);
});

test('a claim older than three days is warned about but never released', () => {
  const report = buildReport({
    issues: [active(60, { agent: 'noodle-1', claimedAt: '2026-09-01T12:00:00.000Z' })],
    claimBranches: ['claim-v1/issue-60'],
    now: NOW,
  });
  assert.equal(report.active[0].ageDays, 7);
  assert.match(report.warnings.join('\n'), /#60: claimed 7 days ago by noodle-1/);
  assert.deepEqual(
    report.active.map((entry) => entry.number),
    [60],
    'a stale claim stays active on the board',
  );
});

test('a malformed body is reported without crashing and the issue still appears', () => {
  const report = buildReport({
    issues: [
      {
        number: 70,
        state: 'open',
        title: 'Work: broken',
        labels: ['work:active'],
        body: 'garbage',
      },
      { number: 71, state: 'open', title: 'Work: none', labels: ['work:ready'] },
      {
        number: 72,
        state: 'open',
        title: 'Work: bad scope',
        labels: ['work:ready'],
        body: body({ scope: 'tools/*.mjs', dependsOn: 'later' }),
      },
    ],
    claimBranches: ['claim-v1/issue-70'],
    now: NOW,
  });

  const warnings = report.warnings.join('\n');
  assert.match(warnings, /#70: Scope-Paths is absent/);
  assert.match(warnings, /#70: Claimed-At is not an ISO instant/);
  assert.match(warnings, /#71: Depends-On is absent/);
  assert.match(warnings, /#72: Scope-Paths is malformed/);
  assert.match(warnings, /#72: Depends-On is malformed/);
  assert.deepEqual(
    report.active.map((entry) => entry.number),
    [70],
  );
  assert.equal(report.active[0].ageDays, null);
  assert.doesNotThrow(() => renderReport(report));
});

test('closed retained refs are historical, and done work stays visible', () => {
  const report = buildReport({
    issues: [
      issue(80, ['work:done'], { state: 'closed' }),
      issue(81, ['work:active'], { state: 'closed' }),
    ],
    claimBranches: ['claim-v1/issue-80', 'claim-v1/issue-81'],
    now: NOW,
  });
  assert.deepEqual(report.active, []);
  assert.deepEqual(report.ready, []);
  assert.deepEqual(report.proposed, []);
  assert.deepEqual(
    report.done.map((entry) => entry.number),
    [80],
  );
  assert.equal(report.warnings.length, 0);
});

test('rendered output is bounded and stays far below the default subprocess buffer', () => {
  const issues = [];
  const claimBranches = [];
  for (let number = 100; number < 700; number += 1) {
    issues.push(active(number, { agent: `noodle-${number}`, scope: `services/svc-${number}/**` }));
    claimBranches.push(`claim-v1/issue-${number}`);
  }
  const report = buildReport({ issues, claimBranches, now: NOW });
  assert.equal(report.active.length, 600);

  const rendered = renderReport(report);
  assert.match(rendered, /… and 560 more/);
  assert.ok(
    Buffer.byteLength(rendered) < 1024 * 1024,
    `rendered board was ${Buffer.byteLength(rendered)} bytes`,
  );
});

test('the CLI prints JSON on request and refuses unknown arguments', () => {
  const chunks = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => chunks.push(String(chunk));
  const errors = [];
  const writeError = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => errors.push(String(chunk));
  try {
    const read = () => ({
      issues: [issue(90, ['work:ready'])],
      claimBranches: [],
    });
    assert.equal(main(['--json'], read), 0);
    assert.equal(main(['--gate=claim:90'], read), 2);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeError;
  }
  const report = JSON.parse(chunks.join(''));
  assert.deepEqual(
    report.ready.map((entry) => entry.number),
    [90],
  );
  assert.match(errors.join(''), /unknown argument --gate=claim:90/);
});

test('work item parsing keeps the declared fields verbatim', () => {
  const item = parseWorkItem(
    issue(95, ['work:active', 'area:tools'], {
      scope: 'tools/a.mjs, tools/b.mjs',
      dependsOn: '#12, #13',
      agent: 'noodle-1',
      branch: 'claim-v1/issue-95',
      claimedAt: '2026-09-08T09:00:00.000Z',
    }),
  );
  assert.equal(item.state, 'active');
  assert.equal(item.agent, 'noodle-1');
  assert.equal(item.branch, 'claim-v1/issue-95');
  assert.deepEqual(item.scopePaths, ['tools/a.mjs', 'tools/b.mjs']);
  assert.deepEqual(item.dependsOn, [12, 13]);
  assert.deepEqual(item.warnings, []);
});

test('blocked, review, shared plans and contradictory labels all stay visible', () => {
  const report = buildReport({
    issues: [
      issue(1, ['work:blocked']),
      { ...active(2, { agent: 'reviewer', scope: 'tools/**' }), labels: ['work:review'] },
      active(3, { agent: 'worker', scope: 'tools/file.mjs' }),
      issue(4, ['work:plan', 'work:ready'], { body: '### Integration-Owner\n\nplanner\n' }),
      issue(5, ['work:ready', 'work:review']),
    ],
    claimBranches: ['claim-v1/issue-2', 'claim-v1/issue-3'],
    now: NOW,
  });
  assert.deepEqual(
    report.blocked.map((row) => row.number),
    [1],
  );
  assert.deepEqual(
    report.review.map((row) => row.number),
    [2],
  );
  assert.deepEqual(
    report.plans.map((row) => row.number),
    [4],
  );
  assert.deepEqual(
    report.unknown.map((row) => row.number),
    [5],
  );
  assert.deepEqual(report.ready, []);
  assert.deepEqual(report.overlaps[0].issues, [2, 3]);
  assert.match(renderReport(report), /explicit work:blocked/);
  assert.match(renderReport(report), /Review/);
  assert.match(renderReport(report), /Shared plans/);
});

test('missing, duplicate, malformed, cyclic and abandoned prerequisites never become ready', () => {
  const report = buildReport({
    issues: [
      issue(1, ['work:ready'], { body: body().replace('Depends-On: none', '') }),
      issue(2, ['work:ready'], { body: body() + '\nDepends-On: none' }),
      issue(3, ['work:ready'], { dependsOn: '#9, #9' }),
      issue(4, ['work:ready'], { dependsOn: '#4' }),
      issue(5, ['work:ready'], { dependsOn: '#6' }),
      issue(6, ['work:done'], { state: 'closed', dependsOn: '#5' }),
      issue(7, ['work:ready'], { dependsOn: '#8' }),
      issue(8, ['work:abandoned'], { state: 'closed' }),
      { ...issue(9, [], { state: 'closed' }), state_reason: 'not_planned' },
      issue(10, ['work:ready'], { dependsOn: '#9' }),
      issue(11, ['work:ready'], { dependsOn: '#99' }),
    ],
    claimBranches: [],
    now: NOW,
  });
  assert.deepEqual(report.ready, []);
  assert.equal(report.blocked.length, 8);
  assert.match(report.warnings.join('\n'), /duplicated/);
  assert.match(report.warnings.join('\n'), /cycle or self-reference/);
  assert.match(report.warnings.join('\n'), /not known delivered/);
});

test('a live old-namespace ref reserves an otherwise ready issue with incomplete bookkeeping', () => {
  const report = buildReport({
    issues: [issue(1, ['work:ready'])],
    claimBranches: ['claim-v1/issue-1'],
    now: NOW,
  });
  assert.deepEqual(report.ready, []);
  assert.equal(report.blocked[0].reserved, true);
  assert.match(report.warnings.join('\n'), /finish by hand, do not reclaim/);
});

test('GitHub form output supports multiline declarations and nested colon metadata', () => {
  const item = parseWorkItem(
    issue(1, ['work:ready'], {
      body: [
        '### Scope-Paths',
        '',
        'tools/z.mjs',
        'docs/**',
        '',
        '### Depends-On',
        '',
        '#2',
        '#3',
        '',
        '### Ownership',
        '',
        'Claim-Agent: unclaimed',
        'Claim-Branch: unclaimed',
        'Claimed-At: unclaimed',
        '',
        '### Integration-Owner',
        '',
        'planner',
        '',
        '### Parent-Plan',
        '',
        '#4',
        '',
        '### Dependency-Notes',
        '',
        'First paragraph.',
        '',
        'Second paragraph.',
      ].join('\n'),
    }),
  );
  assert.deepEqual(item.scopePaths, ['tools/z.mjs', 'docs/**']);
  assert.deepEqual(item.dependsOn, [2, 3]);
  assert.equal(item.agent, 'unclaimed');
  assert.equal(item.integrationOwner, 'planner');
  assert.equal(item.parentPlan, '#4');
  assert.equal(item.dependencyNotes, 'First paragraph.\n\nSecond paragraph.');
  assert.deepEqual(item.warnings, []);
});

test('pagination reads every page and fails on malformed, failed or over-limit reads', () => {
  const calls = [];
  const rows = pages('repos/example/issues?state=all', (args) => {
    calls.push(args);
    return calls.length === 1 ? Array.from({ length: PAGE_SIZE }, (_, number) => number) : [100];
  });
  assert.equal(rows.length, 101);
  assert.match(calls[1][1], /&per_page=100&page=2$/);
  assert.throws(() => pages('endpoint', () => ({})), /array/);
  assert.throws(
    () =>
      pages('endpoint', () => {
        throw new Error('unavailable');
      }),
    /unavailable/,
  );
  let count = 0;
  assert.throws(
    () =>
      pages('endpoint', () => {
        count++;
        return Array(PAGE_SIZE).fill({});
      }),
    /exceeded/,
  );
  assert.equal(count, MAX_PAGES);
});

test('registry adapter reads only issues and reserved refs, rejecting structural host defects', () => {
  const calls = [];
  const read = (args) => {
    calls.push(args);
    if (args[1].includes('/issues?'))
      return [{ ...issue(1, ['work:ready']), labels: [{ name: 'work:ready' }] }];
    return [
      { ref: 'refs/heads/claim-v1/issue-1', object: { type: 'commit', sha: 'a'.repeat(40) } },
    ];
  };
  const registry = readRegistry('repos/example', read);
  assert.deepEqual(registry.claimBranches, ['claim-v1/issue-1']);
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(([command, endpoint]) => command === 'api' && !endpoint.includes('/comments')),
  );
  assert.throws(() => readRegistry('repos/example', () => [{ number: 1 }]), /malformed issue/);
  assert.throws(
    () => readRegistry('repos/example', (args) => (args[1].includes('/issues?') ? [] : [{}])),
    /malformed claim ref/,
  );
});

test('required read failures emit unknown JSON, never an empty board, and exit nonzero', () => {
  const chunks = [],
    errors = [];
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  process.stdout.write = (chunk) => chunks.push(String(chunk));
  process.stderr.write = (chunk) => errors.push(String(chunk));
  try {
    assert.equal(
      main(['--json'], () => {
        throw new Error('host offline');
      }),
      1,
    );
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const result = JSON.parse(chunks.join(''));
  assert.equal(result.coordinationKnown, false);
  assert.equal(result.ready, undefined);
  assert.match(errors.join(''), /Coordination unknown/);
  assert.throws(
    () => buildReport({ issues: [issue(1, []), issue(1, [])], claimBranches: [] }),
    /duplicate issue/,
  );
});

test('minimal form fields are ready with maintainer default, while partial metadata is not unclaimed', () => {
  const minimal =
    '### Outcome\n\nExample.\n\n### Scope-Paths\n\ntools/example.mjs\n\n### Depends-On\n\nnone\n\n### Acceptance checks\n\nTests pass.\n';
  const report = buildReport({
    issues: [
      issue(1, ['work:ready'], { body: minimal }),
      issue(2, ['work:ready'], { body: minimal + '\nClaim-Agent: unclaimed' }),
      issue(3, ['work:ready'], { body: minimal }),
      issue(4, ['work:plan', 'work:proposed'], {
        body: '### Outcome and acceptance\n\nExample.\n\n### Work graph\n\n#1 precedes #2.',
      }),
    ],
    claimBranches: ['claim-v1/issue-3'],
    now: NOW,
  });
  assert.deepEqual(
    report.ready.map((row) => row.number),
    [1],
  );
  assert.equal(report.ready[0].integrationOwner, 'maintainer');
  assert.deepEqual(report.ready[0].warnings, []);
  assert.deepEqual(
    report.blocked.map((row) => row.number),
    [2, 3],
  );
  assert.equal(report.plans[0].integrationOwner, 'maintainer');
});

test('status CLI reads pages over the default process buffer with mocked read-only gh and fails closed on bad JSON', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mn-board-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'requests.jsonl');
  writeFileSync(
    join(directory, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
if (process.env.MOCK_MODE === 'bad-json') { process.stdout.write('{'); }
else if (process.env.MOCK_MODE === 'offline') { process.stderr.write('host unavailable'); process.exitCode = 1; }
else if (args[0] !== 'api' || args.length !== 2) { process.stderr.write('non-read request'); process.exitCode = 9; }
else if (args[1].includes('/issues?') && args[1].endsWith('page=1')) {
  const rows = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, state: 'open', title: 'Work', labels: [{ name: 'work:ready' }], body: 'Scope-Paths: none\\nDepends-On: none\\n' + 'x'.repeat(20000) }));
  process.stdout.write(JSON.stringify(rows));
} else { process.stdout.write('[]'); }
`,
    { mode: 0o755 },
  );
  for (const mode of ['ok', 'bad-json', 'offline']) {
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['tools/coordination-status.mjs', '--json'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: directory, MOCK_LOG: log, MOCK_MODE: mode },
    });
    assert.equal(result.status, mode === 'ok' ? 0 : 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.coordinationKnown, mode === 'ok');
    if (mode === 'ok') {
      assert.equal(report.ready.length, 100);
      const requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(requests.length, 3);
      assert.match(requests[1][1], /page=2$/);
      assert.ok(requests.every((args) => args[0] === 'api' && args.length === 2));
    } else assert.match(result.stderr, /Coordination unknown/);
  }
});

test('unknown work labels are not a ready state or delivered prerequisite, and huge fields stay bounded in human output', () => {
  const report = buildReport({
    issues: [
      issue(1, ['work:ready', 'work:unexpected']),
      issue(2, ['work:unexpected'], { state: 'closed' }),
      issue(3, ['work:ready'], { dependsOn: '#2' }),
      active(4, { agent: 'x'.repeat(2 * 1024 * 1024), scope: 'none' }),
    ],
    claimBranches: ['claim-v1/issue-4'],
    now: NOW,
  });
  assert.deepEqual(report.ready, []);
  assert.deepEqual(
    report.unknown.map((row) => row.number),
    [1],
  );
  assert.deepEqual(report.blocked[0].blockedBy, [2]);
  assert.ok(Buffer.byteLength(renderReport(report)) < 10_000);
});
