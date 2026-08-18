import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  applySample, decodeSample, encodeSample, openPost, volumeThroughPost, type MakerDepthSample,
} from './maker-depth-experiment';

const sample = (tradedVolumeByPrice: Record<number, number>, patch: Partial<MakerDepthSample> = {}): MakerDepthSample => ({
  contractId: 'KXBTC15M-TEST', symbol: 'BTC', closesAt: '2026-08-18T04:00:00Z',
  observedAt: '2026-08-18T03:50:00Z', side: 'UP',
  bidCents: 70, askCents: 71, displayedAtPostCents: 40, displayedAheadCents: 40,
  tradedVolumeByPrice, ...patch,
});

describe('volume through a resting post', () => {
  it('counts prints at or below the post price and ignores the rest', () => {
    const row = sample({ 68: 5, 70: 10, 71: 100, 75: 200 });
    expect(volumeThroughPost(row, 70)).toBe(15);
    expect(volumeThroughPost(row, 71)).toBe(115);
    expect(volumeThroughPost(row, 67)).toBe(0);
  });

  /**
   * The error this whole experiment exists to remove: counting any trade, or a mere quote touch, as
   * progress toward a fill. A brush against the level fills nobody behind the displayed size.
   */
  it('does not advance the queue on trades away from the post price', () => {
    const state = applySample(openPost(70, 40), sample({ 72: 1000, 80: 1000 }));
    expect(state.consumedCents).toBe(0);
    expect(state.filled).toBe(false);
  });
});

describe('a resting post filling', () => {
  it('needs volume beyond the size displayed ahead of it', () => {
    let state = openPost(70, 40);
    state = applySample(state, sample({ 70: 25 }));
    expect(state.filled).toBe(false);
    state = applySample(state, sample({ 70: 10 }));
    expect(state.filled).toBe(false);
    // 45 total finally exceeds the 40 that was ahead.
    state = applySample(state, sample({ 70: 10 }));
    expect(state.filled).toBe(true);
  });

  it('fills immediately when nothing is ahead', () => {
    expect(applySample(openPost(70, 0), sample({ 70: 1 })).filled).toBe(true);
  });

  it('holds the size ahead fixed at posting, so a cancellation cannot fill it', () => {
    // A second sample showing a much smaller displayed size is a cancellation, not an execution.
    let state = applySample(openPost(70, 40), sample({}, { displayedAheadCents: 40 }));
    state = applySample(state, sample({}, { displayedAheadCents: 1 }));
    expect(state.filled).toBe(false);
    expect(state.queueAheadCents).toBe(40);
  });

  it('stays filled once filled', () => {
    const filled = applySample(openPost(70, 0), sample({ 70: 5 }));
    expect(applySample(filled, sample({ 70: 0 })).filled).toBe(true);
  });
});

describe('wire form', () => {
  it('round-trips', () => {
    const row = sample({ 68: 5, 70: 10 });
    expect(decodeSample(encodeSample(row))).toEqual(row);
  });

  it('rejects a damaged row rather than decoding a partial sample', () => {
    expect(decodeSample(null)).toBeNull();
    expect(decodeSample(['c', 'BTC', 'x', 'y', 'SIDEWAYS', 1, 2, 3, 4, []])).toBeNull();
  });
});
