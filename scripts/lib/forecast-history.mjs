/**
 * The authoritative resolved-forecast view: sealed shards, the open shard, then the journal applied on top.
 *
 * **The journal is not optional.** `data/forecast-history-shards/open.json` is rewritten only when the
 * store compacts, so on a running collector it can be hours stale — it was seven hours behind when this
 * module was written. Resolution arrives as `{ op, id, changes }` patch records in
 * `forecast-history.journal.jsonl`, so a loader that reads shards alone sees recently-settled rows as
 * permanently `pending` and silently drops the newest policy era entirely. That is exactly what happened
 * to `analyze:loss-decomposition`, which reported zero rows for v19 while the desk was trading it.
 *
 * Ordering matters: shards first, then the open shard, then journal upserts and patches in file order, so
 * the last write wins the way the store itself replays them.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

export async function readForecastHistory(dataDir) {
  const shardDir = path.join(dataDir, 'forecast-history-shards');
  const byId = new Map();
  const absorb = (list) => { for (const row of list) if (row?.id) byId.set(row.id, row); };

  const indexFile = path.join(shardDir, 'index.json');
  if (existsSync(indexFile)) {
    const index = JSON.parse(await readFile(indexFile, 'utf8'));
    for (const shard of index.shards ?? []) {
      absorb(JSON.parse(await readFile(path.join(shardDir, shard.file), 'utf8')));
      global.gc?.();
    }
  }
  const open = path.join(shardDir, 'open.json');
  if (existsSync(open)) absorb(JSON.parse(await readFile(open, 'utf8')));

  const journal = path.join(dataDir, 'forecast-history.journal.jsonl');
  if (existsSync(journal)) {
    const stream = readline.createInterface({ input: createReadStream(journal) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.forecast?.id) { byId.set(entry.forecast.id, { ...byId.get(entry.forecast.id), ...entry.forecast }); continue; }
      // A patch names an id and the fields that changed; without the base row there is nothing to patch.
      if (entry.id && entry.changes) {
        const base = byId.get(entry.id);
        if (base) byId.set(entry.id, { ...base, ...entry.changes });
      }
    }
  }
  return [...byId.values()];
}

/** Resolved rows only, which is what every settlement-scored analysis wants. */
export async function readResolvedForecasts(dataDir) {
  return (await readForecastHistory(dataDir)).filter((row) => row.status === 'resolved' && row.outcome);
}
