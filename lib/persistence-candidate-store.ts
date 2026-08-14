import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PersistenceCandidateIntent, PersistenceCandidateReport } from './types';

export const TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION = 'persistence-two-consecutive-v1';
export const PERSISTENCE_CANDIDATE_MINIMUM_REVIEW_WINDOWS = 100;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'persistence-candidate.json');
const MAX_INTENTS = 10_000;
let operationQueue: Promise<void> = Promise.resolve();

interface PersistenceCandidateStore {
  version: 1;
  initialized: boolean;
  candidateVersion: string;
  productionPolicyVersion: string;
  startedAt: string;
  updatedAt: string;
  intents: PersistenceCandidateIntent[];
}

export interface PersistenceCandidateCycle {
  productionPolicyVersion: string;
  observedAt: string;
  intents: PersistenceCandidateIntent[];
  productionEligibleIds: string[];
}

const emptyStore = (productionPolicyVersion: string): PersistenceCandidateStore => ({
  version: 1,
  initialized: false,
  candidateVersion: TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION,
  productionPolicyVersion,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  intents: [],
});

async function readStore(productionPolicyVersion: string): Promise<PersistenceCandidateStore> {
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8')) as Partial<PersistenceCandidateStore>;
    if (!Array.isArray(parsed.intents)) throw new Error('Persistence candidate store has no intent collection.');
    return {
      version: 1,
      initialized: true,
      candidateVersion: parsed.candidateVersion ?? TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION,
      productionPolicyVersion: parsed.productionPolicyVersion ?? productionPolicyVersion,
      startedAt: parsed.startedAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      intents: parsed.intents,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore(productionPolicyVersion);
    await rename(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Persistence candidate store was malformed and has been quarantined:', error);
    return emptyStore(productionPolicyVersion);
  }
}

async function writeStore(store: PersistenceCandidateStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2));
  await rename(temporary, STORE_FILE);
}

function normalizedClose(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function clustered(intents: PersistenceCandidateIntent[], value: (intent: PersistenceCandidateIntent) => number | undefined) {
  const windows = new Map<string, number[]>();
  for (const intent of intents) {
    const result = value(intent);
    if (!Number.isFinite(result)) continue;
    const key = normalizedClose(intent.closesAt);
    windows.set(key, [...(windows.get(key) ?? []), result!]);
  }
  const values = [...windows.values()].map((items) => mean(items)!);
  const average = mean(values);
  const standardError = average !== null && values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { windows: windows.size, mean: average, standardError };
}

/** Pure report builder used by the API and tests; sample readiness can never change production. */
export function buildPersistenceCandidateReport(store: Pick<PersistenceCandidateStore, 'candidateVersion' | 'productionPolicyVersion' | 'startedAt' | 'updatedAt' | 'intents'>): PersistenceCandidateReport {
  // A production policy change starts a new evidence cohort. Persistence cannot be credited with
  // outcomes generated under different probability, edge, side, asset, or regime rules.
  const current = store.intents.filter((intent) => intent.candidateVersion === store.candidateVersion
    && intent.productionPolicyVersion === store.productionPolicyVersion);
  const resolved = current.filter((intent) => intent.resolvedAt && intent.askProfitPerContract !== undefined);
  const incremental = current.filter((intent) => !intent.productionEligibleAtCandidate);
  const resolvedIncremental = incremental.filter((intent) => intent.resolvedAt && intent.askProfitPerContract !== undefined);
  const ask = clustered(resolved, (intent) => intent.askProfitPerContract);
  const maker = clustered(resolved, (intent) => intent.makerExpectedProfitPerContract);
  const incrementalAsk = clustered(resolvedIncremental, (intent) => intent.askProfitPerContract);
  const incrementalMaker = clustered(resolvedIncremental, (intent) => intent.makerExpectedProfitPerContract);
  const caughtUp = incremental.filter((intent) => intent.productionEligibleAt).length;
  return {
    candidateVersion: store.candidateVersion,
    productionPolicyVersion: store.productionPolicyVersion,
    startedAt: store.startedAt,
    updatedAt: store.updatedAt,
    candidateIntents: current.length,
    incrementalIntents: incremental.length,
    productionCaughtUp: caughtUp,
    meanProductionDelayMs: mean(incremental.flatMap((intent) => intent.productionDelayMs === undefined ? [] : [intent.productionDelayMs])),
    modelledMakerIntents: current.filter((intent) => Number.isFinite(intent.makerFillProbability)).length,
    resolvedIntents: resolved.length,
    resolvedWindows: ask.windows,
    resolvedIncrementalIntents: resolvedIncremental.length,
    resolvedIncrementalWindows: incrementalAsk.windows,
    meanAskProfitPerContract: ask.mean,
    meanMakerExpectedProfitPerContract: maker.mean,
    meanIncrementalAskProfitPerContract: incrementalAsk.mean,
    meanIncrementalMakerExpectedProfitPerContract: incrementalMaker.mean,
    incrementalAskStandardError: incrementalAsk.standardError,
    minimumReviewWindows: PERSISTENCE_CANDIDATE_MINIMUM_REVIEW_WINDOWS,
    reviewReady: incrementalAsk.windows >= PERSISTENCE_CANDIDATE_MINIMUM_REVIEW_WINDOWS,
    productionChanged: false,
    recent: [...current].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30),
  };
}

async function resolveIntent(intent: PersistenceCandidateIntent): Promise<boolean> {
  if (intent.resolvedAt || intent.invalidReason || Date.parse(intent.closesAt) > Date.now()) return false;
  const baseUrl = (process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/markets/${encodeURIComponent(intent.contractId)}`, {
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
  });
  if (!response.ok) return false;
  const body = await response.json() as { market?: { result?: string } };
  const result = body.market?.result?.toLowerCase();
  const outcome = result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : undefined;
  if (!outcome) return false;
  const won = outcome === intent.side;
  intent.outcome = outcome;
  intent.resolvedAt = new Date().toISOString();
  intent.askProfitPerContract = (won ? 1 : 0) - intent.askPrice - intent.estimatedAskFeeRate;
  const makerReturn = (won ? 1 : 0) - intent.bidPrice - intent.estimatedMakerFeeRate;
  intent.makerExpectedProfitPerContract = Number.isFinite(intent.makerFillProbability)
    ? makerReturn * intent.makerFillProbability!
    : undefined;
  return true;
}

/**
 * Observation-only prospective collector. It writes a separate ledger, places no order, reserves no
 * budget, and has no return path into production policy. Callers deliberately do not await it.
 */
export function updatePersistenceCandidateStore(cycle: PersistenceCandidateCycle): Promise<PersistenceCandidateReport> {
  const operation = operationQueue.then(async () => {
    const store = await readStore(cycle.productionPolicyVersion);
    let changed = false;
    if (!store.initialized) {
      store.initialized = true;
      changed = true;
    }
    if (store.productionPolicyVersion !== cycle.productionPolicyVersion
      || store.candidateVersion !== TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION) {
      store.productionPolicyVersion = cycle.productionPolicyVersion;
      store.candidateVersion = TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION;
      store.startedAt = new Date().toISOString();
      changed = true;
    }
    const byId = new Map(store.intents.map((intent) => [intent.id, intent]));
    const productionEligible = new Set(cycle.productionEligibleIds);
    const now = Date.now();

    for (const intent of store.intents) {
      if (!intent.productionEligibleAt && productionEligible.has(intent.id)) {
        intent.productionEligibleAt = cycle.observedAt;
        intent.productionDelayMs = Math.max(0, Date.parse(intent.productionEligibleAt) - Date.parse(intent.createdAt));
        changed = true;
      }
    }

    for (const intent of cycle.intents) {
      if (byId.has(intent.id)) continue;
      store.intents.push(intent);
      byId.set(intent.id, intent);
      changed = true;
    }

    // Commit decision-time evidence before making any settlement request. A slow API or process crash
    // may delay an outcome patch, but can never erase that the candidate qualified when it did.
    if (changed) {
      store.updatedAt = new Date().toISOString();
      store.intents = store.intents.slice(-MAX_INTENTS);
      await writeStore(store);
      changed = false;
    }

    const due = store.intents.filter((intent) => !intent.resolvedAt && !intent.invalidReason && Date.parse(intent.closesAt) <= now).slice(0, 50);
    const resolutions = await Promise.allSettled(due.map((intent) => resolveIntent(intent)));
    if (resolutions.some((result) => result.status === 'fulfilled' && result.value)) changed = true;
    if (changed) {
      store.updatedAt = new Date().toISOString();
      await writeStore(store);
    }
    return buildPersistenceCandidateReport(store);
  });
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function getPersistenceCandidateReport(productionPolicyVersion: string): Promise<PersistenceCandidateReport> {
  const operation = operationQueue.then(async () => buildPersistenceCandidateReport(await readStore(productionPolicyVersion)));
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
