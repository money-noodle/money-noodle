import { DEFAULT_MARKET_ID, marketProviders, MARKETS } from './market-registry';
import type {
  ExecutionMode, MarketAllocation, MarketFunding, MarketId, ProviderBudget, TradingProviderId,
} from './types';

/** A market may be given the whole provider; several markets may not add up to more than the whole. */
export const MAX_ALLOCATION_PERCENT = 100;

/** Only market with production allocation today, so a seeded provider commits everything to it. */
export const DEFAULT_ALLOCATION: MarketAllocation[] = [{ marketId: DEFAULT_MARKET_ID, percent: 100 }];

export function allocationPercent(budget: ProviderBudget | undefined, marketId: MarketId): number {
  const found = budget?.allocations.find((item) => item.marketId === marketId);
  return found ? found.percent : 0;
}

/**
 * Allocations are hard caps that must fit inside the provider, so their sum is bounded. An unallocated
 * remainder is deliberately left uncommitted rather than shared out, since silently lending one market
 * another's headroom is how a split budget stops meaning anything.
 */
export function allocationsValid(allocations: MarketAllocation[]): boolean {
  // Rounded on the way in as well as in the sum: an allocation computed as 100.0000000001 is float
  // noise from arithmetic, not an operator asking for more than the whole provider.
  if (allocations.some((item) => !(item.percent >= 0) || roundPercent(item.percent) > MAX_ALLOCATION_PERCENT)) return false;
  if (allocations.some((item) => !MARKETS.some((market) => market.id === item.marketId))) return false;
  const markets = new Set(allocations.map((item) => item.marketId));
  if (markets.size !== allocations.length) return false;
  return totalAllocatedPercent(allocations) <= MAX_ALLOCATION_PERCENT;
}

const roundPercent = (value: number) => Number(value.toFixed(6));

export function totalAllocatedPercent(allocations: MarketAllocation[]): number {
  // Rounded because repeated decimal percentages sum to 100.00000000000001 and would fail the bound.
  return roundPercent(allocations.reduce((sum, item) => sum + item.percent, 0));
}

/**
 * Equity the allocation applies to: the working equity for this mode, further bounded by any
 * provider-specific ceiling. A percentage of current equity compounds with wins and contracts in
 * drawdown, which is the behaviour chosen over a fixed cents cap that would leave gains idle.
 */
export function providerEquityCents(budget: ProviderBudget | undefined, mode: ExecutionMode, modeEquityCents: number): number {
  const limit = mode === 'live' ? budget?.liveLimitCents ?? 0 : budget?.paperLimitCents ?? 0;
  const bounded = limit > 0 ? Math.min(modeEquityCents, limit) : modeEquityCents;
  return Math.max(0, Math.floor(bounded));
}

/**
 * What one (provider, market) pair may commit right now. `reservedCents` must be that pair's own open
 * commitments only: charging it another market's reservations would double-count, and charging it the
 * provider total would let one market's positions block a market that has its own headroom.
 */
export function marketFunding(input: {
  providerId: TradingProviderId;
  marketId: MarketId;
  mode: ExecutionMode;
  budget: ProviderBudget | undefined;
  modeEquityCents: number;
  availableCents: number;
  reservedCents: number;
}): MarketFunding {
  const { providerId, marketId, mode, budget, modeEquityCents, availableCents, reservedCents } = input;
  const percent = allocationPercent(budget, marketId);
  const equity = providerEquityCents(budget, mode, modeEquityCents);
  const capCents = Math.floor(equity * percent / 100);
  const headroom = Math.max(0, capCents - Math.max(0, reservedCents));
  // Cash still bounds the cap: an allocation grants permission to spend, never the money itself.
  const spendableCents = Math.max(0, Math.min(headroom, Math.floor(Math.max(0, availableCents))));
  // Names the binding constraint, so a skipped trade is never ambiguous between "no allocation left"
  // and "no cash left" — they call for different operator action.
  const cashBinds = Math.floor(Math.max(0, availableCents)) < headroom;
  const reason = percent <= 0
    ? `No ${marketId} allocation configured for ${providerId}.`
    : headroom <= 0
      ? `${providerId} ${marketId} allocation of ${percent}% (${capCents}¢) is fully committed by its own ${reservedCents}¢ of open positions.`
      : cashBinds
        ? `${providerId} ${marketId} has ${headroom}¢ of allocation headroom but only ${Math.floor(Math.max(0, availableCents))}¢ of available cash.`
        : `${providerId} ${marketId} may commit ${spendableCents}¢ of its ${capCents}¢ allocation (${percent}% of ${equity}¢).`;
  return { providerId, marketId, mode, providerEquityCents: equity, percent, capCents, reservedCents: Math.max(0, reservedCents), spendableCents, reason };
}

/** Providers declared for a market, so callers never invent a pair the registry does not describe. */
export function fundableProviders(marketId: MarketId): TradingProviderId[] {
  return marketProviders(marketId);
}
