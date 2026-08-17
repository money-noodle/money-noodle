/**
 * Signal freshness: how far the firing edge sits above its own persistence median.
 *
 * `signalEligibility` has always computed `medianNetEdge` over the qualifying snapshots and stamped it on
 * every entry decision, and nothing ever read it. The 2026-08-17 review found that decisions firing 2pp or
 * more above that median won 34.0% against 58.7% for the rest, over 228 deduplicated (symbol, window,
 * side) decisions — repeating inside every net-edge band and on 6 of 7 assets it could score.
 *
 * The mechanism came before the cut, which is why it is acted on: an edge that has just jumped above its
 * own recent level is a price that has just moved, and the direction it moved is against the side the jump
 * makes look cheap. A resting passive limit below that then fills only if the move continues, so the entry
 * signal and the fill selection are the same event seen twice.
 *
 * **This threshold was chosen retroactively and promotes nothing.** It ships on an asymmetry — declining
 * this volume costs approximately nothing while the book is negative, and not declining it costs real
 * money if the effect is real — with `edge-spike-sentinel-v1` recording every declined decision at
 * decision time so the figure is recomputed prospectively rather than re-argued from the script that
 * produced it. See docs/edge-spike-sentinel-design.md §2.
 *
 * Pure and I/O free.
 */

export const EDGE_SPIKE_POLICY_VERSION = 'edge-spike-fresh-2pp-v1';

/**
 * Maximum admissible gap between the firing edge and its persistence median.
 *
 * Restrictive only: this can refuse an entry, never authorize one. Set MONEY_NOODLE_MAX_EDGE_SPIKE to
 * change it, or to 1 to disable the gate without reverting the policy version.
 */
export const MAX_EDGE_SPIKE = 0.02;

export function maximumEdgeSpike(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.MONEY_NOODLE_MAX_EDGE_SPIKE);
  return Number.isFinite(configured) && configured > 0 ? Math.min(1, configured) : MAX_EDGE_SPIKE;
}

/**
 * How far the current edge sits above the median of the qualifying snapshots, or null when there is no
 * median to compare against. Negative means the edge is below its own recent level, which is admitted:
 * the rule refuses spikes, not weakness, and weakness is already handled by the median floor.
 */
export function edgeSpike(currentNetEdge: number, medianNetEdge: number | null): number | null {
  if (medianNetEdge === null || !Number.isFinite(currentNetEdge) || !Number.isFinite(medianNetEdge)) return null;
  return currentNetEdge - medianNetEdge;
}

/**
 * Whether a spike is fresh enough to trade.
 *
 * The epsilon sits on the refusing side — admission requires strictly below the bound — so floating noise
 * can only ever refuse an entry, never admit one. A spike of exactly the threshold is refused, which is
 * the cohort boundary the review measured. An unknown spike fails closed.
 */
export function spikeAdmits(spike: number | null, maximum: number = maximumEdgeSpike()): boolean {
  if (spike === null || !Number.isFinite(spike)) return false;
  return spike + 1e-12 < maximum;
}
