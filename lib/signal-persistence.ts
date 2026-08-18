import { edgeSpike, edgeSpikeGateEnabled, maximumEdgeSpike, spikeAdmits } from './edge-spike-policy';
import { observationBucket } from './observation-window';
import type { PositionSide } from './types';

export const CYCLE_DURATION_MS = 15 * 60_000;
export const EXECUTION_WARMUP_MS = 90_000;
/**
 * No new entry inside this much of the close.
 *
 * **Shortened from 120s to 30s at v20.** The 248 decisions the 120s cutoff refused returned +19.8% ±12.0
 * held to settlement and were positive on 8 of 8 days — the most day-stable increment measured.
 *
 * **The operational risk this accepts is real and is not covered by that measurement.** The figure is at
 * the ask, held to settlement. Production rests a maker order: with 30 seconds left there is no time to
 * reprice, no time for the bounded retry (`MAKER_RETRY_LATE_CUTOFF_MS` still refuses a retry inside 120s),
 * and no time to exit — a position taken here is held to settlement whether or not the exit rule would
 * have sold it. Exit availability in that band was 64% against 82% for the population as a whole.
 */
export const EXECUTION_LATE_CUTOFF_MS = 30_000;
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
  /**
   * Firing edge minus its persistence median. Reported whether or not it decides eligibility, so the
   * sentinel can record the continuous value on decisions the gate admits as well as ones it refuses.
   */
  edgeSpike: number | null;
}

export interface SignalPersistenceRequirements {
  requiredSnapshots: number;
  requiredSpanMs: number;
  /**
   * Declared rather than read from a constant here, so a candidate lane that calls this evaluator
   * directly states what it is holding fixed instead of silently inheriting a production gate.
   */
  maximumEdgeSpike: number;
  /**
   * Whether the spike ceiling may refuse an entry at all.
   *
   * A separate field from the ceiling because the two answer different questions: the ceiling is where the
   * gate sits, this is whether it is armed. Declared here rather than read from the environment inside the
   * evaluator so this function stays pure and a caller states what it is holding fixed — the first version
   * of the v19 disarm read `process.env` inside the evaluator and made the rule untestable from a fixture.
   */
  spikeGateEnabled: boolean;
}

/**
 * A function rather than a constant: the spike ceiling is operator-configurable, and a module-level
 * constant would freeze whatever the environment held at import time, leaving the policy manifest able to
 * describe a gate the desk is not running.
 */
export function productionSignalPersistence(): SignalPersistenceRequirements {
  return {
    requiredSnapshots: REQUIRED_QUALIFYING_SNAPSHOTS,
    requiredSpanMs: REQUIRED_OBSERVATION_SPAN_MS,
    maximumEdgeSpike: maximumEdgeSpike(),
    spikeGateEnabled: edgeSpikeGateEnabled(),
  };
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

export function evaluateSignalPersistenceWithRequirements(
  state: SignalPersistenceState | undefined,
  nowMs: number,
  minimumNetEdge: number,
  minimumQuality: number,
  requirements: SignalPersistenceRequirements,
): SignalEligibility {
  if (!state) return { eligible: false, reason: 'No persistence observations yet.', cycleAgeMs: 0, remainingMs: 0, qualifyingSnapshots: 0, medianNetEdge: null, edgeSpike: null };
  const closesAtMs = Date.parse(state.closesAt);
  const cycleAgeMs = nowMs - (closesAtMs - CYCLE_DURATION_MS);
  const remainingMs = closesAtMs - nowMs;
  const observations = state.observations.filter((item) => Number.isFinite(Date.parse(item.at)));
  const edges = observations.map((item) => item.netEdge);
  const medianNetEdge = median(edges);
  // Reported on every outcome, not only the one it decides, so the sentinel can record the continuous
  // value for admitted and refused decisions alike from a single evaluation.
  const currentNetEdge = observations.at(-1)?.netEdge;
  const spike = currentNetEdge === undefined ? null : edgeSpike(currentNetEdge, medianNetEdge);
  const base = { cycleAgeMs, remainingMs, qualifyingSnapshots: observations.length, medianNetEdge, edgeSpike: spike };
  if (!Number.isFinite(closesAtMs)) return { ...base, eligible: false, reason: 'Contract close time is invalid.' };
  if (cycleAgeMs < EXECUTION_WARMUP_MS) return { ...base, eligible: false, reason: `Cycle warming up: ${Math.max(0, Math.floor(cycleAgeMs / 1000))}/${EXECUTION_WARMUP_MS / 1000}s.` };
  if (remainingMs <= EXECUTION_LATE_CUTOFF_MS) return { ...base, eligible: false, reason: `Inside the final ${EXECUTION_LATE_CUTOFF_MS / 1000}s entry cutoff.` };
  if (observations.length < requirements.requiredSnapshots) return { ...base, eligible: false, reason: `Signal persistence ${observations.length}/${requirements.requiredSnapshots} qualifying snapshots.` };
  const required = observations.slice(-requirements.requiredSnapshots);
  const spanMs = observationBucket(Date.parse(required.at(-1)!.at)) - observationBucket(Date.parse(required[0].at));
  if (spanMs < requirements.requiredSpanMs) return { ...base, eligible: false, reason: `Signal observations span ${Math.max(0, Math.floor(spanMs / 1000))}/${requirements.requiredSpanMs / 1000}s.` };
  const latest = observations.at(-1)!;
  if (nowMs - Date.parse(latest.at) > MAX_EXECUTION_SNAPSHOT_AGE_MS) return { ...base, eligible: false, reason: 'Latest persistence snapshot is stale.' };
  if (latest.quality < minimumQuality) return { ...base, eligible: false, reason: `Current estimate quality ${(latest.quality * 100).toFixed(1)}% is below ${(minimumQuality * 100).toFixed(0)}%.` };
  if (medianNetEdge === null || medianNetEdge < minimumNetEdge) return { ...base, eligible: false, reason: `Median edge ${((medianNetEdge ?? 0) * 100).toFixed(1)}pp is below ${(minimumNetEdge * 100).toFixed(0)}pp.` };
  // Last, so every cheaper check reports its own reason first and the spike arm is not polluted by
  // decisions that would have been refused anyway. See docs/edge-spike-sentinel-design.md §3.
  // The spike is always measured and always reported, so the sentinel keeps recording whether or not the
  // gate is armed. Only the refusal is conditional.
  if (requirements.spikeGateEnabled && !spikeAdmits(spike, requirements.maximumEdgeSpike)) return {
    ...base, eligible: false,
    reason: `Edge ${((spike ?? 0) * 100).toFixed(1)}pp above its persistence median exceeds the ${(requirements.maximumEdgeSpike * 100).toFixed(1)}pp freshness ceiling.`,
  };
  return { ...base, eligible: true, reason: `${observations.length} qualifying snapshots; median edge ${(medianNetEdge * 100).toFixed(1)}pp; edge ${((spike ?? 0) * 100).toFixed(1)}pp from median.` };
}

/** Production remains on three snapshots; candidates call the explicit evaluator above. */
export function evaluateSignalPersistence(state: SignalPersistenceState | undefined, nowMs: number, minimumNetEdge: number, minimumQuality: number): SignalEligibility {
  return evaluateSignalPersistenceWithRequirements(state, nowMs, minimumNetEdge, minimumQuality, productionSignalPersistence());
}

/**
 * Production's requirements with the freshness ceiling lifted, which is what the sentinel scores.
 *
 * The declined arm has to be built from an evaluation that reaches the spike check, so that both arms
 * come from one code path on one population. Anything refused earlier belongs in neither arm.
 */
export function evaluateSignalPersistenceIgnoringSpike(state: SignalPersistenceState | undefined, nowMs: number, minimumNetEdge: number, minimumQuality: number): SignalEligibility {
  return evaluateSignalPersistenceWithRequirements(state, nowMs, minimumNetEdge, minimumQuality, {
    ...productionSignalPersistence(), maximumEdgeSpike: Number.POSITIVE_INFINITY,
  });
}
