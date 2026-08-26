import { describe, expect, it } from 'vitest';
import type { TrackedForecast } from './types';
import {
  buildWalkForwardDataset, candidateProbability, PRODUCTION_BASELINE_PARAMETERS,
  runWalkForwardEvaluation, scoreWalkForward, selectedTrade, WALK_FORWARD_CANDIDATES,
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

  it('exposes the exact selected row and economics to read-only review tooling', () => {
    const window = buildWalkForwardDataset([forecast(0)])[0];
    expect(selectedTrade(window, PRODUCTION_BASELINE_PARAMETERS)).toMatchObject({
      rowId: 'BTC:0', symbol: 'BTC', side: 'UP', cost: 0.56,
    });
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

/**
 * The evaluator's baseline must be the gate the desk actually runs, and it must score the unit the desk
 * actually sizes in. Both were wrong until 2026-08-18, and the existing suite did not notice: none of its
 * assertions touched `meanWindowReturn`, so changing the scoring unit outright left every test green.
 * See reports/edge-magnitude-2026-08-18.md.
 */
describe('the evaluator baseline is the production gate', () => {
  const admitted = (patch: Partial<TrackedForecast>, parameters = PRODUCTION_BASELINE_PARAMETERS) =>
    scoreWalkForward(buildWalkForwardDataset([forecast(0, patch)]), parameters).trades;

  it('tracks maximumNetEdge(), which v20 disarmed', () => {
    // probabilityUp 0.99 against a 0.20 ask is a ~78pp edge. v20 admits it: the baseline ceiling is 1.
    expect(PRODUCTION_BASELINE_PARAMETERS.maximumEdge).toBe(1);
    expect(admitted({ probabilityUp: 0.99, entryAsk: 0.2, entrySide: 'UP' })).toBe(1);
    // Tightening only that bound refuses it, which is what proves the ceiling is the binding rule.
    expect(admitted({ probabilityUp: 0.99, entryAsk: 0.2, entrySide: 'UP' },
      { ...PRODUCTION_BASELINE_PARAMETERS, maximumEdge: 0.35 })).toBe(0);
  });

  it('refuses a selected side below the probability floor, as MIN_SELECTED_SIDE_PROBABILITY does', () => {
    // A 54% side clears the edge test against a cheap ask but not the floor v13 restored.
    expect(admitted({ probabilityUp: 0.54, entryAsk: 0.4, entrySide: 'UP', entryFeeRate: 0 })).toBe(0);
    expect(admitted({ probabilityUp: 0.54, entryAsk: 0.4, entrySide: 'UP', entryFeeRate: 0 },
      { ...PRODUCTION_BASELINE_PARAMETERS, minimumSelectedProbability: 0.5 })).toBe(1);
  });

  it('keeps both bounds fixed across the candidate sweep rather than tuning them', () => {
    // Sweeping a gate bound would let the search rediscover a policy by fitting it; that belongs in the
    // manifest, not in a candidate set.
    expect(new Set(WALK_FORWARD_CANDIDATES.map((c) => c.maximumEdge)).size).toBe(1);
    expect(new Set(WALK_FORWARD_CANDIDATES.map((c) => c.minimumSelectedProbability)).size).toBe(1);
  });
});

describe('scoring is per dollar committed', () => {
  /**
   * The defect this pins: `(won ? 1 : 0) - cost` is profit per contract, but the desk sizes by stake. A
   * win at cost 0.20 returns 4.00 per dollar and 0.80 per contract; at cost 0.80 it returns 0.25 and 0.20.
   * Per contract the two rank almost together, per dollar they differ sixteenfold — and that is the axis
   * on which return per dollar rises with edge while win rate falls.
   */
  /**
   * Prices are chosen inside what the gate can actually admit. The 0.55 side floor and the 0.35 edge
   * ceiling together make any cost at or below 0.20 unreachable — `cost > sideProbability - 0.35 >= 0.20`
   * — so a "cheap" fixture has to mean cheap *within the admissible band*, not cheap in the abstract.
   */
  const scoreOne = (probabilityUp: number, entryAsk: number, outcome: 'UP' | 'DOWN') =>
    scoreWalkForward(buildWalkForwardDataset([
      forecast(0, { probabilityUp, entryAsk, entryFeeRate: 0, outcome, direction: 'UP', entrySide: 'UP' }),
    ]), PRODUCTION_BASELINE_PARAMETERS).meanWindowReturn;

  it('scores a cheaper win above a dearer one at the same edge', () => {
    // Both carry a 10pp edge. cost 0.45 -> (1 - 0.45)/0.45 = 1.222 ; cost 0.60 -> 0.667.
    expect(scoreOne(0.55, 0.45, 'UP')).toBeCloseTo(0.55 / 0.45, 6);
    expect(scoreOne(0.70, 0.60, 'UP')).toBeCloseTo(0.40 / 0.60, 6);
  });

  it('scores any loss as the whole stake, whatever it cost', () => {
    expect(scoreOne(0.55, 0.45, 'DOWN')).toBeCloseTo(-1, 6);
    expect(scoreOne(0.70, 0.60, 'DOWN')).toBeCloseTo(-1, 6);
  });

  it('is not the per-contract figure it replaced', () => {
    // Per contract both wins score 0.55 and 0.40; per dollar they are 1.222 and 0.667. Guards the
    // regression directly rather than only asserting the new value.
    expect(scoreOne(0.55, 0.45, 'UP')).not.toBeCloseTo(0.55, 6);
    expect(scoreOne(0.70, 0.60, 'UP')).not.toBeCloseTo(0.40, 6);
  });
});
