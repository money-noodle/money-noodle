/**
 * Future-wealth comparison for replacing an open position.
 *
 * Entry cost is deliberately absent from the decision: it is sunk. It remains essential for realized
 * P&L reporting, but switching is rational only when cash available after selling plus the new trade's
 * expected profit exceeds the expected payout from continuing to hold.
 */
export interface SwitchValueInput {
  incumbentQuantity: number;
  incumbentProbability: number;
  exitBid: number;
  exitFeeCents: number;
  replacementQuantity: number;
  replacementProbability: number;
  replacementAllInCostCents: number;
}

export interface SwitchProbabilityGateInput {
  incumbentSymbol: string;
  incumbentSide: 'UP' | 'DOWN';
  incumbentProbability: number;
  replacementSymbol: string;
  replacementSide: 'UP' | 'DOWN';
  replacementProbability: number;
  minimumAdvantage: number;
  minimumOppositeSideAdvantage: number;
}

export interface SwitchProbabilityGate {
  allowed: boolean;
  advantage: number;
  requiredAdvantage: number;
  oppositeSameAsset: boolean;
}

/**
 * Prevents churn out of a still-plausible incumbent. Same-asset reversals require the stricter gap;
 * this gate is additional to, never a substitute for, positive future-wealth switch value.
 */
export function evaluateSwitchProbabilityGate(input: SwitchProbabilityGateInput): SwitchProbabilityGate | null {
  const numeric = [input.incumbentProbability, input.replacementProbability, input.minimumAdvantage, input.minimumOppositeSideAdvantage];
  if (!numeric.every(Number.isFinite) || input.incumbentProbability < 0 || input.incumbentProbability > 1
    || input.replacementProbability < 0 || input.replacementProbability > 1
    || input.minimumAdvantage < 0 || input.minimumOppositeSideAdvantage < 0) return null;
  const oppositeSameAsset = input.incumbentSymbol === input.replacementSymbol && input.incumbentSide !== input.replacementSide;
  const requiredAdvantage = oppositeSameAsset
    ? Math.max(input.minimumAdvantage, input.minimumOppositeSideAdvantage)
    : input.minimumAdvantage;
  const advantage = input.replacementProbability - input.incumbentProbability;
  return { allowed: advantage + 1e-12 >= requiredAdvantage, advantage, requiredAdvantage, oppositeSameAsset };
}

export interface SwitchValue {
  holdValueCents: number;
  liquidationValueCents: number;
  replacementExpectedProfitCents: number;
  deltaCents: number;
}

export function valueSwitch(input: SwitchValueInput): SwitchValue | null {
  const values = Object.values(input);
  if (!values.every(Number.isFinite) || input.incumbentQuantity <= 0 || input.replacementQuantity <= 0
    || input.incumbentProbability < 0 || input.incumbentProbability > 1
    || input.replacementProbability < 0 || input.replacementProbability > 1
    || input.exitBid < 0 || input.exitBid > 1 || input.exitFeeCents < 0 || input.replacementAllInCostCents <= 0) return null;
  const holdValueCents = input.incumbentQuantity * 100 * input.incumbentProbability;
  const liquidationValueCents = input.incumbentQuantity * 100 * input.exitBid - input.exitFeeCents;
  const replacementExpectedProfitCents = input.replacementQuantity * 100 * input.replacementProbability - input.replacementAllInCostCents;
  return {
    holdValueCents,
    liquidationValueCents,
    replacementExpectedProfitCents,
    deltaCents: liquidationValueCents - holdValueCents + replacementExpectedProfitCents,
  };
}
