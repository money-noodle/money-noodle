// What the published-contract exception may and may not do.
//
// The positive and negative cases run the REAL pinned `openapi-changes` binary over
// controlled specification fixtures, so the identities the checker matches on are the
// tool's own output rather than a report this test invented. A handful of cases that
// cannot be produced by the tool — a truncated report, a summary that disagrees with its
// own changes — are fed in directly, which is the point of them.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';

import {
  CONTRACT_PATH,
  EXCEPTIONS_PATH,
  EXCEPTIONS_VERSION,
  RULES_PATH,
  breakingChangesOf,
  classifyChanges,
  loadExceptions,
  resolveSchemaScalar,
} from './check-openapi-compatibility.mjs';
import { readFileSync } from 'node:fs';

const repositoryRoot = process.cwd();
const binary = path.join(repositoryRoot, 'node_modules', '.bin', 'openapi-changes');
const neutralRules = path.join(repositoryRoot, RULES_PATH);

const SPEC = (body) => `openapi: 3.1.0
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
${body}`;

const COMPONENTS = ({ cap = 12, other = 5, extra = '' }) => `components:
  schemas:
    ControlParameters:
      description: Bounded scalar parameters for a control.
      type: object
${cap === null ? '' : `      maxProperties: ${cap}\n`}      additionalProperties:
        type: string
    Other:
      type: object
      maxProperties: ${other}
${extra}`;

const APPROVED = {
  approvalSource: '#orbit 1562275489748484137',
  approvedAtIso: '2026-10-21T01:25:02Z',
  approver: 'Rai',
  changeKind: 'modified',
  contract: CONTRACT_PATH,
  id: 'control-parameters-max-properties-12-to-20',
  new: '20',
  original: '12',
  property: 'maxProperties',
  reason: 'Synthetic fixture reason.',
  schemaPath: "$.components.schemas['ControlParameters']",
  type: 'schema',
};

/** The real tool, on two fixture documents, always with the explicit neutral rules. */
const compare = (baselineBody, candidateBody, { cwd, home, withRules = true } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mn-openapi-exception-'));
  const baselinePath = path.join(directory, 'base.yaml');
  const candidatePath = path.join(directory, 'candidate.yaml');
  const baselineText = SPEC(baselineBody);
  const candidateText = SPEC(candidateBody);
  writeFileSync(baselinePath, baselineText);
  writeFileSync(candidatePath, candidateText);
  const result = spawnSync(
    binary,
    [
      'report',
      '--reproducible',
      '--no-logo',
      ...(withRules ? ['-c', neutralRules] : []),
      baselinePath,
      candidatePath,
    ],
    { cwd: cwd ?? directory, encoding: 'utf8', env: { ...process.env, HOME: home ?? directory } },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const enumerated = breakingChangesOf(report);
  assert.ok(enumerated.breaking, JSON.stringify(enumerated.failures));
  return { baselineText, candidateText, enumerated, report };
};

const verdictFor = (baselineBody, candidateBody, records, options) => {
  const { baselineText, candidateText, enumerated } = compare(baselineBody, candidateBody, options);
  return classifyChanges({
    baselineText,
    breaking: enumerated.breaking,
    candidateText,
    records,
  });
};

const rejected = (verdict) => verdict.failures.length > 0 || verdict.blocked.length > 0;

describe('the approved published-contract exception', () => {
  it('accepts exactly the approved 12 -> 20 cap change and nothing else about it', () => {
    const verdict = verdictFor(COMPONENTS({ cap: 12 }), COMPONENTS({ cap: 20 }), [APPROVED]);
    assert.deepEqual(verdict.blocked, []);
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.approved.length, 1);
    assert.equal(verdict.approved[0].id, APPROVED.id);
    assert.deepEqual(verdict.unused, []);
  });

  it('rejects every neighbouring cap change, including the reverse', () => {
    for (const [baseline, candidate] of [
      [12, 21],
      [12, 19],
      [20, 12],
      [20, 21],
      [12, null],
    ])
      assert.ok(
        rejected(
          verdictFor(COMPONENTS({ cap: baseline }), COMPONENTS({ cap: candidate }), [APPROVED]),
        ),
        `${baseline} -> ${candidate} must be rejected`,
      );
  });

  it('rejects the same widening on another component', () => {
    const verdict = verdictFor(
      COMPONENTS({ cap: 12, other: 5 }),
      COMPONENTS({ cap: 12, other: 20 }),
      [APPROVED],
    );
    assert.ok(rejected(verdict));
  });

  it('rejects another constraint on the approved component', () => {
    const verdict = verdictFor(
      COMPONENTS({ cap: 12 }),
      COMPONENTS({ cap: 12 }).replace(
        '      additionalProperties:\n        type: string',
        '      additionalProperties:\n        type: string\n        maxLength: 4',
      ),
      [APPROVED],
    );
    assert.ok(rejected(verdict));
  });

  it('rejects a route removal', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'mn-openapi-route-'));
    const baselinePath = path.join(directory, 'base.yaml');
    const candidatePath = path.join(directory, 'candidate.yaml');
    const baselineText = SPEC(COMPONENTS({ cap: 12 }));
    const candidateText = baselineText.replace(
      /  \/v1\/budgets\{?[\s\S]*?responses:[\s\S]*?ControlParameters'\n/u,
      '  /v1/other: {}\n',
    );
    writeFileSync(baselinePath, baselineText);
    writeFileSync(candidatePath, candidateText);
    const result = spawnSync(
      binary,
      ['report', '--reproducible', '--no-logo', '-c', neutralRules, baselinePath, candidatePath],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const enumerated = breakingChangesOf(JSON.parse(result.stdout));
    assert.ok(enumerated.breaking.length > 0, 'the fixture must contain a breaking change');
    const verdict = classifyChanges({
      baselineText,
      breaking: enumerated.breaking,
      candidateText,
      records: [APPROVED],
    });
    assert.ok(rejected(verdict));
  });

  it('rejects an unrelated breaking change travelling with the approved one', () => {
    const verdict = verdictFor(
      COMPONENTS({ cap: 12, other: 5 }),
      COMPONENTS({ cap: 20, other: 4 }),
      [APPROVED],
    );
    assert.equal(verdict.approved.length, 1);
    assert.ok(verdict.blocked.length > 0, 'the narrowing on Other must stay blocked');
    assert.ok(rejected(verdict));
  });

  it('rejects the approved change when no record exists', () => {
    const verdict = verdictFor(COMPONENTS({ cap: 12 }), COMPONENTS({ cap: 20 }), []);
    assert.deepEqual(verdict.approved, []);
    assert.equal(verdict.blocked.length, 1);
  });

  it('rejects a stale record whose values no longer match the documents', () => {
    const verdict = verdictFor(COMPONENTS({ cap: 13 }), COMPONENTS({ cap: 20 }), [APPROVED]);
    assert.ok(verdict.failures.some((failure) => failure.includes('stale')));
  });

  it('rejects an ambiguous pair of records that both match one change', () => {
    const verdict = verdictFor(COMPONENTS({ cap: 12 }), COMPONENTS({ cap: 20 }), [
      APPROVED,
      { ...APPROVED, id: 'a-second-record-for-the-same-change' },
    ]);
    assert.ok(verdict.failures.some((failure) => failure.includes('matches 2 exception records')));
  });

  it('cannot be turned green by an ambient rules file in the working directory or home', () => {
    const permissive = 'schema:\n  maxProperties:\n    modified: false\n';
    const cwd = mkdtempSync(path.join(tmpdir(), 'mn-openapi-ambient-cwd-'));
    writeFileSync(path.join(cwd, 'changes-rules.yaml'), permissive);
    const home = mkdtempSync(path.join(tmpdir(), 'mn-openapi-ambient-home-'));
    mkdirSync(path.join(home, '.config'));
    writeFileSync(path.join(home, '.config', 'changes-rules.yaml'), permissive);
    // Without the explicit rules the ambient file waives the whole class, which is why
    // the checker never relies on auto-discovery.
    const ambient = compare(COMPONENTS({ cap: 12 }), COMPONENTS({ cap: 20 }), {
      cwd,
      home,
      withRules: false,
    });
    assert.equal(ambient.enumerated.breaking.length, 0);
    // With it, the change is breaking again and the unapproved neighbour stays blocked.
    const explicit = verdictFor(COMPONENTS({ cap: 12 }), COMPONENTS({ cap: 21 }), [APPROVED], {
      cwd,
      home,
    });
    assert.ok(rejected(explicit));
    const approvedUnderAmbient = verdictFor(
      COMPONENTS({ cap: 12 }),
      COMPONENTS({ cap: 20 }),
      [APPROVED],
      { cwd, home },
    );
    assert.equal(approvedUnderAmbient.approved.length, 1);
    assert.deepEqual(approvedUnderAmbient.blocked, []);
  });
});

describe('the exception record file', () => {
  it('accepts the committed record and resolves its values in the real contract', () => {
    const loaded = loadExceptions(readFileSync(path.join(repositoryRoot, EXCEPTIONS_PATH), 'utf8'));
    assert.ok(loaded.records, JSON.stringify(loaded.failures));
    assert.equal(loaded.records.length, 1);
    const record = loaded.records[0];
    assert.equal(record.id, 'control-parameters-max-properties-12-to-20');
    assert.equal(record.new, '20');
    assert.equal(
      resolveSchemaScalar(
        readFileSync(path.join(repositoryRoot, CONTRACT_PATH), 'utf8'),
        'ControlParameters',
        'maxProperties',
      ),
      '20',
    );
  });

  it('rejects malformed, duplicated, foreign and unsupported records', () => {
    const file = (exceptions, version = EXCEPTIONS_VERSION) =>
      JSON.stringify({ exceptions, version });
    const cases = [
      ['not json', '{'],
      ['wrong version', file([APPROVED], 'something-else')],
      ['no array', JSON.stringify({ exceptions: {}, version: EXCEPTIONS_VERSION })],
      ['missing field', file([{ ...APPROVED, reason: undefined }])],
      ['extra field', file([{ ...APPROVED, extra: 'x' }])],
      ['empty field', file([{ ...APPROVED, approver: '' }])],
      ['duplicate id', file([APPROVED, APPROVED])],
      ['foreign contract', file([{ ...APPROVED, contract: 'other.yaml' }])],
      ['unsupported type', file([{ ...APPROVED, type: 'path' }])],
      ['unresolvable path', file([{ ...APPROVED, schemaPath: '$.components' }])],
      ['unsupported kind', file([{ ...APPROVED, changeKind: 'removed' }])],
      ['bad instant', file([{ ...APPROVED, approvedAtIso: 'whenever' }])],
    ];
    for (const [label, text] of cases) {
      const loaded = loadExceptions(text);
      assert.ok(loaded.failures && loaded.failures.length > 0, `${label} must fail closed`);
    }
  });

  it('treats a record that matches nothing as historical, not as a failure', () => {
    const verdict = classifyChanges({
      baselineText: SPEC(COMPONENTS({ cap: 12 })),
      breaking: [],
      candidateText: SPEC(COMPONENTS({ cap: 20 })),
      records: [APPROVED],
    });
    assert.deepEqual(verdict.failures, []);
    assert.deepEqual(verdict.blocked, []);
    assert.deepEqual(verdict.unused, [APPROVED.id]);
  });
});

describe('the report itself', () => {
  it('fails closed on a report that is malformed, truncated or self-inconsistent', () => {
    for (const report of [
      undefined,
      null,
      'text',
      {},
      { changes: {} },
      { changes: [{ path: 'x' }] },
      { changes: [], reportSummary: { components: { breakingChanges: 1 } } },
      { changes: [], reportSummary: 'summary' },
      { changes: [], reportSummary: { components: { breakingChanges: 'one' } } },
    ]) {
      const enumerated = breakingChangesOf(report);
      assert.ok(enumerated.failures && enumerated.failures.length > 0, JSON.stringify(report));
    }
  });

  it('accepts a report whose summary agrees with its enumerated changes', () => {
    const enumerated = breakingChangesOf({
      changes: [{ breaking: true, property: 'maxProperties' }],
      reportSummary: { components: { breakingChanges: 1 } },
    });
    assert.ok(enumerated.breaking);
    assert.equal(enumerated.breaking.length, 1);
  });
});

describe('resolving a scalar from the contract text', () => {
  it('refuses anything it cannot resolve unambiguously', () => {
    const duplicatedSchema = SPEC(
      `components:
  schemas:
    ControlParameters:
      type: object
      maxProperties: 12
    ControlParameters:
      type: object
      maxProperties: 20
`,
    );
    assert.equal(
      resolveSchemaScalar(duplicatedSchema, 'ControlParameters', 'maxProperties'),
      undefined,
    );
    const duplicatedProperty = SPEC(
      `components:
  schemas:
    ControlParameters:
      type: object
      maxProperties: 12
      maxProperties: 20
`,
    );
    assert.equal(
      resolveSchemaScalar(duplicatedProperty, 'ControlParameters', 'maxProperties'),
      undefined,
    );
    assert.equal(
      resolveSchemaScalar(SPEC(COMPONENTS({ cap: 12 })), 'Absent', 'maxProperties'),
      undefined,
    );
    assert.equal(
      resolveSchemaScalar(SPEC(COMPONENTS({ cap: null })), 'ControlParameters', 'maxProperties'),
      undefined,
    );
    assert.equal(
      resolveSchemaScalar(SPEC(COMPONENTS({ cap: 12 })), 'ControlParameters', 'maxProperties'),
      '12',
    );
  });
});
