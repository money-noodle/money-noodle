import type { PaperSide } from './paper-pricing.js';
// Pure historical persistence: environment wrappers and sentinel collection removed.
export const CYCLE_DURATION_MS = 900_000;
export const EXECUTION_WARMUP_MS = 90_000;
export const EXECUTION_LATE_CUTOFF_MS = 30_000;
export const MAX_PERSISTENCE_SNAPSHOTS = 4;
export const MAX_EXECUTION_SNAPSHOT_AGE_MS = 30_000;
const observationBucket = (at: number) => Math.floor(at / 15_000) * 15_000;
const edgeSpike = (edge: number, median: number | null) => (median === null ? null : edge - median);
const spikeAdmits = (spike: number | null, maximum: number) =>
  spike !== null && Number.isFinite(spike) && spike + 1e-12 < maximum;
export interface SignalObservation {
  at: string;
  netEdge: number;
  quality: number;
}

export interface SignalPersistenceState {
  symbol: string;
  side: PaperSide;
  closesAt: string;
  observations: SignalObservation[];
}

const canonicalTime = (s: string) =>
  typeof s === 'string' &&
  Number.isSafeInteger(Date.parse(s)) &&
  new Date(Date.parse(s)).toISOString().replace('.000Z', 'Z') === s.replace('.000Z', 'Z');
const validEdge = (n: number) => Number.isFinite(n) && n >= -1 && n <= 1;
const validQuality = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
function validState(state: SignalPersistenceState): boolean {
  return (
    !!state &&
    typeof state.symbol === 'string' &&
    /^[A-Z0-9-]{1,24}$/.test(state.symbol) &&
    ['UP', 'DOWN'].includes(state.side) &&
    canonicalTime(state.closesAt) &&
    Date.parse(state.closesAt) % CYCLE_DURATION_MS === 0 &&
    Array.isArray(state.observations) &&
    state.observations.length <= MAX_PERSISTENCE_SNAPSHOTS &&
    state.observations.every(
      (o, i) =>
        !!o &&
        canonicalTime(o.at) &&
        validEdge(o.netEdge) &&
        validQuality(o.quality) &&
        Date.parse(o.at) >= Date.parse(state.closesAt) - CYCLE_DURATION_MS &&
        Date.parse(o.at) <= Date.parse(state.closesAt) &&
        (i === 0 || Date.parse(o.at) > Date.parse(state.observations[i - 1]!.at)),
    )
  );
}

export function signalPersistenceAfter(
  state: SignalPersistenceState | undefined,
  after: string,
): SignalPersistenceState | undefined {
  if (!state || !validState(state) || !canonicalTime(after)) return undefined;
  return {
    ...state,
    observations: state.observations.filter(
      (observation) => Date.parse(observation.at) > Date.parse(after),
    ),
  };
}

export interface SignalEligibility {
  eligible: boolean;
  reason: string;
  cycleAgeMs: number;
  remainingMs: number;
  qualifyingSnapshots: number;
  medianNetEdge: number | null;

  edgeSpike: number | null;
}

export interface SignalPersistenceRequirements {
  requiredSnapshots: number;
  requiredSpanMs: number;

  maximumEdgeSpike: number;

  spikeGateEnabled: boolean;
}

export function advanceSignalPersistence(
  state: SignalPersistenceState | undefined,
  input: {
    symbol: string;
    side: PaperSide;
    closesAt: string;
    calculationAt: string;
    qualifies: boolean;
    netEdge: number;
    quality: number;
  },
): SignalPersistenceState {
  if (
    (state && !validState(state)) ||
    typeof input.qualifies !== 'boolean' ||
    !canonicalTime(input.calculationAt) ||
    !validState({
      symbol: input.symbol,
      side: input.side,
      closesAt: input.closesAt,
      observations: [{ at: input.calculationAt, netEdge: input.netEdge, quality: input.quality }],
    })
  )
    throw new Error('Invalid bounded paper persistence observation.');
  const current: SignalPersistenceState =
    state?.symbol === input.symbol &&
    Date.parse(state.closesAt) === Date.parse(input.closesAt) &&
    state.side === input.side
      ? state
      : { symbol: input.symbol, side: input.side, closesAt: input.closesAt, observations: [] };
  if (!input.qualifies) return { ...current, observations: [] };
  if (current.observations.some((item) => Date.parse(item.at) === Date.parse(input.calculationAt)))
    return current;
  const observations = [
    ...current.observations,
    { at: input.calculationAt, netEdge: input.netEdge, quality: input.quality },
  ]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_PERSISTENCE_SNAPSHOTS);
  return { ...current, observations };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function evaluateSignalPersistenceWithRequirements(
  state: SignalPersistenceState | undefined,
  nowMs: number,
  minimumNetEdge: number,
  minimumQuality: number,
  requirements: SignalPersistenceRequirements,
): SignalEligibility {
  if (!state)
    return {
      eligible: false,
      reason: 'No persistence observations yet.',
      cycleAgeMs: 0,
      remainingMs: 0,
      qualifyingSnapshots: 0,
      medianNetEdge: null,
      edgeSpike: null,
    };
  if (
    !validState(state) ||
    !Number.isSafeInteger(nowMs) ||
    !validEdge(minimumNetEdge) ||
    !validQuality(minimumQuality) ||
    requirements.maximumEdgeSpike > 2 ||
    requirements.requiredSpanMs > CYCLE_DURATION_MS ||
    typeof requirements.spikeGateEnabled !== 'boolean' ||
    ![
      minimumNetEdge,
      minimumQuality,
      requirements.maximumEdgeSpike,
      requirements.requiredSpanMs,
    ].every(Number.isFinite) ||
    !Number.isSafeInteger(requirements.requiredSnapshots) ||
    requirements.requiredSnapshots < 1 ||
    requirements.requiredSnapshots > MAX_PERSISTENCE_SNAPSHOTS ||
    requirements.requiredSpanMs < 0 ||
    requirements.maximumEdgeSpike < 0 ||
    state.observations.length > MAX_PERSISTENCE_SNAPSHOTS ||
    state.observations.some(
      (o, i) =>
        ![o.netEdge, o.quality, Date.parse(o.at)].every(Number.isFinite) ||
        Date.parse(o.at) > nowMs ||
        (i > 0 && Date.parse(o.at) <= Date.parse(state.observations[i - 1]!.at)),
    )
  ) {
    return {
      eligible: false,
      reason: 'Invalid paper persistence inputs.',
      cycleAgeMs: 0,
      remainingMs: 0,
      qualifyingSnapshots: 0,
      medianNetEdge: null,
      edgeSpike: null,
    };
  }
  const closesAtMs = Date.parse(state.closesAt);
  const cycleAgeMs = nowMs - (closesAtMs - CYCLE_DURATION_MS);
  const remainingMs = closesAtMs - nowMs;
  const observations = state.observations.filter((item) => Number.isFinite(Date.parse(item.at)));
  const edges = observations.map((item) => item.netEdge);
  const medianNetEdge = median(edges);

  const currentNetEdge = observations.at(-1)?.netEdge;
  const spike = currentNetEdge === undefined ? null : edgeSpike(currentNetEdge, medianNetEdge);
  const base = {
    cycleAgeMs,
    remainingMs,
    qualifyingSnapshots: observations.length,
    medianNetEdge,
    edgeSpike: spike,
  };
  if (!Number.isFinite(closesAtMs))
    return { ...base, eligible: false, reason: 'Contract close time is invalid.' };
  if (cycleAgeMs < EXECUTION_WARMUP_MS)
    return {
      ...base,
      eligible: false,
      reason: `Cycle warming up: ${Math.max(0, Math.floor(cycleAgeMs / 1000))}/${EXECUTION_WARMUP_MS / 1000}s.`,
    };
  if (remainingMs <= EXECUTION_LATE_CUTOFF_MS)
    return {
      ...base,
      eligible: false,
      reason: `Inside the final ${EXECUTION_LATE_CUTOFF_MS / 1000}s entry cutoff.`,
    };
  if (observations.length < requirements.requiredSnapshots)
    return {
      ...base,
      eligible: false,
      reason: `Signal persistence ${observations.length}/${requirements.requiredSnapshots} qualifying snapshots.`,
    };
  const required = observations.slice(-requirements.requiredSnapshots);
  const spanMs =
    observationBucket(Date.parse(required.at(-1)!.at)) -
    observationBucket(Date.parse(required[0]!.at));
  if (spanMs < requirements.requiredSpanMs)
    return {
      ...base,
      eligible: false,
      reason: `Signal observations span ${Math.max(0, Math.floor(spanMs / 1000))}/${requirements.requiredSpanMs / 1000}s.`,
    };
  const latest = observations.at(-1)!;
  if (nowMs - Date.parse(latest.at) > MAX_EXECUTION_SNAPSHOT_AGE_MS)
    return { ...base, eligible: false, reason: 'Latest persistence snapshot is stale.' };
  if (latest.quality < minimumQuality)
    return {
      ...base,
      eligible: false,
      reason: `Current estimate quality ${(latest.quality * 100).toFixed(1)}% is below ${(minimumQuality * 100).toFixed(0)}%.`,
    };
  if (medianNetEdge === null || medianNetEdge < minimumNetEdge)
    return {
      ...base,
      eligible: false,
      reason: `Median edge ${((medianNetEdge ?? 0) * 100).toFixed(1)}pp is below ${(minimumNetEdge * 100).toFixed(0)}pp.`,
    };

  if (requirements.spikeGateEnabled && !spikeAdmits(spike, requirements.maximumEdgeSpike))
    return {
      ...base,
      eligible: false,
      reason: `Edge ${((spike ?? 0) * 100).toFixed(1)}pp above its persistence median exceeds the ${(requirements.maximumEdgeSpike * 100).toFixed(1)}pp freshness ceiling.`,
    };
  return {
    ...base,
    eligible: true,
    reason: `${observations.length} qualifying snapshots; median edge ${(medianNetEdge * 100).toFixed(1)}pp; edge ${((spike ?? 0) * 100).toFixed(1)}pp from median.`,
  };
}
