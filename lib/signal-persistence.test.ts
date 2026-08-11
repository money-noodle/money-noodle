import { describe, expect, it } from 'vitest';
import { advanceSignalPersistence, evaluateSignalPersistence, type SignalPersistenceState } from './signal-persistence';

const close = '2026-01-01T00:15:00.000Z';
const time = (seconds: number) => new Date(Date.parse(close) - 900_000 + seconds * 1000).toISOString();

function advance(state: SignalPersistenceState | undefined, seconds: number, qualifies = true, edge = 0.08, quality = 0.7) {
  return advanceSignalPersistence(state, { symbol: 'BTC', side: 'UP', closesAt: close, calculationAt: time(seconds), qualifies, netEdge: edge, quality });
}

describe('execution signal persistence', () => {
  it('blocks an otherwise persistent signal during the first ninety seconds', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [30, 45, 60, 75]) state = advance(state, seconds);
    const result = evaluateSignalPersistence(state, Date.parse(time(75)), 0.05, 0.5);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('warming up');
  });

  it('allows the earliest entry at ninety seconds after persistent observations', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [45, 60, 75, 90]) state = advance(state, seconds);
    const result = evaluateSignalPersistence(state, Date.parse(time(90)), 0.05, 0.5);
    expect(result.eligible).toBe(true);
    expect(result.qualifyingSnapshots).toBe(4);
    expect(result.medianNetEdge).toBeCloseTo(0.08);
  });

  it('does not count the same calculation timestamp more than once', () => {
    let state = advance(undefined, 60);
    state = advance(state, 60);
    expect(state.observations).toHaveLength(1);
  });

  it('resets persistence as soon as the current signal fails', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [30, 45, 60]) state = advance(state, seconds);
    state = advance(state, 75, false);
    expect(state.observations).toHaveLength(0);
    expect(evaluateSignalPersistence(state, Date.parse(time(75)), 0.05, 0.5).eligible).toBe(false);
  });

  it('uses distinct 15-second buckets so scheduler jitter cannot produce a permanent 29/30s gate', () => {
    let state: SignalPersistenceState | undefined;
    for (const milliseconds of [45_900, 60_100, 75_200]) state = advanceSignalPersistence(state, {
      symbol: 'BTC', side: 'UP', closesAt: close, calculationAt: new Date(Date.parse(close) - 900_000 + milliseconds).toISOString(),
      qualifies: true, netEdge: 0.08, quality: 0.7,
    });
    expect(evaluateSignalPersistence(state, Date.parse(time(90)), 0.05, 0.5).eligible).toBe(true);
  });

  it('never reuses UP persistence for a DOWN entry', () => {
    const up = advance(undefined, 60);
    const down = advanceSignalPersistence(up, {
      symbol: 'BTC', side: 'DOWN', closesAt: close, calculationAt: time(75), qualifies: true, netEdge: 0.08, quality: 0.7,
    });
    expect(down.side).toBe('DOWN');
    expect(down.observations).toHaveLength(1);
  });

  it('requires three observations to span at least thirty seconds', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [90, 95, 100]) state = advance(state, seconds);
    const result = evaluateSignalPersistence(state, Date.parse(time(100)), 0.05, 0.5);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('span');
  });

  it('uses median edge rather than one temporary spike', () => {
    let state: SignalPersistenceState | undefined;
    state = advance(state, 60, true, 0.20);
    state = advance(state, 75, true, 0.03);
    state = advance(state, 90, true, 0.03);
    const result = evaluateSignalPersistence(state, Date.parse(time(90)), 0.05, 0.5);
    expect(result.eligible).toBe(false);
    expect(result.medianNetEdge).toBeCloseTo(0.03);
  });

  it('blocks all new entries inside the final two minutes', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [735, 750, 765, 780]) state = advance(state, seconds);
    const result = evaluateSignalPersistence(state, Date.parse(time(780)), 0.05, 0.5);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('final 120s');
  });
});
