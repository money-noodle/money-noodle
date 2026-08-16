import type { StrategyDescriptor, StrategyId } from './types';

/**
 * Strategies running on a market. Mirrors `market-registry` deliberately: the axis is declared once, every
 * durable record carries it explicitly, and adding a third strategy is an addition here rather than a
 * migration of every order and summary already written.
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
    signalSource: 'model-probability',
    description: 'Buys a side when the venue-independent probability exceeds the executable ask by a margin after fees, and holds to settlement unless a reduce-only exit or protected switch qualifies.',
  },
  {
    id: 'long-shot-round-trip',
    name: 'Long-shot round trip',
    signalSource: 'venue-price',
    description: 'Buys a side whose executable ask falls to a low mark early in the cycle and sells it through a resting reduce-only limit at a high mark. Uses no model probability; the trigger is a venue price and a clock.',
  },
];

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

/** Durable records predating explicit strategies belong to the strategy that existed when they were written. */
export function normalizeStrategyId(value: unknown): StrategyId {
  return isStrategyId(value) ? value : DEFAULT_STRATEGY_ID;
}
