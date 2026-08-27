import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { applyPaperMakerSimulation, attachMatchedLiveFillShadow, resolveRestingPaperOrders } from './paper-execution';
import { executionMirrorPairStamp } from './execution-mirror-pair';
import { initialManagedMakerPrice, nextManagedMakerPrice, selectedManagedMakerQuote } from './managed-maker';
import {
  applyTradePrintsToPaperQueue, paperMakerEventTimeMicros, paperMakerEventWithinHorizon, simulateManagedPaperMaker,
  type PaperMakerQueueState,
} from './paper-maker-simulation';
import {
  PAPER_FILL_CALIBRATION_VERSION, PAPER_FILL_QUEUE_CLEAR_MAX, PAPER_NEUTRAL_EXECUTION_VERSION,
  effectiveQueueAhead, isPaperFillCalibration, paperExecutionGeneration, paperExecutionVersion,
} from './paper-fill-calibration';
import type { BinaryOrderBook, DashboardData, PaperOrder } from './types';
import type { KalshiTradePrint } from './kalshi-market-data';

const CLOSES = new Date(Date.now() + 600_000).toISOString();
const ranges = [{ start: '0', end: '1', step: '0.01' }];
const book = (yesBids: Array<[number, number]>): BinaryOrderBook => ({
  yesBids: yesBids.map(([price, quantity]) => ({ price, quantity })),
  noBids: [{ price: 0.55, quantity: 10 }], observedAt: new Date().toISOString(),
});

const order = (over: Partial<PaperOrder> = {}): PaperOrder => ({
  id: 'paper:BTC:UP:x', logicalOrderId: 'paper:BTC:UP:x', attemptNumber: 1, clientOrderId: 'paper:BTC:UP:x',
  executionMode: 'paper', marketId: 'crypto-15m', providerId: 'kalshi', symbol: 'BTC', venue: 'kalshi',
  contractId: 'KX', side: 'UP', status: 'pending_reservation', createdAt: new Date().toISOString(),
  calculationAt: new Date().toISOString(), closesAt: CLOSES, modelProbabilityUp: 0.62, confidence: 0.7,
  askPrice: 0.45, bidPrice: 0.43, spread: 0.02, quantity: 4, requestedQuantity: 4,
  feeCents: 1, stakeCents: 181, potentialPayoutCents: 400,
  restingUntil: new Date(Date.now() + 12_000).toISOString(),
  ...over,
} as PaperOrder);

const dashboard = (ask: number): DashboardData => ({
  predictions: [{
    symbol: 'BTC', market: { live: true, closesAt: CLOSES, askUp: ask, askDown: 1 - ask, bidUp: ask - 0.02, bidDown: 0.5 },
    kalshi: { venue: 'kalshi', live: true, closesAt: CLOSES, askUp: ask, askDown: 1 - ask, bidUp: ask - 0.02, bidDown: 0.5 },
  }],
} as unknown as DashboardData);

const trade = (over: Partial<KalshiTradePrint> = {}): KalshiTradePrint => ({
  id: crypto.randomUUID(), ticker: 'KX', at: new Date(2_000).toISOString(), count: 1,
  yesPrice: 0.42, noPrice: 0.58, takerSide: 'no', ...over,
});

describe('shared managed-maker pricing', () => {
  it('uses the refreshed exact contract rather than the stale issuance bid', () => {
    const initial = initialManagedMakerPrice({
      quote: { bid: 0.38, ask: 0.42, ranges }, maximumPrice: 0.47, requestedStart: 0.46,
    });
    expect(initial).toBe(0.41);
    expect(nextManagedMakerPrice({
      quote: { bid: 0.42, ask: 0.44, ranges }, maximumPrice: 0.47,
      currentPrice: initial, managementAttempt: 0,
    })).toBe(0.42);
  });

  it('uses the same selected-side conversion for DOWN/NO', () => {
    const quote = selectedManagedMakerQuote({ yesBid: 0.40, yesAsk: 0.42, side: 'DOWN', ranges });
    expect(quote.bid).toBeCloseTo(0.58);
    expect(quote.ask).toBeCloseTo(0.60);
    expect(initialManagedMakerPrice({ quote, maximumPrice: 0.60, requestedStart: 0.57 })).toBe(0.58);
  });
});

describe('trade-print queue model', () => {
  it('fills only after opposite-side taker volume consumes displayed queue ahead', () => {
    const state: PaperMakerQueueState = {
      side: 'UP', requestedCount: 4, currentLimit: 0.42, queueAhead: 10,
      filledCount: 0, purchaseCents: 0, observedTradeIds: new Set(),
    };
    const first = applyTradePrintsToPaperQueue(state, [trade({ id: 'first', count: 9 })], 0, 12_000);
    expect(state.filledCount).toBe(0);
    expect(state.queueAhead).toBe(1);
    expect(first).toMatchObject({
      consumingTradeCount: 1, consumingTradeQuantity: 9, queueAheadBefore: 10, queueAheadAfter: 1,
      fillAdded: 0,
    });
    const second = applyTradePrintsToPaperQueue(
      state, [trade({ id: 'first', count: 9 }), trade({ id: 'second', count: 5 })], 0, 12_000,
    );
    expect(state.filledCount).toBe(4);
    expect(state.purchaseCents).toBeCloseTo(168);
    expect(second).toMatchObject({
      consumingTradeCount: 1, consumingTradeQuantity: 5, queueAheadBefore: 1, queueAheadAfter: 0,
      fillAdded: 4,
    });
  });

  it('uses YES takers to consume a DOWN/NO resting bid', () => {
    const state: PaperMakerQueueState = {
      side: 'DOWN', requestedCount: 2, currentLimit: 0.58, queueAhead: 0,
      filledCount: 0, purchaseCents: 0, observedTradeIds: new Set(),
    };
    applyTradePrintsToPaperQueue(
      state, [trade({ takerSide: 'yes', count: 2, yesPrice: 0.42, noPrice: 0.58 })], 0, 12_000,
    );
    expect(state.filledCount).toBe(2);
    expect(state.purchaseCents).toBeCloseTo(116);
  });

  it('ignores ask-lifting trades and never turns touch alone into a fill', () => {
    const state: PaperMakerQueueState = {
      side: 'UP', requestedCount: 4, currentLimit: 0.42, queueAhead: 0,
      filledCount: 0, purchaseCents: 0, observedTradeIds: new Set(),
    };
    applyTradePrintsToPaperQueue(state, [trade({ takerSide: 'yes', count: 100 })], 0, 12_000);
    expect(state.filledCount).toBe(0);
  });

  it('makes a retained pre-horizon replay exactly equal when later prints are present', () => {
    const run = (prints: KalshiTradePrint[]) => {
      const state: PaperMakerQueueState = {
        side: 'UP', requestedCount: 2, currentLimit: 0.42, queueAhead: 0,
        filledCount: 0, purchaseCents: 0, observedTradeIds: new Set(),
      };
      const evidence = applyTradePrintsToPaperQueue(state, prints, 0, 12_000);
      return { state: { ...state, observedTradeIds: [...state.observedTradeIds] }, evidence };
    };
    const inside = trade({ id: 'inside', at: new Date(12_000).toISOString(), count: 1 });
    const after = trade({ id: 'after', at: new Date(12_001).toISOString(), count: 100 });
    expect(run([inside, after])).toEqual(run([inside]));
  });

  it('admits both exact boundaries and rejects malformed or post-horizon event times', () => {
    expect(paperMakerEventWithinHorizon(1_000, 1_000, 13_000)).toBe(true);
    expect(paperMakerEventWithinHorizon(13_000, 1_000, 13_000)).toBe(true);
    expect(paperMakerEventWithinHorizon(13_001, 1_000, 13_000)).toBe(false);
    expect(paperMakerEventWithinHorizon(999, 1_000, 13_000)).toBe(false);
    expect(paperMakerEventWithinHorizon(Number.NaN, 1_000, 13_000)).toBe(false);
    expect(paperMakerEventWithinHorizon(1_000, 13_000, 1_000)).toBe(false);
    const boundary = paperMakerEventTimeMicros('2026-08-27T00:00:12.000000Z');
    const justAfter = paperMakerEventTimeMicros('2026-08-27T00:00:12.000001Z');
    expect(boundary).toBeDefined();
    expect(justAfter).toBeDefined();
    expect(paperMakerEventWithinHorizon(boundary!, boundary! - 12_000_000, boundary!)).toBe(true);
    expect(paperMakerEventWithinHorizon(justAfter!, boundary! - 12_000_000, boundary!)).toBe(false);
    expect(paperMakerEventTimeMicros('2026-08-27T00:00:12.0000001Z')).toBeUndefined();
  });
});

describe('independent paper maker manager', () => {
  it('polls and reprices on the live cadence, then fills from public trades', async () => {
    let now = 0;
    const quotes = [
      { bid: 0.38, ask: 0.42, ranges, orderBook: book([[0.38, 10]]) },
      { bid: 0.42, ask: 0.44, ranges, orderBook: book([[0.40, 10]]) },
      { bid: 0.43, ask: 0.45, ranges, orderBook: book([[0.41, 10]]) },
    ];
    let quoteIndex = 0;
    const result = await simulateManagedPaperMaker({
      side: 'UP', requestedCount: 4, maximumPrice: 0.47, requestedStart: 0.46,
    }, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      quote: async () => quotes[Math.min(quoteIndex++, quotes.length - 1)],
      tradesSince: async () => now < 4_000 ? [] : [trade({ id: 'fill', at: new Date(3_000).toISOString(), count: 4, yesPrice: 0.42 })],
    });
    expect(result.initialPrice).toBe(0.41);
    expect(result.filledCount).toBe(4);
    expect(result.averagePrice).toBe(0.42);
    expect(result.observations.map((item) => item.event)).toContain('amend_accepted');
    expect(result.observations.find((item) => item.event === 'paper_trade_evidence' && item.fillAdded === 4)).toMatchObject({
      consumingTradeCount: 1, consumingTradeQuantity: 4, firstConsumingTradeAt: new Date(3_000).toISOString(),
      queueAheadBefore: 0, queueAheadAfter: 0, fillAdded: 4,
    });
    expect(result.observations.at(-1)).toMatchObject({ event: 'paper_fill', filledCount: 4 });
  });

  it('never consumes a public print after the exact executable horizon', async () => {
    const run = async (printAtMs: number) => {
      let now = 0;
      return simulateManagedPaperMaker({
        side: 'UP', requestedCount: 1, maximumPrice: 0.41, requestedStart: 0.41,
      }, {
        checks: 1, pollMs: 2_000, now: () => now,
        wait: async (milliseconds) => { now += milliseconds; },
        quote: async () => ({ bid: 0.40, ask: 0.42, ranges, orderBook: book([[0.41, 0]]) }),
        tradesSince: async () => [trade({
          id: `boundary-${printAtMs}`, at: new Date(printAtMs).toISOString(), count: 1,
          yesPrice: 0.41, takerSide: 'no',
        })],
      });
    };
    expect((await run(2_000)).filledCount).toBe(1);
    const after = await run(2_001);
    expect(after.filledCount).toBe(0);
    expect(after.observations.find((item) => item.event === 'paper_trade_evidence')).toMatchObject({
      consumingTradeCount: 0, fillAdded: 0,
    });
  });

  it('does not fill an orphaned order merely because a dashboard ask touched its limit', () => {
    const pending = order({ initialSubmittedPrice: 0.43 });
    const ledger: any = { orders: [pending], paperBudget: { availableCents: 1000 } };
    expect(resolveRestingPaperOrders(dashboard(0.43), ledger)).toBe(false);
    expect(pending.status).toBe('pending_reservation');
  });

  it('returns an interrupted reservation after its durable horizon expires', () => {
    const pending = order({ restingUntil: new Date(Date.now() - 1_000).toISOString() });
    const ledger: any = { orders: [pending], paperBudget: { availableCents: 1000 } };
    expect(resolveRestingPaperOrders(dashboard(0.30), ledger)).toBe(true);
    expect(pending.status).toBe('unfilled');
    expect(ledger.paperBudget.availableCents).toBe(1000 + pending.stakeCents);
  });

  it('keeps only a partial fill and releases the unused reservation', () => {
    const pending = order({ stakeCents: 200, quantity: 4, requestedQuantity: 4 });
    const ledger: any = { orders: [pending], paperBudget: { availableCents: 800 } };
    applyPaperMakerSimulation(pending, {
      submittedAt: '2026-08-15T00:00:00Z', completedAt: '2026-08-15T00:00:12Z',
      restingUntil: '2026-08-15T00:00:12Z', initialPrice: 0.41, finalPrice: 0.42,
      filledCount: 2, averagePrice: 0.42, purchaseCents: 84, evidenceComplete: true,
      observations: [{ at: '2026-08-15T00:00:12Z', event: 'paper_fill', filledCount: 2 }],
    }, ledger);
    // A managed maker fill pays no Kalshi fee, so the stake is the purchase alone and the whole unused
    // reserve comes back. Charging the taker schedule here cost paper 4c on this fill and 694c overall
    // before 2026-08-17, none of which live ever paid. See docs/paper-maker-fee-design.md.
    expect(pending).toMatchObject({ status: 'open', quantity: 2, requestedQuantity: 4, stakeCents: 84, feeCents: 0 });
    expect(ledger.paperBudget.availableCents).toBe(916);
    // The reservation must balance exactly: what went out, minus what the fill cost, comes back.
    expect(ledger.paperBudget.availableCents).toBe(800 + 200 - pending.stakeCents);
  });

  it('excludes a zero-fill attempt whose terminal trade evidence was unavailable', () => {
    const pending = order({ stakeCents: 200 });
    const ledger: any = { orders: [pending], paperBudget: { availableCents: 800 } };
    applyPaperMakerSimulation(pending, {
      submittedAt: '2026-08-15T00:00:00Z', completedAt: '2026-08-15T00:00:12Z',
      restingUntil: '2026-08-15T00:00:12Z', initialPrice: 0.41, finalPrice: 0.42,
      filledCount: 0, averagePrice: 0, purchaseCents: 0, evidenceComplete: false,
      observations: [{ at: '2026-08-15T00:00:12Z', event: 'paper_expired', filledCount: 0 }],
    }, ledger);
    expect(pending.status).toBe('rejected');
    expect(pending.noFillReason).toBeUndefined();
    expect(ledger.paperBudget.availableCents).toBe(1000);
  });
});

describe('matched-live shadow', () => {
  it('uses an exact prospective pair instead of the nearest same-window paper row', () => {
    const intended = order({ createdAt: '2026-08-15T00:00:00Z', calculationAt: '2026-08-15T00:00:00Z' });
    intended.executionMirrorPair = executionMirrorPairStamp(intended);
    const nearer = order({ id: 'paper:nearer', createdAt: '2026-08-15T00:00:10Z', calculationAt: '2026-08-15T00:00:10Z' });
    nearer.executionMirrorPair = executionMirrorPairStamp(nearer);
    const live = order({
      id: 'live:BTC:UP:x', executionMode: 'live', status: 'open', createdAt: '2026-08-15T00:00:10Z',
      calculationAt: intended.calculationAt, quantity: 1, requestedQuantity: 1, filledCount: 1,
      authoritativeFillPrice: 0.44, actualFeeCents: 0, venueOrderId: 'venue-live',
    });
    live.executionMirrorPair = executionMirrorPairStamp(live);
    expect(attachMatchedLiveFillShadow([intended, nearer, live], live)).toBe(true);
    expect(intended.matchedLiveFill?.liveOrderId).toBe(live.id);
    expect(nearer.matchedLiveFill).toBeUndefined();
  });

  it('records authoritative live terms separately and caps them at paper quantity', () => {
    const paper = order({ status: 'unfilled', quantity: 4.17, requestedQuantity: 4.17 });
    const live = order({
      id: 'live:BTC:UP:x', executionMode: 'live', status: 'open', createdAt: paper.createdAt,
      quantity: 4.08, requestedQuantity: 4.08, filledCount: 4.08,
      authoritativeFillPrice: 0.44, actualFeeCents: 0, feeCents: 0, venueOrderId: 'venue-live',
    });
    expect(attachMatchedLiveFillShadow([paper, live], live, '2026-08-15T00:00:00Z')).toBe(true);
    expect(paper.status).toBe('unfilled');
    expect(paper.matchedLiveFill).toMatchObject({
      liveOrderId: live.id, quantity: 4.08, fillPrice: 0.44, purchaseCents: 179.52,
    });
    expect(live.matchedPaperOrderId).toBe(paper.id);
  });
});

describe('paper fill calibration', () => {
  it('neutral fraction reproduces the exact displayed queue', () => {
    expect(effectiveQueueAhead(10, 0)).toBe(10);
    expect(effectiveQueueAhead(0.42, 0)).toBe(0.42); // neutral fraction exact upstream
    expect(effectiveQueueAhead(0.01, 0)).toBe(0.01);
  });

  it('reduces the initial queue with exact floor+1e-9 arithmetic and never negative', () => {
    expect(effectiveQueueAhead(10, 0.25)).toBe(7); // floor(10*0.75 + 1e-9) = 7.50.. floor = 7
    expect(effectiveQueueAhead(2, 0.5)).toBe(2); // 0.5 is at the capped bound: rejected -> fraction 0
    expect(effectiveQueueAhead(70, 0.3)).toBe(49); // floor(49.0000..)=49
    expect(effectiveQueueAhead(0, 0.4)).toBe(0);
    expect(effectiveQueueAhead(undefined, 0.25)).toBeUndefined();
    expect(effectiveQueueAhead(10, Number.NaN)).toBe(10); // unsafe fraction coerced to 0
  });

  it('bounds and validation reject out-of-range, generation-conflicting, and incomplete calibrations', () => {
    expect(effectiveQueueAhead(100, PAPER_FILL_QUEUE_CLEAR_MAX)).toBe(100); // at cap key == 0
    expect(isPaperFillCalibration({
      version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0.2,
      appliedToPaperExecution: paperExecutionVersion(8), heldOutWindows: 30,
      adoptedAt: '2026-08-21T00:00:00Z', reason: 'held-out fit',
    })).toBe(true);
    expect(isPaperFillCalibration({
      version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0,
      appliedToPaperExecution: PAPER_NEUTRAL_EXECUTION_VERSION, heldOutWindows: 0,
      adoptedAt: '', reason: 'neutral',
    })).toBe(true);
    expect(isPaperFillCalibration({
      version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0.2,
      appliedToPaperExecution: PAPER_NEUTRAL_EXECUTION_VERSION, heldOutWindows: 30,
      adoptedAt: '2026-08-21T00:00:00Z', reason: 'must not pool with neutral v7',
    })).toBe(false);
    expect(isPaperFillCalibration({ version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0.2 })).toBe(false);
    expect(isPaperFillCalibration({
      version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: -0.1,
    })).toBe(false);
    expect(isPaperFillCalibration({
      version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0.9,
    })).toBe(false);
    expect(isPaperFillCalibration(null)).toBe(false);
    expect(paperExecutionGeneration(paperExecutionVersion(8))).toBe(8);
    expect(() => paperExecutionVersion(5)).toThrow();
  });

  it('an explicit neutral calibration is exactly equal to the absent-calibration control', async () => {
    const run = async (calibration?: Parameters<typeof simulateManagedPaperMaker>[1]['calibration']) => {
      let now = 0;
      return simulateManagedPaperMaker({
        side: 'UP', requestedCount: 4, maximumPrice: 0.47, requestedStart: 0.46,
      }, {
        now: () => now,
        wait: async (milliseconds) => { now += milliseconds; },
        quote: async () => ({ bid: 0.38, ask: 0.42, ranges, orderBook: book([[0.41, 10]]) }),
        tradesSince: async () => now < 6_000 ? [] : [trade({
          id: 'neutral-fill', at: new Date(5_000).toISOString(), count: 14, yesPrice: 0.41, takerSide: 'no',
        })],
        calibration,
        onInitialQuoteSettled: () => undefined,
      });
    };
    expect(await run({
      version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0,
      appliedToPaperExecution: PAPER_NEUTRAL_EXECUTION_VERSION, heldOutWindows: 0,
      adoptedAt: '', reason: 'neutral',
    })).toEqual(await run());
  });

  it('applies a configured calibration whenever an amendment joins a new queue', async () => {
    const run = async (queueClearFraction: number) => {
      let now = 0, quoteIndex = 0;
      const quotes = [
        { bid: 0.38, ask: 0.42, ranges, orderBook: book([[0.38, 100]]) },
        { bid: 0.38, ask: 0.42, ranges, orderBook: book([[0.41, 10]]) },
      ];
      return simulateManagedPaperMaker({
        side: 'UP', requestedCount: 4, maximumPrice: 0.41, requestedStart: 0.38,
      }, {
        checks: 2,
        now: () => now,
        wait: async (milliseconds) => { now += milliseconds; },
        quote: async () => quotes[Math.min(quoteIndex++, quotes.length - 1)],
        tradesSince: async () => now < 4_000 ? [] : [trade({
          id: 'amended-fill', at: new Date(3_000).toISOString(), count: 8, yesPrice: 0.41, takerSide: 'no',
        })],
        calibration: {
          version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction,
          appliedToPaperExecution: paperExecutionVersion(8), heldOutWindows: 30,
          adoptedAt: '2026-08-21T00:00:00Z', reason: 'test',
        },
      });
    };
    const neutral = await run(0);
    const calibrated = await run(0.3);
    expect(neutral.filledCount).toBe(0); // all eight prints remain behind ten displayed contracts
    expect(calibrated.filledCount).toBe(1); // amended queue is floor(10 * 0.7) = 7
    expect(calibrated.observations.find((item) => item.event === 'paper_trade_evidence' && item.fillAdded === 1))
      .toMatchObject({ limitPrice: 0.41, queueAheadBefore: 7, queueAheadAfter: 0, fillAdded: 1 });
  });

  it('applies a configured calibration when later depth recovers the initially unavailable queue', async () => {
    let now = 0, quoteIndex = 0;
    const quotes = [
      { bid: 0.38, ask: 0.42, ranges },
      { bid: 0.38, ask: 0.42, ranges, orderBook: book([[0.41, 10]]) },
    ];
    const result = await simulateManagedPaperMaker({
      side: 'UP', requestedCount: 4, maximumPrice: 0.41, requestedStart: 0.41,
    }, {
      checks: 2,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      quote: async () => quotes[Math.min(quoteIndex++, quotes.length - 1)],
      tradesSince: async () => now < 4_000 ? [] : [trade({
        id: 'recovered-depth-fill', at: new Date(3_000).toISOString(), count: 8, yesPrice: 0.41, takerSide: 'no',
      })],
      calibration: {
        version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0.3,
        appliedToPaperExecution: paperExecutionVersion(8), heldOutWindows: 30,
        adoptedAt: '2026-08-21T00:00:00Z', reason: 'test',
      },
    });
    expect(result.filledCount).toBe(1);
    expect(result.observations.find((item) => item.event === 'paper_trade_evidence' && item.fillAdded === 1))
      .toMatchObject({ queueAheadBefore: 7, queueAheadAfter: 0, fillAdded: 1 });
  });

  it('a configured calibration reduces the simulated initial queue on the manager', async () => {
    let now = 0;
    const result = await simulateManagedPaperMaker({
      side: 'UP', requestedCount: 4, maximumPrice: 0.47, requestedStart: 0.46,
    }, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      quote: async () => ({ bid: 0.38, ask: 0.42, ranges, orderBook: book([[0.41, 10]]) }),
      tradesSince: async () => now < 6_000 ? [] : [trade({ id: 'fill', at: new Date(5_000).toISOString(), count: 8, yesPrice: 0.41, takerSide: 'no' })],
      calibration: {
        version: PAPER_FILL_CALIBRATION_VERSION, queueClearFraction: 0.3,
        appliedToPaperExecution: paperExecutionVersion(8), heldOutWindows: 30,
        adoptedAt: '2026-08-21T00:00:00Z', reason: 'test',
      },
      onInitialQuoteSettled: () => undefined,
    });
    // A calibrated 0.3 clear shrinks the 10 displayed ahead to 7; the 8-count taker consumes it and fills.
    expect(result.filledCount).toBeGreaterThan(0);
  });
});
