import type { PositionSide, StandaloneExitPolicy } from './types';

export const PROFIT_REVERSAL_ARM_PERCENT = 0.75;
export const STRICT_EXIT_MIN_GAIN_CENTS = 1;
/** After an exit, the same side must wait this long and re-earn persistence before it can be re-entered. */
export const POST_EXIT_REENTRY_COOLDOWN_MS = 60_000;

/**
 * Whether an armed profit reversal may actually sell. Withheld by default on its own evidence.
 *
 * Both tracks scored the rule negative against the hold it rejected, and live clears two standard
 * errors: live incremental −192.9% ±81.5 over 9 exits in 8 windows, paper −10.1% ±29.3 over 37 exits
 * in 23 windows. Holding instead would have settled in the money on 66.7% of the live exits. That is
 * the signature of a rule selling winners early rather than protecting them.
 *
 * The comparison that matters is against its sibling: `strict-value-v1` is positive on both tracks
 * over the same interval (paper +30.3% ±14.3, t=2.12), so this is not exits being wrong in general —
 * it is one of the two exit rules paying for the other. Strict value is unchanged.
 *
 * The live sample is small and the paper interval spans zero, so this is withholding rather than
 * refutation. It is one environment variable back: MONEY_NOODLE_PROFIT_REVERSAL_EXIT=true. Arming and
 * high-water tracking below continue regardless of this switch, so the counterfactual arms keep
 * scoring what the rule would have done and the decision stays reversible on evidence. See SPEC §12.
 */
export function profitReversalExitEnabled(): boolean {
  return process.env.MONEY_NOODLE_PROFIT_REVERSAL_EXIT === 'true';
}

/**
 * The standalone exit policies in force, named exactly as they are stamped onto each exit order.
 * Derived from the switch rather than fixed, so a withheld rule cannot silently blend its cohort
 * into the one that ran without it.
 */
export function standaloneExitPolicyVersion(): string {
  return profitReversalExitEnabled() ? 'strict-value-v1 + profit-reversal-75-v1' : 'strict-value-v1';
}

export interface ExitObservationState {
  profitLockArmedAt?: string;
  peakNetLiquidationCents?: number;
  peakNetProfitPercent?: number;
  peakOwnedSideProbability?: number;
  peakObservedAt?: string;
}

export interface ExitPolicyInput extends ExitObservationState {
  observedAt: string;
  side: PositionSide;
  quantity: number;
  exactCostCents: number;
  executableBid: number;
  exitFeeCents: number;
  ownedSideProbability: number;
  uncertainty: number;
  strictMinimumGainCents?: number;
}

export interface ExitPolicyDecision extends ExitObservationState {
  executableBid: number;
  exitFeeCents: number;
  netLiquidationCents: number;
  netProfitPercent: number;
  holdValueCents: number;
  optimisticHoldValueCents: number;
  action: 'HOLD' | 'SELL';
  policy?: StandaloneExitPolicy;
  reason: string;
}

/**
 * One fresh observation may execute an exit. Profit reversal is armed only after +75% executable
 * profit, then requires both a lower valid bid and lower independent owned-side probability than the
 * recorded liquidation high-water snapshot. Reaching +75% alone never sells.
 */
export function evaluateExitPolicy(input: ExitPolicyInput): ExitPolicyDecision | null {
  const numeric = [input.quantity, input.exactCostCents, input.executableBid, input.exitFeeCents,
    input.ownedSideProbability, input.uncertainty, input.strictMinimumGainCents ?? STRICT_EXIT_MIN_GAIN_CENTS];
  if (!numeric.every(Number.isFinite) || input.quantity <= 0 || input.exactCostCents <= 0
    || input.executableBid <= 0 || input.executableBid >= 1 || input.exitFeeCents < 0
    || input.ownedSideProbability < 0 || input.ownedSideProbability > 1 || input.uncertainty < 0) return null;

  const netLiquidationCents = input.quantity * 100 * input.executableBid - input.exitFeeCents;
  const netProfitPercent = (netLiquidationCents - input.exactCostCents) / input.exactCostCents;
  const holdValueCents = input.quantity * 100 * input.ownedSideProbability;
  const optimisticHoldValueCents = input.quantity * 100 * Math.min(1, input.ownedSideProbability + input.uncertainty);
  const minimumGain = input.strictMinimumGainCents ?? STRICT_EXIT_MIN_GAIN_CENTS;

  let state: ExitObservationState = {
    profitLockArmedAt: input.profitLockArmedAt,
    peakNetLiquidationCents: input.peakNetLiquidationCents,
    peakNetProfitPercent: input.peakNetProfitPercent,
    peakOwnedSideProbability: input.peakOwnedSideProbability,
    peakObservedAt: input.peakObservedAt,
  };
  if (!state.profitLockArmedAt && netProfitPercent >= PROFIT_REVERSAL_ARM_PERCENT) {
    state = { ...state, profitLockArmedAt: input.observedAt };
  }
  if (state.profitLockArmedAt && (state.peakNetLiquidationCents === undefined || netLiquidationCents > state.peakNetLiquidationCents + 1e-9)) {
    state = {
      ...state,
      peakNetLiquidationCents: netLiquidationCents,
      peakNetProfitPercent: netProfitPercent,
      peakOwnedSideProbability: input.ownedSideProbability,
      peakObservedAt: input.observedAt,
    };
  }

  if (netLiquidationCents >= optimisticHoldValueCents + minimumGain) {
    return { ...state, executableBid: input.executableBid, exitFeeCents: input.exitFeeCents, netLiquidationCents, netProfitPercent, holdValueCents, optimisticHoldValueCents,
      action: 'SELL', policy: 'strict-value-v1',
      reason: `Executable cash exceeds optimistic hold value by ${(netLiquidationCents - optimisticHoldValueCents).toFixed(2)}c.`,
    };
  }

  const reversedFromPeak = state.profitLockArmedAt
    && state.peakNetLiquidationCents !== undefined && state.peakOwnedSideProbability !== undefined
    && netLiquidationCents < state.peakNetLiquidationCents - 1e-9
    && input.ownedSideProbability < state.peakOwnedSideProbability - 1e-9
    // The arming observation establishes the peak; it cannot also be its own reversal confirmation.
    && state.peakObservedAt !== input.observedAt;
  if (reversedFromPeak && profitReversalExitEnabled()) {
    return { ...state, executableBid: input.executableBid, exitFeeCents: input.exitFeeCents, netLiquidationCents, netProfitPercent, holdValueCents, optimisticHoldValueCents,
      action: 'SELL', policy: 'profit-reversal-75-v1',
      reason: `Profit lock armed at +${PROFIT_REVERSAL_ARM_PERCENT * 100}%; executable value and owned-side probability both declined from high water.`,
    };
  }

  const holdReason = reversedFromPeak
    ? 'Profit reversal is withheld from execution on its own evidence; the armed downturn was recorded, not sold.'
    : state.profitLockArmedAt ? 'Profit lock armed; no confirmed joint value/probability downturn.'
      : 'No strict value exit or armed profit reversal.';
  return { ...state, executableBid: input.executableBid, exitFeeCents: input.exitFeeCents, netLiquidationCents, netProfitPercent, holdValueCents, optimisticHoldValueCents,
    action: 'HOLD', reason: holdReason,
  };
}
