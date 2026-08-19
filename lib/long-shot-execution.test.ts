import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  LONG_SHOT_DEFAULT_ALLOCATION_PERCENT, collectLongShotEvidence, holdSentinelFromStampedPaperOrder,
  longShotAllocationCents, longShotSizingFor, longShotTrackStartingCents, sentinelPeakBids,
} from './long-shot-execution';
import { HOLD_SENTINEL_VERSION, type HoldSentinel } from './hold-sentinel';
import { longShotSettings, longShotSizing } from './long-shot-policy';
import type { DashboardData, PaperOrder, Prediction } from './types';

const settings = longShotSettings({
  NODE_ENV: 'test', MONEY_NOODLE_LONG_SHOT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv);

const closesAt = '2026-08-15T00:15:00Z';
const nowMs = Date.parse('2026-08-15T00:01:00Z');

const prediction = (symbol: string, askUp: number, askDown: number): Prediction => ({
  symbol,
  kalshi: {
    venue: 'kalshi', probabilityUp: askUp, bidUp: askUp - 0.01, askUp, bidDown: askDown - 0.01, askDown,
    liquidity: 100, volume: 100, url: '', closesAt, ticker: `KX${symbol}15M-TEST`, live: true,
    comparability: 'approximate',
  },
} as unknown as Prediction);

const dashboard = (...predictions: Prediction[]) => ({ predictions } as unknown as DashboardData);

const sizing = longShotSizing(600, settings);

const order = (patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: 'ls-1', executionMode: 'live', strategyId: 'long-shot-round-trip',
  symbol: 'BTC', venue: 'kalshi', contractId: 'KXBTC15M-TEST', side: 'UP', status: 'open',
  createdAt: '2026-08-15T00:01:00Z', calculationAt: '2026-08-15T00:01:00Z', closesAt,
  modelProbabilityUp: 0.5, confidence: 0.5, askPrice: 0.1, bidPrice: 0.09, spread: 0.01,
  quantity: 1.8, stakeCents: 20, feeCents: 2, potentialPayoutCents: 180,
  ...patch,
});

describe('long-shot trigger capture', () => {
  const stampedOrder = (patch: Partial<PaperOrder> = {}) => order({
    executionMode: 'paper', strategyPolicyVersion: 'long-shot-round-trip-buy10-sell90-win600-v1',
    holdSentinelVersion: HOLD_SENTINEL_VERSION, entryTargetCents: 10, exitTargetCents: 90,
    issuanceAskPrice: 0.1, issuanceBidPrice: 0.09, entryGeneration: 1,
    calculationAt: new Date(nowMs).toISOString(), ...patch,
  });

  it('builds the sentinel from the prospectively stamped paper decision', () => {
    expect(holdSentinelFromStampedPaperOrder(stampedOrder())).toMatchObject({
      id: 'BTC:UP:2026-08-15T00:15:00Z:1', sentinelVersion: HOLD_SENTINEL_VERSION,
      policyVersion: 'long-shot-round-trip-buy10-sell90-win600-v1', executed: true,
      entryAskCents: 10, oppositeAskCents: 91, entryMarkCents: 10, exitMarkCents: 90,
      quantity: 1.8, stakeCents: 20, estimatedFeeCents: 2, entryGeneration: 1,
    });
  });

  it('refuses historical and live orders rather than backfilling a selected cohort', () => {
    expect(holdSentinelFromStampedPaperOrder(stampedOrder({ holdSentinelVersion: undefined }))).toBeNull();
    expect(holdSentinelFromStampedPaperOrder(stampedOrder({ executionMode: 'live' }))).toBeNull();
  });

  it('records an operationally blocked decision with its exact reason', () => {
    const result = holdSentinelFromStampedPaperOrder(stampedOrder({ entryGeneration: 2 }), {
      executed: false, skipReason: 'Paper headroom is below the all-in ticket.',
    });
    expect(result).toMatchObject({ entryGeneration: 2, executed: false, skipReason: 'Paper headroom is below the all-in ticket.' });
  });

  it('reconciles only stamped decisions and never creates triggers from the slower dashboard', async () => {
    const cycle = await collectLongShotEvidence({
      dashboard: dashboard(prediction('ETH', 0.1, 0.91)),
      orders: [order(), stampedOrder()], existingSentinels: [], nowMs,
    });
    expect(cycle.sentinels).toHaveLength(1);
    expect(cycle.sentinels[0].symbol).toBe('BTC');
  });
});

describe('long-shot allocation and sizing', () => {
  it('falls back to the designed launch allocation while none is configured', () => {
    expect(LONG_SHOT_DEFAULT_ALLOCATION_PERCENT).toBe(30);
    expect(longShotAllocationCents(2_000)).toBe(600);
    expect(longShotAllocationCents(2_000, 900)).toBe(900);
    expect(longShotAllocationCents(0)).toBe(0);
  });

  it('rolls equity forward on this strategy\'s own realized P&L only', () => {
    const orders = [
      order({ id: 'ls-won', status: 'sold', actualPnlCents: 140 }),
      order({ id: 'edge-lost', strategyId: 'edge-binary-buy', status: 'lost', actualPnlCents: -500 }),
    ];
    // The edge policy's 500c loss must not shrink this strategy's ticket.
    expect(longShotSizingFor(orders, 600, settings).ticketCents).toBe(Math.floor(740 / 30));
  });

  it('halts on its own drawdown', () => {
    const orders = [order({ id: 'ls-lost', status: 'lost', actualPnlCents: -301 })];
    expect(longShotSizingFor(orders, 600, settings).halted).toBe(true);
  });
});

/**
 * The peak recorder, which did not exist between 2026-08-15 and 2026-08-17.
 *
 * Its absence made `reachedExitMark` false for every sentinel, collapsing the round-trip arm onto the hold
 * arm and reporting an advantage of exactly zero that nothing had measured. Every unit test of the report
 * passed throughout, because each supplied `peakOwnedSideBidCents` in its fixture. These tests exercise the
 * wiring instead of the arithmetic. See docs/long-shot-policy-design.md §10a.
 */
describe('sentinel peak bid observation', () => {
  const sentinel = (patch: Partial<HoldSentinel> = {}): HoldSentinel => ({
    id: 'BTC:UP:2026-08-15T00:15:00Z:1',
    sentinelVersion: HOLD_SENTINEL_VERSION,
    policyVersion: 'long-shot-round-trip-buy10-sell90-win600-v1',
    observedAt: '2026-08-15T00:01:00Z',
    symbol: 'BTC', side: 'UP', closesAt, contractId: 'KXBTC15M-TEST',
    entryAskCents: 10, oppositeAskCents: 91, secondsRemaining: 840,
    entryMarkCents: 10, exitMarkCents: 90,
    quantity: 1.8, stakeCents: 20, estimatedFeeCents: 2,
    entryGeneration: 1, executed: false,
    ...patch,
  });

  const later = '2026-08-15T00:02:00Z';

  it('derives the owned side bid from the opposite ask on the shared book', () => {
    // bid(UP) = 100 - ask(DOWN); the owned side's own ask is never read.
    const peaks = sentinelPeakBids(dashboard(prediction('BTC', 0.30, 0.72)), [sentinel()], later);
    expect(peaks['BTC:UP:2026-08-15T00:15:00Z:1']).toBeCloseTo(28, 9);
  });

  it('derives the DOWN side bid from the UP ask', () => {
    const peaks = sentinelPeakBids(dashboard(prediction('BTC', 0.72, 0.30)), [sentinel({ side: 'DOWN' })], later);
    expect(peaks['BTC:UP:2026-08-15T00:15:00Z:1']).toBeCloseTo(28, 9);
  });

  it('never observes a sentinel on the cycle that created it', () => {
    // Otherwise the quote that triggered the entry also becomes the peak it is judged against.
    const peaks = sentinelPeakBids(dashboard(prediction('BTC', 0.30, 0.72)), [sentinel()], sentinel().observedAt);
    expect(peaks).toEqual({});
  });

  it('stops observing once the sentinel has settled', () => {
    const peaks = sentinelPeakBids(
      dashboard(prediction('BTC', 0.30, 0.72)),
      [sentinel({ resolvedAt: '2026-08-15T00:15:05Z', settledSide: 'DOWN' })],
      later,
    );
    expect(peaks).toEqual({});
  });

  it('fails closed on a missing, dead, or nonsensical quote rather than recording a touch', () => {
    expect(sentinelPeakBids(dashboard(), [sentinel()], later)).toEqual({});
    const dead = prediction('BTC', 0.30, 0.72);
    (dead.kalshi as { live: boolean }).live = false;
    expect(sentinelPeakBids(dashboard(dead), [sentinel()], later)).toEqual({});
    // ask(DOWN) = 0 would imply a 100c bid, which is not a price this book can show.
    expect(sentinelPeakBids(dashboard(prediction('BTC', 0.99, 0)), [sentinel()], later)).toEqual({});
  });

  it('matches on the exact contract, so a price is never scored against another window', () => {
    const peaks = sentinelPeakBids(dashboard(prediction('BTC', 0.30, 0.72)), [sentinel({ contractId: 'KXBTC15M-OTHER' })], later);
    expect(peaks).toEqual({});
  });
});

describe('longShotTrackStartingCents', () => {
  it('sizes paper from the paper bankroll and live from the funded market allocation', () => {
    const input = { marketCapCents: 2_000, paperBankrollCents: 10_000, configuredStartingCents: 600 };
    // 30% of each pot; live prefers the explicitly funded amount.
    expect(longShotTrackStartingCents({ ...input, mode: 'paper' })).toBe(3_000);
    expect(longShotTrackStartingCents({ ...input, mode: 'live' })).toBe(600);
  });

  it('ignores the live funded allocation for paper, so a paper stake never reads as a live commitment', () => {
    expect(longShotTrackStartingCents({
      mode: 'paper', marketCapCents: 2_000, paperBankrollCents: 10_000, configuredStartingCents: 1,
    })).toBe(3_000);
  });

  it('falls back to the percentage when live has no funded allocation', () => {
    expect(longShotTrackStartingCents({ mode: 'live', marketCapCents: 2_000, paperBankrollCents: 10_000 })).toBe(600);
  });

  it('never returns a negative or non-finite basis', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(longShotTrackStartingCents({ mode: 'paper', marketCapCents: 2_000, paperBankrollCents: bad })).toBeGreaterThanOrEqual(0);
      expect(longShotTrackStartingCents({ mode: 'live', marketCapCents: bad, paperBankrollCents: 10_000 })).toBeGreaterThanOrEqual(0);
    }
  });

  it('un-halts the paper track that a live-sized basis would have stopped', () => {
    const settings = longShotSettings({
      ...process.env, MONEY_NOODLE_LONG_SHOT_ENABLED: 'true', MONEY_NOODLE_LONG_SHOT_DRAWDOWN_DIVISOR: '50',
    });
    const liveBasis = longShotTrackStartingCents({ mode: 'live', marketCapCents: 2_000, paperBankrollCents: 10_000, configuredStartingCents: 600 });
    const paperBasis = longShotTrackStartingCents({ mode: 'paper', marketCapCents: 2_000, paperBankrollCents: 10_000 });
    // The measured paper drawdown that halted the policy: 600c funded, -308c realized.
    expect(longShotSizing(liveBasis - 308, settings).halted).toBe(true);
    expect(longShotSizing(paperBasis - 308, settings).halted).toBe(false);
  });
});
