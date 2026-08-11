import { describe, expect, it } from 'vitest';
import type { TrackedForecast } from './types';
import {
  buildWalkForwardDataset, candidateProbability, PRODUCTION_BASELINE_PARAMETERS,
  runWalkForwardEvaluation, scoreWalkForward, WALK_FORWARD_CANDIDATES,
} from './walk-forward';

function forecast(index: number, patch: Partial<TrackedForecast> = {}): TrackedForecast {
  const closeMs = Date.parse('2026-01-01T00:00:00Z') + (index + 1) * 15 * 60_000;
  const up = index % 2 === 0;
  return {
    id: `BTC:${index}`, cycleId: `BTC:${index}`, symbol: 'BTC', marketUrl: `https://example.com/btc-${index}`,
    issuedAt: new Date(closeMs - 300_000).toISOString(), closesAt: new Date(closeMs).toISOString(), secondsRemaining: 300,
    direction: up ? 'UP' : 'DOWN', probabilityUp: up ? 0.72 : 0.28, directionalLikelihood: 0.72,
    basisProbabilityUp: up ? 0.68 : 0.32, confidence: 0.7, modelVersion: 'production', policyVersion: 'v9',
    polymarketProbabilityUp: 0.5, entryAsk: up ? 0.55 : 0.2, entryFeeRate: 0.01,
    factors: [], status: 'resolved', outcome: up ? 'UP' : 'DOWN', correct: true, ...patch,
  };
}

describe('walk-forward evaluation', () => {
  it('includes production and volatility/cap replay candidates without venue-price parameters', () => {
    expect(WALK_FORWARD_CANDIDATES).toContainEqual(PRODUCTION_BASELINE_PARAMETERS);
    expect(new Set(WALK_FORWARD_CANDIDATES.map((candidate) => candidate.volatilityScale))).toEqual(new Set([0.8, 1, 1.2]));
    expect(new Set(WALK_FORWARD_CANDIDATES.map((candidate) => candidate.probabilityCap))).toEqual(new Set([0.03, 0.05]));
    expect(Object.keys(WALK_FORWARD_CANDIDATES[0])).not.toContain('venueWeight');
  });

  it('selects one fixed-horizon snapshot per asset and groups correlated assets by close', () => {
    const first = forecast(0, { id: 'BTC:early', secondsRemaining: 600, issuedAt: '2026-01-01T00:05:00Z' });
    const target = forecast(0, { id: 'BTC:target' });
    const eth = forecast(0, { id: 'ETH:target', cycleId: 'ETH:0', symbol: 'ETH' });
    const dataset = buildWalkForwardDataset([first, target, eth]);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].rows).toHaveLength(2);
    expect(dataset[0].rows.find((row) => row.symbol === 'BTC')?.id).toBe('BTC:target');
  });

  it('selects at most one largest apparent edge inside a correlated window', () => {
    const dataset = buildWalkForwardDataset([
      forecast(0),
      forecast(0, { id: 'ETH:0', cycleId: 'ETH:0', symbol: 'ETH', probabilityUp: 0.8 }),
    ]);
    const score = scoreWalkForward(dataset, PRODUCTION_BASELINE_PARAMETERS);
    expect(score.windows).toBe(1);
    expect(score.observations).toBe(2);
    expect(score.trades).toBe(1);
  });

  it('never scores a real venue entry against a legacy or mismatched venue outcome', () => {
    const legacy = buildWalkForwardDataset([forecast(0, {
      entryVenue: 'kalshi', evaluationVenue: 'polymarket', targetIntegrity: 'legacy-polymarket',
    })]);
    expect(scoreWalkForward(legacy, PRODUCTION_BASELINE_PARAMETERS).trades).toBe(0);

    const exact = buildWalkForwardDataset([forecast(0, {
      entryVenue: 'kalshi', evaluationVenue: 'kalshi', targetIntegrity: 'venue-specific',
    })]);
    expect(scoreWalkForward(exact, PRODUCTION_BASELINE_PARAMETERS).trades).toBe(1);
  });

  it('applies only venue-independent probability transformations', () => {
    const row = buildWalkForwardDataset([forecast(0)])[0].rows[0];
    const parameters = { ...PRODUCTION_BASELINE_PARAMETERS, basisWeight: 0.65 };
    const before = candidateProbability(row, parameters);
    const after = candidateProbability({ ...row, entryAsk: 0.95, entryFeeRate: 0.04 }, parameters);
    expect(after).toBe(before);
  });

  it('uses expanding chronological folds and never changes production', () => {
    const dataset = buildWalkForwardDataset(Array.from({ length: 100 }, (_, index) => forecast(index)));
    const run = runWalkForwardEvaluation(dataset, 100, '2026-02-10T00:00:00Z');
    expect(run.folds).toHaveLength(5);
    expect(run.folds.map((fold) => [fold.trainingWindows, fold.testingWindows])).toEqual([
      [50, 10], [60, 10], [70, 10], [80, 10], [90, 10],
    ]);
    expect(run.folds[0].testStartsAt).toBe(dataset[50].closesAt);
    expect(run.folds.at(-1)?.testEndsAt).toBe(dataset[99].closesAt);
    expect(run.baseline.windows).toBe(50);
    expect(run.candidate.windows).toBe(50);
    expect(run.productionChanged).toBe(false);
    expect(run.datasetFingerprint).toMatch(/^fnv1a-/);
  });

  it('refuses to evaluate before its formal checkpoint', () => {
    const dataset = buildWalkForwardDataset(Array.from({ length: 99 }, (_, index) => forecast(index)));
    expect(() => runWalkForwardEvaluation(dataset, 100)).toThrow(/requires 100 resolved windows/);
  });
});
