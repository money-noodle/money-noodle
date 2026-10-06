#!/usr/bin/env node

// The live budget has no execution path, asserted over the repository tree.
//
// ADR-0013 §4 says the live budget exists as a record only: "In M4 there is no
// venue credential in Secret Manager, no live wire module, no reconciliation job,
// and no arming path." That is a statement about what the repository does *not*
// contain, so it cannot be proved by a unit test — a unit test can only show that
// one code path behaves, and the claim is that no code path exists at all.
//
// So this walks the tree and asserts absence. It is deliberately a blunt
// instrument: it will fail on a file named for a venue, on a secret container
// declared for one, and on an arming operation in the contract. A real funded
// design will have to delete or rewrite this test, which is the point — removing
// it is a visible act in a reviewed diff rather than a quiet consequence of
// adding a file.
//
// What it does not assert: that the `live` budget accepts controls into intent
// and audit. That half is proved in the service's own tests, where a fake
// recorder can show the row being appended.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.nx',
  '.terraform',
  'coverage',
  'dist',
  'generated',
  'node_modules',
]);

/** Everything a reviewer would consider source, with generated output left out. */
function sourceFiles(directory = repositoryRoot) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    }
    if (!entry.isFile()) return [];
    return statSync(path).size > 2_000_000 ? [] : [path];
  });
}

const files = sourceFiles();
const named = (path) => relative(repositoryRoot, path).split(sep).join('/');

// This test file names every forbidden thing in order to look for it, so it is
// the one file excluded from its own search.
const SELF = 'tools/live-budget-inertness.test.mjs';

test('no live wire, venue or execution module exists anywhere in the tree', () => {
  // Module *names*, not mentions: a document may discuss a venue, and ADR-0013
  // does. What may not exist is a file that is one.
  const forbiddenNames =
    /(live-(wire|execution|order|trade|arm)|venue-(client|credential|adapter|gateway)|place-order|submit-order|arm-live|reconcil\w*-job)/u;

  const offenders = files
    .map(named)
    .filter((path) => path !== SELF)
    .filter((path) => forbiddenNames.test(path));

  assert.deepEqual(
    offenders,
    [],
    `ADR-0013 §4 gives the live budget no execution path in M4. These files look like one: ${offenders.join(', ')}`,
  );
});

test('no venue credential is declared in any stack or in the custody catalog', () => {
  // Secret ids are declared in `infra/stacks/**` and consumed by name. A venue
  // credential would have to appear as one before it could be read.
  const declarations = files.filter(
    (path) => named(path).startsWith('infra/') || named(path).startsWith('tools/delivery/'),
  );

  const venueSecret =
    /["'][a-z0-9-]*(venue|broker|exchange|kalshi|polymarket|kraken)[a-z0-9-]*(api[-_]?key|secret|credential|token|private[-_]?key)[a-z0-9-]*["']/iu;

  for (const path of declarations) {
    if (named(path) === SELF) continue;
    const source = readFileSync(path, 'utf8');
    assert.ok(
      !venueSecret.test(source),
      `${named(path)} declares what looks like a venue credential. ADR-0013 §4: no venue credential exists in M4.`,
    );
  }
});

test('the contract publishes no operation that could arm or execute', () => {
  const contract = readFileSync(
    join(repositoryRoot, 'services/platform-api/openapi/platform-api.v1.yaml'),
    'utf8',
  );
  const operationIds = [...contract.matchAll(/^\s*operationId:\s*(\S+)/gmu)].map(
    (match) => match[1],
  );

  const arming = operationIds.filter((id) =>
    /(arm|execute|placeOrder|submitOrder|withdraw|transfer|fund)/iu.test(id),
  );

  assert.deepEqual(
    arming,
    [],
    `The contract publishes an operation that could reach a funded effect: ${arming.join(', ')}. ADR-0013 §4 keeps the kill switch and live enable outside the UI.`,
  );
});

test('the live budget is still a published budget kind with the same controls', () => {
  // The other half of the claim: inert is not absent. If a future change deleted
  // the live record rather than leaving it inert, these assertions would fail and
  // the three above would still pass.
  const contract = readFileSync(
    join(repositoryRoot, 'services/platform-api/openapi/platform-api.v1.yaml'),
    'utf8',
  );
  assert.match(contract, /enum: \[paper, live\]/u, 'both budget kinds must be published');

  const domain = readFileSync(
    join(repositoryRoot, 'services/platform-api/src/domain/budget-control.ts'),
    'utf8',
  );
  assert.match(
    domain,
    /BUDGET_KINDS = Object\.freeze\(\['paper', 'live'\] as const\)/u,
    'the account must still hold exactly two budget records',
  );
});
