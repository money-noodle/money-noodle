import { describe, it, expect } from 'vitest';
import { adaptiveEntryEpisodeDecision, type PaperAttempt } from './domain/paper-episodes.js';
import { selectPortfolio } from './domain/paper-portfolio.js';
import {
  advanceSignalPersistence,
  evaluateSignalPersistenceWithRequirements,
  type SignalPersistenceState,
} from './domain/paper-persistence.js';
const close = '2026-10-11T12:15:00Z';
const created = '2026-10-11T12:02:00Z';
const maker: PaperAttempt = {
  id: 'maker',
  createdAt: created,
  status: 'unfilled',
  executionPolicyVersion: 'synthetic',
  filledCount: 0,
  makerCompletedAt: '2026-10-11T12:02:12Z',
  liquidityRole: 'maker',
  noFillReason: 'rested_no_fill',
  entryExecutionDecision: { executedStyle: 'maker' },
};
const constraints = {
  maximumPositions: 2,
  maximumSameWindow: 2,
  maximumSameGroupPerWindow: 1,
  correlationPenaltyCents: 1,
  sameGroupPenaltyCents: 0,
};
const input = {
  symbol: 'BTC',
  side: 'UP' as const,
  closesAt: close,
  calculationAt: created,
  qualifies: true,
  netEdge: 0.1,
  quality: 0.75,
};
const requirements = {
  requiredSnapshots: 2,
  requiredSpanMs: 15000,
  maximumEdgeSpike: 0.02,
  spikeGateEnabled: false,
};
describe('F4 F6 bounded dormant reducers', () => {
  it('F4 definitive zero only; bounded ids chronology and maker IOC IOC compatibility', () => {
    for (const filledCount of [NaN, -1, Infinity, 0.01])
      expect(
        adaptiveEntryEpisodeDecision([{ ...maker, filledCount }], 'synthetic', 3).allowed,
      ).toBe(false);
    const missingFill = { ...maker };
    delete missingFill.filledCount;
    expect(adaptiveEntryEpisodeDecision([missingFill], 'synthetic', 3).allowed).toBe(false);
    expect(
      adaptiveEntryEpisodeDecision(
        [{ ...maker, makerCompletedAt: '2026-10-11T12:01:59Z' }],
        'synthetic',
        3,
      ).allowed,
    ).toBe(false);
    expect(() => adaptiveEntryEpisodeDecision(Array(4).fill(maker), 'synthetic', 3)).toThrow();
    expect(() => adaptiveEntryEpisodeDecision([maker, maker], 'synthetic', 3)).toThrow();
    expect(adaptiveEntryEpisodeDecision([maker], 'synthetic', 3).allowed).toBe(true);
    const ioc = {
      ...maker,
      id: 'ioc',
      createdAt: '2026-10-11T12:02:13Z',
      makerCompletedAt: '2026-10-11T12:02:14Z',
      noFillReason: 'ioc_no_fill',
      liquidityRole: 'taker' as const,
      entryExecutionDecision: { executedStyle: 'taker' as const },
    };
    expect(adaptiveEntryEpisodeDecision([maker, ioc], 'synthetic', 3).attemptNumber).toBe(3);
    expect(adaptiveEntryEpisodeDecision([maker, ioc], 'synthetic', 3).allowed).toBe(true);
  });
  it('F6 portfolio small workcap finite penalties retains BTC SOL7', () => {
    const candidates = ['BTC', 'ETH', 'SOL'].map((symbol, i) => ({
      id: symbol,
      symbol,
      closesAt: close,
      expectedProfitCents: 10 - i,
    }));
    expect(
      selectPortfolio(candidates, [], constraints)
        .filter((c) => c.selected)
        .map((c) => [c.symbol, c.adjustedExpectedContributionCents]),
    ).toEqual([
      ['BTC', 10],
      ['SOL', 7],
    ]);
    expect(() =>
      selectPortfolio(candidates, [], { ...constraints, maximumPositions: 2000 }),
    ).toThrow();
    expect(() =>
      selectPortfolio(candidates, [], { ...constraints, correlationPenaltyCents: 1e308 }),
    ).toThrow();
    expect(() =>
      selectPortfolio(candidates, [{ symbol: 'BTC', closesAt: 'bad' }], constraints),
    ).toThrow();
  });
  it('F6 persistence validates before copy resets symbol and preserves median buckets reentry', () => {
    const state: SignalPersistenceState = advanceSignalPersistence(undefined, {
      ...input,
      calculationAt: '2026-10-11T12:01:45Z',
      netEdge: 0.08,
    });
    const next = advanceSignalPersistence(state, input);
    expect(
      evaluateSignalPersistenceWithRequirements(next, Date.parse(created), 0.05, 0.6, requirements),
    ).toMatchObject({ eligible: true, medianNetEdge: 0.09 });
    expect(advanceSignalPersistence(next, { ...input, symbol: 'ETH' }).observations).toHaveLength(
      1,
    );
    for (const bad of [
      { ...input, netEdge: 1e308 },
      { ...input, quality: 2 },
    ])
      expect(() => advanceSignalPersistence(next, bad)).toThrow();
    expect(() =>
      advanceSignalPersistence(
        { ...next, observations: Array(5).fill(next.observations[0]) },
        input,
      ),
    ).toThrow();
    expect(
      evaluateSignalPersistenceWithRequirements(
        { ...next, observations: [{ at: created, netEdge: 1e308, quality: 2 }] },
        Date.parse(created),
        0.05,
        0.6,
        requirements,
      ).eligible,
    ).toBe(false);
  });
});
