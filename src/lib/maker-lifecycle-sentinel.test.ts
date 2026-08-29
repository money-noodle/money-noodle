import { describe, expect, it } from 'vitest';
import {
  MAKER_LIFECYCLE_CANDIDATE_IDS, buildMakerLifecycleSentinelReport, makerLifecycleSentinelFromOrder,
  makerLifecycleTakerLimit,
} from './maker-lifecycle-sentinel';
import type { PaperOrder } from './types';

const AT = '2026-08-28T00:00:00.000Z';
const plus = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();

function order(observations: PaperOrder['entryExecutionObservations'], overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: 'live:BTC:UP:2026-08-28T00:15:00Z', executionMode: 'live', strategyId: 'edge-binary-buy',
    symbol: 'BTC', side: 'UP', contractId: 'KXBTC15M-TEST', closesAt: '2026-08-28T00:15:00Z',
    stakeCents: 30, quantity: 0, entrySizingDecision: { stakeLimitCents: 30 },
    entryExecutionObservations: observations, ...overrides,
  } as unknown as PaperOrder;
}

const series = (askAtCutover: number, filledAtCutover = 0, depth?: number) => ([
  { at: AT, event: 'accepted', limitPrice: 0.5, filledCount: 0, remainingCount: 0.6 },
  { at: plus(2.1), event: 'management_quote', selectedBid: askAtCutover - 0.01, selectedAsk: askAtCutover, filledCount: filledAtCutover, remainingCount: 0.6, ...(depth === undefined ? {} : { bestAskDepth: depth }) },
  { at: plus(13.7), event: 'terminal_fill', filledCount: filledAtCutover, remainingCount: 0.6, restingDurationMs: 13_700 },
] as unknown as PaperOrder['entryExecutionObservations']);

describe('maker lifecycle sentinel', () => {
  it('advances two ticks and refuses to cross above the production ceiling', () => {
    expect(makerLifecycleTakerLimit(0.5)).toBe(0.52);
    expect(makerLifecycleTakerLimit(0.74)).toBe(0.75);   // clamped, never rounded past the ceiling
    expect(makerLifecycleTakerLimit(0.76)).toBeNull();   // uncrossable at any speed
    expect(makerLifecycleTakerLimit(0)).toBeNull();
  });

  it('takes on the taker arm and never prices a purchase on the abandon arm', () => {
    const sentinel = makerLifecycleSentinelFromOrder(order(series(0.5)), AT)!;
    const taker = sentinel.arms.find((arm) => arm.candidateId === 'maker-expire2s-taker-v1')!;
    const abandon = sentinel.arms.find((arm) => arm.candidateId === 'maker-expire2s-abandon-v1')!;
    expect(taker.acquired).toBe(true);
    expect(taker.fillPrice).toBe(0.5);
    expect(taker.limitPrice).toBe(0.52);
    expect(taker.costCents).toBeGreaterThan(0);
    expect(taker.feeCents).toBeGreaterThanOrEqual(1);
    expect(abandon.acquired).toBe(false);
    expect(abandon.noTradeReason).toBe('arm-does-not-take');
    expect(abandon.costCents).toBeUndefined();
  });

  it('records no trade above the ceiling and never a capped one', () => {
    const sentinel = makerLifecycleSentinelFromOrder(order(series(0.8)), AT)!;
    for (const arm of sentinel.arms) expect(arm.acquired).toBe(false);
    expect(sentinel.arms[0].noTradeReason).toBe('above-price-ceiling');
  });

  it('will not fill beyond the depth actually displayed', () => {
    const shallow = makerLifecycleSentinelFromOrder(order(series(0.5, 0, 0.01)), AT)!;
    expect(shallow.arms[0].noTradeReason).toBe('insufficient-depth');
    const deep = makerLifecycleSentinelFromOrder(order(series(0.5, 0, 500)), AT)!;
    expect(deep.arms[0].acquired).toBe(true);
  });

  it('treats a maker that filled before the cutover as no decision for either arm', () => {
    const sentinel = makerLifecycleSentinelFromOrder(order(series(0.5, 0.6)), AT)!;
    for (const arm of sentinel.arms) expect(arm.noTradeReason).toBe('filled-before-cutover');
    expect(sentinel.productionFilled).toBe(true);
  });

  it('treats an absent quote at the cutover as unavailable, not as a refusal to trade', () => {
    const noPoll = [
      { at: AT, event: 'accepted', limitPrice: 0.5, filledCount: 0, remainingCount: 0.6 },
      { at: plus(13.7), event: 'terminal_fill', filledCount: 0, remainingCount: 0.6, restingDurationMs: 13_700 },
    ] as unknown as PaperOrder['entryExecutionObservations'];
    const sentinel = makerLifecycleSentinelFromOrder(order(noPoll), AT)!;
    expect(sentinel.cutover).toBeUndefined();
    for (const arm of sentinel.arms) expect(arm.noTradeReason).toBe('no-quote-at-cutover');
  });

  it('ignores a poll that lands before the two-second boundary', () => {
    const early = [
      { at: AT, event: 'accepted', limitPrice: 0.5, filledCount: 0, remainingCount: 0.6 },
      { at: plus(1.4), event: 'management_quote', selectedBid: 0.49, selectedAsk: 0.5, filledCount: 0, remainingCount: 0.6 },
      { at: plus(13.7), event: 'terminal_fill', filledCount: 0, remainingCount: 0.6, restingDurationMs: 13_700 },
    ] as unknown as PaperOrder['entryExecutionObservations'];
    expect(makerLifecycleSentinelFromOrder(order(early), AT)!.cutover).toBeUndefined();
  });

  // Regression: matching only live's event names produced zero paper records for 108 completed makers,
  // which would have kept the two-track review lock permanently closed without ever reporting a fault.
  it('builds the same record from the paper track vocabulary', () => {
    const paper = [
      { at: AT, event: 'paper_submitted', selectedBid: 0.49, selectedAsk: 0.5, limitPrice: 0.49, remainingCount: 0.6, bestAskDepth: 200 },
      { at: plus(2.1), event: 'management_quote', selectedBid: 0.49, selectedAsk: 0.5, filledCount: 0, remainingCount: 0.6, bestAskDepth: 200 },
      { at: plus(12.4), event: 'paper_expired', limitPrice: 0.49, filledCount: 0, remainingCount: 0 },
    ] as unknown as PaperOrder['entryExecutionObservations'];
    const sentinel = makerLifecycleSentinelFromOrder(order(paper, { executionMode: 'paper', id: 'paper:BTC:UP:2026-08-28T00:15:00Z' }), AT)!;
    expect(sentinel).not.toBeNull();
    expect(sentinel.executionMode).toBe('paper');
    expect(sentinel.cutover?.selectedAsk).toBe(0.5);
    expect(sentinel.arms.find((arm) => arm.candidateId === 'maker-expire2s-taker-v1')!.acquired).toBe(true);
  });

  it('reads a paper fill as terminal and as production having filled', () => {
    const filled = [
      { at: AT, event: 'paper_submitted', selectedBid: 0.49, selectedAsk: 0.5, limitPrice: 0.49, remainingCount: 0.6 },
      { at: plus(2.1), event: 'management_quote', selectedBid: 0.49, selectedAsk: 0.5, filledCount: 0.6, remainingCount: 0 },
      { at: plus(2.2), event: 'paper_fill', filledCount: 0.6, remainingCount: 0, restingDurationMs: 2200 },
    ] as unknown as PaperOrder['entryExecutionObservations'];
    const sentinel = makerLifecycleSentinelFromOrder(order(filled, { executionMode: 'paper' }), AT)!;
    expect(sentinel.productionFilled).toBe(true);
    for (const arm of sentinel.arms) expect(arm.noTradeReason).toBe('filled-before-cutover');
  });

  it('fails closed on a row it cannot narrow by strategy', () => {
    expect(makerLifecycleSentinelFromOrder(order(series(0.5), { strategyId: undefined }), AT)).toBeNull();
  });

  // Regression: the incremental return divided by the ARM's own stake, floored at 1 cent, so an abstention
  // row reported a raw cent difference as a fraction -- one 30c row came out as -3000% per window.
  it('normalizes the incremental return against the production stake, not the arm stake', () => {
    const base = makerLifecycleSentinelFromOrder(order(series(0.5)), AT)!;
    const report = buildMakerLifecycleSentinelReport({
      startedAt: AT,
      orders: [{ id: base.orderId, stakeCents: 30, pnlCents: 30 } as unknown as PaperOrder],
      sentinels: [{ ...base, productionFilled: true, outcome: 'UP', resolvedAt: AT }],
    });
    const abandon = report.tracks.live.candidates.find((arm) => arm.candidateId === 'maker-expire2s-abandon-v1')!;
    // Abstaining against a production winner forfeits exactly one stake: -1.0, never -30.
    expect(abandon.incrementalMeanReturn).toBeCloseTo(-1, 6);
  });

  // Regression: a maker that filled before the cutover was never reached by the rule, so the arm inherits
  // production's fill. Scoring it as an abstention made both arms look like "never trade" on fast fills.
  it('gives an arm production\'s own result when the maker filled before the cutover', () => {
    const early = makerLifecycleSentinelFromOrder(order(series(0.5, 0.6)), AT)!;
    const report = buildMakerLifecycleSentinelReport({
      startedAt: AT,
      orders: [{ id: early.orderId, stakeCents: 30, pnlCents: 30 } as unknown as PaperOrder],
      sentinels: [{ ...early, outcome: 'UP', resolvedAt: AT }],
    });
    for (const armReport of report.tracks.live.candidates) {
      expect(armReport.pnlCents, armReport.candidateId).toBe(30);
      expect(armReport.divergentWindows, armReport.candidateId).toBe(0);
    }
  });

  // Regression: an absent quote is unavailable evidence, already counted against coverage. Scoring it as a
  // decision not to trade penalized an arm for a data gap.
  it('leaves an unavailable cycle out of the scored cohort entirely', () => {
    const base = makerLifecycleSentinelFromOrder(order(series(0.5)), AT)!;
    const blind = { ...base, id: 'blind', cutover: undefined, outcome: 'UP' as const, resolvedAt: AT, productionFilled: true,
      arms: MAKER_LIFECYCLE_CANDIDATE_IDS.map((candidateId) => ({ candidateId, acquired: false, noTradeReason: 'no-quote-at-cutover' as const })) };
    const report = buildMakerLifecycleSentinelReport({
      startedAt: AT,
      orders: [{ id: base.orderId, stakeCents: 30, pnlCents: 30 } as unknown as PaperOrder],
      sentinels: [blind],
    });
    const abandon = report.tracks.live.candidates.find((arm) => arm.candidateId === 'maker-expire2s-abandon-v1')!;
    expect(abandon.records).toBe(0);
    expect(abandon.divergentWindows).toBe(0);
    expect(report.tracks.live.unavailableRecords).toBe(1);   // still counted against coverage
  });

  it('drops a row whose order is missing rather than inverting the baseline', () => {
    const base = makerLifecycleSentinelFromOrder(order(series(0.5)), AT)!;
    const report = buildMakerLifecycleSentinelReport({
      startedAt: AT, orders: [],
      sentinels: [{ ...base, productionFilled: true, outcome: 'UP', resolvedAt: AT }],
    });
    for (const armReport of report.tracks.live.candidates) expect(armReport.records).toBe(0);
  });

  it('records the queue position named as decision-time evidence', () => {
    const withQueue = [
      { at: AT, event: 'accepted', limitPrice: 0.5, filledCount: 0, remainingCount: 0.6 },
      { at: plus(2.1), event: 'management_quote', selectedBid: 0.49, selectedAsk: 0.5, filledCount: 0, remainingCount: 0.6, bestAskDepth: 200, displayedAhead: 17 },
      { at: plus(13.7), event: 'terminal_fill', filledCount: 0, remainingCount: 0.6, restingDurationMs: 13_700 },
    ] as unknown as PaperOrder['entryExecutionObservations'];
    expect(makerLifecycleSentinelFromOrder(order(withQueue), AT)!.cutover?.displayedAhead).toBe(17);
  });

  it('reaches the cushion tick by index rather than by rounding', () => {
    // toFixed rounds half-up: 0.615 + 0.02 became 0.64, three ticks of cushion instead of two.
    expect(makerLifecycleTakerLimit(0.615)).toBeCloseTo(0.63, 10);
    expect(makerLifecycleTakerLimit(0.5)).toBeCloseTo(0.52, 10);
  });

  it('counts an unavailable cycle against coverage and scores settlement per arm', () => {
    const won = makerLifecycleSentinelFromOrder(order(series(0.5)), AT)!;
    const report = buildMakerLifecycleSentinelReport({
      startedAt: AT,
      // A baseline order is required: without one the row now drops out rather than inverting the comparison.
      orders: [{ id: won.orderId, stakeCents: 0, pnlCents: 0 } as unknown as PaperOrder],
      sentinels: [
        { ...won, outcome: 'UP', resolvedAt: AT },
        { ...won, id: 'x', cutover: undefined, arms: MAKER_LIFECYCLE_CANDIDATE_IDS.map((candidateId) => ({ candidateId, acquired: false, noTradeReason: 'no-quote-at-cutover' as const })) },
      ],
    });
    expect(report.tracks.live.records).toBe(2);
    expect(report.tracks.live.unavailableRecords).toBe(1);
    expect(report.tracks.live.coverage).toBe(0.5);
    const taker = report.tracks.live.candidates.find((arm) => arm.candidateId === 'maker-expire2s-taker-v1')!;
    expect(taker.acquisitions).toBe(1);
    expect(taker.pnlCents).toBeGreaterThan(0);   // 0.5c entry settling in our favour pays
    expect(taker.reviewUnlocked).toBe(false);    // never on counts alone
  });
});
