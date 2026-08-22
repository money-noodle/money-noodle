import type { ForecastStorageIndex } from './forecast-storage';
import type { TrackedForecast } from './types';

const terminal = (row: TrackedForecast) => row.status === 'resolved' || row.status === 'invalid';

/**
 * Reads only as many newest daily shards as a bounded history list needs.
 *
 * Open rows are always included before the final top-k sort because an old unresolved row may coexist with
 * newer terminal rows. Once the matching rows from complete newest shards reach the limit, every unvisited
 * shard is strictly older by issuance day and cannot enter the result.
 */
export async function collectRecentForecastHistory(input: {
  index: ForecastStorageIndex;
  openRows: TrackedForecast[];
  limit: number;
  matches?: (row: TrackedForecast) => boolean;
  readShard: (shardId: string) => Promise<TrackedForecast[]>;
}): Promise<TrackedForecast[]> {
  const limit = Math.max(0, Math.floor(input.limit));
  if (!limit) return [];
  const matches = input.matches ?? (() => true);
  const records = new Map<string, TrackedForecast>();
  for (const row of input.openRows) if (matches(row)) records.set(row.id, row);

  for (const entry of [...input.index.shards].reverse()) {
    for (const row of await input.readShard(entry.shardId)) {
      if (!matches(row)) continue;
      const existing = records.get(row.id);
      if (existing && terminal(existing) && !terminal(row)) continue;
      if (existing && terminal(row) && !terminal(existing)) records.set(row.id, row);
      else if (!existing) records.set(row.id, row);
    }
    if (records.size >= limit) break;
  }

  return [...records.values()]
    .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt) || a.id.localeCompare(b.id))
    .slice(0, limit);
}
