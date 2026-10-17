import { describe, expect, it } from 'vitest';
import { evaluateExitPolicy } from './domain/paper-exit.js';
import {
  advanceSwitchPersistence,
  switchEvidenceReady,
  switchEvidenceSpanMs,
} from './domain/paper-switch.js';
import { nextManagedMakerPrice } from './domain/paper-pricing.js';
const exit = {
  observedAt: '2026-10-11T03:00:00Z',
  side: 'UP' as const,
  quantity: 2,
  exactCostCents: 50,
  executableBid: 0.5,
  exitFeeCents: 2,
  ownedSideProbability: 0.4,
  uncertainty: 0.05,
  strictMinimumGainCents: 1,
};
const switchInput = {
  incumbentId: 'synthetic-i',
  replacementId: 'synthetic-r',
  observedAt: '2026-10-11T03:00:00Z',
  deltaCents: 5,
  maximumGapMs: 35000,
};
const ready = { requiredObservations: 3, requiredSpanMs: 30000, requiredGainCents: 1 };
describe('independent F2 F3 F5 dormant boundary fixes', () => {
  it('F2 refuses enormous intermediates negative gain and malformed highwater while retaining98vs90SELL', () => {
    expect(evaluateExitPolicy({ ...exit, quantity: 1e308 }, false)).toBeNull();
    expect(evaluateExitPolicy({ ...exit, strictMinimumGainCents: -1 }, false)).toBeNull();
    expect(evaluateExitPolicy({ ...exit, exactCostCents: 1e-308 }, false)).toBeNull();
    expect(evaluateExitPolicy({ ...exit, peakNetLiquidationCents: Infinity }, false)).toBeNull();
    expect(evaluateExitPolicy({ ...exit, observedAt: 'bad' }, false)).toBeNull();
    const decision = evaluateExitPolicy(exit, false);
    expect(decision?.action).toBe('SELL');
    expect(decision?.netLiquidationCents).toBe(98);
    expect(decision?.optimisticHoldValueCents).toBe(90);
    expect(evaluateExitPolicy({ ...exit, ownedSideProbability: 0.6 }, false)?.action).toBe('HOLD');
  });
  it('F3 timestamp aliases0/Z and0/.000Z are only one observation;0/30 is not3', () => {
    const one = advanceSwitchPersistence(undefined, switchInput);
    const alias = advanceSwitchPersistence(one, {
      ...switchInput,
      observedAt: '2026-10-11T03:00:00.000Z',
    });
    expect(alias.observations).toBe(1);
    const two = advanceSwitchPersistence(alias, {
      ...switchInput,
      observedAt: '2026-10-11T03:00:30Z',
    });
    expect(two.observations).toBe(2);
    expect(switchEvidenceReady(two, ready)).toBe(false);
    expect(() =>
      advanceSwitchPersistence({ ...one, firstSeenAt: '2026-10-11T03:00:15Z' }, switchInput),
    ).toThrow();
  });
  it('F3 preserves three genuine observations min gain and SOURCE bucket rather than elapsed span', () => {
    let state = advanceSwitchPersistence(undefined, switchInput);
    state = advanceSwitchPersistence(state, {
      ...switchInput,
      observedAt: '2026-10-11T03:00:15Z',
      deltaCents: 3,
    });
    state = advanceSwitchPersistence(state, {
      ...switchInput,
      observedAt: '2026-10-11T03:00:30Z',
      deltaCents: 4,
    });
    expect(state.minimumDeltaCents).toBe(3);
    expect(switchEvidenceReady(state, ready)).toBe(true);
    const first = advanceSwitchPersistence(undefined, {
      ...switchInput,
      observedAt: '2026-10-11T03:00:14.999Z',
    });
    const last = advanceSwitchPersistence(first, {
      ...switchInput,
      observedAt: '2026-10-11T03:00:30Z',
    });
    expect(switchEvidenceSpanMs(last)).toBe(30000);
  });
  it('F5 rejects invalid current price both active and terminal; preserves repricing and moving-ask resting price', () => {
    const input = {
      quote: { bid: 0.42, ask: 0.44 },
      maximumPrice: 0.5,
      currentPrice: 0.41,
      managementAttempt: 0,
    };
    for (const currentPrice of [-0.1, 0, 1, 1.2, 0.500001])
      for (const managementAttempt of [0, 5])
        expect(() =>
          nextManagedMakerPrice({ ...input, currentPrice, managementAttempt }),
        ).toThrow();
    expect(nextManagedMakerPrice(input)).toBe(0.42);
    expect(nextManagedMakerPrice({ ...input, managementAttempt: 5 })).toBe(0.41);
    expect(nextManagedMakerPrice({ ...input, quote: { bid: 0.38, ask: 0.4 } })).toBe(0.41);
  });
});
