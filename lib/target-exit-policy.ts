import type { PaperOrder, PaperOrderStatus } from './types';

/**
 * The long-shot policy's exit: watch the owned side's bid, and sell at the mark when it is reached.
 *
 * This was designed as a resting reduce-only GTC limit, which would have filled on a spike unattended.
 * Kalshi refuses that combination — verified 2026-08-15, `400 invalid_order: "reduce_only can only be used
 * with IoC orders"` — and reduce-only is the property that keeps a sell from opening reverse exposure, so
 * the resting order gave way rather than the invariant. See docs/long-shot-policy-design.md §8.
 *
 * Pure and I/O free: it decides whether to sell, and the caller submits through the existing
 * `placeKalshiSell` IOC primitive.
 */
export const TARGET_EXIT_POLICY_VERSION = 'polled-reduce-only-ioc-target-v1';

/** Cadence the caller must poll at. Two seconds is what paper maker management already sustains. */
export const TARGET_EXIT_POLL_MS = 2_000;

/** Smallest quantity Kalshi v2 accepts, so a smaller remainder cannot be sold. */
export const MINIMUM_EXIT_COUNT = 0.01;

export interface TargetExitPosition {
  status: PaperOrderStatus;
  /** Quantity actually acquired by the entry, from authoritative fills. */
  filledQuantity: number;
  /** Quantity already closed by prior partial exits. */
  soldQuantity: number;
  closesAt: string;
  /** Set while an exit request is in flight, so one tick cannot submit twice. */
  exitPending?: boolean;
}

export type TargetExitDecision =
  | { action: 'sell'; limitPriceCents: number; count: number }
  | { action: 'wait'; reason: string };

const sellableStatuses = new Set<PaperOrderStatus>(['open']);

/**
 * Quantity this position may still sell. Never negative, and never more than was acquired.
 *
 * Rounded **down** to the venue's 0.01 increment, never to nearest. Rounding to nearest would turn 0.005
 * held into 0.01 sellable, which is a reduce-only breach dressed up as a display convention. Selling less
 * than is held is always safe; selling more is the one thing this policy must never do.
 */
export function heldQuantity(position: Pick<TargetExitPosition, 'filledQuantity' | 'soldQuantity'>): number {
  const filled = Number.isFinite(position.filledQuantity) ? Math.max(0, position.filledQuantity) : 0;
  const sold = Number.isFinite(position.soldQuantity) ? Math.max(0, position.soldQuantity) : 0;
  return Math.floor(Math.max(0, filled - sold) * 100 + 1e-8) / 100;
}

/**
 * `soldQuantity` is 0 here by construction, not by omission. A partial exit in this ledger decrements the
 * entry's own `quantity`/`filledCount` to the remainder and books the sold slice as a separate `:exit:`
 * order, so the remaining held amount is already what the entry reports. The field stays in the interface
 * because the reduce-only bound should be stated explicitly rather than implied by that convention, and a
 * caller that ever tracks sales differently must not silently over-sell.
 */
export function targetExitPosition(order: PaperOrder): TargetExitPosition {
  return {
    status: order.status,
    filledQuantity: order.filledCount ?? order.quantity ?? 0,
    soldQuantity: 0,
    closesAt: order.closesAt,
    exitPending: order.exitPending,
  };
}

/**
 * Whether to sell this position right now, given the owned side's current executable bid.
 *
 * The submitted limit is the mark rather than the observed bid, so a quote that retreats between
 * observation and submission produces no fill instead of a worse one, and the next tick re-evaluates.
 */
export function evaluateTargetExit(
  position: TargetExitPosition,
  options: { exitMarkCents: number; ownedSideBidCents: number; nowMs: number; draining?: boolean },
): TargetExitDecision {
  if (position.exitPending) return { action: 'wait', reason: 'An exit request is already in flight.' };
  if (options.draining) return { action: 'wait', reason: 'Execution is draining; no new exit may start.' };
  if (!sellableStatuses.has(position.status)) return { action: 'wait', reason: `Position is ${position.status}.` };

  const held = heldQuantity(position);
  if (held < MINIMUM_EXIT_COUNT) {
    return { action: 'wait', reason: `Held ${held} is below the ${MINIMUM_EXIT_COUNT} minimum order size.` };
  }

  const closesAtMs = Date.parse(position.closesAt);
  if (Number.isFinite(closesAtMs) && options.nowMs >= closesAtMs) {
    // Deliberately no fallback exit. Selling into the close at any price is what the strategy declines to
    // do, so past close the correct action is to let it settle.
    return { action: 'wait', reason: 'Past close; the position settles rather than selling at any price.' };
  }
  if (!Number.isFinite(options.exitMarkCents) || options.exitMarkCents <= 0 || options.exitMarkCents >= 100) {
    return { action: 'wait', reason: 'No usable exit mark.' };
  }
  if (!Number.isFinite(options.ownedSideBidCents) || options.ownedSideBidCents <= 0) {
    return { action: 'wait', reason: 'No executable owned-side bid.' };
  }
  if (options.ownedSideBidCents < options.exitMarkCents) {
    return { action: 'wait', reason: `Owned-side bid ${options.ownedSideBidCents}¢ is below the ${options.exitMarkCents}¢ mark.` };
  }
  return { action: 'sell', limitPriceCents: options.exitMarkCents, count: held };
}

/**
 * Highest owned-side bid seen while a position was open.
 *
 * Recorded on every tick rather than only on a fill, because it is what lets every candidate exit mark be
 * evaluated from one dataset afterwards. Without it, the only recoverable fact is whether the one mark in
 * force was reached, and re-choosing the mark would need another month of collection.
 */
export function observePeakBid(previousPeakCents: number | undefined, ownedSideBidCents: number): number {
  const previous = Number.isFinite(previousPeakCents) ? (previousPeakCents as number) : 0;
  const current = Number.isFinite(ownedSideBidCents) ? ownedSideBidCents : 0;
  return Math.max(previous, current, 0);
}

/**
 * Proceeds and realized P&L for an exit that filled, whole or partial.
 *
 * A partial fill is an ordinary outcome rather than an error. Entry cost is apportioned by the fraction
 * sold so the unsold remainder retains its own basis.
 */
export function targetExitSettlement(input: {
  filledCount: number;
  averagePriceCents: number;
  feeCents: number;
  entryQuantity: number;
  entryStakeCents: number;
}): { proceedsCents: number; costBasisCents: number; realizedPnlCents: number; remainingQuantity: number } {
  const filled = Math.max(0, input.filledCount);
  const proceedsCents = filled * input.averagePriceCents - Math.max(0, input.feeCents);
  const fraction = input.entryQuantity > 0 ? Math.min(1, filled / input.entryQuantity) : 0;
  const costBasisCents = input.entryStakeCents * fraction;
  return {
    proceedsCents,
    costBasisCents,
    realizedPnlCents: proceedsCents - costBasisCents,
    // Floored for the same reason as `heldQuantity`: a remainder rounded up becomes quantity we do not own.
    remainingQuantity: Math.floor(Math.max(0, input.entryQuantity - filled) * 100 + 1e-8) / 100,
  };
}
