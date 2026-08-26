export const ENTRY_SIZING_POLICY_VERSION = 'entry-sizing-reduce30-below-edge30-v1';
export const FULL_SIZE_EDGE_THRESHOLD = 0.30;
export const REDUCED_ENTRY_MULTIPLIER = 0.30;

export interface EntrySizingDecision {
  policyVersion: typeof ENTRY_SIZING_POLICY_VERSION;
  baseStakeLimitCents: number;
  netEdge: number;
  multiplier: number;
  stakeLimitCents: number;
  reason: string;
}

/**
 * Reduce-only sizing: high edge retains today's base ticket and every lower edge receives 30%.
 * The resulting all-in control amount is quantized once, up against the account, before fill sizing.
 */
export function evaluateEntrySizing(baseStakeLimitCents: number, netEdge: number): EntrySizingDecision | null {
  if (!Number.isSafeInteger(baseStakeLimitCents) || baseStakeLimitCents <= 0 || !Number.isFinite(netEdge)) return null;
  const fullSize = netEdge + 1e-12 >= FULL_SIZE_EDGE_THRESHOLD;
  const multiplier = fullSize ? 1 : REDUCED_ENTRY_MULTIPLIER;
  const stakeLimitCents = fullSize
    ? baseStakeLimitCents
    : Math.ceil(baseStakeLimitCents * REDUCED_ENTRY_MULTIPLIER - 1e-9);
  return {
    policyVersion: ENTRY_SIZING_POLICY_VERSION,
    baseStakeLimitCents,
    netEdge,
    multiplier,
    stakeLimitCents,
    reason: fullSize
      ? `Issuance net edge ${(netEdge * 100).toFixed(1)}pp retains the full ${baseStakeLimitCents}c base ticket.`
      : `Issuance net edge ${(netEdge * 100).toFixed(1)}pp is below ${(FULL_SIZE_EDGE_THRESHOLD * 100).toFixed(0)}pp; ticket reduced to ${stakeLimitCents}c (${REDUCED_ENTRY_MULTIPLIER}x of ${baseStakeLimitCents}c).`,
  };
}
