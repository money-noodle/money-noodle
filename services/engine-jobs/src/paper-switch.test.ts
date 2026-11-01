import { describe, expect, it } from 'vitest';
import {
  valueSwitch,
  evaluateSwitchProbabilityGate,
  advanceSwitchPersistence,
  switchEvidenceReady,
  switchCooldownRemainingMs,
} from './domain/paper-switch.js';
describe('pure switch/hysteresis inputs, not exit or reentry authority', () => {
  it('compares future wealth excluding sunk cost with independent fee arithmetic', () => {
    expect(
      valueSwitch({
        incumbentQuantity: 4,
        incumbentProbability: 0.5,
        exitBid: 0.6,
        exitFeeCents: 7,
        replacementQuantity: 4,
        replacementProbability: 0.7,
        replacementAllInCostCents: 207,
      }),
    ).toEqual({
      holdValueCents: 200,
      liquidationValueCents: 233,
      replacementExpectedProfitCents: 73,
      deltaCents: 106,
    });
  });
  it('requires the stronger explicit same-asset reversal probability gap', () => {
    expect(
      evaluateSwitchProbabilityGate({
        incumbentSymbol: 'BTC',
        incumbentSide: 'UP',
        incumbentProbability: 0.5,
        replacementSymbol: 'BTC',
        replacementSide: 'DOWN',
        replacementProbability: 0.69,
        minimumAdvantage: 0.15,
        minimumOppositeSideAdvantage: 0.2,
      })?.allowed,
    ).toBe(false);
  });
  it('requires3observations spanning30bucketseconds and keepsminimumgain', () => {
    const input = {
      incumbentId: 'synthetic-incumbent',
      replacementId: 'synthetic-replacement',
      observedAt: '2026-10-11T02:00:00.000Z',
      deltaCents: 5,
      maximumGapMs: 35000,
    };
    const one = advanceSwitchPersistence(undefined, input);
    expect(advanceSwitchPersistence(one, input)).toEqual(one);
    const two = advanceSwitchPersistence(one, {
      ...input,
      observedAt: '2026-10-11T02:00:15.000Z',
      deltaCents: 3,
    });
    expect(
      switchEvidenceReady(two, {
        requiredObservations: 3,
        requiredSpanMs: 30000,
        requiredGainCents: 1,
      }),
    ).toBe(false);
    const three = advanceSwitchPersistence(two, {
      ...input,
      observedAt: '2026-10-11T02:00:30.000Z',
      deltaCents: 4,
    });
    expect(three.minimumDeltaCents).toBe(3);
    expect(
      switchEvidenceReady(three, {
        requiredObservations: 3,
        requiredSpanMs: 30000,
        requiredGainCents: 3,
      }),
    ).toBe(true);
    expect(
      advanceSwitchPersistence(three, {
        ...input,
        replacementId: 'other',
        observedAt: '2026-10-11T02:00:45.000Z',
      }).observations,
    ).toBe(1);
  });
  it('resets oversized evidence gaps and derives explicit cooldown without wallclock defaults', () => {
    const input = {
      incumbentId: 'i',
      replacementId: 'r',
      observedAt: '2026-10-11T02:00:00.000Z',
      deltaCents: 1,
      maximumGapMs: 35000,
    };
    expect(
      advanceSwitchPersistence(advanceSwitchPersistence(undefined, input), {
        ...input,
        observedAt: '2026-10-11T02:00:35.001Z',
      }).observations,
    ).toBe(1);
    const at = Date.parse(input.observedAt);
    expect(switchCooldownRemainingMs(input.observedAt, at + 59000, 60000)).toBe(1000);
    expect(switchCooldownRemainingMs(input.observedAt, at + 60000, 60000)).toBe(0);
    expect(switchCooldownRemainingMs('bad', at, 60000)).toBe(60000);
    expect(() => advanceSwitchPersistence(undefined, { ...input, deltaCents: NaN })).toThrow();
  });
});
