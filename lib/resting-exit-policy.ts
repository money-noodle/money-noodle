import type { PaperOrder, PaperOrderStatus } from './types';

/**
 * Lifecycle of the long-shot policy's resting reduce-only limit sell. Pure and I/O free: it decides what
 * should happen to the order, and the caller performs it.
 *
 * The venue's `reduce_only` flag is the primary guarantee that this can never open or reverse exposure.
 * The quantity rule here is a second, independent one, computed locally from the entry fill and every
 * prior partial sale. Two mechanisms rather than one because a sell that exceeds the held quantity is the
 * single way this strategy could create a short position, and a flag we cannot unit-test is not enough.
 */
export const RESTING_EXIT_POLICY_VERSION = 'resting-reduce-only-limit-v1';

/** Smallest quantity Kalshi v2 accepts, so a smaller remainder cannot be rested. */
export const MINIMUM_EXIT_COUNT = 0.01;

export interface RestingExitPosition {
  status: PaperOrderStatus;
  /** Quantity actually acquired by the entry, from authoritative fills. */
  filledQuantity: number;
  /** Quantity already closed by prior partial exits. */
  soldQuantity: number;
  /** Quantity currently resting on the book, if an exit order is live. */
  restingCount?: number;
  exitVenueOrderId?: string;
  closesAt: string;
}

export type RestingExitDecision =
  | { action: 'place'; limitPriceCents: number; count: number }
  | { action: 'cancel'; reason: string }
  | { action: 'hold'; reason: string };

const openStatuses = new Set<PaperOrderStatus>(['open']);

/**
 * Quantity this position may still sell. Never negative, and never more than was acquired.
 *
 * Rounded **down** to the venue's 0.01 increment, never to nearest. Rounding to nearest would turn 0.005
 * held into 0.01 sellable, which is a reduce-only breach dressed up as a display convention. Selling less
 * than is held is always safe; selling more is the one thing this policy must never do.
 */
export function heldQuantity(position: Pick<RestingExitPosition, 'filledQuantity' | 'soldQuantity'>): number {
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
export function restingExitPosition(order: PaperOrder): RestingExitPosition {
  return {
    status: order.status,
    filledQuantity: order.filledCount ?? order.quantity ?? 0,
    soldQuantity: 0,
    restingCount: order.restingExitCount,
    exitVenueOrderId: order.exitVenueOrderId,
    closesAt: order.closesAt,
  };
}

/**
 * What to do with this position's resting exit right now.
 *
 * Cancellation is checked before placement, and the invariant breach is checked before everything, so a
 * resting order that exceeds what is held is withdrawn rather than left working while some other condition
 * is evaluated.
 */
export function evaluateRestingExit(
  position: RestingExitPosition,
  options: { exitMarkCents: number; nowMs: number; draining?: boolean },
): RestingExitDecision {
  const held = heldQuantity(position);
  const resting = position.restingCount ?? 0;
  const working = Boolean(position.exitVenueOrderId) && resting > 0;

  // Fail closed and withdraw: a resting sell larger than the position would breach reduce-only if the
  // venue flag were ever absent, misconfigured, or applied to the wrong leg.
  if (working && resting > held + 1e-8) {
    return { action: 'cancel', reason: `Resting exit of ${resting} exceeds the ${held} held; withdrawing before it can breach reduce-only.` };
  }
  // The drain must reach quiescence, and a working order is exactly what stops it.
  if (options.draining) {
    return working
      ? { action: 'cancel', reason: 'Execution is draining; no order may remain working.' }
      : { action: 'hold', reason: 'Execution is draining.' };
  }
  if (held <= 0) {
    return working
      ? { action: 'cancel', reason: 'Nothing is held; the resting exit has nothing left to reduce.' }
      : { action: 'hold', reason: 'Nothing is held.' };
  }
  if (!openStatuses.has(position.status)) {
    return working
      ? { action: 'cancel', reason: `Position is ${position.status}; the resting exit is no longer valid.` }
      : { action: 'hold', reason: `Position is ${position.status}.` };
  }

  const closesAtMs = Date.parse(position.closesAt);
  if (Number.isFinite(closesAtMs) && options.nowMs >= closesAtMs) {
    // Deliberately not cancelled. An unfilled resting sell simply expires with the contract, and there is
    // no fallback exit: selling into the close at any price is what the whole strategy declines to do.
    return { action: 'hold', reason: 'Past close; the resting exit expires with the contract.' };
  }
  if (working) return { action: 'hold', reason: `Resting ${resting} at ${options.exitMarkCents}¢.` };
  if (held < MINIMUM_EXIT_COUNT) {
    return { action: 'hold', reason: `Held ${held} is below the ${MINIMUM_EXIT_COUNT} minimum order size.` };
  }
  if (!Number.isFinite(options.exitMarkCents) || options.exitMarkCents <= 0 || options.exitMarkCents >= 100) {
    return { action: 'hold', reason: 'No usable exit mark.' };
  }
  return { action: 'place', limitPriceCents: options.exitMarkCents, count: held };
}

/**
 * Proceeds and realized P&L for a resting exit that filled, whole or partial.
 *
 * A partial fill is an ordinary outcome here rather than an error: the remainder simply keeps resting.
 * Entry cost is apportioned by the fraction sold so the unsold remainder retains its own basis.
 */
export function restingExitSettlement(input: {
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
