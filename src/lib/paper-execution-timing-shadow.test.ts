import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  PAPER_ACKNOWLEDGEMENT_DELAY_MS, PAPER_CREATE_DELAY_MS, PAPER_EXECUTION_TIMING_SHADOW_VERSION,
  PAPER_FINAL_EVIDENCE_GRACE_MS, evaluateAcceptanceTimingShadow, paperExecutionTimingShadowId,
  replayPaperMakerAtEventTime, type PaperExecutionTimingDecision,
} from './paper-execution-timing-shadow';
import {
  getPaperExecutionTimingShadows, recordPaperAcceptanceTimingResult, recordPaperExecutionGraceResult,
  recordPaperExecutionTimingDecision, resetPaperExecutionTimingShadowStoreForTests,
} from './paper-execution-timing-shadow-store';
import { observePaperAcceptanceTiming, observePaperFinalEvidenceGrace, resetPaperExecutionTimingObserverForTests } from './paper-execution-timing-observer';
import { PAPER_MANAGED_MAKER_EXECUTION_VERSION, type PaperMakerSimulationResult } from './paper-maker-simulation';
import type { KalshiTradePrint } from './kalshi-market-data';
import type { PaperOrder } from './types';

const at = (milliseconds: number) => new Date(milliseconds).toISOString();
const trade = (over: Partial<KalshiTradePrint> = {}): KalshiTradePrint => ({
  id: crypto.randomUUID(), ticker: 'KXBTC', at: at(3_000), count: 1,
  yesPrice: 0.40, noPrice: 0.60, takerSide: 'no', ...over,
});
const simulation = (over: Partial<PaperMakerSimulationResult> = {}): PaperMakerSimulationResult => ({
  submittedAt: at(0), completedAt: at(12_000), restingUntil: at(12_000),
  initialPrice: 0.40, finalPrice: 0.42, filledCount: 0, averagePrice: 0, purchaseCents: 0,
  evidenceComplete: true,
  observations: [
    { at: at(0), event: 'paper_submitted', limitPrice: 0.40, displayedAhead: 2 },
    { at: at(4_000), event: 'amend_accepted', limitPrice: 0.42, displayedAhead: 3 },
    { at: at(12_000), event: 'paper_expired', limitPrice: 0.42 },
  ],
  ...over,
});
const order = (over: Partial<PaperOrder> = {}): PaperOrder => ({
  id: 'paper:timing', logicalOrderId: 'paper:timing', attemptNumber: 1, clientOrderId: 'paper:timing',
  executionMode: 'paper', strategyId: 'edge-binary-buy', marketId: 'crypto-15m',
  providerId: 'kalshi', providerVariantId: 'kalshi-us', venue: 'kalshi', contractId: 'KXBTC',
  symbol: 'BTC', side: 'UP', status: 'pending_reservation', createdAt: at(0), calculationAt: at(0),
  closesAt: at(900_000), modelProbabilityUp: 0.65, confidence: 0.8,
  askPrice: 0.45, bidPrice: 0.40, issuanceAskPrice: 0.45, issuanceBidPrice: 0.40,
  approvedMaximumPrice: 0.45, quantity: 2, requestedQuantity: 2, stakeCents: 90, feeCents: 0,
  potentialPayoutCents: 200, liquidityRole: 'maker', paperEntryRoute: 'maker',
  executionMirrorPair: { version: 'entry-execution-mirror-pair-v1', id: 'pair:timing' },
  entryDecision: { executionPolicyVersion: PAPER_MANAGED_MAKER_EXECUTION_VERSION } as PaperOrder['entryDecision'],
  paperFillCalibration: {
    version: 'paper-fill-calibration-v1', queueClearFraction: 0,
    appliedToPaperExecution: PAPER_MANAGED_MAKER_EXECUTION_VERSION,
    heldOutWindows: 0, adoptedAt: '', reason: 'neutral',
  },
  ...over,
} as PaperOrder);

const decision = (): PaperExecutionTimingDecision => ({
  version: PAPER_EXECUTION_TIMING_SHADOW_VERSION, id: paperExecutionTimingShadowId('paper:timing'),
  recordedAt: at(0), orderId: 'paper:timing', mirrorPairId: 'pair:timing',
  strategyId: 'edge-binary-buy', marketId: 'crypto-15m', providerId: 'kalshi', providerVariantId: 'kalshi-us',
  paperExecutionVersion: PAPER_MANAGED_MAKER_EXECUTION_VERSION,
  contractId: 'KXBTC', symbol: 'BTC', side: 'UP', closesAt: at(900_000), calculationAt: at(0),
  requestedCount: 2, maximumPrice: 0.45, requestedStart: 0.40,
  createDelayMs: PAPER_CREATE_DELAY_MS, acknowledgementDelayMs: PAPER_ACKNOWLEDGEMENT_DELAY_MS,
  finalEvidenceGraceMs: PAPER_FINAL_EVIDENCE_GRACE_MS,
});

describe('paper execution timing pure shadow', () => {
  it('holds the create limit fixed through acknowledgement and classifies a crossing race', () => {
    expect(evaluateAcceptanceTimingShadow({
      createQuote: { bid: 0.40, ask: 0.45 }, acknowledgementQuote: { bid: 0.42, ask: 0.44 },
      maximumPrice: 0.45, requestedStart: 0.44,
    })).toEqual({ status: 'post_only_race', limitPrice: 0.44 });
    expect(evaluateAcceptanceTimingShadow({
      createQuote: { bid: 0.40, ask: 0.45 }, acknowledgementQuote: { bid: 0.41, ask: 0.45 },
      maximumPrice: 0.45, requestedStart: 0.44,
    })).toEqual({ status: 'accepted', limitPrice: 0.44 });
  });

  it('replays prints against the queue and limit active at venue event time', () => {
    const replay = replayPaperMakerAtEventTime({
      side: 'UP', requestedCount: 2, queueClearFraction: 0, simulation: simulation(),
      prints: [
        trade({ id: 'early', at: at(3_000), count: 3, yesPrice: 0.40 }),
        trade({ id: 'late', at: at(5_000), count: 4, yesPrice: 0.42 }),
        trade({ id: 'after-horizon-micro', at: '1970-01-01T00:00:12.000001Z', count: 100, yesPrice: 0.42 }),
        trade({ id: 'after-horizon', at: at(12_001), count: 100, yesPrice: 0.42 }),
      ],
    });
    expect(replay).toEqual({ filledCount: 2, purchaseCents: 82, averagePrice: 0.41, consumingPrints: 2 });
  });

  it('admits the exact horizon boundary, deduplicates prints, and rejects the wrong aggressor', () => {
    const boundary = trade({ id: 'boundary', at: at(12_000), count: 4, yesPrice: 0.42 });
    expect(replayPaperMakerAtEventTime({
      side: 'UP', requestedCount: 1, queueClearFraction: 0, simulation: simulation(),
      prints: [boundary, boundary, trade({ id: 'wrong', at: at(11_000), count: 100, takerSide: 'yes' })],
    })).toMatchObject({ filledCount: 1, purchaseCents: 42, consumingPrints: 1 });
  });
});

describe('paper timing observer', () => {
  beforeEach(() => resetPaperExecutionTimingObserverForTests());

  it('uses the frozen 400ms create and 250ms acknowledgement schedule', async () => {
    let now = 0;
    const requested: number[] = [];
    const decisions: PaperExecutionTimingDecision[] = [];
    const acceptances: unknown[] = [];
    const quotes = [{ bid: 0.40, ask: 0.45 }, { bid: 0.39, ask: 0.40 }];
    const observedOrder = order();
    const before = structuredClone(observedOrder);
    await observePaperAcceptanceTiming(observedOrder, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      quote: async () => { requested.push(now); return quotes.shift()!; },
      recordDecision: async (value) => { decisions.push(value); },
      recordAcceptance: async (_id, value) => { acceptances.push(value); },
    });
    expect(requested).toEqual([400, 650]);
    expect(decisions).toHaveLength(1);
    expect(acceptances).toEqual([expect.objectContaining({ status: 'post_only_race' })]);
    expect(observedOrder).toEqual(before);
  });

  it('caps optional requests at six intents and records overflow as unavailable', async () => {
    const decisions: PaperExecutionTimingDecision[] = [];
    const acceptances: Array<{ status: string }> = [];
    const grace: Array<{ status: string }> = [];
    let quoteRequests = 0;
    const { startPaperExecutionTimingObservers } = await import('./paper-execution-timing-observer');
    startPaperExecutionTimingObservers(Array.from({ length: 7 }, (_, index) => order({
      id: `paper:timing:${index}`,
      executionMirrorPair: { version: 'entry-execution-mirror-pair-v1', id: `pair:timing:${index}` },
    })), {
      now: () => 0, wait: async () => undefined,
      quote: async () => { quoteRequests += 1; return { bid: 0.40, ask: 0.45 }; },
      recordDecision: async (value) => { decisions.push(value); },
      recordAcceptance: async (_id, value) => { acceptances.push(value); },
      recordGrace: async (_id, value) => { grace.push(value); },
    });
    await vi.waitFor(() => expect(decisions).toHaveLength(7));
    await vi.waitFor(() => expect(acceptances).toHaveLength(7));
    expect(quoteRequests).toBe(12);
    expect(acceptances.filter((value) => value.status === 'unavailable')).toHaveLength(1);
    expect(grace).toEqual([expect.objectContaining({ status: 'unavailable' })]);
  });

  it('waits beyond classification but excludes post-horizon prints by event time', async () => {
    let now = 12_000;
    const grace: unknown[] = [];
    // The normal starter owns assignment; invoke it with injected no-I/O dependencies and let its
    // acceptance task finish before testing the independent grace completion.
    const { startPaperExecutionTimingObservers } = await import('./paper-execution-timing-observer');
    startPaperExecutionTimingObservers([order()], {
      now: () => now, wait: async (milliseconds) => { now += milliseconds; },
      quote: async () => ({ bid: 0.40, ask: 0.45 }),
      // Keep the detached acceptance task parked after synchronous assignment so it cannot move this
      // test clock while the independent grace observer runs.
      recordDecision: () => new Promise(() => undefined), recordAcceptance: async () => undefined,
    });
    await observePaperFinalEvidenceGrace(order(), simulation(), {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      tradesSince: async () => [
        trade({ id: 'inside', at: at(11_900), count: 4, yesPrice: 0.42 }),
        trade({ id: 'outside-micro', at: '1970-01-01T00:00:12.000001Z', count: 100, yesPrice: 0.42 }),
        trade({ id: 'outside', at: at(12_100), count: 100, yesPrice: 0.42 }),
      ],
      recordGrace: async (_id, value) => { grace.push(value); },
    });
    expect(now).toBe(15_000);
    expect(grace).toEqual([expect.objectContaining({
      status: 'available', retainedPrints: [expect.objectContaining({ id: 'inside' })],
      eventTimeReplay: expect.objectContaining({ filledCount: 1 }),
    })]);
  });
});

describe('paper timing append-only store', () => {
  let directory = '';
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'paper-timing-'));
    process.env.MONEY_NOODLE_PAPER_EXECUTION_TIMING_PATH = directory;
    resetPaperExecutionTimingShadowStoreForTests();
  });
  afterEach(async () => {
    delete process.env.MONEY_NOODLE_PAPER_EXECUTION_TIMING_PATH;
    resetPaperExecutionTimingShadowStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it('appends one decision and idempotent acceptance/grace patches, then reloads them', async () => {
    const value = decision();
    await recordPaperExecutionTimingDecision(value);
    await recordPaperExecutionTimingDecision(value);
    await recordPaperAcceptanceTimingResult(value.id, {
      status: 'accepted', completedAt: at(650),
      createQuote: { requestedAt: at(400), observedAt: at(410), selectedBid: 0.40, selectedAsk: 0.45, limitPrice: 0.40 },
      acknowledgementQuote: { requestedAt: at(650), observedAt: at(660), selectedBid: 0.40, selectedAsk: 0.45, limitPrice: 0.40 },
    });
    await recordPaperExecutionGraceResult(value.id, {
      status: 'available', completedAt: at(15_000), production: {
        filledCount: 0, purchaseCents: 0, averagePrice: 0, consumingPrints: 0,
      }, eventTimeReplay: { filledCount: 1, purchaseCents: 42, averagePrice: 0.42, consumingPrints: 1 },
    });
    resetPaperExecutionTimingShadowStoreForTests();
    const store = await getPaperExecutionTimingShadows();
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      decision: { id: value.id }, acceptance: { status: 'accepted' },
      grace: { status: 'available', eventTimeReplay: { filledCount: 1 } },
    });
    const journal = await readFile(path.join(directory, 'paper-execution-timing-shadows.journal.jsonl'), 'utf8');
    expect(journal.trim().split('\n')).toHaveLength(3);
  });
});
