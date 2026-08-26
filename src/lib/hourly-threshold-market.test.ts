import { describe, expect, it } from 'vitest';
import {
  EXACT_HOURLY_DURATION_MS, hourlyThresholdProbability, selectCurrentHourlyThresholdGroup,
  type KalshiThresholdMarketRow,
} from './hourly-threshold-market';

const openAt = '2026-08-26T15:00:00.000Z';
const closesAt = '2026-08-26T16:00:00.000Z';
const now = Date.parse('2026-08-26T15:30:00.000Z');

function row(direction: 'ABOVE' | 'BELOW', patch: Partial<KalshiThresholdMarketRow> = {}): KalshiThresholdMarketRow {
  const above = direction === 'ABOVE';
  const strike = above ? 120 : 80;
  return {
    ticker: `KXBTC-TEST-T${strike}`, status: 'active', market_type: 'binary', open_time: openAt,
    close_time: closesAt, floor_strike: above ? strike : null, cap_strike: above ? null : strike,
    yes_bid_dollars: '0.0100', yes_ask_dollars: '0.0200', no_bid_dollars: '0.9800', no_ask_dollars: '0.9900',
    rules_primary: `If the settlement average is ${above ? 'above' : 'below'} ${strike}, the market resolves Yes.`,
    rules_secondary: 'The final sixty prices use a simple average.',
    ...patch,
  };
}

describe('hourly threshold normalization', () => {
  it('forms one exact-duration group while retaining two independent YES contracts', () => {
    const selected = selectCurrentHourlyThresholdGroup([row('ABOVE'), row('BELOW')], now);
    expect(Date.parse(selected.closesAt!) - Date.parse(selected.openAt!)).toBe(EXACT_HOURLY_DURATION_MS);
    expect(selected.complete).toBe(true);
    expect(selected.candidates).toEqual([
      expect.objectContaining({ direction: 'ABOVE', displaySide: 'UP', ticker: 'KXBTC-TEST-T120', strike: 120, yesAsk: 0.02 }),
      expect.objectContaining({ direction: 'BELOW', displaySide: 'DOWN', ticker: 'KXBTC-TEST-T80', strike: 80, yesAsk: 0.02 }),
    ]);
  });

  it('never substitutes a longer-duration threshold pair from the same series', () => {
    const longClose = new Date(Date.parse(openAt) + 25 * 3_600_000).toISOString();
    const selected = selectCurrentHourlyThresholdGroup([
      row('ABOVE', { close_time: longClose }), row('BELOW', { close_time: longClose }),
    ], now);
    expect(selected).toMatchObject({ complete: false, candidates: [], unavailableReason: expect.stringContaining('exact one-hour') });
  });

  it('fails an ambiguous direction closed while preserving the unambiguous sibling as research evidence', () => {
    const selected = selectCurrentHourlyThresholdGroup([
      row('ABOVE'), row('ABOVE', { ticker: 'KXBTC-OTHER-T121', floor_strike: 121, rules_primary: 'Above 121.' }), row('BELOW'),
    ], now);
    expect(selected.complete).toBe(false);
    expect(selected.candidates.map((candidate) => candidate.direction)).toEqual(['BELOW']);
    expect(selected.unavailableReason).toContain('ABOVE contract ambiguous');
  });

  it('treats a serialized zero ask as unavailable rather than a free contract', () => {
    const selected = selectCurrentHourlyThresholdGroup([
      row('ABOVE', { yes_ask_dollars: '0.0000' }), row('BELOW'),
    ], now);
    expect(selected.candidates.find((item) => item.direction === 'ABOVE')?.yesAsk).toBeUndefined();
    expect(selected.candidates.find((item) => item.direction === 'ABOVE')?.yesBid).toBe(0.01);
  });

  it('does not infer direction from ticker, row order, or a complementary book', () => {
    const selected = selectCurrentHourlyThresholdGroup([
      row('ABOVE', { floor_strike: null, cap_strike: null }),
      row('BELOW', { rules_primary: 'This wording does not state the relation.' }),
    ], now);
    expect(selected.candidates).toEqual([]);
    expect(selected.complete).toBe(false);
  });
});

describe('hourly threshold probability', () => {
  it('prices each strike independently rather than making the pair complementary', () => {
    const common = { currentPrice: 100, secondsRemaining: 1_800, volatilityPerSecond: 0.0002 };
    const above = hourlyThresholdProbability({ ...common, direction: 'ABOVE', strike: 120 });
    const below = hourlyThresholdProbability({ ...common, direction: 'BELOW', strike: 80 });
    expect(above).toBeLessThan(0.001);
    expect(below).toBeLessThan(0.001);
    expect(above! + below!).toBeLessThan(0.001);
  });

  it('returns equal halves at either contract own strike and rejects malformed money/model inputs', () => {
    expect(hourlyThresholdProbability({ direction: 'ABOVE', strike: 100, currentPrice: 100, secondsRemaining: 1_800, volatilityPerSecond: 0.001 })).toBeCloseTo(0.5, 7);
    expect(hourlyThresholdProbability({ direction: 'BELOW', strike: 100, currentPrice: 100, secondsRemaining: 1_800, volatilityPerSecond: 0.001 })).toBeCloseTo(0.5, 7);
    expect(hourlyThresholdProbability({ direction: 'ABOVE', strike: Number.NaN, currentPrice: 100, secondsRemaining: 1_800, volatilityPerSecond: 0.001 })).toBeUndefined();
  });
});
