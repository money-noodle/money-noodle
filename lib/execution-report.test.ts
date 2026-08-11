import { describe, expect, it } from 'vitest';
import { buildMakerFillReport, buildTradeRecord } from './execution-report';
import type { PaperOrder, TrackedForecast } from './types';

function order(probability: number, filledCount: number, patch: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: crypto.randomUUID(), executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: 'TEST', side: 'UP',
    status: filledCount ? 'open' : 'unfilled', venueOrderId: crypto.randomUUID(), filledCount,
    createdAt: '2026-01-01T00:01:00Z', calculationAt: '2026-01-01T00:01:00Z', closesAt: '2026-01-01T00:15:00Z',
    modelProbabilityUp: 0.7, confidence: 0.7, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
    quantity: 0.2, stakeCents: 9, feeCents: 1, potentialPayoutCents: 20,
    makerFillEstimate: { probability, horizonSeconds: 4.5, quoteDistance: 0.01, quoteVolatilityPerSecond: 0.01, samples: 5, model: 'quote-first-passage-v1' },
    ...patch,
  };
}

function outcome(symbol: string, closesAt: string, result: 'UP' | 'DOWN'): TrackedForecast {
  return {
    id: `${symbol}:${closesAt}`, symbol, marketUrl: `https://example.com/${symbol}`, issuedAt: '2026-01-01T00:10:00Z', closesAt,
    direction: 'UP', probabilityUp: 0.7, directionalLikelihood: 0.7, confidence: 0.7,
    modelVersion: 'production', policyVersion: 'v9', polymarketProbabilityUp: 0.5, factors: [],
    status: 'resolved', outcome: result, correct: result === 'UP',
  };
}

describe('maker first-passage validation report', () => {
  it('compares observation-only estimates with nonzero authoritative fills', () => {
    const report = buildMakerFillReport([order(0.2, 0), order(0.6, 0.2), order(0.8, 0)]);
    expect(report.attempts).toBe(3);
    expect(report.fills).toBe(1);
    expect(report.meanPredictedProbability).toBeCloseTo(0.5333, 3);
    expect(report.observedFillRate).toBeCloseTo(1 / 3);
    expect(report.buckets).toHaveLength(3);
  });

  it('separates submission, acceptance, queue fill, and adverse-selection outcomes', () => {
    const close = '2026-01-01T00:15:00Z';
    const race = order(0.8, 0, { symbol: 'SOL', venueOrderId: undefined, noFillReason: 'post_only_race', reason: 'Post-only acknowledgement race.' });
    const noFill = order(0.7, 0, { symbol: 'BNB', noFillReason: 'rested_no_fill' });
    const complete = order(0.7, 0.2, { symbol: 'BTC', status: 'won', outcome: 'UP', requestedQuantity: 0.2, actualStakeCents: 9, actualPnlCents: 11 });
    const partial = order(0.7, 0.1, { symbol: 'ETH', status: 'lost', outcome: 'DOWN', requestedQuantity: 0.2, actualStakeCents: 5, actualPnlCents: -5 });
    const report = buildMakerFillReport([race, noFill, complete, partial], [outcome('BNB', close, 'DOWN')]);
    expect(report).toMatchObject({
      submittedAttempts: 4, postOnlyRaces: 1, acceptedAttempts: 3, restedNoFillAttempts: 1,
      partialFills: 1, completeFills: 1, resolvedFilledAttempts: 2, resolvedAcceptedNoFillAttempts: 1,
      filledWinRate: 0.5, acceptedNoFillCounterfactualWinRate: 0, adverseSelectionWinRateGap: 0.5,
      pairedAdverseSelectionWindows: 1, pairedWinRateGap: 0.5, pairedWinRateGapStandardError: null,
    });
    expect(report.fillRateGivenAcceptance).toBeCloseTo(2 / 3);
    expect(report.segments.some((segment) => segment.dimension === 'Attempt')).toBe(true);
  });

  it('reports shadow taker recommendations without blending them into actual taker fills', () => {
    const shadow = order(0.5, 0, {
      symbol: 'BNB', shadowTakerAllInCents: 9, shadowTakerQuantity: 0.2,
      entryExecutionDecision: {
        policyVersion: 'maker-taker-adaptive-shadow-v1', configuredMode: 'maker', executedStyle: 'maker', recommendedStyle: 'taker',
        reason: 'shadow', takerNetEdge: 0.18, medianNetEdge: 0.14, makerNetEdge: 0.2,
        makerExpectedCapturedEdge: 0.1, takerAdvantage: 0.08, makerCohort: '25-50c · 1-2c', makerSamples: 40, makerFillRate: 0.5,
      },
    });
    const report = buildMakerFillReport([shadow], [outcome('BNB', shadow.closesAt, 'UP')]);
    expect(report.adaptiveExecution).toMatchObject({ shadowEvaluations: 1, takerRecommendations: 1, resolvedTakerRecommendations: 1, actualTakerOrders: 0 });
    expect(report.adaptiveExecution.meanTakerCounterfactualReturn).toBeCloseTo(11 / 9);
  });

  it('scores DOWN fills against DOWN outcomes and side probability', () => {
    const down = order(0.5, 0.2, {
      side: 'DOWN', modelProbabilityUp: 0.2, status: 'won', outcome: 'DOWN',
      askPrice: 0.3, actualStakeCents: 7, actualPnlCents: 13,
    });
    const record = buildTradeRecord([down], 'live');
    expect(record.winRate).toBe(1);
    expect(record.meanPredictedEdge).toBeGreaterThan(0.4);
    expect(record.segments.find((group) => group.dimension === 'Direction')?.segments[0].label).toBe('DOWN');
    expect(buildMakerFillReport([down]).filledWinRate).toBe(1);
  });

  it('labels low and high entry-price tails accurately', () => {
    const cheap = order(0.5, 0.2, { status: 'won', askPrice: 0.08, actualStakeCents: 3, actualPnlCents: 17 });
    const expensive = order(0.5, 0.2, { status: 'lost', askPrice: 0.80, actualStakeCents: 17, actualPnlCents: -17, closesAt: '2026-01-01T00:30:00Z' });
    const labels = buildTradeRecord([cheap, expensive], 'live').segments
      .find((group) => group.dimension === 'Entry price')?.segments.map((segment) => segment.label);
    expect(labels).toEqual(expect.arrayContaining(['<10¢', '75¢+']));
  });

  it('reports switch-versus-hold counterfactuals separately from ordinary P&L', () => {
    const switched = order(0.5, 0.2, { status: 'sold', payoutCents: 8, actualStakeCents: 9, actualPnlCents: -1, switchVsHoldCents: 3, counterfactualHoldPnlCents: -4, counterfactualSwitchPnlCents: -1 });
    const record = buildTradeRecord([switched], 'live');
    expect(record.switchesEvaluated).toBe(1);
    expect(record.meanSwitchVsHoldCents).toBe(3);
    expect(record.realizedPnlCents).toBe(-1);
  });

  it('excludes rejected requests and legacy attempts without a model estimate', () => {
    const rejected = order(0.5, 0, { status: 'rejected', venueOrderId: undefined });
    const legacy = order(0.5, 0, { makerFillEstimate: undefined });
    expect(buildMakerFillReport([rejected, legacy]).attempts).toBe(0);
  });
});
