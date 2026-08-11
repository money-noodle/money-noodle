import { DATA_FRESHNESS } from './freshness';

export const OBSERVATION_INTERVAL_MS = DATA_FRESHNESS.observationBucketMs;
export const TRACKING_POLICY_VERSION = 'all-qualified-15s-snapshots-v2';

export function observationBucket(observedAt: number): number {
  return Math.floor(observedAt / OBSERVATION_INTERVAL_MS) * OBSERVATION_INTERVAL_MS;
}

export function signalObservationId(cycleId: string, observedAt: number): string {
  return `${cycleId}:${observationBucket(observedAt)}`;
}

/**
 * Non-qualifying calculations exist to measure calibration, so they are sampled once a minute.
 * Consecutive 15-second samples are almost perfectly autocorrelated and would inflate the apparent
 * sample size while bloating durable storage.
 */
export const CALCULATION_SNAPSHOT_INTERVAL_MS = 60_000;

export function calculationObservationId(cycleId: string, observedAt: number): string {
  return `calc:${cycleId}:${Math.floor(observedAt / CALCULATION_SNAPSHOT_INTERVAL_MS) * CALCULATION_SNAPSHOT_INTERVAL_MS}`;
}
