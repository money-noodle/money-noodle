import { describe, expect, it } from 'vitest';
import {
  TRAILING_ENTRY_POLL_MS, TRAILING_FAST_LOOK_BUDGET, TRAILING_SIGNIFICANCE_CENTS, beginTrailingEntry,
  evaluateTrailingEntry, observeTrailingEntry, trailingGainCents, trailingIsFast,
} from './trailing-entry';

const start = 1_000_000;
const options = { entryMarkCents: 10 };
const look = (state: ReturnType<typeof beginTrailingEntry>, ask: number, offset: number) =>
  observeTrailingEntry(state, ask, start + offset);

describe('trailing entry', () => {
  it('waits while the price is still falling meaningfully', () => {
    const state = beginTrailingEntry(10, start);
    expect(evaluateTrailingEntry(state, 9.5, options)).toMatchObject({ action: 'wait' });
    expect(evaluateTrailingEntry(state, 8, options)).toMatchObject({ action: 'wait' });
  });

  it('buys the moment the fall stalls', () => {
    // A stall is the first evidence of a reversal, which is what this strategy needs. A price that keeps
    // falling is trending, and never buying one is the intended outcome rather than a miss.
    const state = look(beginTrailingEntry(10, start), 8, 250);
    expect(evaluateTrailingEntry(state, 8, options)).toMatchObject({ action: 'buy', askCents: 8 });
    expect(evaluateTrailingEntry(state, 8.05, options)).toMatchObject({ action: 'buy' });
  });

  it('treats one deci-cent as the unit of significance', () => {
    // Below 10c Kalshi prices in deci-cents (tapered_deci_cent), so a tenth is a real tick rather than noise.
    expect(TRAILING_SIGNIFICANCE_CENTS).toBe(0.1);
    const state = beginTrailingEntry(10, start);
    expect(evaluateTrailingEntry(state, 9.9, options)).toMatchObject({ action: 'wait' });
    expect(evaluateTrailingEntry(state, 9.95, options)).toMatchObject({ action: 'buy' });
  });

  it('compares against the best seen, so jitter cannot extend the wait forever', () => {
    // Against the previous look, a price oscillating down-and-up would restart the wait each time. One
    // improvement buys one more look, not a fresh lease.
    let state = beginTrailingEntry(10, start);
    state = look(state, 8, 250);
    state = look(state, 9, 500);
    expect(state.bestAskCents).toBe(8);
    expect(evaluateTrailingEntry(state, 9, options)).toMatchObject({ action: 'buy', askCents: 9 });
  });

  it('buys at what is offered now, not at the best that has gone', () => {
    // Holding out for a price the book no longer shows is how a stall turns into a miss.
    let state = beginTrailingEntry(10, start);
    state = look(state, 7, 250);
    const decision = evaluateTrailingEntry(state, 9, options);
    expect(decision).toMatchObject({ action: 'buy', askCents: 9 });
  });

  it('abandons rather than paying above the mark', () => {
    // Buying above the mark because we were already watching is the rule quietly widening itself. Measured
    // at 2% of first touches, so the cost of abandoning is small.
    const state = look(beginTrailingEntry(10, start), 9, 250);
    expect(evaluateTrailingEntry(state, 10.5, options)).toMatchObject({ action: 'abandon' });
  });

  it('never buys on a vanished quote', () => {
    const state = beginTrailingEntry(10, start);
    for (const ask of [0, -1, Number.NaN]) {
      expect(evaluateTrailingEntry(state, ask, options)).toMatchObject({ action: 'wait' });
    }
  });

  it('never buys on a deadline, however long the fall runs', () => {
    // Ten minutes of continuous falling still does not buy. The entry window closes the candidate; a timer
    // that purchased would take exactly the trending contracts the stall rule exists to avoid. The fast
    // watch is bounded separately, which costs requests rather than changing the decision.
    let state = beginTrailingEntry(10, start);
    let ask = 10;
    for (let tick = 1; tick <= 2_400; tick += 1) {
      ask -= 0.2;
      if (ask <= 0.2) break;
      expect(evaluateTrailingEntry(state, ask, options)).toMatchObject({ action: 'wait' });
      state = look(state, ask, tick * TRAILING_ENTRY_POLL_MS);
    }
    expect(state.looks).toBeGreaterThan(40);
  });

  it('records what trailing earned, so the rule is judged on evidence', () => {
    let state = beginTrailingEntry(10, start);
    state = look(state, 7.9, 250);
    expect(state.firstTouchAskCents).toBe(10);
    expect(trailingGainCents(state, 7.9)).toBe(2.1);
    // A worse fill than first touch is recorded as negative rather than clamped away.
    expect(trailingGainCents(state, 10.5)).toBe(-0.5);
  });

  it('polls fast enough to see a deci-cent move, at a cadence the venue can answer', () => {
    expect(TRAILING_ENTRY_POLL_MS).toBe(250);
  });

  it('spends a bounded fast-look budget, then keeps trailing at the slow cadence', () => {
    // Cost and the trading rule are separate concerns. Watching four times a second for one contract is
    // four requests a second, and several can qualify at once, so the fast watch is bounded — but the
    // decision is not: after the budget it still waits, and still buys when the fall stalls.
    let state = beginTrailingEntry(10, start);
    expect(trailingIsFast(state)).toBe(true);
    for (let tick = 1; tick <= TRAILING_FAST_LOOK_BUDGET; tick += 1) {
      state = look(state, 10 - tick * 0.15, tick * TRAILING_ENTRY_POLL_MS);
    }
    expect(trailingIsFast(state)).toBe(false);
    // Still trailing, and still refusing a falling price.
    expect(evaluateTrailingEntry(state, state.bestAskCents - 0.5, options)).toMatchObject({ action: 'wait' });
    // And still buying on a stall, just noticed a second later rather than a quarter of one.
    expect(evaluateTrailingEntry(state, state.bestAskCents, options)).toMatchObject({ action: 'buy' });
  });

  it('bounds the fast watch to ten seconds', () => {
    // Ample for a stall to appear: 54% of first touches improved within two fifteen-second samples.
    expect(TRAILING_FAST_LOOK_BUDGET * TRAILING_ENTRY_POLL_MS).toBe(10_000);
  });
});
