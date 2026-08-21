import { describe, expect, it } from 'vitest';
import {
  buildQuoteTrajectorySpreadObservation, cloneQuoteTrajectorySpreadObservation, quoteTrajectoryForDecision,
  QUOTE_TRAJECTORY_SPREAD_VERSION, TRAJECTORY_WINDOW_SECONDS,
  type QuotePathSample, type UnderlyingPathSample,
} from './quote-trajectory-spread';

const calculationAtMs = Date.parse('2026-08-20T04:10:00Z');
const closesAt = '2026-08-20T04:15:00Z';
const offsets = [-45_000, -30_000, -15_000, 0];

function underlying(prices = [100, 101, 102, 103], customOffsets = offsets): UnderlyingPathSample[] {
  return customOffsets.map((offset, index) => ({ sourceObservedAt: calculationAtMs + offset, price: prices[index] }));
}

function quotes(input: {
  bids?: number[];
  asks?: number[];
  side?: 'UP' | 'DOWN';
  customOffsets?: number[];
} = {}): QuotePathSample[] {
  const bids = input.bids ?? [0.40, 0.41, 0.42, 0.43];
  const asks = input.asks ?? [0.42, 0.43, 0.44, 0.45];
  const side = input.side ?? 'UP';
  return (input.customOffsets ?? offsets).map((offset, index) => ({
    providerId: 'kalshi', symbol: 'BTC', contractId: 'KXBTC', closesAt,
    sourceObservedAt: calculationAtMs + offset,
    bidUp: side === 'UP' ? bids[index] : 0.49,
    askUp: side === 'UP' ? asks[index] : 0.51,
    bidDown: side === 'DOWN' ? bids[index] : 0.49,
    askDown: side === 'DOWN' ? asks[index] : 0.51,
  }));
}

function observation(input: {
  side?: 'UP' | 'DOWN';
  underlyingSamples?: UnderlyingPathSample[];
  quoteSamples?: QuotePathSample[];
} = {}) {
  return buildQuoteTrajectorySpreadObservation({
    calculationAtMs, symbol: 'BTC', providerId: 'kalshi', contractId: 'KXBTC',
    side: input.side ?? 'UP', closesAt,
    underlyingSamples: input.underlyingSamples ?? underlying(),
    quoteSamples: input.quoteSamples ?? quotes({ side: input.side }),
  });
}

describe('quote trajectory and spread observation', () => {
  it('retains signed monotone underlying and selected-side movement on both horizons', () => {
    const result = observation();
    expect(result.underlying.trailing60Seconds).toMatchObject({
      observationCount: 4, coverageSeconds: 45, netChangePercent: 3,
      signedTrendEfficiency: 1,
    });
    expect(result.quote.trailing60Seconds).toMatchObject({
      observationCount: 4, coverageSeconds: 45,
      midpointSignedTrendEfficiency: 1, spreadSignedEfficiency: null,
    });
    expect(result.quote.trailing60Seconds?.midpointChangeCents).toBeCloseTo(3, 12);
    expect(result.quote.trailing60Seconds?.spreadChangeCents).toBeCloseTo(0, 12);
    expect(result.underlying.cycleToDate).toEqual(result.underlying.trailing60Seconds);
    expect(result.quote.cycleToDate).toEqual(result.quote.trailing60Seconds);
  });

  it('computes the complete eight-window decision grid from exact source boundaries', () => {
    const customOffsets = Array.from({ length: 301 }, (_, index) => -600_000 + index * 2_000);
    const prices = customOffsets.map((_, index) => 100 + index * 0.01);
    const bids = customOffsets.map((_, index) => 0.18 + index * 0.001);
    const asks = customOffsets.map((_, index) => 0.20 + index * 0.001);
    const result = observation({
      underlyingSamples: underlying(prices, customOffsets),
      quoteSamples: quotes({ bids, asks, customOffsets }),
    });

    expect(result.version).toBe(QUOTE_TRAJECTORY_SPREAD_VERSION);
    expect(result.decisionWindows.windowCoverage).toBe(8);
    expect(result.decisionWindows.selectedSide).toBe('UP');
    expect(result.decisionWindows.issuedAt).toBe(new Date(calculationAtMs).toISOString());
    for (const windowSeconds of TRAJECTORY_WINDOW_SECONDS) {
      expect(result.decisionWindows.quoteAges[windowSeconds]).toBe(windowSeconds);
      expect(result.decisionWindows.venueMoves[windowSeconds]).toBeCloseTo(windowSeconds * 0.05, 12);
      expect(result.decisionWindows.underlyingMoves[windowSeconds]).toBeGreaterThan(0);
    }
  });

  it('does not relabel an ordinary 15-second reading as a two-second move', () => {
    const customOffsets = Array.from({ length: 41 }, (_, index) => -600_000 + index * 15_000);
    const prices = customOffsets.map((_, index) => 100 + index * 0.1);
    const bids = customOffsets.map((_, index) => 0.30 + index * 0.002);
    const asks = customOffsets.map((_, index) => 0.32 + index * 0.002);
    const grid = observation({
      underlyingSamples: underlying(prices, customOffsets),
      quoteSamples: quotes({ bids, asks, customOffsets }),
    }).decisionWindows;

    expect(grid.venueMoves[2]).toBeNull();
    expect(grid.underlyingMoves[2]).toBeNull();
    expect(grid.quoteAges[2]).toBeNull();
    expect(grid.windowCoverage).toBe(7);
    expect(grid.quoteAges[30]).toBe(30);
    expect(grid.venueMoves[600]).toBeCloseTo(8, 12);
  });

  it('records selected-side ask movement rather than midpoint movement', () => {
    const result = observation({ quoteSamples: quotes({
      bids: [0.40, 0.40, 0.40, 0.40], asks: [0.42, 0.43, 0.44, 0.45],
    }) });
    expect(result.decisionWindows.venueMoves[30]).toBeCloseTo(2, 12);
  });

  it('uses the named side book rather than assuming DOWN is the complement of UP', () => {
    const result = observation({
      side: 'DOWN',
      quoteSamples: quotes({ side: 'DOWN', bids: [0.60, 0.59, 0.58, 0.57], asks: [0.63, 0.62, 0.61, 0.60] }),
    });
    expect(result.quote.trailing60Seconds?.midpointChangeCents).toBeCloseTo(-3, 12);
    expect(result.quote.trailing60Seconds?.midpointSignedTrendEfficiency).toBe(-1);
  });

  it('measures widening and narrowing independently of midpoint movement', () => {
    const widening = observation({ quoteSamples: quotes({
      bids: [0.49, 0.48, 0.47, 0.46], asks: [0.51, 0.52, 0.53, 0.54],
    }) });
    expect(widening.quote.trailing60Seconds).toMatchObject({
      midpointChangeCents: 0, midpointSignedTrendEfficiency: null,
      spreadChangeCents: 6, spreadSignedEfficiency: 1,
    });

    const narrowing = observation({ quoteSamples: quotes({
      bids: [0.46, 0.47, 0.48, 0.49], asks: [0.54, 0.53, 0.52, 0.51],
    }) });
    expect(narrowing.quote.trailing60Seconds?.spreadChangeCents).toBeCloseTo(-6, 12);
    expect(narrowing.quote.trailing60Seconds?.spreadSignedEfficiency).toBe(-1);
  });

  it('keeps a flat observed path distinct from unavailable evidence', () => {
    const flat = observation({
      underlyingSamples: underlying([100, 100, 100, 100]),
      quoteSamples: quotes({ bids: [0.49, 0.49, 0.49, 0.49], asks: [0.51, 0.51, 0.51, 0.51] }),
    });
    expect(flat.underlying.trailing60Seconds?.netChangePercent).toBe(0);
    expect(flat.underlying.trailing60Seconds?.signedTrendEfficiency).toBeNull();
    expect(flat.quote.trailing60Seconds?.midpointSignedTrendEfficiency).toBeNull();
    expect(flat.quote.trailing60Seconds?.spreadSignedEfficiency).toBeNull();

    const missing = observation({ underlyingSamples: [], quoteSamples: [] });
    expect(missing.underlying.trailing60Seconds).toBeUndefined();
    expect(missing.quote.trailing60Seconds).toBeUndefined();
    expect(missing.quote.trailing60SecondsUnavailableReason).toContain('No source-timestamped');
  });

  it('deduplicates identical source timestamps but rejects contradictory latest values', () => {
    const duplicate = observation({
      underlyingSamples: [...underlying(), underlying().at(-1)!],
      quoteSamples: [...quotes(), quotes().at(-1)!],
    });
    expect(duplicate.quote.trailing60Seconds?.observationCount).toBe(4);

    const contradictory = { ...quotes().at(-1)!, askUp: 0.50 };
    const invalid = observation({ quoteSamples: [...quotes(), contradictory] });
    expect(invalid.quote.trailing60Seconds).toBeUndefined();
    expect(invalid.quote.trailing60SecondsUnavailableReason).toContain('malformed or contradictory');
  });

  it('fails stale and future source observations closed', () => {
    const staleOffsets = [-61_000, -46_000, -31_000, -16_000];
    const stale = observation({
      underlyingSamples: underlying([100, 101, 102, 103], staleOffsets),
      quoteSamples: quotes({ customOffsets: staleOffsets }),
    });
    expect(stale.quote.trailing60SecondsUnavailableReason).toContain('stale');

    const futureOffsets = [-45_000, -30_000, -15_000, 1];
    const future = observation({
      underlyingSamples: underlying([100, 101, 102, 103], futureOffsets),
      quoteSamples: quotes({ customOffsets: futureOffsets }),
    });
    expect(future.underlying.trailing60SecondsUnavailableReason).toContain('future-dated');
    expect(future.quote.trailing60SecondsUnavailableReason).toContain('future-dated');
  });

  it('breaks at a source gap and requires four fresh observations over 45 seconds', () => {
    const gappedOffsets = [-90_000, -30_000, -15_000, 0];
    const result = observation({
      underlyingSamples: underlying([99, 100, 101, 102], gappedOffsets),
      quoteSamples: quotes({ customOffsets: gappedOffsets }),
    });
    expect(result.underlying.cycleToDate).toBeUndefined();
    expect(result.underlying.cycleToDateUnavailableReason).toContain('3/4');
    expect(result.quote.cycleToDate).toBeUndefined();
  });

  it('uses the named price tolerance and rejects crossed or non-finite current books', () => {
    const withinTolerance = quotes({ bids: [0.49, 0.49, 0.49, 0.5000000005], asks: [0.51, 0.51, 0.51, 0.50] });
    expect(observation({ quoteSamples: withinTolerance }).quote.trailing60Seconds).toBeDefined();

    const crossed = quotes();
    crossed[crossed.length - 1] = { ...crossed.at(-1)!, bidUp: 0.60, askUp: 0.50 };
    const crossedResult = observation({ quoteSamples: crossed });
    expect(crossedResult.quote.trailing60SecondsUnavailableReason).toContain('malformed');

    const beyondTolerance = quotes();
    beyondTolerance[beyondTolerance.length - 1] = { ...beyondTolerance.at(-1)!, bidUp: 0.5000000011, askUp: 0.50 };
    expect(observation({ quoteSamples: beyondTolerance }).quote.trailing60Seconds).toBeUndefined();

    const malformed = quotes();
    malformed[malformed.length - 1] = { ...malformed.at(-1)!, askUp: Number.NaN };
    expect(observation({ quoteSamples: malformed }).quote.trailing60Seconds).toBeUndefined();
  });

  it('clones immutable nested evidence and keeps the qualified-row payload bounded', () => {
    const original = observation();
    const cloned = cloneQuoteTrajectorySpreadObservation(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.quote).not.toBe(original.quote);
    expect(cloned.quote.trailing60Seconds).not.toBe(original.quote.trailing60Seconds);
    expect(cloned.version).toBe('quote-trajectory-spread-observation-v2');
    if (cloned.version !== 'quote-trajectory-spread-observation-v2') throw new Error('Expected v2 clone.');
    expect(cloned.decisionWindows).not.toBe(original.decisionWindows);
    expect(cloned.decisionWindows.venueMoves).not.toBe(original.decisionWindows.venueMoves);
    expect(JSON.stringify(original).length).toBeLessThan(5_000);
  });

  it('stamps only the exact v2 provider, contract, side, and window identity', () => {
    const original = observation();
    const identity = { providerId: 'kalshi' as const, contractId: 'KXBTC', side: 'UP' as const, closesAt };
    expect(quoteTrajectoryForDecision(original, identity)).toEqual(original);
    expect(quoteTrajectoryForDecision([
      observation({ side: 'DOWN', quoteSamples: quotes({ side: 'DOWN' }) }), original,
    ], identity)).toEqual(original);
    expect(quoteTrajectoryForDecision(original, { ...identity, side: 'DOWN' })).toBeUndefined();
    expect(quoteTrajectoryForDecision(original, { ...identity, contractId: 'OTHER' })).toBeUndefined();
    expect(quoteTrajectoryForDecision({ ...original, version: 'quote-trajectory-spread-observation-v1' }, identity)).toBeUndefined();
  });
});
