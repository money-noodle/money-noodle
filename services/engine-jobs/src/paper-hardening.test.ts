import { describe, expect, it } from 'vitest';
import {
  backOffValidKalshiPrice,
  advanceValidKalshiPrice,
  initialManagedMakerPrice,
  nextManagedMakerPrice,
} from './domain/paper-pricing.js';
import { normalizePaperBook, selectedSideDepth } from './domain/paper-depth.js';
import { paperMakerAccounting } from './domain/paper-money.js';
import {
  applyTradePrintsToPaperQueue,
  PAPER_EVIDENCE_PRECISION_VERSION,
  type PaperMakerQueueState,
} from './domain/paper-maker-queue.js';
describe('explicit paper boundary corrections (not runtime authority)', () => {
  it('rejects infinite counts, excessive ladders, and rounded submicrostep nonprogress', () => {
    expect(() => backOffValidKalshiPrice(0.42, Infinity)).toThrow();
    expect(() => advanceValidKalshiPrice(0.42, 1001)).toThrow();
    expect(() =>
      backOffValidKalshiPrice(0.42, 1, [{ start: '0', end: '1', step: '0.0000001' }]),
    ).toThrow();
    expect(() =>
      backOffValidKalshiPrice(
        0.42,
        1,
        Array.from({ length: 65 }, () => ({ start: '0', end: '1', step: '0.01' })),
      ),
    ).toThrow();
    expect(() =>
      initialManagedMakerPrice({
        quote: { bid: 0.4, ask: 0.42 },
        maximumPrice: 0.5,
        createAttempt: Infinity,
      }),
    ).toThrow();
    expect(() =>
      nextManagedMakerPrice({
        quote: { bid: 0.4, ask: 0.42 },
        maximumPrice: 0.5,
        currentPrice: 0.4,
        managementAttempt: NaN,
      }),
    ).toThrow();
    expect(
      backOffValidKalshiPrice(0.11, 2, [
        { start: '0', end: '.1', step: '.001' },
        { start: '.1', end: '1', step: '.01' },
      ]),
    ).toBe(0.099);
  });
  it('attributes fill to earlier microsecond z despite later a lexical precedence, with stable exact ties', () => {
    expect(PAPER_EVIDENCE_PRECISION_VERSION).toBe('paper-queue-evidence-microseconds-v1');
    const make = (): PaperMakerQueueState => ({
      side: 'UP',
      requestedCount: 1,
      currentLimit: 0.42,
      queueAhead: 0,
      filledCount: 0,
      purchaseCents: 0,
      observedTradeIds: new Set(),
    });
    const trade = (id: string, at: string) => ({
      id,
      at,
      count: 1,
      yesPrice: 0.42,
      noPrice: 0.58,
      takerSide: 'no' as const,
    });
    const start = Date.parse('2026-10-11T00:00:00Z');
    const queue = make();
    const evidence = applyTradePrintsToPaperQueue(
      queue,
      [trade('a', '2026-10-11T00:00:02.000999Z'), trade('z', '2026-10-11T00:00:02.000001Z')],
      start,
      start + 12000,
    );
    expect([...queue.observedTradeIds]).toEqual(['z']);
    expect(queue.purchaseCents).toBe(42);
    expect(evidence.firstConsumingTradeAt).toBe('2026-10-11T00:00:02.000001Z');
    const tied = make();
    applyTradePrintsToPaperQueue(
      tied,
      [trade('z', '2026-10-11T00:00:02.000001Z'), trade('a', '2026-10-11T00:00:02.000001Z')],
      start,
      start + 12000,
    );
    expect([...tied.observedTradeIds]).toEqual(['a']);
  });
  it('rejects impossible filled quantities before manufacturing payout', () => {
    expect(() =>
      paperMakerAccounting({
        venue: 'polymarket',
        filledCount: 0.5,
        purchaseCents: 25,
        averagePrice: 0.5,
        reservationCents: 100,
        evidenceComplete: true,
      }),
    ).toThrow();
    expect(() =>
      paperMakerAccounting({
        venue: 'kalshi',
        filledCount: 0.015,
        purchaseCents: 0.75,
        averagePrice: 0.5,
        reservationCents: 100,
        evidenceComplete: true,
      }),
    ).toThrow();
    expect(
      paperMakerAccounting({
        venue: 'kalshi',
        filledCount: 1.25,
        purchaseCents: 72.5,
        averagePrice: 0.58,
        reservationCents: 207,
        evidenceComplete: true,
      }),
    ).toEqual({
      status: 'open',
      stakeCents: 73,
      feeCents: 0,
      releasedCents: 134,
      potentialPayoutCents: 125,
    });
  });
  it('refuses negative/NaN/oversized depth but preserves fractional public displayed proxy', () => {
    const book = {
      observedAt: '2026-10-11T00:00:00Z',
      yesBids: [{ price: 0.42, quantity: 0.5 }],
      noBids: [{ price: 0.5, quantity: 2 }],
    };
    for (const quantity of [-1, NaN])
      expect(() => normalizePaperBook({ ...book, yesBids: [{ price: 0.42, quantity }] })).toThrow();
    expect(() =>
      normalizePaperBook({
        ...book,
        yesBids: Array.from({ length: 1001 }, () => ({ price: 0.42, quantity: 1 })),
      }),
    ).toThrow();
    expect(selectedSideDepth(book, 'UP', 0.42, 0.5, 0.42).displayedAhead).toBe(0.5);
    expect(selectedSideDepth(undefined, 'UP', 0.42, 0.5, 0.42).displayedAhead).toBeUndefined();
  });
});
