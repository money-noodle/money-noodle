import { describe, expect, it } from 'vitest';
import {
  advanceValidKalshiPrice, backOffValidKalshiPrice, boundedTakerLimit, confirmKalshiCancellation, floorToValidKalshiPrice,
  kalshiExitOrderBody, kalshiMakerAmendOrderBody, kalshiMakerEntryOrderBody,
  kalshiOrderBookSide, kalshiTakerEntryOrderBody, selectedSidePriceFromYes,
  stableKalshiExchangeIndex, validateKalshiExchangeIndex, validateKalshiMarketWireIdentity,
  yesPriceFromSelectedSide,
} from './live-orders';

const tapered = [
  { start: '0.0000', end: '0.1000', step: '0.0010' },
  { start: '0.1000', end: '0.9000', step: '0.0100' },
  { start: '0.9000', end: '1.0000', step: '0.0010' },
];

describe('Kalshi tapered price quantization', () => {
  it('uses 0.1c ticks below 10c', () => {
    expect(floorToValidKalshiPrice(0.0999, tapered)).toBeCloseTo(0.099);
  });

  it('switches to 1c ticks above 10c', () => {
    expect(floorToValidKalshiPrice(0.1099, tapered)).toBeCloseTo(0.10);
    expect(floorToValidKalshiPrice(0.1199, tapered)).toBeCloseTo(0.11);
  });

  it('finds the valid passive level immediately below a boundary ask', () => {
    expect(floorToValidKalshiPrice(0.10 - 1e-8, tapered)).toBeCloseTo(0.099);
    expect(floorToValidKalshiPrice(0.11 - 1e-8, tapered)).toBeCloseTo(0.10);
  });

  it('returns to 0.1c ticks above 90c', () => {
    expect(floorToValidKalshiPrice(0.9099, tapered)).toBeCloseTo(0.909);
  });

  it('advances exact ticks for bounded taker cushions across tapered boundaries', () => {
    expect(advanceValidKalshiPrice(0.22, 2, tapered)).toBeCloseTo(0.24);
    expect(advanceValidKalshiPrice(0.099, 2, tapered)).toBeCloseTo(0.11);
    expect(advanceValidKalshiPrice(0.899, 2, tapered)).toBeCloseTo(0.901);
  });

  it('uses the fresh ask plus two ticks without targeting the structural ceiling', () => {
    expect(boundedTakerLimit({ ask: 0.45, maximumPrice: 0.50, cushionTicks: 2, ranges: tapered })).toEqual({ limit: 0.47, tickSize: 0.01 });
    expect(boundedTakerLimit({ ask: 0.49, maximumPrice: 0.50, cushionTicks: 2, ranges: tapered })).toEqual({ limit: 0.50, tickSize: 0.01 });
    expect(boundedTakerLimit({ ask: 0.51, maximumPrice: 0.50, cushionTicks: 2, ranges: tapered })?.limit).toBe(0.50);
    expect(boundedTakerLimit({ ask: 0.455, maximumPrice: 0.50, cushionTicks: 2, ranges: tapered })).toBeNull();
  });

  it('backs off exact ticks after post-only acknowledgement races', () => {
    expect(backOffValidKalshiPrice(0.22, 1, tapered)).toBeCloseTo(0.21);
    expect(backOffValidKalshiPrice(0.22, 2, tapered)).toBeCloseTo(0.20);
    expect(backOffValidKalshiPrice(0.10, 1, tapered)).toBeCloseTo(0.099);
    expect(backOffValidKalshiPrice(0.077, 2, tapered)).toBeCloseTo(0.075);
  });
});

describe('Kalshi binary side translation', () => {
  it('opens and closes signed YES/NO exposure on opposite book sides', () => {
    expect(kalshiOrderBookSide('UP', 'entry')).toBe('bid');
    expect(kalshiOrderBookSide('UP', 'exit')).toBe('ask');
    expect(kalshiOrderBookSide('DOWN', 'entry')).toBe('ask');
    expect(kalshiOrderBookSide('DOWN', 'exit')).toBe('bid');
  });

  it('keeps all-in accounting in the selected side price', () => {
    expect(yesPriceFromSelectedSide(0.23, 'UP')).toBeCloseTo(0.23);
    expect(yesPriceFromSelectedSide(0.23, 'DOWN')).toBeCloseTo(0.77);
    expect(selectedSidePriceFromYes(0.77, 'DOWN')).toBeCloseTo(0.23);
  });

  it('builds every entry, amend, and exit wire body with the exact nonzero exchange index', () => {
    const common = { ticker: 'UP', positionSide: 'UP' as const, selectedLimit: 0.23, count: 0.25, exchangeIndex: 2 };
    const up = kalshiTakerEntryOrderBody({ ...common, clientOrderId: 'up' });
    const down = kalshiTakerEntryOrderBody({ ...common, ticker: 'DOWN', positionSide: 'DOWN', clientOrderId: 'down' });
    const maker = kalshiMakerEntryOrderBody({ ...common, clientOrderId: 'maker' });
    const amend = kalshiMakerAmendOrderBody(common);
    const exit = kalshiExitOrderBody({ ...common, positionSide: 'DOWN', clientOrderId: 'exit' });
    expect(up).toMatchObject({ side: 'bid', price: '0.2300', time_in_force: 'immediate_or_cancel', post_only: false, reduce_only: false, exchange_index: 2 });
    expect(down).toMatchObject({ side: 'ask', price: '0.7700', time_in_force: 'immediate_or_cancel', post_only: false, reduce_only: false, exchange_index: 2 });
    expect(maker).toMatchObject({ side: 'bid', price: '0.2300', time_in_force: 'good_till_canceled', post_only: true, reduce_only: false, exchange_index: 2 });
    expect(amend).toEqual({ ticker: 'UP', side: 'bid', price: '0.2300', count: '0.25', exchange_index: 2 });
    expect(exit).toMatchObject({ side: 'bid', price: '0.7700', time_in_force: 'immediate_or_cancel', post_only: false, reduce_only: true, exchange_index: 2 });
  });
});

describe('Kalshi exchange-index target integrity', () => {
  it('accepts only an exact active ticker with a non-negative safe-integer index', () => {
    expect(validateKalshiMarketWireIdentity('KXBTC-TEST', {
      ticker: 'KXBTC-TEST', status: 'active', exchange_index: 2,
    })).toEqual({ ticker: 'KXBTC-TEST', exchangeIndex: 2 });
  });

  it.each([undefined, '2', 2.5, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed exchange index %s',
    (value) => expect(() => validateKalshiExchangeIndex(value)).toThrow('invalid exchange_index'),
  );

  it('rejects mismatched, missing, and inactive exact-market identity', () => {
    expect(() => validateKalshiMarketWireIdentity('KXBTC-TEST', undefined)).toThrow('did not match');
    expect(() => validateKalshiMarketWireIdentity('KXBTC-TEST', {
      ticker: 'KXETH-TEST', status: 'active', exchange_index: 2,
    })).toThrow('did not match');
    expect(() => validateKalshiMarketWireIdentity('KXBTC-TEST', {
      ticker: 'KXBTC-TEST', status: 'closed', exchange_index: 2,
    })).toThrow('is not active');
  });

  it('retains one index through a transaction and fails closed if a refresh changes it', () => {
    expect(stableKalshiExchangeIndex(undefined, 2)).toBe(2);
    expect(stableKalshiExchangeIndex(2, 2)).toBe(2);
    expect(() => stableKalshiExchangeIndex(2, 3)).toThrow('changed from 2 to 3');
  });
});

describe('Kalshi cancellation confirmation', () => {
  it('tolerates a bounded resting-to-canceled consistency delay', async () => {
    const states = [
      { order: { status: 'resting', remaining_count_fp: '0.25' } },
      { order: { status: 'canceled', remaining_count_fp: '0.00' } },
    ];
    const waits: number[] = [];
    await expect(confirmKalshiCancellation(
      'venue-1',
      async () => states.shift()!,
      async (milliseconds) => { waits.push(milliseconds); },
      [0, 250],
    )).resolves.toBeUndefined();
    expect(waits).toEqual([250]);
  });

  it('fails closed after the bounded window if the order still rests', async () => {
    await expect(confirmKalshiCancellation(
      'venue-2',
      async () => ({ order: { status: 'resting', remaining_count_fp: '0.25' } }),
      async () => undefined,
      [0, 1, 1],
    )).rejects.toThrow('Kalshi cancellation remains uncertain for venue-2');
  });

  it('does not accept terminal status with contradictory remaining quantity', async () => {
    await expect(confirmKalshiCancellation(
      'venue-3',
      async () => ({ order: { status: 'canceled', remaining_count_fp: '0.25' } }),
      async () => undefined,
      [0],
    )).rejects.toThrow(/remains uncertain/);
  });
});
