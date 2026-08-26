/**
 * Future-wealth comparison for replacing an open position.
 *
 * Entry cost is deliberately absent from the decision: it is sunk. It remains essential for realized
 * P&L reporting, but switching is rational only when cash available after selling plus the new trade's
 * expected profit exceeds the expected payout from continuing to hold.
 */
export const SWITCH_POLICY_VERSION = 'future-wealth-side-gap-v1';

/** Defaults remain deliberately conservative and can only be tightened/adjusted server-side. */
const DEFAULT_MIN_SWITCH_GAIN_CENTS = 1;
const DEFAULT_SWITCH_UNCERTAINTY_MARGIN_CENTS = 1;
const DEFAULT_SWITCH_COOLDOWN_SECONDS = 180;
/** A replacement must be materially more likely to pay than the side already owned. */
const DEFAULT_MIN_SWITCH_PROBABILITY_ADVANTAGE = 0.15;
/** Reversing the same asset is especially vulnerable to noise and spread churn. */
const DEFAULT_MIN_OPPOSITE_SIDE_ADVANTAGE = 0.20;

export interface SwitchPolicySettings {
  minimumGainCents: number;
  uncertaintyMarginCents: number;
  cooldownSeconds: number;
  minimumProbabilityAdvantage: number;
  minimumOppositeSideAdvantage: number;
}

/** The single reader for switch configuration, so execution and the published policy cannot disagree. */
export function switchPolicySettings(environment: NodeJS.ProcessEnv = process.env): SwitchPolicySettings {
  const bounded = (name: string, fallback: number, maximum: number) => {
    const value = Number(environment[name] ?? fallback);
    return Number.isFinite(value) && value >= 0 ? Math.min(maximum, value) : fallback;
  };
  return {
    minimumGainCents: bounded('MONEY_NOODLE_MIN_SWITCH_GAIN_CENTS', DEFAULT_MIN_SWITCH_GAIN_CENTS, 100),
    uncertaintyMarginCents: bounded('MONEY_NOODLE_SWITCH_UNCERTAINTY_MARGIN_CENTS', DEFAULT_SWITCH_UNCERTAINTY_MARGIN_CENTS, 100),
    cooldownSeconds: bounded('MONEY_NOODLE_SWITCH_COOLDOWN_SECONDS', DEFAULT_SWITCH_COOLDOWN_SECONDS, 3_600),
    minimumProbabilityAdvantage: bounded('MONEY_NOODLE_MIN_SWITCH_PROBABILITY_ADVANTAGE', DEFAULT_MIN_SWITCH_PROBABILITY_ADVANTAGE, 0.5),
    minimumOppositeSideAdvantage: bounded('MONEY_NOODLE_MIN_OPPOSITE_SIDE_ADVANTAGE', DEFAULT_MIN_OPPOSITE_SIDE_ADVANTAGE, 0.5),
  };
}
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
