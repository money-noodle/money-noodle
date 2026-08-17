import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { correctedPaperPnlCents } from './paper-execution';
import type { PaperOrder } from './types';

/**
 * The reported paper P&L must not contradict the paper bankroll sitting beside it on the same screen.
 *
 * On 2026-08-17 the bankroll was credited 694c of taker fees wrongly charged on maker fills. The order
 * records still carry that fee — they are evidence and are never rewritten — so any figure summed from
 * them reads low by exactly the amount returned unless the correction is added back.
 *
 * `executionMode` is not decoration in these fixtures: the figure is scoped to the bankroll funding
 * that bought the order, and that attribution is mode-aware. An order without it is read as live.
 */
const order = (pnl: number, exact?: number): PaperOrder => ({
  executionMode: 'paper', pnlCents: pnl, ...(exact === undefined ? {} : { actualPnlCents: exact }),
} as PaperOrder);

const correction = (realizedPnlCents: number) => ({
  at: '2026-08-17T15:34:40.451Z', reason: 'test', orderIds: ['a'],
  availableCents: realizedPnlCents, realizedPnlCents,
});

describe('paper P&L reported against a corrected bankroll', () => {
  it('is the plain order sum when nothing has been corrected', () => {
    const orders = [order(-100), order(250), order(-30)];
    expect(correctedPaperPnlCents(orders, undefined)).toBe(120);
    expect(correctedPaperPnlCents(orders, { startingCents: 10_000, availableCents: 10_120, realizedPnlCents: 120 })).toBe(120);
  });

  it('adds back a maker-fee correction, because the orders still carry the fee', () => {
    const orders = [order(-694)];
    const budget = { startingCents: 10_000, availableCents: 9_916, realizedPnlCents: -84, makerFeeCorrections: [correction(694)] };
    expect(correctedPaperPnlCents(orders, budget)).toBe(0);
  });

  it('sums several corrections, so a later run does not overwrite an earlier one', () => {
    const budget = {
      startingCents: 10_000, availableCents: 10_000, realizedPnlCents: 0,
      makerFeeCorrections: [correction(694), correction(212), correction(5)],
    };
    expect(correctedPaperPnlCents([order(-1_000)], budget)).toBe(-89);
  });

  /**
   * The subtlety this whole split exists for. `strategyLeakCorrections` removed another strategy's
   * payouts from the bankroll; those orders never enter the edge-policy sum in the first place, so
   * applying it here would subtract them a second time.
   */
  it('ignores the strategy-leak correction, which the order sum already excludes', () => {
    const budget = {
      startingCents: 10_000, availableCents: 9_940, realizedPnlCents: -20,
      strategyLeakCorrections: [correction(-20)],
    };
    expect(correctedPaperPnlCents([order(-100)], budget)).toBe(-100);
  });

  it('applies only the maker-fee array when both are present', () => {
    const budget = {
      startingCents: 10_000, availableCents: 9_916, realizedPnlCents: -84,
      makerFeeCorrections: [correction(694)],
      strategyLeakCorrections: [correction(-20)],
    };
    expect(correctedPaperPnlCents([order(-694)], budget)).toBe(0);
  });

  it('uses the whole-cent budget view and ignores the exact one', () => {
    // The figure sits beside starting/available/equity, and the bankroll accumulates whole cents. Summing
    // the exact `actualPnlCents` here is what made the panel disagree with itself by ~100c over 205 sold
    // exits, because a sold exit prices `actualPnlCents` from a fractional net liquidation.
    expect(correctedPaperPnlCents([order(10, 10.5), order(-4)], undefined)).toBe(6);
    expect(correctedPaperPnlCents([order(25, 25.32)], undefined)).toBe(25);
  });

  it('stays an integer so it can be reconciled against the bankroll counter', () => {
    const orders = [order(6, 6.48), order(11, 11.94), order(-8, -7.8)];
    const total = correctedPaperPnlCents(orders, { startingCents: 0, availableCents: 0, realizedPnlCents: 0, makerFeeCorrections: [correction(694)] });
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(703);
  });

  it('treats a missing P&L as zero rather than dropping the order', () => {
    const withoutPnl = { executionMode: 'paper' } as PaperOrder;
    expect(correctedPaperPnlCents([withoutPnl, order(-50)], undefined)).toBe(-50);
  });

  it('counts only the funding currently backing the bankroll', () => {
    // A reset zeroes the counter, so an earlier funding's orders must stop reaching this figure or
    // the panel reports the whole pre-reset P&L as an unreconciled residual.
    const previous = { executionMode: 'paper', pnlCents: 900 } as PaperOrder;
    const current = { executionMode: 'paper', pnlCents: -25, paperBankrollId: 'paper-2-x' } as PaperOrder;
    const budget = { startingCents: 5_000, availableCents: 4_975, realizedPnlCents: -25, fundingId: 'paper-2-x', fundingSequence: 2, startedAt: '2026-08-18T00:00:00.000Z' };
    expect(correctedPaperPnlCents([previous, current], budget)).toBe(-25);
  });

  it('drops a correction made under an earlier bankroll, whose counter the reset already zeroed', () => {
    const current = { executionMode: 'paper', pnlCents: -25, paperBankrollId: 'paper-2-x' } as PaperOrder;
    const budget = {
      startingCents: 5_000, availableCents: 4_975, realizedPnlCents: -25,
      fundingId: 'paper-2-x', fundingSequence: 2, startedAt: '2026-08-18T00:00:00.000Z',
      makerFeeCorrections: [correction(694)],
    };
    expect(correctedPaperPnlCents([current], budget)).toBe(-25);
  });
});
