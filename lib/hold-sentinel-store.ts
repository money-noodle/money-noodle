import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  HOLD_SENTINEL_VERSION, buildHoldSentinelReport, type HoldSentinel, type HoldSentinelReport,
} from './hold-sentinel';
import type { PositionSide } from './types';

/**
 * Durable store for approach (ii): the buy-and-hold arm of the long-shot trigger.
 *
 * Places no order and holds no budget. Records are immutable once written — only the settlement outcome is
 * ever patched in, and only once. See docs/long-shot-policy-design.md §10.
 */
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'hold-sentinels.json');
const MAX_SENTINELS = 20_000;

let operationQueue: Promise<void> = Promise.resolve();

interface HoldSentinelStore {
  version: 1;
  sentinelVersion: string;
  startedAt: string;
  updatedAt: string;
  sentinels: HoldSentinel[];
}

const emptyStore = (): HoldSentinelStore => ({
  version: 1,
  sentinelVersion: HOLD_SENTINEL_VERSION,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sentinels: [],
});

async function readStore(): Promise<HoldSentinelStore> {
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8')) as Partial<HoldSentinelStore>;
    if (!Array.isArray(parsed.sentinels)) throw new Error('Hold sentinel store has no sentinel collection.');
    return {
      version: 1,
      sentinelVersion: parsed.sentinelVersion ?? HOLD_SENTINEL_VERSION,
      startedAt: parsed.startedAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      sentinels: parsed.sentinels,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    await rename(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Hold sentinel store was malformed and has been quarantined:', error);
    return emptyStore();
  }
}

async function writeStore(store: HoldSentinelStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(store));
  await rename(temporary, STORE_FILE);
}

/** Stable across cycles, so re-observing the same trigger cannot manufacture a second sample. */
export function holdSentinelId(input: { symbol: string; side: PositionSide; closesAt: string; entryGeneration: number }): string {
  return `${input.symbol}:${input.side}:${input.closesAt}:${input.entryGeneration}`;
}

export interface HoldSentinelCycle {
  observedAt: string;
  /** Triggers observed this cycle, executed or not. */
  sentinels: HoldSentinel[];
  /** Settled outcomes keyed by `contractId:closesAt`, applied to any sentinel still unresolved. */
  outcomes?: Record<string, PositionSide>;
  /** Peak owned-side bid observed by the executing lane, keyed by sentinel id. */
  peakBids?: Record<string, number>;
}

async function update(cycle: HoldSentinelCycle): Promise<void> {
  const store = await readStore();
  const byId = new Map(store.sentinels.map((sentinel) => [sentinel.id, sentinel]));
  let changed = false;

  for (const sentinel of cycle.sentinels) {
    // First observation wins. A trigger re-seen on a later cycle must not overwrite the quote, clock, or
    // skip reason captured at the moment the decision was actually made.
    if (byId.has(sentinel.id)) continue;
    byId.set(sentinel.id, sentinel);
    changed = true;
  }

  for (const [id, peakBidCents] of Object.entries(cycle.peakBids ?? {})) {
    const sentinel = byId.get(id);
    if (!sentinel || !Number.isFinite(peakBidCents)) continue;
    if ((sentinel.peakOwnedSideBidCents ?? 0) >= peakBidCents) continue;
    byId.set(id, { ...sentinel, peakOwnedSideBidCents: peakBidCents });
    changed = true;
  }

  for (const sentinel of byId.values()) {
    if (sentinel.resolvedAt) continue;
    const settledSide = cycle.outcomes?.[`${sentinel.contractId}:${sentinel.closesAt}`];
    if (!settledSide) continue;
    byId.set(sentinel.id, { ...sentinel, resolvedAt: cycle.observedAt, settledSide });
    changed = true;
  }

  if (!changed) return;
  const sentinels = [...byId.values()]
    .sort((left, right) => Date.parse(right.closesAt) - Date.parse(left.closesAt) || left.id.localeCompare(right.id))
    .slice(0, MAX_SENTINELS);
  await writeStore({ ...store, sentinelVersion: HOLD_SENTINEL_VERSION, updatedAt: cycle.observedAt, sentinels });
}

/** Serialized behind its own queue; evidence collection never delays a cycle that has money in it. */
export function updateHoldSentinelStore(cycle: HoldSentinelCycle): Promise<void> {
  const operation = operationQueue.then(() => update(cycle));
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function getHoldSentinelReport(
  policyVersion: string,
  exitFeeCents: (sentinel: HoldSentinel) => number,
): Promise<HoldSentinelReport> {
  const store = await readStore();
  return buildHoldSentinelReport({ sentinels: store.sentinels, policyVersion, exitFeeCents });
}

export async function getHoldSentinels(): Promise<HoldSentinel[]> {
  return (await readStore()).sentinels;
}
