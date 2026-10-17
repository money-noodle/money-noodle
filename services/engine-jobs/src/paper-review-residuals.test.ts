import { describe, it, expect } from 'vitest';
import { immediateBuyFill, immediateSellFill } from './domain/paper-ioc.js';
import { selectPortfolio } from './domain/paper-portfolio.js';
import { advanceSignalPersistence } from './domain/paper-persistence.js';
import { adaptiveEntryEpisodeDecision, type PaperAttempt } from './domain/paper-episodes.js';
const close = '2026-10-11T12:15:00Z',
  alias = '2026-10-11T12:15:00.000Z';
const caps = {
  maximumPositions: 2,
  maximumSameWindow: 1,
  maximumSameGroupPerWindow: 1,
  correlationPenaltyCents: 1,
  sameGroupPenaltyCents: 1,
};
const maker: PaperAttempt = {
  id: 'maker',
  createdAt: '2026-10-11T12:02:00Z',
  makerCompletedAt: '2026-10-11T12:02:12Z',
  filledCount: 0,
  status: 'unfilled',
  executionPolicyVersion: 'synthetic',
  liquidityRole: 'maker',
  entryExecutionDecision: { executedStyle: 'maker' },
  noFillReason: 'rested_no_fill',
};
const ioc: PaperAttempt = {
  ...maker,
  id: 'ioc',
  createdAt: '2026-10-11T12:02:13Z',
  makerCompletedAt: '2026-10-11T12:02:14Z',
  liquidityRole: 'taker',
  entryExecutionDecision: { executedStyle: 'taker' },
  noFillReason: 'ioc_no_fill',
};
describe('independent residual literals R1 through R4', () => {
  it('R1 canonical .29 full request and partial depth buy/sell; no tiny roundup; worst-level cash', () => {
    for (const fn of [immediateBuyFill, immediateSellFill])
      for (const [quantity, request] of [
        [1, 0.29],
        [0.29, 1],
      ] as const) {
        const fill = fn(
          {
            observedAt: close,
            yesBids: [{ price: 0.5, quantity }],
            noBids: [{ price: 0.5, quantity }],
          },
          'UP',
          0.5,
          request!,
        );
        expect(fill.filledCount).toBe(0.29);
        expect(fill.cashCents).toBeCloseTo(14.5, 10);
        expect(fill.filledCount).toBeLessThanOrEqual(quantity!);
      }
    expect(
      immediateBuyFill(
        { observedAt: close, yesBids: [], noBids: [{ price: 0.5, quantity: 0.0099999999 }] },
        'UP',
        0.5,
        0.01,
      ).filledCount,
    ).toBe(0);
    const buy = immediateBuyFill(
      {
        observedAt: close,
        yesBids: [],
        noBids: [
          { price: 0.6, quantity: 0.1 },
          { price: 0.5, quantity: 0.19 },
        ],
      },
      'UP',
      0.5,
      0.29,
    );
    expect(buy.filledCount).toBe(0.29);
    expect(buy.cashCents).toBeCloseTo(13.5, 10);
    const sell = immediateSellFill(
      {
        observedAt: close,
        yesBids: [
          { price: 0.6, quantity: 0.1 },
          { price: 0.5, quantity: 0.19 },
        ],
        noBids: [],
      },
      'UP',
      0.5,
      0.29,
    );
    expect(sell.filledCount).toBe(0.29);
    expect(sell.cashCents).toBeCloseTo(15.5, 10);
  });
  it('R2 aliases preserve same asset/window/group constraints and penalties plus signal history', () => {
    const existing = [{ symbol: 'BTC', closesAt: close }];
    const candidate = { id: 'candidate', symbol: 'BTC', closesAt: alias, expectedProfitCents: 10 };
    expect(selectPortfolio([candidate], existing, caps)[0]?.selected).toBe(false);
    expect(selectPortfolio([{ ...candidate, symbol: 'SOL' }], existing, caps)[0]?.selected).toBe(
      false,
    );
    expect(
      selectPortfolio([{ ...candidate, symbol: 'ETH' }], existing, {
        ...caps,
        maximumSameWindow: 2,
      })[0]?.selected,
    ).toBe(false);
    expect(
      selectPortfolio([{ ...candidate, symbol: 'SOL' }], existing, {
        ...caps,
        maximumSameWindow: 2,
      })[0]?.adjustedExpectedContributionCents,
    ).toBe(9);
    const input = {
      symbol: 'BTC',
      side: 'UP' as const,
      closesAt: close,
      calculationAt: '2026-10-11T12:01:45Z',
      qualifies: true,
      netEdge: 0.08,
      quality: 0.75,
    };
    const state = advanceSignalPersistence(undefined, input);
    expect(
      advanceSignalPersistence(state, {
        ...input,
        closesAt: alias,
        calculationAt: '2026-10-11T12:02:00Z',
      }).observations,
    ).toHaveLength(2);
  });
  it('R3 rejects oversize existing before touching any element', () => {
    const existing = Array(2001);
    Object.defineProperty(existing, 0, {
      get() {
        throw new Error('element traversed');
      },
    });
    expect(() => selectPortfolio([], existing, caps)).toThrow('Invalid paper portfolio inputs.');
  });
  it('R4 whole sequence rejects malformed first contradictory role earlier terminal and overlap', () => {
    expect(adaptiveEntryEpisodeDecision([maker, ioc], 'synthetic', 3).allowed).toBe(true);
    for (const first of [
      { ...maker, liquidityRole: 'taker' as const },
      { ...maker, noFillReason: 'pre_submit_quote_moved' },
      { ...maker, fallbackSequenceEndedAt: maker.makerCompletedAt! },
    ])
      expect(adaptiveEntryEpisodeDecision([first, ioc], 'synthetic', 3).allowed).toBe(false);
    expect(
      adaptiveEntryEpisodeDecision([maker, { ...ioc, liquidityRole: 'maker' }], 'synthetic', 3)
        .allowed,
    ).toBe(false);
    expect(
      adaptiveEntryEpisodeDecision(
        [maker, { ...ioc, createdAt: '2026-10-11T12:02:11Z' }],
        'synthetic',
        3,
      ).allowed,
    ).toBe(false);
  });
});
