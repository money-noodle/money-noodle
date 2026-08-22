import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prediction } from './types';

vi.mock('server-only', () => ({}));
const fs = vi.hoisted(() => ({
  readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(),
}));
vi.mock('node:fs/promises', () => fs);

const runtimeKey = Symbol.for('money-noodle.cycle-path-store');
const globals = globalThis as typeof globalThis & { [runtimeKey]?: unknown };
const observedAt = Date.parse('2026-08-22T00:05:00Z');

function prediction(): Prediction {
  return {
    symbol: 'BTC', market: { closesAt: '2026-08-22T00:15:00Z' },
    basis: { referencePrice: 100, currentPrice: 101 },
  } as Prediction;
}

describe('cycle path process cache', () => {
  beforeEach(() => {
    delete globals[runtimeKey];
    vi.resetModules();
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.rename.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue(JSON.stringify({ version: 1, policyVersion: 'aligned-15s-observation-only-v1', cycles: [] }));
  });

  it('parses once across independently loaded server module copies', async () => {
    const first = await import('./cycle-path-store');
    expect((await first.getCyclePathReport()).totalCycles).toBe(0);
    vi.resetModules();
    const second = await import('./cycle-path-store');
    expect(await second.getCyclePaths()).toEqual([]);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it('publishes a compact write-through value only after the atomic rename', async () => {
    const first = await import('./cycle-path-store');
    await first.recordCyclePathObservations([prediction()], [], observedAt);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.writeFile.mock.calls[0][1]).not.toContain('\n');

    vi.resetModules();
    const second = await import('./cycle-path-store');
    const report = await second.getCyclePathReport(observedAt);
    expect(report.totalCycles).toBe(1);
    expect(report.totalPoints).toBe(1);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it('invalidates ambiguous memory state and reloads durable data after a failed write', async () => {
    const store = await import('./cycle-path-store');
    await store.getCyclePathReport();
    fs.writeFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.recordCyclePathObservations([prediction()], [], observedAt)).rejects.toThrow('disk full');
    expect((await store.getCyclePathReport()).totalCycles).toBe(0);
    expect(fs.readFile).toHaveBeenCalledTimes(2);
  });
});
