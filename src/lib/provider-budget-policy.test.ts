import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  allocationPercent, allocationsValid, DEFAULT_ALLOCATION, marketFunding, providerEquityCents,
  totalAllocatedPercent,
} from './provider-budget-policy';
import { CRYPTO_15M } from './market-registry';
import type { ProviderBudget } from './types';

const budget = (overrides: Partial<ProviderBudget> = {}): ProviderBudget => ({
  providerId: 'kalshi', liveLimitCents: 0, paperLimitCents: 0,
  allocations: DEFAULT_ALLOCATION, updatedAt: '2026-08-13T00:00:00.000Z', ...overrides,
});

describe('market allocations', () => {
  it('accepts a full single-market allocation and rejects an over-commitment', () => {
    expect(allocationsValid([{ marketId: CRYPTO_15M, percent: 100 }])).toBe(true);
    expect(allocationsValid([{ marketId: CRYPTO_15M, percent: 60 }])).toBe(true);
    expect(allocationsValid([{ marketId: CRYPTO_15M, percent: 101 }])).toBe(false);
    expect(allocationsValid([{ marketId: CRYPTO_15M, percent: -1 }])).toBe(false);
  });

  it('rejects duplicate and unknown markets rather than silently merging them', () => {
    expect(allocationsValid([{ marketId: CRYPTO_15M, percent: 50 }, { marketId: CRYPTO_15M, percent: 50 }])).toBe(false);
    expect(allocationsValid([{ marketId: 'us-equities-daily' as never, percent: 50 }])).toBe(false);
  });

  it('tolerates decimal percentages that sum just past 100 through float error', () => {
    expect(totalAllocatedPercent([{ marketId: CRYPTO_15M, percent: 33.333333 }])).toBeCloseTo(33.333333);
    expect(allocationsValid([{ marketId: CRYPTO_15M, percent: 100.0000000001 }])).toBe(true);
  });

  it('reports no allocation for a market the provider has not been given', () => {
    expect(allocationPercent(budget({ allocations: [] }), CRYPTO_15M)).toBe(0);
    expect(allocationPercent(undefined, CRYPTO_15M)).toBe(0);
  });
});

describe('provider equity', () => {
  it('uses mode equity when no provider ceiling is configured', () => {
    expect(providerEquityCents(budget(), 'live', 2_153)).toBe(2_153);
  });

  it('applies a provider ceiling below mode equity, and never above it', () => {
    expect(providerEquityCents(budget({ liveLimitCents: 1_000 }), 'live', 2_153)).toBe(1_000);
    expect(providerEquityCents(budget({ liveLimitCents: 9_999 }), 'live', 2_153)).toBe(2_153);
  });

  it('keeps live and paper ceilings independent', () => {
    const both = budget({ liveLimitCents: 500, paperLimitCents: 5_000 });
    expect(providerEquityCents(both, 'live', 10_000)).toBe(500);
    expect(providerEquityCents(both, 'paper', 10_000)).toBe(5_000);
  });
});

describe('market funding', () => {
  const base = {
    providerId: 'kalshi' as const, marketId: CRYPTO_15M, mode: 'live' as const,
    modeEquityCents: 2_000, availableCents: 2_000, reservedCents: 0,
  };

  it('caps a market at its percentage of provider equity', () => {
    const funding = marketFunding({ ...base, budget: budget({ allocations: [{ marketId: CRYPTO_15M, percent: 60 }] }) });
    expect(funding.capCents).toBe(1_200);
    expect(funding.spendableCents).toBe(1_200);
  });

  it('charges a market only its own reservations', () => {
    const funding = marketFunding({ ...base, reservedCents: 500, budget: budget({ allocations: [{ marketId: CRYPTO_15M, percent: 60 }] }) });
    expect(funding.spendableCents).toBe(700);
  });

  it('never permits more than cash on hand, because an allocation is permission and not money', () => {
    const funding = marketFunding({ ...base, availableCents: 300, budget: budget() });
    expect(funding.capCents).toBe(2_000);
    expect(funding.spendableCents).toBe(300);
    expect(funding.reason).toMatch(/available cash/);
  });

  it('refuses to fund a market with no allocation, and says so', () => {
    const funding = marketFunding({ ...base, budget: budget({ allocations: [] }) });
    expect(funding.spendableCents).toBe(0);
    expect(funding.reason).toMatch(/No crypto-15m allocation/);
  });

  it('reports a fully committed allocation distinctly from an unfunded one', () => {
    const funding = marketFunding({ ...base, reservedCents: 1_200, budget: budget({ allocations: [{ marketId: CRYPTO_15M, percent: 60 }] }) });
    expect(funding.spendableCents).toBe(0);
    expect(funding.reason).toMatch(/fully committed/);
  });

  it('compounds with wins and contracts in drawdown, since the cap tracks equity', () => {
    const allocated = budget({ allocations: [{ marketId: CRYPTO_15M, percent: 50 }] });
    const grown = marketFunding({ ...base, budget: allocated, modeEquityCents: 4_000, availableCents: 4_000 });
    const shrunk = marketFunding({ ...base, budget: allocated, modeEquityCents: 1_000, availableCents: 1_000 });
    expect(grown.capCents).toBe(2_000);
    expect(shrunk.capCents).toBe(500);
  });

  it('cannot be pushed negative by a reservation larger than the cap', () => {
    const funding = marketFunding({ ...base, reservedCents: 99_999, budget: budget() });
    expect(funding.spendableCents).toBe(0);
    expect(funding.capCents).toBeGreaterThanOrEqual(0);
  });
});
