// The v1 forecast storage: an append-only journal plus sealed daily shards with
// per-shard rollups and exact id artifacts, published through an index. The
// structural half of the v1 "forecast v3" verifier is ported here from the v1
// archive's verify-forecast-storage script and forecast-storage module,
// sanitized. The summary-equivalence half (direct performance summary versus the
// stored rollups) depends on v1's performance module and is deliberately NOT
// ported; the evidence document names that gap.

import type { DataTree } from './archive-source.js';
import { readTreeText } from './archive-source.js';
import { sha256Hex } from './sha256.js';

export const FORECAST_JOURNAL_FILE = 'forecast-history.journal.jsonl';
export const FORECAST_SHARD_DIRECTORY = 'forecast-history-shards';
export const FORECAST_STORAGE_VERSION = 'forecast-storage-v4';
export const LEGACY_FORECAST_STORAGE_VERSION = 'forecast-storage-v3';

export interface ForecastRow {
  id: string;
  status: string;
  qualified?: boolean;
  [key: string]: unknown;
}

export interface ForecastShardIndexEntry {
  shardId: string;
  file: string;
  rollupFile: string;
  rowCount: number;
  sha256: string;
  rollupSha256: string;
  idsFile?: string;
  idsSha256?: string;
  qualifiedRows?: number;
  unqualifiedRows?: number;
}

export interface ForecastStorageIndex {
  version: string;
  generation: string;
  generatedAt: string;
  totalRows: number;
  openRows: number;
  openFile: string;
  openSha256: string;
  compactedJournalSha256: string;
  compactedJournalBytes?: number;
  terminalRows: number;
  shards: ForecastShardIndexEntry[];
}

export type ForecastJournalEvent =
  | { op: 'upsert'; forecast: ForecastRow }
  | { op: 'patch'; id: string; changes: Partial<ForecastRow> }
  | { op: 'delete'; id: string };

export const terminalForecast = (row: ForecastRow) =>
  row.status === 'resolved' || row.status === 'invalid';

export function parseForecastJournal(raw: string): ForecastJournalEvent[] {
  const events: ForecastJournalEvent[] = [];
  raw.split('\n').forEach((line, index) => {
    if (!line) return;
    let event: ForecastJournalEvent;
    try {
      event = JSON.parse(line) as ForecastJournalEvent;
    } catch {
      throw new Error(`Forecast journal event ${index + 1} was not valid JSON.`);
    }
    if (event.op === 'upsert' && event.forecast?.id) events.push(event);
    else if ((event.op === 'patch' || event.op === 'delete') && event.id) events.push(event);
    else throw new Error(`Forecast journal event ${index + 1} had an unsupported shape.`);
  });
  return events;
}

export function replayForecastJournal(
  snapshot: ForecastRow[],
  events: ForecastJournalEvent[],
): ForecastRow[] {
  const records = new Map(snapshot.map((row) => [row.id, row]));
  for (const event of events) {
    if (event.op === 'delete') records.delete(event.id);
    else if (event.op === 'upsert') records.set(event.forecast.id, event.forecast);
    else {
      const existing = records.get(event.id);
      if (existing) records.set(event.id, { ...existing, ...event.changes });
    }
  }
  return [...records.values()];
}

/** Only the journal bytes the active generation has not already incorporated. */
export function uncompactedJournal(index: ForecastStorageIndex, journalRaw: string): string {
  if (index.compactedJournalSha256 === sha256Hex(journalRaw)) return '';
  const bytes = index.compactedJournalBytes;
  if (bytes === undefined || bytes < 0) return journalRaw;
  const raw = Buffer.from(journalRaw);
  if (raw.length < bytes || sha256Hex(raw.subarray(0, bytes)) !== index.compactedJournalSha256) {
    return journalRaw;
  }
  return raw.subarray(bytes).toString('utf8');
}

export interface ForecastVerification {
  ok: boolean;
  errors: string[];
  version: string;
  shards: number;
  sealedRows: number;
  openRowsAtLastSeal: number;
  journalEvents: number;
  currentOpenRows: number;
  currentTotalRows: number;
  /** Named so the evidence document can say what was not checked. */
  notVerified: string[];
}

export interface ForecastLayout {
  index: ForecastStorageIndex;
  shards: { entry: ForecastShardIndexEntry; rows: ForecastRow[]; rollup: unknown; ids: string[] }[];
  openAtSeal: ForecastRow[];
  journalEvents: ForecastJournalEvent[];
  currentOpen: ForecastRow[];
}

export function readForecastLayout(tree: DataTree): ForecastLayout | undefined {
  const indexRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/index.json`);
  if (indexRaw === undefined) return undefined;
  const index = JSON.parse(indexRaw) as ForecastStorageIndex;
  const journalRaw = readTreeText(tree, FORECAST_JOURNAL_FILE) ?? '';
  const journalEvents = parseForecastJournal(uncompactedJournal(index, journalRaw));
  const shards = index.shards.map((entry) => {
    const rowsRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${entry.file}`);
    const rollupRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${entry.rollupFile}`);
    const idsRaw = entry.idsFile
      ? readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${entry.idsFile}`)
      : undefined;
    return {
      entry,
      rows: rowsRaw === undefined ? [] : (JSON.parse(rowsRaw) as ForecastRow[]),
      rollup: rollupRaw === undefined ? undefined : (JSON.parse(rollupRaw) as unknown),
      ids: idsRaw === undefined ? [] : (JSON.parse(idsRaw) as string[]),
    };
  });
  const openRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${index.openFile}`);
  const openAtSeal = openRaw === undefined ? [] : (JSON.parse(openRaw) as ForecastRow[]);
  return {
    index,
    shards,
    openAtSeal,
    journalEvents,
    currentOpen: replayForecastJournal(openAtSeal, journalEvents),
  };
}

export function verifyForecastStorage(tree: DataTree): ForecastVerification {
  const errors: string[] = [];
  const layout = readForecastLayout(tree);
  if (!layout) {
    return {
      ok: false,
      errors: ['No forecast storage index was found in the restored tree.'],
      version: 'absent',
      shards: 0,
      sealedRows: 0,
      openRowsAtLastSeal: 0,
      journalEvents: 0,
      currentOpenRows: 0,
      currentTotalRows: 0,
      notVerified: [],
    };
  }
  const { index } = layout;
  if (
    index.version !== FORECAST_STORAGE_VERSION &&
    index.version !== LEGACY_FORECAST_STORAGE_VERSION
  ) {
    errors.push(`Unsupported forecast storage version ${String(index.version)}.`);
  }
  const sealed: ForecastRow[] = [];
  for (const { entry, rows, rollup, ids } of layout.shards) {
    const rowsRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${entry.file}`);
    const rollupRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${entry.rollupFile}`);
    if (rowsRaw === undefined) {
      errors.push(`Shard ${entry.shardId} could not be read.`);
      continue;
    }
    if (rollupRaw === undefined) {
      errors.push(`Rollup ${entry.shardId} could not be read.`);
      continue;
    }
    if (sha256Hex(rowsRaw) !== entry.sha256) {
      errors.push(`Shard ${entry.shardId} checksum did not match the index.`);
    }
    if (sha256Hex(rollupRaw) !== entry.rollupSha256) {
      errors.push(`Rollup ${entry.shardId} checksum did not match the index.`);
    }
    if (index.version === FORECAST_STORAGE_VERSION) {
      if (!entry.idsFile || !entry.idsSha256) {
        errors.push(`Shard ${entry.shardId} lacks v4 exact-ID metadata.`);
      } else {
        const idsRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${entry.idsFile}`);
        if (idsRaw === undefined) errors.push(`ID artifact ${entry.shardId} could not be read.`);
        else if (sha256Hex(idsRaw) !== entry.idsSha256) {
          errors.push(`ID artifact ${entry.shardId} checksum did not match the index.`);
        }
        if (
          ids.join('\n') !==
          rows
            .map((row) => row.id)
            .sort()
            .join('\n')
        ) {
          errors.push(`ID artifact ${entry.shardId} did not exactly match shard rows.`);
        }
        const qualified = rows.filter((row) => row.qualified !== false).length;
        if (
          entry.qualifiedRows !== qualified ||
          entry.unqualifiedRows !== rows.length - qualified
        ) {
          errors.push(`Shard ${entry.shardId} qualification counts did not match rows.`);
        }
      }
    }
    if (rows.length !== entry.rowCount) {
      errors.push(`Shard ${entry.shardId} held ${rows.length} rows; index says ${entry.rowCount}.`);
    }
    if (rows.some((row) => !terminalForecast(row))) {
      errors.push(`Shard ${entry.shardId} contains a non-terminal row.`);
    }
    if ((rollup as { shardId?: string } | undefined)?.shardId !== entry.shardId) {
      errors.push(`Rollup ${entry.shardId} identifies itself as a different shard.`);
    }
    sealed.push(...rows);
  }
  const openRaw = readTreeText(tree, `${FORECAST_SHARD_DIRECTORY}/${index.openFile}`);
  if (openRaw === undefined) errors.push(`Open artifact ${index.openFile} could not be read.`);
  else if (sha256Hex(openRaw) !== index.openSha256) {
    errors.push('Open artifact checksum did not match the index.');
  }
  if (sealed.length !== index.terminalRows) {
    errors.push(`Indexed terminal rows ${index.terminalRows}; shard files held ${sealed.length}.`);
  }
  if (layout.openAtSeal.length !== index.openRows) {
    errors.push(`Indexed open rows ${index.openRows}; open file held ${layout.openAtSeal.length}.`);
  }
  if (sealed.length + layout.openAtSeal.length !== index.totalRows) {
    errors.push(
      `Indexed total rows ${index.totalRows}; artifacts held ${sealed.length + layout.openAtSeal.length}.`,
    );
  }
  const sealedIds = new Set<string>();
  for (const row of sealed) {
    if (sealedIds.has(row.id)) errors.push(`Duplicate sealed forecast id ${row.id}.`);
    sealedIds.add(row.id);
  }
  const openIds = new Set<string>();
  for (const row of layout.currentOpen) {
    if (openIds.has(row.id)) errors.push(`Duplicate open forecast id ${row.id}.`);
    if (sealedIds.has(row.id)) {
      errors.push(`Open forecast id ${row.id} collided with sealed terminal evidence.`);
    }
    openIds.add(row.id);
  }
  return {
    ok: errors.length === 0,
    errors,
    version: index.version,
    shards: index.shards.length,
    sealedRows: sealed.length,
    openRowsAtLastSeal: layout.openAtSeal.length,
    journalEvents: layout.journalEvents.length,
    currentOpenRows: layout.currentOpen.length,
    currentTotalRows: sealed.length + layout.currentOpen.length,
    notVerified: [
      'Rollup summary equivalence (direct performance summary versus stored rollups) depends on the v1 performance module and is not ported; rollups are loaded as sealed artifacts with their checksums verified only.',
      'Legacy-rollup reseal detection against the active buy-policy version is not ported.',
    ],
  };
}
