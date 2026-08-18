import 'server-only';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { decodeContractPath } from './contract-path';
import {
  LONG_SHOT_CANDIDATE_VERSION, candidatesFromPath, decodeCandidate, encodeCandidate,
  type LongShotCandidate,
} from './long-shot-candidate';
import type { PositionSide } from './types';

/**
 * Durable band-independent candidate summaries, derived read-only from recorded contract paths.
 *
 * Observation only. Nothing here may gate, size, price, or trade. The point of the shape is that an
 * operator can define a new `(entry range, exit)` band and have it measured immediately: no band, entry
 * mark, or entry window is stored, so nothing needs re-collecting when one changes.
 *
 * See docs/long-shot-policy-design.md §15a.
 */
const DATA_DIR = path.resolve(process.cwd(), 'data');
const CANDIDATE_FILE = path.join(DATA_DIR, 'long-shot-candidates.journal.jsonl');
const PATH_JOURNAL = path.join(DATA_DIR, 'contract-paths.journal.jsonl');
const PATH_ACTIVE = path.join(DATA_DIR, 'contract-paths.json');

/** Parsed candidates, reused while the file is unchanged so a dialog open is not a full re-parse. */
let cache: { mtimeMs: number; size: number; candidates: LongShotCandidate[] } | null = null;

async function readJournal(): Promise<LongShotCandidate[]> {
  const candidates: LongShotCandidate[] = [];
  if (!existsSync(CANDIDATE_FILE)) return candidates;
  const stream = readline.createInterface({ input: createReadStream(CANDIDATE_FILE) });
  for await (const line of stream) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const candidate = decodeCandidate(parsed);
    // A damaged line is skipped rather than failing the whole read: this is telemetry, not a ledger.
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/**
 * Settlements live beside the journal rather than inside it.
 *
 * A window resolves after its candidates are written, and the journal is append-only — AGENTS §3 forbids
 * rewriting history to patch a row. One small map keyed by `symbol|closesAt` also holds a settlement once
 * for both sides rather than twice, and lets the venue be asked lazily without blocking collection.
 */
const SETTLEMENT_FILE = path.join(DATA_DIR, 'long-shot-settlements.json');

async function readSettlements(): Promise<Record<string, PositionSide>> {
  if (!existsSync(SETTLEMENT_FILE)) return {};
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(SETTLEMENT_FILE, 'utf8')) as { settlements?: Record<string, PositionSide> };
    return parsed.settlements ?? {};
  } catch {
    // Observation-only telemetry: an unreadable map degrades the return column to "ungraded", nothing more.
    return {};
  }
}

export async function recordLongShotSettlements(resolved: Record<string, PositionSide>): Promise<void> {
  if (!Object.keys(resolved).length) return;
  const { rename, writeFile } = await import('node:fs/promises');
  const merged = { ...(await readSettlements()), ...resolved };
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${SETTLEMENT_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, settlements: merged }));
  await rename(temporary, SETTLEMENT_FILE);
  cache = null;
}

export const settlementKey = (symbol: string, closesAt: string) => `${symbol}|${closesAt}`;

export async function getLongShotCandidates(): Promise<LongShotCandidate[]> {
  if (!existsSync(CANDIDATE_FILE)) return [];
  const stats = await stat(CANDIDATE_FILE);
  if (cache && cache.mtimeMs === stats.mtimeMs && cache.size === stats.size) return cache.candidates;
  const [rows, settlements] = await Promise.all([readJournal(), readSettlements()]);
  // Deduplicate by contract and side, newest write winning. The journal is append-only, so a schema
  // change that makes older rows undecodable causes the backfill to re-derive and append them again;
  // without this that would double-count every candidate rather than replace it.
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) byKey.set(`${row.contractId}|${row.closesAt}|${row.side}`, row);
  // The map is authoritative: a row written before its window resolved carries no settlement of its own.
  const candidates = [...byKey.values()].map((candidate) => ({
    ...candidate,
    settledSide: settlements[settlementKey(candidate.symbol, candidate.closesAt)] ?? candidate.settledSide,
  }));
  cache = { mtimeMs: stats.mtimeMs, size: stats.size, candidates };
  return candidates;
}

/** Windows with candidates on file, closed, and still ungraded. Bounded so a backlog never stalls a cycle. */
export async function unresolvedCandidateWindows(limit = 12, nowMs = Date.now()): Promise<Array<{ symbol: string; closesAt: string; contractId: string }>> {
  const candidates = await getLongShotCandidates();
  const pending = new Map<string, { symbol: string; closesAt: string; contractId: string }>();
  for (const candidate of candidates) {
    if (candidate.settledSide) continue;
    if (Date.parse(candidate.closesAt) > nowMs) continue;
    pending.set(settlementKey(candidate.symbol, candidate.closesAt), {
      symbol: candidate.symbol, closesAt: candidate.closesAt, contractId: candidate.contractId,
    });
  }
  // Newest first: a recent window is the one an operator is most likely to be looking at.
  return [...pending.values()]
    .sort((left, right) => Date.parse(right.closesAt) - Date.parse(left.closesAt))
    .slice(0, limit);
}

export async function appendLongShotCandidates(candidates: LongShotCandidate[]): Promise<void> {
  if (!candidates.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(CANDIDATE_FILE, candidates.map((candidate) => `${JSON.stringify(encodeCandidate(candidate))}\n`).join(''));
  cache = null;
}

/** Every recorded path, sealed and active, newest close first. Read-only; paths are never mutated here. */
async function readPaths(): Promise<Array<ReturnType<typeof decodeContractPath>>> {
  const records: Array<ReturnType<typeof decodeContractPath>> = [];
  if (existsSync(PATH_JOURNAL)) {
    const stream = readline.createInterface({ input: createReadStream(PATH_JOURNAL) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      try { records.push(decodeContractPath(JSON.parse(line))); } catch { /* damaged line skipped */ }
    }
  }
  if (existsSync(PATH_ACTIVE)) {
    try {
      const parsed = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(PATH_ACTIVE, 'utf8'))) as {
        active?: Array<{ contractId: string; symbol: string; closesAt: string; points: unknown[] }>;
      };
      for (const record of parsed.active ?? []) {
        records.push(decodeContractPath([record.contractId, record.symbol, record.closesAt,
          (record.points as Array<{ offsetSeconds: number; askUpCents: number; askDownCents: number }>)
            .map((point) => [point.offsetSeconds, point.askUpCents, point.askDownCents])]));
      }
    } catch { /* an unreadable active set is not fatal to a backfill over the journal */ }
  }
  return records;
}

export interface CandidateBackfillResult {
  pathsRead: number;
  candidatesWritten: number;
  alreadyPresent: number;
  unresolved: number;
}

/**
 * Builds the candidate journal from paths already on disk.
 *
 * Idempotent: rows already present for a `(contract, side)` are left alone, so a repeated run costs a read
 * and writes nothing. This is the **only** backfill this feature has — because the stored form carries no
 * band, saving a new band recomputes results in memory and needs no pass over history at all.
 *
 * Read-only over `data/contract-paths.*`. It never mutates a path, and it is not on any execution path.
 */
export async function backfillLongShotCandidates(): Promise<CandidateBackfillResult> {
  // Settlement is deliberately not resolved here: it arrives from the venue afterwards, into its own map,
  // so a backfill over a thousand windows is a local read rather than a thousand venue calls.
  const settlements = await readSettlements();
  const existing = new Set((await getLongShotCandidates()).map((candidate) => `${candidate.contractId}|${candidate.closesAt}|${candidate.side}`));
  const paths = await readPaths();
  // The journal can hold one window more than once; the longest path for a contract is the complete one.
  const byContract = new Map<string, NonNullable<ReturnType<typeof decodeContractPath>>>();
  for (const record of paths) {
    if (!record) continue;
    const key = `${record.contractId}|${record.closesAt}`;
    const seen = byContract.get(key);
    if (!seen || record.points.length > seen.points.length) byContract.set(key, record);
  }

  const fresh: LongShotCandidate[] = [];
  let alreadyPresent = 0;
  let unresolved = 0;
  for (const record of byContract.values()) {
    const settledSide = settlements[settlementKey(record.symbol, record.closesAt)];
    if (!settledSide) unresolved += 1;
    for (const candidate of candidatesFromPath(record, settledSide)) {
      if (existing.has(`${candidate.contractId}|${candidate.closesAt}|${candidate.side}`)) { alreadyPresent += 1; continue; }
      fresh.push(candidate);
    }
  }
  await appendLongShotCandidates(fresh);
  return { pathsRead: byContract.size, candidatesWritten: fresh.length, alreadyPresent, unresolved };
}

export const LONG_SHOT_CANDIDATE_STORE_VERSION = LONG_SHOT_CANDIDATE_VERSION;

/**
 * Asks the venue how a handful of ungraded windows settled.
 *
 * Bounded per call and never awaited on a cycle that has money in it: a slow venue must cost this surface
 * freshness and nothing else. An unpublished or ambiguous result stays unresolved rather than being graded
 * as a loss, which is the same rule `resolveSentinelOutcomes` applies.
 */
export async function resolveLongShotSettlements(limit = 12, nowMs = Date.now()): Promise<number> {
  const due = await unresolvedCandidateWindows(limit, nowMs);
  if (!due.length) return 0;
  const resolved: Record<string, PositionSide> = {};
  await Promise.all(due.map(async (window) => {
    try {
      const response = await fetch(
        `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(window.contractId)}`,
        { signal: AbortSignal.timeout(4_000), cache: 'no-store' },
      );
      if (!response.ok) return;
      const body = await response.json() as { market?: { result?: string } };
      const result = body.market?.result?.toLowerCase();
      if (result === 'yes') resolved[settlementKey(window.symbol, window.closesAt)] = 'UP';
      else if (result === 'no') resolved[settlementKey(window.symbol, window.closesAt)] = 'DOWN';
    } catch {
      // A transient venue failure is not an outcome; the next pass retries.
    }
  }));
  await recordLongShotSettlements(resolved);
  return Object.keys(resolved).length;
}
