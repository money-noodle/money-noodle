import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeCyclePath } from './cycle-regime';
import { observationBucket } from './observation-window';
import type { CyclePathPoint, CyclePathRecord, CyclePathReport, CycleRegimeFeatures, Prediction } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CYCLE_PATH_FILE = path.join(DATA_DIR, 'cycle-paths.json');
const CYCLE_DURATION_MS = 15 * 60_000;
const MAX_CYCLES = 1_200;
export const CYCLE_PATH_POLICY_VERSION = 'aligned-15s-observation-only-v1';
let pathQueue: Promise<void> = Promise.resolve();

interface CyclePathStore { version: 1; policyVersion: string; cycles: CyclePathRecord[] }
interface UnderlyingObservation { time: number; prices: Record<string, number> }

async function readStore(): Promise<CyclePathStore> {
  try {
    const parsed = JSON.parse(await readFile(CYCLE_PATH_FILE, 'utf8')) as Partial<CyclePathStore>;
    return { version: 1, policyVersion: CYCLE_PATH_POLICY_VERSION, cycles: Array.isArray(parsed.cycles) ? parsed.cycles : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, policyVersion: CYCLE_PATH_POLICY_VERSION, cycles: [] };
    throw error;
  }
}

async function writeStore(store: CyclePathStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CYCLE_PATH_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2));
  await rename(temporary, CYCLE_PATH_FILE);
}

function cycleId(symbol: string, closesAt: string): string { return `${symbol}:${closesAt}`; }

function pathPoint(time: number, price: number, referencePrice: number, cycleStartMs: number): CyclePathPoint {
  return {
    at: new Date(time).toISOString(), offsetSeconds: (time - cycleStartMs) / 1000,
    price, basisPercent: (price / referencePrice - 1) * 100,
  };
}

async function updateCyclePaths(predictions: Prediction[], history: UnderlyingObservation[], observedAt: number): Promise<Record<string, CycleRegimeFeatures>> {
  const store = await readStore();
  const byId = new Map(store.cycles.map((cycle) => [cycle.id, cycle]));
  const result: Record<string, CycleRegimeFeatures> = {};
  let changed = false;
  for (const prediction of predictions) {
    const closeMs = Date.parse(prediction.market.closesAt);
    const referencePrice = prediction.basis?.referencePrice;
    const currentPrice = prediction.basis?.currentPrice;
    // Only exact quarter-hour contracts are admitted to this dataset.
    if (!Number.isFinite(closeMs) || closeMs % CYCLE_DURATION_MS !== 0 || !(referencePrice && referencePrice > 0) || !(currentPrice && currentPrice > 0)) continue;
    const cycleStartMs = closeMs - CYCLE_DURATION_MS;
    if (observedAt < cycleStartMs || observedAt > closeMs + 30_000) continue;
    const id = cycleId(prediction.symbol, prediction.market.closesAt);
    const existing = byId.get(id) ?? {
      id, symbol: prediction.symbol, cycleStartedAt: new Date(cycleStartMs).toISOString(),
      closesAt: prediction.market.closesAt, referencePrice, points: [],
      features: summarizeCyclePath([]),
    };
    const pointsByBucket = new Map(existing.points.map((point) => [observationBucket(Date.parse(point.at)), point]));
    for (const observation of history) {
      const price = observation.prices[prediction.symbol];
      if (observation.time < cycleStartMs || observation.time > Math.min(observedAt, closeMs) || !(price > 0)) continue;
      pointsByBucket.set(observationBucket(observation.time), pathPoint(observation.time, price, existing.referencePrice, cycleStartMs));
    }
    if (observedAt <= closeMs) pointsByBucket.set(observationBucket(observedAt), pathPoint(observedAt, currentPrice, existing.referencePrice, cycleStartMs));
    const points = [...pointsByBucket.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const features = summarizeCyclePath(points);
    const next: CyclePathRecord = { ...existing, points, features };
    if (JSON.stringify(existing) !== JSON.stringify(next)) changed = true;
    byId.set(id, next);
    result[prediction.symbol] = features;
  }
  if (changed) {
    const cycles = [...byId.values()].sort((a, b) => Date.parse(b.closesAt) - Date.parse(a.closesAt)).slice(0, MAX_CYCLES);
    await writeStore({ version: 1, policyVersion: CYCLE_PATH_POLICY_VERSION, cycles });
  }
  return result;
}

export function recordCyclePathObservations(predictions: Prediction[], history: UnderlyingObservation[], observedAt = Date.now()): Promise<Record<string, CycleRegimeFeatures>> {
  const operation = pathQueue.then(() => updateCyclePaths(predictions, history, observedAt));
  pathQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function getCyclePathReport(nowMs = Date.now()): Promise<CyclePathReport> {
  await pathQueue;
  const store = await readStore();
  const latest = new Map<string, CyclePathRecord>();
  for (const cycle of [...store.cycles].sort((a, b) => Date.parse(b.closesAt) - Date.parse(a.closesAt))) if (!latest.has(cycle.symbol)) latest.set(cycle.symbol, cycle);
  return {
    policyVersion: store.policyVersion,
    totalCycles: store.cycles.length,
    completedCycles: store.cycles.filter((cycle) => Date.parse(cycle.closesAt) <= nowMs).length,
    totalPoints: store.cycles.reduce((sum, cycle) => sum + cycle.points.length, 0),
    latestByAsset: [...latest.values()].map((cycle) => ({ symbol: cycle.symbol, closesAt: cycle.closesAt, features: cycle.features })),
  };
}

/**
 * Regime features for one asset/window, or undefined when that cycle has not been observed. Exposed so
 * an entry decision can record what the path looked like at the moment it was taken, rather than
 * reconstructing it later from a 210MB forecast snapshot.
 */
export async function cycleRegimeFor(symbol: string, closesAt: string): Promise<CycleRegimeFeatures | undefined> {
  const store = await readStore();
  return store.cycles.find((cycle) => cycle.id === cycleId(symbol, closesAt))?.features;
}

export async function getCyclePaths(): Promise<CyclePathRecord[]> {
  await pathQueue;
  return (await readStore()).cycles;
}
