import { describe, expect, it } from 'vitest';
import { longShotSettings, longShotSizing } from './long-shot-policy';
import { marketFunding } from './provider-budget-policy';
import {
  strategyAllocation, strategyAllocations, strategyAllocationsValid, strategyCanFundTicket,
  strategyEquityCents, strategyFunding, strategyStartingCents,
} from './strategy-budget-policy';
import { EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import type { MarketAllocation, ProviderBudget } from './types';

const settings = longShotSettings({
  NODE_ENV: 'test', MONEY_NOODLE_LONG_SHOT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv);

const budget = (allocations: MarketAllocation[]): ProviderBudget => ({
  providerId: 'kalshi', liveLimitCents: 0, paperLimitCents: 0, allocations,
  updatedAt: '2026-08-15T00:00:00Z',
});

/** The live configuration: one provider, one market, 2000c of equity, all of it allocated. */
const funding = (availableCents = 2_000, reservedCents = 0) => marketFunding({
  providerId: 'kalshi', marketId: 'crypto-15m', mode: 'live',
  budget: budget([{ marketId: 'crypto-15m', percent: 100 }]),
  modeEquityCents: 2_000, availableCents, reservedCents,
});

const allocation = (percent: number, startingCents: number) => ({
  strategyId: LONG_SHOT_ROUND_TRIP, percent, startingCents, fundedAt: '2026-08-15T00:00:00Z',
});

describe('strategy allocations', () => {
  it('gives the whole market to the edge policy when none are configured', () => {
    // Every allocation written before 2026-08-15 meant exactly this, so it must not read as unfunded.
    const legacy = strategyAllocations({ marketId: 'crypto-15m', percent: 100 });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ strategyId: EDGE_BINARY_BUY, percent: 100 });
    expect(strategyAllocation({ marketId: 'crypto-15m', percent: 100 }, LONG_SHOT_ROUND_TRIP)).toBeUndefined();
  });

  it('bounds the sum at the whole market and leaves any remainder uncommitted', () => {
    expect(strategyAllocationsValid([allocation(30, 600)])).toBe(true);
    expect(strategyAllocationsValid([
      { strategyId: EDGE_BINARY_BUY, percent: 70, startingCents: 1_400, fundedAt: '' }, allocation(30, 600),
    ])).toBe(true);
    expect(strategyAllocationsValid([
      { strategyId: EDGE_BINARY_BUY, percent: 80, startingCents: 1_600, fundedAt: '' }, allocation(30, 600),
    ])).toBe(false);
    expect(strategyAllocationsValid([allocation(30, 600), allocation(10, 200)])).toBe(false);
    expect(strategyAllocationsValid([allocation(-5, 100)])).toBe(false);
  });

  it('funds 30% of a 2000c market cap as 600c', () => {
    expect(strategyStartingCents(2_000, 30)).toBe(600);
    expect(strategyStartingCents(2_000, 0)).toBe(0);
    expect(strategyStartingCents(Number.NaN, 30)).toBe(0);
  });
});

describe('strategy equity is its own, not a live share of the market', () => {
  it('rolls forward from what it was funded with plus what it earned', () => {
    expect(strategyEquityCents(600, 0)).toBe(600);
    expect(strategyEquityCents(600, 140)).toBe(740);
    expect(strategyEquityCents(600, -300)).toBe(300);
    expect(strategyEquityCents(600, -900)).toBe(0);
  });

  it('lets the long-shot drawdown halt fire on its own losses rather than the account\'s', () => {
    // The point of not re-applying the percentage continuously. At 30%, its own losses would reach a live
    // share diluted more than threefold, so a 50% strategy drawdown would barely move the figure and the
    // halt could never fire on the strategy that earned it.
    const own = strategyEquityCents(600, -301);
    expect(longShotSizing(own, settings).halted).toBe(true);
    expect(longShotSizing(strategyEquityCents(600, -300), settings).halted).toBe(false);
  });

  it('sizes the ticket from its own equity, so a run of losses shrinks the next bet', () => {
    expect(longShotSizing(strategyEquityCents(600, 0), settings).ticketCents).toBe(20);
    expect(longShotSizing(strategyEquityCents(600, -150), settings).ticketCents).toBe(15);
    expect(longShotSizing(strategyEquityCents(600, 600), settings).ticketCents).toBe(40);
  });
});

describe('strategy funding', () => {
  const fund = (patch: Partial<Parameters<typeof strategyFunding>[0]> = {}) => {
    const realizedPnlCents = patch.realizedPnlCents ?? 0;
    const equity = strategyEquityCents(600, realizedPnlCents);
    return strategyFunding({
      funding: funding(), strategyId: LONG_SHOT_ROUND_TRIP, allocation: allocation(30, 600),
      realizedPnlCents, reservedCents: 0, sizing: longShotSizing(equity, settings), ...patch,
    });
  };

  it('reports the funded slice, its own equity, and a fundable ticket', () => {
    const result = fund();
    expect(result).toMatchObject({
      strategyId: LONG_SHOT_ROUND_TRIP, percent: 30, startingCents: 600,
      equityCents: 600, spendableCents: 600, ticketCents: 20, halted: false,
    });
    expect(strategyCanFundTicket(result)).toBe(true);
  });

  it('charges a strategy only its own open positions', () => {
    const result = fund({ reservedCents: 580 });
    expect(result.spendableCents).toBe(20);
    expect(strategyCanFundTicket(result)).toBe(true);
    expect(fund({ reservedCents: 600 }).spendableCents).toBe(0);
  });

  it('stops funding entirely once the strategy has halted', () => {
    const halted = fund({ realizedPnlCents: -301 });
    expect(halted.halted).toBe(true);
    expect(halted.spendableCents).toBe(0);
    expect(strategyCanFundTicket(halted)).toBe(false);
    expect(halted.reason).toContain('below the 300¢ required');
  });

  it('never authorises more than the market above it can fund', () => {
    // An allocation grants permission to spend, never the money itself. Provider cash still binds.
    const starved = fund({ funding: funding(50) });
    expect(starved.spendableCents).toBe(50);
    expect(starved.reason).toContain('can only fund 50¢');
    expect(strategyCanFundTicket(starved)).toBe(true);
    expect(strategyCanFundTicket(fund({ funding: funding(5) }))).toBe(false);
  });

  it('names an unconfigured strategy as unfunded rather than halted', () => {
    // Different operator action: one needs an allocation, the other needs a review of why it lost.
    const absent = fund({ allocation: undefined, sizing: longShotSizing(0, settings) });
    expect(absent.percent).toBe(0);
    expect(absent.spendableCents).toBe(0);
    expect(absent.reason).toContain('No long-shot-round-trip allocation configured');
  });
});
