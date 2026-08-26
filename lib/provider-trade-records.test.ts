import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildAttributedTradeRecords, buildProviderTradeRecords, buildTradeRecord, orderMarketId, orderProviderId } from './execution-report';
import { CRYPTO_15M } from './market-registry';
import { EMPTY_ORDER_ATTRIBUTION_FILTERS, orderMatchesAttribution } from './order-attribution';
import type { ExecutionMode, PaperOrder, PaperOrderStatus, TradingProviderId } from './types';

let sequence = 0;
function order(overrides: {
  mode: ExecutionMode; venue?: 'polymarket' | 'kalshi'; providerId?: TradingProviderId; providerVariantId?: string;
  status?: PaperOrderStatus; pnlCents?: number; marketId?: 'crypto-15m';
}): PaperOrder {
  const { mode, venue = 'kalshi', providerId, providerVariantId, status = 'won', pnlCents = 100, marketId } = overrides;
  sequence += 1;
  return {
    id: `order-${sequence}`, executionMode: mode, providerId, providerVariantId, marketId,
    symbol: 'BTC', venue, contractId: `c-${sequence}`, side: 'UP', status,
    createdAt: '2026-08-11T00:01:00Z', calculationAt: '2026-08-11T00:00:30Z',
    closesAt: `2026-08-11T0${sequence % 9}:15:00Z`,
    modelProbabilityUp: 0.62, confidence: 0.7, askPrice: 0.5, bidPrice: 0.48, spread: 0.02,
    quantity: 10, stakeCents: 500, feeCents: 10, potentialPayoutCents: 1_000,
    ...(status === 'won' || status === 'lost' ? { settledAt: '2026-08-11T00:15:05Z', outcome: 'UP' as const, payoutCents: 500 + pnlCents, pnlCents } : {}),
  };
}

describe('order identity fallbacks', () => {
  it('attributes orders written before providerId existed to their venue', () => {
    expect(orderProviderId(order({ mode: 'live', venue: 'polymarket' }))).toBe('polymarket');
    expect(orderProviderId(order({ mode: 'live', venue: 'kalshi', providerId: 'kalshi' }))).toBe('kalshi');
  });

  it('attributes orders written before markets were explicit to crypto-15m', () => {
    expect(orderMarketId(order({ mode: 'paper' }))).toBe(CRYPTO_15M);
    expect(orderMarketId(order({ mode: 'paper', marketId: 'crypto-15m' }))).toBe(CRYPTO_15M);
  });
});

describe('per-provider trade records', () => {
  const orders = [
    order({ mode: 'live', venue: 'kalshi', pnlCents: 200 }),
    order({ mode: 'live', venue: 'kalshi', providerId: 'kalshi', pnlCents: 100 }),
    order({ mode: 'live', venue: 'polymarket', pnlCents: -50 }),
    order({ mode: 'live', venue: 'kalshi', status: 'unfilled' }),
    order({ mode: 'live', venue: 'kalshi', status: 'rejected' }),
    order({ mode: 'paper', venue: 'kalshi', pnlCents: 75 }),
  ];

  it('splits a mode by provider without mixing another provider in', () => {
    const live = buildProviderTradeRecords(orders, 'live');
    expect(live.map((item) => item.providerId)).toEqual(['kalshi', 'polymarket']);
    const kalshi = live.find((item) => item.providerId === 'kalshi')!.record;
    const polymarket = live.find((item) => item.providerId === 'polymarket')!.record;
    expect(kalshi.realizedPnlCents).toBe(300);
    expect(polymarket.realizedPnlCents).toBe(-50);
    expect(live.map((item) => item.marketId)).toEqual([CRYPTO_15M, CRYPTO_15M]);
  });

  it('tracks attempts and failures per provider, not only settled wins', () => {
    const kalshi = buildProviderTradeRecords(orders, 'live').find((item) => item.providerId === 'kalshi')!.record;
    expect(kalshi.unfilled).toBe(1);
    expect(kalshi.rejected).toBe(1);
    expect(buildProviderTradeRecords(orders, 'live').find((item) => item.providerId === 'polymarket')!.record.unfilled).toBe(0);
  });

  it('never leaks orders across execution modes', () => {
    const paper = buildProviderTradeRecords(orders, 'paper');
    expect(paper).toHaveLength(1);
    expect(paper[0].record.realizedPnlCents).toBe(75);
    expect(paper[0].record.mode).toBe('paper');
  });

  it('reconciles with the combined record for the same mode', () => {
    const combined = buildTradeRecord(orders, 'live');
    const split = buildProviderTradeRecords(orders, 'live');
    expect(split.reduce((sum, item) => sum + item.record.realizedPnlCents, 0)).toBe(combined.realizedPnlCents);
    expect(split.reduce((sum, item) => sum + item.record.settled, 0)).toBe(combined.settled);
    expect(split.reduce((sum, item) => sum + item.record.unfilled + item.record.rejected, 0)).toBe(combined.unfilled + combined.rejected);
  });

  it('does not blend provider variants in exact attribution rows', () => {
    const generationRows = [
      order({ mode: 'live', providerId: 'kalshi', providerVariantId: 'variant-a', pnlCents: 40 }),
      order({ mode: 'live', providerId: 'kalshi', providerVariantId: 'variant-b', pnlCents: -20 }),
    ];
    const records = buildAttributedTradeRecords(generationRows, 'live');
    expect(records.map((item) => item.attribution.providerVariantId).sort()).toEqual(['variant-a', 'variant-b']);
    expect(records.reduce((sum, item) => sum + item.record.realizedPnlCents, 0)).toBe(20);
    const filtered = generationRows.filter((item) => orderMatchesAttribution(item, {
      ...EMPTY_ORDER_ATTRIBUTION_FILTERS, modes: ['live'], providerVariantIds: ['variant-a'],
    }));
    expect(buildTradeRecord(filtered, 'live').realizedPnlCents).toBe(40);
    expect(buildTradeRecord(filtered, 'paper').settled).toBe(0);
  });
});
