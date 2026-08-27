import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_FILLABLE_ASK, applyMakerMissTakerReserve, applyTakerQuoteMovementReserve, boundedTakerFreshQuoteRefusal, estimatePaperFill, evaluateEntryEpisodePersistence, groupedRecentOrders, venueFeeCents } from './paper-execution';
import type { PaperOrder, Prediction } from './types';
import type { SignalPersistenceState } from './signal-persistence';
import { MAX_ENTRY_PRICE, MIN_ENTRY_PRICE, MIN_NET_EDGE, bestEntry, venueFeeRate, ENTRY_ADMISSION_FEE_ROLE } from './prediction-policy';

const liveAttempt = (patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: 'live:XRP:close', logicalOrderId: 'live:XRP:close', attemptNumber: 1, executionMode: 'live',
  clientOrderId: 'live:XRP:close', symbol: 'XRP', venue: 'kalshi', contractId: 'TEST', side: 'UP', status: 'unfilled',
  createdAt: '2026-01-01T00:00:00Z', calculationAt: '2026-01-01T00:00:00Z', closesAt: '2026-01-01T00:15:00Z',
  modelProbabilityUp: 0.7, confidence: 0.7, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
  quantity: 0.2, stakeCents: 9, feeCents: 1, potentialPayoutCents: 20, ...patch,
});

describe('paper execution fills', () => {
  it('keeps Polymarket whole but sizes Kalshi in 0.01-contract increments', () => {
    expect(estimatePaperFill(100, 0.50, 'polymarket')).toEqual({
      quantity: 1, limitPriceCents: 50, purchaseCents: 50, feeCents: 1, stakeCents: 51, potentialPayoutCents: 100,
    });
    expect(estimatePaperFill(100, 0.50, 'kalshi')).toEqual({
      quantity: 1.92, limitPriceCents: 50, purchaseCents: 96, feeCents: 4, stakeCents: 100, potentialPayoutCents: 192,
    });
  });

  it('preserves Kalshi sub-cent price increments while reserving whole cents', () => {
    // Tapered crypto books trade in 0.1c increments. Submit 5.4c, but reserve 6c of principal.
    const plan = estimatePaperFill(10, 0.054, 'kalshi')!;
    expect(plan.limitPriceCents).toBeCloseTo(5.4);
    expect(plan.quantity).toBe(1.66);
    expect(plan.purchaseCents).toBe(9);
    expect(plan.stakeCents).toBe(plan.purchaseCents + plan.feeCents);
    expect(plan.stakeCents).toBeLessThanOrEqual(10);
  });

  it('spends the cap on as many contracts as fees allow', () => {
    const plan = estimatePaperFill(100, 0.10, 'kalshi')!;
    expect(plan.quantity).toBeGreaterThan(1);
    expect(plan.stakeCents).toBeLessThanOrEqual(100);
    // One more contract would breach the cap once its actual venue fee is added.
    const nextQuantity = Number((plan.quantity + 0.01).toFixed(2));
    const nextTotal = Math.ceil(nextQuantity * plan.limitPriceCents) + venueFeeCents('kalshi', plan.limitPriceCents, nextQuantity, 'taker');
    expect(nextTotal).toBeGreaterThan(100);
  });

  it('uses fractional Kalshi quantity when a whole contract does not fit', () => {
    expect(estimatePaperFill(25, 0.50, 'kalshi')?.quantity).toBe(0.48);
    expect(estimatePaperFill(4, MIN_ENTRY_PRICE, 'kalshi')?.quantity).toBe(0.3);
    expect(estimatePaperFill(10, 0.35, 'kalshi')).toMatchObject({ quantity: 0.25, stakeCents: 10 });
    expect(estimatePaperFill(9, 0.28, 'kalshi')).toMatchObject({ quantity: 0.28, stakeCents: 9 });
    expect(estimatePaperFill(1, 0.50, 'kalshi')).toBeNull();
    expect(estimatePaperFill(100, 0, 'polymarket')).toBeNull();
  });

  it('resets episode qualification at maker completion without requiring a nonqualifying gap', () => {
    const state: SignalPersistenceState = {
      symbol: 'BTC', side: 'UP', closesAt: '2026-01-01T00:15:00Z',
      observations: [
        { at: '2026-01-01T00:01:45Z', netEdge: 0.08, quality: 0.7 },
        { at: '2026-01-01T00:02:00Z', netEdge: 0.08, quality: 0.7 },
        { at: '2026-01-01T00:02:15Z', netEdge: 0.08, quality: 0.7 },
        { at: '2026-01-01T00:02:30Z', netEdge: 0.08, quality: 0.7 },
      ],
    };
    expect(evaluateEntryEpisodePersistence({ ...state, observations: state.observations.slice(0, 2) }, Date.parse('2026-01-01T00:02:00Z'), '2026-01-01T00:02:00Z'))
      .toMatchObject({ eligible: false, qualifyingSnapshots: 0 });
    expect(evaluateEntryEpisodePersistence({ ...state, observations: state.observations.slice(0, 3) }, Date.parse('2026-01-01T00:02:15Z'), '2026-01-01T00:02:00Z'))
      .toMatchObject({ eligible: false, qualifyingSnapshots: 1 });
    expect(evaluateEntryEpisodePersistence(state, Date.parse('2026-01-01T00:02:30Z'), '2026-01-01T00:02:00Z'))
      .toMatchObject({ eligible: true, qualifyingSnapshots: 2 });
  });

  it('stamps reduce-only sizing before fill estimation and reuses its cap for taker reserve', () => {
    const source = readFileSync(new URL('./paper-execution.ts', import.meta.url), 'utf8');
    expect(source).toContain('evaluateEntrySizing(stakeLimitCents, entry.netEdge)');
    expect(source).toContain('entrySizingDecision: { ...selected.sizing }');
    expect(source).toContain('built.order.entrySizingDecision?.stakeLimitCents ?? liveStakeCeiling');
  });

  it('routes every live and paper adaptive continuation through the terminal-refusal guard', () => {
    const source = readFileSync(new URL('./paper-execution.ts', import.meta.url), 'utf8');
    // Import plus one paper call and one live call. A missing lane reintroduces maker execution after refusal.
    expect(source.match(/terminalizeRefusedAdaptiveContinuation/g)).toHaveLength(3);
    expect(source).toContain('if (!continued && !built.order.fallbackSequenceEndedAt)');
  });

  it('re-runs the production venue rule for a bounded treatment without inheriting the strict 2c route gate', () => {
    const prediction = {
      modelProbabilityUp: 0.70, confidence: 0.70, enabledTradingVenues: ['kalshi'],
      market: { live: false },
      kalshi: { live: true, ticker: 'TEST', closesAt: '2026-01-01T00:15:00Z', askUp: 0.50, bidUp: 0.48, askDown: 0.52, bidDown: 0.50 },
    } as Prediction;
    expect(boundedTakerFreshQuoteRefusal(prediction, 'UP', { bid: 0.47, ask: 0.50, spread: 0.03 })).toBeUndefined();
    expect(boundedTakerFreshQuoteRefusal(prediction, 'UP', { bid: 0.64, ask: 0.70, spread: 0.06 })).toContain('production venue buy rule');
    expect(boundedTakerFreshQuoteRefusal(prediction, 'UP', { bid: 0.65, ask: 0.751, spread: 0.101 })).toContain('production ceiling');
  });

  it('sizes taker quantity and fees against the one-cent worst-case cap', () => {
    const taker = liveAttempt({ askPrice: 0.28, issuanceAskPrice: 0.28, approvedMaximumPrice: 0.28 });
    expect(applyTakerQuoteMovementReserve(taker, 100)).toBeUndefined();
    const worstCase = estimatePaperFill(100, 0.29, 'kalshi')!;
    expect(taker.approvedMaximumPrice).toBeCloseTo(0.29, 12);
    expect(taker).toMatchObject({
      quantity: worstCase.quantity, requestedQuantity: worstCase.quantity, stakeCents: worstCase.stakeCents,
      feeCents: worstCase.feeCents, potentialPayoutCents: worstCase.potentialPayoutCents,
    });
    expect(taker.stakeCents).toBeLessThanOrEqual(100);
  });

  it('reserves fallback quantity at the 25% ceiling without targeting that ceiling on wire', () => {
    const maker = liveAttempt({
      initialSubmittedPrice: 0.39,
      entryExecutionObservations: [{ at: '2026-01-01T00:00:12Z', event: 'cancel_confirmed', limitPrice: 0.40 }],
    });
    const taker = liveAttempt({ id: 'live:XRP:close:episode:2', attemptNumber: 2 });
    expect(applyMakerMissTakerReserve(taker, 100, maker)).toBeUndefined();
    const worstCase = estimatePaperFill(100, 0.50, 'kalshi')!;
    expect(taker.approvedMaximumPrice).toBeCloseTo(0.50);
    expect(taker).toMatchObject({
      quantity: worstCase.quantity, stakeCents: worstCase.stakeCents, feeCents: worstCase.feeCents,
    });
    expect(taker.stakeCents).toBeLessThanOrEqual(100);
  });

  it('groups maker retries by logical intent and marks a recovered fill', () => {
    const first = liveAttempt({ noFillReason: 'post_only_race' });
    const retry = liveAttempt({
      id: 'live:XRP:close:retry:2', attemptNumber: 2, status: 'open', filledCount: 0.2,
      createdAt: '2026-01-01T00:01:00Z', noFillReason: undefined,
    });
    const grouped = groupedRecentOrders([first, retry]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ id: retry.id, recoveredAfterRetry: true });
    expect(grouped[0].attemptHistory?.map((attempt) => [attempt.attemptNumber, attempt.noFillReason, attempt.status])).toEqual([
      [1, 'post_only_race', 'unfilled'], [2, undefined, 'open'],
    ]);
  });

  it('infers historical no-submission, rested, and post-only classifications without rewriting them', () => {
    const crossed = liveAttempt({ reason: 'Post-only price crossed after three quote refreshes.' });
    const rested = liveAttempt({ id: 'live:BNB:close', logicalOrderId: 'live:BNB:close', symbol: 'BNB', venueOrderId: 'venue' });
    const moved = liveAttempt({
      id: 'live:HYPE:close', logicalOrderId: 'live:HYPE:close', symbol: 'HYPE', noFillReason: 'ioc_no_fill',
      reason: 'Taker not submitted: current UP ask 29.0c exceeds approved 28.0c cap.',
    });
    const acceptedIoc = liveAttempt({
      id: 'live:ETH:close', logicalOrderId: 'live:ETH:close', symbol: 'ETH', venueOrderId: 'ioc',
      liquidityRole: 'taker', noFillReason: undefined,
    });
    expect(groupedRecentOrders([crossed, rested, moved, acceptedIoc]).map((order) => order.noFillReason))
      .toEqual(['post_only_race', 'rested_no_fill', 'pre_submit_quote_moved', 'ioc_no_fill']);
  });

  it('refuses fills at or above the $1 payout, which are a guaranteed loss', () => {
    expect(estimatePaperFill(200, MAX_FILLABLE_ASK, 'kalshi')).not.toBeNull();
    expect(estimatePaperFill(200, MAX_FILLABLE_ASK + 0.005, 'kalshi')).toBeNull();
    expect(estimatePaperFill(200, 1.0, 'kalshi')).toBeNull();
  });

  it('leaves expensive entries to the expected-value gate rather than a price ceiling', () => {
    const mostConfident = 0.97;
    const dearest = mostConfident - MIN_NET_EDGE - venueFeeRate('kalshi', 0.9, ENTRY_ADMISSION_FEE_ROLE);
    // **Still a live constraint at v22, for the opposite reason.** v20 made the ceiling bind by
    // dropping the floor to -5pp; v22 restores the +5pp floor but narrows the ceiling to 75c, and the
    // dearest price a 97% belief can clear (~91c) is still above it. Under SPEC 5.7 the price ceiling
    // therefore continues to refuse rows the expected-value gate would admit, and remains a control.
    expect(dearest).toBeGreaterThan(MAX_ENTRY_PRICE);
    expect(bestEntry({
      modelProbabilityUp: mostConfident, enabledTradingVenues: ['kalshi'],
      market: { live: false } as never,
      kalshi: { live: true, askUp: 0.98, askDown: 0.03 } as never,
    })).toBeUndefined();
  });
});
