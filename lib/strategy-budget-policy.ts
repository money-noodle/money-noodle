import { DEFAULT_STRATEGY_ID, EDGE_BINARY_BUY } from './strategy-registry';
import { MAX_ALLOCATION_PERCENT } from './provider-budget-policy';
import type { MarketAllocation, MarketFunding, StrategyAllocation, StrategyFunding, StrategyId } from './types';

/**
 * The fourth level of budget keying: provider holds the cash, market takes a percentage of the provider,
 * strategy takes a percentage of the market. See docs/long-shot-policy-design.md §6 and §12.
 *
 * Pure and I/O free. The strategy's realized P&L is passed in, read by the caller from the shared order
 * ledger, so there is no parallel durable counter that could drift away from the immutable record.
 */

/** Every allocation written before strategies were explicit gave the whole market to the edge policy. */
export function strategyAllocations(allocation: MarketAllocation | undefined): StrategyAllocation[] {
  if (!allocation) return [];
  if (allocation.strategies?.length) return allocation.strategies;
  return [{
    strategyId: EDGE_BINARY_BUY, percent: MAX_ALLOCATION_PERCENT,
    startingCents: 0, fundedAt: '',
  }];
}

export function strategyAllocation(allocation: MarketAllocation | undefined, strategyId: StrategyId): StrategyAllocation | undefined {
  return strategyAllocations(allocation).find((item) => item.strategyId === strategyId);
}

const roundPercent = (value: number) => Number(value.toFixed(6));

/**
 * Strategy shares are hard caps inside the market, bounded exactly as market shares are inside the
 * provider. An unallocated remainder stays uncommitted rather than being shared out: lending one strategy
 * another's headroom is precisely what makes a split budget stop meaning anything, and here it would also
 * break the isolation the loss stop depends on.
 */
export function strategyAllocationsValid(allocations: StrategyAllocation[]): boolean {
  if (allocations.some((item) => !(item.percent >= 0) || roundPercent(item.percent) > MAX_ALLOCATION_PERCENT)) return false;
  if (allocations.some((item) => !(item.startingCents >= 0) || !Number.isFinite(item.startingCents))) return false;
  const ids = new Set(allocations.map((item) => item.strategyId));
  if (ids.size !== allocations.length) return false;
  return roundPercent(allocations.reduce((sum, item) => sum + item.percent, 0)) <= MAX_ALLOCATION_PERCENT;
}

/** Cash a percentage of a market cap funds, floored to whole cents. */
export function strategyStartingCents(marketCapCents: number, percent: number): number {
  if (!Number.isFinite(marketCapCents) || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.floor(Math.max(0, marketCapCents) * Math.max(0, percent) / 100));
}

/**
 * Equity a strategy's ticket is sized from: what it was funded with, plus what it has actually earned or
 * lost. Deliberately not a live percentage of current market equity — that would size this strategy's
 * ticket from the other's results, and would dilute its own losses by its share so the drawdown halt
 * could never fire on the strategy that earned it.
 */
export function strategyEquityCents(startingCents: number, realizedPnlCents: number): number {
  const equity = Math.floor(startingCents + realizedPnlCents);
  return Number.isFinite(equity) ? Math.max(0, equity) : 0;
}

export interface StrategyFundingInput {
  funding: MarketFunding;
  strategyId: StrategyId;
  allocation: StrategyAllocation | undefined;
  /** This strategy's own settled P&L across the shared ledger. */
  realizedPnlCents: number;
  /** This strategy's own open commitments. */
  reservedCents: number;
  /** Ticket and halt, from the pure long-shot sizing rule or an equivalent for another strategy. */
  sizing: { ticketCents: number; halted: boolean; reason?: string };
}

/**
 * What one strategy may commit right now. Three ceilings apply in order, and the reason names which one
 * binds, because they call for different operator action: the strategy has halted on its own drawdown;
 * its own allocation is committed by its own positions; or the market it sits in has no cash left.
 */
export function strategyFunding(input: StrategyFundingInput): StrategyFunding {
  const { funding, strategyId, allocation, realizedPnlCents, reservedCents, sizing } = input;
  const percent = allocation?.percent ?? 0;
  const startingCents = allocation?.startingCents ?? 0;
  const equityCents = strategyEquityCents(startingCents, realizedPnlCents);
  const ownReserved = Math.max(0, Math.floor(reservedCents));
  const headroom = Math.max(0, equityCents - ownReserved);
  // The market's own spendable figure already accounts for provider cash and the market cap, so this
  // never authorises spend the level above would refuse.
  const spendableCents = sizing.halted ? 0 : Math.max(0, Math.min(headroom, funding.spendableCents));

  const reason = percent <= 0
    ? `No ${strategyId} allocation configured for ${funding.providerId} ${funding.marketId}.`
    : sizing.halted
      ? sizing.reason ?? `${strategyId} has halted.`
      : headroom <= 0
        ? `${strategyId} has committed its ${equityCents}¢ of equity to its own ${ownReserved}¢ of open positions.`
        : spendableCents < headroom
          ? `${strategyId} has ${headroom}¢ of its own headroom but ${funding.marketId} can only fund ${funding.spendableCents}¢.`
          : `${strategyId} may commit ${spendableCents}¢ of its ${equityCents}¢ equity (${percent}% of ${funding.capCents}¢ funded at ${startingCents}¢) in ${sizing.ticketCents}¢ tickets.`;

  return {
    strategyId, marketId: funding.marketId, mode: funding.mode, percent,
    startingCents, realizedPnlCents, equityCents, reservedCents: ownReserved,
    spendableCents, ticketCents: sizing.ticketCents, halted: sizing.halted, reason,
  };
}

/** Whether a strategy can fund one more ticket right now. Sizing and cash are separate failures. */
export function strategyCanFundTicket(funding: StrategyFunding): boolean {
  return !funding.halted && funding.ticketCents > 0 && funding.spendableCents >= funding.ticketCents;
}

export { DEFAULT_STRATEGY_ID };
