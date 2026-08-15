import { describe, expect, it } from 'vitest';
import {
  buildLongShotOrder, longShotDailyNetLossCents, longShotFunding, longShotRealizedPnlCents,
  longShotReservedCents, openLongShotPositions,
} from './long-shot-engine';
import { longShotSettings } from './long-shot-policy';
import type { PaperOrder } from './types';

const settings = longShotSettings({
  NODE_ENV: 'test', MONEY_NOODLE_LONG_SHOT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv);

let counter = 0;
const order = (patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: `ls-${counter += 1}`, executionMode: 'live', strategyId: 'long-shot-round-trip',
  symbol: 'BTC', venue: 'kalshi', contractId: 'KXBTC15M-TEST', side: 'UP', status: 'lost',
  createdAt: '2026-08-15T00:01:00Z', calculationAt: '2026-08-15T00:01:00Z', closesAt: '2026-08-15T00:15:00Z',
  settledAt: '2026-08-15T00:15:05Z',
  modelProbabilityUp: 0.5, confidence: 0, askPrice: 0.1, bidPrice: 0.09, spread: 0.01,
  quantity: 1.8, stakeCents: 20, feeCents: 2, potentialPayoutCents: 180, actualPnlCents: -20,
  ...patch,
});

describe('strategy-scoped money', () => {
  const mixed = [
    order({ actualPnlCents: -20 }),
    order({ actualPnlCents: 140, status: 'sold' }),
    order({ id: 'edge-1', strategyId: 'edge-binary-buy', actualPnlCents: -500 }),
    order({ id: 'paper-1', executionMode: 'paper', actualPnlCents: 900 }),
  ];

  it('counts only this strategy and only this track', () => {
    // The edge policy's 500c loss and the paper lane's 900c gain are both irrelevant to live equity.
    expect(longShotRealizedPnlCents(mixed, 'live')).toBe(120);
    expect(longShotRealizedPnlCents(mixed, 'paper')).toBe(900);
  });

  it('charges a strategy only its own open positions', () => {
    const withOpen = [...mixed, order({ status: 'open', stakeCents: 20 }), order({ id: 'edge-2', strategyId: 'edge-binary-buy', status: 'open', stakeCents: 500 })];
    expect(longShotReservedCents(withOpen, 'live')).toBe(20);
    expect(openLongShotPositions(withOpen, 'live')).toHaveLength(1);
  });

  it('excludes exit legs so a round trip is not double counted', () => {
    const withExit = [...mixed, order({ id: 'ls-1:exit:1', status: 'sold', actualPnlCents: 140 })];
    expect(longShotRealizedPnlCents(withExit, 'live')).toBe(120);
  });
});

describe('funding', () => {
  it('rolls equity forward from the allocation on its own results', () => {
    const funding = longShotFunding([order({ actualPnlCents: 140, status: 'sold' })], 'live', 600, settings);
    expect(funding).toMatchObject({ equityCents: 740, reservedCents: 0, headroomCents: 740 });
    expect(funding.sizing.ticketCents).toBe(24);
  });

  it('reduces headroom by its own committed stake without touching equity', () => {
    const funding = longShotFunding([order({ status: 'open', stakeCents: 20, actualPnlCents: undefined })], 'live', 600, settings);
    expect(funding.equityCents).toBe(600);
    expect(funding.headroomCents).toBe(580);
  });

  it('halts on its own drawdown, not the account\'s', () => {
    expect(longShotFunding([order({ actualPnlCents: -301 })], 'live', 600, settings).sizing.halted).toBe(true);
    // An edge-policy wipeout leaves this strategy funded.
    expect(longShotFunding([order({ id: 'edge', strategyId: 'edge-binary-buy', actualPnlCents: -1_900 })], 'live', 600, settings).sizing.halted).toBe(false);
  });
});

describe('daily circuit breaker', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');

  it('counts net loss inside the trailing day and ignores older results', () => {
    const orders = [
      order({ actualPnlCents: -20, settledAt: '2026-08-15T06:00:00Z' }),
      order({ actualPnlCents: -20, settledAt: '2026-08-15T11:00:00Z' }),
      order({ actualPnlCents: -500, settledAt: '2026-08-10T00:00:00Z' }),
    ];
    expect(longShotDailyNetLossCents(orders, 'live', now)).toBe(40);
  });

  it('reports zero while the strategy is up, so a winning run is never throttled', () => {
    // A loss cap rather than a spend cap: the breaker exists for a misfiring trigger, not for winning.
    const orders = [
      order({ actualPnlCents: -20, settledAt: '2026-08-15T06:00:00Z' }),
      order({ actualPnlCents: 140, status: 'sold', settledAt: '2026-08-15T07:00:00Z' }),
    ];
    expect(longShotDailyNetLossCents(orders, 'live', now)).toBe(0);
  });
});

describe('order construction', () => {
  const built = buildLongShotOrder({
    mode: 'live', symbol: 'BTC', side: 'UP', contractId: 'KXBTC15M-TEST',
    closesAt: '2026-08-15T00:15:00Z', calculationAt: '2026-08-15T00:01:00Z',
    entryAsk: 0.10, oppositeAsk: 0.91, entryGeneration: 1, exitMarkCents: 90,
    fill: { quantity: 1.8, limitPriceCents: 10, feeCents: 2, stakeCents: 20, potentialPayoutCents: 180 },
  });

  it('stamps the strategy explicitly so it cannot default into the edge policy', () => {
    // An unattributed order would normalize to the edge policy and land inside its loss breaker and its
    // published track record.
    expect(built.strategyId).toBe('long-shot-round-trip');
    expect(built.marketId).toBe('crypto-15m');
    expect(built.exitTargetCents).toBe(90);
  });

  it('derives the owned-side bid from the opposite ask and seeds the peak', () => {
    expect(built.bidPrice).toBeCloseTo(0.09, 6);
    expect(built.peakOwnedSideBidCents).toBe(9);
  });

  it('gives a re-entry its own durable id', () => {
    const reentry = buildLongShotOrder({
      mode: 'live', symbol: 'BTC', side: 'UP', contractId: 'KXBTC15M-TEST',
      closesAt: '2026-08-15T00:15:00Z', calculationAt: '2026-08-15T00:01:00Z',
      entryAsk: 0.10, oppositeAsk: 0.91, entryGeneration: 2, exitMarkCents: 90,
      fill: { quantity: 1.8, limitPriceCents: 10, feeCents: 2, stakeCents: 20, potentialPayoutCents: 180 },
    });
    expect(reentry.id).not.toBe(built.id);
    expect(reentry.id).toContain('reentry:2');
    expect(reentry.entryGeneration).toBe(2);
  });

  it('records no model probability it did not use', () => {
    // The trigger is a venue price and a clock. A fabricated forecast would be worse than an explicit 0.5
    // with zero confidence.
    expect(built.confidence).toBe(0);
  });
});
