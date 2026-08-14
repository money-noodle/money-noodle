import { afterEach, describe, expect, it } from 'vitest';
import { evaluateExitPolicy, profitReversalExitEnabled, standaloneExitPolicyVersion } from './exit-policy';

const base = {
  observedAt: '2026-01-01T00:05:00Z', side: 'UP' as const, quantity: 1,
  exactCostCents: 40, executableBid: 0.5, exitFeeCents: 1,
  ownedSideProbability: 0.7, uncertainty: 0.05,
};

/** A snapshot one tick past an armed high-water mark, with both value and probability lower. */
const reversedFromPeak = {
  ...base, observedAt: '2026-01-01T00:05:15Z', executableBid: 0.68, exitFeeCents: 0,
  ownedSideProbability: 0.84, profitLockArmedAt: base.observedAt,
  peakNetLiquidationCents: 71, peakNetProfitPercent: 0.775,
  peakOwnedSideProbability: 0.9, peakObservedAt: base.observedAt,
};

afterEach(() => { delete process.env.MONEY_NOODLE_PROFIT_REVERSAL_EXIT; });

describe('standalone exit policy', () => {
  it('takes a strict value exit when Kalshi cash beats optimistic hold value', () => {
    const result = evaluateExitPolicy({ ...base, executableBid: 0.9, ownedSideProbability: 0.6 })!;
    expect(result).toMatchObject({ action: 'SELL', policy: 'strict-value-v1' });
    expect(result.netLiquidationCents).toBe(89);
    expect(result.optimisticHoldValueCents).toBeCloseTo(65);
  });

  it('arms at 75% executable profit without selling immediately', () => {
    const result = evaluateExitPolicy({ ...base, executableBid: 0.71, exitFeeCents: 0, ownedSideProbability: 0.9 })!;
    expect(result.netProfitPercent).toBeCloseTo(0.775);
    expect(result.action).toBe('HOLD');
    expect(result.profitLockArmedAt).toBe(base.observedAt);
    expect(result.peakNetLiquidationCents).toBe(71);
  });

  it('sells on one later snapshot when value and probability both reverse from high water', () => {
    process.env.MONEY_NOODLE_PROFIT_REVERSAL_EXIT = 'true';
    const result = evaluateExitPolicy(reversedFromPeak)!;
    expect(result).toMatchObject({ action: 'SELL', policy: 'profit-reversal-75-v1' });
  });

  it('withholds the profit-reversal sale by default while still recording the armed downturn', () => {
    expect(profitReversalExitEnabled()).toBe(false);
    const result = evaluateExitPolicy(reversedFromPeak)!;
    expect(result.action).toBe('HOLD');
    expect(result.policy).toBeUndefined();
    // The observation survives the withholding, so the counterfactual arms can still score the rule.
    expect(result.profitLockArmedAt).toBe(base.observedAt);
    expect(result.peakNetLiquidationCents).toBe(71);
    expect(result.reason).toMatch(/withheld/i);
  });

  it('keeps strict value exits executable while profit reversal is withheld', () => {
    const result = evaluateExitPolicy({ ...base, executableBid: 0.9, ownedSideProbability: 0.6 })!;
    expect(result).toMatchObject({ action: 'SELL', policy: 'strict-value-v1' });
  });

  it('names the cohort by the rules that could actually sell', () => {
    expect(standaloneExitPolicyVersion()).toBe('strict-value-v1');
    process.env.MONEY_NOODLE_PROFIT_REVERSAL_EXIT = 'true';
    expect(standaloneExitPolicyVersion()).toBe('strict-value-v1 + profit-reversal-75-v1');
  });

  it('does not sell on a quote dip without probability confirmation', () => {
    const result = evaluateExitPolicy({
      ...base, observedAt: '2026-01-01T00:05:15Z', executableBid: 0.68, exitFeeCents: 0,
      ownedSideProbability: 0.91, profitLockArmedAt: base.observedAt,
      peakNetLiquidationCents: 71, peakNetProfitPercent: 0.775,
      peakOwnedSideProbability: 0.9, peakObservedAt: base.observedAt,
    })!;
    expect(result.action).toBe('HOLD');
  });

  it('applies the same policy to DOWN ownership', () => {
    const result = evaluateExitPolicy({ ...base, side: 'DOWN', executableBid: 0.9, ownedSideProbability: 0.6 })!;
    expect(result.policy).toBe('strict-value-v1');
  });
});
