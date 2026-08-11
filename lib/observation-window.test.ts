import { describe, expect, it } from 'vitest';
import { signalObservationId, observationBucket } from './observation-window';

describe('15-second recommendation observations', () => {
  it('deduplicates requests inside one UTC bucket', () => {
    expect(observationBucket(30_001)).toBe(30_000);
    expect(observationBucket(44_999)).toBe(30_000);
    expect(signalObservationId('btc-cycle', 30_001)).toBe(signalObservationId('btc-cycle', 44_999));
  });

  it('creates a new observation in the next bucket', () => {
    expect(signalObservationId('btc-cycle', 44_999)).not.toBe(signalObservationId('btc-cycle', 45_000));
  });
});
