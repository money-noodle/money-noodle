// The discovery rule, including the cases that must fail.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ReleaseSuiteError,
  assertDiscoveredSuites,
  assertNestedRun,
  discoverReleaseSuites,
  summarizeTap,
} from './suite-discovery.mjs';

function refusal(run) {
  try {
    run();
    return null;
  } catch (error) {
    assert.ok(error instanceof ReleaseSuiteError, `expected a refusal, got ${error}`);
    return error.code;
  }
}

test('discovery finds the nested suites this directory declares', () => {
  const suites = discoverReleaseSuites();
  assert.ok(suites.length >= 2, 'expected several nested release suites');
  assert.ok(suites.some((path) => path.endsWith('/journey/journey.test.mjs')));
  assert.ok(suites.every((path) => path.endsWith('.test.mjs')));
  assertDiscoveredSuites(suites);
});

test('zero discovered tests fails', () => {
  const empty = mkdtempSync(join(tmpdir(), 'release-suite-'));
  mkdirSync(join(empty, 'nested'));
  // A directory with files that are not suites is still an empty suite.
  writeFileSync(join(empty, 'nested', 'helper.mjs'), 'export const x = 1;\n');

  assert.deepEqual(discoverReleaseSuites(empty), []);
  assert.equal(
    refusal(() => assertDiscoveredSuites(discoverReleaseSuites(empty))),
    'no-release-suite',
  );
  assert.equal(
    refusal(() => assertDiscoveredSuites([])),
    'no-release-suite',
  );
  assert.equal(
    refusal(() => assertDiscoveredSuites(undefined)),
    'no-release-suite',
  );
  assert.equal(
    refusal(() => assertDiscoveredSuites(['/elsewhere/tools/other/thing.test.mjs'], '/elsewhere')),
    'foreign-suite',
  );
});

test('a nested run that proved nothing is refused', () => {
  const counts = (output) => summarizeTap(output);
  const ran = '# tests 4\n# pass 4\n# fail 0\n# skipped 0\n';

  assert.deepEqual(counts(ran), { fail: 0, pass: 4, skipped: 0, tests: 4 });
  assert.deepEqual(counts(''), {
    fail: undefined,
    pass: undefined,
    skipped: undefined,
    tests: undefined,
  });

  assert.equal(
    refusal(() => assertNestedRun({ counts: counts(''), journeyEnabled: false, status: 0 })),
    'no-tests-run',
  );
  assert.equal(
    refusal(() =>
      assertNestedRun({
        counts: counts('# tests 0\n# pass 0\n# fail 0\n# skipped 0\n'),
        journeyEnabled: false,
        status: 0,
      }),
    ),
    'no-tests-run',
  );
  assert.equal(
    refusal(() =>
      assertNestedRun({
        counts: counts('# tests 4\n# pass 3\n# fail 1\n# skipped 0\n'),
        journeyEnabled: false,
        status: 1,
      }),
    ),
    'nested-failure',
  );
  // A nonzero exit with clean counters is still a failure: the runner crashed.
  assert.equal(
    refusal(() => assertNestedRun({ counts: counts(ran), journeyEnabled: false, status: 7 })),
    'nested-failure',
  );

  assert.deepEqual(assertNestedRun({ counts: counts(ran), journeyEnabled: false, status: 0 }), {
    fail: 0,
    pass: 4,
    skipped: 0,
    tests: 4,
  });
});

test('an enabled journey that skipped itself fails the gate', () => {
  const skipped = summarizeTap('# tests 14\n# pass 13\n# fail 0\n# skipped 1\n');
  assert.equal(
    refusal(() => assertNestedRun({ counts: skipped, journeyEnabled: true, status: 0 })),
    'journey-skipped',
  );
  // The same run is acceptable when the journey was never enabled.
  assert.ok(assertNestedRun({ counts: skipped, journeyEnabled: false, status: 0 }));

  const solitary = summarizeTap('# tests 1\n# pass 1\n# fail 0\n# skipped 0\n');
  assert.equal(
    refusal(() => assertNestedRun({ counts: solitary, journeyEnabled: true, status: 0 })),
    'journey-empty',
  );
});
