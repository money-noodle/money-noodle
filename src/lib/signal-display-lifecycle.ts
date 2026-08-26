export const SIGNAL_WINDOW_FADE_MS = 2_400;

export interface SignalDisplayCandidate {
  symbol: string;
  market: { closesAt: string };
}

export interface RetainedSignal<T extends SignalDisplayCandidate = SignalDisplayCandidate> {
  key: string;
  prediction: T;
  capturedAtMs: number;
}

export type SignalDisplayPhase = 'current' | 'signal-expired' | 'window-expired';

export function signalDisplayKey(signal: SignalDisplayCandidate): string {
  return `${signal.symbol}:${signal.market.closesAt}`;
}

export function signalWindowCloseMs(signal: SignalDisplayCandidate): number {
  const closeMs = Date.parse(signal.market.closesAt);
  return Number.isFinite(closeMs) ? closeMs : 0;
}

export function signalRemovalAtMs(signal: SignalDisplayCandidate): number {
  return signalWindowCloseMs(signal) + SIGNAL_WINDOW_FADE_MS;
}

/**
 * Retains the last qualified snapshot through market close. Current snapshots replace retained ones on
 * requalification; nothing here persists beyond the mounted dashboard's browser-session state.
 */
export function reconcileRetainedSignals<T extends SignalDisplayCandidate>(
  previous: RetainedSignal<T>[],
  current: T[],
  nowMs: number,
  capturedAtMs = nowMs,
): RetainedSignal<T>[] {
  const currentKeys = new Set(current.map(signalDisplayKey));
  const retained = previous.filter((item) =>
    !currentKeys.has(item.key) && signalRemovalAtMs(item.prediction) > nowMs);
  const currentSnapshots = current
    .filter((prediction) => signalRemovalAtMs(prediction) > nowMs)
    .map((prediction) => ({ key: signalDisplayKey(prediction), prediction, capturedAtMs }));
  return [...currentSnapshots, ...retained];
}

export function signalDisplayPhase(
  signal: SignalDisplayCandidate,
  currentlyQualified: boolean,
  nowMs: number,
): SignalDisplayPhase {
  if (nowMs >= signalWindowCloseMs(signal)) return 'window-expired';
  return currentlyQualified ? 'current' : 'signal-expired';
}
