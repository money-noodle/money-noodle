import type { KalshiFillRecord, KalshiOrderRecord, KalshiReconciliationSnapshot } from './kalshi-reconciliation';
import { expectedVenueClientOrderIds, isV2LiveEntryClientOrderId } from './live-order-identity';
import type { PaperOrder } from './types';

export interface RecoveredSettlement { stakeCents: number; payoutCents: number; relatedId: string }
export interface ExecutionReconciliationResult {
  orders: PaperOrder[];
  issues: string[];
  targetReservedCents: number;
  recoveredFills: number;
  venueManagedPositions: number;
  settlements: RecoveredSettlement[];
  retryableIssues: string[];
}

export const UNCERTAIN_VISIBILITY_GRACE_MS = 30_000;

function clientMatches(localId: string, venueClientId: string): boolean {
  return expectedVenueClientOrderIds(localId).includes(venueClientId);
}

function matchedOrders(
  order: PaperOrder, venueOrders: KalshiOrderRecord[], ambiguousVenueIds: ReadonlySet<string> = new Set(),
): KalshiOrderRecord[] {
  return venueOrders.filter((venue) => !ambiguousVenueIds.has(venue.orderId)
    && (venue.orderId === order.venueOrderId
      || clientMatches(order.clientOrderId ?? order.id, venue.clientOrderId)));
}

/** Historical post-only races remain in Kalshi history as canceled zero-fill records. Recognize them as
 * owned noise only; they never enter `matchedOrders` and therefore can never supply fill authority. */
function isTerminalLegacyCreateRejection(venue: KalshiOrderRecord, localOrders: PaperOrder[]): boolean {
  if (isV2LiveEntryClientOrderId(venue.clientOrderId) || venue.status !== 'canceled'
    || Math.abs(venue.fillCount) > 1e-8 || Math.abs(venue.remainingCount) > 1e-8) return false;
  const match = /^(.*)-[12]$/.exec(venue.clientOrderId);
  if (!match || match[1].length !== 30) return false;
  return localOrders.some((local) => !isV2LiveEntryClientOrderId(local.clientOrderId ?? local.id)
    && (local.clientOrderId ?? local.id).slice(0, 30) === match[1]);
}

function fillTotals(fills: KalshiFillRecord[], side: PaperOrder['side']): { count: number; purchaseCents: number; feeCents: number; averagePriceCents: number } {
  const count = fills.reduce((sum, fill) => sum + fill.count, 0);
  const purchaseCents = fills.reduce((sum, fill) => sum + fill.count * (side === 'UP' ? fill.yesPriceDollars : 1 - fill.yesPriceDollars) * 100, 0);
  const feeCents = fills.reduce((sum, fill) => sum + fill.feeDollars * 100, 0);
  return { count, purchaseCents, feeCents, averagePriceCents: count > 0 ? purchaseCents / count : 0 };
}

const isTerminal = (status: PaperOrder['status']) => status === 'won' || status === 'lost' || status === 'invalid' || status === 'sold';

/** A local lifecycle row claims current venue position only while it can still own exposure. A rejected
 * or unfilled attempt is not an owner merely because its contract has not closed yet. */
function claimsCurrentVenuePosition(order: PaperOrder, nowMs: number): boolean {
  return Date.parse(order.closesAt) > nowMs
    && (order.status === 'open' || order.status === 'pending_reservation'
      || order.status === 'uncertain' || order.exitPending === true);
}

function realizedEntryPortion(order: PaperOrder, orders: PaperOrder[]): {
  quantity: number; purchaseCents: number; feeCents: number; stakeCents: number;
  exitGrossProceedsCents: number; exitFeeCents: number;
} {
  return orders
    .filter((item) => item.id.startsWith(`${order.id}:exit:`) && item.status === 'sold' && item.executionMode === order.executionMode && item.venue === order.venue)
    .reduce((sum, item) => {
      const feeCents = item.actualFeeCents ?? item.feeCents ?? 0;
      const stakeCents = item.actualStakeCents ?? item.stakeCents;
      const purchaseCents = item.actualPurchaseCents ?? Math.max(0, stakeCents - feeCents);
      const exitFeeCents = item.exitFeeCents ?? 0;
      const exitGrossProceedsCents = (item.saleProceedsCents ?? item.payoutCents ?? 0) + exitFeeCents;
      return {
        quantity: sum.quantity + item.quantity,
        purchaseCents: sum.purchaseCents + purchaseCents,
        feeCents: sum.feeCents + feeCents,
        stakeCents: sum.stakeCents + stakeCents,
        exitGrossProceedsCents: sum.exitGrossProceedsCents + exitGrossProceedsCents,
        exitFeeCents: sum.exitFeeCents + exitFeeCents,
      };
    }, { quantity: 0, purchaseCents: 0, feeCents: 0, stakeCents: 0, exitGrossProceedsCents: 0, exitFeeCents: 0 });
}

/** Pure local/venue matcher. No ambiguous state is repaired silently: issues block startup. */
export function reconcileExecutionLedger(localOrders: PaperOrder[], snapshot: KalshiReconciliationSnapshot, nowMs = Date.now()): ExecutionReconciliationResult {
  const orders = structuredClone(localOrders);
  const issues: string[] = [];
  const settlements: RecoveredSettlement[] = [];
  const retryableIssues: string[] = [];
  let recoveredFills = 0;
  const localLive = orders.filter((order) => order.executionMode === 'live' && order.venue === 'kalshi'
    && !order.id.includes(':exit:'));
  // One local intent may own an amendment chain, but one venue order may never repair multiple local
  // rows. Detect ownership globally before applying any fill so iteration order cannot choose a winner.
  const ownersByVenueOrderId = new Map<string, Set<string>>();
  for (const venue of snapshot.orders) {
    for (const local of localLive) {
      if (venue.orderId !== local.venueOrderId
        && !clientMatches(local.clientOrderId ?? local.id, venue.clientOrderId)) continue;
      const owners = ownersByVenueOrderId.get(venue.orderId) ?? new Set<string>();
      owners.add(local.id);
      ownersByVenueOrderId.set(venue.orderId, owners);
    }
  }
  const ambiguousVenueIds = new Set([...ownersByVenueOrderId.entries()]
    .filter(([, owners]) => owners.size > 1).map(([venueOrderId]) => venueOrderId));
  for (const venueOrderId of ambiguousVenueIds) {
    const owners = [...(ownersByVenueOrderId.get(venueOrderId) ?? [])].sort();
    issues.push(`${venueOrderId}: one Kalshi order matches multiple local entries (${owners.join(', ')}).`);
  }

  for (const order of localLive) {
    order.clientOrderId ??= order.id;
    order.issuanceAskPrice ??= order.entryDecision?.actionableAsk ?? order.askPrice;
    order.issuanceBidPrice ??= order.entryDecision?.actionableBid ?? order.bidPrice;
    order.issuanceSpread ??= order.entryDecision?.spread ?? order.spread;
    order.approvedMaximumPrice ??= order.entryDecision?.actionableAsk ?? order.askPrice;
    const venueOrders = matchedOrders(order, snapshot.orders, ambiguousVenueIds);
    const venueIds = new Set(venueOrders.map((item) => item.orderId));
    if (order.venueOrderId && !ambiguousVenueIds.has(order.venueOrderId)) venueIds.add(order.venueOrderId);
    const entryAction = order.side === 'UP' ? 'buy' : 'sell';
    const buyFills = snapshot.fills.filter((fill) => venueIds.has(fill.orderId) && fill.action === entryAction);
    const totals = fillTotals(buyFills, order.side);

    if (!isTerminal(order.status) && totals.count > 1e-8) {
      const realizedEntry = realizedEntryPortion(order, orders);
      const localAcquiredQuantity = order.quantity + realizedEntry.quantity;
      // `requestedQuantity` is the quantity actually submitted and dominates `shadowTakerQuantity` on
      // every order that carries both, so the guard takes its bound from the order rather than a shadow.
      const acquiredQuantityLimit = Math.max(order.requestedQuantity ?? 0, localAcquiredQuantity);
      if (totals.count > acquiredQuantityLimit + 0.011) issues.push(`${order.id}: venue buy fills ${totals.count.toFixed(2)} exceed local requested quantity ${acquiredQuantityLimit.toFixed(2)}.`);
      const remainingCount = Math.max(0, totals.count - realizedEntry.quantity);
      const wasMissing = !order.venueOrderId || localAcquiredQuantity + 1e-8 < totals.count || order.status !== 'open';
      const accountedStakeCents = Math.ceil(totals.purchaseCents + totals.feeCents - 1e-9);
      const localAcquiredStakeCents = (order.actualStakeCents ?? order.stakeCents) + realizedEntry.stakeCents;
      // The ceiling is what was authorized at issuance, because a fill legitimately costs up to the
      // reservation even after `stakeCents` has been revised down to what was really paid. Orders
      // predating `reservedStakeCents` fall back to the locally acquired total, which is the behaviour
      // they already had; the taker shadow is never consulted, so repricing it cannot move this gate.
      const acquiredStakeLimitCents = Math.max(order.reservedStakeCents ?? 0, Math.ceil(localAcquiredStakeCents - 1e-9));
      if (accountedStakeCents > acquiredStakeLimitCents) issues.push(`${order.id}: recovered fill cost ${accountedStakeCents}c exceeds its ${acquiredStakeLimitCents}c reservation.`);
      const filledVenueOrder = venueOrders.find((item) => buyFills.some((fill) => fill.orderId === item.orderId)) ?? venueOrders[0];
      const remainingPurchaseCents = Math.max(0, totals.purchaseCents - realizedEntry.purchaseCents);
      const remainingFeeCents = Math.max(0, totals.feeCents - realizedEntry.feeCents);
      const remainingStakeCents = remainingPurchaseCents + remainingFeeCents;
      order.venueOrderId = filledVenueOrder?.orderId ?? order.venueOrderId;
      order.filledCount = Number(remainingCount.toFixed(2));
      order.quantity = Number(remainingCount.toFixed(2));
      order.authoritativeFillPrice = totals.averagePriceCents / 100;
      order.feeCents = remainingFeeCents;
      order.actualPurchaseCents = remainingPurchaseCents;
      order.actualFeeCents = remainingFeeCents;
      order.actualStakeCents = remainingStakeCents;
      order.stakeCents = Math.ceil(remainingStakeCents - 1e-9);
      order.potentialPayoutCents = Math.round(remainingCount * 100);
      order.liquidityRole = buyFills.some((fill) => fill.isTaker) ? 'taker' : 'maker';
      order.status = 'open';
      order.reason = wasMissing ? 'Recovered and verified from authoritative Kalshi order and fill history during startup reconciliation.' : order.reason;
      if (wasMissing) recoveredFills += 1;
    } else if (!isTerminal(order.status) && totals.count <= 1e-8) {
      if (order.status === 'open') {
        issues.push(`${order.id}: local position is open but Kalshi returned no matching fill.`);
      } else if (order.status === 'pending_reservation' || order.status === 'uncertain') {
        const ageMs = nowMs - Date.parse(order.createdAt);
        if (!venueOrders.length && Number.isFinite(ageMs) && ageMs < UNCERTAIN_VISIBILITY_GRACE_MS) {
          const issue = `${order.id}: Kalshi has not exposed the durable client order ID yet; retry during the ${UNCERTAIN_VISIBILITY_GRACE_MS / 1000}s consistency window.`;
          issues.push(issue); retryableIssues.push(issue);
        } else {
          order.status = venueOrders.length ? 'unfilled' : 'rejected';
          order.filledCount = 0;
          order.venueOrderId = venueOrders[0]?.orderId ?? order.venueOrderId;
          order.reason = venueOrders.length
            ? 'Reconciliation confirmed the venue order ended with no fill.'
            : 'Reconciliation found no accepted Kalshi order or fill for the durable client order ID after the consistency window.';
        }
      }
    }

    // Kalshi amendments may produce a chain of order records sharing one client intent. Aggregate
    // their fills above; only overfill/position contradictions are unsafe, not record count itself.
    if (order.exitPending || order.exitVenueOrderId) {
      const exitOrders = snapshot.orders.filter((venue) => venue.orderId === order.exitVenueOrderId
        || Boolean(order.exitClientOrderId && venue.clientOrderId === order.exitClientOrderId));
      const exitIds = new Set(exitOrders.map((item) => item.orderId));
      if (order.exitVenueOrderId) exitIds.add(order.exitVenueOrderId);
      const exitAction = order.side === 'UP' ? 'sell' : 'buy';
      const exitFills = snapshot.fills.filter((fill) => exitIds.has(fill.orderId) && fill.action === exitAction);
      const exit = fillTotals(exitFills, order.side);
      if (order.exitPending && exit.count <= 1e-8) {
        const exitAgeMs = order.exitRequestedAt ? nowMs - Date.parse(order.exitRequestedAt) : Number.POSITIVE_INFINITY;
        if (!exitOrders.length && Number.isFinite(exitAgeMs) && exitAgeMs < UNCERTAIN_VISIBILITY_GRACE_MS) {
          const issue = `${order.id}: Kalshi has not exposed the reduce-only client order ID yet; retry during the ${UNCERTAIN_VISIBILITY_GRACE_MS / 1000}s consistency window.`;
          issues.push(issue); retryableIssues.push(issue);
        } else {
          order.exitPending = false;
          order.exitVenueOrderId = exitOrders[0]?.orderId ?? order.exitVenueOrderId;
          order.reason = exitOrders.length ? 'Reconciliation confirmed the reduce-only exit received no fill; incumbent retained.' : 'Reconciliation found no accepted reduce-only exit after the consistency window; incumbent retained.';
        }
      } else if (exit.count > 1e-8 && order.status === 'open') {
        const realizedExit = realizedEntryPortion(order, orders);
        const unappliedExitCount = Math.max(0, exit.count - realizedExit.quantity);
        if (unappliedExitCount <= 1e-8) {
          order.exitPending = false;
          order.exitVenueOrderId = exitOrders.find((item) => exitFills.some((fill) => fill.orderId === item.orderId))?.orderId ?? order.exitVenueOrderId;
          order.reason = order.reason ?? 'Reconciliation confirmed the reduce-only exit was already reflected in the partial-exit ledger.';
          continue;
        }
        const originalQuantity = order.quantity;
        if (unappliedExitCount > originalQuantity + 0.011) issues.push(`${order.id}: reduce-only fills ${exit.count.toFixed(2)} exceed local position ${(originalQuantity + realizedExit.quantity).toFixed(2)}.`);
        const grossProceedsCents = Math.max(0, exit.purchaseCents - realizedExit.exitGrossProceedsCents);
        const unappliedExitFeeCents = Math.max(0, exit.feeCents - realizedExit.exitFeeCents);
        const netProceedsCents = grossProceedsCents - unappliedExitFeeCents;
        const exitVenueOrder = exitOrders.find((item) => exitFills.some((fill) => fill.orderId === item.orderId));
        if (unappliedExitCount + 1e-8 >= originalQuantity) {
          order.status = 'sold'; order.exitPending = false; order.exitVenueOrderId = exitVenueOrder?.orderId ?? order.exitVenueOrderId;
          order.exitPrice = exit.averagePriceCents / 100; order.exitFeeCents = unappliedExitFeeCents;
          order.saleProceedsCents = netProceedsCents; order.payoutCents = netProceedsCents;
          order.pnlCents = Math.floor(netProceedsCents + 1e-9) - order.stakeCents;
          order.actualPnlCents = netProceedsCents - (order.actualStakeCents ?? order.stakeCents);
          order.settledAt = new Date(nowMs).toISOString(); order.switchDecisionAt ??= new Date(nowMs).toISOString();
          order.reason = 'Recovered completed reduce-only exit during startup reconciliation; no replacement was submitted automatically.';
          settlements.push({ stakeCents: order.stakeCents, payoutCents: Math.max(0, Math.floor(netProceedsCents + 1e-9)), relatedId: `${order.id}:switch-exit` });
          recoveredFills += 1;
        } else {
          const soldRatio = unappliedExitCount / originalQuantity;
          const soldStake = (order.actualStakeCents ?? order.stakeCents) * soldRatio;
          const remainingActualStake = (order.actualStakeCents ?? order.stakeCents) - soldStake;
          const remainingReserved = Math.ceil(remainingActualStake - 1e-9);
          const releasedStake = Math.max(0, order.stakeCents - remainingReserved);
          const partialId = `${order.id}:exit:${exitVenueOrder?.orderId ?? order.exitVenueOrderId}`;
          if (!orders.some((item) => item.id === partialId)) orders.push({
            ...order, id: partialId, status: 'sold', quantity: Number(unappliedExitCount.toFixed(2)), filledCount: Number(unappliedExitCount.toFixed(2)),
            stakeCents: releasedStake, actualStakeCents: soldStake,
            actualPurchaseCents: (order.actualPurchaseCents ?? (order.authoritativeFillPrice ?? order.askPrice) * originalQuantity * 100) * soldRatio,
            actualFeeCents: (order.actualFeeCents ?? order.feeCents) * soldRatio,
            potentialPayoutCents: Math.round(unappliedExitCount * 100), exitPending: false,
            exitVenueOrderId: exitVenueOrder?.orderId ?? order.exitVenueOrderId, exitPrice: exit.averagePriceCents / 100,
            exitFeeCents: unappliedExitFeeCents, saleProceedsCents: netProceedsCents, payoutCents: netProceedsCents,
            pnlCents: Math.floor(netProceedsCents + 1e-9) - releasedStake, actualPnlCents: netProceedsCents - soldStake,
            settledAt: new Date(nowMs).toISOString(), reason: 'Recovered partial reduce-only exit during startup reconciliation; replacement withheld.',
          });
          order.quantity = Number((originalQuantity - unappliedExitCount).toFixed(2)); order.filledCount = order.quantity;
          order.actualPurchaseCents = (order.actualPurchaseCents ?? (order.authoritativeFillPrice ?? order.askPrice) * originalQuantity * 100) * (1 - soldRatio);
          order.actualFeeCents = (order.actualFeeCents ?? order.feeCents) * (1 - soldRatio);
          order.actualStakeCents = remainingActualStake; order.stakeCents = remainingReserved;
          order.potentialPayoutCents = Math.round(order.quantity * 100); order.exitPending = false;
          order.reason = 'Startup reconciliation recovered a partial reduce-only exit; remaining incumbent retained and replacement withheld.';
          settlements.push({ stakeCents: releasedStake, payoutCents: Math.max(0, Math.floor(netProceedsCents + 1e-9)), relatedId: `${partialId}:partial-switch-exit` });
          recoveredFills += 1;
        }
      }
    }
  }

  // A managed venue order without any local durable intent cannot be reconstructed safely.
  for (const venue of snapshot.orders.filter((item) => item.clientOrderId.startsWith('live:'))) {
    if (ambiguousVenueIds.has(venue.orderId) || isTerminalLegacyCreateRejection(venue, localLive)) continue;
    if (!localLive.some((local) => matchedOrders(local, [venue]).length > 0)) issues.push(`${venue.orderId}: managed Kalshi order ${venue.clientOrderId} has no local ledger record.`);
  }
  for (const resting of snapshot.restingOrders) issues.push(`${resting.orderId}: unrelated resting Kalshi order (${resting.clientOrderId || 'no client id'}) must be reviewed before automation resumes.`);

  const expectedByTicker = new Map<string, number>();
  for (const order of orders.filter((item) => item.executionMode === 'live' && item.venue === 'kalshi'
    && item.status === 'open' && claimsCurrentVenuePosition(item, nowMs))) {
    const signedQuantity = order.side === 'UP' ? order.quantity : -order.quantity;
    expectedByTicker.set(order.contractId, (expectedByTicker.get(order.contractId) ?? 0) + signedQuantity);
  }
  let venueManagedPositions = 0;
  const currentManagedTickers = new Set(localLive.filter((order) => claimsCurrentVenuePosition(order, nowMs))
    .map((order) => order.contractId));
  for (const ticker of currentManagedTickers) {
    const expected = expectedByTicker.get(ticker) ?? 0;
    const actual = snapshot.positions.find((position) => position.ticker === ticker)?.quantity ?? 0;
    if (Math.abs(actual - expected) > 0.011) issues.push(`${ticker}: Kalshi position ${actual.toFixed(2)} does not match local open quantity ${expected.toFixed(2)}.`);
    if (Math.abs(actual) > 1e-8) venueManagedPositions += 1;
  }

  const targetReservedCents = orders
    .filter((order) => order.executionMode === 'live' && (order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain'))
    .reduce((sum, order) => sum + order.stakeCents, 0);
  return { orders, issues: [...new Set(issues)], retryableIssues: [...new Set(retryableIssues)], targetReservedCents, recoveredFills, venueManagedPositions, settlements };
}
