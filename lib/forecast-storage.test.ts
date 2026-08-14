import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildForecastStoragePlan, verifyForecastStoragePlan, writeForecastStoragePlan } from './forecast-storage';
import type { TrackedForecast } from './types';

function forecast(overrides: Partial<TrackedForecast> = {}): TrackedForecast {
  return {
    id: 'btc:1',
    symbol: 'BTC',
    marketUrl: 'https://example.com/btc',
    issuedAt: '2026-08-14T10:00:00Z',
    closesAt: '2026-08-14T10:15:00Z',
    direction: 'UP',
    probabilityUp: 0.7,
    directionalLikelihood: 0.7,
    confidence: 0.65,
    modelVersion: 'test',
    policyVersion: 'test',
    polymarketProbabilityUp: 0.5,
    factors: [],
    status: 'pending',
    ...overrides,
  };
}

describe('forecast storage layout planning', () => {
  it('keeps unresolved rows hot and shards terminal rows by issuance day', () => {
    const rows = [
      forecast({ id: 'pending' }),
      forecast({ id: 'resolved-a', status: 'resolved', correct: true, outcome: 'UP', issuedAt: '2026-08-13T23:59:00Z' }),
      forecast({ id: 'resolved-b', status: 'resolved', correct: false, outcome: 'DOWN', issuedAt: '2026-08-14T00:01:00Z' }),
      forecast({ id: 'invalid', status: 'invalid', issuedAt: '2026-08-14T00:02:00Z' }),
    ];
    const plan = buildForecastStoragePlan(rows, '2026-08-14T12:00:00Z');
    expect(plan.open.map((item) => item.id)).toEqual(['pending']);
    expect(plan.index).toMatchObject({ totalRows: 4, openRows: 1, terminalRows: 3 });
    expect(plan.shards.map((shard) => shard.entry.shardId)).toEqual(['2026-08-13', '2026-08-14']);
    expect(plan.shards.find((shard) => shard.entry.shardId === '2026-08-14')?.rollup).toMatchObject({
      rowCount: 2,
      resolved: 1,
      invalid: 1,
      pending: 0,
    });
    expect(verifyForecastStoragePlan(rows, plan)).toMatchObject({ ok: true, errors: [] });
  });

  it('writes open rows, shards, rollups, and index atomically readable as JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-forecast-storage-'));
    try {
      const rows = [
        forecast({ id: 'pending' }),
        forecast({ id: 'resolved', status: 'resolved', correct: true, outcome: 'UP' }),
      ];
      const plan = buildForecastStoragePlan(rows, '2026-08-14T12:00:00Z');
      await writeForecastStoragePlan(root, plan);
      const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
      const open = JSON.parse(await readFile(path.join(root, 'open.json'), 'utf8'));
      const shard = JSON.parse(await readFile(path.join(root, '2026-08-14.json'), 'utf8'));
      const rollup = JSON.parse(await readFile(path.join(root, '2026-08-14.rollup.json'), 'utf8'));
      expect(index.shards).toHaveLength(1);
      expect(open.map((item: TrackedForecast) => item.id)).toEqual(['pending']);
      expect(shard.map((item: TrackedForecast) => item.id)).toEqual(['resolved']);
      expect(rollup).toMatchObject({ shardId: '2026-08-14', rowCount: 1, resolved: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
