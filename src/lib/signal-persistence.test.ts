import { describe, expect, it } from 'vitest';
import { MAX_EDGE_SPIKE } from './edge-spike-policy';
import {
  advanceSignalPersistence, evaluateSignalPersistence, evaluateSignalPersistenceIgnoringSpike,
  evaluateSignalPersistenceWithRequirements, REQUIRED_OBSERVATION_SPAN_MS, REQUIRED_QUALIFYING_SNAPSHOTS,
  signalPersistenceAfter,
  type SignalPersistenceState,
} from './signal-persistence';

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

  it('requalifies a continuous signal only from observations after maker completion', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [90, 105, 120, 135]) state = advance(state, seconds);
    const fresh = signalPersistenceAfter(state, time(105));
    expect(fresh?.observations.map((observation) => observation.at)).toEqual([time(120), time(135)]);
    expect(evaluateSignalPersistence(fresh, Date.parse(time(135)), 0.05, 0.5)).toMatchObject({
      eligible: true, qualifyingSnapshots: 2,
    });
    expect(evaluateSignalPersistence(signalPersistenceAfter(state, time(120)), Date.parse(time(135)), 0.05, 0.5).eligible).toBe(false);
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

  it('refuses observations too close together to span the required window', () => {
    // Five seconds apart, so the last two share a 15-second bucket and span zero however many there are.
    let state: SignalPersistenceState | undefined;
    for (const seconds of [90, 95, 100]) state = advance(state, seconds);
    const result = evaluateSignalPersistence(state, Date.parse(time(100)), 0.05, 0.5);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('span');
  });

  it('lets a candidate lane state requirements production does not use', () => {
    // v21 promoted the two-snapshot candidate, so production is now 2-over-15s. The property under test
    // is that a lane can declare its own bar rather than inherit production's, so the stricter
    // three-over-thirty rule stands in as the candidate here.
    let state: SignalPersistenceState | undefined;
    for (const seconds of [90, 105]) state = advance(state, seconds);
    expect(evaluateSignalPersistence(state, Date.parse(time(105)), 0.05, 0.5).eligible).toBe(true);
    expect(evaluateSignalPersistenceWithRequirements(state, Date.parse(time(105)), 0.05, 0.5, {
      requiredSnapshots: 3, requiredSpanMs: 30_000, maximumEdgeSpike: MAX_EDGE_SPIKE, spikeGateEnabled: true,
    }).eligible).toBe(false);
  });

  it('carries the production persistence rule v21 promoted', () => {
    expect(REQUIRED_QUALIFYING_SNAPSHOTS).toBe(2);
    expect(REQUIRED_OBSERVATION_SPAN_MS).toBe(15_000);
  });

  it('refuses an edge that has just spiked above its own persistence median', () => {
    // The losing cohort of reports/edge-policy-review-2026-08-17.md §3: the edge jumps because the price
    // just moved, and it moved against the side the jump makes look cheap.
    let state: SignalPersistenceState | undefined;
    state = advance(state, 60, true, 0.08);
    state = advance(state, 75, true, 0.08);
    state = advance(state, 90, true, 0.14);
    // Evaluated with the gate explicitly armed. Production disarmed it at v19 by operator decision, so
    // the wrapper no longer refuses — the gate's *logic* is still live and still has to be right, because
    // MONEY_NOODLE_EDGE_SPIKE_GATE re-arms it without a version bump.
    const result = evaluateSignalPersistenceWithRequirements(state, Date.parse(time(90)), 0.05, 0.5, {
      requiredSnapshots: REQUIRED_QUALIFYING_SNAPSHOTS, requiredSpanMs: REQUIRED_OBSERVATION_SPAN_MS,
      maximumEdgeSpike: MAX_EDGE_SPIKE, spikeGateEnabled: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.edgeSpike).toBeCloseTo(0.06, 10);
    expect(result.reason).toContain('freshness ceiling');
  });

  it('does not refuse a spike in production, because v19 disarmed the gate', () => {
    // The same state as above. What changed at v19 is only whether the ceiling may refuse; the spike is
    // still measured and still reported, which is what keeps edge-spike-sentinel-v1 answering the
    // question. If this ever starts refusing again without a manifest entry, something re-armed silently.
    let state: SignalPersistenceState | undefined;
    state = advance(state, 60, true, 0.08);
    state = advance(state, 75, true, 0.08);
    state = advance(state, 90, true, 0.14);
    const result = evaluateSignalPersistence(state, Date.parse(time(90)), 0.05, 0.5);
    expect(result.eligible).toBe(true);
    expect(result.edgeSpike).toBeCloseTo(0.06, 10);
  });

  it('admits an edge that is merely high, so long as it is not fresh', () => {
    // A large edge is not the problem; a large *jump* is. This is what keeps the gate from becoming a
    // second, accidental edge ceiling on top of MAX_NET_EDGE.
    let state: SignalPersistenceState | undefined;
    for (const seconds of [60, 75, 90]) state = advance(state, seconds, true, 0.30);
    const result = evaluateSignalPersistence(state, Date.parse(time(90)), 0.05, 0.5);
    expect(result.eligible).toBe(true);
    expect(result.edgeSpike).toBeCloseTo(0, 10);
  });

  it('admits an edge that has fallen below its median, and reports the spike either way', () => {
    let state: SignalPersistenceState | undefined;
    state = advance(state, 60, true, 0.14);
    state = advance(state, 75, true, 0.14);
    state = advance(state, 90, true, 0.08);
    const result = evaluateSignalPersistence(state, Date.parse(time(90)), 0.05, 0.5);
    expect(result.eligible).toBe(true);
    expect(result.edgeSpike).toBeCloseTo(-0.06, 10);
  });

  it('scores the ignoring-spike evaluator identically except for the gate', () => {
    let state: SignalPersistenceState | undefined;
    state = advance(state, 60, true, 0.08);
    state = advance(state, 75, true, 0.08);
    state = advance(state, 90, true, 0.14);
    const gated = evaluateSignalPersistenceWithRequirements(state, Date.parse(time(90)), 0.05, 0.5, {
      requiredSnapshots: REQUIRED_QUALIFYING_SNAPSHOTS, requiredSpanMs: REQUIRED_OBSERVATION_SPAN_MS,
      maximumEdgeSpike: MAX_EDGE_SPIKE, spikeGateEnabled: true,
    });
    const ungated = evaluateSignalPersistenceIgnoringSpike(state, Date.parse(time(90)), 0.05, 0.5);
    expect(gated.eligible).toBe(false);
    expect(ungated.eligible).toBe(true);
    // Both arms of the sentinel must come from one evaluation, so every other reported field agrees.
    expect(ungated.edgeSpike).toBeCloseTo(gated.edgeSpike!, 12);
    expect(ungated.medianNetEdge).toBeCloseTo(gated.medianNetEdge!, 12);
    expect(ungated.qualifyingSnapshots).toBe(gated.qualifyingSnapshots);
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

  it('blocks all new entries inside the final 30 seconds', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [825, 840, 855, 870]) state = advance(state, seconds);
    const result = evaluateSignalPersistence(state, Date.parse(time(870)), 0.05, 0.5);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('final 30s');
  });

  it('admits the 120s-to-30s band that v20 opened', () => {
    let state: SignalPersistenceState | undefined;
    for (const seconds of [735, 750, 765, 780]) state = advance(state, seconds);
    // 120 seconds remaining: refused before v20, admitted now.
    expect(evaluateSignalPersistence(state, Date.parse(time(780)), 0.05, 0.5).eligible).toBe(true);
  });
});
