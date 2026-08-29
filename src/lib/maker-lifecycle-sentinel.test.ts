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

  it('counts an unavailable cycle against coverage and scores settlement per arm', () => {
    const won = makerLifecycleSentinelFromOrder(order(series(0.5)), AT)!;
    const report = buildMakerLifecycleSentinelReport({
      startedAt: AT, orders: [],
      sentinels: [{ ...won, outcome: 'UP', resolvedAt: AT }, { ...won, id: 'x', cutover: undefined, arms: MAKER_LIFECYCLE_CANDIDATE_IDS.map((candidateId) => ({ candidateId, acquired: false })) }],
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
