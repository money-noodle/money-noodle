import { describe, expect, it } from 'vitest';
import {
  advanceSignalPersistence,
  evaluateSignalPersistenceWithRequirements,
  signalPersistenceAfter,
  type SignalPersistenceState,
} from './domain/paper-persistence.js';
import { selectPortfolio } from './domain/paper-portfolio.js';
import {
  evaluateEntryExecutionPolicy,
  adaptiveContinuationRefusal,
} from './domain/paper-entry-route.js';
import { adaptiveEntryEpisodeDecision, type PaperAttempt } from './domain/paper-episodes.js';
import { immediateBuyFill, immediateSellFill } from './domain/paper-ioc.js';
import { evaluateExitPolicy } from './domain/paper-exit.js';
import { paperMarketFunding } from './domain/paper-funding.js';
import { estimatePaperFill } from './domain/paper-money.js';
const close = '2026-10-11T12:15:00Z';
const now = Date.parse('2026-10-11T12:02:00Z');
const requirements = {
  requiredSnapshots: 2,
  requiredSpanMs: 15000,
  maximumEdgeSpike: 0.02,
  spikeGateEnabled: false,
};
const state = (): SignalPersistenceState => ({
  symbol: 'BTC',
  side: 'UP',
  closesAt: close,
  observations: [
    { at: '2026-10-11T12:01:45Z', netEdge: 0.08, quality: 0.75 },
    { at: '2026-10-11T12:02:00Z', netEdge: 0.1, quality: 0.75 },
  ],
});
const route = {
  mode: 'adaptive' as const,
  currentNetEdge: 0.01,
  medianNetEdge: 0.01,
  confidence: 0.7,
  spread: 0.02,
  makerNetEdge: 0.02,
  minimumMedianNetEdge: 0.05,
  minimumConfidence: 0.6,
  maximumSpread: 0.1,
};
const maker: PaperAttempt = {
  id: 'maker',
  createdAt: '2026-10-11T12:02:00Z',
  status: 'unfilled',
  executionPolicyVersion: 'paper-synthetic-v7',
  makerCompletedAt: '2026-10-11T12:02:12Z',
  liquidityRole: 'maker',
  noFillReason: 'rested_no_fill',
  entryExecutionDecision: { executedStyle: 'maker' },
};
describe('paper policy reducers with explicit current inputs (no materializer)', () => {
  it('uses two15s observations, exact median and resets a failed streak', () => {
    expect(
      evaluateSignalPersistenceWithRequirements(state(), now, 0.05, 0.6, requirements),
    ).toMatchObject({ eligible: true, qualifyingSnapshots: 2, medianNetEdge: 0.09 });
    const s = state();
    const input = {
      symbol: 'BTC',
      side: 'UP' as const,
      closesAt: close,
      calculationAt: '2026-10-11T12:02:00Z',
      qualifies: true,
      netEdge: 0.1,
      quality: 0.75,
    };
    expect(advanceSignalPersistence(s, input)).toBe(s);
    expect(advanceSignalPersistence(s, { ...input, qualifies: false }).observations).toEqual([]);
    expect(signalPersistenceAfter(s, '2026-10-11T12:01:45Z')?.observations).toHaveLength(1);
  });
  it('refuses absent, stale, future, short-span, warmup and late evidence', () => {
    expect(
      evaluateSignalPersistenceWithRequirements(undefined, now, 0.05, 0.6, requirements).eligible,
    ).toBe(false);
    expect(
      evaluateSignalPersistenceWithRequirements(state(), now + 31000, 0.05, 0.6, requirements)
        .eligible,
    ).toBe(false);
    expect(
      evaluateSignalPersistenceWithRequirements(state(), now - 1, 0.05, 0.6, requirements).eligible,
    ).toBe(false);
    expect(
      evaluateSignalPersistenceWithRequirements(state(), now, 0.05, 0.6, {
        ...requirements,
        requiredSpanMs: 30000,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateSignalPersistenceWithRequirements(
        state(),
        Date.parse('2026-10-11T12:14:30Z'),
        0.05,
        0.6,
        requirements,
      ).eligible,
    ).toBe(false);
    const s = state();
    s.observations[1]!.netEdge = 0.14;
    expect(
      evaluateSignalPersistenceWithRequirements(s, now, 0.05, 0.6, {
        ...requirements,
        spikeGateEnabled: true,
      }).eligible,
    ).toBe(false);
  });
  it('selects constrained dollar contribution rather than first arrivals', () => {
    const selected = selectPortfolio(
      [
        { id: 'btc', symbol: 'BTC', closesAt: close, expectedProfitCents: 10 },
        { id: 'eth', symbol: 'ETH', closesAt: close, expectedProfitCents: 9 },
        { id: 'sol', symbol: 'SOL', closesAt: close, expectedProfitCents: 8 },
      ],
      [],
      {
        maximumPositions: 2,
        maximumSameWindow: 2,
        maximumSameGroupPerWindow: 1,
        correlationPenaltyCents: 1,
        sameGroupPenaltyCents: 1,
      },
    );
    expect(selected.map((x) => x.selected)).toEqual([true, false, true]);
    expect(selected[2]?.adjustedExpectedContributionCents).toBe(7);
  });
  it('never substitutes live fill cohorts or grants high-edge first taker authority', () => {
    const first = evaluateEntryExecutionPolicy({ ...route, mode: 'taker', currentNetEdge: 0.5 });
    expect(first.executedStyle).toBe('maker');
    expect(first.makerFillRate).toBeNull();
    expect(first.makerSamples).toBe(0);
    const fallback = evaluateEntryExecutionPolicy({
      ...route,
      makerMissFallback: true,
      fallbackFromOrderId: 'maker',
    });
    expect(fallback.executedStyle).toBe('taker');
    expect(adaptiveContinuationRefusal(true, fallback)).toBeUndefined();
    expect(
      adaptiveContinuationRefusal(
        true,
        evaluateEntryExecutionPolicy({ ...route, makerMissFallback: true, currentNetEdge: 0 }),
      ),
    ).toBeDefined();
  });
  it('allows exactlymaker->IOC->IOC after definitive zero-fill, not partial/rejected/old generation', () => {
    expect(adaptiveEntryEpisodeDecision([], 'paper-synthetic-v7', 3).attemptNumber).toBe(1);
    expect(adaptiveEntryEpisodeDecision([maker], 'paper-synthetic-v7', 3)).toMatchObject({
      allowed: true,
      attemptNumber: 2,
      takerFallback: true,
    });
    const ioc: PaperAttempt = {
      ...maker,
      id: 'ioc',
      createdAt: '2026-10-11T12:02:15Z',
      noFillReason: 'ioc_no_fill',
      liquidityRole: 'taker',
      entryExecutionDecision: { executedStyle: 'taker' },
    };
    expect(adaptiveEntryEpisodeDecision([maker, ioc], 'paper-synthetic-v7', 3).attemptNumber).toBe(
      3,
    );
    for (const prior of [
      { ...maker, filledCount: 0.01 },
      { ...maker, status: 'rejected' },
      { ...maker, executionPolicyVersion: 'old' },
      { ...maker, fallbackSequenceEndedAt: close },
    ])
      expect(adaptiveEntryEpisodeDecision([prior], 'paper-synthetic-v7', 3).allowed).toBe(false);
    expect(
      adaptiveEntryEpisodeDecision([maker, ioc, { ...ioc, id: 'last' }], 'paper-synthetic-v7', 3)
        .allowed,
    ).toBe(false);
  });
  it('uses one IOC book sweep and drops sub-lattice cash from the worst level', () => {
    const book = {
      observedAt: close,
      yesBids: [{ price: 0.5, quantity: 1 }],
      noBids: [
        { price: 0.6, quantity: 1 },
        { price: 0.5, quantity: 1.255 },
      ],
    };
    // Buy1@40c then1.25@50c =>102.5c; remaining.005 removed from worstlevel.
    expect(immediateBuyFill(book, 'UP', 0.5, 3)).toMatchObject({
      filledCount: 2.25,
      cashCents: 102.5,
      levelsConsumed: 2,
    });
    expect(immediateSellFill(book, 'UP', 0.5, 3)).toMatchObject({ filledCount: 1, cashCents: 50 });
    expect(immediateBuyFill(undefined, 'UP', 0.5, 3).filledCount).toBe(0);
  });
  it('strict exit compares executable cash with optimistichold and explicit reversal switch', () => {
    const input = {
      observedAt: close,
      side: 'UP' as const,
      quantity: 2,
      exactCostCents: 50,
      executableBid: 0.5,
      exitFeeCents: 2,
      ownedSideProbability: 0.4,
      uncertainty: 0.05,
    };
    //98 executable versus90 optimistic =>8c advantage >=1c rule.
    expect(evaluateExitPolicy(input, false)).toMatchObject({
      action: 'SELL',
      policy: 'strict-value-v1',
      netLiquidationCents: 98,
      optimisticHoldValueCents: 90,
    });
    expect(evaluateExitPolicy({ ...input, ownedSideProbability: 0.6 }, false)?.action).toBe('HOLD');
    expect(evaluateExitPolicy({ ...input, quantity: 0 }, false)).toBeNull();
  });
  it('charges only pair reservations under explicit finite cap and never zero-as-unlimited', () => {
    expect(
      paperMarketFunding({
        providerLimitCents: 1000,
        allocationPercent: 40,
        modeEquityCents: 2000,
        availableCents: 500,
        pairReservedCents: 150,
      }),
    ).toEqual({ equityCents: 1000, capCents: 400, headroomCents: 250, spendableCents: 250 });
    expect(() =>
      paperMarketFunding({
        providerLimitCents: 0,
        allocationPercent: 100,
        modeEquityCents: 2000,
        availableCents: 2000,
        pairReservedCents: 0,
      }),
    ).toThrow();
  });
  it('affordable quantity is monotone across a fee/cent discontinuity, independently enumerated', () => {
    //50c ticks:3.98 costs199+7=206;3.99 costs200+7=207;4 costs200+7=207;
    //4.01 costs201+8=209;4.02 costs201+8=209;4.03 costs202+8=210.
    expect(
      [206, 207, 208, 209].map((cap) => estimatePaperFill(cap, 0.5, 'kalshi')?.quantity),
    ).toEqual([3.98, 4, 4, 4.02]);
    expect(estimatePaperFill(1, 0.5, 'kalshi')).toBeNull();
    expect(estimatePaperFill(Number.MAX_SAFE_INTEGER, 1e-20, 'kalshi')).toBeNull();
  });
});
