import type { ExecutionMode, PaperOrder, PositionSide } from './types';
import { orderStrategyId } from './execution-report';
import { LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import { longShotPolicyVersion, longShotSizing, type LongShotSettings, type LongShotSizing } from './long-shot-policy';

/**
 * Money accounting for the long-shot policy, kept separate from the edge policy's without adding a second
 * durable bankroll.
 *
 * Both figures are derived from the shared order ledger rather than stored. A parallel counter would be a
 * second source of truth that could drift from the immutable record, and it would need its own
 * reconciliation; the ledger already knows every stake and every settlement.
 *
 * Pure and I/O free.
 */

const SETTLED = new Set(['won', 'lost', 'sold', 'invalid']);
const COMMITTED = new Set(['open', 'pending_reservation', 'uncertain']);

/**
 * This strategy's orders in one track, from a funding epoch onward.
 *
 * `sinceMs` is when the allocation was last funded. Re-funding sets a new starting amount, so P&L earned
 * against the previous one must not carry across: fund 600¢, lose 300¢, re-fund at 800¢, and counting the
 * old loss again would report 500¢ of equity against 800¢ actually committed. Budget changes require a
 * paused, quiescent engine with nothing reserved, so no order can straddle the boundary.
 */
const mine = (orders: PaperOrder[], mode: ExecutionMode, sinceMs = 0) => orders.filter((order) =>
  orderStrategyId(order) === LONG_SHOT_ROUND_TRIP && order.executionMode === mode && !order.id.includes(':exit:')
  && Date.parse(order.createdAt) >= sinceMs);

/** This strategy's realized P&L in one track. Never crosses tracks: `paper − live` must stay readable. */
export function longShotRealizedPnlCents(orders: PaperOrder[], mode: ExecutionMode, sinceMs = 0): number {
  return mine(orders, mode, sinceMs)
    .filter((order) => SETTLED.has(order.status))
    .reduce((sum, order) => sum + (order.actualPnlCents ?? order.pnlCents ?? 0), 0);
}

/** Stake committed to this strategy's own open positions in one track. */
export function longShotReservedCents(orders: PaperOrder[], mode: ExecutionMode): number {
  return mine(orders, mode)
    .filter((order) => COMMITTED.has(order.status))
    .reduce((sum, order) => sum + (order.actualStakeCents ?? order.stakeCents), 0);
}

export interface LongShotFunding {
  equityCents: number;
  reservedCents: number;
  /** equity − own reservations. Cash and the market cap bound this again at the caller. */
  headroomCents: number;
  sizing: LongShotSizing;
}

/**
 * What this strategy may commit in one track right now.
 *
 * Equity is the funded allocation plus its own realized P&L — deliberately not a live share of current
 * market equity, which would size this strategy's ticket from the other's results and dilute its own
 * losses so the drawdown halt could never fire on the strategy that earned it.
 */
export function longShotFunding(
  orders: PaperOrder[], mode: ExecutionMode, startingCents: number, settings: LongShotSettings,
  fundedAtMs = 0,
): LongShotFunding {
  const equityCents = Math.max(0, Math.floor(startingCents + longShotRealizedPnlCents(orders, mode, fundedAtMs)));
  const reservedCents = longShotReservedCents(orders, mode);
  return {
    equityCents, reservedCents,
    headroomCents: Math.max(0, equityCents - reservedCents),
    sizing: longShotSizing(equityCents, settings),
  };
}

/**
 * Net loss over the trailing day, as a positive number of cents. Zero when the strategy is up.
 *
 * A loss cap rather than a spend cap: a spend cap would throttle the policy exactly when it is winning and
 * re-entering, which is the opposite of the intent. It is a circuit breaker against a misfiring trigger, not
 * a throttle on ordinary losing, and at the measured candidate flow it should almost never bind.
 */
export function longShotDailyNetLossCents(orders: PaperOrder[], mode: ExecutionMode, nowMs = Date.now()): number {
  const since = nowMs - 24 * 60 * 60_000;
  const net = mine(orders, mode)
    .filter((order) => SETTLED.has(order.status) && Date.parse(order.settledAt ?? order.createdAt) >= since)
    .reduce((sum, order) => sum + (order.actualPnlCents ?? order.pnlCents ?? 0), 0);
  return Math.max(0, -net);
}

/** Open long-shot positions in one track, for the caps and for the exit poller. */
export function openLongShotPositions(orders: PaperOrder[], mode: ExecutionMode): PaperOrder[] {
  return mine(orders, mode).filter((order) => COMMITTED.has(order.status));
}

export interface LongShotOrderInput {
  mode: ExecutionMode;
  symbol: string;
  side: PositionSide;
  contractId: string;
  closesAt: string;
  calculationAt: string;
  entryAsk: number;
  oppositeAsk: number;
  entryGeneration: number;
  exitMarkCents: number;
  settings: LongShotSettings;
  /** Trailing evidence, when the entry waited for the fall to stall. */
  firstTouchAskCents?: number;
  trailingLooks?: number;
  /** Live only: the funding epoch that bought this order. */
  budgetEpochId?: string;
  /** Paper only: the bankroll funding that bought it. The two tracks never share an identity. */
  paperBankrollId?: string;
  fill: { quantity: number; limitPriceCents: number; feeCents: number; stakeCents: number; potentialPayoutCents: number };
}

/**
 * A long-shot entry order.
 *
 * `strategyId` is stamped explicitly rather than defaulted: an unattributed order would normalize to the
 * edge policy and land inside its loss breaker and its published track record.
 */
export function buildLongShotOrder(input: LongShotOrderInput): PaperOrder {
  const base = `${input.mode}:long-shot:${input.symbol}:${input.side}:${input.closesAt}`;
  const id = input.entryGeneration > 1 ? `${base}:reentry:${input.entryGeneration}` : base;
  return {
    id, logicalOrderId: id, clientOrderId: id, attemptNumber: 1,
    executionMode: input.mode,
    strategyId: LONG_SHOT_ROUND_TRIP,
    marketId: 'crypto-15m',
    providerId: 'kalshi',
    ...(input.mode === 'live'
      ? { budgetEpochId: input.budgetEpochId }
      : { paperBankrollId: input.paperBankrollId }),
    symbol: input.symbol, venue: 'kalshi', contractId: input.contractId, side: input.side,
    status: 'pending_reservation',
    createdAt: new Date().toISOString(),
    calculationAt: input.calculationAt,
    closesAt: input.closesAt,
    // This policy consumes no model probability; the trigger is a venue price and a clock. The field is
    // required by the ledger shape, and a fabricated forecast here would be worse than an explicit 0.5.
    modelProbabilityUp: 0.5,
    confidence: 0,
    askPrice: input.entryAsk,
    bidPrice: 1 - input.oppositeAsk,
    spread: Math.max(0, input.entryAsk + input.oppositeAsk - 1),
    issuanceAskPrice: input.entryAsk,
    issuanceBidPrice: 1 - input.oppositeAsk,
    quantity: input.fill.quantity,
    stakeCents: input.fill.stakeCents,
    feeCents: input.fill.feeCents,
    potentialPayoutCents: input.fill.potentialPayoutCents,
    entryGeneration: input.entryGeneration,
    exitTargetCents: input.exitMarkCents,
    strategyPolicyVersion: longShotPolicyVersion(input.settings),
    firstTouchAskCents: input.firstTouchAskCents,
    trailingLooks: input.trailingLooks,
    peakOwnedSideBidCents: Math.round((1 - input.oppositeAsk) * 100),
  };
}
