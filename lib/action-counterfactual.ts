import { PROFIT_REVERSAL_ARM_PERCENT } from './exit-policy';
import type { ActionCounterfactualArm, ActionCounterfactualBasis, ExecutionMode, PaperOrder, StandaloneExitPolicy } from './types';

/** Stamped onto every arm so a later report can be compared against the definitions that produced it. */
export const ACTION_COUNTERFACTUAL_VERSION = 'action-counterfactual-v1';
/** An arm needs this many independent settlement windows before its mean is worth reading at all. */
export const MIN_CREDIBLE_WINDOWS = 5;

const actualStake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents;
const actualPnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/**
 * Trades sharing a settlement window share one market move, so they are one observation rather than
 * several. Every mean and standard error in this module is computed over per-window means for that
 * reason; treating the trades as independent is what made earlier exit readings look decisive.
 */
export function clusterByWindow<T>(items: T[], closesAt: (item: T) => string, value: (item: T) => number) {
  const windows = new Map<string, number[]>();
  for (const item of items) {
    const key = closesAt(item);
    windows.set(key, [...(windows.get(key) ?? []), value(item)]);
  }
  const perWindow = [...windows.values()].flatMap((group) => {
    const average = mean(group);
    return average === null ? [] : [average];
  });
  const average = mean(perWindow);
  const standardError = average !== null && perWindow.length > 1
    ? Math.sqrt(perWindow.reduce((sum, item) => sum + (item - average) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
    : null;
  return { windows: perWindow.length, mean: average, standardError };
}

/** One decision: what the action actually returned, and what the rejected alternative would have returned. */
interface Decision {
  order: PaperOrder;
  takenCents: number;
  alternativeCents: number;
}

function arm(
  action: ActionCounterfactualArm['action'],
  alternative: string,
  policy: string,
  basis: ActionCounterfactualBasis,
  description: string,
  decisions: Decision[],
): ActionCounterfactualArm | null {
  if (!decisions.length) return null;
  const incremental = (decision: Decision) => decision.takenCents - decision.alternativeCents;
  const cents = clusterByWindow(decisions, (decision) => decision.order.closesAt, incremental);
  // Stake sizing changed by more than an order of magnitude over the recorded history, so cent totals
  // are dominated by the largest-stake era. The normalized return is the comparable figure.
  const returns = clusterByWindow(
    decisions.filter((decision) => actualStake(decision.order) > 0),
    (decision) => decision.order.closesAt,
    (decision) => incremental(decision) / actualStake(decision.order),
  );
  // How often the action won, as distinct from how much. An exit is insurance: it surrenders a little
  // remaining upside most times it fires and avoids a total loss of stake occasionally, so a positive
  // mean routinely sits on a hit rate well under half. Without this figure the obvious "improvement" —
  // it is only right a quarter of the time, make it fire less — reads as reasonable and would remove the
  // payoff. Reported beside the mean so the asymmetry cannot be missed.
  const beat = decisions.filter((decision) => incremental(decision) > 0).length;
  return {
    action, alternative, policy, basis, description,
    decisions: decisions.length,
    windows: cents.windows,
    decisionsBeatingAlternative: beat,
    hitRate: decisions.length ? beat / decisions.length : null,
    takenPnlCents: decisions.reduce((sum, decision) => sum + decision.takenCents, 0),
    alternativePnlCents: decisions.reduce((sum, decision) => sum + decision.alternativeCents, 0),
    incrementalCents: decisions.reduce((sum, decision) => sum + incremental(decision), 0),
    meanIncrementalCents: cents.mean,
    meanIncrementalReturn: returns.mean,
    incrementalReturnStandardError: returns.standardError,
    credible: returns.windows >= MIN_CREDIBLE_WINDOWS && returns.mean !== null
      && returns.standardError !== null && Math.abs(returns.mean) > 2 * returns.standardError,
  };
}

const exitPolicies: StandaloneExitPolicy[] = ['strict-value-v1', 'profit-reversal-75-v1'];

/**
 * Incremental value of each action actually taken against the alternative it rejected, split by the
 * policy that chose it. A positive arm means the action beat its alternative.
 *
 * The EXIT and SWITCH arms are authoritative: their alternative is priced from the settled venue
 * outcome the position would have reached. The HOLD arms are approximate, because the exit a hold
 * rejected can only be priced from the executable bid recorded at an observation. Complete position
 * paths make the HOLD arms exact; until enough have accumulated, they are labeled as estimates and
 * must not be read as equivalent evidence.
 *
 * This is reporting only. Nothing here may change an exit, retry, or sizing decision until an arm
 * survives the separate held-out promotion gates.
 */
export function buildActionCounterfactuals(orders: PaperOrder[], mode: ExecutionMode): ActionCounterfactualArm[] {
  const mine = orders.filter((order) => order.executionMode === mode && !order.id.includes(':exit:'));

  const standaloneExits = mine.filter((order) => order.status === 'sold' && !order.switchedToOrderId
    && order.counterfactualHoldPnlCents !== undefined);
  const exitDecision = (order: PaperOrder): Decision => ({ order, takenCents: actualPnl(order), alternativeCents: order.counterfactualHoldPnlCents! });

  const switches = mine.filter((order) => order.switchVsHoldCents !== undefined);

  // Held to settlement with the exit engine watching: the rejected alternative is selling at the last
  // executable bid it observed. Positions the engine never priced cannot contribute to this arm.
  const held = mine.filter((order) => (order.status === 'won' || order.status === 'lost')
    && order.latestNetLiquidationCents !== undefined);
  const heldDecision = (order: PaperOrder, liquidation: number): Decision => ({
    order, takenCents: actualPnl(order), alternativeCents: liquidation - actualStake(order),
  });
  // Armed but never sold. This is the population the profit-reversal policy is meant to protect, priced
  // at its own high-water mark, which is the most favorable exit it could plausibly have taken.
  const armedNeverSold = held.filter((order) => order.profitLockArmedAt && order.peakNetLiquidationCents !== undefined);

  return [
    ...exitPolicies.map((policy) => arm(
      'EXIT', 'HOLD', policy, 'authoritative',
      'Sold before settlement versus holding the same position to its settled outcome.',
      standaloneExits.filter((order) => order.standaloneExitPolicy === policy).map(exitDecision),
    )),
    arm(
      'SWITCH', 'HOLD', 'protected-switch', 'authoritative',
      'Liquidated the incumbent to fund a superior candidate versus holding the incumbent to settlement.',
      switches.map((order) => ({ order, takenCents: actualPnl(order), alternativeCents: actualPnl(order) - order.switchVsHoldCents! })),
    ),
    arm(
      'HOLD', 'EXIT', 'exit-at-last-observation', 'approximate',
      'Held to settlement versus selling at the last executable bid the exit engine observed.',
      held.map((order) => heldDecision(order, order.latestNetLiquidationCents!)),
    ),
    arm(
      'HOLD', 'EXIT', 'exit-at-armed-peak', 'approximate',
      `Held to settlement after arming at +${PROFIT_REVERSAL_ARM_PERCENT * 100}% versus selling at the recorded executable high water.`,
      armedNeverSold.map((order) => heldDecision(order, order.peakNetLiquidationCents!)),
    ),
  ].flatMap((item) => item ? [item] : []);
}
