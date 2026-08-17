import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { MAX_EDGE_SPIKE, edgeSpike, maximumEdgeSpike, spikeAdmits } from './edge-spike-policy';

describe('edge spike', () => {
  it('is the signed gap between the firing edge and its persistence median', () => {
    // A grid, not a fixture: the claim is that no input reaches a different answer.
    for (const current of [-0.2, 0, 0.05, 0.12, 0.34, 0.9]) {
      for (const median of [-0.2, 0, 0.05, 0.12, 0.34, 0.9]) {
        expect(edgeSpike(current, median)).toBeCloseTo(current - median, 12);
      }
    }
  });

  it('is unknown when there is no median or either input is not finite', () => {
    expect(edgeSpike(0.1, null)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(edgeSpike(bad, 0.1)).toBeNull();
      expect(edgeSpike(0.1, bad)).toBeNull();
    }
  });
});

describe('spike admission', () => {
  it('admits an edge at or below its own recent level and refuses one that has jumped', () => {
    for (const spike of [-0.5, -0.02, -1e-9, 0, 0.001, 0.019]) expect(spikeAdmits(spike, 0.02)).toBe(true);
    for (const spike of [0.02, 0.021, 0.05, 0.3, 1]) expect(spikeAdmits(spike, 0.02)).toBe(false);
  });

  it('puts the tolerance on the refusing side, so noise can never admit', () => {
    // Exactly at the ceiling is refused: that is the cohort boundary the 2026-08-17 review measured.
    expect(spikeAdmits(0.02, 0.02)).toBe(false);
    expect(spikeAdmits(0.02 - 1e-13, 0.02)).toBe(false);
    expect(spikeAdmits(0.02 - 1e-9, 0.02)).toBe(true);
  });

  it('fails closed on an unknown or non-finite spike', () => {
    expect(spikeAdmits(null, 0.02)).toBe(false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) expect(spikeAdmits(bad, 0.02)).toBe(false);
  });

  it('admits everything only when explicitly disabled', () => {
    for (const spike of [0, 0.05, 0.5, 0.99]) expect(spikeAdmits(spike, 1)).toBe(true);
    expect(spikeAdmits(0.5, Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('configured ceiling', () => {
  it('defaults to the production constant and only accepts a positive finite override', () => {
    expect(maximumEdgeSpike({ NODE_ENV: 'test' })).toBe(MAX_EDGE_SPIKE);
    for (const bad of ['', 'abc', '0', '-0.02', 'NaN']) {
      expect(maximumEdgeSpike({ NODE_ENV: 'test', MONEY_NOODLE_MAX_EDGE_SPIKE: bad })).toBe(MAX_EDGE_SPIKE);
    }
    expect(maximumEdgeSpike({ NODE_ENV: 'test', MONEY_NOODLE_MAX_EDGE_SPIKE: '0.05' })).toBe(0.05);
    // Never above 1: a spike is a probability difference, so a larger ceiling is meaningless.
    expect(maximumEdgeSpike({ NODE_ENV: 'test', MONEY_NOODLE_MAX_EDGE_SPIKE: '7' })).toBe(1);
  });

  it('can only ever refuse entries relative to no gate at all', () => {
    // Restrictive-only is the property that lets this ship on a weak result: for every spike, the gate
    // either agrees with "no gate" or is stricter. It can never admit something an ungated desk refused.
    for (const spike of [-1, -0.01, 0, 0.01, 0.02, 0.5]) {
      const gated = spikeAdmits(spike, MAX_EDGE_SPIKE);
      const ungated = spikeAdmits(spike, Number.POSITIVE_INFINITY);
      expect(gated && !ungated).toBe(false);
    }
  });
});
