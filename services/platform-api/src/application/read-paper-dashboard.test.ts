// The three reads, and above all what they answer when the record is not there.
//
// Provider-free: the port is a double. The fixtures come from the domain tests, so
// one synthetic record serves the whole stack and no figure is written twice.

import { describe, expect, it, vi } from 'vitest';

import { syntheticBudgetRow, syntheticOpenExecution } from '../domain/read-paper-budget.test.js';
import {
  syntheticPerformanceRow,
  syntheticStoredPerformance,
} from '../domain/read-paper-performance.test.js';
import type { PaperProjectionPort } from '../domain/paper-projection.js';
import {
  createGetPaperBudget,
  createGetPaperPerformance,
  createGetPaperPerformanceSummary,
} from './read-paper-dashboard.js';

/** What the adapter throws, reproduced structurally so no adapter is imported. */
function portFailure(code: string): Error {
  return Object.assign(new Error('A projection read did not complete.'), {
    code,
    name: 'ProjectionFailure',
  });
}

function port(overrides: Partial<PaperProjectionPort> = {}): PaperProjectionPort {
  return {
    close: async () => undefined,
    probePrivileges: async () => ({
      attributes: {
        bypassRowLevelSecurity: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        superuser: false,
      },
      grants: [],
    }),
    readBudget: async () => syntheticBudgetRow,
    readExecutions: async () => [syntheticOpenExecution],
    readLongShot: async () => null,
    readPerformance: async () => syntheticPerformanceRow(),
    ...overrides,
  };
}

describe('createGetPaperBudget', () => {
  it('publishes the budget and its executions', async () => {
    const outcome = await createGetPaperBudget({ projection: port() })();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.availableCents).toBe(85);
    expect(outcome.value.recentExecutions).toHaveLength(1);
  });

  it('asks for exactly the bound the published contract declares', async () => {
    const readExecutions = vi.fn(async () => [syntheticOpenExecution]);
    await createGetPaperBudget({ projection: port({ readExecutions }) })();

    expect(readExecutions).toHaveBeenCalledWith(30);
  });

  it('reports a missing row as unpublished rather than as a zero balance', async () => {
    const readExecutions = vi.fn(async () => []);
    const outcome = await createGetPaperBudget({
      projection: port({ readBudget: async () => null, readExecutions }),
    })();

    expect(outcome).toEqual({ failure: 'not-published', ok: false });
    // And the second read is never issued: there is no budget to attach rows to.
    expect(readExecutions).not.toHaveBeenCalled();
  });

  it('treats a failed execution read as the whole read failing', async () => {
    // Half a budget is not a budget. The source replaces both tables together, so a
    // budget row with its execution list silently missing would misreport the record.
    const outcome = await createGetPaperBudget({
      projection: port({
        readExecutions: async () => {
          throw portFailure('projection-query-failed');
        },
      }),
    })();

    expect(outcome).toEqual({ failure: 'unreachable', ok: false });
  });

  it('reports an unreadable row as invalid, naming the field and never its value', async () => {
    const outcome = await createGetPaperBudget({
      projection: port({
        readBudget: async () => ({ ...syntheticBudgetRow, realizedPnlCents: 'minus three' }),
      }),
    })();

    expect(outcome).toEqual({ detail: 'realizedPnlCents', failure: 'invalid', ok: false });
  });

  it('reports a row the adapter itself could not read as invalid', async () => {
    const outcome = await createGetPaperBudget({
      projection: port({
        readBudget: async () => {
          throw portFailure('projection-unexpected-shape');
        },
      }),
    })();

    expect(outcome).toEqual({ detail: 'the stored record', failure: 'invalid', ok: false });
  });

  it('reports an unconfigured projection as unreachable, without calling anything', async () => {
    expect(await createGetPaperBudget({ projection: null })()).toEqual({
      failure: 'unreachable',
      ok: false,
    });
  });

  it('refuses to classify an unknown throw as a readable record', async () => {
    // Not a port failure at all. Whatever it was, it is not evidence that the
    // record is published and readable.
    const outcome = await createGetPaperBudget({
      projection: port({
        readBudget: async () => {
          throw new Error('connect ECONNREFUSED db.example.invalid:5432');
        },
      }),
    })();

    expect(outcome).toEqual({ failure: 'unreachable', ok: false });
    expect(JSON.stringify(outcome)).not.toContain('db.example.invalid');
  });
});

describe('createGetPaperPerformanceSummary', () => {
  it('publishes the bounded summary', async () => {
    const outcome = await createGetPaperPerformanceSummary({ projection: port() })();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.generatedAt).toBe('2026-10-05T06:09:00.000Z');
    expect(outcome.value.summary.issued).toBe(4);
  });

  it('reports a missing row as unpublished rather than as an empty record', async () => {
    expect(
      await createGetPaperPerformanceSummary({
        projection: port({ readPerformance: async () => null }),
      })(),
    ).toEqual({ failure: 'not-published', ok: false });
  });

  it('reports an unreadable summary as invalid, naming the field path', async () => {
    const payload = syntheticStoredPerformance();
    const homepage = payload.homepage as Record<string, unknown>;
    payload.homepage = { ...homepage, summary: { ...(homepage.summary as object), issued: null } };
    const outcome = await createGetPaperPerformanceSummary({
      projection: port({ readPerformance: async () => syntheticPerformanceRow(payload) }),
    })();

    expect(outcome).toEqual({
      detail: 'payload.homepage.summary.issued',
      failure: 'invalid',
      ok: false,
    });
  });

  it('reports an unreachable read as unreachable', async () => {
    const outcome = await createGetPaperPerformanceSummary({
      projection: port({
        readPerformance: async () => {
          throw portFailure('projection-unavailable');
        },
      }),
    })();

    expect(outcome).toEqual({ failure: 'unreachable', ok: false });
  });

  it('reports an unconfigured projection as unreachable', async () => {
    expect(await createGetPaperPerformanceSummary({ projection: null })()).toEqual({
      failure: 'unreachable',
      ok: false,
    });
  });
});

describe('createGetPaperPerformance', () => {
  it('publishes the full record', async () => {
    const outcome = await createGetPaperPerformance({ projection: port() })();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.generatedAt).toBe('2026-10-05T06:00:30.000Z');
    expect(outcome.value.paperRecord.settled).toBe(2);
  });

  it('reports a missing row as unpublished rather than as an empty record', async () => {
    expect(
      await createGetPaperPerformance({
        projection: port({ readPerformance: async () => null }),
      })(),
    ).toEqual({ failure: 'not-published', ok: false });
  });

  it('names the field path when the stored document cannot be read', async () => {
    const outcome = await createGetPaperPerformance({
      projection: port({
        readPerformance: async () =>
          syntheticPerformanceRow(syntheticStoredPerformance({ summary: 7 })),
      }),
    })();

    expect(outcome).toEqual({ detail: 'payload.summary', failure: 'invalid', ok: false });
  });

  it('reports an unconfigured projection as unreachable', async () => {
    expect(await createGetPaperPerformance({ projection: null })()).toEqual({
      failure: 'unreachable',
      ok: false,
    });
  });
});
