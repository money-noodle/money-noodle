import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildForecastStoragePlan, verifyForecastStoragePlan } from './forecast-storage';
import { buildSummaryRollup, summarizeFromRollups } from './forecast-rollup';
import { summarizePerformance } from './performance';
import type { TrackedForecast } from './types';

/**
 * The composition the reader depends on: sealed shard statistics plus the open rows reproduce the summary
 * that the rows themselves produce. `summarizeFromStorage` is that composition against files; this pins
 * the algebra it rests on, so a layout change cannot quietly alter a lifetime figure.
 */
let counter = 0;
const forecast = (patch: Partial<TrackedForecast> = {}): TrackedForecast => {
  const index = counter += 1;
  const issuedAt = patch.issuedAt ?? `2026-08-${String(8 + (index % 3)).padStart(2, '0')}T0${index % 9}:00:00.000Z`;
  return {
    id: `f-${index}`,
    cycleId: `cycle-${index % 5}`,
    symbol: ['BTC', 'ETH', 'SOL'][index % 3],
    issuedAt,
    closesAt: '2026-08-11T00:15:00.000Z',
    direction: index % 2 ? 'UP' : 'DOWN',
    probabilityUp: 0.4 + (index % 5) / 20,
    directionalLikelihood: 0.6,
    confidence: 0.5 + (index % 4) / 20,
    modelVersion: 'Blend 0.4',
    policyVersion: 'test-policy',
    trackingPolicyVersion: 'all-qualified-15s-snapshots-v2',
    qualified: index % 4 !== 0,
    status: 'resolved',
    outcome: index % 2 ? 'UP' : 'DOWN',
    correct: index % 3 !== 0,
    brierScore: 0.2,
    logLoss: 0.5,
    marketUrl: 'https://example.test/m',
    factors: [],
    ...patch,
  } as TrackedForecast;
};

describe('sealed statistics plus open rows reproduce the summary', () => {
  const rows = [
    ...Array.from({ length: 40 }, () => forecast()),
    ...Array.from({ length: 6 }, () => forecast({ status: 'pending', outcome: undefined, correct: undefined })),
  ];

  it('matches the direct summary field for field', () => {
    const plan = buildForecastStoragePlan(rows);
    const verification = verifyForecastStoragePlan(rows, plan);
    expect(verification.errors).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  it('folds the open set in as one more rollup rather than special-casing it', () => {
    // This is exactly what `summarizeFromStorage` does once the files are read.
    const plan = buildForecastStoragePlan(rows);
    const composed = summarizeFromRollups([
      ...plan.shards.map((shard) => shard.rollup),
      buildSummaryRollup('open', plan.open),
    ]);
    const direct = summarizePerformance(rows);
    expect(composed.issued).toBe(direct.issued);
    expect(composed.pending).toBe(direct.pending);
    expect(composed.resolved).toBe(direct.resolved);
    expect(composed.cycles).toBe(direct.cycles);
    expect(composed.resolvedWindows).toBe(direct.resolvedWindows);
  });

  it('splits into more than one shard, so the merge is actually exercised', () => {
    // A single-shard fixture would pass while proving nothing about cross-shard merging, which is where
    // cycles, clustered windows, and missed-buy selections can each be counted twice.
    const plan = buildForecastStoragePlan(rows);
    expect(plan.shards.length).toBeGreaterThan(1);
    expect(plan.open.length).toBe(6);
  });

  it('keeps the open set out of the shards, so no row is counted twice', () => {
    const plan = buildForecastStoragePlan(rows);
    const sealedIds = new Set(plan.shards.flatMap((shard) => shard.rows.map((row) => row.id)));
    expect(plan.open.every((row) => !sealedIds.has(row.id))).toBe(true);
    expect(sealedIds.size + plan.open.length).toBe(rows.length);
  });

  it('reports an empty history without inventing a summary', () => {
    const composed = summarizeFromRollups([buildSummaryRollup('open', [])]);
    expect(composed.issued).toBe(0);
    expect(composed.pending).toBe(0);
    expect(composed.resolved).toBe(0);
  });
});
