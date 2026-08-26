import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractProvenanceRecord, Prediction } from './types';

vi.mock('server-only', () => ({}));
const fs = vi.hoisted(() => ({
  readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(),
}));
vi.mock('node:fs/promises', () => fs);

const runtimeKey = Symbol.for('money-noodle.contract-provenance-store');
const globals = globalThis as typeof globalThis & { [runtimeKey]?: unknown };

function provenance(registryId: string): ContractProvenanceRecord {
  return {
    version: 'contract-provenance-v1', registryId, venue: 'polymarket', contractId: `contract-${registryId}`,
    marketUrl: 'https://example.test', closesAt: '2026-08-22T01:00:00Z', capturedAt: '2026-08-22T00:00:00Z',
    rulesSource: 'test', rulesFingerprint: `fingerprint-${registryId}`, rulesText: 'rules', comparability: 'exact',
  };
}

function prediction(record: ContractProvenanceRecord): Prediction {
  return { market: { contract: record } } as Prediction;
}

describe('contract provenance process cache', () => {
  beforeEach(() => {
    delete globals[runtimeKey];
    vi.resetModules();
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.rename.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue(JSON.stringify({ version: 1, records: [provenance('old')] }));
  });

  it('parses once across independently loaded server module copies', async () => {
    const first = await import('./contract-provenance-store');
    expect((await first.getContractProvenanceRegistry()).records).toHaveLength(1);
    vi.resetModules();
    const second = await import('./contract-provenance-store');
    expect((await second.getContractProvenanceRegistry()).records).toHaveLength(1);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it('publishes an addition to every module copy only after the atomic rename', async () => {
    const first = await import('./contract-provenance-store');
    await first.recordContractProvenance([prediction(provenance('new'))]);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.writeFile.mock.calls[0][1]).not.toContain('\n');

    vi.resetModules();
    const second = await import('./contract-provenance-store');
    expect((await second.getContractProvenanceRegistry()).records.map((record) => record.registryId)).toEqual(['old', 'new']);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it('invalidates ambiguous memory state and reloads durable data after a failed write', async () => {
    const store = await import('./contract-provenance-store');
    await store.getContractProvenanceRegistry();
    fs.writeFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.recordContractProvenance([prediction(provenance('new'))])).rejects.toThrow('disk full');
    expect((await store.getContractProvenanceRegistry()).records.map((record) => record.registryId)).toEqual(['old']);
    expect(fs.readFile).toHaveBeenCalledTimes(2);
  });
});
