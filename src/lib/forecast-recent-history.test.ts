import { describe, expect, it, vi } from 'vitest';
import { collectRecentForecastHistory } from './forecast-recent-history';
import type { ForecastStorageIndex } from './forecast-storage';
import type { TrackedForecast } from './types';

function row(id: string, issuedAt: string, patch: Partial<TrackedForecast> = {}): TrackedForecast {
  return {
    id, issuedAt, symbol: 'BTC', marketUrl: 'https://example.test/btc', closesAt: '2026-08-22T00:15:00Z',
    direction: 'UP', probabilityUp: 0.6, directionalLikelihood: 0.6, confidence: 0.6,
    modelVersion: 'test', policyVersion: 'test', polymarketProbabilityUp: 0.5,
    factors: [], status: 'resolved', outcome: 'UP', qualified: true, ...patch,
  };
}

const index: ForecastStorageIndex = {
  version: 'forecast-storage-v3', generation: 'test', generatedAt: '2026-08-22T01:00:00Z',
  totalRows: 6, openRows: 1, openFile: 'open.test.json', openSha256: 'test',
  compactedJournalSha256: 'test', terminalRows: 5,
  shards: ['2026-08-20', '2026-08-21', '2026-08-22'].map((shardId) => ({
    shardId, file: `${shardId}.json`, rollupFile: `${shardId}.rollup.json`, rowCount: 2,
    sha256: 'test', rollupSha256: 'test',
  })),
};

describe('bounded recent forecast history', () => {
  it('matches a full top-k scan without reading an unnecessary older shard', async () => {
    const open = [row('open-old', '2026-08-19T23:00:00Z', { status: 'pending' })];
    const shards = new Map([
      ['2026-08-20', [row('old-a', '2026-08-20T10:00:00Z'), row('old-b', '2026-08-20T11:00:00Z')]],
      ['2026-08-21', [row('middle-a', '2026-08-21T10:00:00Z'), row('middle-b', '2026-08-21T11:00:00Z')]],
      ['2026-08-22', [row('new-qualified', '2026-08-22T10:00:00Z'), row('new-unqualified', '2026-08-22T11:00:00Z', { qualified: false })]],
    ]);
    const readShard = vi.fn(async (shardId: string) => shards.get(shardId) ?? []);
    const matches = (forecast: TrackedForecast) => forecast.qualified !== false;
    const recent = await collectRecentForecastHistory({ index, openRows: open, limit: 3, matches, readShard });
    const full = [...open, ...[...shards.values()].flat()].filter(matches)
      .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt) || a.id.localeCompare(b.id)).slice(0, 3);

    expect(recent.map((forecast) => forecast.id)).toEqual(full.map((forecast) => forecast.id));
    expect(readShard.mock.calls.map(([shardId]) => shardId)).toEqual(['2026-08-22', '2026-08-21']);
  });

  it('returns immediately for an empty limit without loading a shard', async () => {
    const readShard = vi.fn(async () => [] as TrackedForecast[]);
    expect(await collectRecentForecastHistory({ index, openRows: [], limit: 0, readShard })).toEqual([]);
    expect(readShard).not.toHaveBeenCalled();
  });
});
