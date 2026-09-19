#!/usr/bin/env node

// Root discovery for the nested release suites.
//
// The accepted test layout is explicit: "Release orchestration and synthetic
// recovery tests live under `tools/release/**`; `tools/release.test.mjs` makes
// the existing repository test command discover and execute the nested suite,
// failing on missing tests or failed checks."
//
// So this file is the attachment point, not the tests. `pnpm verify:foundation`
// already runs `node --test tools/*.test.mjs`, which makes the nested suite part
// of the `affected projects and repository gates` required check without adding
// a required check or renaming one — either of which would detach the release
// qualification gate in `delivery.yml`.
//
// The rules it enforces live in `tools/release/suite-discovery.mjs`, where they
// are themselves tested, including the cases that must fail.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  REPOSITORY_ROOT,
  assertDiscoveredSuites,
  assertNestedRun,
  discoverReleaseSuites,
  summarizeTap,
} from './release/suite-discovery.mjs';

const journeyEnabled = process.env.MONEY_NOODLE_RELEASE_JOURNEY === '1';

test('the nested release suite exists', () => {
  assert.ok(assertDiscoveredSuites(discoverReleaseSuites()).length > 0);
});

test('every nested release check passes', { timeout: journeyEnabled ? 2_700_000 : 300_000 }, () => {
  const suites = assertDiscoveredSuites(discoverReleaseSuites());

  // A child of a test run inherits `NODE_TEST_CONTEXT`, which switches the
  // reporter to the parent's serialized channel and leaves nothing to read.
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-concurrency=1', ...suites],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: childEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Printed unconditionally: the nested run is the evidence, and evidence that
  // only appears on failure cannot be read on the run that succeeded.
  console.log(output);

  assertNestedRun({ counts: summarizeTap(output), journeyEnabled, status: result.status });
});
