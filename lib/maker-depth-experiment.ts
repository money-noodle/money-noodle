import type { PositionSide } from './types';

/**
 * A bounded experiment: does a resting order fill on ordinary trades, or only on the ones about to go
 * against it?
 *
 * The rule below is the point of the whole exercise. `analyze:maker-fills` treats a post as filled the
 * moment the ask touches it, which cannot tell a brush from a sweep and is therefore permissive by
 * construction. Here a post fills only once **traded volume at or through its price** exceeds the size
 * displayed ahead of it — the same distinction `simulatePaperMaker` already applies to real orders.
 *
 * Observation only. Nothing here may gate, size, price, or trade. Pure and I/O free.
 * See docs/long-shot-policy-design.md §17.
 */
export const MAKER_DEPTH_EXPERIMENT_VERSION = 'maker-depth-experiment-v1';

export interface MakerDepthSample {
  contractId: string;
  symbol: string;
  closesAt: string;
  observedAt: string;
  side: PositionSide;
  bidCents: number;
  askCents: number;
  /** Size displayed at the price a maker would post, i.e. one tick inside the bid. */
  displayedAtPostCents?: number;
  /** Size displayed at or better than the post price — the proxy for queue rank, never rank itself. */
  displayedAheadCents?: number;
  /**
   * Volume traded at each price since the previous sample, keyed by whole-cent price on this side.
   *
   * Cumulative between samples rather than sampled, so this is exact whatever the cadence — which is what
   * lets the experiment run slowly and cheaply without weakening the number that decides the answer.
   */
  tradedVolumeByPrice: Record<number, number>;
}

/**
 * Volume that traded at or through a resting buy at `postCents`.
 *
 * A resting bid is consumed by sellers hitting it, so anything printed at or below the post price counts.
 * A print above it is somebody else's trade and must not advance our queue — treating any trade as
 * progress is the error that makes touch-based models permissive.
 */
export function volumeThroughPost(sample: MakerDepthSample, postCents: number): number {
  let total = 0;
  for (const [price, volume] of Object.entries(sample.tradedVolumeByPrice)) {
    if (Number(price) <= postCents + 1e-9 && Number.isFinite(volume)) total += volume;
  }
  return total;
}

export interface RestingPostState {
  postCents: number;
  /** Displayed size ahead at the moment of posting. Consumed before any of our own size can fill. */
  queueAheadCents: number;
  filled: boolean;
  /** Volume that has traded at or through the post price since it was placed. */
  consumedCents: number;
}

export function openPost(postCents: number, queueAheadCents: number): RestingPostState {
  return { postCents, queueAheadCents: Math.max(0, queueAheadCents), filled: false, consumedCents: 0 };
}

/**
 * Applies one sample's prints to a resting post.
 *
 * The post fills once cumulative volume through its price exceeds the size that was ahead of it. Size
 * ahead is fixed at posting rather than re-read: a level that grows behind us does not delay our fill, and
 * a level that shrinks by cancellation does not advance it — only executions do, which is exactly the
 * distinction depth snapshots cannot make on their own.
 */
export function applySample(state: RestingPostState, sample: MakerDepthSample): RestingPostState {
  if (state.filled) return state;
  const consumedCents = state.consumedCents + volumeThroughPost(sample, state.postCents);
  return { ...state, consumedCents, filled: consumedCents > state.queueAheadCents + 1e-9 };
}

/** Compact wire form; the traded-volume map is stored as `[price, volume]` pairs. */
export function encodeSample(sample: MakerDepthSample): unknown[] {
  return [
    sample.contractId, sample.symbol, sample.closesAt, sample.observedAt, sample.side,
    sample.bidCents, sample.askCents, sample.displayedAtPostCents ?? null, sample.displayedAheadCents ?? null,
    Object.entries(sample.tradedVolumeByPrice).map(([price, volume]) => [Number(price), volume]),
  ];
}

export function decodeSample(encoded: unknown): MakerDepthSample | null {
  if (!Array.isArray(encoded) || encoded.length < 10) return null;
  const [contractId, symbol, closesAt, observedAt, side, bidCents, askCents, atPost, ahead, prints] = encoded;
  if (typeof contractId !== 'string' || typeof symbol !== 'string' || typeof closesAt !== 'string') return null;
  if (typeof observedAt !== 'string' || (side !== 'UP' && side !== 'DOWN')) return null;
  if (![bidCents, askCents].every((value) => Number.isFinite(Number(value)))) return null;
  const tradedVolumeByPrice: Record<number, number> = {};
  if (Array.isArray(prints)) {
    for (const raw of prints) {
      if (!Array.isArray(raw) || raw.length < 2) continue;
      const [price, volume] = raw.map(Number);
      if (!Number.isFinite(price) || !Number.isFinite(volume)) continue;
      tradedVolumeByPrice[price] = (tradedVolumeByPrice[price] ?? 0) + volume;
    }
  }
  return {
    contractId, symbol, closesAt, observedAt, side,
    bidCents: Number(bidCents), askCents: Number(askCents),
    displayedAtPostCents: Number.isFinite(Number(atPost)) ? Number(atPost) : undefined,
    displayedAheadCents: Number.isFinite(Number(ahead)) ? Number(ahead) : undefined,
    tradedVolumeByPrice,
  };
}
