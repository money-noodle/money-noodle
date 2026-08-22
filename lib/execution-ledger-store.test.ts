import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const io = vi.hoisted(() => ({
  readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(),
}));
const postgres = vi.hoisted(() => ({ enabled: vi.fn(() => false), sync: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: io.readFile, mkdir: io.mkdir, writeFile: io.writeFile, rename: io.rename,
}));
vi.mock('./postgres-paper-projection', () => ({
  postgresPaperProjectionSyncEnabled: () => postgres.enabled(),
  syncPublicPaperBudgetToPostgres: (payload: unknown) => postgres.sync(payload),
  readPublicPaperBudgetFromPostgres: vi.fn(),
}));

const runtimeKey = Symbol.for('money-noodle.execution-ledger-runtime');
const globals = globalThis as typeof globalThis & { [runtimeKey]?: unknown };
const emptyLedger = {
  version: 8, paperBudget: { startingCents: 10_000, availableCents: 10_000, realizedPnlCents: 0 },
  orders: [], signalPersistence: {}, portfolioDecisions: {}, switchPersistence: {}, liveCorrections: [],
};

describe('execution ledger commit cache', () => {
  beforeEach(() => {
    delete globals[runtimeKey];
    vi.resetModules();
    vi.clearAllMocks();
    io.readFile.mockResolvedValue(JSON.stringify(emptyLedger));
    io.mkdir.mockResolvedValue(undefined);
    io.writeFile.mockResolvedValue(undefined);
    io.rename.mockResolvedValue(undefined);
    postgres.enabled.mockReturnValue(false);
    postgres.sync.mockResolvedValue(undefined);
  });

  it('publishes a compact committed value only after atomic rename', async () => {
    const execution = await import('./paper-execution');
    const events: string[] = [];
    io.writeFile.mockImplementation(async () => { events.push('write'); });
    io.rename.mockImplementation(async () => { events.push('rename'); });

    await execution.resetPaperBudget(1_000);
    expect(events).toEqual(['write', 'rename']);
    expect(io.writeFile.mock.calls[0][1]).not.toContain('\n');
    expect(await execution.getPaperBankrollStartingCents()).toBe(1_000);
    expect(io.readFile).toHaveBeenCalledTimes(1);
  });

  it('invalidates memory and reloads the prior durable generation after failed rename', async () => {
    const execution = await import('./paper-execution');
    io.rename.mockRejectedValueOnce(new Error('rename failed'));
    await expect(execution.resetPaperBudget(1_000)).rejects.toThrow('rename failed');
    expect(await execution.getPaperBankrollStartingCents()).toBe(10_000);
    expect(io.readFile).toHaveBeenCalledTimes(2);
  });

  it('reloads disk when an operation throws after an intermediate commit', async () => {
    postgres.enabled.mockReturnValue(true);
    postgres.sync.mockImplementationOnce(() => { throw new Error('post-commit failure'); });
    const execution = await import('./paper-execution');
    await expect(execution.resetPaperBudget(1_000)).rejects.toThrow('post-commit failure');
    expect(io.rename).toHaveBeenCalledTimes(1);
    expect(await execution.getPaperBankrollStartingCents()).toBe(10_000);
    expect(io.readFile).toHaveBeenCalledTimes(2);
  });

  it('keeps the one-second long-shot precheck on a bounded queued view', () => {
    const source = readFileSync(new URL('./paper-execution.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function longShotExitTick');
    const end = source.indexOf('/** Started lazily from the collector cycle', start);
    const tick = source.slice(start, end);
    expect(tick).toContain('readLedgerView');
    expect(tick).not.toContain('loadLedgerFromDisk');
    expect(tick).not.toContain('getExecutionOrders');
  });

  it('returns detached filtered order rows rather than the committed objects', async () => {
    io.readFile.mockResolvedValue(JSON.stringify({
      ...emptyLedger,
      orders: [
        { id: 'paper', executionMode: 'paper', strategyId: 'edge-binary-buy' },
        { id: 'live', executionMode: 'live', strategyId: 'edge-binary-buy' },
        { id: 'other', executionMode: 'paper', strategyId: 'long-shot-round-trip' },
      ],
    }));
    const execution = await import('./paper-execution');
    const rows = await execution.getExecutionOrders({ executionMode: 'paper', strategyId: 'edge-binary-buy' });
    expect(rows.map((row) => row.id)).toEqual(['paper']);
    rows[0].id = 'mutated-reader-copy';
    expect((await execution.getExecutionOrders({ executionMode: 'paper', strategyId: 'edge-binary-buy' }))[0].id).toBe('paper');
    expect(io.readFile).toHaveBeenCalledTimes(1);
  });
});
