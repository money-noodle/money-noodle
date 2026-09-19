// Discovery for the nested release suites.
//
// Separate from `tools/release.test.mjs` so the discovery rule itself can be
// tested: "fails on missing tests" is the behaviour the accepted layout asks
// for, and a rule that is only exercised by the happy path is not a rule.

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = dirname(dirname(RELEASE_DIRECTORY));

/** Every `*.test.mjs` under `tools/release/**`, discovered rather than listed. */
export function discoverReleaseSuites(root = RELEASE_DIRECTORY) {
  const found = [];
  const walk = (directory) => {
    let items;
    try {
      items = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && item.name.endsWith('.test.mjs')) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

export class ReleaseSuiteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseSuiteError';
    this.code = code;
  }
}

/**
 * Refuses an empty release suite.
 *
 * A gate that discovered nothing reports success because it asked nothing,
 * which is strictly worse than having no gate: it looks like evidence.
 */
export function assertDiscoveredSuites(suites, root = REPOSITORY_ROOT) {
  if (!Array.isArray(suites) || suites.length === 0) {
    throw new ReleaseSuiteError(
      'no-release-suite',
      'tools/release/** declares no *.test.mjs suite; a release gate that discovers nothing proves nothing.',
    );
  }
  for (const suite of suites) {
    const within = relative(root, suite).split('\\').join('/');
    if (!within.startsWith('tools/release/')) {
      throw new ReleaseSuiteError('foreign-suite', `${within} is not a release suite.`);
    }
  }
  return suites;
}

/** The counters a `node --test` TAP run reported, as numbers or `undefined`. */
export function summarizeTap(output) {
  const counter = (name) => {
    const value = String(output).match(new RegExp(`^# ${name} (\\d+)$`, 'mu'))?.[1];
    return value === undefined ? undefined : Number(value);
  };
  return {
    fail: counter('fail'),
    pass: counter('pass'),
    skipped: counter('skipped'),
    tests: counter('tests'),
  };
}

/**
 * Refuses a nested run that did not actually prove anything.
 *
 * `journeyEnabled` is the case that matters: a conditional suite's real failure
 * mode is to stop running while continuing to report success.
 */
export function assertNestedRun({ counts, journeyEnabled, status }) {
  if (counts.tests === undefined || counts.tests === 0) {
    throw new ReleaseSuiteError('no-tests-run', 'The nested release run discovered no tests.');
  }
  if (status !== 0 || counts.fail !== 0) {
    throw new ReleaseSuiteError('nested-failure', 'A nested release check failed.');
  }
  if (journeyEnabled) {
    if (counts.skipped !== 0) {
      throw new ReleaseSuiteError(
        'journey-skipped',
        'The packaged release journey was enabled for this run but skipped.',
      );
    }
    if (!(counts.pass > 1)) {
      throw new ReleaseSuiteError(
        'journey-empty',
        'The enabled packaged release journey contributed no passing checks.',
      );
    }
  }
  return counts;
}
