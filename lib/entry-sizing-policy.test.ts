import { describe, expect, it } from 'vitest';
import {
  ENTRY_SIZING_POLICY_VERSION, FULL_SIZE_EDGE_THRESHOLD, REDUCED_ENTRY_MULTIPLIER, evaluateEntrySizing,
} from './entry-sizing-policy';

describe('reduce-only edge entry sizing', () => {
  it('reduces ordinary entries and retains the base ticket at 30pp', () => {
    expect(evaluateEntrySizing(100, 0.299)?.stakeLimitCents).toBe(30);
    expect(evaluateEntrySizing(100, FULL_SIZE_EDGE_THRESHOLD)).toMatchObject({
      policyVersion: ENTRY_SIZING_POLICY_VERSION, multiplier: 1, stakeLimitCents: 100,
    });
    expect(evaluateEntrySizing(100, 0.8)?.stakeLimitCents).toBe(100);
  });

  it('rounds the all-in control cap up once and never exceeds the base', () => {
    const decision = evaluateEntrySizing(101, 0.10)!;
    expect(decision.multiplier).toBe(REDUCED_ENTRY_MULTIPLIER);
    expect(decision.stakeLimitCents).toBe(31);
    expect(decision.stakeLimitCents).toBeLessThanOrEqual(decision.baseStakeLimitCents);
  });

  it('holds the 30pp probability boundary to the named epsilon', () => {
    expect(evaluateEntrySizing(100, 0.30 - 2e-12)?.stakeLimitCents).toBe(30);
    expect(evaluateEntrySizing(100, 0.30 - 0.5e-12)?.stakeLimitCents).toBe(100);
  });

  it('has no arbitrary minimum beyond a positive whole-cent control amount', () => {
    expect(evaluateEntrySizing(2, 0.10)?.stakeLimitCents).toBe(1);
    expect(evaluateEntrySizing(1, 0.10)?.stakeLimitCents).toBe(1);
  });

  it('fails closed on malformed control inputs', () => {
    expect(evaluateEntrySizing(0, 0.4)).toBeNull();
    expect(evaluateEntrySizing(10.5, 0.4)).toBeNull();
    expect(evaluateEntrySizing(10, Number.NaN)).toBeNull();
  });
});
