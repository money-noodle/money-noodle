import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { venueFeeFraction } from './venue-fee-schedule';
import { ENTRY_FEE_ROLE } from './prediction-policy';
import type { MakerObservationSource, MakerObservedFillSummary, PersistenceCandidateIntent, PersistenceCandidateReport } from './types';

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

/**
 * Observed-fill evidence for one source.
 *
 * Sources are never pooled. The backfill replays a 60-second sampler that has already discarded taker
 * direction, so it can only score the static arm and it fills slightly too often; blending it with live
 * 2-second observation would hide both facts inside one average. See docs/maker-post-observation-design.md §7.
 */
function summarizeObservedFills(intents: PersistenceCandidateIntent[], source: MakerObservationSource): MakerObservedFillSummary {
  const observed = intents.filter((intent) => intent.makerObservationSource === source && intent.makerObservationModel);
  const decided = (outcome: PersistenceCandidateIntent['makerLadderFill']) => outcome === 'filled' || outcome === 'unfilled';
  // Conditional on an observed fill: the only figure here that can contradict the ask benchmark.
  const realized = clustered(
    observed.filter((intent) => intent.makerLadderFill === 'filled' && intent.makerRealizedProfitPerContract !== undefined),
    (intent) => intent.makerRealizedProfitPerContract,
  );
  const settled = (intent: PersistenceCandidateIntent) => decided(intent.makerLadderFill) || decided(intent.makerStaticFill);
  return {
    source,
    observedIntents: observed.filter(settled).length,
    unobservedIntents: observed.filter((intent) => !settled(intent)).length,
    ladderFilled: observed.filter((intent) => intent.makerLadderFill === 'filled').length,
    ladderUnfilled: observed.filter((intent) => intent.makerLadderFill === 'unfilled').length,
    staticFilled: observed.filter((intent) => intent.makerStaticFill === 'filled').length,
    staticUnfilled: observed.filter((intent) => intent.makerStaticFill === 'unfilled').length,
    meanRealizedProfitPerContract: realized.mean,
    realizedStandardError: realized.standardError,
    realizedWindows: realized.windows,
  };
}

/** Settlement return at the bid, with no fill assumption applied to it at all. */
const bidPricedProfit = (intent: PersistenceCandidateIntent): number | undefined =>
  intent.outcome === undefined ? undefined : (intent.outcome === intent.side ? 1 : 0) - intent.bidPrice - intent.estimatedMakerFeeRate;

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
    meanIncrementalBidPricedProfitPerContract: clustered(resolvedIncremental, bidPricedProfit).mean,
    observedFill: summarizeObservedFills(resolvedIncremental, 'live-2s'),
    backfilledFill: summarizeObservedFills(resolvedIncremental, 'depth-experiment-60s'),
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
  // Return at the price the simulated post actually paid, which is a rung of the ladder rather than the
  // bid it started from. The fee role is `ENTRY_FEE_ROLE` like every other figure in this store, so the
  // two are comparable; that role is known wrong and is tracked in docs/entry-gate-fee-design.md, not
  // quietly corrected here where it would flatter this benchmark by about 1.5pp.
  if (intent.makerLadderFill === 'filled' && Number.isFinite(intent.makerLadderFillCents)) {
    const fillPrice = intent.makerLadderFillCents! / 100;
    if (fillPrice > 0 && fillPrice < 1) {
      intent.makerRealizedProfitPerContract = (won ? 1 : 0) - fillPrice - venueFeeFraction('kalshi', fillPrice, ENTRY_FEE_ROLE);
    }
  }
  return true;
}

export interface MakerPostObservationRecord {
  id: string;
  makerObservationModel: string;
  makerObservationSource: MakerObservationSource;
  makerPostCents: number;
  makerQueueAheadCents?: number;
  makerLadderFill: PersistenceCandidateIntent['makerLadderFill'];
  makerLadderFillCents?: number;
  makerLadderFillAt?: string;
  makerStaticFill: PersistenceCandidateIntent['makerStaticFill'];
  makerStaticFillCents?: number;
}

/**
 * Attaches observed-fill evidence to intents that do not already carry it.
 *
 * **Write-once.** An intent that already has an observation is left alone, so a re-run of the backfill
 * cannot overwrite a live 2-second observation with a coarser one, and no observation is ever revised
 * after the fact. Settlement figures are recomputed on the next resolution pass for anything that gains
 * a fill after it resolved.
 */
export function applyMakerPostObservations(
  intents: PersistenceCandidateIntent[],
  observations: MakerPostObservationRecord[],
): number {
  const byId = new Map(intents.map((intent) => [intent.id, intent]));
  let applied = 0;
  for (const observation of observations) {
    const intent = byId.get(observation.id);
    if (!intent || intent.makerObservationModel) continue;
    Object.assign(intent, observation);
    // An intent that settled before its observation landed still needs its conditional return.
    if (intent.outcome && intent.makerLadderFill === 'filled' && Number.isFinite(intent.makerLadderFillCents)) {
      const fillPrice = intent.makerLadderFillCents! / 100;
      if (fillPrice > 0 && fillPrice < 1) {
        intent.makerRealizedProfitPerContract = (intent.outcome === intent.side ? 1 : 0)
          - fillPrice - venueFeeFraction('kalshi', fillPrice, ENTRY_FEE_ROLE);
      }
    }
    applied += 1;
  }
  return applied;
}

/**
 * Removes backfilled observations, and only those.
 *
 * The backfill replays a coarser data source and a defect in that replay must be correctable without
 * hand-editing the store (AGENTS §3). Live observations are never touched, and the decision-time record
 * every intent carries is never touched by either path.
 */
export function clearBackfilledMakerPostObservations(): Promise<number> {
  const operation = operationQueue.then(async () => {
    const store = await readStore(TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION);
    let cleared = 0;
    for (const intent of store.intents) {
      if (intent.makerObservationSource !== 'depth-experiment-60s') continue;
      delete intent.makerObservationModel; delete intent.makerObservationSource;
      delete intent.makerPostCents; delete intent.makerQueueAheadCents;
      delete intent.makerLadderFill; delete intent.makerLadderFillCents; delete intent.makerLadderFillAt;
      delete intent.makerStaticFill; delete intent.makerStaticFillCents;
      delete intent.makerRealizedProfitPerContract;
      cleared += 1;
    }
    if (cleared) {
      store.updatedAt = new Date().toISOString();
      await writeStore(store);
    }
    return cleared;
  });
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Durable write path for observations produced outside a trading cycle, e.g. the one-day backfill. */
export function recordMakerPostObservations(observations: MakerPostObservationRecord[]): Promise<number> {
  const operation = operationQueue.then(async () => {
    if (!observations.length) return 0;
    const store = await readStore(TWO_SNAPSHOT_PERSISTENCE_CANDIDATE_VERSION);
    const applied = applyMakerPostObservations(store.intents, observations);
    if (applied) {
      store.updatedAt = new Date().toISOString();
      await writeStore(store);
    }
    return applied;
  });
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
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
