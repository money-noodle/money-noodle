import { describe, expect, it } from 'vitest';
import { evaluateSwitchProbabilityGate, valueSwitch } from './switch-policy';

describe('switch probability advantage gate', () => {
  it('requires a materially stronger replacement before selling', () => {
    expect(evaluateSwitchProbabilityGate({
      incumbentSymbol: 'BTC', incumbentSide: 'UP', incumbentProbability: 0.48,
      replacementSymbol: 'ETH', replacementSide: 'DOWN', replacementProbability: 0.60,
      minimumAdvantage: 0.15, minimumOppositeSideAdvantage: 0.20,
    })).toMatchObject({ allowed: false, advantage: 0.12, requiredAdvantage: 0.15 });
  });

  it('uses the stricter threshold for same-asset UP-to-DOWN reversal', () => {
    const blocked = evaluateSwitchProbabilityGate({
      incumbentSymbol: 'BTC', incumbentSide: 'UP', incumbentProbability: 0.35,
      replacementSymbol: 'BTC', replacementSide: 'DOWN', replacementProbability: 0.54,
      minimumAdvantage: 0.15, minimumOppositeSideAdvantage: 0.20,
    });
    const allowed = evaluateSwitchProbabilityGate({
      incumbentSymbol: 'BTC', incumbentSide: 'UP', incumbentProbability: 0.30,
      replacementSymbol: 'BTC', replacementSide: 'DOWN', replacementProbability: 0.55,
      minimumAdvantage: 0.15, minimumOppositeSideAdvantage: 0.20,
    });
    expect(blocked).toMatchObject({ allowed: false, oppositeSameAsset: true, requiredAdvantage: 0.20 });
    expect(allowed).toMatchObject({ allowed: true, oppositeSameAsset: true });
    expect(allowed?.advantage).toBeCloseTo(0.25);
  });
});

describe('position switch valuation', () => {
  it('charges the liquidation loss, exit fee, and replacement cost', () => {
    const result = valueSwitch({
      incumbentQuantity: 1, incumbentProbability: 0.60,
      exitBid: 0.40, exitFeeCents: 2,
      replacementQuantity: 1, replacementProbability: 0.80,
      replacementAllInCostCents: 50,
    })!;
    expect(result.holdValueCents).toBe(60);
    expect(result.liquidationValueCents).toBe(38);
    expect(result.replacementExpectedProfitCents).toBe(30);
    // Selling loses 22c of expected hold value; the replacement earns 30c, leaving only 8c gain.
    expect(result.deltaCents).toBe(8);
  });

  it('rejects an apparently stronger replacement when selling destroys more value', () => {
    const result = valueSwitch({
      incumbentQuantity: 0.5, incumbentProbability: 0.8,
      exitBid: 0.2, exitFeeCents: 1,
      replacementQuantity: 0.2, replacementProbability: 0.9,
      replacementAllInCostCents: 10,
    })!;
    expect(result.replacementExpectedProfitCents).toBe(8);
    expect(result.deltaCents).toBeLessThan(0);
  });

  it('does not use original entry cost in the future decision', () => {
    const input = {
      incumbentQuantity: 0.25, incumbentProbability: 0.5,
      exitBid: 0.45, exitFeeCents: 0.5,
      replacementQuantity: 0.2, replacementProbability: 0.75,
      replacementAllInCostCents: 10,
    };
    expect(valueSwitch(input)?.deltaCents).toBeCloseTo(3.25);
  });

  it('fails closed on malformed probabilities and quantities', () => {
    expect(valueSwitch({ incumbentQuantity: 0, incumbentProbability: 0.5, exitBid: 0.4, exitFeeCents: 1, replacementQuantity: 1, replacementProbability: 0.7, replacementAllInCostCents: 50 })).toBeNull();
    expect(valueSwitch({ incumbentQuantity: 1, incumbentProbability: 1.2, exitBid: 0.4, exitFeeCents: 1, replacementQuantity: 1, replacementProbability: 0.7, replacementAllInCostCents: 50 })).toBeNull();
  });
});
