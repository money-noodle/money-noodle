import { describe, expect, it } from 'vitest';
import {
  applyTradePrintsToPaperQueue,
  paperMakerEventTimeMicros,
  paperMakerEventWithinHorizon,
  type PaperMakerQueueState,
  type PaperTradePrint,
} from './domain/paper-maker-queue.js';
const state = (over: Partial<PaperMakerQueueState> = {}): PaperMakerQueueState => ({
  side: 'UP',
  requestedCount: 4,
  currentLimit: 0.42,
  queueAhead: 10,
  filledCount: 0,
  purchaseCents: 0,
  observedTradeIds: new Set(),
  ...over,
});
const print = (over: Partial<PaperTradePrint> = {}): PaperTradePrint => ({
  id: 'synthetic-print',
  at: '2026-10-11T00:00:02.000Z',
  count: 9,
  yesPrice: 0.42,
  noPrice: 0.58,
  takerSide: 'no',
  ...over,
});
const start = Date.parse('2026-10-11T00:00:00Z');
describe('isolated paper v7 queue primitive (not runtime authority)', () => {
  it('consumes ten queue units before four fills; repeated print is inert', () => {
    const queue = state();
    applyTradePrintsToPaperQueue(queue, [print()], start, start + 12_000);
    expect(queue.queueAhead).toBe(1);
    expect(queue.filledCount).toBe(0);
    const evidence = applyTradePrintsToPaperQueue(
      queue,
      [print(), print({ id: 'next', count: 5 })],
      start,
      start + 12_000,
    );
    expect(queue.filledCount).toBe(4);
    expect(queue.purchaseCents).toBeCloseTo(168);
    expect(evidence.fillAdded).toBe(4);
    expect(evidence.consumingTradeQuantity).toBe(5);
  });
  it('uses YES takers for DOWN and accounts partial purchase at the paper limit', () => {
    const queue = state({ side: 'DOWN', currentLimit: 0.58, queueAhead: 0 });
    applyTradePrintsToPaperQueue(
      queue,
      [print({ takerSide: 'yes', count: 1.25 })],
      start,
      start + 12_000,
    );
    expect(queue.filledCount).toBe(1.25);
    expect(queue.purchaseCents).toBeCloseTo(72.5);
  });
  it('does not infer fills from ask-lifting prints or missing displayed queue', () => {
    const queue = state({ queueAhead: 0 });
    applyTradePrintsToPaperQueue(
      queue,
      [print({ takerSide: 'yes', count: 100 })],
      start,
      start + 12_000,
    );
    expect(queue.filledCount).toBe(0);
    const unknown = state();
    delete unknown.queueAhead;
    applyTradePrintsToPaperQueue(unknown, [print({ count: 100 })], start, start + 12_000);
    expect(unknown.filledCount).toBe(0);
  });
  it('includes the exact horizon but excludes one microsecond afterward', () => {
    const queue = state({ queueAhead: 0 });
    applyTradePrintsToPaperQueue(
      queue,
      [
        print({ id: 'boundary', at: '2026-10-11T00:00:12.000000Z', count: 1 }),
        print({ id: 'late', at: '2026-10-11T00:00:12.000001Z', count: 100 }),
      ],
      start,
      start + 12_000,
    );
    expect(queue.filledCount).toBe(1);
    expect([...queue.observedTradeIds]).toEqual(['boundary']);
    expect(paperMakerEventTimeMicros('2026-10-11T00:00:12.0000001Z')).toBeUndefined();
    expect(paperMakerEventWithinHorizon(13_000, 1_000, 13_000)).toBe(true);
    expect(paperMakerEventWithinHorizon(13_001, 1_000, 13_000)).toBe(false);
  });
  it('rejects malformed or oversized batches before changing any queue state', () => {
    const queue = state();
    expect(() =>
      applyTradePrintsToPaperQueue(queue, [print(), print({ count: -1 })], start, start + 12_000),
    ).toThrow();
    expect(queue.queueAhead).toBe(10);
    expect(queue.observedTradeIds.size).toBe(0);
    expect(() =>
      applyTradePrintsToPaperQueue(
        queue,
        Array.from({ length: 1001 }, () => print()),
        start,
        start + 12_000,
      ),
    ).toThrow();
    expect(() => applyTradePrintsToPaperQueue(queue, [], start, start + 12_001)).toThrow();
  });
});
