import type { StrategyDescriptor, StrategyId } from './types';

/**
 * Known strategy identities. Mirrors `market-registry` deliberately: every durable record remains
 * attributable even after a strategy retires. Only `ACTIVE_STRATEGIES` may appear in allocation controls
 * or receive new execution authority.
 */
export const EDGE_BINARY_BUY: StrategyId = 'edge-binary-buy';

/**
 * Default carried by records written before strategies were explicit. Every order in the ledger up to
 * 2026-08-15 came from the edge policy, which is the only thing that traded, so an absent field is not
 * ambiguous.
 */
export const DEFAULT_STRATEGY_ID: StrategyId = EDGE_BINARY_BUY;

export const LONG_SHOT_ROUND_TRIP: StrategyId = 'long-shot-round-trip';

export const STRATEGIES: StrategyDescriptor[] = [
  {
    id: 'edge-binary-buy',
    name: 'Edge binary buy',
    status: 'active',
    signalSource: 'model-probability',
    description: 'Buys a side when the venue-independent probability exceeds the executable ask by a margin after fees, and holds to settlement unless a reduce-only exit or protected switch qualifies.',
  },
  {
    id: 'long-shot-round-trip',
    name: 'Long-shot round trip (retired)',
    status: 'retired',
    signalSource: 'venue-price',
    description: 'Retired on 2026-08-26 after its prospective paper review. Retained only to attribute historical ledger, accounting, and reconciliation evidence; it has no execution or allocation authority.',
  },
];

export const ACTIVE_STRATEGIES: readonly StrategyDescriptor[] = STRATEGIES.filter((strategy) => strategy.status === 'active');

export function strategyDescriptor(strategyId: StrategyId): StrategyDescriptor {
  const found = STRATEGIES.find((strategy) => strategy.id === strategyId);
  // Unreachable for a typed StrategyId. The throw keeps a malformed durable record from being silently
  // attributed to the only strategy that used to exist, which would put long-shot P&L inside the edge
  // policy's loss breaker.
  if (!found) throw new Error(`Unknown strategy ${strategyId}.`);
  return found;
}

export function isStrategyId(value: unknown): value is StrategyId {
  return typeof value === 'string' && STRATEGIES.some((strategy) => strategy.id === value);
}

/** Retired identities remain parseable but can never be newly funded. */
export function isActiveStrategyId(value: unknown): value is StrategyId {
  return typeof value === 'string' && ACTIVE_STRATEGIES.some((strategy) => strategy.id === value);
}

/** Durable records predating explicit strategies belong to the strategy that existed when they were written. */
export function normalizeStrategyId(value: unknown): StrategyId {
  return isStrategyId(value) ? value : DEFAULT_STRATEGY_ID;
}
