import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { estimatePaperFill, venueFeeCents } from './paper-execution';
import {
  evaluateLongShotEntry, longShotDailyLossCapCents, longShotPolicyVersion, longShotRoundTrip,
  longShotSettings, longShotSizing,
  type LongShotEntryInput, type LongShotSettings,
} from './long-shot-policy';

const settings = (overrides: Partial<LongShotSettings> = {}): LongShotSettings => ({
  enabled: true, entryMarkCents: 10, exitMarkCents: 90, minimumSecondsRemaining: 720,
  drawdownDivisor: 30, minimumTicketCents: 10, maximumOpenPerSettlementWindow: 3,
  maximumEntriesPerAssetWindow: 3, dailyLossTickets: 10, excludedAssets: [], ...overrides,
});

const candidate = (overrides: Partial<LongShotEntryInput> = {}): LongShotEntryInput => ({
  symbol: 'BTC', side: 'UP', askPrice: 0.10, secondsRemaining: 800,
  openSameAssetWindow: 0, openSameSettlementWindow: 0, entriesThisAssetWindow: 0,
  dailyNetLossCents: 0, ...overrides,
});

const kalshiFee = (limitPriceCents: number, quantity: number) => venueFeeCents('kalshi', limitPriceCents, quantity);

describe('long-shot settings', () => {
  it('defaults to disabled, so deploying the code cannot start trading', () => {
    expect(longShotSettings({ NODE_ENV: 'test' }).enabled).toBe(false);
  });

  it('keeps the exit mark strictly above the entry mark however it is configured', () => {
    // An exit at or below cost would guarantee a loss on every "win", so the bound is enforced rather
    // than trusted to the operator.
    const parsed = longShotSettings({
      NODE_ENV: 'test', MONEY_NOODLE_LONG_SHOT_ENABLED: 'true',
      MONEY_NOODLE_LONG_SHOT_ENTRY_MARK_CENTS: '40', MONEY_NOODLE_LONG_SHOT_EXIT_MARK_CENTS: '20',
    });
    expect(parsed.entryMarkCents).toBe(40);
    expect(parsed.exitMarkCents).toBe(41);
  });

  it('opens the entry window for the first five minutes by default', () => {
    // Widened from three on measurement: flow rose 5.5x at the 10c mark while the rate of reaching 90c
    // stayed flat from three minutes onward, so the wider window buys candidates without buying worse ones.
    expect(longShotSettings({ NODE_ENV: 'test' }).minimumSecondsRemaining).toBe(600);
  });

  it('bounds every numeric setting against nonsense input', () => {
    const parsed = longShotSettings({
      NODE_ENV: 'test',
      MONEY_NOODLE_LONG_SHOT_ENTRY_MARK_CENTS: '0', MONEY_NOODLE_LONG_SHOT_MIN_SECONDS_REMAINING: '99999',
      MONEY_NOODLE_LONG_SHOT_DRAWDOWN_DIVISOR: '-4', MONEY_NOODLE_LONG_SHOT_MAX_OPEN_PER_WINDOW: 'abc',
    });
    expect(parsed.entryMarkCents).toBe(1);
    expect(parsed.minimumSecondsRemaining).toBe(899);
    expect(parsed.drawdownDivisor).toBe(5);
    expect(parsed.maximumOpenPerSettlementWindow).toBe(3);
  });
});

describe('long-shot sizing and the derived halt', () => {
  it('sizes the ticket as equity divided by the drought it must survive', () => {
    expect(longShotSizing(600, settings())).toMatchObject({ ticketCents: 20, halted: false });
    expect(longShotSizing(1200, settings())).toMatchObject({ ticketCents: 40, halted: false });
  });

  it('halts exactly where a viable ticket can no longer be funded with full runway', () => {
    // The stop is the consequence of the ticket rule and the fee floor, not a separately chosen percentage.
    expect(longShotSizing(300, settings())).toMatchObject({ ticketCents: 10, halted: false, haltThresholdCents: 300 });
    expect(longShotSizing(299, settings()).halted).toBe(true);
    expect(longShotSizing(0, settings()).halted).toBe(true);
    expect(longShotSizing(Number.NaN, settings()).halted).toBe(true);
  });

  it('scales the daily circuit breaker with the ticket rather than fixing it in cents', () => {
    expect(longShotDailyLossCapCents(20, settings())).toBe(200);
    expect(longShotDailyLossCapCents(40, settings())).toBe(400);
  });
});

describe('long-shot entry rule', () => {
  const sizing = longShotSizing(600, settings());

  it('qualifies a side at or below the mark with enough clock left', () => {
    expect(evaluateLongShotEntry(candidate(), sizing, settings())).toEqual({ qualifies: true, limitPriceCents: 10 });
    expect(evaluateLongShotEntry(candidate({ askPrice: 0.05 }), sizing, settings()).qualifies).toBe(true);
    expect(evaluateLongShotEntry(candidate({ side: 'DOWN' }), sizing, settings()).qualifies).toBe(true);
  });

  it('refuses an ask above the mark, and fails closed on a missing quote', () => {
    expect(evaluateLongShotEntry(candidate({ askPrice: 0.11 }), sizing, settings()).qualifies).toBe(false);
    expect(evaluateLongShotEntry(candidate({ askPrice: 0 }), sizing, settings()).qualifies).toBe(false);
    expect(evaluateLongShotEntry(candidate({ askPrice: Number.NaN }), sizing, settings()).qualifies).toBe(false);
  });

  it('gates on time remaining, so the rule governs re-entries as well as first entries', () => {
    // Expressed as remaining rather than elapsed: a comeback needs clock left, and a third re-entry at
    // minute 14 must be refused even though "first three minutes" would have nothing to say about it.
    expect(evaluateLongShotEntry(candidate({ secondsRemaining: 720 }), sizing, settings()).qualifies).toBe(true);
    expect(evaluateLongShotEntry(candidate({ secondsRemaining: 719 }), sizing, settings()).qualifies).toBe(false);
    expect(evaluateLongShotEntry(candidate({ secondsRemaining: 60 }), sizing, settings()).qualifies).toBe(false);
  });

  it('forbids a second concurrent position on one asset and window', () => {
    // Averaging down is the only shape that compounds a single window's loss, and it is the reason
    // re-entry is safe: the sole exit is the profit target, so the policy is only ever flat after a win.
    const decision = evaluateLongShotEntry(candidate({ openSameAssetWindow: 1 }), sizing, settings());
    expect(decision.qualifies).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining('already open on BTC') });
  });

  it('allows re-entry up to the churn cap once the previous round trip has closed', () => {
    expect(evaluateLongShotEntry(candidate({ entriesThisAssetWindow: 2 }), sizing, settings()).qualifies).toBe(true);
    expect(evaluateLongShotEntry(candidate({ entriesThisAssetWindow: 3 }), sizing, settings()).qualifies).toBe(false);
  });

  it('caps concurrent positions per settlement window without any correlation-group rationing', () => {
    // Arrivals cluster; outcomes measured near independent. This bounds how much equity one 15-minute
    // event can consume, and deliberately does not reuse the edge policy's beta tiers, which would
    // ration alt-beta -- the high-fluctuation assets this policy most wants.
    expect(evaluateLongShotEntry(candidate({ openSameSettlementWindow: 2 }), sizing, settings()).qualifies).toBe(true);
    expect(evaluateLongShotEntry(candidate({ openSameSettlementWindow: 3 }), sizing, settings()).qualifies).toBe(false);
    for (const symbol of ['BTC', 'ETH', 'DOGE', 'XRP']) {
      expect(evaluateLongShotEntry(candidate({ symbol, openSameSettlementWindow: 2 }), sizing, settings()).qualifies).toBe(true);
    }
  });

  it('stops on the daily loss circuit breaker and on the derived halt', () => {
    expect(evaluateLongShotEntry(candidate({ dailyNetLossCents: 199 }), sizing, settings()).qualifies).toBe(true);
    expect(evaluateLongShotEntry(candidate({ dailyNetLossCents: 200 }), sizing, settings()).qualifies).toBe(false);
    expect(evaluateLongShotEntry(candidate(), longShotSizing(299, settings()), settings()).qualifies).toBe(false);
  });

  it('is off by default and honours a policy-specific exclusion list', () => {
    expect(evaluateLongShotEntry(candidate(), sizing, settings({ enabled: false })).qualifies).toBe(false);
    // XRP is excluded from the edge policy on directional evidence; that does not bind here.
    expect(evaluateLongShotEntry(candidate({ symbol: 'XRP' }), sizing, settings()).qualifies).toBe(true);
    expect(evaluateLongShotEntry(candidate({ symbol: 'XRP' }), sizing, settings({ excludedAssets: ['XRP'] })).qualifies).toBe(false);
  });
});

describe('long-shot round-trip economics', () => {
  it('breaks even at 12.5% on the launch marks, against the production fee and sizing code', () => {
    const fill = estimatePaperFill(20, 0.10, 'kalshi');
    expect(fill).toMatchObject({ quantity: 1.80, stakeCents: 20, potentialPayoutCents: 180 });

    const trip = longShotRoundTrip(fill!, 90, kalshiFee);
    expect(trip.exitFeeCents).toBe(2);
    expect(trip.exitProceedsCents).toBeCloseTo(160, 6);
    expect(trip.netOnWinCents).toBeCloseTo(140, 6);
    expect(trip.breakEvenTouchRate).toBeCloseTo(0.125, 6);
    expect(trip.breakEvenHoldRate).toBeCloseTo(0.1111, 4);
  });

  it('selling early costs only ~1.13x the hold rate, which every winner clears by construction', () => {
    const trip = longShotRoundTrip(estimatePaperFill(20, 0.10, 'kalshi')!, 90, kalshiFee);
    expect(trip.breakEvenTouchRate / trip.breakEvenHoldRate).toBeLessThan(1.2);
  });

  it('holds its edge down to the 10c ticket floor and loses it below', () => {
    // This is why the floor is 10c rather than the 2c the edge policy permits: the max(1, ceil(...)) fee
    // is a fixed cost, so it stops being negligible long before the ticket reaches zero.
    const at20 = longShotRoundTrip(estimatePaperFill(20, 0.10, 'kalshi')!, 90, kalshiFee);
    const at10 = longShotRoundTrip(estimatePaperFill(10, 0.10, 'kalshi')!, 90, kalshiFee);
    const at3 = longShotRoundTrip(estimatePaperFill(3, 0.10, 'kalshi')!, 90, kalshiFee);

    expect(at10.breakEvenTouchRate).toBeCloseTo(at20.breakEvenTouchRate, 6);
    expect(at10.breakEvenTouchRate).toBeCloseTo(0.125, 6);
    expect(at3.breakEvenTouchRate).toBeGreaterThan(0.17);
  });

  it('prices a deeper discount as a materially easier bar', () => {
    const deep = longShotRoundTrip(estimatePaperFill(20, 0.05, 'kalshi')!, 90, kalshiFee);
    expect(deep.breakEvenTouchRate).toBeLessThan(0.07);
  });
});

describe('mirror invariant: the long-shot rule layer takes no execution mode', () => {
  it('exposes no per-track parameter, so paper and live cannot diverge', () => {
    // Same blunt arity assertion the edge policy uses, for the same reason: a divergence must be
    // impossible to express rather than merely absent today.
    expect(evaluateLongShotEntry.length).toBe(3);
    expect(longShotSizing.length).toBe(2);
    expect(longShotRoundTrip.length).toBe(3);
  });

  it('reaches the same verdict on repeat evaluation across a grid of inputs', () => {
    const sizing = longShotSizing(600, settings());
    for (const askPrice of [0.02, 0.05, 0.10, 0.11, 0.4]) {
      for (const secondsRemaining of [899, 800, 720, 719, 100]) {
        for (const side of ['UP', 'DOWN'] as const) {
          const input = candidate({ askPrice, secondsRemaining, side });
          const first = evaluateLongShotEntry(input, sizing, settings());
          expect(evaluateLongShotEntry(input, sizing, settings())).toEqual(first);
        }
      }
    }
  });
});

describe('policy version derivation', () => {
  it('changes when a cohort-defining parameter changes', () => {
    // A hardcoded string was the first attempt and it was wrong: widening the entry window left the
    // version unchanged, so two rule sets would have blended silently.
    const base = longShotPolicyVersion({ entryMarkCents: 10, exitMarkCents: 90, minimumSecondsRemaining: 600 });
    expect(base).toBe('long-shot-round-trip-buy10-sell90-win600-v1');
    expect(longShotPolicyVersion({ entryMarkCents: 10, exitMarkCents: 90, minimumSecondsRemaining: 720 })).not.toBe(base);
    expect(longShotPolicyVersion({ entryMarkCents: 15, exitMarkCents: 90, minimumSecondsRemaining: 600 })).not.toBe(base);
    expect(longShotPolicyVersion({ entryMarkCents: 10, exitMarkCents: 85, minimumSecondsRemaining: 600 })).not.toBe(base);
  });

  it('tracks the live settings, so an env change cannot leave it stale', () => {
    expect(longShotPolicyVersion(longShotSettings({ NODE_ENV: 'test' })))
      .toBe('long-shot-round-trip-buy10-sell90-win600-v1');
    expect(longShotPolicyVersion(longShotSettings({
      NODE_ENV: 'test', MONEY_NOODLE_LONG_SHOT_ENTRY_MARK_CENTS: '25',
    } as unknown as NodeJS.ProcessEnv))).toContain('buy25-');
  });
});
