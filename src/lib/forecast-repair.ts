import 'server-only';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ForecastJournalEvent } from './forecast-tracker';
import type { TrackedForecast } from './types';

export interface ForecastRecoverySource {
  label: string;
  indexFile: string;
  indexHash: string;
  journalFile: string;
  journalHash: string;
  sealed: TrackedForecast[];
  open: TrackedForecast[];
  events: ForecastJournalEvent[];
  diagnostics: string[];
}

export interface ForecastRecoveryResult {
  rows: TrackedForecast[];
  restoredQualifiedIds: string[];
  ignoredStalePending: number;
  canonicalizedTerminalCollisions: number;
  prunedUnqualified: number;
  archiveRowsAfterReplay: number;
  currentRowsAfterReplay: number;
}

const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const terminal = (row: TrackedForecast) => row.status === 'resolved' || row.status === 'invalid';

async function artifact(root: string, file: string): Promise<{ file: string; raw: string }> {
  const candidates = [path.join(root, file), path.join(root, 'shards', file)];
  for (const candidate of candidates) {
    try { return { file: candidate, raw: await readFile(candidate, 'utf8') }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`Recovery artifact ${file} was absent under ${root}.`);
}

export async function loadForecastRecoverySource(input: {
  label: string;
  root: string;
  journalFile: string;
  /** Verified archives fail on contradictions; the known-corrupt local generation records them. */
  strictIndex: boolean;
}): Promise<ForecastRecoverySource> {
  const indexPath = path.join(input.root, 'index.json');
  const indexRaw = await readFile(indexPath, 'utf8');
  const index = JSON.parse(indexRaw) as {
    openFile?: string; openSha256?: string; openRows: number; terminalRows: number; totalRows: number;
    shards: Array<{ shardId: string; file: string; rowCount: number; sha256: string }>;
  };
  const diagnostics: string[] = [];
  const sealed: TrackedForecast[] = [];
  for (const entry of index.shards) {
    const stored = await artifact(input.root, entry.file);
    const actualHash = sha256(stored.raw);
    const rows = JSON.parse(stored.raw) as TrackedForecast[];
    if (actualHash !== entry.sha256) diagnostics.push(`${input.label} shard ${entry.shardId} checksum ${actualHash} != ${entry.sha256}.`);
    if (rows.length !== entry.rowCount) diagnostics.push(`${input.label} shard ${entry.shardId} rows ${rows.length} != ${entry.rowCount}.`);
    if (rows.some((row) => !terminal(row))) diagnostics.push(`${input.label} shard ${entry.shardId} contained a non-terminal row.`);
    sealed.push(...rows);
  }
  const openArtifact = await artifact(input.root, index.openFile ?? 'open.json');
  const open = JSON.parse(openArtifact.raw) as TrackedForecast[];
  if (index.openSha256 && sha256(openArtifact.raw) !== index.openSha256) diagnostics.push(`${input.label} open checksum did not match its index.`);
  if (open.length !== index.openRows) diagnostics.push(`${input.label} open rows ${open.length} != ${index.openRows}.`);
  if (sealed.length !== index.terminalRows) diagnostics.push(`${input.label} terminal rows ${sealed.length} != ${index.terminalRows}.`);
  if (sealed.length + open.length !== index.totalRows) diagnostics.push(`${input.label} artifact rows ${sealed.length + open.length} != ${index.totalRows}.`);
  if (input.strictIndex && diagnostics.length) throw new Error(diagnostics.join(' '));

  const journalRaw = await readFile(input.journalFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const events = journalRaw.split('\n').flatMap((line) => line ? [JSON.parse(line) as ForecastJournalEvent] : []);
  return {
    label: input.label, indexFile: indexPath, indexHash: sha256(indexRaw),
    journalFile: input.journalFile, journalHash: sha256(journalRaw),
    sealed, open, events, diagnostics,
  };
}

function sameTerminal(left: TrackedForecast, right: TrackedForecast): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminalStatement(row: TrackedForecast): string {
  return JSON.stringify({
    status: row.status, outcome: row.outcome, invalidReason: row.invalidReason,
    evaluationVenue: row.evaluationVenue, targetIntegrity: row.targetIntegrity,
    evaluationContractId: row.evaluationVenue
      ? row.venueOutcomes?.[row.evaluationVenue]?.contractId ?? row.venueContracts?.[row.evaluationVenue]?.registryId
      : undefined,
  });
}

interface MergeCounts { ignored: number; canonicalized: number }

function canonicalTerminal(left: TrackedForecast, right: TrackedForecast, counts: MergeCounts): TrackedForecast {
  if (sameTerminal(left, right)) return left;
  if (terminalStatement(left) !== terminalStatement(right)) throw new Error(`Recovery found conflicting terminal statements for ${right.id}.`);
  // Concurrent dashboard bundles could calculate different snapshots inside one bucketed observation ID.
  // Normal single-writer semantics retain the first one, so recover the earliest issuance rather than
  // choosing whichever stale compactor happened to publish last.
  const leftIssued = Date.parse(left.issuedAt);
  const rightIssued = Date.parse(right.issuedAt);
  counts.canonicalized += 1;
  if (leftIssued !== rightIssued) return leftIssued < rightIssued ? left : right;
  // The same row may be slimmed to provenance registry references in one generation and still expanded
  // in another. Preserve the richer representation when issuance and terminal statement are identical.
  const leftBytes = JSON.stringify(left).length;
  const rightBytes = JSON.stringify(right).length;
  if (leftBytes === rightBytes) throw new Error(`Recovery found conflicting terminal payloads at the same issuance time for ${right.id}.`);
  return leftBytes > rightBytes ? left : right;
}

function applyEvent(records: Map<string, TrackedForecast>, event: ForecastJournalEvent, counts: MergeCounts): void {
  if (event.op === 'delete') {
    const existing = records.get(event.id);
    if (existing?.qualified !== false) throw new Error(`Recovery refused deletion of qualified forecast ${event.id}.`);
    records.delete(event.id);
    return;
  }
  if (event.op === 'patch') {
    const existing = records.get(event.id);
    if (existing) records.set(event.id, { ...existing, ...event.changes });
    return;
  }
  const existing = records.get(event.forecast.id);
  if (existing && terminal(existing) && !terminal(event.forecast)) { counts.ignored += 1; return; }
  if (existing && terminal(existing) && terminal(event.forecast)) {
    records.set(event.forecast.id, canonicalTerminal(existing, event.forecast, counts));
    return;
  }
  records.set(event.forecast.id, event.forecast);
}

function overlay(records: Map<string, TrackedForecast>, row: TrackedForecast, counts: MergeCounts): void {
  const existing = records.get(row.id);
  if (existing && terminal(existing) && !terminal(row)) { counts.ignored += 1; return; }
  if (existing && terminal(existing) && terminal(row)) {
    records.set(row.id, canonicalTerminal(existing, row, counts));
    return;
  }
  records.set(row.id, row);
}

function replaySource(source: ForecastRecoverySource): Map<string, TrackedForecast> {
  const records = new Map<string, TrackedForecast>();
  const counts: MergeCounts = { ignored: 0, canonicalized: 0 };
  for (const row of source.sealed) overlay(records, row, counts);
  for (const row of source.open) overlay(records, row, counts);
  for (const event of source.events) applyEvent(records, event, counts);
  return records;
}

export function recoverForecastRows(
  archive: ForecastRecoverySource, current: ForecastRecoverySource, unqualifiedRetention = 20_000,
): ForecastRecoveryResult {
  const archiveState = replaySource(archive);
  const records = new Map(archiveState);
  const currentIds = new Set<string>();
  const counts: MergeCounts = { ignored: 0, canonicalized: 0 };
  for (const row of current.sealed) { currentIds.add(row.id); overlay(records, row, counts); }
  for (const row of current.open) { currentIds.add(row.id); overlay(records, row, counts); }
  for (const event of current.events) {
    if (event.op === 'upsert') currentIds.add(event.forecast.id);
    else if (event.op === 'delete') currentIds.delete(event.id);
    applyEvent(records, event, counts);
  }

  const restoredQualifiedIds = [...archiveState.values()]
    .filter((row) => row.qualified !== false && !currentIds.has(row.id))
    .map((row) => row.id).sort();
  const all = [...records.values()];
  const unqualified = all.filter((row) => row.qualified === false)
    .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt) || b.id.localeCompare(a.id));
  const keep = new Set(unqualified.slice(0, unqualifiedRetention).map((row) => row.id));
  const rows = all.filter((row) => row.qualified !== false || keep.has(row.id));
  return {
    rows,
    restoredQualifiedIds,
    ignoredStalePending: counts.ignored,
    canonicalizedTerminalCollisions: counts.canonicalized,
    prunedUnqualified: all.length - rows.length,
    archiveRowsAfterReplay: archiveState.size,
    currentRowsAfterReplay: currentIds.size,
  };
}
