import { describe, expect, it } from 'vitest';
import { latestOpenOrderVenueQuote } from './open-order-quote';

describe('latest open-order venue quote', () => {
  it('shows the newest owned-side quote across execution and position observations', () => {
    expect(latestOpenOrderVenueQuote({
      entryExecutionObservations: [
        { at: '2026-08-20T12:00:00.000Z', event: 'create_quote', selectedBid: 0.39, selectedAsk: 0.40 },
        { at: '2026-08-20T12:00:02.000Z', event: 'management_quote', selectedBid: 0.40, selectedAsk: 0.41 },
      ],
      positionObservations: [
        {
          at: '2026-08-20T12:00:15.000Z', selectedBid: 0.44, selectedAsk: 0.45, spread: 0.01,
          netLiquidationCents: 43, exitFeeCents: 1, exactCostCents: 40, unrealizedPnlCents: 3,
          unrealizedReturn: 0.075, ownedSideProbability: 0.6, confidence: 0.7, secondsRemaining: 300,
        },
      ],
    })).toEqual({ bid: 0.44, ask: 0.45, observedAt: '2026-08-20T12:00:15.000Z', source: 'position' });
  });

  it('uses a managed-order quote before a position observation exists', () => {
    expect(latestOpenOrderVenueQuote({
      entryExecutionObservations: [
        { at: '2026-08-20T12:00:02.000Z', event: 'management_quote', selectedBid: 0.40, selectedAsk: 0.41 },
      ],
    })).toMatchObject({ bid: 0.40, ask: 0.41, source: 'execution' });
  });

  it('fails closed on malformed, crossed, or out-of-range prices', () => {
    expect(latestOpenOrderVenueQuote({
      entryExecutionObservations: [
        { at: 'invalid', event: 'create_quote', selectedBid: 0.4, selectedAsk: 0.41 },
        { at: '2026-08-20T12:00:00.000Z', event: 'create_quote', selectedBid: 0.42, selectedAsk: 0.41 },
        { at: '2026-08-20T12:00:01.000Z', event: 'create_quote', selectedBid: Number.NaN, selectedAsk: 0.41 },
      ],
    })).toBeUndefined();
  });
});
