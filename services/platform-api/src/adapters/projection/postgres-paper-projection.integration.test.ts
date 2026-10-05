// The adapter against a real PostgreSQL projection.
//
// Skipped unless `PLATFORM_API_PROJECTION_DATABASE_URL` is set, so CI needs no
// database and nothing here can become a hidden requirement of `pnpm check`. It
// is the only test in this service that may touch a network, and it still only
// reads.
//
// Run it against a SELECT-only role on a copy of the projection:
//
//   PLATFORM_API_PROJECTION_DATABASE_URL=… \
//     pnpm exec vitest run --config services/platform-api/vitest.config.ts \
//     services/platform-api/src/adapters/projection
//
// A skipped suite proving nothing is exactly why `describe.skipIf` is used here
// rather than an early `return`: the reason shows in the reporter instead of
// looking like a pass.

import { describe, expect, it } from 'vitest';

import {
  createGetPaperBudget,
  createGetPaperPerformance,
  createGetPaperPerformanceSummary,
} from '../../application/read-paper-dashboard.js';
import { MAX_EXECUTION_ROWS } from '../../domain/paper-projection.js';
import { evaluateProjectionPrivileges } from '../../domain/projection-privileges.js';
import { createPostgresProjectionClient } from './postgres-client.js';
import { createPostgresPaperProjection } from './postgres-paper-projection.js';
import { expectedTableList, readProjectionConfig } from './read-projection-config.js';

const config = readProjectionConfig(process.env);
const configured = config.connectionString !== undefined;

describe.skipIf(!configured)('createPostgresPaperProjection against a real projection', () => {
  const open = () =>
    createPostgresPaperProjection({
      client: createPostgresProjectionClient(config.connectionString as string),
      schema: config.schema,
      tables: config.tables,
    });

  it('probes privileges and finds the role is SELECT-only', async () => {
    const projection = open();
    try {
      const observation = await projection.probePrivileges();
      const verdict = evaluateProjectionPrivileges({
        attributes: observation.attributes,
        expectedTables: expectedTableList(config.tables),
        grants: observation.grants,
      });

      // A failure here is the point of the ticket, not a flaky test: the
      // configured role is not read-only, and the violations say which table and
      // which privilege without naming the role.
      expect(verdict.violations).toEqual([]);
      expect(verdict.selectOnly).toBe(true);
    } finally {
      await projection.close();
    }
  });

  it('reads the singleton rows, or reports honestly that they are absent', async () => {
    const projection = open();
    try {
      // `null` is a real answer: the projection may legitimately have no row yet.
      // Either way the typed readers must not throw on well-formed data.
      const budget = await projection.readBudget();
      if (budget !== null) {
        expect(typeof budget.availableCents).toBe('bigint');
        expect(typeof budget.realizedPnlCents).toBe('string');
        expect(budget.sourceUpdatedAt).toBeInstanceOf(Date);
      }

      for (const payload of [await projection.readPerformance(), await projection.readLongShot()]) {
        if (payload !== null) {
          expect(payload.sourceUpdatedAt).toBeInstanceOf(Date);
        }
      }
    } finally {
      await projection.close();
    }
  });

  it('reads executions within the bound it was asked for', async () => {
    const projection = open();
    try {
      const rows = await projection.readExecutions(5);
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const row of rows) {
        expect(['polymarket', 'kalshi']).toContain(row.venue);
        expect(['UP', 'DOWN']).toContain(row.side);
        expect(typeof row.stakeCents).toBe('string');
      }

      // An unreasonable request is clamped rather than honoured.
      const clamped = await projection.readExecutions(Number.MAX_SAFE_INTEGER);
      expect(clamped.length).toBeLessThanOrEqual(MAX_EXECUTION_ROWS);
    } finally {
      await projection.close();
    }
  });

  it('closes idempotently', async () => {
    const projection = open();
    await projection.close();
    await expect(projection.close()).resolves.toBeUndefined();
  });

  // #210: the published reads against the real stored records. This is the only
  // place the actual document the separate writer produces meets the validation
  // this API applies to it, so a field that changed shape upstream surfaces here as
  // a named path rather than as a 503 in production.
  //
  // A `not-published` outcome is a pass: the projection may legitimately have no
  // row yet. An `invalid` outcome is a real finding and prints the path.
  it.each([
    ['budget', createGetPaperBudget],
    ['performance summary', createGetPaperPerformanceSummary],
    ['full performance record', createGetPaperPerformance],
  ])('reads the published %s, or says honestly that there is none', async (_label, create) => {
    const projection = open();
    try {
      const outcome = await create({ projection })();
      if (!outcome.ok) {
        expect(outcome.failure, `detail: ${outcome.detail ?? 'none'}`).toBe('not-published');
        return;
      }

      // Published source times are the source's, normalized, and never this
      // process's clock. A record stamped in the future would mean the opposite.
      const published = outcome.value as { readonly sourceUpdatedAt: string };
      expect(Number.isNaN(Date.parse(published.sourceUpdatedAt))).toBe(false);
      expect(Date.parse(published.sourceUpdatedAt)).toBeLessThanOrEqual(Date.now() + 60_000);
    } finally {
      await projection.close();
    }
  });
});
