import { describe, expect, it } from 'vitest';
import { advanceSwitchPersistence, switchCooldownRemainingMs, switchEvidenceReady, type SwitchPersistenceState } from './switch-hysteresis';

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const advance = (previous: SwitchPersistenceState | undefined, seconds: number, delta = 3) => advanceSwitchPersistence(previous, { incumbentId: 'old', replacementId: 'new', observedAt: at(seconds), deltaCents: delta });

describe('switch hysteresis and cooldown', () => {
  it('requires three distinct snapshots spanning thirty seconds', () => {
    let state = advance(undefined, 0);
    state = advance(state, 15);
    expect(switchEvidenceReady(state, { requiredObservations: 3, requiredSpanMs: 30_000, requiredGainCents: 2 })).toBe(false);
    state = advance(state, 30);
    expect(switchEvidenceReady(state, { requiredObservations: 3, requiredSpanMs: 30_000, requiredGainCents: 2 })).toBe(true);
  });

  it('treats three cadence buckets as thirty seconds despite scheduler jitter', () => {
    let state = advanceSwitchPersistence(undefined, { incumbentId: 'old', replacementId: 'new', observedAt: '2026-01-01T00:00:15.900Z', deltaCents: 3 });
    state = advanceSwitchPersistence(state, { incumbentId: 'old', replacementId: 'new', observedAt: '2026-01-01T00:00:30.100Z', deltaCents: 3 });
    state = advanceSwitchPersistence(state, { incumbentId: 'old', replacementId: 'new', observedAt: '2026-01-01T00:00:45.200Z', deltaCents: 3 });
    expect(switchEvidenceReady(state, { requiredObservations: 3, requiredSpanMs: 30_000, requiredGainCents: 2 })).toBe(true);
  });

  it('does not manufacture observations by repeating a timestamp', () => {
    let state = advance(undefined, 0);
    state = advance(state, 0);
    expect(state.observations).toBe(1);
  });

  it('retains the minimum observed gain as an uncertainty hysteresis guard', () => {
    let state = advance(undefined, 0, 4);
    state = advance(state, 15, 1.5);
    state = advance(state, 30, 4);
    expect(state.minimumDeltaCents).toBe(1.5);
    expect(switchEvidenceReady(state, { requiredObservations: 3, requiredSpanMs: 30_000, requiredGainCents: 2 })).toBe(false);
  });

  it('resets after a gap or candidate change', () => {
    let state = advance(undefined, 0);
    state = advance(state, 60);
    expect(state.observations).toBe(1);
    state = advanceSwitchPersistence(state, { incumbentId: 'other', replacementId: 'new', observedAt: at(75), deltaCents: 3 });
    expect(state.observations).toBe(1);
    expect(state.incumbentId).toBe('other');
  });

  it('reports a bounded cooldown after a completed switch', () => {
    expect(switchCooldownRemainingMs(at(0), Date.parse(at(60)), 180_000)).toBe(120_000);
    expect(switchCooldownRemainingMs(at(0), Date.parse(at(181)), 180_000)).toBe(0);
  });
});
