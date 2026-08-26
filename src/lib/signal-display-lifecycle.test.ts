import { describe, expect, it } from 'vitest';
import {
  reconcileRetainedSignals, signalDisplayKey, signalDisplayPhase, signalRemovalAtMs,
  type RetainedSignal, type SignalDisplayCandidate,
} from './signal-display-lifecycle';

const closeMs = Date.parse('2026-08-20T22:30:00Z');
const candidate = (probability: number): SignalDisplayCandidate & { probability: number } => ({
  symbol: 'BTC', market: { closesAt: '2026-08-20T22:30:00Z' }, probability,
});

describe('positive-edge signal display lifecycle', () => {
  it('retains the last qualified snapshot without fading when qualification ends before market close', () => {
    const qualified = candidate(0.61);
    const previous = reconcileRetainedSignals([], [qualified], closeMs - 60_000);
    const retained = reconcileRetainedSignals(previous, [], closeMs - 30_000);

    expect(retained).toEqual([{ key: signalDisplayKey(qualified), prediction: qualified, capturedAtMs: closeMs - 60_000 }]);
    expect(signalDisplayPhase(retained[0].prediction, false, closeMs - 30_000)).toBe('signal-expired');
  });

  it('replaces a retained snapshot and clears its expired state when the same window requalifies', () => {
    const oldSnapshot = candidate(0.61);
    const previous: RetainedSignal<typeof oldSnapshot>[] = [{ key: signalDisplayKey(oldSnapshot), prediction: oldSnapshot, capturedAtMs: closeMs - 20_000 }];
    const current = candidate(0.68);
    const reconciled = reconcileRetainedSignals(previous, [current], closeMs - 10_000);

    expect(reconciled).toEqual([{ key: signalDisplayKey(current), prediction: current, capturedAtMs: closeMs - 10_000 }]);
    expect(signalDisplayPhase(reconciled[0].prediction, true, closeMs - 10_000)).toBe('current');
  });

  it('starts expiry at market close and removes the snapshot only after the fade interval', () => {
    const signal = candidate(0.61);
    const previous = reconcileRetainedSignals([], [signal], closeMs - 1);

    expect(signalDisplayPhase(signal, false, closeMs)).toBe('window-expired');
    expect(signalRemovalAtMs(signal)).toBe(closeMs + 2_400);
    expect(reconcileRetainedSignals(previous, [], closeMs + 2_399)).toHaveLength(1);
    expect(reconcileRetainedSignals(previous, [], closeMs + 2_400)).toEqual([]);
  });

  it('fails closed and retains no snapshot with an invalid market close', () => {
    const invalid = { symbol: 'BTC', market: { closesAt: 'invalid' } };
    expect(reconcileRetainedSignals([], [invalid], closeMs)).toEqual([]);
    expect(signalDisplayPhase(invalid, true, closeMs)).toBe('window-expired');
  });
});
