import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * The hosted read is the last gate before a public response, and what it reads was written by whatever
 * worker version happened to be running. These cases pin the behaviour that a withdrawn field stays
 * withdrawn even when an older snapshot still contains it.
 */
describe('hosted projection read', () => {
  const stored = {
    summary: { issued: 4, recent: [] },
    paperRecord: { mode: 'paper', settled: 2 },
    forecasts: [{ id: 'a', symbol: 'BTC' }],
    cyclePaths: { totalCycles: 3 },
    // Published by an older worker, withdrawn from the public surface since.
    modelEvaluations: { runs: [{ recommendedParameters: { basisWeight: 0.65, temperature: 1 } }] },
    liveRecord: { mode: 'live', realizedPnlCents: 9_999 },
  };

  async function read(payload: unknown, sourceUpdatedAt = '2026-08-12T00:00:00.000Z') {
    vi.resetModules();
    // The module memoizes its client on globalThis, which survives resetModules and would otherwise
    // hand every later case the first case's payload.
    delete (globalThis as { __moneyNoodlePostgres?: unknown }).__moneyNoodlePostgres;
    vi.doMock('postgres', () => {
      const query = () => Promise.resolve([{ payload, source_updated_at: sourceUpdatedAt }]);
      const client = Object.assign(query, { json: (v: unknown) => v, unsafe: query, end: () => Promise.resolve() });
      return { default: () => client };
    });
    process.env.MONEY_NOODLE_DATABASE_URL = 'postgres://reader@example.test/db';
    const module = await import('./postgres-paper-projection');
    return module.readPublicPaperPerformanceFromPostgres();
  }

  it('drops fields an older snapshot still carries after they were withdrawn', async () => {
    const result = await read(stored);
    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual(['cyclePaths', 'durable', 'forecasts', 'generatedAt', 'paperRecord', 'summary']);
    const serialized = JSON.stringify(result);
    for (const withdrawn of ['modelEvaluations', 'recommendedParameters', 'basisWeight', 'liveRecord']) {
      expect(serialized).not.toContain(withdrawn);
    }
  });

  it('derives durable and generatedAt from the replication timestamp, not the stored copy', async () => {
    const result = await read({ ...stored, durable: false, generatedAt: 'stale-value' });
    expect(result!.durable).toBe(true);
    expect(result!.generatedAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('treats a double-encoded payload as a failed replication', async () => {
    expect(await read(JSON.stringify(stored))).toBeNull();
  });

  it('treats a payload missing its scored halves as a failed replication', async () => {
    expect(await read({ forecasts: [], cyclePaths: {} })).toBeNull();
    expect(await read({ summary: { issued: 1 } })).toBeNull();
  });
});
