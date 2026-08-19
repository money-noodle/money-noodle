import { afterEach, describe, expect, it } from 'vitest';
import { bestEntry, hasTradableEdge, MIN_NET_EDGE, qualifiesAsBuyEdge, qualifiesVenueBuyEdge, venueEntryOptions, venueFeeRate, ENTRY_ADMISSION_FEE_ROLE } from './prediction-policy';
import type { MarketQuote, VenueQuote } from './types';

const market: MarketQuote = {
  probabilityUp: 0.5, probabilityDown: 0.5, liquidity: 1_000, volume: 1_000,
  bidUp: 0.49, askUp: 0.51, bidDown: 0.49, askDown: 0.51,
  url: 'https://example.com/market', closesAt: '2026-08-08T18:00:00Z', live: true,
};
const kalshi: VenueQuote = {
  venue: 'kalshi', probabilityUp: 0.5, bidUp: 0.49, askUp: 0.51, bidDown: 0.49, askDown: 0.51, liquidity: 1_000, volume: 1_000,
  url: 'https://example.com/kalshi', closesAt: '2026-08-08T18:00:00Z', ticker: 'TEST', live: true, comparability: 'approximate',
};
const candidate = (overrides: { modelProbabilityUp?: number; confidence?: number; market?: MarketQuote; kalshi?: VenueQuote; enabledTradingVenues?: Array<'polymarket' | 'kalshi'> } = {}) => ({
  modelProbabilityUp: overrides.modelProbabilityUp ?? 0.7,
  confidence: overrides.confidence ?? 0.6,
  market: overrides.market ?? market,
  kalshi: overrides.kalshi,
  enabledTradingVenues: overrides.enabledTradingVenues ?? ['polymarket', 'kalshi'] as Array<'polymarket' | 'kalshi'>,
});

describe('binary buy policy v13', () => {
  it('qualifies on expected value after fees rather than directional confidence', () => {
    // 70% belief bought at 51c clears the edge bar.
    expect(qualifiesAsBuyEdge(candidate())).toBe(true);
    // The same 70% belief bought at 90c is a losing trade and must be rejected.
    expect(qualifiesAsBuyEdge(candidate({ market: { ...market, askUp: 0.90 } }))).toBe(false);
    // A high directional likelihood is not sufficient on its own. At v20 the floor is -5pp, so the
    // price has to be far enough above the belief to fail even a gate that tolerates negative edge.
    expect(qualifiesAsBuyEdge(candidate({ modelProbabilityUp: 0.95, market: { ...market, askUp: 0.94 } }))).toBe(true);
    expect(qualifiesAsBuyEdge(candidate({ modelProbabilityUp: 0.80, market: { ...market, askUp: 0.90 } }))).toBe(false);
    // v13 restores the 55% floor after the prospective 52.5–55% v12 cohort lost when filled live.
    expect(qualifiesAsBuyEdge(candidate({ modelProbabilityUp: 0.55, market: { ...market, askUp: 0.42 } }))).toBe(true);
    expect(qualifiesAsBuyEdge(candidate({ modelProbabilityUp: 0.549, market: { ...market, askUp: 0.42 } }))).toBe(false);
  });

  it('rejects a cheap side when the independent model still calls that side an underdog', () => {
    const cheapDownUnderdog = candidate({
      modelProbabilityUp: 0.6,
      market: { ...market, askUp: 0.95, askDown: 0.20 },
    });
    expect(venueEntryOptions(cheapDownUnderdog)[0]).toMatchObject({ side: 'DOWN', probability: 0.4 });
    expect(bestEntry(cheapDownUnderdog)).toMatchObject({ side: 'UP', probability: 0.6 });
    expect(qualifiesAsBuyEdge(cheapDownUnderdog)).toBe(false);

    // DOWN entry is permitted by default since v16, so nothing needs enabling here; the underdog
    // rejection above is decided by the probability floor either way.
    const favoredDown = candidate({
      modelProbabilityUp: 0.4,
      market: { ...market, askUp: 0.95, askDown: 0.40 },
    });
    expect(bestEntry(favoredDown)).toMatchObject({ side: 'DOWN', probability: 0.6 });
    expect(qualifiesAsBuyEdge(favoredDown)).toBe(true);
  });

  it('subtracts venue fees before judging the edge', () => {
    expect(venueFeeRate('kalshi', 0.5, 'taker')).toBeCloseTo(0.0175, 6);
    expect(venueFeeRate('polymarket', 0.5, 'taker')).toBeCloseTo(0.005, 6);
    // Kalshi charges nothing on a resting fill, which is what production executes as. The gate still
    // uses immediate taker economics before adaptive execution chooses a placement style.
    expect(venueFeeRate('kalshi', 0.5, 'maker')).toBe(0);
    expect(ENTRY_ADMISSION_FEE_ROLE).toBe('taker');
    // Gross edge sits exactly at the bar, so the fee alone must push it below — the property under test,
    // stated relative to whatever the floor currently is rather than to a hardcoded 5pp.
    // Belief 60% priced so the gross edge lands exactly on the floor; the side floor still passes.
    const marginal = candidate({ modelProbabilityUp: 0.60, market: { ...market, askUp: 0.60 - MIN_NET_EDGE } });
    expect(bestEntry(marginal)!.netEdge).toBeLessThan(MIN_NET_EDGE);
    expect(hasTradableEdge(marginal)).toBe(false);
  });

  it('prefers the highest expected value, not simply the cheapest quote', () => {
    const cheapKalshi = { ...kalshi, askUp: 0.50 };
    const options = venueEntryOptions(candidate({ market: { ...market, askUp: 0.505 }, kalshi: cheapKalshi }));
    // Kalshi is cheaper but its fee is larger, so Polymarket wins on net edge.
    expect(options[0].venue).toBe('polymarket');
  });

  it('skips an out-of-range quote without hiding a valid lower-edge venue', () => {
    const mixed = candidate({ market: { ...market, askUp: 0.51 }, kalshi: { ...kalshi, askUp: 0.04 } });
    expect(bestEntry(mixed)).toMatchObject({ venue: 'polymarket', side: 'UP', price: 0.51 });
    expect(qualifiesAsBuyEdge(mixed)).toBe(true);
  });

  it('only considers venues enabled for trading', () => {
    const onlyKalshiCheap = candidate({ market: { ...market, askUp: 0.95 }, kalshi: { ...kalshi, askUp: 0.4 } });
    expect(qualifiesAsBuyEdge({ ...onlyKalshiCheap, enabledTradingVenues: ['polymarket'] })).toBe(false);
    expect(qualifiesAsBuyEdge({ ...onlyKalshiCheap, enabledTradingVenues: ['kalshi'] })).toBe(true);
  });

  it('does not let a Polymarket-only edge authorize a live Kalshi order', () => {
    // Kalshi must be dear enough to fail the v20 -5pp floor, not merely dearer than Polymarket.
    const mixed = candidate({ market: { ...market, askUp: 0.4 }, kalshi: { ...kalshi, askUp: 0.79 } });
    expect(qualifiesAsBuyEdge(mixed)).toBe(true);
    expect(qualifiesVenueBuyEdge(mixed, 'polymarket')).toBe(true);
    expect(qualifiesVenueBuyEdge(mixed, 'kalshi')).toBe(false);
  });

  // DOWN entry is permitted by default since v16; see down-entry-suspension.test.ts for the switch
  // itself. These cases assert side selection and pricing, which must hold whatever the switch says.
  afterEach(() => { delete process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY; });

  it('buys DOWN only from its own actionable ask and probability', () => {
    // Edge held inside the 35pp ceiling so this case tests side selection, not the edge bound.
    const bearish = candidate({ modelProbabilityUp: 0.35, market: { ...market, askUp: 0.7, askDown: 0.45 } });
    expect(bestEntry(bearish)).toMatchObject({ side: 'DOWN', price: 0.45 });
    expect(qualifiesAsBuyEdge(bearish)).toBe(true);
    expect(qualifiesVenueBuyEdge(bearish, 'polymarket', 'DOWN')).toBe(true);
    expect(qualifiesVenueBuyEdge(bearish, 'polymarket', 'UP')).toBe(false);
  });

  it('does not infer the DOWN ask from the UP ask', () => {
    const missingDown = candidate({ modelProbabilityUp: 0.2, market: { ...market, askUp: 0.7, askDown: undefined } });
    expect(qualifiesAsBuyEdge(missingDown)).toBe(false);
  });

  it('still requires a usable estimate and a real ask', () => {
    expect(qualifiesAsBuyEdge(candidate({ confidence: 0.2 }))).toBe(false);
    expect(qualifiesAsBuyEdge(candidate({ market: { ...market, askUp: undefined } }))).toBe(false);
    expect(qualifiesAsBuyEdge(candidate({ modelProbabilityUp: 0.99, market: { ...market, askUp: 0.98 } }))).toBe(false);
  });
});
