import { observationBucket } from './observation-window';
import type { PositionSide } from './types';

export const CYCLE_DURATION_MS = 15 * 60_000;
export const EXECUTION_WARMUP_MS = 60_000;
export const EXECUTION_LATE_CUTOFF_MS = 120_000;
export const REQUIRED_QUALIFYING_SNAPSHOTS = 3;
export const REQUIRED_OBSERVATION_SPAN_MS = 30_000;
export const MAX_PERSISTENCE_SNAPSHOTS = 4;
export const MAX_EXECUTION_SNAPSHOT_AGE_MS = 30_000;

export interface SignalObservation {
  at: string;
  netEdge: number;
  quality: number;
}

export interface SignalPersistenceState {
  symbol: string;
  side: PositionSide;
  closesAt: string;
  observations: SignalObservation[];
}

export interface SignalEligibility {
  eligible: boolean;
  reason: string;
  cycleAgeMs: number;
  remainingMs: number;
  qualifyingSnapshots: number;
  medianNetEdge: number | null;
}

/**
 * Advances one signal's durable execution evidence. A failed current snapshot resets the streak;
 * repeated processing of the same generatedAt timestamp never manufactures extra persistence.
 */
export function advanceSignalPersistence(state: SignalPersistenceState | undefined, input: {
  symbol: string;
  side: PositionSide;
  closesAt: string;
  calculationAt: string;
  qualifies: boolean;
  netEdge: number;
  quality: number;
}): SignalPersistenceState {
  const current: SignalPersistenceState = state?.closesAt === input.closesAt && state.side === input.side
    ? state
    : { symbol: input.symbol, side: input.side, closesAt: input.closesAt, observations: [] };
  if (!input.qualifies) return { ...current, observations: [] };
  if (current.observations.some((item) => item.at === input.calculationAt)) return current;
  const observations = [...current.observations, { at: input.calculationAt, netEdge: input.netEdge, quality: input.quality }]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_PERSISTENCE_SNAPSHOTS);
  return { ...current, observations };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluateSignalPersistence(state: SignalPersistenceState | undefined, nowMs: number, minimumNetEdge: number, minimumQuality: number): SignalEligibility {
  if (!state) return { eligible: false, reason: 'No persistence observations yet.', cycleAgeMs: 0, remainingMs: 0, qualifyingSnapshots: 0, medianNetEdge: null };
  const closesAtMs = Date.parse(state.closesAt);
  const cycleAgeMs = nowMs - (closesAtMs - CYCLE_DURATION_MS);
  const remainingMs = closesAtMs - nowMs;
  const observations = state.observations.filter((item) => Number.isFinite(Date.parse(item.at)));
  const edges = observations.map((item) => item.netEdge);
  const medianNetEdge = median(edges);
  const base = { cycleAgeMs, remainingMs, qualifyingSnapshots: observations.length, medianNetEdge };
  if (!Number.isFinite(closesAtMs)) return { ...base, eligible: false, reason: 'Contract close time is invalid.' };
  if (cycleAgeMs < EXECUTION_WARMUP_MS) return { ...base, eligible: false, reason: `Cycle warming up: ${Math.max(0, Math.floor(cycleAgeMs / 1000))}/${EXECUTION_WARMUP_MS / 1000}s.` };
  if (remainingMs <= EXECUTION_LATE_CUTOFF_MS) return { ...base, eligible: false, reason: `Inside the final ${EXECUTION_LATE_CUTOFF_MS / 1000}s entry cutoff.` };
  if (observations.length < REQUIRED_QUALIFYING_SNAPSHOTS) return { ...base, eligible: false, reason: `Signal persistence ${observations.length}/${REQUIRED_QUALIFYING_SNAPSHOTS} qualifying snapshots.` };
  const required = observations.slice(-REQUIRED_QUALIFYING_SNAPSHOTS);
  const spanMs = observationBucket(Date.parse(required.at(-1)!.at)) - observationBucket(Date.parse(required[0].at));
  if (spanMs < REQUIRED_OBSERVATION_SPAN_MS) return { ...base, eligible: false, reason: `Signal observations span ${Math.max(0, Math.floor(spanMs / 1000))}/${REQUIRED_OBSERVATION_SPAN_MS / 1000}s.` };
  const latest = observations.at(-1)!;
  if (nowMs - Date.parse(latest.at) > MAX_EXECUTION_SNAPSHOT_AGE_MS) return { ...base, eligible: false, reason: 'Latest persistence snapshot is stale.' };
  if (latest.quality < minimumQuality) return { ...base, eligible: false, reason: `Current estimate quality ${(latest.quality * 100).toFixed(1)}% is below ${(minimumQuality * 100).toFixed(0)}%.` };
  if (medianNetEdge === null || medianNetEdge < minimumNetEdge) return { ...base, eligible: false, reason: `Median edge ${((medianNetEdge ?? 0) * 100).toFixed(1)}pp is below ${(minimumNetEdge * 100).toFixed(0)}pp.` };
  return { ...base, eligible: true, reason: `${observations.length} qualifying snapshots; median edge ${(medianNetEdge * 100).toFixed(1)}pp.` };
}
