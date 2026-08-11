import { describe, expect, it } from 'vitest';
import { backOffValidKalshiPrice, confirmKalshiCancellation, floorToValidKalshiPrice, kalshiOrderBookSide, selectedSidePriceFromYes, yesPriceFromSelectedSide } from './live-orders';

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
