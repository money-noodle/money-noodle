// What the published-contract exception may and may not do.
//
// The cases that matter run the ACTUAL checker entrypoint — `node
// tools/check-openapi-compatibility.mjs` — inside a controlled repository root, against
// the real pinned `openapi-changes` binary, and assert its final exit status and output.
// A second group replaces only the binary inside the fixture root with a stub that prints
// a chosen payload or fails, which is how the tool-error and malformed-envelope paths are
// reached without a flag, an override or any change to production source.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';

import {
  APPROVED_EXCEPTIONS,
  CONTRACT_PATH,
  EXCEPTIONS_PATH,
  EXCEPTIONS_VERSION,
  NO_CHANGE_MESSAGE,
  RULES_PATH,
  classifyChanges,
  loadExceptions,
  parseReport,
  resolveSchemaScalar,
} from './check-openapi-compatibility.mjs';

const repositoryRoot = process.cwd();
const CHECKER = 'tools/check-openapi-compatibility.mjs';
const APPROVED = Object.freeze({
  ...APPROVED_EXCEPTIONS[0],
  reason: 'Synthetic fixture reason; the identity above is the approved one.',
});

const SPEC = (
  cap,
  { description = 'Bounded scalar parameters for a control.', other = 5 } = {},
) => `openapi: 3.1.0
info:
  title: fixture
  version: '1'
paths:
  /v1/budgets/{kind}/controls:
    post:
      operationId: recordControl
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ControlParameters'
components:
  schemas:
    ControlParameters:
      description: ${description}
      type: object
${cap === null ? '' : `      maxProperties: ${cap}\n`}      additionalProperties:
        type: string
    Other:
      type: object
      maxProperties: ${other}
`;

const exceptionsFile = (exceptions, version = EXCEPTIONS_VERSION) =>
  `${JSON.stringify({ exceptions, version }, undefined, 2)}\n`;

/**
 * A repository root the checker can run in: its own git history for the baseline, its own
 * copy of the checker and the neutral rules, its own contract and exception file, and
 * either the real pinned binary or a stub in its own `node_modules/.bin`.
 */
const fixtureRoot = ({ baseline, candidate, exceptions = [APPROVED], stub }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'mn-openapi-root-'));
  mkdirSync(path.join(root, 'tools'), { recursive: true });
  mkdirSync(path.join(root, path.dirname(CONTRACT_PATH)), { recursive: true });
  cpSync(path.join(repositoryRoot, CHECKER), path.join(root, CHECKER));
  cpSync(path.join(repositoryRoot, RULES_PATH), path.join(root, RULES_PATH));
  writeFileSync(path.join(root, CONTRACT_PATH), baseline);
  writeFileSync(path.join(root, EXCEPTIONS_PATH), exceptionsFile(exceptions));
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.email=fixture@invalid', '-c', 'user.name=fixture', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  assert.equal(git('init', '--quiet').status, 0);
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '--quiet', '-m', 'baseline').status, 0);
  // The candidate is the working tree; the baseline stays in the commit.
  writeFileSync(path.join(root, CONTRACT_PATH), candidate);
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  const binary = path.join(root, 'node_modules', '.bin', 'openapi-changes');
  if (stub === undefined)
    symlinkSync(path.join(repositoryRoot, 'node_modules', '.bin', 'openapi-changes'), binary);
  else if (stub !== 'missing') {
    writeFileSync(binary, stub);
    chmodSync(binary, 0o755);
  }
  return root;
};

/** The actual CLI, in that root, with the baseline taken from its own first commit. */
const runChecker = (options) => {
  const root = fixtureRoot(options);
  const result = spawnSync(process.execPath, [CHECKER], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NX_BASE: undefined, OPENAPI_BASE_REF: 'HEAD' },
  });
  return { ...result, root, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

/** A stub that prints one payload on stdout and exits 0. */
const printing = (payload) => `#!/bin/sh\ncat <<'PAYLOAD'\n${payload}\nPAYLOAD\n`;

describe('the checker CLI, against the real pinned tool', () => {
  it('passes an unchanged contract that already holds the approved value', () => {
    const run = runChecker({ baseline: SPEC(20), candidate: SPEC(20) });
    assert.equal(run.status, 0, run.text);
    assert.match(run.stdout, /the contract is unchanged/u);
    assert.match(run.stdout, /is historical: its approved value is already the baseline/u);
  });

  it('passes a harmless description change after the approved value merged', () => {
    const run = runChecker({
      baseline: SPEC(20),
      candidate: SPEC(20, { description: 'Reworded, no bound moved.' }),
    });
    assert.equal(run.status, 0, run.text);
    assert.match(run.stdout, /1 change\(s\), 0 breaking/u);
    assert.match(run.stdout, /is historical/u);
  });

  it('passes the approved cap change while it is in flight', () => {
    const run = runChecker({ baseline: SPEC(12), candidate: SPEC(20) });
    assert.equal(run.status, 0, run.text);
    assert.match(
      run.stdout,
      /Accepted one approved exception \(control-parameters-max-properties-12-to-20\)/u,
    );
    assert.match(run.stdout, /1 breaking, 1 approved by exception/u);
  });

  it('rejects every move away from the approved value, and never waives it as historical', () => {
    for (const [label, baseline, candidate] of [
      ['20 -> 21', SPEC(20), SPEC(21)],
      ['20 -> 12', SPEC(20), SPEC(12)],
      ['12 -> 21', SPEC(12), SPEC(21)],
      ['bound removed', SPEC(20), SPEC(null)],
      ['another component narrowed', SPEC(20), SPEC(20, { other: 4 })],
    ]) {
      const run = runChecker({ baseline, candidate });
      assert.equal(run.status, 1, `${label} must be rejected: ${run.text}`);
      assert.doesNotMatch(run.stdout, /Accepted one approved exception/u, label);
    }
  });

  it('rejects an unrelated breaking change travelling with the approved one', () => {
    const run = runChecker({ baseline: SPEC(12), candidate: SPEC(20, { other: 4 }) });
    assert.equal(run.status, 1, run.text);
    assert.match(run.stdout, /Accepted one approved exception/u);
    assert.match(run.stderr, /Rejected breaking change with no approved exception/u);
  });

  it('rejects the approved change when the exception file is empty', () => {
    const run = runChecker({ baseline: SPEC(12), candidate: SPEC(20), exceptions: [] });
    assert.equal(run.status, 1, run.text);
    assert.match(run.stderr, /Rejected breaking change with no approved exception/u);
  });
});

describe('the checker CLI, on unapproved exception identities', () => {
  const cases = [
    ['an unknown id', [{ ...APPROVED, id: 'some-other-exception' }]],
    ['an altered new value', [{ ...APPROVED, new: '21' }]],
    ['an altered original value', [{ ...APPROVED, original: '20' }]],
    ['another component', [{ ...APPROVED, schemaPath: "$.components.schemas['Other']" }]],
    ['another property', [{ ...APPROVED, property: 'maxLength' }]],
    ['another approver', [{ ...APPROVED, approver: 'Someone Else' }]],
    ['another approval source', [{ ...APPROVED, approvalSource: '#orbit 1' }]],
    ['another approval instant', [{ ...APPROVED, approvedAtIso: '2026-10-22T00:00:00Z' }]],
    [
      'the approved record plus an unknown one',
      [APPROVED, { ...APPROVED, id: 'extra', new: '21' }],
    ],
  ];
  for (const [label, exceptions] of cases)
    it(`rejects ${label}, even against matching specifications`, () => {
      // The specifications and the report are made to agree with whatever the record
      // claims, so only the identity check can refuse these.
      const declared = exceptions.at(-1);
      const run = runChecker({
        baseline: SPEC(declared.original === '20' ? 20 : 12),
        candidate: SPEC(declared.new === '21' ? 21 : 20),
        exceptions,
      });
      assert.equal(run.status, 1, `${label} must be rejected: ${run.text}`);
      assert.match(run.stderr, /is not an approved exception|Rejected/u, label);
      assert.doesNotMatch(run.stdout, /Accepted one approved exception \(extra\)/u, label);
    });

  it('rejects an unknown record coexisting with an unrelated breaking change', () => {
    const run = runChecker({
      baseline: SPEC(12),
      candidate: SPEC(20, { other: 4 }),
      exceptions: [{ ...APPROVED, id: 'unknown-door' }],
    });
    assert.equal(run.status, 1, run.text);
    assert.match(run.stderr, /is not an approved exception/u);
  });

  it('rejects a malformed, duplicated or foreign record before any change is matched', () => {
    for (const [label, exceptions, version] of [
      ['missing field', [{ ...APPROVED, reason: undefined }], undefined],
      ['extra field', [{ ...APPROVED, extra: 'x' }], undefined],
      ['empty field', [{ ...APPROVED, reason: '' }], undefined],
      ['duplicate id', [APPROVED, APPROVED], undefined],
      ['foreign contract', [{ ...APPROVED, contract: 'other.yaml' }], undefined],
      ['unsupported type', [{ ...APPROVED, type: 'path' }], undefined],
      ['unsupported kind', [{ ...APPROVED, changeKind: 'removed' }], undefined],
      ['wrong file version', [APPROVED], 'something-else'],
    ]) {
      const root = fixtureRoot({ baseline: SPEC(12), candidate: SPEC(20) });
      writeFileSync(path.join(root, EXCEPTIONS_PATH), exceptionsFile(exceptions, version));
      const run = spawnSync(process.execPath, [CHECKER], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NX_BASE: undefined, OPENAPI_BASE_REF: 'HEAD' },
      });
      assert.equal(run.status, 1, `${label} must be rejected: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /Rejected/u, label);
    }
  });
});

describe('the checker CLI, when the tool misbehaves', () => {
  const stubCases = [
    ['a missing binary', 'missing', /failed to run|Rejected/u],
    ['a non-zero exit', '#!/bin/sh\necho "boom" >&2\nexit 3\n', /exited 3/u],
    ['empty output', '#!/bin/sh\n', /not JSON/u],
    ['truncated JSON', printing('{"changes": [{"breaking": true}'), /not JSON/u],
    ['a bare empty object', printing('{}'), /has no changes/u],
    [
      'an empty change list',
      printing(
        '{"changes": [], "reportSummary": {"components": {"totalChanges": 0, "breakingChanges": 0}}}',
      ),
      /lists no changes/u,
    ],
    [
      'a changes-only report',
      printing('{"changes": [{"breaking": false}]}'),
      /has no reportSummary/u,
    ],
    [
      'a missing breaking count',
      printing(
        '{"changes": [{"breaking": false}], "reportSummary": {"components": {"totalChanges": 1}}}',
      ),
      /non-negative integer change counts/u,
    ],
    [
      'a negative count',
      printing(
        '{"changes": [{"breaking": false}], "reportSummary": {"components": {"totalChanges": -1, "breakingChanges": 0}}}',
      ),
      /non-negative integer change counts/u,
    ],
    [
      'a fractional count',
      printing(
        '{"changes": [{"breaking": false}], "reportSummary": {"components": {"totalChanges": 1.5, "breakingChanges": 0}}}',
      ),
      /non-negative integer change counts/u,
    ],
    [
      'more breaking than total',
      printing(
        '{"changes": [{"breaking": true}], "reportSummary": {"components": {"totalChanges": 1, "breakingChanges": 2}}}',
      ),
      /more breaking changes than changes/u,
    ],
    [
      'a total that disagrees with the list',
      printing(
        '{"changes": [{"breaking": false}], "reportSummary": {"components": {"totalChanges": 2, "breakingChanges": 0}}}',
      ),
      /counts 2 change\(s\) but 1 are enumerated/u,
    ],
    [
      'a breaking count that disagrees with the list',
      printing(
        '{"changes": [{"breaking": false}], "reportSummary": {"components": {"totalChanges": 1, "breakingChanges": 1}}}',
      ),
      /counts 1 breaking change\(s\) but 0 are enumerated/u,
    ],
    [
      'an error envelope',
      printing(
        '{"changes": [], "reportSummary": {"components": {"totalChanges": 2, "breakingChanges": 0}}, "errors": ["incomplete comparison"]}',
      ),
      /unexpected fields: errors/u,
    ],
    ['an unknown envelope', printing('{"status": "partial"}'), /unexpected fields: status/u],
    [
      'an array summary section',
      printing('{"changes": [{"breaking": false}], "reportSummary": {"components": [1]}}'),
      /section components is not an object/u,
    ],
    ['an array where the report belongs', printing('[]'), /not an object/u],
    [
      'a change that is not an object',
      printing(
        '{"changes": ["nope"], "reportSummary": {"components": {"totalChanges": 1, "breakingChanges": 0}}}',
      ),
      /change\[0\] is not an object/u,
    ],
    [
      'a change with no breaking flag',
      printing(
        '{"changes": [{"property": "maxProperties"}], "reportSummary": {"components": {"totalChanges": 1, "breakingChanges": 0}}}',
      ),
      /change\[0\] has no breaking flag/u,
    ],
    [
      'an unrecognised message',
      printing('{"message": "something else"}'),
      /unrecognised compatibility message/u,
    ],
  ];
  for (const [label, stub, pattern] of stubCases)
    it(`rejects ${label}`, () => {
      const run = runChecker({ baseline: SPEC(20), candidate: SPEC(20), stub });
      assert.equal(run.status, 1, `${label} must be rejected: ${run.text}`);
      assert.match(run.text, pattern, label);
    });

  it('accepts exactly the pinned no-change form from the tool', () => {
    const run = runChecker({
      baseline: SPEC(20),
      candidate: SPEC(20),
      stub: printing(JSON.stringify({ message: NO_CHANGE_MESSAGE })),
    });
    assert.equal(run.status, 0, run.text);
    assert.match(run.stdout, /the contract is unchanged/u);
  });

  it('still rejects a no-change claim while an active record expects a transition', () => {
    // The documents say 12 -> 20, so the record is active; a tool that reports nothing
    // cannot make that disappear, and the active-but-unmatched state is reported.
    const run = runChecker({
      baseline: SPEC(12),
      candidate: SPEC(20),
      stub: printing(JSON.stringify({ message: NO_CHANGE_MESSAGE })),
    });
    assert.equal(run.status, 0, run.text);
    assert.match(run.stdout, /is active but matches no change in this comparison/u);
  });
});

describe('the committed exception record', () => {
  it('is the approved identity, and resolves in the real contract', () => {
    const loaded = loadExceptions(readFileSync(path.join(repositoryRoot, EXCEPTIONS_PATH), 'utf8'));
    assert.ok(loaded.records, JSON.stringify(loaded.failures));
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0].id, APPROVED_EXCEPTIONS[0].id);
    assert.equal(APPROVED_EXCEPTIONS.length, 1, 'exactly one exception is approved');
    assert.equal(
      resolveSchemaScalar(
        readFileSync(path.join(repositoryRoot, CONTRACT_PATH), 'utf8'),
        'ControlParameters',
        'maxProperties',
      ),
      '20',
    );
  });

  it('cannot be extended by a file edit alone', () => {
    const loaded = loadExceptions(exceptionsFile([{ ...APPROVED, id: 'a-new-door', new: '21' }]));
    assert.ok(loaded.failures.some((failure) => failure.includes('is not an approved exception')));
  });
});

describe('record lifecycle states', () => {
  const states = (baselineCap, candidateCap) =>
    classifyChanges({
      baselineText: SPEC(baselineCap),
      breaking: [],
      candidateText: SPEC(candidateCap),
      records: [APPROVED],
    });

  it('is active in flight, historical after merge, and stale otherwise', () => {
    assert.deepEqual(states(12, 20).unused, [APPROVED.id]);
    assert.deepEqual(states(12, 20).historical, []);
    assert.deepEqual(states(20, 20).historical, [APPROVED.id]);
    assert.deepEqual(states(20, 20).unused, []);
    assert.deepEqual(states(20, 20).failures, []);
    for (const [baseline, candidate] of [
      [20, 21],
      [20, 12],
      [12, 21],
      [12, 12],
    ])
      assert.ok(
        states(baseline, candidate).failures.some((failure) => failure.includes('stale')),
        `${baseline} -> ${candidate} must be stale`,
      );
  });

  it('never lets a historical record admit a change', () => {
    const verdict = classifyChanges({
      baselineText: SPEC(20),
      breaking: [
        {
          changeText: 'modified',
          new: '21',
          original: '20',
          path: "$.components.schemas['ControlParameters']",
          property: 'maxProperties',
          type: 'schema',
        },
      ],
      candidateText: SPEC(20),
      records: [APPROVED],
    });
    assert.deepEqual(verdict.approved, []);
    assert.equal(verdict.blocked.length, 1);
  });
});

describe('the report envelope, in isolation', () => {
  it('accepts the two forms the pinned tool emits and nothing else', () => {
    assert.equal(parseReport(JSON.stringify({ message: NO_CHANGE_MESSAGE })).kind, 'no-change');
    const normal = parseReport(
      JSON.stringify({
        changes: [{ breaking: true }, { breaking: false }],
        modifiedPath: 'b.yaml',
        originalPath: 'a.yaml',
        reportSummary: { components: { breakingChanges: 1, totalChanges: 2 } },
      }),
    );
    assert.equal(normal.kind, 'report');
    assert.equal(normal.breaking.length, 1);
    for (const text of [
      '',
      '{',
      '[]',
      '{}',
      '{"message":"other"}',
      '{"message":"No changes found between specifications","changes":[]}',
      '{"changes":[]}',
      '{"changes":[{"breaking":false}]}',
      '{"changes":[],"reportSummary":{"components":{"totalChanges":2}}}',
      '{"changes":[],"reportSummary":{"components":{"totalChanges":2,"breakingChanges":0}},"errors":["incomplete"]}',
      '{"changes":[{"breaking":false}],"reportSummary":{}}',
      '{"changes":[{"breaking":false}],"reportSummary":{"components":{"totalChanges":"1","breakingChanges":0}}}',
    ])
      assert.ok(parseReport(text).failures, `must fail closed: ${text}`);
  });
});

describe('resolving a scalar from the contract text', () => {
  it('refuses anything it cannot resolve unambiguously', () => {
    const duplicatedSchema = `openapi: 3.1.0
components:
  schemas:
    ControlParameters:
      maxProperties: 12
    ControlParameters:
      maxProperties: 20
`;
    assert.equal(
      resolveSchemaScalar(duplicatedSchema, 'ControlParameters', 'maxProperties'),
      undefined,
    );
    const duplicatedProperty = `openapi: 3.1.0
components:
  schemas:
    ControlParameters:
      maxProperties: 12
      maxProperties: 20
`;
    assert.equal(
      resolveSchemaScalar(duplicatedProperty, 'ControlParameters', 'maxProperties'),
      undefined,
    );
    assert.equal(resolveSchemaScalar(SPEC(12), 'Absent', 'maxProperties'), undefined);
    assert.equal(resolveSchemaScalar(SPEC(null), 'ControlParameters', 'maxProperties'), undefined);
    assert.equal(resolveSchemaScalar(SPEC(12), 'ControlParameters', 'maxProperties'), '12');
  });
});

describe('ambient rules files', () => {
  it('cannot waive the class, in the working directory or in home, under the real tool', () => {
    const permissive = 'schema:\n  maxProperties:\n    modified: false\n';
    // Each location on its own, so neither result depends on the other being present.
    for (const location of ['cwd', 'home']) {
      const root = fixtureRoot({ baseline: SPEC(20), candidate: SPEC(21) });
      const home = mkdtempSync(path.join(tmpdir(), 'mn-openapi-home-'));
      if (location === 'cwd') writeFileSync(path.join(root, 'changes-rules.yaml'), permissive);
      else {
        mkdirSync(path.join(home, '.config'), { recursive: true });
        writeFileSync(path.join(home, '.config', 'changes-rules.yaml'), permissive);
      }
      const run = spawnSync(process.execPath, [CHECKER], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, NX_BASE: undefined, OPENAPI_BASE_REF: 'HEAD' },
      });
      assert.equal(
        run.status,
        1,
        `an ambient ${location} waiver must not turn 20 -> 21 green: ${run.stdout}${run.stderr}`,
      );
    }
  });
});
