import type { PositionSide } from './types';

export const PROFIT_REVERSAL_ARM_PERCENT = 0.75;
export const STRICT_EXIT_MIN_GAIN_CENTS = 1;

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
  policy?: 'strict-value-v1' | 'profit-reversal-75-v1';
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
  if (reversedFromPeak) {
    return { ...state, executableBid: input.executableBid, exitFeeCents: input.exitFeeCents, netLiquidationCents, netProfitPercent, holdValueCents, optimisticHoldValueCents,
      action: 'SELL', policy: 'profit-reversal-75-v1',
      reason: `Profit lock armed at +${PROFIT_REVERSAL_ARM_PERCENT * 100}%; executable value and owned-side probability both declined from high water.`,
    };
  }

  return { ...state, executableBid: input.executableBid, exitFeeCents: input.exitFeeCents, netLiquidationCents, netProfitPercent, holdValueCents, optimisticHoldValueCents,
    action: 'HOLD', reason: state.profitLockArmedAt ? 'Profit lock armed; no confirmed joint value/probability downturn.' : 'No strict value exit or armed profit reversal.',
  };
}
